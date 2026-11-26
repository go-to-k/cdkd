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

const secret = vi.hoisted(() => ({ username: 'pg', other: 'zz' }));

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
/** A second secret of the same bag, referenced by another property, under the floor. */
const OTHER = 'zz';

/** Parameter values per gap kind, as a function of the secret's text. */
const PARAMETER_GAPS: Record<string, (v: string) => string> = {
  'a parameter holding the secret text': (v) => v,
  'a parameter containing it': (v) => `a${v}${v}b`,
  'an unrelated parameter': () => 'qqq',
  "a parameter containing the OTHER secret's text": () => `x${OTHER}x`,
};
const REGION = 'us-east-1';

type Part = { text: string } | { token: true } | { gap: string };

/**
 * The persisted spelling the rule gives (go-to-k/cdkd#7050): template text as
 * written, the token as itself, and a gap's value with the leaf's OWN secret
 * text written as the token (another secret's sub-floor text is a public
 * value's own bytes, and stays).
 */
function expected(parts: readonly Part[], delimiter: string, v: string, token: string, gapValue: (name: string) => string): string {
  return parts
    .map((part) =>
      'text' in part ? part.text : 'token' in part ? token : gapValue(part.gap).split(v).join(token)
    )
    .join(delimiter);
}

interface Case {
  source: unknown;
  expected: string;
}

function cases(v: string, token: string): Record<string, Case> {
  const out: Record<string, Case> = {};
  const gapNodes: Record<string, unknown> = {
    ...Object.fromEntries(Object.keys(PARAMETER_GAPS).map((name, i) => [name, { Ref: `P${i}` }])),
    'a pseudo parameter': { Ref: 'AWS::Region' },
  };
  const gapValue = (name: string): string =>
    name === 'a pseudo parameter' ? REGION : PARAMETER_GAPS[name]!(v);
  const node = (part: Part): unknown =>
    'text' in part ? part.text : 'token' in part ? token : gapNodes[part.gap];
  for (const gap of Object.keys(gapNodes)) {
    for (const text of ['tt:', `${v}-`]) {
      const shapes: Record<string, Part[]> = {
        'token, then the gap': [{ text }, { token: true }, { gap }],
        'the gap, then the token': [{ gap }, { token: true }, { text }],
        'the token between two gaps': [{ text }, { gap }, { token: true }, { gap }],
      };
      for (const [shape, parts] of Object.entries(shapes)) {
        out[`Join, ${shape}: ${gap}, text ${JSON.stringify(text)}`] = {
          source: { 'Fn::Join': ['', parts.map(node)] },
          expected: expected(parts, '', v, token, gapValue),
        };
        out[`Join with a delimiter, ${shape}: ${gap}, text ${JSON.stringify(text)}`] = {
          source: { 'Fn::Join': ['/', parts.map(node)] },
          expected: expected(parts, '/', v, token, gapValue),
        };
      }
      const subParts: Part[] = [{ text }, { gap }, { token: true }, { gap }];
      out[`Sub variable map: ${gap}, text ${JSON.stringify(text)}`] = {
        source: { 'Fn::Sub': [`${text}\${G}\${T}\${G}`, { G: gapNodes[gap], T: token }] },
        expected: expected(subParts, '', v, token, gapValue),
      };
      out[`Sub inline token: ${gap}, text ${JSON.stringify(text)}`] = {
        source: { 'Fn::Sub': [`${text}\${G}${token}`, { G: gapNodes[gap] }] },
        expected: expected([{ text }, { gap }, { token: true }], '', v, token, gapValue),
      };
    }
  }
  return out;
}

async function persist(v: string, source: unknown, other: string): Promise<string> {
  secret.username = v;
  const resolver = new IntrinsicFunctionResolver('us-east-1');
  const bag: RecordedSecretValues = new Map();
  const parameters = Object.fromEntries(
    Object.values(PARAMETER_GAPS).map((value, i) => [`P${i}`, value(v)])
  );
  // `M` puts a second, sub-floor secret into the same pass bag.
  const template = { L: source, M: other };
  const resolved = await resolver.resolve(template, {
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
    source: template,
    generation: 'same-generation',
  }) as Record<string, unknown>;
  expect(out['M']).toBe(other);
  return String(out['L']);
}

describe('a secret never reaches state beside a value-bearing part (#7050)', () => {
  it('the sample reaches under the substring floor', () => {
    expect(SECRET_VALUES.filter((v) => v.length < MIN_NEEDLE_LENGTH).length).toBeGreaterThan(1);
    expect(OTHER.length).toBeLessThan(MIN_NEEDLE_LENGTH);
  });

  const all = SECRET_VALUES.flatMap((v, n) => {
    const token = `{{resolve:secretsmanager:db-7050-${n}:SecretString:username::}}`;
    const other = `{{resolve:secretsmanager:db-7050-${n}:SecretString:other::}}`;
    return Object.entries(cases(v, token)).map(([name, c]) => [v, name, c, other] as const);
  });

  it.each(all)('secret %j, %s', async (v, _name, c, other) => {
    const persisted = await persist(v, c.source, other);
    // The exact spelling: the template's text kept, every own secret byte a
    // token, and nothing else rewritten.
    expect(persisted).toBe(c.expected);
    expect(dynamicReferenceTokens(persisted).length).toBeGreaterThan(0);
  });
});
