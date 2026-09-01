import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import {
  redactSecretsForState,
  scrubResourceRecord,
  recordSecretExpression,
  forgetSecretExpression,
  isProvenPublicExpression,
  clearRecordedSecretExpressions,
  STATE_SOURCED_READBACK_RULES,
  STATE_SOURCED_CROSS_GENERATION_RULES,
  TEMPLATE_SOURCED_RULES,
} from '../../../src/deployment/secret-redaction.js';

const EXPR = '{{resolve:secretsmanager:app/db:SecretString:password}}';
const EXPR_B = '{{resolve:secretsmanager:app/other:SecretString:password}}';
const PLAINTEXT = 'the-real-resolved-secret-value';
const SECURE_SSM = '{{resolve:ssm:/app/secure-token}}';
const PUBLIC_SSM = '{{resolve:ssm:/app/public-host}}';

const readback = (bag: unknown, source: unknown): Record<string, unknown> =>
  redactSecretsForState(
    bag,
    new Map<string, string>(),
    source,
    STATE_SOURCED_READBACK_RULES
  ) as Record<string, unknown>;

/**
 * DERIVED NEEDLES — the mechanism that closes issue
 * [#2012](https://github.com/go-to-k/cdkd/issues/2012)'s last two rows.
 *
 * On the readback paths the secrets map is EMPTY by construction, so the value
 * scan has no needles and POSITION is the only mechanism. Two shapes have no
 * position to argue from — an UNPAIRED array element beside a paired one, and
 * an observed KEY the source does not carry — and both are exactly where
 * `redactByPath` ALREADY delegates to the value scan.
 *
 * The needle comes from the record itself. Certifying a position IS the
 * assertion that AWS's value there is that expression's resolved form; read
 * back out, that assertion is a plaintext, which is what the scan was missing.
 * Nothing is resolved, nothing is fetched, and no permission is added — issue
 * #2012's own proposed direction (resolve the record's expressions) would have
 * made `cdkd state refresh-observed` and every deploy's observed capture FETCH
 * secrets.
 *
 * The cases below are written in BOTH polarities on purpose. A needle is a
 * REWRITE with a blast radius — every leaf in the record equal to the plaintext
 * takes the expression — so the refusals (what must NOT become a needle) are
 * the load-bearing half, and each is written so that deleting its guard makes
 * it fail.
 */
describe('secret-redaction - derived needles (issue #2012)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  it('learns from a certified KEY and reaches a key the source does not carry', () => {
    // The row-6 shape at its simplest. `Password` is certified by position, so
    // `MasterPassword` — which has no source leaf at all — is reached by value.
    const out = readback({ Password: PLAINTEXT, MasterPassword: PLAINTEXT }, { Password: EXPR });

    expect(out).toEqual({ Password: EXPR, MasterPassword: EXPR });
  });

  it('learns from a certified ELEMENT and reaches an UNPAIRED sibling', () => {
    // The row-5 shape. `DB` pairs by `Name`; `DB_COPY` has no counterpart in the
    // record, so the walk returns it untouched and only the needle reaches it.
    const out = readback(
      {
        Environment: [
          { Name: 'DB', Value: PLAINTEXT },
          { Name: 'DB_COPY', Value: PLAINTEXT },
        ],
      },
      { Environment: [{ Name: 'DB', Value: EXPR }] }
    );

    expect(out['Environment']).toEqual([
      { Name: 'DB', Value: EXPR },
      { Name: 'DB_COPY', Value: EXPR },
    ]);
  });

  it('reaches a plaintext EMBEDDED in an unpaired leaf, not only a whole-value one', () => {
    // The needle goes through `redactSecretsForState`'s ordinary substring arm,
    // so an AWS-added field that merely QUOTES the secret is covered too. This
    // is the shape a failed delete's error text has (issue #2179's sink).
    const out = readback(
      { Password: PLAINTEXT, StatusReason: `value ${PLAINTEXT} was rejected` },
      { Password: EXPR }
    );

    expect(out['StatusReason']).toBe(`value ${EXPR} was rejected`);
  });

  it('learns from a MIXED leaf, which is the DOMINANT CDK shape', () => {
    // `Fn::Join` around `secretValueFromJson` renders a leaf that CONTAINS the
    // reference rather than being it. The source's literal prefix and suffix
    // bracket the resolved value exactly, so the plaintext between them is
    // extracted rather than guessed.
    const out = readback(
      { Url: `postgres://u:${PLAINTEXT}@h`, AwsAdded: PLAINTEXT },
      { Url: `postgres://u:${EXPR}@h` }
    );

    expect(out['Url']).toBe(`postgres://u:${EXPR}@h`);
    expect(out['AwsAdded']).toBe(EXPR);
  });

  it('refuses to extract from a mixed leaf whose surrounding text AWS NORMALISED', () => {
    // The extraction is anchored at BOTH ends. If the frame does not match, the
    // slice offsets are meaningless, so nothing is learned rather than a needle
    // cut at the wrong place. The leaf itself is still refused by position.
    const out = readback(
      { Url: `POSTGRES://U:${PLAINTEXT}@H`, AwsAdded: PLAINTEXT },
      { Url: `postgres://u:${EXPR}@h` }
    );

    expect(out['Url']).toBe(`postgres://u:${EXPR}@h`);
    expect(out['AwsAdded']).toBe(PLAINTEXT);
  });

  it('refuses to extract from a leaf carrying TWO references, CONSERVATIVELY', () => {
    // With two spans the text between them cannot be split between the two
    // resolved values without guessing, and a guess here is a needle.
    //
    // THE FIXTURE HAD TO BE CHOSEN. The obvious one — two references that BOTH
    // resolved — is an equivalent mutant: relaxing the span count makes the
    // extraction take span 0 and treat everything after it as a literal SUFFIX,
    // which then contains a whole `{{resolve:...}}` token that a resolved
    // readback cannot end with, so the frame check refuses it anyway. Measured:
    // the mutation came back GREEN across all five suites.
    //
    // What separates the two is a SECOND reference that survives LITERALLY in
    // the readback, which is what cdkd's unsupported-service arm produces —
    // `ssm-secure:` is warned about and left in place, so AWS really does hold
    // the token text. Then the frame matches and the relaxed form WOULD extract
    // a needle. This case pins that cdkd does not.
    //
    // The refusal is CONSERVATIVE rather than a correctness guard, and saying
    // so is the point: the extraction here would in fact be right. What it buys
    // is that "exactly one span" is the only shape the extraction reasons
    // about, so widening it stays a deliberate change with this case to flip.
    const unresolvable = '{{resolve:ssm-secure:/app/token}}';
    const out = readback(
      { Url: `a${PLAINTEXT}b${unresolvable}c`, AwsAdded: PLAINTEXT },
      { Url: `a${EXPR}b${unresolvable}c` }
    );

    expect(out['AwsAdded']).toBe(PLAINTEXT);
  });

  it('slices correctly when the secret itself repeats the leaf SUFFIX', () => {
    // Anchoring at the ends rather than searching: an `indexOf` scan for `@h`
    // would cut `abc@h` short and learn `abc`, which is a needle nobody asked
    // for and a wrong redaction wherever `abc` occurs.
    const secret = 'abc@h';
    const out = readback(
      { Url: `postgres://u:${secret}@h`, AwsAdded: secret },
      { Url: `postgres://u:${EXPR}@h` }
    );

    expect(out['AwsAdded']).toBe(EXPR);
  });

  // ------------------------------------------------ WHAT MUST NOT BE LEARNED --

  it('does NOT learn from a LOOK-ALIKE spelling that names no secret service', () => {
    // `isSingleDynamicReferenceToken` accepts any `{{resolve:<anything>}}`, and
    // the resolver's unsupported-service arm WARNS and returns the literal — so
    // AWS holds the token text and the value beside it is ordinary data.
    // `cdkd drift` pins the same rule for its own registration path
    // (`--revert does not register a live value for a look-alike spelling`);
    // this is the readback twin, and without the service check the two commands
    // disagree about the same expression.
    const odd = '{{resolve:notaservice:/x}}';
    const out = readback({ DB: 'ordinary-live-value', LEVEL: 'ordinary-live-value' }, { DB: odd });

    expect(out['LEVEL']).toBe('ordinary-live-value');
  });

  it('does NOT learn from a PROVEN-PUBLIC ssm parameter', () => {
    // The false redaction the resolver's verdict store warns about: a public
    // parameter holding `prod-region-1` would turn `my-prod-region-1-bucket`
    // into `my-{{resolve:ssm:/app/public-host}}-bucket`, a change the desired
    // side never mirrors, i.e. a perpetual spurious UPDATE.
    forgetSecretExpression(PUBLIC_SSM);
    expect(isProvenPublicExpression(PUBLIC_SSM)).toBe(true);

    const out = readback(
      { Host: 'public-host-value', Sibling: 'a-public-host-value-suffix' },
      { Host: PUBLIC_SSM }
    );

    expect(out['Sibling']).toBe('a-public-host-value-suffix');
  });

  it('DOES learn from a plain ssm token with no verdict either way', () => {
    // The #1901 premise the whole-token arm already acts on: a public `String`
    // parameter is persisted RESOLVED, so a `{{resolve:ssm:` token SURVIVING in
    // a persisted state bag is a `SecureString` by construction. Requiring a
    // recorded verdict would make the needle unavailable on `cdkd state
    // refresh-observed`, whose process resolves nothing — i.e. it would fail
    // exactly where issue #2012 is reported.
    const out = readback({ Token: 'decrypted-token-value', Copy: 'decrypted-token-value' }, {
      Token: SECURE_SSM,
    });

    expect(out['Copy']).toBe(SECURE_SSM);
  });

  it('does NOT learn a sub-floor plaintext, which would rewrite unrelated leaves', () => {
    // `redactSecretsForState`'s whole-value arm matches at ANY length, so a
    // two-character needle would rewrite every leaf equal to it. The collector
    // applies `MIN_NEEDLE_LENGTH` itself rather than relying on
    // `buildNeedleRegex`, which only filters the SUBSTRING arm.
    const out = readback({ Flag: 'ok', Level: 'ok' }, { Flag: EXPR });

    expect(out['Flag']).toBe(EXPR);
    expect(out['Level']).toBe('ok');
  });

  it('POISONS a plaintext learned twice under DIFFERENT expressions', () => {
    // The issue #1910 collapse arriving through this door. Two references
    // momentarily sharing one resolved value (an `:AWSCURRENT` /
    // `:AWSPREVIOUS` pair mid-rotation) would otherwise give every other
    // occurrence whichever expression was learned last — and `--revert` /
    // `resolveReplayProps` re-resolve a persisted expression against the live
    // resource, so that is a wrong-secret WRITE.
    //
    // Both certified positions still take their OWN source leaf, which is
    // position doing its job; only the positionless `Copy` is left alone.
    const out = readback(
      { A: PLAINTEXT, B: PLAINTEXT, Copy: PLAINTEXT },
      { A: EXPR, B: EXPR_B }
    );

    expect(out['A']).toBe(EXPR);
    expect(out['B']).toBe(EXPR_B);
    expect(out['Copy']).toBe(PLAINTEXT);
  });

  it('does NOT learn from an already-redacted record (bag leaf IS a token)', () => {
    // A second `refresh-observed` over clean state: bag and source are both the
    // expression, and learning `EXPR -> EXPR` would put a `{{resolve:...}}`
    // string in the needle set for the value scan to keep stepping over.
    const out = readback({ Password: EXPR, Other: EXPR }, { Password: EXPR });

    expect(out).toEqual({ Password: EXPR, Other: EXPR });
  });

  it('does NOT rewrite one persisted EXPRESSION into another (the #1917 class)', () => {
    // The shape that makes the guard above load-bearing rather than tidy. The
    // record's `properties` have moved on to a new reference — a rotation to a
    // different version stage — while the observed bag still holds the OLD
    // expression. Without the token guard the pass would learn
    // `EXPR_B -> EXPR`, and every positionless leaf still carrying `EXPR_B`
    // would be rewritten to a reference the stack has not deployed. `cdkd drift
    // --revert` re-resolves the baseline, so that is a WRITE of the wrong
    // secret version to the live resource.
    //
    // The certified position itself still takes its own source leaf: that is
    // position doing its job, and `sourceIsSameGeneration` is what licenses it.
    const out = readback({ Password: EXPR_B, Other: EXPR_B }, { Password: EXPR });

    expect(out['Password']).toBe(EXPR);
    expect(out['Other']).toBe(EXPR_B);
  });

  // ----------------------------------------------------------------- SCOPE --

  it('does NOT derive needles when a REAL secrets map is present', () => {
    // The bound exists for `crossStackAssociations` /
    // `nestedStackParameterExpressions`, which are `WeakMap`s keyed by the
    // RecordedSecretValues INSTANCE: handing the pipeline a different Map
    // object would silently lose every association that pass recorded. With a
    // real map the value scan already has the pass's own needles, and this case
    // pins that the derived pass does not displace it.
    const secrets = new Map<string, string>([['an-unrelated-secret', EXPR_B]]);
    const out = redactSecretsForState(
      { Password: PLAINTEXT, MasterPassword: PLAINTEXT },
      secrets,
      { Password: EXPR },
      STATE_SOURCED_READBACK_RULES
    ) as Record<string, unknown>;

    expect(out['Password']).toBe(EXPR);
    expect(out['MasterPassword']).toBe(PLAINTEXT);
  });

  it('does NOT derive needles on `cdkd scrub`s CROSS-GENERATION observed walk', () => {
    // The source there has already been repositioned onto TODAY's template, so
    // a value learned from it describes a different generation of the resource
    // (issue #1917). The gate is `isReadbackProjectedFromState`, shared with
    // the refusal pass, so the two can never select different callers.
    const out = redactSecretsForState(
      { Password: PLAINTEXT, MasterPassword: PLAINTEXT },
      new Map<string, string>(),
      { Password: EXPR },
      STATE_SOURCED_CROSS_GENERATION_RULES
    ) as Record<string, unknown>;

    expect(out['MasterPassword']).toBe(PLAINTEXT);
  });

  it('does NOT derive needles from a TEMPLATE source', () => {
    // A template carries PUBLIC expressions too, so its leaves cannot be
    // trusted wholesale — the reason `trustAnyExpression` is false there.
    const out = redactSecretsForState(
      { Password: PLAINTEXT, MasterPassword: PLAINTEXT },
      new Map<string, string>(),
      { Password: EXPR },
      TEMPLATE_SOURCED_RULES
    ) as Record<string, unknown>;

    expect(out['MasterPassword']).toBe(PLAINTEXT);
  });

  it('applies through scrubResourceRecord, the call the commands actually make', () => {
    // `cdkd state refresh-observed` and the deploy persist choke point reach
    // this through `scrubResourceRecord` with no template bag, which DERIVES
    // the readback rules rather than being handed them.
    const scrubbed = scrubResourceRecord(
      {
        properties: { Env: { Password: EXPR } },
        observedProperties: { Env: { Password: PLAINTEXT, Mirror: PLAINTEXT } },
      },
      new Map<string, string>()
    );

    expect(scrubbed.observedProperties!['Env']).toEqual({ Password: EXPR, Mirror: EXPR });
    expect(JSON.stringify(scrubbed)).not.toContain(PLAINTEXT);
  });

  it('does NOT let a DERIVED map be read as evidence that a pass resolved this bag', () => {
    // THE ONE INTERACTION THAT COULD TURN THIS FIX INTO A DISCLOSURE.
    // `mixedLeafMayCarryPublicReference` splits on whether a secrets map
    // exists: a NON-EMPTY map means "a resolution pass ran, so absence from the
    // verdict store is evidence of a PUBLIC parameter — keep the resolved
    // value". A derived map satisfies `size > 0` while proving nothing of the
    // kind, so handing it to the refusal pass would read every
    // `{{resolve:ssm:` mixed leaf as public and persist the decrypted
    // `SecureString` — the exact regression the `secrets-dynamic-ref` integ
    // caught before issue #1926 shipped, arriving through a new door.
    //
    // THE FIXTURE HAD TO BE CHOSEN, NOT JUST WRITTEN, and the first attempt was
    // VACUOUS — measured, not suspected. With a mixed leaf whose frame matches,
    // `redactByPath` value-scans it with the DERIVED needle and produces the
    // source form anyway, so the refusal pass's answer is unobservable and the
    // mutation came back GREEN across all five suites.
    //
    // What discriminates is a mixed leaf the needle CANNOT reach: AWS
    // normalised the surrounding text, so nothing is learned from it and the
    // value scan has nothing to match. The derived map is still non-empty (the
    // `Password` pair), which is the whole condition under test.
    //
    //  - correct: the refusal pass sees the ORIGINAL empty map, so absence
    //    carries no signal, the leaf is refused and the source expression wins.
    //  - mutated: it sees a non-empty map, reads absence from the verdict store
    //    as "public", keeps the bag — and the decrypted `SecureString` is
    //    persisted.
    const normalisedFrame = 'PRE-decrypted-secure-value-POST';
    const out = readback(
      { Password: PLAINTEXT, Url: normalisedFrame },
      { Password: EXPR, Url: `pre-${SECURE_SSM}-post` }
    );

    expect(out['Url']).toBe(`pre-${SECURE_SSM}-post`);
    expect(JSON.stringify(out)).not.toContain('decrypted-secure-value');
  });
});

/**
 * THE PROVEN-PUBLIC VERDICT STORE — issue
 * [#2036](https://github.com/go-to-k/cdkd/issues/2036).
 *
 * `mixedLeafMayCarryPublicReference` used to read ABSENCE from the secret
 * verdict store as "public", which on the empty-map readback paths (where
 * nothing is ever resolved, so nothing can ever be recorded) persisted the
 * DECRYPTED `SecureString`. Issue #1926 fixed that by refusing to read absence
 * at all there, at the price of OVER-redacting a genuinely public parameter.
 *
 * The closure is evidence rather than inference: the resolver's own
 * `pinSecretVerdict` retraction already carries a DEFINITIVE public verdict
 * (`GetParameter` returned a non-`SecureString` `Type`), and it now records
 * that fact positively instead of only deleting a memo. No lookup is added.
 */
describe('secret-redaction - proven-public verdicts (issue #2036)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  it('KEEPS a PROVEN-PUBLIC ssm mixed leaf resolved on the EMPTY-map path', () => {
    // The over-redaction issue #2036 records, closed. Before this, the leaf
    // took the source expression, so `observedProperties` held an expression
    // where AWS holds a literal — a baseline that stops matching the moment the
    // parameter becomes unreadable, and a `--revert` that writes the token.
    forgetSecretExpression(PUBLIC_SSM);

    const out = readback({ Url: 'pre-public-host-post' }, { Url: `pre-${PUBLIC_SSM}-post` });

    expect(out['Url']).toBe('pre-public-host-post');
  });

  it('still REFUSES an ssm mixed leaf with NO verdict on the EMPTY-map path', () => {
    // Absence is still not evidence. This is the population issue #1926's fix
    // exists for and it is unchanged: `cdkd state refresh-observed` against a
    // stack this process never deployed records nothing at all.
    const out = readback({ Url: 'pre-decrypted-post' }, { Url: `pre-${SECURE_SSM}-post` });

    expect(out['Url']).toBe(`pre-${SECURE_SSM}-post`);
  });

  it('still REFUSES a leaf whose ssm reference was RECORDED as secret', () => {
    recordSecretExpression(SECURE_SSM);

    const out = readback({ Url: 'pre-decrypted-post' }, { Url: `pre-${SECURE_SSM}-post` });

    expect(out['Url']).toBe(`pre-${SECURE_SSM}-post`);
  });

  it('POISONS a spelling recorded PUBLIC and then SECRET, in that order', () => {
    // The store is keyed by the bare expression STRING, which carries no region
    // and no account, so one `cdkd deploy --all` can legitimately see the same
    // spelling as a `String` in one region and a `SecureString` in another. A
    // stale SECRET verdict can only over-redact; a stale PUBLIC one would keep
    // the plaintext, so a disagreement must never resolve to "public".
    forgetSecretExpression(SECURE_SSM);
    recordSecretExpression(SECURE_SSM);
    expect(isProvenPublicExpression(SECURE_SSM)).toBe(false);

    const out = readback({ Url: 'pre-decrypted-post' }, { Url: `pre-${SECURE_SSM}-post` });

    expect(out['Url']).toBe(`pre-${SECURE_SSM}-post`);
  });

  it('POISONS a spelling recorded SECRET and then PUBLIC, in that order too', () => {
    // The other order. Both must poison, or the outcome depends on which region
    // a `--stack-concurrency 4` run happened to resolve first.
    recordSecretExpression(SECURE_SSM);
    forgetSecretExpression(SECURE_SSM);
    expect(isProvenPublicExpression(SECURE_SSM)).toBe(false);

    const out = readback({ Url: 'pre-decrypted-post' }, { Url: `pre-${SECURE_SSM}-post` });

    expect(out['Url']).toBe(`pre-${SECURE_SSM}-post`);
  });

  it('stays PUBLIC when the same public verdict is recorded twice', () => {
    // A repeated resolution of the same public parameter is the NORM, not a
    // disagreement — poisoning on it would make the fix inert after the second
    // resource in a stack.
    forgetSecretExpression(PUBLIC_SSM);
    forgetSecretExpression(PUBLIC_SSM);

    expect(isProvenPublicExpression(PUBLIC_SSM)).toBe(true);
  });

  it('requires EVERY reference in the leaf to be proven public, not just one', () => {
    // Keeping the bag here keeps it UNSCANNED: with an empty map `redactByPath`
    // value-scanned nothing, so one proven-public token must not license
    // keeping its neighbour's plaintext. The populated-map arm can afford
    // `some` because the scan already ran there.
    forgetSecretExpression(PUBLIC_SSM);

    const out = readback(
      { Url: `host=public-host-value;pw=${PLAINTEXT}` },
      { Url: `host=${PUBLIC_SSM};pw=${EXPR}` }
    );

    expect(out['Url']).toBe(`host=${PUBLIC_SSM};pw=${EXPR}`);
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
  });

  it('refuses a leaf with a STRAY opener and no complete token', () => {
    // `isDynamicReferenceString` is a SUBSTRING test for `{{resolve:`, so this
    // leaf reaches the arm with ZERO complete tokens. An `every` over an empty
    // list is vacuously true, which would keep the readback value on the
    // strength of no evidence at all.
    const stray = 'prefix {{resolve: unterminated';
    const out = readback({ Url: 'whatever-aws-returned' }, { Url: stray });

    expect(out['Url']).toBe(stray);
  });

  it('clears BOTH stores on reset', () => {
    // The reset is paired with the resolver's cache reset. Leaving the PUBLIC
    // half behind would let the next phase inherit a stale verdict in the one
    // direction that can un-redact.
    forgetSecretExpression(PUBLIC_SSM);
    clearRecordedSecretExpressions();

    expect(isProvenPublicExpression(PUBLIC_SSM)).toBe(false);
  });
});
