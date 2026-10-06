/**
 * The shared derived-name judge's state-side helpers (go-to-k/cdkd#3869):
 * the callback the CLI commands give their resolver contexts, the per-resource
 * printing bag `cdkd destroy` binds, and the print-only `secretNameSink` the
 * resolver records a command's reads into.
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
const { destroySecretNameBag, secretNamesReadBy, stateSecretNameNeedles } = await import(
  '../../../src/deployment/secret-name-needles.js'
);
const { hasMaskableValues, maskSecretsInText } = await import(
  '../../../src/deployment/secret-redaction.js'
);

const REF = '{{resolve:secretsmanager:team:SecretString:user::}}';
const USER_ID = 'team-secret-user';

type Records = Parameters<typeof destroySecretNameBag>[1];

const records = (): Records =>
  ({
    User: {
      physicalId: USER_ID,
      resourceType: 'AWS::IAM::User',
      properties: { UserName: REF },
      dependencies: [],
    },
    Key: {
      physicalId: 'AKIAEXAMPLEKEY',
      resourceType: 'AWS::IAM::AccessKey',
      properties: { UserName: USER_ID },
      dependencies: ['User'],
    },
    Plain: {
      physicalId: 'plain-bucket',
      resourceType: 'AWS::S3::Bucket',
      properties: { BucketName: 'plain-bucket' },
      dependencies: [],
    },
  }) as unknown as Records;

describe('stateSecretNameNeedles — the CLI commands’ callback', () => {
  it('judges a state record from its persisted reference, and nothing else', () => {
    const needles = stateSecretNameNeedles(records());
    expect([...(needles('User') ?? [])]).toContain(USER_ID);
    expect(needles('Plain')).toBeUndefined();
    expect(needles('Missing')).toBeUndefined();
  });
});

describe('secretNamesReadBy / destroySecretNameBag — what a destroy masks', () => {
  it("a reader carries the secret-named sibling's needles it holds", () => {
    expect([...secretNamesReadBy('Key', records().Key, records())]).toContain(USER_ID);
    expect(secretNamesReadBy('Plain', records().Plain, records()).size).toBe(0);
  });

  it("each resource's bag masks its own name and what it read", () => {
    expect(maskSecretsInText(`Deleting user ${USER_ID}`, destroySecretNameBag('User', records()))).toBe(
      'Deleting user ***'
    );
    expect(
      maskSecretsInText(
        `Access key of ${USER_ID} deleted`,
        destroySecretNameBag('Key', records())
      )
    ).toBe('Access key of *** deleted');
    // An ordinary resource binds nothing to mask.
    expect(hasMaskableValues(destroySecretNameBag('Plain', records()))).toBe(false);
  });
});

describe('ResolverContext.secretNameSink — a command’s print-only sink', () => {
  beforeEach(() => {
    logLines.length = 0;
  });

  it('records there, never into the pass bag or printingSecrets, and masks the line', async () => {
    const recordedSecretValues = new Map<string, string>();
    const printingSecrets = new Map<string, string>();
    const sink = new Map<string, string>();
    const resources = records();
    const value = await new IntrinsicFunctionResolver().resolve(
      { Ref: 'User' },
      {
        template: { Resources: {} },
        resources,
        recordedSecretValues,
        printingSecrets,
        secretNameNeedles: stateSecretNameNeedles(resources),
        secretNameSink: sink,
      } as never
    );
    expect(value).toBe(USER_ID);
    expect(hasMaskableValues(recordedSecretValues)).toBe(false);
    expect(hasMaskableValues(printingSecrets)).toBe(false);
    expect(maskSecretsInText(USER_ID, sink)).toBe('***');
    expect(logLines.join('\n')).toContain('resolved to');
    expect(logLines.join('\n')).not.toContain(USER_ID);
  });
});
