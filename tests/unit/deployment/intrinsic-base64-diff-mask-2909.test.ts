/**
 * Issue [#2909](https://github.com/go-to-k/cdkd/issues/2909): `Fn::Base64`
 * over a dynamic reference resolved differently on the deploy and diff paths.
 *
 * The deploy resolves the reference and encodes the PLAINTEXT, and the
 * encoding is a derived mask-only needle (issue #2759), so state persists
 * `***`. The diff pass sets `skipDynamicReferences`, under which a SECRET
 * reference stays a `{{resolve:...}}` token, and encoded the TOKEN. The two
 * never agreed, so such a resource diffed UPDATE on every run and
 * `cdkd diff --fail` was permanently red.
 *
 * Each positive case drives BOTH paths through the real resolver and the real
 * persistence redaction, and asserts the diff side equals what the deploy
 * persists. The negatives pin the two populations that must keep their real
 * encoding: input the deploy and the diff resolve alike (no reference, a
 * public `String` parameter, a token of a service cdkd does not resolve), and
 * the deploy path itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const debugSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: debugSpy,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

const PASSWORD = 'Zk7pQw2mVx';
const PUBLIC_VALUE = 'public-config-value';
const SECURE_VALUE = 'secure-param-value';

const sends = vi.hoisted(() => ({
  secretsManager: 0,
  ssm: [] as Array<{ Name?: string; WithDecryption?: boolean }>,
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: {
      send: vi.fn(async (command: { input?: { Name?: string; WithDecryption?: boolean } }) => {
        sends.ssm.push({ ...command.input });
        if (command.input?.Name === '/app/public') {
          return { Parameter: { Value: PUBLIC_VALUE, Type: 'String' } };
        }
        // A SecureString answers ciphertext when not decrypting, as SSM does.
        return {
          Parameter: {
            Value: command.input?.WithDecryption === true ? SECURE_VALUE : 'AQICAHciphertext',
            Type: 'SecureString',
          },
        };
      }),
    },
    secretsManager: {
      send: vi.fn(async () => {
        sends.secretsManager++;
        return { SecretString: JSON.stringify({ password: PASSWORD }) };
      }),
    },
  }),
}));

const { IntrinsicFunctionResolver, resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);
const { redactSecretsForState, SECRET_MASK, recordFreshNoEchoValuesIn, carriesFreshNoEchoValue } =
  await import(
  '../../../src/deployment/secret-redaction.js'
);

const SM_REF = '{{resolve:secretsmanager:s:SecretString:password}}';

function context(skipDynamicReferences: boolean): {
  template: { Resources: Record<string, never> };
  resources: Record<string, never>;
  stackName: string;
  recordedSecretValues: Map<string, string>;
  skipDynamicReferences?: boolean;
} {
  return {
    template: { Resources: {} },
    resources: {},
    stackName: 'Base64DiffMask',
    recordedSecretValues: new Map<string, string>(),
    ...(skipDynamicReferences ? { skipDynamicReferences: true } : {}),
  };
}

/** What a deploy of `property` sends to AWS, and what it persists. */
async function deploySide(property: unknown): Promise<{ sent: unknown; persisted: unknown }> {
  const ctx = context(false);
  const sent = await new IntrinsicFunctionResolver('us-east-1').resolve(property, ctx as never);
  const persisted = redactSecretsForState({ V: sent }, ctx.recordedSecretValues, { V: property });
  return { sent, persisted: persisted.V };
}

/** What the diff pass (deploy's or `cdkd diff`'s) compares against the record. */
async function diffSide(property: unknown): Promise<unknown> {
  return new IntrinsicFunctionResolver('us-east-1').resolve(property, context(true) as never);
}

beforeEach(() => {
  debugSpy.mockClear();
  sends.secretsManager = 0;
  sends.ssm = [];
  resetAccountInfoCache();
});

describe('issue #2909: Fn::Base64 over an unresolved secret reference compares as the persisted mask', () => {
  it.each([
    ['a bare secretsmanager reference (the measured shape)', { 'Fn::Base64': SM_REF }],
    [
      'the CDK UserData shape: a script joined around the reference',
      { 'Fn::Base64': { 'Fn::Join': ['', ['#!/bin/bash\nPW=', SM_REF, '\n']] } },
    ],
    [
      'an Fn::Sub body embedding the reference',
      { 'Fn::Base64': { 'Fn::Sub': `#!/bin/bash\nPW=${SM_REF}\n` } },
    ],
    ['an ssm-secure reference', { 'Fn::Base64': 'pw={{resolve:ssm-secure:/app/secure}}' }],
    [
      'a plain ssm reference whose parameter is a SecureString',
      { 'Fn::Base64': 'pw={{resolve:ssm:/app/secure}}' },
    ],
  ])('%s', async (_label, property) => {
    const deployed = await deploySide(property);
    // Vacuity guard: the deploy really encoded a plaintext and persisted the mask.
    expect(typeof deployed.sent).toBe('string');
    expect(deployed.sent).not.toBe(SECRET_MASK);
    expect(deployed.persisted).toBe(SECRET_MASK);
    sends.secretsManager = 0;
    sends.ssm = [];

    expect(await diffSide(property)).toBe(deployed.persisted);
    // The comparison path still fetches no secret value.
    expect(sends.secretsManager).toBe(0);
    expect(sends.ssm.every((input) => input.WithDecryption !== true)).toBe(true);
  });

  it('the diff-path line prints the mask and no encoding, beside a NoEcho value it masks', async () => {
    const noEcho = 'noecho-parameter-value';
    const ctx = {
      ...context(true),
      template: { Parameters: { P: { Type: 'String', NoEcho: true } }, Resources: {} },
      parameters: { P: noEcho },
    };
    const property = { 'Fn::Base64': { 'Fn::Join': ['', ['K=', { Ref: 'P' }, '\nPW=', SM_REF]] } };
    expect(await new IntrinsicFunctionResolver('us-east-1').resolve(property, ctx as never)).toBe(
      SECRET_MASK
    );
    const lines = debugSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('Resolved Fn::Base64: '));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`resolved to ${SECRET_MASK} (an unresolved secret reference`);
    expect(lines[0]).not.toContain(noEcho);
    expect(lines[0]).not.toContain(Buffer.from(`K=${noEcho}\nPW=${SM_REF}`).toString('base64'));
  });

  it('a Base64 input both sides resolve alike keeps its real encoding on the diff path', async () => {
    for (const property of [
      { 'Fn::Base64': '#!/bin/bash\necho hello\n' },
      // A public `String` parameter resolves on the comparison path too.
      { 'Fn::Base64': 'host={{resolve:ssm:/app/public}}' },
    ]) {
      const deployed = await deploySide(property);
      const diffed = await diffSide(property);
      expect(diffed).not.toBe(SECRET_MASK);
      expect(diffed).toBe(deployed.persisted);
      expect(diffed).toBe(deployed.sent);
    }
    expect(await diffSide({ 'Fn::Base64': 'host={{resolve:ssm:/app/public}}' })).toBe(
      Buffer.from(`host=${PUBLIC_VALUE}`).toString('base64')
    );
  });

  it('a token of a service cdkd does not resolve is encoded as written on both paths', async () => {
    const property = { 'Fn::Base64': 'x={{resolve:unsupported:thing}}' };
    const diffed = await diffSide(property);
    expect(diffed).toBe(Buffer.from('x={{resolve:unsupported:thing}}').toString('base64'));
    expect(diffed).toBe((await deploySide(property)).sent);
  });

  it('an input that also embeds a FRESH NoEcho value keeps its encoding, marked fresh (go-to-k/cdkd#3662)', async () => {
    // A cross-stack read recovered from a producer in the same `deploy --all`
    // records the re-minted value as fresh BEFORE the consumer's diff pass. The
    // mask would compare equal to the recorded `***` and the new value would
    // never be sent; the encoding diffs UPDATE and the engine refuses its skip.
    const fresh = 'freshly-minted-token-value';
    const ctx = context(true);
    recordFreshNoEchoValuesIn(fresh, ctx.recordedSecretValues);
    const text = `TOKEN=${fresh}\nPW=${SM_REF}`;
    const diffed = await new IntrinsicFunctionResolver('us-east-1').resolve(
      { 'Fn::Base64': text },
      ctx as never
    );
    expect(diffed).toBe(Buffer.from(text).toString('base64'));
    expect(carriesFreshNoEchoValue({ V: diffed }, ctx.recordedSecretValues)).toBe(true);
    expect(sends.secretsManager).toBe(0);
  });

  it('the deploy path still sends the encoding of the plaintext, never the mask', async () => {
    const { sent } = await deploySide({ 'Fn::Base64': SM_REF });
    expect(sent).toBe(Buffer.from(PASSWORD).toString('base64'));
    expect(sends.secretsManager).toBe(1);
  });
});
