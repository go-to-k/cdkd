import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import {
  redactSecretsForState,
  scrubResourceRecord,
  clearRecordedSecretExpressions,
  TEMPLATE_DERIVED_RULES,
  TEMPLATE_SOURCED_RULES,
  STATE_SOURCED_READBACK_RULES,
  STATE_SOURCED_CROSS_GENERATION_RULES,
  STATE_DERIVED_RULES,
  type PathSourceRules,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

// The reference a PREVIOUS deploy already persisted into a MIXED leaf: the
// dominant CDK shape, an `Fn::Join` around a secret, whose ordinary
// substring-arm output is the expression sitting inside surrounding text.
const SM_TOKEN = '{{resolve:secretsmanager:appdb/creds:SecretString:password}}';

// ...and the leaf holding it. Note `appdb` occurs TWICE: once as ordinary text
// and once inside the token's OWN text, which is the whole defect.
const MIXED_LEAF = `jdbc://appdb:${SM_TOKEN}@host`;

// The secret recorded by a LATER deploy: an ssm SecureString whose resolved
// plaintext is `appdb` (5 chars, above MIN_NEEDLE_LENGTH, so it is a needle).
const SSM_EXPR = '{{resolve:ssm:/app/dbname}}';
const SSM_PLAINTEXT = 'appdb';

// What the leaf must become: the OUTSIDE occurrence rewritten onto the ssm
// expression, the token byte-identical.
const MIXED_LEAF_REDACTED = `jdbc://${SSM_EXPR}:${SM_TOKEN}@host`;

// The wreckage the blanket `value.replace(regex, ...)` produced: the needle
// spliced INTO the reference. `resolveReplayProps` scans it with `([^}]+)`,
// which stops at the first `}`, so the rollback asks Secrets Manager for the
// secret id `{{resolve:ssm:/app/dbname`.
const MANGLED = `jdbc://${SSM_EXPR}:{{resolve:secretsmanager:${SSM_EXPR}/creds:SecretString:password}}@host`;

// A secret whose resolved PLAINTEXT is itself a complete `{{resolve:...}}`
// string (issue #1917), embedded in a larger leaf. This is the case the naive
// "mask only OUTSIDE the spans" fix breaks: the plaintext IS a span, so
// span-skipping alone would stop redacting it and trade a mangling bug for a
// disclosure.
const TOKEN_SHAPED_PLAINTEXT = '{{resolve:secretsmanager:decoy/other:SecretString:key}}';
const TOKEN_SHAPED_EXPR = '{{resolve:secretsmanager:app/db:SecretString:password}}';

// A recorded plaintext that STRADDLES a span boundary: it embeds a whole
// reference AND surrounding text. Nobody stores a secret of this shape on
// purpose -- it is the same premise as TOKEN_SHAPED_PLAINTEXT one step further:
// if a secret's resolved value can BE a reference, it can CONTAIN one.
const STRADDLING_PLAINTEXT = 'pw{{resolve:ssm:/a/b}}tail';
const STRADDLING_EXPR = '{{resolve:secretsmanager:S:SecretString:password}}';

// The same shape with the reference at the very start, so the match CONTAINS a
// span rather than crossing one boundary.
const CONTAINING_PLAINTEXT = '{{resolve:ssm:/a/b}}tail';

function ssmSecrets(): RecordedSecretValues {
  return new Map([[SSM_PLAINTEXT, SSM_EXPR]]);
}

/**
 * Issue [#1935](https://github.com/go-to-k/cdkd/issues/1935) — ONE rule over
 * the whole leaf: replace every recorded-plaintext match EXCEPT one that lies
 * STRICTLY INSIDE a complete `{{resolve:...}}` span.
 *
 * A match can sit in exactly four positions relative to the spans, and each is
 * a case below because each fails differently:
 *
 * | position                     | verdict  | what it protects                        |
 * | ---------------------------- | -------- | --------------------------------------- |
 * | strictly inside a span       | KEPT     | the #1935 splice                        |
 * | coextensive with a span      | REPLACED | the #1917 token-shaped plaintext        |
 * | containing / straddling one  | REPLACED | the straddle REGRESSION (see below)     |
 * | disjoint from every span     | REPLACED | the ordinary embedded secret            |
 *
 * The third row is here because an earlier revision of this fix got it wrong
 * in the disclosing direction. Expressed as TWO rules — replace a span that IS
 * a recorded plaintext, value-scan the text between spans — a straddling
 * plaintext belongs to neither half and was persisted IN THE CLEAR, where the
 * pre-fix code had redacted it. Measured on both sides with the same probe:
 * `origin/main` produced the expression, the two-rule form produced
 * `jdbc://user:pw{{resolve:ssm:/a/b}}tail@host`. So these cases are not
 * hypothetical coverage — they are the regression the security review caught.
 *
 * The fourth thing the single pass buys is needle PRECEDENCE: `buildNeedleRegex`
 * sorts alternatives longest-first, which only holds WITHIN one scan, so the
 * split form let a short needle in the tail beat a long straddling one and
 * wrote the wrong expression (the issue #1910 class, re-applied by the replay).
 *
 * This walk is the SHARED arm: every `PathSourceRules` constant reaches it
 * through `redactByPath`'s fallbacks and the journal's `previousState` /
 * `attributes` walks reach it with no source at all.
 */
describe('secret-redaction - one rule over the whole leaf, spans excepted (issue #1935)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  it('STRICTLY INSIDE: keeps a span whose text merely CONTAINS a needle', () => {
    const out = redactSecretsForState({ Url: MIXED_LEAF }, ssmSecrets()) as Record<string, unknown>;

    expect(out['Url']).toBe(MIXED_LEAF_REDACTED);
    expect(out['Url']).not.toBe(MANGLED);
    // The shape the rollback executor chokes on, asserted directly: no
    // `{{resolve:` may open inside THIS leaf's token. Not a global invariant of
    // the walk — an UNTERMINATED opener still admits one, pinned below as the
    // residual it is.
    expect(out['Url'] as string).not.toMatch(/\{\{resolve:[^}]*\{\{resolve:/);
  });

  it('STRICTLY INSIDE: a needle occurring ONLY inside a span leaves the leaf byte-identical', () => {
    // No outside occurrence at all, so the whole leaf must survive untouched —
    // the half of the defect a test that only checks the outside text would
    // miss, since the mangled output also "redacts" the prefix.
    const leaf = `dsn=${SM_TOKEN};timeout=30`;
    const out = redactSecretsForState({ Url: leaf }, ssmSecrets()) as Record<string, unknown>;

    expect(out['Url']).toBe(leaf);
  });

  it('DISJOINT: still redacts a needle outside every span', () => {
    const out = redactSecretsForState(
      { Url: `jdbc://appdb:pw@host` },
      ssmSecrets()
    ) as Record<string, unknown>;

    expect(out['Url']).toBe(`jdbc://${SSM_EXPR}:pw@host`);
  });

  it('MIXED POSITIONS: a needle inside AND outside a span redacts only the outside one', () => {
    const out = redactSecretsForState(
      { Url: `appdb-${SM_TOKEN}-appdb` },
      ssmSecrets()
    ) as Record<string, unknown>;

    expect(out['Url']).toBe(`${SSM_EXPR}-${SM_TOKEN}-${SSM_EXPR}`);
  });

  it('COEXTENSIVE: a token-shaped PLAINTEXT span is STILL redacted (issue #1917)', () => {
    // The case that makes "mask only outside the spans" wrong on its own. The
    // recorded plaintext IS a complete token, embedded in a larger leaf, so it
    // is a span — and it must be replaced by its expression, not preserved.
    const secrets: RecordedSecretValues = new Map([
      [TOKEN_SHAPED_PLAINTEXT, TOKEN_SHAPED_EXPR],
    ]);
    const out = redactSecretsForState(
      { Url: `dsn=${TOKEN_SHAPED_PLAINTEXT};timeout=30` },
      secrets
    ) as Record<string, unknown>;

    expect(out['Url']).toBe(`dsn=${TOKEN_SHAPED_EXPR};timeout=30`);
    expect(JSON.stringify(out)).not.toContain(TOKEN_SHAPED_PLAINTEXT);
  });

  it('COEXTENSIVE + INSIDE on one leaf: replaces the recorded span, keeps the other', () => {
    // Both rules firing on the SAME leaf, in the same direction they disagree
    // on: one span is a recorded plaintext (replace), the next is not (keep).
    // A collapse in either direction changes exactly one of these two halves.
    const secrets: RecordedSecretValues = new Map([
      [TOKEN_SHAPED_PLAINTEXT, TOKEN_SHAPED_EXPR],
    ]);
    const out = redactSecretsForState(
      { Url: `${TOKEN_SHAPED_PLAINTEXT}|${SM_TOKEN}` },
      secrets
    ) as Record<string, unknown>;

    expect(out['Url']).toBe(`${TOKEN_SHAPED_EXPR}|${SM_TOKEN}`);
  });

  it('leaves a WHOLE-token leaf verbatim, which is the degenerate case of the rule', () => {
    // The early-out this arm keeps for the re-scrub-of-clean-state path. An
    // EQUIVALENT mutant by construction — deleting the early-out must produce
    // the same answer through the span split (one span, not a recorded
    // plaintext, no outside text) — so this case cannot go red on its removal.
    // It is here to pin the ANSWER, so a future edit that makes the two paths
    // disagree is caught by whichever one it broke.
    const out = redactSecretsForState({ Url: SM_TOKEN }, ssmSecrets()) as Record<string, unknown>;

    expect(out['Url']).toBe(SM_TOKEN);
  });

  it('STRADDLING: a plaintext CROSSING a span boundary is redacted, not kept', () => {
    // THE REGRESSION CASE. The probe is the one used against both sides:
    // `origin/main` redacts this leaf, and the two-rule form did not. The match
    // is neither a whole span nor contained in the between-span text, so a rule
    // that splits the leaf drops it at both ends.
    const out = redactSecretsForState(
      { Url: `jdbc://user:${STRADDLING_PLAINTEXT}@host` },
      new Map([[STRADDLING_PLAINTEXT, STRADDLING_EXPR]])
    ) as Record<string, unknown>;

    expect(out['Url']).toBe(`jdbc://user:${STRADDLING_EXPR}@host`);
    // The assertion that matters most is the absence, not the shape: this leaf
    // reaches state.json, the journal, `observedProperties`, and `state.outputs`
    // (from which `reresolveCrossStackValue` re-applies it to a live AWS call).
    expect(JSON.stringify(out)).not.toContain(STRADDLING_PLAINTEXT);
  });

  it('CONTAINING: a plaintext that embeds a WHOLE span plus a tail is redacted', () => {
    // The other half of the same class: the match starts exactly where the span
    // does and runs past its end, so it is contained-BY nothing and contains a
    // span itself. Consuming it cannot splice, because the whole reference goes
    // with it.
    const out = redactSecretsForState(
      { Url: `x${CONTAINING_PLAINTEXT}y` },
      new Map([[CONTAINING_PLAINTEXT, STRADDLING_EXPR]])
    ) as Record<string, unknown>;

    expect(out['Url']).toBe(`x${STRADDLING_EXPR}y`);
  });

  it('PRECEDENCE: a long straddling needle beats a short one later in the leaf', () => {
    // `buildNeedleRegex` sorts alternatives longest-first, and that ordering
    // only holds within ONE scan. Splitting the leaf at the span boundaries let
    // `tail@ho` — which lies wholly in the tail — win, so the leaf took the
    // WRONG expression: the issue #1910 wrong-reference class, which the replay
    // re-resolves and applies to the live resource.
    const long = STRADDLING_PLAINTEXT;
    const short = 'tail@ho';
    const out = redactSecretsForState(
      { Url: `jdbc://user:${long}@host` },
      new Map([
        [long, '{{resolve:secretsmanager:LONG:SecretString:p}}'],
        [short, '{{resolve:secretsmanager:SHORT:SecretString:p}}'],
      ])
    ) as Record<string, unknown>;

    expect(out['Url']).toBe('jdbc://user:{{resolve:secretsmanager:LONG:SecretString:p}}@host');
  });

  it('RESIDUAL: an UNTERMINATED `{{resolve:` opener is not a span, so a needle after it is replaced', () => {
    // Pinned rather than described in prose, because a residual stated only in
    // a comment is a claim nothing checks. An opener with no `}}` is not a
    // reference by the resolver's own grammar, so it forms no span and the
    // needle behind it is redacted — producing a string the resolver's
    // `([^}]+)` reads as the secret id `{{resolve:ssm:/app/dbname`.
    //
    // Deliberate, and identical to the pre-fix behavior: treating a bare opener
    // as a span would leave PLAINTEXT behind two characters any template text
    // can contain, which is the trade this arm exists to refuse. A future fix
    // has to flip this assertion on purpose.
    const out = redactSecretsForState({ Url: 'foo{{resolve:appdb' }, ssmSecrets()) as Record<
      string,
      unknown
    >;

    expect(out['Url']).toBe(`foo{{resolve:${SSM_EXPR}`);
  });

  it('reaches the walk through `attributes`, which has no source at all', () => {
    // `scrubResourceRecord` value-scans `attributes` with no position source,
    // so this arm is the ONLY thing standing between an attribute leaf and the
    // splice. Named in the issue as one of the sourceless walks.
    const scrubbed = scrubResourceRecord(
      { properties: {}, attributes: { Endpoint: MIXED_LEAF } },
      ssmSecrets()
    );

    expect(scrubbed.attributes!['Endpoint']).toBe(MIXED_LEAF_REDACTED);
  });

  it('reaches the walk through a journal `previousState`-shaped record scrub', () => {
    // The journal snapshot is scrubbed against its own `properties`, so its
    // `observedProperties` leaf takes the readback constant and its unpaired
    // keys fall to this same walk.
    const scrubbed = scrubResourceRecord(
      {
        properties: { Url: MIXED_LEAF },
        observedProperties: { Extra: MIXED_LEAF },
      },
      ssmSecrets()
    );

    expect(scrubbed.properties['Url']).toBe(MIXED_LEAF_REDACTED);
    expect(scrubbed.observedProperties!['Extra']).toBe(MIXED_LEAF_REDACTED);
  });

  // What these rows pin, stated at the strength they actually have: no rules
  // constant BYPASSES the shared walk for a key the SOURCE LACKS. They do NOT
  // pin per-constant behavior — the `rules` argument is INERT on this path
  // (test review measured it: inverting all three flags of one constant left
  // every row green), so the five rows pass and fail together. That is worth
  // having and is not worth more than it is: a regression confined to ONE
  // constant's own path is not detectable here.
  const constants: ReadonlyArray<readonly [string, PathSourceRules]> = [
    ['TEMPLATE_DERIVED_RULES', TEMPLATE_DERIVED_RULES],
    ['TEMPLATE_SOURCED_RULES', TEMPLATE_SOURCED_RULES],
    ['STATE_SOURCED_READBACK_RULES', STATE_SOURCED_READBACK_RULES],
    ['STATE_SOURCED_CROSS_GENERATION_RULES', STATE_SOURCED_CROSS_GENERATION_RULES],
    ['STATE_DERIVED_RULES', STATE_DERIVED_RULES],
  ];

  // The module's own doc names FOUR fallbacks into this walk. The matrix above
  // covers the first; these cover the rest, so "every fallback inherits the
  // fix" is a measurement rather than a reading of the call graph.
  it('FALLBACK 2 (diverged shape): a scalar bag against an OBJECT source', () => {
    const out = redactSecretsForState(
      { Url: MIXED_LEAF },
      ssmSecrets(),
      { Url: { 'Fn::Join': ['', ['a', 'b']] } },
      TEMPLATE_DERIVED_RULES
    ) as Record<string, unknown>;

    expect(out['Url']).toBe(MIXED_LEAF_REDACTED);
  });

  it('FALLBACK 3 (unpaired array element): an element the source array cannot pair', () => {
    // Identity-keyed pairing (issue #1915) leaves an element with no partner to
    // the value scan. `descendArrays: false` keeps the positional arm from
    // rescuing it, which is the readback shape.
    const out = redactSecretsForState(
      { List: [{ Name: 'a', V: MIXED_LEAF }, { Name: 'unpaired', V: MIXED_LEAF }] },
      ssmSecrets(),
      { List: [{ Name: 'a', V: SM_TOKEN }] },
      TEMPLATE_SOURCED_RULES
    ) as Record<string, Array<Record<string, unknown>>>;

    expect(out['List']![1]!['V']).toBe(MIXED_LEAF_REDACTED);
  });

  it('FALLBACK 4 (public-reference leaf): a source token that is not a KNOWN secret', () => {
    // A public `{{resolve:ssm:...}}` source leaf keeps its RESOLVED value
    // (issue #1901) and is value-scanned instead — so the scan has to be the
    // fixed one here too.
    const out = redactSecretsForState(
      { Url: MIXED_LEAF },
      ssmSecrets(),
      { Url: '{{resolve:ssm:/public/param}}' },
      TEMPLATE_DERIVED_RULES
    ) as Record<string, unknown>;

    expect(out['Url']).toBe(MIXED_LEAF_REDACTED);
  });

  it.each(constants)('does not bypass the shared walk under %s', (_name, rules) => {
    const out = redactSecretsForState(
      { Url: MIXED_LEAF, Extra: MIXED_LEAF },
      ssmSecrets(),
      { Url: SM_TOKEN },
      rules
    ) as Record<string, unknown>;

    expect(out['Extra']).toBe(MIXED_LEAF_REDACTED);
    expect(out['Extra'] as string).not.toMatch(/\{\{resolve:[^}]*\{\{resolve:/);
  });
});
