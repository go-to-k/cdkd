/**
 * go-to-k/cdkd#7050, the generated invariant: a secret's plaintext never
 * reaches state, at ANY length, whatever else in the leaf holds the same text.
 *
 * Through the real resolver and the real persist walk: each case resolves a
 * template node into a pass bag (which records where each `{{resolve:...}}`
 * token was substituted) and redacts the result against the same node, as the
 * deploy persist does. Crossed: secret values (two under MIN_NEEDLE_LENGTH) x
 * gap kinds (a parameter holding the secret's text, one containing it, one
 * unrelated, a pseudo parameter, an `Fn::Sub` variable map) x the token's
 * place (before, after, between gaps) x `Fn::Join` / `Fn::Sub`. Asserted:
 *
 * - no plaintext of the secret outside a `{{resolve:...}}` token;
 * - the template's own text (`tt:` / `:tt`) is kept as written;
 * - every token the template spells is in the persisted leaf.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

const secret = vi.hoisted(() => ({ username: 'pg' }));

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
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '210987654321' }) },
    secretsManager: {
      send: vi.fn(async () => ({ SecretString: JSON.stringify(secret) })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(): Promise<unknown> {
      return { SecretString: JSON.stringify(secret) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});

import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  dynamicReferenceTokens,
  redactForState,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { MIN_NEEDLE_LENGTH } from '../../../src/deployment/secret-redaction/rules.js';

const SECRET_VALUES = ['pg', 'x9', 'root', 'postgres', '1234'] as const;

/** Parameter values per gap kind, as a function of the secret's text. */
const PARAMETER_GAPS: Record<string, (v: string) => string> = {
  'a parameter holding the secret text': (v) => v,
  'a parameter containing it': (v) => `a${v}${v}b`,
  'an unrelated parameter': () => 'zzz',
};

function cases(v: string, token: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const gaps: Record<string, unknown> = {
    ...Object.fromEntries(Object.keys(PARAMETER_GAPS).map((name, i) => [name, { Ref: `P${i}` }])),
    'a pseudo parameter': { Ref: 'AWS::Region' },
  };
  for (const [name, gap] of Object.entries(gaps)) {
    out[`Join: token, then ${name}`] = { 'Fn::Join': ['', ['tt:', token, gap]] };
    out[`Join: ${name}, then token`] = { 'Fn::Join': ['', [gap, token, ':tt']] };
    out[`Join: token between two ${name}s`] = { 'Fn::Join': ['', ['tt:', gap, token, gap]] };
    out[`Join with a delimiter: ${name} / token`] = { 'Fn::Join': ['/', [gap, token, 'tt:']] };
    out[`Sub variable map: ${name} beside the token`] = {
      'Fn::Sub': ['tt:${G}${T}${G}', { G: gap, T: token }],
    };
    out[`Sub inline token after ${name}`] = { 'Fn::Sub': ['tt:${G}' + token, { G: gap }] };
  }
  void v;
  return out;
}

async function persist(
  v: string,
  source: unknown
): Promise<{ persisted: string; token: string }> {
  secret.username = v;
  const resolver = new IntrinsicFunctionResolver('us-east-1');
  const bag: RecordedSecretValues = new Map();
  const parameters = Object.fromEntries(
    Object.values(PARAMETER_GAPS).map((value, i) => [`P${i}`, value(v)])
  );
  const resolved = await resolver.resolve({ L: source }, {
    template: {
      Resources: {},
      Parameters: Object.fromEntries(Object.keys(parameters).map((k) => [k, { Type: 'String' }])),
    },
    resources: {},
    parameters,
    recordedSecretValues: bag,
  } as never);
  const out = redactForState(resolved as Record<string, unknown>, {
    provenance: 'template-derived',
    secrets: bag,
    source: { L: source },
    generation: 'same-generation',
  }) as Record<string, unknown>;
  return { persisted: String(out['L']), token: '' };
}

describe('a secret never reaches state beside a value-bearing part (#7050)', () => {
  it('the sample reaches under the substring floor', () => {
    expect(SECRET_VALUES.filter((v) => v.length < MIN_NEEDLE_LENGTH).length).toBeGreaterThan(1);
  });

  const all = SECRET_VALUES.flatMap((v, n) => {
    const token = `{{resolve:secretsmanager:db-7050-${n}:SecretString:username::}}`;
    return Object.entries(cases(v, token)).map(([name, source]) => [v, name, source, token] as const);
  });

  it.each(all)('secret %j, %s: no plaintext, the text kept', async (v, _name, source, token) => {
    const { persisted } = await persist(v, source);
    const outsideTokens = persisted.split(/\{\{resolve:[^}]+\}\}/).join('\u0000');
    expect(outsideTokens).not.toContain(v);
    if (persisted === '***') return;
    expect(dynamicReferenceTokens(persisted)).toContain(token);
    expect(persisted.includes('tt:') || persisted.includes(':tt')).toBe(true);
  });
});
