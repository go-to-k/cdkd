/**
 * The two `ResolverContext` fields behind issue
 * [#4929](https://github.com/go-to-k/cdkd/issues/4929), against the REAL
 * resolver with only the leaf SDK clients faked:
 *
 * - `skippedSecretReferences` receives exactly the SECRET tokens a
 *   `skipDynamicReferences` pass leaves unresolved -- the ones the real pass
 *   resolves -- and never token text a `Ref` hands over as text, nor a public
 *   `ssm` token the comparison pass resolves.
 * - `secretStandInTokens` makes `Fn::Split` keep a named token whole on a
 *   comparison pass, and only there: a pass with real values ignores it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const { ssmResponses, ssmSends, secretSend } = vi.hoisted(() => ({
  ssmResponses: new Map<string, unknown>(),
  ssmSends: [] as Array<{ Name?: string; WithDecryption?: boolean }>,
  secretSend: vi.fn(async () => {
    throw new Error('a comparison pass must not fetch a secret');
  }),
}));

vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    SSMClient: class {
      readonly config = { region: () => Promise.resolve('us-east-1') };
      async send(command: { input?: { Name?: string; WithDecryption?: boolean } }) {
        const input = command.input ?? {};
        ssmSends.push(input);
        const response = ssmResponses.get(String(input.Name));
        if (response === undefined) throw new Error(`no ssm response for ${String(input.Name)}`);
        return response;
      }
      destroy(): void {}
    },
  };
});
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    SecretsManagerClient: vi.fn().mockImplementation(() => ({
      send: secretSend,
      config: { region: () => Promise.resolve('us-east-1') },
      destroy: () => undefined,
    })),
  };
});
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

import { AwsClients, resetAwsClients, setAwsClients } from '../../../src/utils/aws-clients.js';
import {
  IntrinsicFunctionResolver,
  resetAccountInfoCache,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { clearRecordedSecretExpressions } from '../../../src/deployment/secret-redaction/mask-only.js';
import {
  maskSecretsInText,
  recordLogOnlyValue,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const USER_EXPR = '{{resolve:secretsmanager:prod/db/cred:SecretString:user4929r::}}';
const PW_EXPR = '{{resolve:secretsmanager:prod/db/cred:SecretString:pw4929r::}}';
const SPELLING = `postgres://${USER_EXPR}:${PW_EXPR}@host`;
const SECURE_EXPR = '{{resolve:ssm-secure:/app/secure4929}}';
const SSM_SECURE_EXPR = '{{resolve:ssm:/app/securestring4929}}';
const SSM_PUBLIC_EXPR = '{{resolve:ssm:/app/public4929}}';

const PIECE = { 'Fn::Select': [1, { 'Fn::Split': [':', { Ref: 'Conn' }] }] };
const LIST = { 'Fn::Split': [':', { Ref: 'Conn' }] };

let resolver: IntrinsicFunctionResolver;

beforeEach(() => {
  ssmResponses.clear();
  ssmSends.length = 0;
  secretSend.mockClear();
  resetAccountInfoCache();
  clearRecordedSecretExpressions();
  setAwsClients(new AwsClients({ region: 'us-east-1' }));
  ssmResponses.set('/app/securestring4929', {
    Parameter: { Value: 'AQICAH-ciphertext', Type: 'SecureString' },
  });
  ssmResponses.set('/app/public4929', { Parameter: { Value: 'public-host', Type: 'String' } });
  resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
});

afterEach(() => {
  resetAwsClients();
  resetAccountInfoCache();
  clearRecordedSecretExpressions();
});

function comparisonContext(extra: Partial<ResolverContext> = {}): ResolverContext {
  return {
    template: { Resources: {} },
    resources: {},
    parameters: { Conn: SPELLING },
    skipDynamicReferences: true,
    ...extra,
  } as ResolverContext;
}

describe('secretStandInTokens (go-to-k/cdkd#4929)', () => {
  it('without it a comparison pass splits a Ref-reached token as text (the pre-fix answer)', async () => {
    expect(await resolver.resolve(PIECE, comparisonContext())).toBe('//{{resolve');
    expect(await resolver.resolve(LIST, comparisonContext())).toEqual(SPELLING.split(':'));
  });

  it('keeps each named token whole, in both read shapes', async () => {
    const context = comparisonContext({ secretStandInTokens: new Set([USER_EXPR, PW_EXPR]) });
    expect(await resolver.resolve(PIECE, context)).toBe(`//${USER_EXPR}`);
    expect(await resolver.resolve(LIST, context)).toEqual([
      'postgres',
      `//${USER_EXPR}`,
      `${PW_EXPR}@host`,
    ]);
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('keeps ONLY the named tokens whole: an unnamed one is still split as text', async () => {
    const context = comparisonContext({ secretStandInTokens: new Set([USER_EXPR]) });
    const pieces = (await resolver.resolve(LIST, context)) as string[];
    expect(pieces.slice(0, 2)).toEqual(['postgres', `//${USER_EXPR}`]);
    expect(pieces.length).toBeGreaterThan(3);
    expect(pieces).not.toContain(`${PW_EXPR}@host`);
  });

  it('a pass holding real values ignores it and splits as CloudFormation does', async () => {
    const context = comparisonContext({
      skipDynamicReferences: false,
      secretStandInTokens: new Set([USER_EXPR, PW_EXPR]),
    });
    expect(await resolver.resolve(LIST, context)).toEqual(SPELLING.split(':'));
  });
});

describe('a NoEcho value split with its token kept whole stays masked on the printed pieces (go-to-k/cdkd#4929)', () => {
  const TOKEN = '{{resolve:secretsmanager:s:SecretString:pw::}}';
  const NOECHO = `u:${TOKEN}Z:x`;

  it("records each KEPT piece's share of the needle, so a sub-floor plain fragment (`}}Z`) is masked inside it", async () => {
    const bag: RecordedSecretValues = new Map();
    recordLogOnlyValue(bag, NOECHO);
    const context = comparisonContext({
      parameters: { Conn: NOECHO },
      recordedSecretValues: bag,
      secretStandInTokens: new Set([TOKEN]),
    });
    const pieces = (await resolver.resolve(LIST, context)) as string[];
    expect(pieces).toEqual(['u', `${TOKEN}Z`, 'x']);
    // Every printed piece carrying NoEcho-literal text is masked whole.
    for (const piece of pieces) {
      expect(maskSecretsInText(piece, bag)).not.toContain('Z');
    }
    expect(maskSecretsInText(pieces.join('|'), bag)).not.toMatch(/\}\}Z/);
  });
});

describe('skippedSecretReferences (go-to-k/cdkd#4929)', () => {
  async function skipped(value: unknown): Promise<string[]> {
    const sink = new Set<string>();
    await resolver.resolve(value, comparisonContext({ skippedSecretReferences: sink }));
    return [...sink].sort();
  }

  it('records each secretsmanager / ssm-secure token of a template literal', async () => {
    expect(await skipped(`a-${USER_EXPR}-${SECURE_EXPR}`)).toEqual([SECURE_EXPR, USER_EXPR].sort());
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('records a token Fn::Join / Fn::Sub assembles, a Ref part included', async () => {
    expect(await skipped({ 'Fn::Join': ['', ['x', { Ref: 'Conn' }]] })).toEqual(
      [PW_EXPR, USER_EXPR].sort()
    );
    expect(await skipped({ 'Fn::Sub': `u=${USER_EXPR}` })).toEqual([USER_EXPR]);
  });

  it('records a plain ssm token whose parameter is a SecureString, asked without decryption', async () => {
    expect(await skipped(`v=${SSM_SECURE_EXPR}`)).toEqual([SSM_SECURE_EXPR]);
    expect(ssmSends).toEqual([{ Name: '/app/securestring4929', WithDecryption: false }]);
  });

  it('never records a public ssm token, which the comparison pass resolves', async () => {
    expect(await skipped(`v=${SSM_PUBLIC_EXPR}`)).toEqual([]);
  });

  it('never records token TEXT a Ref hands over, which the real pass does not resolve', async () => {
    expect(await skipped({ Ref: 'Conn' })).toEqual([]);
    expect(await skipped(LIST)).toEqual([]);
  });
});
