/**
 * The deploy-wide derived-name needle (go-to-k/cdkd#3869): a physical name
 * derived from a secret (a rewriting provider's fold of it, or an id minted
 * from a value since rotated) is no recorded plaintext, so a resource READING
 * it through `Ref` / `Fn::GetAtt` printed it, and so did the resolver's own
 * `resolved to` line under `--verbose`.
 *
 * Three layers, each with its own discriminator:
 *  - `secretNameNeedlesOf` decides WHETHER a record is named from a secret and
 *    which spellings its id prints as;
 *  - the resolver records those needles, and the value it served, as LOG-ONLY
 *    needles of the reading pass's bag, before its line;
 *  - `withPrintingSecrets` masks every line of a scope without becoming the
 *    bag a provider seeds or compares with.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const logLines: string[] = [];
vi.mock('../../../src/utils/logger.js', () => {
  const push =
    (level: string) =>
    (...args: unknown[]): void =>
      void logLines.push(`${level} ${args.map(String).join(' ')}`);
  const fake = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    setLevel: (): void => {},
    child: (): unknown => fake,
  };
  return { getLogger: () => fake };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));

const { IntrinsicFunctionResolver } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);
const { secretNameNeedlesOf } = await import('../../../src/deployment/deploy-engine/masking.js');
const { maskSecretsInText, recordLogOnlyValue } = await import(
  '../../../src/deployment/secret-redaction.js'
);
const { withPrintingSecrets, withCurrentResourceSecrets, getCurrentResourceSecrets } =
  await import('../../../src/deployment/resource-secrets-scope.js');
const { currentLogLineMasker } = await import('../../../src/utils/log-line-masker.js');
const { withStackName } = await import('../../../src/provisioning/resource-name.js');

type Bag = Map<string, string>;

const REF = '{{resolve:secretsmanager:sdin:SecretString:queue::}}';

/** A printing bag holding `needles` as LOG-ONLY needles, the way the engine records them. */
function logOnlyBag(needles: Iterable<string> | undefined): Bag {
  const bag: Bag = new Map();
  for (const needle of needles ?? []) recordLogOnlyValue(bag, needle);
  return bag;
}

describe('secretNameNeedlesOf — is a record named from a secret, and what does its id print as', () => {
  it('a state record whose name is still a reference: the id and its name segments', () => {
    const arn = 'arn:aws:sqs:us-east-1:123456789012:rotated-queue-name';
    const needles = secretNameNeedlesOf(
      'Queue',
      {
        resourceType: 'AWS::SQS::Queue',
        physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/rotated-queue-name',
        properties: { QueueName: REF },
      },
      undefined
    );
    // The ARN a `Fn::GetAtt` serves is a DIFFERENT wrapper than the URL id:
    // only the name segment covers both.
    expect(maskSecretsInText(`target ${arn}`, logOnlyBag(needles))).not.toContain('rotated');
  });

  it('a name resolved this deploy and REWRITTEN by its provider: every derived spelling', () => {
    const secret = 'alice@example.com';
    const bag: Bag = new Map([[secret, REF]]);
    withStackName('MyStack', () => {
      const needles = secretNameNeedlesOf(
        'Role',
        {
          resourceType: 'AWS::IAM::Role',
          physicalId: 'alice-example-com',
          properties: { RoleName: secret },
        },
        bag
      );
      const masked = logOnlyBag(needles);
      // The bare and the stack-prefixed spelling, neither of which is the
      // recorded plaintext.
      expect(maskSecretsInText('Attached policy to alice-example-com', masked)).toBe(
        'Attached policy to ***'
      );
      expect(
        maskSecretsInText('arn:aws:iam::123456789012:role/MyStack-alice-example-com', masked)
      ).not.toContain('alice');
    });
  });

  it('a resolved name keeps the rest of an ARN id readable', () => {
    const name = 'secret-queue-name';
    const needles = secretNameNeedlesOf(
      'Queue',
      {
        resourceType: 'AWS::SQS::Queue',
        physicalId: `https://sqs.us-east-1.amazonaws.com/123456789012/${name}`,
        properties: { QueueName: name },
      },
      new Map([[name, REF]])
    );
    expect(
      maskSecretsInText(`arn:aws:sqs:us-east-1:123456789012:${name}`, logOnlyBag(needles))
    ).toBe('arn:aws:sqs:us-east-1:123456789012:***');
  });

  it('a resolved name a service lower-cases is masked in its lower-cased id', () => {
    const name = 'TeamSecretCluster';
    const needles = secretNameNeedlesOf(
      'Cache',
      {
        resourceType: 'AWS::ElastiCache::CacheCluster',
        physicalId: 'teamsecretcluster',
        properties: { ClusterName: name },
      },
      new Map([[name, REF]])
    );
    expect(maskSecretsInText('Deleting teamsecretcluster', logOnlyBag(needles))).toBe(
      'Deleting ***'
    );
  });

  it('a resolved name too short to match inside the id is still its own needle', () => {
    // Below the substring floor, so only the name itself, matched WHOLE (a
    // provider masking the value it was handed), can withhold it.
    const needles = secretNameNeedlesOf(
      'Queue',
      {
        resourceType: 'AWS::SQS::Queue',
        physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/abc',
        properties: { QueueName: 'abc' },
      },
      new Map([['abc', REF]])
    );
    expect(maskSecretsInText('abc', logOnlyBag(needles))).toBe('***');
  });

  it('a secret in a NON-name property does not make the id a needle', () => {
    expect(
      secretNameNeedlesOf(
        'Db',
        {
          resourceType: 'AWS::RDS::DBCluster',
          physicalId: 'db-cluster-1',
          properties: { DBClusterIdentifier: 'db-cluster-1', MasterUserPassword: 'hunter22' },
        },
        new Map([['hunter22', REF]])
      )
    ).toBeUndefined();
    // Nor does a reference in one.
    expect(
      secretNameNeedlesOf(
        'Db',
        {
          resourceType: 'AWS::RDS::DBCluster',
          physicalId: 'db-cluster-1',
          properties: { MasterUserPassword: REF },
        },
        undefined
      )
    ).toBeUndefined();
  });

  it('an IAM Path taken from a secret makes the policy ARN a needle', () => {
    const arn = 'arn:aws:iam::123456789012:policy/team-path/Policy-1';
    const needles = secretNameNeedlesOf(
      'Policy',
      {
        resourceType: 'AWS::IAM::ManagedPolicy',
        physicalId: arn,
        properties: { Path: REF, PolicyDocument: {} },
      },
      undefined
    );
    expect(maskSecretsInText(`Attached managed policy ${arn}`, logOnlyBag(needles))).toBe(
      'Attached managed policy ***'
    );
  });

  it('an id embedding a recorded plaintext carries that plaintext for a reader', () => {
    const needles = secretNameNeedlesOf(
      'Field',
      { resourceType: 'AWS::AppSync::Resolver', physicalId: 'api1|Query|field', properties: {} },
      new Map([['Query', '***']])
    );
    expect([...(needles ?? [])]).toEqual(['Query']);
  });

  it('no physical id, or an ordinary name: nothing', () => {
    expect(
      secretNameNeedlesOf('Queue', { resourceType: 'AWS::SQS::Queue', properties: {} }, undefined)
    ).toBeUndefined();
    expect(
      secretNameNeedlesOf(
        'Queue',
        {
          resourceType: 'AWS::SQS::Queue',
          physicalId: 'https://sqs/1/plain',
          properties: { QueueName: 'plain' },
        },
        undefined
      )
    ).toBeUndefined();
  });
});

describe('the resolver records what it read from a secret-named resource (go-to-k/cdkd#3869)', () => {
  const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/sdin-secret-queue';
  const QUEUE_ARN = 'arn:aws:sqs:us-east-1:123456789012:sdin-secret-queue';

  beforeEach(() => {
    logLines.length = 0;
  });

  function contextFor(
    withNeedles: boolean,
    withAttributes = true
  ): import('../../../src/deployment/intrinsic-function-resolver.js').ResolverContext {
    const resources = {
      Queue: {
        physicalId: QUEUE_URL,
        resourceType: 'AWS::SQS::Queue',
        properties: { QueueName: REF },
        ...(withAttributes && { attributes: { Arn: QUEUE_ARN } }),
        dependencies: [],
      },
    };
    return {
      template: { Resources: { Queue: { Type: 'AWS::SQS::Queue', Properties: {} } } },
      resources,
      recordedSecretValues: new Map(),
      ...(withNeedles && {
        secretNameNeedles: (logicalId: string) =>
          secretNameNeedlesOf(
            logicalId,
            resources[logicalId as keyof typeof resources],
            undefined
          ),
      }),
    } as never;
  }

  it.each([
    ['Fn::GetAtt from attributes', { 'Fn::GetAtt': ['Queue', 'Arn'] }, QUEUE_ARN],
    ['Ref', { Ref: 'Queue' }, QUEUE_URL],
    ['Fn::Sub over a GetAtt', { 'Fn::Sub': '${Queue.Arn}/x' }, `${QUEUE_ARN}/x`],
  ])('%s: the value is served as is, and no line or reader masker prints the name', async (_l, node, served) => {
    const context = contextFor(true);
    const value = await new IntrinsicFunctionResolver().resolve(node, context);
    // The reader's REAL input: nothing is substituted.
    expect(value).toBe(served);
    // Log-only: nothing a persistence reader walks.
    expect(context.recordedSecretValues!.size).toBe(0);
    expect(logLines.join('\n')).not.toContain('sdin-secret-queue');
    expect(maskSecretsInText(`create failed for ${served}`, context.recordedSecretValues!)).not.toContain(
      'sdin-secret-queue'
    );
  });

  it('a CONSTRUCTED attribute (no recorded attributes) is recorded before its line', async () => {
    const context = contextFor(true, false);
    const value = await new IntrinsicFunctionResolver().resolve(
      { 'Fn::GetAtt': ['Queue', 'Arn'] },
      context
    );
    expect(value).toBe(QUEUE_ARN);
    expect(logLines.join('\n')).toContain('Resolved Fn::GetAtt:');
    expect(logLines.join('\n')).not.toContain('sdin-secret-queue');
  });

  it('the served value itself is a needle, where the id needles do not cover it', async () => {
    // A role whose PATH came from the secret: its id is the bare role name,
    // and only the ARN a `Fn::GetAtt` serves carries the path.
    const arn = 'arn:aws:iam::123456789012:role/sdin-secret-path/plain-role';
    const resources = {
      Role: {
        physicalId: 'plain-role',
        resourceType: 'AWS::IAM::Role',
        properties: { Path: REF },
        attributes: { Arn: arn },
        dependencies: [],
      },
    };
    const context = {
      template: { Resources: { Role: { Type: 'AWS::IAM::Role', Properties: {} } } },
      resources,
      recordedSecretValues: new Map(),
      secretNameNeedles: (logicalId: string) =>
        secretNameNeedlesOf(logicalId, resources[logicalId as 'Role'], undefined),
    } as never;
    expect(await new IntrinsicFunctionResolver().resolve({ 'Fn::GetAtt': ['Role', 'Arn'] }, context)).toBe(arn);
    expect(logLines.join('\n')).toContain('resolved to');
    expect(logLines.join('\n')).not.toContain('sdin-secret-path');
  });

  it('negative control: a context without the callback prints the name', async () => {
    const context = contextFor(false);
    await new IntrinsicFunctionResolver().resolve({ 'Fn::GetAtt': ['Queue', 'Arn'] }, context);
    expect(logLines.join('\n')).toContain('sdin-secret-queue');
  });
});

describe('withPrintingSecrets — a printing bag, not the resource bag (go-to-k/cdkd#3869)', () => {
  it('masks a line logged in its scope and leaves getCurrentResourceSecrets alone', () => {
    const printing = logOnlyBag(['derived-secret-name']);
    const own: Bag = new Map([['own-plaintext', REF]]);
    withCurrentResourceSecrets(own, () =>
      withPrintingSecrets(printing, () => {
        expect(getCurrentResourceSecrets()).toBe(own);
        expect(currentLogLineMasker()?.('drop derived-secret-name and own-plaintext')).toBe(
          'drop *** and ***'
        );
      })
    );
    withPrintingSecrets(printing, () => {
      expect(getCurrentResourceSecrets()).toBeUndefined();
    });
  });

  it('reads the bag by reference, so a needle registered mid-scope masks too', () => {
    const printing: Bag = new Map();
    withPrintingSecrets(printing, () => {
      expect(currentLogLineMasker()).toBeUndefined();
      recordLogOnlyValue(printing, 'late-derived-name');
      expect(currentLogLineMasker()?.('late-derived-name')).toBe('***');
    });
  });
});
