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
const { buildFinalSnapshotIdentifier } = await import(
  '../../../src/provisioning/final-snapshot.js'
);

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

  it('before an id exists: the resolved name and its derived spellings, never a reference', () => {
    const name = 'pre-create-name';
    const needles = secretNameNeedlesOf(
      'Queue',
      { resourceType: 'AWS::SQS::Queue', properties: { QueueName: name } },
      new Map([[name, REF]])
    );
    expect([...(needles ?? [])]).toEqual([name]);
    // A reference has no plaintext to spell and no id to stand in for it.
    expect(
      secretNameNeedlesOf(
        'Queue',
        { resourceType: 'AWS::SQS::Queue', properties: { QueueName: REF } },
        undefined
      )
    ).toBeUndefined();
  });

  it('a stack-wide NoEcho value embedded by chance in an id is no evidence (embedded bag narrower)', () => {
    const noEcho: Bag = new Map();
    recordLogOnlyValue(noEcho, 'prod');
    // No name key reads the value: only the EMBEDDED arm could take it.
    const record = {
      resourceType: 'AWS::AppSync::Resolver',
      physicalId: 'api1|prod|field',
      properties: { FieldName: 'field' },
    };
    expect(secretNameNeedlesOf('Queue', record, noEcho, { embedded: undefined })).toBeUndefined();
    // Control: the same value in the embedded bag is carried.
    expect([...(secretNameNeedlesOf('Queue', record, noEcho, { embedded: noEcho }) ?? [])]).toEqual(['prod']);
  });

  it('short names: an id EQUAL to a recorded plaintext, and no short lower-cased spelling', () => {
    expect([
      ...(secretNameNeedlesOf(
        'Stage',
        { resourceType: 'AWS::ApiGatewayV2::Stage', physicalId: 'abc', properties: {} },
        new Map([['abc', REF]])
      ) ?? []),
    ]).toEqual(['abc']);
    // `ABC` lower-cased would be a 3-character needle masking every `abc`.
    expect([
      ...(secretNameNeedlesOf(
        'Stage',
        {
          resourceType: 'AWS::ApiGatewayV2::Stage',
          physicalId: 'stage-id-1',
          properties: { StageName: 'ABC' },
        },
        new Map([['ABC', REF]])
      ) ?? []),
    ]).toEqual(['ABC']);
  });

  it('nothing named from a secret: nothing', () => {
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

  it('an attribute that carries no needle is not recorded (an endpoint port)', async () => {
    const context = contextFor(true);
    (context.resources['Queue'] as { attributes: Record<string, unknown> }).attributes = {
      Arn: QUEUE_ARN,
      Port: '5432',
    };
    await new IntrinsicFunctionResolver().resolve({ 'Fn::GetAtt': ['Queue', 'Port'] }, context);
    expect(maskSecretsInText('port 5432', context.recordedSecretValues!)).toBe('port 5432');
  });

  it('a served leaf containing a needle under the substring floor is not recorded', async () => {
    // A 3-character name: the needle itself is recorded (whole-text masking),
    // but a leaf merely CONTAINING it is not, or every ARN holding those three
    // characters would be withheld.
    const resources = {
      Q: {
        physicalId: 'abc',
        resourceType: 'AWS::Example::Thing',
        properties: { ThingName: REF },
        attributes: { Arn: 'arn:aws:example:us-east-1:123456789012:thing/abc' },
        dependencies: [],
      },
    };
    const bag: Bag = new Map();
    await new IntrinsicFunctionResolver().resolve({ 'Fn::GetAtt': ['Q', 'Arn'] }, {
      template: { Resources: { Q: { Type: 'AWS::Example::Thing', Properties: {} } } },
      resources,
      recordedSecretValues: bag,
      secretNameNeedles: (logicalId: string) =>
        secretNameNeedlesOf(logicalId, resources[logicalId as 'Q'], undefined),
    } as never);
    expect(maskSecretsInText('abc', bag)).toBe('***');
    expect(maskSecretsInText('arn:aws:example:us-east-1:123456789012:thing/abc', bag)).toBe(
      'arn:aws:example:us-east-1:123456789012:thing/abc'
    );
  });

  it("a context carrying a print-only bag records there, never into the pass's own", async () => {
    // The deploy engine's nested-stack row: its own bag seeds the child.
    const context = contextFor(true);
    const printing: Bag = new Map();
    (context as { printingSecrets?: Bag }).printingSecrets = printing;
    await new IntrinsicFunctionResolver().resolve({ 'Fn::GetAtt': ['Queue', 'Arn'] }, context);
    expect(maskSecretsInText(QUEUE_ARN, context.recordedSecretValues!)).toBe(QUEUE_ARN);
    expect(maskSecretsInText(QUEUE_ARN, printing)).not.toContain('sdin-secret-queue');
    expect(logLines.join('\n')).toContain('resolved to');
    expect(logLines.join('\n')).not.toContain('sdin-secret-queue');
  });

  it.each([
    ['with the callback', true],
    ['negative control, without it', false],
  ])('a GetAtt REFUSAL that renders the target id masks it %s', async (_label, withNeedles) => {
    // `guardedPhysicalIdFallback` refuses an `...Arn` attribute it would
    // answer with a non-ARN physical id, quoting that id, before any served
    // value exists to record.
    const resources = {
      Thing: {
        physicalId: 'sdin-secret-thing',
        resourceType: 'AWS::Example::Thing',
        properties: { ThingName: REF },
        dependencies: [],
      },
    };
    const context = {
      template: { Resources: { Thing: { Type: 'AWS::Example::Thing', Properties: {} } } },
      resources,
      recordedSecretValues: new Map(),
      ...(withNeedles && {
        secretNameNeedles: (logicalId: string) =>
          secretNameNeedlesOf(logicalId, resources[logicalId as 'Thing'], undefined),
      }),
    } as never;
    const error = await new IntrinsicFunctionResolver()
      .resolve({ 'Fn::GetAtt': ['Thing', 'ThingArn'] }, context)
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    expect(error?.message).toContain('Cannot resolve Fn::GetAtt');
    if (withNeedles) expect(error?.message).not.toContain('sdin-secret-thing');
    else expect(error?.message).toContain('sdin-secret-thing');
  });

  it('the reader bag holds the target id itself, not only what it served', async () => {
    const context = contextFor(true);
    await new IntrinsicFunctionResolver().resolve({ 'Fn::GetAtt': ['Queue', 'Arn'] }, context);
    expect(maskSecretsInText('queue sdin-secret-queue', context.recordedSecretValues!)).not.toContain(
      'sdin-secret-queue'
    );
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

  it('two interleaved scopes each mask only their own bag', async () => {
    const first = logOnlyBag(['first-derived-name']);
    const second = logOnlyBag(['second-derived-name']);
    const line = 'first-derived-name second-derived-name';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const a = withPrintingSecrets(first, async () => {
      await gate;
      return currentLogLineMasker()?.(line);
    });
    const b = withPrintingSecrets(second, async () => {
      const seen = currentLogLineMasker()?.(line);
      release();
      return seen;
    });
    expect(await b).toBe('first-derived-name ***');
    expect(await a).toBe('*** second-derived-name');
  });

  it('an inner scope leaves the enclosing scope as it was once it returns', () => {
    const own: Bag = new Map([['own-plaintext', REF]]);
    withCurrentResourceSecrets(own, () => {
      withPrintingSecrets(logOnlyBag(['inner-derived-name']), () => {
        expect(currentLogLineMasker()?.('inner-derived-name')).toBe('***');
      });
      expect(currentLogLineMasker()?.('inner-derived-name own-plaintext')).toBe(
        'inner-derived-name ***'
      );
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

describe('secretNameNeedlesOf — an ElastiCache final-snapshot name cut across a needle', () => {
  const RG = 'AWS::ElastiCache::ReplicationGroup';
  const AT = new Date('2026-08-03T04:05:06Z');
  const snapshotLine = (id: string, type = RG): string =>
    `Creating final snapshot ${buildFinalSnapshotIdentifier(id, type, AT)} for Cache (${id})`;

  it('a name resolved this deploy: the 28-character snapshot base is masked', () => {
    const name = 'Cdkd-Secret-Derived-Cache-Group-01';
    const id = name.toLowerCase();
    const needles = secretNameNeedlesOf(
      'Cache',
      { resourceType: RG, physicalId: id, properties: { ReplicationGroupId: name } },
      new Map([[name, REF]])
    );
    expect(maskSecretsInText(snapshotLine(id), logOnlyBag(needles))).toBe(
      'Creating final snapshot ***20260803-040506 for Cache (***)'
    );
  });

  it('a NoEcho value the id embeds: no fragment of it survives in the snapshot base', () => {
    const token = 'cdkd-noecho-0123456789abcdef';
    const id = `rg-${token}`;
    const noEcho = logOnlyBag([token]);
    const needles = secretNameNeedlesOf(
      'Cache',
      { resourceType: RG, physicalId: id, properties: { ReplicationGroupId: id } },
      noEcho,
      { embedded: noEcho }
    );
    const masked = maskSecretsInText(snapshotLine(id), logOnlyBag(needles));
    expect(masked).not.toContain('0123456789');
    expect(masked).toContain('***20260803-040506');
  });

  it('an embedded needle alone, with no name key: the prefix stands in for its fragment', () => {
    const token = 'cdkd-noecho-0123456789abcdef';
    const id = `rg-${token}`;
    const needles = secretNameNeedlesOf(
      'Cache',
      { resourceType: RG, physicalId: id, properties: {} },
      undefined,
      { embedded: logOnlyBag([token]) }
    );
    expect([...(needles ?? [])].sort()).toEqual([`${id.slice(0, 28)}-final-`, token].sort());
  });

  it('a cache cluster (the atomic delete parameter) is cut the same way', () => {
    const name = 'cdkd-secret-derived-cache-cluster-01';
    const needles = secretNameNeedlesOf(
      'Cluster',
      {
        resourceType: 'AWS::ElastiCache::CacheCluster',
        physicalId: name,
        properties: { ClusterName: name },
      },
      new Map([[name, REF]])
    );
    expect([...(needles ?? [])]).toContain(`${name.slice(0, 28)}-final-`);
  });

  it('a mixed-case needle the cut splits is found in the case-folded base', () => {
    // AWS returns a lowercase id; a mixed-case one pins the fold defensively.
    const token = 'NoEchoToken-0123456789ABCDEF';
    const id = `Rg-${token}`;
    const needles = secretNameNeedlesOf(
      'Cache',
      { resourceType: RG, physicalId: id, properties: {} },
      undefined,
      { embedded: logOnlyBag([token]) }
    );
    expect([...(needles ?? [])]).toContain(`${id.toLowerCase().slice(0, 28)}-final-`);
  });

  it('a mixed-case needle wholly inside the kept part adds its lowercased spelling', () => {
    const id = 'SecretHead-plain-tail-plain-tail';
    const needles = secretNameNeedlesOf(
      'Cache',
      { resourceType: RG, physicalId: id, properties: {} },
      undefined,
      { embedded: logOnlyBag(['SecretHead']) }
    );
    expect([...(needles ?? [])].sort()).toEqual(['SecretHead', 'secrethead']);
    expect(maskSecretsInText(snapshotLine(id), logOnlyBag(needles))).not.toContain('secrethead');
  });

  it('folds a needle through the base charset: a character outside it, and a run of hyphens', () => {
    const id = 'team_secret--value_x-plain-tail-plain';
    const needles = secretNameNeedlesOf(
      'Db',
      { resourceType: 'AWS::RDS::DBInstance', physicalId: id, properties: {} },
      undefined,
      { embedded: logOnlyBag(['team_secret--value']) }
    );
    expect([...(needles ?? [])].sort()).toEqual(['team-secret-value', 'team_secret--value']);
    expect(
      maskSecretsInText(snapshotLine(id, 'AWS::RDS::DBInstance'), logOnlyBag(needles))
    ).not.toContain('team-secret-value');
  });

  it('judges the substring floor on the folded spelling: one folding below it adds nothing', () => {
    const id = 'ab___cd-plain-tail';
    const needles = secretNameNeedlesOf(
      'Db',
      { resourceType: 'AWS::RDS::DBInstance', physicalId: id, properties: {} },
      undefined,
      { embedded: logOnlyBag(['ab___']) }
    );
    expect([...(needles ?? [])]).toEqual(['ab___']);
  });

  it('reads every occurrence: a needle inside the kept part AND across the cut', () => {
    const id = `sekret-${'a'.repeat(19)}sekret-tail`;
    const needles = secretNameNeedlesOf(
      'Cache',
      { resourceType: RG, physicalId: id, properties: {} },
      undefined,
      { embedded: logOnlyBag(['sekret']) }
    );
    expect([...(needles ?? [])]).toContain(`${id.slice(0, 28)}-final-`);
  });

  it('adds nothing for a needle that starts at, or ends exactly at, the cut', () => {
    const judge = (id: string, needle: string): string[] => [
      ...(secretNameNeedlesOf(
        'Cache',
        { resourceType: RG, physicalId: id, properties: {} },
        undefined,
        { embedded: logOnlyBag([needle]) }
      ) ?? []),
    ];
    const startsAtCut = `${'a'.repeat(28)}tok1-tail`;
    expect(startsAtCut.indexOf('tok1-tail')).toBe(28);
    expect(judge(startsAtCut, 'tok1-tail')).toEqual(['tok1-tail']);
    const endsAtCut = `${'a'.repeat(22)}ends12-tail`;
    expect(endsAtCut.indexOf('ends12') + 'ends12'.length).toBe(28);
    expect(judge(endsAtCut, 'ends12')).toEqual(['ends12']);
  });

  it('adds nothing for a needle wholly inside the kept part, which already matches', () => {
    const id = 'secret-head-plain-tail-plain-tail';
    const needles = secretNameNeedlesOf(
      'Cache',
      { resourceType: RG, physicalId: id, properties: {} },
      undefined,
      { embedded: logOnlyBag(['secret-head']) }
    );
    expect([...(needles ?? [])]).toEqual(['secret-head']);
    expect(maskSecretsInText(snapshotLine(id), logOnlyBag(needles))).toContain(
      '***-plain-tail-plain-final-'
    );
  });

  it('adds nothing for a needle wholly past the cut, which the snapshot name does not carry', () => {
    const id = 'plain-replication-group-head-tok-secret-value';
    const needles = secretNameNeedlesOf(
      'Cache',
      { resourceType: RG, physicalId: id, properties: {} },
      undefined,
      { embedded: logOnlyBag(['tok-secret-value']) }
    );
    expect([...(needles ?? [])]).toEqual(['tok-secret-value']);
  });

  it('adds nothing for a needle below the substring floor, which masks only a whole string', () => {
    const id = `${'a'.repeat(26)}xyz-tail`;
    const needles = secretNameNeedlesOf(
      'Cache',
      { resourceType: RG, physicalId: id, properties: { ReplicationGroupId: 'xyz' } },
      new Map([['xyz', REF]])
    );
    expect([...(needles ?? [])]).toEqual(['xyz']);
  });

  it('adds nothing for a type whose snapshot base keeps the whole id', () => {
    const name = 'cdkd-secret-derived-database-instance-01';
    const needles = secretNameNeedlesOf(
      'Db',
      {
        resourceType: 'AWS::RDS::DBInstance',
        physicalId: name,
        properties: { DBInstanceIdentifier: name },
      },
      new Map([[name, REF]])
    );
    expect([...(needles ?? [])]).toEqual([name]);
  });
});
