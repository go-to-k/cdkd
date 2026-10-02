import { isRecordedSecretExpression } from './mask-only.js';

/**
 * A resolved secret value shorter than this is NOT used as a redaction needle:
 * a 1-2 character plaintext (e.g. a secret whose JSON key holds `"0"`) would
 * match incidental characters everywhere and mangle unrelated state. Such a
 * value is still masked at the exact leaf where it was the WHOLE value (handled
 * by the caller), but is not scanned for as a substring. Real secrets are far
 * longer than this, so the bound only excludes degenerate cases.
 *
 * EXPORTED because a caller assembling its own secrets bag may need the same
 * bound on the WHOLE-VALUE arm, which this module deliberately does not apply
 * (the no-source arm below matches a whole value at ANY length, which is right
 * for a POSITION-SCOPED bag). `cdkd scrub`'s cross-resource union has no
 * position source at all, so it filters itself here before scanning — see
 * `allRecordedSecrets` in `src/cli/commands/scrub.ts`. Read-only: no behavior
 * in this module changes with the export.
 */
export const MIN_NEEDLE_LENGTH = 4;

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a single alternation regex matching any recorded secret value, longest
 * first so an overlapping shorter secret cannot pre-empt a longer match. Returns
 * `undefined` when there is nothing worth scanning for.
 */
export function buildNeedleRegex(values: Iterable<string>): RegExp | undefined {
  const needles = Array.from(new Set(values))
    .filter((v) => v.length >= MIN_NEEDLE_LENGTH)
    .sort((a, b) => b.length - a.length);
  if (needles.length === 0) return undefined;
  return new RegExp(needles.map(escapeRegExp).join('|'), 'g');
}

/**
 * The three rules the path pass needs, which are ORTHOGONAL — the first two
 * were one parameter and the conflation was a real defect (found by review,
 * reproduced against the branch tip).
 *
 * They are decided by DIFFERENT bags:
 *
 * - `descendArrays` follows the BAG's provenance. Positional descent is sound
 *   only when the bag was PRODUCED BY resolving the source, so the two have
 *   identical structure. The persisted `properties` is
 *   `effectiveProperties ?? desiredProperties`, so a provider-NARROWED bag can
 *   be walked against the template; every `effectiveProperties` producer today
 *   preserves length and order on an equal-length array, and the length check
 *   below is what makes a producer that stops doing so fall to the value scan
 *   rather than mis-align. An AWS readback may be REORDERED — AWS does not
 *   preserve list order, which is the whole reason
 *   `src/analyzer/drift-normalize.ts` exists — and descending it BLINDLY by
 *   position would write an expression onto the WRONG element while leaving the
 *   real secret in plaintext. A readback array is not therefore beyond
 *   position: {@link identityKeyFor} pairs it by an identity FIELD, and
 *   {@link unkeyedArrayPairsByAnchors} (issue #2012) walks one positionally
 *   when the positions themselves corroborate the alignment. Both answer the
 *   ORDER objection on its own terms rather than waiving it — a reorder breaks
 *   an identity pairing's equality test and an anchor pairing's anchors alike —
 *   and both refuse where they cannot.
 * - `trustAnyExpression` follows the SOURCE's provenance. A persisted STATE bag
 *   holds no public expressions (a public ssm reference is stored RESOLVED), so
 *   any `{{resolve:...}}` in one is by construction a secret — which is what
 *   lets an UNCHANGED resource be redacted with no secrets map at all (issue
 *   #1900). One narrow exception exists and is worth knowing rather than
 *   asserting around: `cdkd import` warns and persists the RAW template
 *   intrinsic when it cannot resolve one, so a public expression CAN sit in a
 *   record's `properties`. Trusting it here only copies that same literal into
 *   `observedProperties`, which the record already carried, so this does not
 *   make it reach anything new. A TEMPLATE bag carries public and secret expressions alike, so only
 *   a KNOWN secret may be persisted from it, or a `String` / `StringList`
 *   parameter would be stored as its expression and the diff would compare a
 *   resolved desired side against it forever — the perpetual UPDATE issue #1901
 *   exists to prevent.
 *
 * - `sourceIsSameGeneration` answers whether the SOURCE describes the same
 *   generation of this resource that the BAG does (issue #1916 review ->
 *   issues #1917 / #1926 review). It exists for ONE shape: a bag leaf that is
 *   ALREADY a complete `{{resolve:...}}` token. Such a leaf is EITHER an
 *   expression a previous pass persisted, with no plaintext to redact, OR a
 *   secret whose resolved plaintext literally IS a `{{resolve:...}}` string
 *   (issue #1917) — and the leaf cannot tell you which. Neither can
 *   `secrets.has(bag)`: rewriting a leaf because it coincides with a recorded
 *   plaintext is the very move the retention exists to prevent.
 *
 *   Note what this rule does NOT say. It is not "which caller is this", and an
 *   earlier draft got that wrong in a way worth recording, because the wrong
 *   version reads perfectly plausible. Callers know what they INTEND their bag
 *   to be; they do not control what it IS. `DeployEngine.redactStateForPersist`
 *   walks EVERY record in the state map, while `perResourceTemplateProps` is
 *   populated right after resolution and BEFORE the provider call — so any
 *   resource that merely ENTERED the create/update arm supplies today's
 *   template as source while its record is still the PREVIOUS generation.
 *   Reachable through an intermediate `saveStateAfterResource`, through the
 *   pre/post-rollback saves, and through Ctrl-C. Keyed on the caller, that row
 *   said "this bag was resolved from this source" and rewrote a restored
 *   `:AWSPREVIOUS` reference to the template's `:AWSCURRENT` — so a rotation
 *   that FAILED and was rolled back would read as already applied, the next
 *   deploy would see NO_CHANGE, and drift could not see it either because the
 *   baseline was rewritten too. Only a source that is THIS record's own
 *   persisted bag is same-generation by construction; a TEMPLATE source never
 *   is, however the caller reached it.
 *
 *   The BAG's generation is a separate fact, and it lives on the object rather
 *   than in these rules for the same reason (issue #2516): the engine marks
 *   each bag it installed on a success path with {@link markSameGenerationBag},
 *   and {@link redactSecretsForState} reads the mark for the object it was
 *   handed. That is what lets `positionByEmbeddedSpan` write an embedded
 *   1-3 character secret as its token on this pass's own bag while every
 *   cross-generation walk — the same population listed above — keeps the value
 *   scan's answer. No rules constant claims it.
 *
 *   The refusal is a FALL-BACK, not a stop: a refused leaf takes a WHOLE-VALUE
 *   redaction rather than being returned untouched. That is what lets the rule
 *   be set conservatively without giving up issue #1917. On a bag the pass
 *   really did resolve, the token-shaped plaintext is a key of `secrets`, so it
 *   is rewritten onto an expression; a previous generation's expression is not
 *   a key (it is an expression, not a plaintext), so it survives untouched. One
 *   test, two right answers, and neither depends on the caller having
 *   classified itself correctly.
 *
 *   Whole-value and not the full value scan. The two now AGREE for this shape
 *   rather than differing, which is a change worth stating because the
 *   original reason for the distinction has been removed: the scan's SUBSTRING
 *   arm used to splice a short secret value found inside the token's own text
 *   into the reference, and since issue
 *   [#1935](https://github.com/go-to-k/cdkd/issues/1935) it KEEPS a match that
 *   lies strictly inside a complete `{{resolve:...}}` span — which is every
 *   match in a whole-token leaf except one covering the leaf entire, and that
 *   one is the whole-value arm's own case. The whole-value form is kept because
 *   it states what this arm means without depending on that rule holding.
 *
 *   And "onto its own expression" is the ordinary case, not a
 *   guarantee — `RecordedSecretValues` is keyed by plaintext, so if two
 *   references share one token-shaped resolved value the map has already
 *   collapsed and the refused leaf takes the SURVIVOR's expression. That is
 *   the #1910 wrong-reference class rather than a disclosure, it needs a secret
 *   whose value is a dynamic-reference string AND a colliding sibling, and it
 *   is stated here rather than papered over because the alternative reading —
 *   that the fallback always lands each leaf on its own expression — is what an
 *   earlier draft of this paragraph claimed.
 *
 * `observedProperties` is exactly the case that proves the first two are
 * separate: its bag is an AWS readback (so no array descent) while its source
 * may be the TEMPLATE (so no blanket trust). Answering both from one enum
 * leaked the template's public ssm expression into the drift baseline, which
 * `cdkd drift --revert` then pushes back to AWS as a literal.
 *
 * The generation table, one row per (WRITE SITE, source) pair, for the case
 * "the BAG leaf is a single complete `{{resolve:...}}` token". TAKE SOURCE
 * means the source leaf is persisted verbatim; VALUE SCAN means the source is
 * refused for this leaf and only a recorded PLAINTEXT match can rewrite it.
 *
 * ```text
 *   write site                                 source               rules constant                        verdict
 *   -----------------------------------------  -------------------  ------------------------------------  ----------
 *   deploy persist `properties`                current template     TEMPLATE_DERIVED_RULES                VALUE SCAN
 *   deploy journal props / attemptedProps      current template     TEMPLATE_DERIVED_RULES                VALUE SCAN
 *   deploy no-change re-check                  current template     TEMPLATE_DERIVED_RULES                VALUE SCAN
 *   deploy `redactOutputs` (7 sites)           template `Outputs`   TEMPLATE_SOURCED_RULES                VALUE SCAN
 *   `cdkd import` `properties`                 imported template    TEMPLATE_DERIVED_RULES                VALUE SCAN
 *   observed walk, template source             current template     TEMPLATE_SOURCED_RULES                VALUE SCAN
 *   `cdkd scrub` `properties`                  TODAY's template     TEMPLATE_SOURCED_RULES                VALUE SCAN
 *   `cdkd scrub` `outputs`                     TODAY's template     TEMPLATE_SOURCED_RULES                VALUE SCAN
 *   `cdkd scrub` observed walk                 REPOSITIONED props   STATE_SOURCED_CROSS_GENERATION_RULES  VALUE SCAN
 *   observed walk, own-record source           the record itself    STATE_SOURCED_BASELINE_RULES *        TAKE SOURCE
 *   `cdkd state refresh-observed`              the record itself    STATE_SOURCED_BASELINE_RULES          TAKE SOURCE
 *   `cdkd import` observed capture             the record itself    STATE_SOURCED_BASELINE_RULES          TAKE SOURCE
 *   deploy masked-baseline re-capture (x2)     the record itself    STATE_SOURCED_BASELINE_RULES          TAKE SOURCE
 *   `cdkd drift --accept` new baseline         the record itself    BASELINE / READBACK by destination *** TAKE SOURCE
 *   `cdkd drift --revert` narrowed delta       revert baseline      BASELINE / READBACK by destination *** TAKE SOURCE
 *   deploy journal `previousState`             the record itself    STATE_SOURCED_READBACK_RULES (passed) TAKE SOURCE
 *   rollback replay trailing record scrub      the record itself    STATE_SOURCED_READBACK_RULES **       TAKE SOURCE
 *   rollback replay `properties`               journaled record     STATE_DERIVED_RULES                   TAKE SOURCE
 * ```
 *
 * Three rows were added by the issue
 * [#2004](https://github.com/go-to-k/cdkd/issues/2004) audit, which walked the
 * table in BOTH directions — every row to a call site, and every call site
 * passing a position source back to a row. `cdkd state refresh-observed` was
 * the one that prompted it (it reached this module along no path at all until
 * issue #1926), and the two `cdkd drift` writers turned up the same way: they
 * are distinct WRITE SITES sharing a rules constant with the deploy-time
 * observed walk, and a table claiming one row per write site cannot fold them
 * into it. The reverse direction found no orphan rows.
 *
 * The two OUTPUTS rows now AGREE, and they got there one issue apart. `deploy
 * redactOutputs` moved to TEMPLATE_SOURCED for issue
 * [#1943](https://github.com/go-to-k/cdkd/issues/1943): its bag can be the
 * PREVIOUS deploy's `state.outputs` (the no-change path persists
 * `persistedOutputs` while `outputsTemplateSource` is today's template), so
 * `descendArrays` — the only flag the two constants differ on — is a claim that
 * site cannot make. `cdkd scrub`'s outputs call followed for issue
 * [#2099](https://github.com/go-to-k/cdkd/issues/2099), whose whole subject was
 * that this second row had been left on the default on a FALSE premise (that a
 * template Output `Value` cannot be an array, which CloudFormation requires but
 * cdkd does not enforce). They remain two rows rather than one because they are
 * two write sites, and the table claims one row per write site.
 *
 * The `verdict` column answers ONLY the "bag leaf is a single complete
 * `{{resolve:...}}` token" question the table poses. The
 * `STATE_SOURCED_*` readback constants additionally run
 * {@link refuseUncertifiedReadbackPositions} after the path pass, which is what
 * answers the shapes that question does not reach — a MIXED leaf, an array
 * that cannot pair, an unpaired element. See that function's own table.
 *
 * THE STARRED SPELLINGS are one derivation, split by TWO tests (issue
 * [#2852](https://github.com/go-to-k/cdkd/issues/2852), narrowed by issue
 * [#2906](https://github.com/go-to-k/cdkd/issues/2906)).
 * `scrubResourceRecord` redacts `observedProperties` specifically, so the
 * DESTINATION is settled there and the fail-closed refusal MAY apply — but it
 * applies only where BOTH hold: the secrets map is EMPTY, and the observed bag
 * carries {@link markSameGenerationBag}'s mark, i.e. THIS RUN produced it.
 * `**` is everything else — the populated map, where the value scan had needles
 * and masking a leaf it left alone would buy little; and the UNMARKED bag,
 * which is a previous generation's `observedProperties` being re-written
 * unchanged, where a mask destroys an intact persisted baseline and protects no
 * reader who is not already exposed. The second test is what stops a
 * FAILURE-PATH `redactStateForPersist` save — a resource whose resolve threw
 * before recording anything — from taking `*` over a bag it did not produce.
 *
 * `***` is the same destination question answered by the CALLER: the two
 * `cdkd drift` writers read the record's own `observedProperties` and pass
 * {@link STATE_SOURCED_BASELINE_RULES} when the bag lands there,
 * {@link STATE_SOURCED_READBACK_RULES} when it lands in `properties` (issue
 * [#2939](https://github.com/go-to-k/cdkd/issues/2939); the selector's
 * rationale sits on the BASELINE constant's doc below).
 *
 * WHICH ROW A CALL TAKES IS PER-CALL, not per-site, and two of the labels above
 * are therefore the COMMON case rather than the only one — a distinction a
 * review round had to measure, because the first version of this paragraph
 * asserted it the other way:
 *
 * - `redactRollbackRecord` is always `**` (`redactRollbackRecord` early-returns
 *   on an empty map, so it cannot reach the derivation with one).
 * - the deploy JOURNAL's `previousState` no longer consults the derivation at
 *   all: `DeployEngine.redactOperationsForJournal` passes
 *   `STATE_SOURCED_READBACK_RULES` explicitly (issue
 *   [#2886](https://github.com/go-to-k/cdkd/issues/2886)). An op whose
 *   resource resolved nothing this deploy — a DELETE, an UPDATE with no
 *   reference of its own — reaches that scrub with an EMPTY map, and under
 *   the derivation it took `*`: masks in a journal snapshot that
 *   `replayRollback` then restored into `state.json` as permanent phantom
 *   drift on a baseline that was intact before the deploy. The journal is a
 *   REPLAYED baseline — its bag already sits in `state.json` — so the
 *   readback answer is right for BOTH its map states.
 * - the `#1900` observed walk is `*`, and it is the ONLY drain that reaches the
 *   refusal: `kickOffObservedCapture` fires for freshly created / updated
 *   resources, which record `perResourceTemplateProps`, so `redactStateForPersist`
 *   passes a template `sourceProperties` and the row is TEMPLATE_SOURCED, whose
 *   `trustAnyExpression: false` makes {@link isReadbackProjectedFromState}
 *   false. An earlier revision here said "every `drainObservedCaptures`
 *   baseline", which is a strictly larger set than the one that arms. It stays
 *   `*` under #2906's second test because `drainObservedCaptures` MARKS every
 *   READBACK it installs, the auto-refresh's included. The one bag it installs
 *   unmarked is not a readback: see the masked-baseline row below.
 * - the masked-baseline re-capture (issue
 *   [#3595](https://github.com/go-to-k/cdkd/issues/3595),
 *   `masked-baseline-recapture.ts`) walks a fresh readback TWICE with
 *   `STATE_SOURCED_BASELINE_RULES` passed explicitly — once with an empty map,
 *   once with a map resolved from the record's own `properties` — and persists
 *   neither: it copies only whole references the record spells into the
 *   PREVIOUS baseline's masked positions. That bag is installed unmarked and
 *   reaches the persist choke point as `**`.
 * - `redactStateForPersist` ALSO reaches the derivation for a resource this
 *   deploy never resolved — every failure-path and intermediate save, and each
 *   `orphans` entry since (#2948) — with an empty map, no template bag,
 *   and the PRIOR generation's `observedProperties` still installed. That is
 *   `**`, by the mark's absence. Before #2906 it took `*` and masked a baseline
 *   `state.json` already held intact.
 *
 * `cdkd state refresh-observed` and `cdkd import`'s observed capture both pass
 * `STATE_SOURCED_BASELINE_RULES` themselves and need no derivation — import
 * moved onto it in issue
 * [#2885](https://github.com/go-to-k/cdkd/issues/2885), the residue #2852 left
 * behind. Both are baseline callers for the same reason: their one destination
 * is `observedProperties`. The two `cdkd drift` writers are NOT, and that is
 * the whole reason the flag is DECLARED rather than derived — `--accept` writes
 * its result into `properties` FOR A RECORD WITH NO `observedProperties` (it
 * writes the baseline for one that has it), and a mask in `properties` is a
 * regression.
 *
 * The two rows reach this through
 * `scrubResourceRecord` with NO `sourceProperties`:
 * `DeployEngine.redactOperationsForJournal` scrubs a
 * `previousState` snapshot against its own untouched `properties` (passing
 * the readback constant as `observedRules`, per the bullet above), and
 * `redactRollbackRecord` finishes by scrubbing the record it just positioned.
 * Both are same-generation for the same reason the `#1900` row is — the source
 * is that record's own persisted bag — and they are listed because this table
 * claims one row per write site, and an incomplete "one row per" claim is worse
 * than no claim: it is the artifact a future edit gets checked against.
 *
 * The two TAKE SOURCE rows are the only pairs where the source is the SAME
 * record's own persisted bag: the `#1900` observed walk projects a readback
 * from the very `properties` it sits beside, and the replay resolved its bag
 * FROM the journaled record. Both are also the rows where TAKE SOURCE is the
 * only thing that can work — the `#1900` path has an EMPTY secrets map by
 * construction, so a value scan there has no needles at all.
 *
 * `cdkd scrub`'s observed walk looks like the `#1900` row and is not: scrub
 * repositions `properties` onto TODAY's template FIRST, so by the time the
 * observed bag is walked its "own-record" source has already moved a
 * generation. It keeps `trustAnyExpression` (that source still holds no public
 * expressions, which is what lets scrub clean legacy plaintext) but not the
 * generation claim.
 */
export interface PathSourceRules {
  descendArrays: boolean;
  trustAnyExpression: boolean;
  sourceIsSameGeneration: boolean;
  /**
   * May this pass write {@link SECRET_MASK} at a position it cannot certify
   * (issue [#2852](https://github.com/go-to-k/cdkd/issues/2852))?
   *
   * A DESTINATION flag, and it exists because destination is the one thing this
   * module cannot infer. The refusal is only ever right for a bag that is going
   * to be persisted as a drift BASELINE. `cdkd drift --accept` walks a bag with
   * these same three other flags and then writes it to `observedProperties` OR,
   * for a record that has none, to `properties`
   * (`src/cli/commands/drift.ts`) — and a mask in `properties` is a
   * REGRESSION, not a safety win: `cdkd export` blocks the record and the
   * rollback replay refuses the operation, over a template value that was never
   * unknown.
   *
   * Two earlier attempts to infer this from what the pass could see both failed
   * against a measurement, which is why it is declared rather than derived: the
   * RULES alone select `drift.ts` too, and `secrets.size === 0` does not
   * separate them either — `runAccept` reaches an empty map through its
   * cross-region refusal (`secrets.clear()`) and through a resource whose only
   * `{{resolve:`-shaped leaf names a service cdkd resolves for nobody.
   *
   * Optional, and ABSENT means "no". A caller that has not thought about where
   * its bag lands must not get the refusal by default.
   */
  failClosedOnUncertifiedPositions?: boolean;
}

/**
 * The bag was produced by resolving the source: same shape, template source.
 *
 * `sourceIsSameGeneration` is FALSE despite the name, and that is the whole
 * lesson of issue #1917's review: the RULES describe the source, but the deploy
 * engine's persist choke point applies them to every record in the state map,
 * including ones this pass never rewrote. A template can never certify the
 * generation of the bag it is walked against.
 */
export const TEMPLATE_DERIVED_RULES: PathSourceRules = {
  descendArrays: true,
  trustAnyExpression: false,
  sourceIsSameGeneration: false,
};

/**
 * An AWS readback, or a persisted STATE bag, projected from the TEMPLATE: no
 * relaxation applies.
 *
 * One constant covers both bags because the template is what decides all three
 * rules here, and it decides them identically: shapes may diverge (no
 * positional descent), the template carries PUBLIC ssm expressions (no blanket
 * trust), and it is a different generation from anything it is walked against
 * (no source-takes-precedence on an expression-shaped leaf). An earlier draft
 * split this into a second `TEMPLATE_SOURCED_STATE_BAG_RULES` for `cdkd scrub`;
 * the two ended up byte-identical once the axis moved from CALLER to
 * GENERATION, and two identical constants are a drift hazard, not a
 * distinction.
 */
export const TEMPLATE_SOURCED_RULES: PathSourceRules = {
  descendArrays: false,
  trustAnyExpression: false,
  sourceIsSameGeneration: false,
};

/**
 * An AWS readback projected from THIS record's own persisted STATE bag.
 *
 * Does NOT fail closed. This is the constant a caller reaches for when it knows
 * the SHAPE of its two bags and nothing about where the result lands —
 * `cdkd drift`'s two writers pass it, and so does
 * `DeployEngine.redactOperationsForJournal` for the journal's `previousState`
 * (issue [#2886](https://github.com/go-to-k/cdkd/issues/2886): a REPLAYED
 * baseline must not gain masks a rollback restore then persists). See
 * {@link STATE_SOURCED_BASELINE_RULES} for the one that does, and
 * `failClosedOnUncertifiedPositions` for why the difference is declared rather
 * than derived.
 */
export const STATE_SOURCED_READBACK_RULES: PathSourceRules = {
  descendArrays: false,
  trustAnyExpression: true,
  sourceIsSameGeneration: true,
};

/**
 * {@link STATE_SOURCED_READBACK_RULES} for a caller that KNOWS its bag becomes
 * a drift BASELINE — `observedProperties` and nothing else (issue
 * [#2852](https://github.com/go-to-k/cdkd/issues/2852)).
 *
 * Identical on the three shape flags, so every relaxation and refusal the
 * readback path already had applies unchanged; the only difference is that a
 * position this pass cannot certify is written as {@link SECRET_MASK} rather
 * than as the DECRYPTED readback. Passed by `cdkd state refresh-observed` and
 * by `cdkd import`'s observed capture (issue
 * [#2885](https://github.com/go-to-k/cdkd/issues/2885), which moved it off the
 * non-failing constant), and derived by {@link scrubResourceRecord} for the
 * observed bag — the deploy's `drainObservedCaptures` baseline reaches it that
 * way.
 *
 * WHAT SELECTS IT IS THE DESTINATION, which is why it cannot be derived from
 * the two bags: `cdkd drift --accept` walks with the same shape flags and then
 * writes its result into `properties` for a record with no
 * `observedProperties`, where a mask is a REGRESSION rather than a refusal
 * (`cdkd export` blocks such a record and the rollback replay refuses the
 * operation). A caller declares this constant when it knows its bag becomes a
 * drift baseline and nothing else — and since issue
 * [#2939](https://github.com/go-to-k/cdkd/issues/2939) the two `cdkd drift`
 * writers make that call per record: `--accept`'s new baseline and
 * `--revert`'s narrowed delta take THIS constant when the record carries
 * `observedProperties` (the bag lands there) and
 * {@link STATE_SOURCED_READBACK_RULES} otherwise (the bag lands in
 * `properties`), the *** rows of the write-site table above.
 */
export const STATE_SOURCED_BASELINE_RULES: PathSourceRules = {
  descendArrays: false,
  trustAnyExpression: true,
  sourceIsSameGeneration: true,
  failClosedOnUncertifiedPositions: true,
};

/**
 * A STATE source that is no longer this bag's own generation — `cdkd scrub`'s
 * `observedProperties` walk (issue #1917 review).
 *
 * It differs from {@link STATE_SOURCED_READBACK_RULES} on one flag, and the
 * difference is not cosmetic. Scrub positions `properties` against TODAY's
 * template BEFORE the observed bag is walked, so the "record's own properties"
 * that serve as the observed source may already carry an expression the stack
 * has never deployed. Taking that source for an observed leaf that ALREADY
 * holds an expression rewrites the drift baseline onto an undeployed
 * reference — which `cdkd drift --revert` then pushes to AWS.
 *
 * `trustAnyExpression` stays TRUE: the source is still a STATE bag, holding no
 * public expressions, and that relaxation is what lets scrub clean a legacy
 * PLAINTEXT observed leaf (issue #1900) rather than falling back to a value
 * scan that an old state file gives no needles for.
 */
export const STATE_SOURCED_CROSS_GENERATION_RULES: PathSourceRules = {
  descendArrays: false,
  trustAnyExpression: true,
  sourceIsSameGeneration: false,
};

/**
 * The bag was produced by resolving a STATE source — every relaxation applies.
 *
 * The rollback replay is the case (issue #1910): `resolveReplayProps` resolves
 * the JOURNALED bag and the provider's `effectiveProperties` come back from
 * that, so the two have identical structure and positional array descent is
 * sound exactly as it is for a template-derived bag. The source is a persisted
 * record, which holds no PUBLIC expressions — a `String` ssm reference is
 * stored resolved — so any `{{resolve:...}}` in it is by construction a secret.
 * And it is the SAME generation the bag was resolved from, one statement
 * earlier in the same call, which is as strong as that claim ever gets.
 *
 * Using a `*_SOURCED_*` constant here instead would be wrong in the quiet
 * direction: it turns positional array descent OFF for a bag that genuinely
 * does correspond positionally, and drops the generation claim for the one
 * writer that can actually make it.
 */
export const STATE_DERIVED_RULES: PathSourceRules = {
  descendArrays: true,
  trustAnyExpression: true,
  sourceIsSameGeneration: true,
};

export function isDynamicReferenceString(value: unknown): value is string {
  return typeof value === 'string' && value.includes('{{resolve:');
}

/**
 * Is this template expression one whose resolved value is a SECRET?
 *
 * Two independent answers, and both are needed:
 *
 * - A `secretsmanager` reference is secret BY DEFINITION, so spelling settles
 *   it with no lookup. This arm is what makes the #1904 fix work at all: when
 *   two expressions resolve to the same value the value-keyed map keeps only the
 *   last, so asking the map whether the LOSING expression was a secret answers
 *   "no" — precisely for the pair the fix exists to separate.
 * - An `ssm` reference is secret only when its parameter is a `SecureString`
 *   (issue #1901), which is not derivable from the string, so that arm consults
 *   what the resolver actually recorded.
 *
 * `secretExpressions` is what closes the ssm/ssm case (issue #1910). Derived
 * from the value-keyed map it is useless for exactly this question — the map
 * already collapsed the pair, so the losing expression is absent from
 * `secrets.values()` — which is why callers pass the resolver's own SET of
 * secret expressions instead. Callers that pass nothing fall back to the map's
 * values, i.e. to the pre-#1910 behavior: the pair still collapses, but nothing
 * leaks (both leaves are redacted, just onto one expression).
 */
export function isKnownSecretExpression(
  expression: string,
  secretExpressions: ReadonlySet<string>
): boolean {
  return (
    isSecretExpressionByVerdictOrSpelling(expression) ||
    // The pass's own map collapsed every group of expressions sharing a
    // resolved value down to its last member, so the LOSING members reach this
    // arm and only this arm (issue #1910).
    secretExpressions.has(expression)
  );
}

/**
 * The arms of {@link isKnownSecretExpression} that need NO pass-local set:
 * `secretsmanager` / `ssm-secure` by SPELLING, and anything this process
 * PROVED secret.
 *
 * Split out so the resolver can ask the same question at the issue #2059
 * recording seam, where no `secretExpressions` set is in hand. It must not
 * acquire an argless default of its own — that is how a predicate silently
 * starts answering about a narrower population than its caller believes.
 *
 * The omitted arm costs the caller only REFUSALS. A cross-REGION `ssm`
 * `SecureString` is the one shape it can miss, because the producer-region
 * resolver is a GUEST and `pinSecretVerdict` deliberately writes nothing
 * process-wide from a guest (issue #1934's review) — so such a token is simply
 * not recorded at the seam, and its leaf falls back to the value scan.
 *
 * GUEST SUPPRESSION ALSO CUTS THE OTHER WAY, and saying only the above would be
 * one-sided. The same early return means a guest's DEFINITIVE PUBLIC verdict
 * never RETRACTS a memo either, so if the consumer's own resolver already
 * pinned that spelling as a `SecureString`, this answers `true` for a
 * producer-region parameter that is really a plain `String`. The outcome is
 * bounded to a spurious UPDATE (#1901's class) and can never be a plaintext:
 * the answer persisted is still an EXPRESSION, and the presence test beside
 * this one at the seam still requires the pass to have resolved it to a real
 * needle. Closing it means keying the verdict store by region, which is a
 * change to a store this function only reads.
 */
export function isSecretExpressionByVerdictOrSpelling(expression: string): boolean {
  return (
    // The two spellings that are secret whatever they point at — the same
    // pair `SPELLED_SECRET_REFERENCE_PREFIXES` lists; `ssm-secure` joined here
    // with issue #2482. The resolver still records that expression into the
    // verdict store at its shared tail, but for ENUMERATION (the #1916
    // losing-member recovery), not because the verdict needs a memo — the
    // spelling answers here before anything has been resolved.
    expression.startsWith('{{resolve:secretsmanager:') ||
    expression.startsWith('{{resolve:ssm-secure:') ||
    isRecordedSecretExpression(expression)
  );
}

/**
 * The character class a `{{resolve:...}}` reference's INNER text is built from,
 * and the SINGLE SOURCE OF TRUTH every dynamic-reference predicate in cdkd
 * derives from (issue
 * [#1936](https://github.com/go-to-k/cdkd/issues/1936)).
 *
 * **THE AUTHORITY IS THE RESOLVER.**
 * `IntrinsicFunctionResolver.resolveDynamicReferences`
 * (`src/deployment/intrinsic-resolver/dynamic-refs.ts`) scans with
 * `/\{\{resolve:([^}]+)\}\}/g`, so what cdkd will actually RESOLVE is exactly
 * `{{resolve:` followed by one or more non-`}` characters followed by `}}`.
 * A predicate that answers a different question than that scan is answering
 * about a string the resolver already substituted a value INTO, which is how a
 * leaf ends up classified as "not a token" while holding the plaintext the
 * resolver put there.
 *
 * Three sites disagreed before this constant existed, and the STRICTEST of them
 * was the one that persisted plaintext. `isSingleDynamicReferenceToken` here and
 * `isWholeDynamicReference` in `src/cli/commands/drift.ts` both spelled the
 * inner class `[^{}]*`, while `survivingDynamicReferences` (same file) spelled
 * it `[^}]+` to match the resolver. For a reference whose inner text contains a
 * `{` — a Secrets Manager JSON key or a secret name, e.g.
 * `{{resolve:secretsmanager:app/db:SecretString:my{key}}` — the resolver
 * resolves it fine, but the strict spelling said it was not a single token, so
 * `redactByPath`'s source arm refused it and on an EMPTY-map path the RESOLVED
 * PLAINTEXT was persisted verbatim. A disclosure, narrow and pre-existing.
 *
 * `cdkd scrub` is the only leaking command, and it leaks on BOTH of its walks
 * -- the second one named after the issue #2088 security review, which found
 * the first draft of this note incomplete:
 *
 * - the `properties` walk under `TEMPLATE_SOURCED_RULES`, where
 *   `isKnownSecretExpression` answers true by SPELLING but the strict
 *   predicate refused the leaf before it could; and
 * - the cross-generation `observedProperties` walk, whose value scan has no
 *   needles (issue #1900).
 *
 * The empty map is reachable on both because `scrub.ts` resolves BEST-EFFORT
 * (a deleted secret, or a role lacking read permission on it, leaves
 * `recordedSecretValues` empty) and then records `perResourceTemplateProps`
 * UNCONDITIONALLY while recording `perResourceSecrets` only when non-empty --
 * so the position source is present with no map beside it.
 *
 * `cdkd state refresh-observed` and the deploy's `drainObservedCaptures` are
 * NOT affected: they take a `STATE_SOURCED_*` readback constant, which sets
 * `sourceIsSameGeneration`, so {@link refuseUncertifiedReadbackPositions}
 * restores the source even under the old strict class.
 *
 * Excluding `{` bought nothing. The mangled / concatenated shapes it might seem
 * to guard — `{{resolve:a}}{{resolve:b}}`, a spliced token — are already
 * rejected by `[^}]+` under an ANCHORED pattern, because the class cannot cross
 * the first `}`. (A claim that `[^}]+` would let `{{resolve:a}}{{resolve:b}}`
 * through circulated in review and is FALSE: that string does not match
 * `^\{\{resolve:[^}]+\}\}$` either.) The only strings the two spellings
 * classify differently are the ones with a `{` inside a single token, i.e.
 * exactly the disclosure above.
 *
 * `+` rather than `*` for the same reason: `{{resolve:}}` is not something the
 * resolver would try to resolve, so nothing here may call it a token.
 *
 * The class is exported as a STRING rather than as a finished `RegExp` because
 * three different pattern shapes are built from it — anchored, global, and
 * {@link SKELETON_WILDCARD}'s zero-or-more form — and a shared global `RegExp`
 * instance would carry `lastIndex` across callers.
 */
export const DYNAMIC_REFERENCE_INNER_CHAR = '[^}]';

/**
 * The inner-text pattern fragment of a complete `{{resolve:...}}` reference,
 * byte-identical to the resolver's own `([^}]+)` capture. See
 * {@link DYNAMIC_REFERENCE_INNER_CHAR} for why this is one constant.
 */
export const DYNAMIC_REFERENCE_INNER = `${DYNAMIC_REFERENCE_INNER_CHAR}+`;

/**
 * Anchored: the WHOLE string is one complete `{{resolve:...}}` token.
 *
 * A non-global `RegExp`, so `.test` carries no `lastIndex` state and the shared
 * instance is safe to reuse.
 */
export const WHOLE_DYNAMIC_REFERENCE_PATTERN = new RegExp(
  `^\\{\\{resolve:${DYNAMIC_REFERENCE_INNER}\\}\\}$`
);

/**
 * Is this leaf a SINGLE complete `{{resolve:...}}` token and nothing else?
 *
 * Whole-leaf substitution is only correct for that shape. A MIXED leaf --
 * `pre{{resolve:ssm:/public}}-{{resolve:secretsmanager:x}}post`, i.e. anything
 * the resolver substituted INTO rather than replaced -- must fall to the value
 * scan, which rewrites just the secret substring. Substituting the whole leaf
 * there would re-introduce every other token in it, including a public ssm
 * reference the resolver deliberately left resolved (issue #1901).
 *
 * EXPORTED since issue #1936 so `src/cli/commands/drift.ts` can consume this
 * one definition instead of carrying a hand-copied twin. Its copy's own comment
 * said "copied rather than imported because that helper is module-private and
 * this file may not widen that module's exports" — widening the exports is the
 * cheaper half of that trade once the copies have provably disagreed.
 */
export function isSingleDynamicReferenceToken(value: string): boolean {
  return WHOLE_DYNAMIC_REFERENCE_PATTERN.test(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
