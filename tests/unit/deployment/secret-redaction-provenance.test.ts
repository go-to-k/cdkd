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
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

// The reference the SOURCE bag holds at the leaf under test.
const EXPR = '{{resolve:secretsmanager:app/db:SecretString:password}}';

// ...and the resolved PLAINTEXT of that reference, which is itself a complete
// `{{resolve:...}}` string (issue #1917). Nobody stores a secret of this shape
// on purpose; the point is that it satisfies `isSingleDynamicReferenceToken`
// exactly like an already-redacted leaf, so the guard that keeps such a leaf
// verbatim used to keep the PLAINTEXT and run no redaction on it at all.
const TOKEN_SHAPED_PLAINTEXT = '{{resolve:secretsmanager:decoy/other:SecretString:key}}';

// The `cdkd scrub` hazard the guard exists for, which has nothing to do with
// values: state holds the version stage that is DEPLOYED, the template holds
// the one the user just edited in and has not deployed yet.
const STATE_EXPR_PREV = '{{resolve:secretsmanager:app/db:SecretString:password:AWSPREVIOUS}}';
const TEMPLATE_EXPR_CURR = '{{resolve:secretsmanager:app/db:SecretString:password:AWSCURRENT}}';

function envBag(value: unknown): Record<string, unknown> {
  return { Environment: { Variables: { PW: value } } };
}

function envLeaf(bag: unknown): unknown {
  const env = (bag as Record<string, unknown>)['Environment'] as Record<string, unknown>;
  return (env['Variables'] as Record<string, unknown>)['PW'];
}

/**
 * Issue #1917 — a secret whose plaintext IS a `{{resolve:...}}` string.
 *
 * One case per WRITE SITE, because the whole defect is that a naive fix passes
 * the wrong half: testing `secrets.has(bag)` before the early return closes the
 * disclosure at most sites and re-opens the #1910 scrub convergence at the
 * rest. The discriminator is whether the SOURCE describes the same GENERATION
 * as the bag, so the matrix has to be per-site to be worth anything.
 *
 * Note what these cases assert on a refusal: not "the leaf is returned
 * untouched" but "the leaf goes to the VALUE SCAN". That is what lets the
 * refusal be set for every template source without giving up the disclosure
 * fix — a plaintext this pass resolved is a key of `secrets` and is still
 * rewritten, while a previous generation's expression is not a key and
 * survives.
 */
describe('secret-redaction - source generation and the token-shaped plaintext (issue #1917)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  // The generation verdicts, asserted as data as well as behavior. Only a
  // source that is THIS record's own persisted bag can certify the generation,
  // so every TEMPLATE-sourced constant must be false — including
  // `TEMPLATE_DERIVED_RULES`, whose name suggests otherwise and whose earlier
  // `true` was the reachable defect the review found.
  it('grants the same-generation claim only to STATE-sourced constants', () => {
    expect(TEMPLATE_DERIVED_RULES.sourceIsSameGeneration).toBe(false);
    expect(TEMPLATE_SOURCED_RULES.sourceIsSameGeneration).toBe(false);
    expect(STATE_SOURCED_CROSS_GENERATION_RULES.sourceIsSameGeneration).toBe(false);
    expect(STATE_DERIVED_RULES.sourceIsSameGeneration).toBe(true);
    expect(STATE_SOURCED_READBACK_RULES.sourceIsSameGeneration).toBe(true);
  });

  // The two STATE-sourced constants differ on exactly this flag and agree on
  // the other two, so nothing else in the suite would notice them being
  // swapped. `cdkd scrub` needs the cross-generation one; the #1900 observed
  // walk needs the other.
  it('keeps the two STATE-sourced constants distinguishable', () => {
    expect(STATE_SOURCED_CROSS_GENERATION_RULES.trustAnyExpression).toBe(
      STATE_SOURCED_READBACK_RULES.trustAnyExpression
    );
    expect(STATE_SOURCED_CROSS_GENERATION_RULES.descendArrays).toBe(
      STATE_SOURCED_READBACK_RULES.descendArrays
    );
    expect(STATE_SOURCED_CROSS_GENERATION_RULES.sourceIsSameGeneration).not.toBe(
      STATE_SOURCED_READBACK_RULES.sourceIsSameGeneration
    );
  });

  // SITE 1: the deploy engine's state-persist choke point (and the journal's
  // `properties` / `attemptedProperties`, the no-change re-check and
  // `redactOutputs`, which take the same rules). The bag it walks was USUALLY
  // produced by resolving the template — see the case after this one for when
  // it was not.
  it('deploy persist: redacts the token-shaped plaintext onto the template expression', () => {
    const secrets: RecordedSecretValues = new Map([[TOKEN_SHAPED_PLAINTEXT, EXPR]]);

    const persisted = redactSecretsForState(
      envBag(TOKEN_SHAPED_PLAINTEXT),
      secrets,
      envBag(EXPR)
    );

    expect(envLeaf(persisted)).toBe(EXPR);
    expect(JSON.stringify(persisted)).not.toContain(TOKEN_SHAPED_PLAINTEXT);
  });

  // SITE 1b — the case that moved this whole rule off the CALLER axis.
  //
  // `redactStateForPersist` walks EVERY record in the state map, while
  // `perResourceTemplateProps` is populated right after resolution and BEFORE
  // the provider call. So a resource that merely ENTERED the create/update arm
  // hands today's template to a record that is still the PREVIOUS generation —
  // reachable through an intermediate `saveStateAfterResource`, through the
  // pre/post-rollback saves, and through Ctrl-C.
  //
  // The consequence is worse than a disclosure. A failed rotation that AWS
  // rolled back to `:AWSPREVIOUS` would be persisted as `:AWSCURRENT`, so the
  // next deploy diffs the template against a state that already agrees, finds
  // nothing to do, and the rotation is silently never applied. Drift cannot see
  // it either, because the observed baseline is rewritten in the same walk.
  it('deploy persist: does NOT rewrite a PREVIOUS-generation record onto today template', () => {
    // Secrets recorded for the resource this pass DID resolve. The carried
    // record's own expression is not a plaintext, so it is not a key here —
    // which is exactly why the value-scan fallback leaves it alone.
    const secrets: RecordedSecretValues = new Map([['some-resolved-plaintext', TEMPLATE_EXPR_CURR]]);

    const persisted = redactSecretsForState(
      envBag(STATE_EXPR_PREV),
      secrets,
      envBag(TEMPLATE_EXPR_CURR)
    );

    expect(envLeaf(persisted)).toBe(STATE_EXPR_PREV);
  });

  // SITE 2: `cdkd import`. Same rules as the deploy engine, but its source
  // leaf is the raw TEMPLATE intrinsic, which for the dominant CDK shape is an
  // `Fn::Join` OBJECT rather than a string — so this exercises the skeleton
  // arm the guard used to short-circuit, not a second copy of caller 1.
  it('cdkd import: positions the token-shaped plaintext through the intrinsic skeleton', () => {
    const joined = '{{resolve:secretsmanager:app/db-123456789012:SecretString:password}}';
    const secrets: RecordedSecretValues = new Map([[TOKEN_SHAPED_PLAINTEXT, joined]]);

    const persisted = redactSecretsForState(
      envBag(TOKEN_SHAPED_PLAINTEXT),
      secrets,
      envBag({
        'Fn::Join': [
          '',
          ['{{resolve:secretsmanager:app/db-', { Ref: 'AWS::AccountId' }, ':SecretString:password}}'],
        ],
      })
    );

    expect(envLeaf(persisted)).toBe(joined);
    expect(JSON.stringify(persisted)).not.toContain(TOKEN_SHAPED_PLAINTEXT);
  });

  // SITE 3: the rollback executor's replay writer. Bag = the provider's
  // `effectiveProperties`, produced by resolving the JOURNALED record, so the
  // source is a persisted bag and both relaxations apply.
  it('rollback replay: redacts the token-shaped plaintext onto the journaled expression', () => {
    // A SecureString ssm reference: its spelling proves nothing, so this leaf
    // is persisted only because the source is a STATE bag (trustAnyExpression).
    const secureExpr = '{{resolve:ssm:/prod/db/password}}';
    const secrets: RecordedSecretValues = new Map([[TOKEN_SHAPED_PLAINTEXT, secureExpr]]);

    const persisted = redactSecretsForState(
      envBag(TOKEN_SHAPED_PLAINTEXT),
      secrets,
      envBag(secureExpr),
      STATE_DERIVED_RULES
    );

    expect(envLeaf(persisted)).toBe(secureExpr);
    expect(JSON.stringify(persisted)).not.toContain(TOKEN_SHAPED_PLAINTEXT);
  });

  // SITE 4a: the observed-readback walk with NO template source — the #1900
  // UNCHANGED-resource shape, where the secrets map is EMPTY and the record's
  // own UNTOUCHED `properties` are the only source, hence the one place the
  // same-generation claim genuinely holds. AWS echoed the plaintext back, and
  // with an empty map the value-scan fallback could not close this one.
  it('observed readback (#1900, no secrets map): redacts onto the record own expression', () => {
    const scrubbed = scrubResourceRecord(
      {
        properties: envBag(EXPR),
        observedProperties: envBag(TOKEN_SHAPED_PLAINTEXT),
      },
      new Map()
    );

    expect(envLeaf(scrubbed.observedProperties)).toBe(EXPR);
    expect(JSON.stringify(scrubbed)).not.toContain(TOKEN_SHAPED_PLAINTEXT);
  });

  // SITE 4b: the same walk with a TEMPLATE source (the deploy engine supplies
  // one for a resource resolved this deploy), which drops both the blanket
  // trust and the generation claim.
  it('observed readback (template source): redacts onto the template expression', () => {
    const secrets: RecordedSecretValues = new Map([[TOKEN_SHAPED_PLAINTEXT, EXPR]]);

    const scrubbed = scrubResourceRecord(
      {
        properties: envBag(TOKEN_SHAPED_PLAINTEXT),
        observedProperties: envBag(TOKEN_SHAPED_PLAINTEXT),
      },
      secrets,
      envBag(EXPR)
    );

    expect(envLeaf(scrubbed.properties)).toBe(EXPR);
    expect(envLeaf(scrubbed.observedProperties)).toBe(EXPR);
    expect(JSON.stringify(scrubbed)).not.toContain(TOKEN_SHAPED_PLAINTEXT);
  });

  // SITE 5: `cdkd scrub`'s `properties` walk. This is the half a
  // `secrets.has(bag)` fix breaks. The bag is PERSISTED STATE and the source is
  // TODAY's template, so the two are different GENERATIONS of the same leaf and
  // a difference between them is the normal case rather than a leak.
  it('cdkd scrub: keeps a state expression that the template has since edited', () => {
    const secrets: RecordedSecretValues = new Map([['some-other-plaintext', TEMPLATE_EXPR_CURR]]);

    const positioned = redactSecretsForState(
      envBag(STATE_EXPR_PREV),
      secrets,
      envBag(TEMPLATE_EXPR_CURR),
      TEMPLATE_SOURCED_RULES
    );

    // Rewriting this to the template's expression would report recordsChanged
    // for a record holding no plaintext at all, and would then make the next
    // deploy compare expression-vs-expression, see NO_CHANGE, and never push
    // the edited reference to AWS.
    expect(envLeaf(positioned)).toBe(STATE_EXPR_PREV);
  });

  // ...and refusing the source does NOT cost the disclosure fix even here,
  // because the refusal falls back to the value scan rather than returning the
  // leaf. `cdkd scrub` re-resolves today's template, so a legacy token-shaped
  // plaintext IS a key of its map and is rewritten in the same pass.
  it('cdkd scrub: still cleans a legacy token-shaped plaintext, in the same pass', () => {
    const secrets: RecordedSecretValues = new Map([[TOKEN_SHAPED_PLAINTEXT, EXPR]]);

    const positioned = redactSecretsForState(
      envBag(TOKEN_SHAPED_PLAINTEXT),
      secrets,
      envBag(EXPR),
      TEMPLATE_SOURCED_RULES
    );

    expect(envLeaf(positioned)).toBe(EXPR);
    expect(JSON.stringify(positioned)).not.toContain(TOKEN_SHAPED_PLAINTEXT);
  });

  // SITE 6: `cdkd scrub`'s OBSERVED walk, which looks like SITE 4a and is not.
  // Scrub repositions `properties` onto today's template first, so the
  // "record's own properties" the observed walk falls back to have already
  // moved a generation — and an observed leaf holding its own expression must
  // not be rewritten onto one the stack may never have deployed, because
  // `cdkd drift --revert` pushes that baseline back to AWS.
  it('cdkd scrub observed walk: keeps a baseline expression the template has edited', () => {
    const scrubbed = scrubResourceRecord(
      {
        // Already repositioned onto TODAY's template by scrub, one step earlier.
        properties: envBag(TEMPLATE_EXPR_CURR),
        observedProperties: envBag(STATE_EXPR_PREV),
      },
      new Map(),
      undefined,
      STATE_SOURCED_CROSS_GENERATION_RULES
    );

    expect(envLeaf(scrubbed.observedProperties)).toBe(STATE_EXPR_PREV);
  });

  // The half of SITE 6 that must keep working: a legacy PLAINTEXT observed leaf
  // is still cleaned, which is what the retained `trustAnyExpression` buys and
  // the reason this is not simply `TEMPLATE_SOURCED_RULES`.
  it('cdkd scrub observed walk: still cleans a legacy plaintext baseline', () => {
    const scrubbed = scrubResourceRecord(
      {
        properties: envBag(TEMPLATE_EXPR_CURR),
        observedProperties: envBag('a-plain-resolved-secret'),
      },
      new Map(),
      undefined,
      STATE_SOURCED_CROSS_GENERATION_RULES
    );

    expect(envLeaf(scrubbed.observedProperties)).toBe(TEMPLATE_EXPR_CURR);
  });

  // BLOCKER from the round-2 review: the refusal must be a WHOLE-VALUE
  // redaction, not the full value scan. The scan's other arm rewrites a secret
  // found as a SUBSTRING, and this leaf is a complete `{{resolve:...}}` token,
  // so a short secret VALUE occurring inside the token's own text gets spliced
  // INTO the reference. `cdkd scrub` over already-clean state is the worst
  // case: full map, bag of persisted expressions by construction.
  it('does NOT splice a recorded secret VALUE into a leaf that is already an expression', () => {
    // An ssm SecureString whose decrypted value is an ordinary word that also
    // occurs inside an unrelated reference's text.
    const secrets: RecordedSecretValues = new Map([['prod', '{{resolve:ssm:/app/env}}']]);
    const stateLeaf = '{{resolve:secretsmanager:prod/db:SecretString:password}}';

    const positioned = redactSecretsForState(
      envBag(stateLeaf),
      secrets,
      envBag(TEMPLATE_EXPR_CURR),
      TEMPLATE_SOURCED_RULES
    );

    expect(envLeaf(positioned)).toBe(stateLeaf);
  });

  // The same hazard on the SOURCELESS walk, which the journal's `previousState`
  // and every `attributes` bag take. Not reachable through the path pass at
  // all, so the rule is spelled out in both places.
  it('does NOT splice a recorded secret VALUE into an expression on the value-scan walk', () => {
    const secrets: RecordedSecretValues = new Map([['prod', '{{resolve:ssm:/app/env}}']]);
    const stateLeaf = '{{resolve:secretsmanager:prod/db:SecretString:password}}';

    expect(envLeaf(redactSecretsForState(envBag(stateLeaf), secrets))).toBe(stateLeaf);
  });

  // ...and the half that must survive that bound: a token-shaped leaf which IS
  // a recorded plaintext is still rewritten. Without this the fix above would
  // read as "never touch a token-shaped leaf", which re-opens #1917.
  it('still redacts a token-shaped leaf that is a WHOLE recorded plaintext', () => {
    const secrets: RecordedSecretValues = new Map([[TOKEN_SHAPED_PLAINTEXT, EXPR]]);

    expect(envLeaf(redactSecretsForState(envBag(TOKEN_SHAPED_PLAINTEXT), secrets))).toBe(EXPR);
  });

  // `redactSecretsForState`'s DEFAULT rules argument, which every deploy-side
  // writer relies on by omitting it. Flipping the default to a
  // `descendArrays: false` constant is invisible to every other case here,
  // because they all pass their rules explicitly. A keyless list with a
  // colliding pair is what separates them: positional descent keeps each leaf
  // on its own expression, and the value scan collapses both onto the survivor
  // (the #1904 defect).
  it('defaults to TEMPLATE_DERIVED_RULES, so a keyless list still descends', () => {
    const EXPR_A = '{{resolve:secretsmanager:app/a:SecretString:pw}}';
    const EXPR_B = '{{resolve:secretsmanager:app/b:SecretString:pw}}';
    const SHARED = 'one-value-two-references';
    const secrets: RecordedSecretValues = new Map([[SHARED, EXPR_B]]);

    const persisted = redactSecretsForState({ Command: [SHARED, SHARED] }, secrets, {
      Command: [EXPR_A, EXPR_B],
    });

    expect((persisted as Record<string, unknown>)['Command']).toEqual([EXPR_A, EXPR_B]);
  });

  // `STATE_SOURCED_CROSS_GENERATION_RULES.trustAnyExpression` on its own terms.
  // The scrub-observed cases elsewhere use a `secretsmanager` expression, which
  // `isKnownSecretExpression` accepts by SPELLING — so they pass with the flag
  // off. An unrecorded `ssm` reference is the discriminator: nothing but the
  // blanket trust can persist it, and that trust is what cleans a legacy
  // baseline whose expression the template no longer carries.
  it('trusts an unrecorded ssm expression from a STATE source on the scrub observed walk', () => {
    const unrecordedSsm = '{{resolve:ssm:/legacy/db/password}}';

    const scrubbed = scrubResourceRecord(
      {
        properties: envBag(unrecordedSsm),
        observedProperties: envBag('a-plain-resolved-secret'),
      },
      new Map(),
      undefined,
      STATE_SOURCED_CROSS_GENERATION_RULES
    );

    expect(envLeaf(scrubbed.observedProperties)).toBe(unrecordedSsm);
  });

  // The direction that would be a fresh #1901 regression if the guard removal
  // were read as "always take the source": a PUBLIC ssm parameter is config
  // that must stay RESOLVED in state, and a template source is not trusted.
  it('does NOT persist a public ssm expression from a template source', () => {
    const publicExpr = '{{resolve:ssm:/app/public-host}}';
    const secrets: RecordedSecretValues = new Map([[TOKEN_SHAPED_PLAINTEXT, EXPR]]);

    const persisted = redactSecretsForState(
      envBag('public-host-value'),
      secrets,
      envBag(publicExpr)
    );

    expect(envLeaf(persisted)).toBe('public-host-value');
  });
});
