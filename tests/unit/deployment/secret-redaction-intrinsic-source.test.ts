import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  redactSecretsForState,
  recordSecretExpression,
  clearRecordedSecretExpressions,
  TEMPLATE_SOURCED_READBACK_RULES,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

vi.mock('../../../src/utils/logger.js', () => {
  const noop = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => noop,
  };
  return { getLogger: () => noop };
});

const mockSecretsManagerSend = vi.fn();
const mockSSMSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '111122223333' }) },
    ec2: { send: vi.fn().mockResolvedValue({ AvailabilityZones: [] }) },
    secretsManager: { send: mockSecretsManagerSend },
    ssm: { send: mockSSMSend },
  }),
}));

// The pair the real-AWS `secrets-dynamic-ref` fixture deploys: ONE secret, read
// twice — once bare and once pinned to the `AWSCURRENT` stage. Before the
// staging labels diverge both reads return the SAME plaintext, which is exactly
// what makes the value-keyed map collapse them.
const SECRET_NAME = 'cdkd-test-dynref-secret-111122223333';
const EXPR_PLAIN = `{{resolve:secretsmanager:${SECRET_NAME}:SecretString:password}}`;
const EXPR_STAGED = `{{resolve:secretsmanager:${SECRET_NAME}:SecretString:password:AWSCURRENT}}`;
const SHARED = 'sh4red-pl4intext-p4ssw0rd';

/**
 * What CDK emits for `secret.secretValueFromJson('password')` on an
 * env-agnostic stack: the secret's ARN / name carries a `Ref`, so the whole
 * dynamic reference is an `Fn::Join` and the source leaf is an intrinsic
 * OBJECT rather than a `{{resolve:...}}` STRING. This is the DOMINANT CDK
 * shape, which is what made issue #1916 a real bound rather than an edge case.
 */
function joinSource(tail: string): Record<string, unknown> {
  return {
    'Fn::Join': [
      '',
      ['{{resolve:secretsmanager:cdkd-test-dynref-secret-', { Ref: 'AWS::AccountId' }, tail],
    ],
  };
}

const SOURCE_PLAIN = joinSource(':SecretString:password}}');
const SOURCE_STAGED = joinSource(':SecretString:password:AWSCURRENT}}');

describe('secret-redaction - intrinsic (Fn::Join / Fn::Sub) source leaf (issue #1916)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  // The starting point, pinned so the fix below is measured against something
  // real. Position cannot answer here (no source STRING to copy) and the value
  // map has already collapsed the pair, so BOTH leaves take the survivor's
  // expression — the unstaged leaf ends up holding the staged spelling.
  it('collapses onto the sibling expression when nothing recorded the candidates', () => {
    const map: RecordedSecretValues = new Map();
    map.set(SHARED, EXPR_PLAIN);
    map.set(SHARED, EXPR_STAGED);
    expect(map.size).toBe(1);

    const redacted = redactSecretsForState(
      { Variables: { SECRET_PASSWORD: SHARED, SECRET_PASSWORD_STAGED: SHARED } },
      map,
      { Variables: { SECRET_PASSWORD: SOURCE_PLAIN, SECRET_PASSWORD_STAGED: SOURCE_STAGED } }
    ) as { Variables: Record<string, string> };

    expect(JSON.stringify(redacted)).not.toContain(SHARED);
    expect(redacted.Variables['SECRET_PASSWORD']).toBe(EXPR_STAGED);
  });

  it('keeps each leaf on ITS OWN expression once every secret expression is recorded', () => {
    recordSecretExpression(EXPR_PLAIN);
    recordSecretExpression(EXPR_STAGED);

    const map: RecordedSecretValues = new Map();
    map.set(SHARED, EXPR_PLAIN);
    map.set(SHARED, EXPR_STAGED);

    const redacted = redactSecretsForState(
      { Variables: { SECRET_PASSWORD: SHARED, SECRET_PASSWORD_STAGED: SHARED } },
      map,
      { Variables: { SECRET_PASSWORD: SOURCE_PLAIN, SECRET_PASSWORD_STAGED: SOURCE_STAGED } }
    ) as { Variables: Record<string, string> };

    expect(redacted.Variables['SECRET_PASSWORD']).toBe(EXPR_PLAIN);
    expect(redacted.Variables['SECRET_PASSWORD_STAGED']).toBe(EXPR_STAGED);
    expect(JSON.stringify(redacted)).not.toContain(SHARED);
  });

  it('positions an Fn::Sub source the same way', () => {
    recordSecretExpression(EXPR_PLAIN);
    recordSecretExpression(EXPR_STAGED);

    const subSource = (tail: string) => ({
      'Fn::Sub': `{{resolve:secretsmanager:cdkd-test-dynref-secret-\${AWS::AccountId}${tail}`,
    });

    const redacted = redactSecretsForState(
      { A: SHARED, B: SHARED },
      new Map([[SHARED, EXPR_STAGED]]),
      {
        A: subSource(':SecretString:password}}'),
        B: subSource(':SecretString:password:AWSCURRENT}}'),
      }
    ) as Record<string, string>;

    expect(redacted['A']).toBe(EXPR_PLAIN);
    expect(redacted['B']).toBe(EXPR_STAGED);
  });

  // `${!Foo}` is CloudFormation's escape for a LITERAL `${Foo}`, so it is known
  // text and must be matched as such. Wildcarding it would make the skeleton
  // match BOTH candidates and the pass would refuse (condition 2) — a silent
  // downgrade to the collapse, which is why this direction needs its own case.
  it('treats an Fn::Sub ${!Literal} escape as literal text, not a substitution', () => {
    const ESCAPED = '{{resolve:secretsmanager:tenant-${Stage}/db:SecretString:password}}';
    const OTHER = '{{resolve:secretsmanager:tenant-prod/db:SecretString:password}}';
    recordSecretExpression(ESCAPED);
    recordSecretExpression(OTHER);

    const redacted = redactSecretsForState(
      { P: SHARED },
      new Map([[SHARED, OTHER]]),
      { P: { 'Fn::Sub': '{{resolve:secretsmanager:tenant-${!Stage}/db:SecretString:password}}' } }
    ) as Record<string, string>;

    expect(redacted['P']).toBe(ESCAPED);
  });

  // Condition 2. When the intrinsic's literal parts cannot separate the
  // candidates, guessing would be the collapse this fix exists to remove, one
  // step over — so the pass refuses and the value scan answers as it does today.
  //
  // The SURVIVOR is deliberately a THIRD expression the skeleton does NOT
  // match, and that is what gives this case discriminating power: with the
  // survivor among the matches, "refuse and fall back" and "take the first
  // match" produce the SAME string, and a first-cut of this test passed with
  // the exactly-one rule mutated away. It also passed for a second wrong
  // reason — a skeleton ending in a wildcard cannot match a candidate's `}}`
  // terminator at all, so ZERO candidates matched and ambiguity was never
  // reached. The `Ref` sits in the MIDDLE here so both really do match.
  it('refuses when the skeleton matches MORE THAN ONE candidate', () => {
    const SURVIVOR = '{{resolve:secretsmanager:unrelated-secret:SecretString:password}}';
    recordSecretExpression(EXPR_PLAIN);
    recordSecretExpression(EXPR_STAGED);

    // `...password${Ref}}}` matches BOTH the bare and the `:AWSCURRENT` form.
    const ambiguous = {
      'Fn::Join': [
        '',
        [
          '{{resolve:secretsmanager:cdkd-test-dynref-secret-',
          { Ref: 'AWS::AccountId' },
          ':SecretString:password',
          { Ref: 'Stage' },
          '}}',
        ],
      ],
    };

    const redacted = redactSecretsForState(
      { P: SHARED },
      new Map([[SHARED, SURVIVOR]]),
      { P: ambiguous }
    ) as Record<string, string>;

    // Falls back to the value scan: the survivor, i.e. today's behavior.
    expect(redacted['P']).toBe(SURVIVOR);
  });

  it('refuses when the skeleton matches NO candidate', () => {
    recordSecretExpression(EXPR_PLAIN);

    const unrelated = {
      'Fn::Join': ['', ['{{resolve:secretsmanager:some-other-secret-', { Ref: 'X' }, ':SecretString:key}}']],
    };

    const redacted = redactSecretsForState(
      { P: SHARED },
      new Map([[SHARED, EXPR_PLAIN]]),
      { P: unrelated }
    ) as Record<string, string>;

    expect(redacted['P']).toBe(EXPR_PLAIN);
  });

  // Condition 1, driven through the input that actually reaches it: the
  // skeleton matches EXACTLY ONE candidate, but the bag leaf is not that
  // secret's plaintext at all — a readback AWS masked, or a bag/source
  // misalignment. Persisting the expression there would overwrite a value the
  // pass has no evidence about.
  //
  // Two measured notes on why the setup looks the way it does. The EMBEDDED
  // case below cannot fence this rule: its skeleton carries the surrounding
  // text, so no bare `{{resolve:...}}` candidate matches it and the pass
  // refuses one step later regardless. And the matched candidate must be a
  // collapsed LOSER (absent from the map's values), or condition 3 fires first
  // and the two rules become indistinguishable — a first cut using the
  // SURVIVOR passed with this rule mutated away.
  it('refuses when the bag leaf is not the matched secret plaintext', () => {
    recordSecretExpression(EXPR_PLAIN);
    recordSecretExpression(EXPR_STAGED);

    const redacted = redactSecretsForState(
      { SECRET_PASSWORD: 'masked-by-aws' },
      new Map([[SHARED, EXPR_STAGED]]),
      { SECRET_PASSWORD: SOURCE_PLAIN },
      TEMPLATE_SOURCED_READBACK_RULES
    ) as Record<string, string>;

    expect(redacted['SECRET_PASSWORD']).toBe('masked-by-aws');
  });

  // A leaf that merely EMBEDS a secret is not the whole-token shape the
  // skeleton describes, so it must keep going to the value scan, which rewrites
  // just the substring. Persisting the whole expression would DESTROY the
  // surrounding text.
  it('leaves an EMBEDDED secret to the value scan rather than replacing the whole leaf', () => {
    recordSecretExpression(EXPR_PLAIN);

    const embedded = {
      'Fn::Join': [
        '',
        ['postgres://admin:', '{{resolve:secretsmanager:cdkd-test-dynref-secret-', { Ref: 'A' }, ':SecretString:password}}', '@db:5432'],
      ],
    };

    const redacted = redactSecretsForState(
      { Url: `postgres://admin:${SHARED}@db:5432` },
      new Map([[SHARED, EXPR_PLAIN]]),
      { Url: embedded }
    ) as Record<string, string>;

    expect(redacted['Url']).toBe(`postgres://admin:${EXPR_PLAIN}@db:5432`);
  });

  // Condition 3. A candidate the pass itself recorded against a DIFFERENT
  // plaintext is demonstrably not this leaf's expression, so a shape-plausible
  // match is refused — the fence against a bag/source misalignment.
  it('refuses a candidate the pass recorded against another plaintext', () => {
    const OTHER_VALUE = 'a-completely-different-secret';
    recordSecretExpression(EXPR_PLAIN);

    const redacted = redactSecretsForState(
      { P: SHARED },
      // EXPR_PLAIN is on record as resolving to OTHER_VALUE, and SHARED has its
      // own surviving expression, so the skeleton's match is provably wrong.
      new Map([
        [OTHER_VALUE, EXPR_PLAIN],
        [SHARED, EXPR_STAGED],
      ]),
      { P: SOURCE_PLAIN }
    ) as Record<string, string>;

    expect(redacted['P']).toBe(EXPR_STAGED);
  });

  // The #1901 direction that would be a real regression: a PUBLIC ssm reference
  // must stay RESOLVED in state, or the diff compares a resolved desired side
  // against a stored expression forever.
  //
  // The skeleton pass cannot reach it because a public expression is never
  // RECORDED, so it is never a candidate — which is the invariant this case
  // pins, from the outside: an intrinsic source describing a public reference,
  // with a recorded SECRET whose shape it does not match, must leave the leaf
  // alone. A widening of the candidate list to "any expression the source
  // mentions" would fail here.
  it('never persists a public ssm expression through the skeleton path', () => {
    const PUBLIC_HOST = 'db.example.com';
    recordSecretExpression(EXPR_PLAIN);

    const redacted = redactSecretsForState(
      { Host: PUBLIC_HOST },
      new Map([[SHARED, EXPR_PLAIN]]),
      { Host: { 'Fn::Join': ['', ['{{resolve:ssm:/app/', { Ref: 'Env' }, '/host}}']] } }
    ) as Record<string, string>;

    expect(redacted['Host']).toBe(PUBLIC_HOST);
  });

  // The `observedProperties` caller: bag is an AWS readback, source is the
  // TEMPLATE. Arrays are not descended there, but a KEY-aligned leaf is, so the
  // skeleton pass must reach it — otherwise an echoed secret is persisted under
  // its sibling's expression exactly as in the `properties` case.
  it('positions an AWS readback against a TEMPLATE intrinsic source', () => {
    recordSecretExpression(EXPR_PLAIN);
    recordSecretExpression(EXPR_STAGED);

    const redacted = redactSecretsForState(
      { SECRET_PASSWORD: SHARED },
      new Map([[SHARED, EXPR_STAGED]]),
      { SECRET_PASSWORD: SOURCE_PLAIN },
      TEMPLATE_SOURCED_READBACK_RULES
    ) as Record<string, string>;

    expect(redacted['SECRET_PASSWORD']).toBe(EXPR_PLAIN);
  });

  it('ignores an object source that is not a single-key Fn::Join / Fn::Sub', () => {
    recordSecretExpression(EXPR_PLAIN);

    const redacted = redactSecretsForState(
      { P: SHARED },
      new Map([[SHARED, EXPR_STAGED]]),
      // A nested bag, not an intrinsic — descending is the object walk's job and
      // a string bag against it must simply fall through.
      { P: { Nested: EXPR_PLAIN } }
    ) as Record<string, string>;

    expect(redacted['P']).toBe(EXPR_STAGED);
  });
});

describe('IntrinsicFunctionResolver - records every secret expression (issue #1916)', () => {
  let resolver: IntrinsicFunctionResolver;

  const template: CloudFormationTemplate = { Resources: {} };

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
    clearRecordedSecretExpressions();
    mockSecretsManagerSend.mockReset();
    mockSSMSend.mockReset();
  });

  afterEach(() => {
    resetAccountInfoCache();
    clearRecordedSecretExpressions();
  });

  // The end-to-end fence: the resolver resolves BOTH Fn::Join-wrapped reads of
  // one secret, and the redaction that follows must keep each leaf on its own
  // expression. This is the unit-test twin of what the `secrets-dynamic-ref`
  // integ asserts against real AWS.
  it('lets a collapsed secretsmanager pair behind an Fn::Join be separated again', async () => {
    mockSecretsManagerSend.mockResolvedValue({
      SecretString: JSON.stringify({ password: SHARED }),
    });

    const recordedSecretValues: RecordedSecretValues = new Map();
    const context: ResolverContext = { template, resources: {}, recordedSecretValues };

    const source = {
      Variables: { SECRET_PASSWORD: SOURCE_PLAIN, SECRET_PASSWORD_STAGED: SOURCE_STAGED },
    };
    const resolved = (await resolver.resolve(source, context)) as {
      Variables: Record<string, string>;
    };

    // Both reads returned the SAME plaintext, so the value-keyed map collapsed.
    expect(resolved.Variables['SECRET_PASSWORD']).toBe(SHARED);
    expect(resolved.Variables['SECRET_PASSWORD_STAGED']).toBe(SHARED);
    expect(recordedSecretValues.size).toBe(1);

    const redacted = redactSecretsForState(resolved, recordedSecretValues, source) as {
      Variables: Record<string, string>;
    };

    expect(redacted.Variables['SECRET_PASSWORD']).toBe(EXPR_PLAIN);
    expect(redacted.Variables['SECRET_PASSWORD_STAGED']).toBe(EXPR_STAGED);
    expect(JSON.stringify(redacted)).not.toContain(SHARED);
  });

  // The ssm half of the store's contract is UNCHANGED: an unclassifiable `Type`
  // is secret for THIS resolution but deliberately NOT pinned, so the next pass
  // re-asks AWS instead of inheriting a transient answer (issue #1901). The
  // #1916 recording must not have widened that.
  it('does NOT pin an ssm reference whose Type came back unclassifiable', async () => {
    mockSSMSend.mockResolvedValue({ Parameter: { Value: SHARED, Type: undefined } });

    const recordedSecretValues: RecordedSecretValues = new Map();
    const expression = '{{resolve:ssm:/app/unknown-type}}';
    await resolver.resolveDynamicReferences(expression, {
      template,
      resources: {},
      recordedSecretValues,
    });

    // Treated as secret for this pass...
    expect(recordedSecretValues.get(SHARED)).toBe(expression);
    // ...but the process-wide store stays empty, so a later pass re-asks.
    const redacted = redactSecretsForState({ P: 'plain-config' }, new Map(), {
      P: expression,
    }) as Record<string, string>;
    expect(redacted['P']).toBe('plain-config');
  });
});
