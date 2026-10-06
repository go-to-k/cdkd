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
const { secretNamePrintingBag, secretNamesReadBy, stateSecretNameNeedles } = await import(
  '../../../src/deployment/secret-name-needles.js'
);
const { hasMaskableValues, maskSecretsInText, recordLogOnlyValue } = await import(
  '../../../src/deployment/secret-redaction.js'
);

const REF = '{{resolve:secretsmanager:team:SecretString:user::}}';
const USER_ID = 'team-secret-user';

type Records = Parameters<typeof secretNamePrintingBag>[1];

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

describe('secretNamesReadBy / secretNamePrintingBag — what a destroy masks', () => {
  it("a reader carries the secret-named sibling's needles it holds", () => {
    expect([...secretNamesReadBy('Key', records().Key, records())]).toContain(USER_ID);
    expect(secretNamesReadBy('Plain', records().Plain, records()).size).toBe(0);
  });

  it("each resource's bag masks its own name and what it read", () => {
    expect(maskSecretsInText(`Deleting user ${USER_ID}`, secretNamePrintingBag('User', records()))).toBe(
      'Deleting user ***'
    );
    expect(
      maskSecretsInText(
        `Access key of ${USER_ID} deleted`,
        secretNamePrintingBag('Key', records())
      )
    ).toBe('Access key of *** deleted');
    // An ordinary resource binds nothing to mask.
    expect(hasMaskableValues(secretNamePrintingBag('Plain', records()))).toBe(false);
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

  function sinkContext(recordedSecretValues = new Map<string, string>()) {
    const resources = records();
    const sink = new Map<string, string>();
    return {
      sink,
      recordedSecretValues,
      context: {
        template: { Resources: {} },
        resources,
        recordedSecretValues,
        secretNameNeedles: stateSecretNameNeedles(resources),
        secretNameSink: sink,
      } as never,
    };
  }

  it('an Fn::Base64 encoding of text embedding the name is a sink needle too', async () => {
    // The CDK `UserData` shape: an encoding that decodes straight back to it.
    const { sink, context } = sinkContext();
    const encoded = (await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Base64': { 'Fn::Sub': 'q=${User}' } },
      context
    )) as string;
    expect(Buffer.from(encoded, 'base64').toString()).toBe(`q=${USER_ID}`);
    expect(maskSecretsInText(encoded, sink)).toBe('***');
    expect(logLines.join('\n')).toContain('Resolved Fn::Base64');
    expect(logLines.join('\n')).not.toContain(encoded);
  });

  it('a piece of the name, split and selected, is masked on every line', async () => {
    const { context } = sinkContext();
    const piece = await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Select': [1, { 'Fn::Split': ['-', { Ref: 'User' }] }] },
      context
    );
    expect(piece).toBe('secret');
    expect(logLines.join('\n')).toContain('Resolved Fn::Select');
    expect(logLines.join('\n')).not.toMatch(/\bsecret\b/);
  });

  it("the pass's own bag stays free of the encoding, even holding another log-only needle", async () => {
    // A pass bag with an unrelated log-only needle (`cdkd diff`'s `NoEcho`
    // values) takes the log-only carry; only the sink may hold the name's.
    const bag = new Map<string, string>();
    recordLogOnlyValue(bag, 'unrelated-noecho-value');
    const { context } = sinkContext(bag);
    const encoded = (await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Base64': { Ref: 'User' } },
      context
    )) as string;
    expect(maskSecretsInText(encoded, bag)).toBe(encoded);
  });

  it('the sink stays free of an encoding the printing bag alone masks', async () => {
    // The sink arm compares the masks WITH and WITHOUT the sink, both over the
    // printing bag: an encoding of a `NoEcho` value belongs to that bag only.
    const printing = new Map<string, string>();
    recordLogOnlyValue(printing, 'printing-only-noecho-value');
    const { sink, context } = sinkContext();
    recordLogOnlyValue(sink, 'unrelated-sink-needle');
    (context as { printingSecrets?: Map<string, string> }).printingSecrets = printing;
    const encoded = (await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Base64': 'pw=printing-only-noecho-value' },
      context
    )) as string;
    // Premise: the printing arm took it.
    expect(maskSecretsInText(encoded, printing)).toBe('***');
    expect(maskSecretsInText(encoded, sink)).toBe(encoded);
  });
});
