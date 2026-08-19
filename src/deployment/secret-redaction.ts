/**
 * Secret redaction for resolved dynamic references (GHSA fix).
 *
 * CloudFormation dynamic references (`{{resolve:secretsmanager:...}}`) are
 * resolved to plaintext by `IntrinsicFunctionResolver.resolveDynamicReferences`
 * so the concrete secret can be handed to the AWS API on create / update. That
 * plaintext must NEVER be persisted to cdkd state or shown in CLI output, or
 * anyone with read access to the state bucket / terminal logs recovers the
 * secret — which defeats the entire point of storing it in Secrets Manager.
 *
 * The resolver records, per resolution pass, every plaintext secret VALUE it
 * substituted together with the original `{{resolve:...}}` expression it came
 * from (a `RecordedSecretValues` map on `ResolverContext`). This module turns
 * that record into two pure operations:
 *
 * - {@link redactSecretsForState} rewrites the bag cdkd is about to PERSIST so
 *   each secret value is replaced by the original unresolved expression. This
 *   is CloudFormation-parity: CFn keeps the `{{resolve:...}}` reference in the
 *   template and resolves it service-side, so the concrete value never lands in
 *   a persisted artifact. Storing the expression (rather than a blind `***`
 *   marker) also means the next `cdkd deploy` diffs expression-vs-expression
 *   and does not spuriously re-apply the resource on every run.
 *
 * - {@link maskSecretsInText} replaces any known secret value inside an
 *   arbitrary string with a fixed marker, for log / error-message paths where
 *   the resolved value would otherwise be echoed (`Fn::Join` / `Fn::Sub` debug
 *   lines, the Cloud Control JSON-patch log, AWS validation errors quoting the
 *   offending value).
 *
 * {@link maskSecretsInText} works by VALUE match alone: a resolved secret is a
 * distinctive plaintext string, so a value scan covers the embedded cases
 * uniformly without threading a path argument through every resolver method.
 * Over-redaction (a coincidental match elsewhere) is harmless and the safe
 * direction; under-redaction would leak a secret, so a match is always
 * replaced. {@link redactSecretsForState} layers POSITION on top of that scan —
 * see its own doc and {@link redactByPath} — because a value match cannot tell
 * two expressions apart once they resolve to the same plaintext.
 *
 * The module is a LEAF — it imports nothing — because both the resolver and the
 * deploy engine consume it and both already sit on a dense import ring.
 */

/**
 * Map of resolved plaintext secret value -> the original `{{resolve:...}}`
 * expression it was substituted from. Populated by the resolver during a
 * resolution pass and read by the persistence / masking helpers below.
 */
export type RecordedSecretValues = Map<string, string>;

/** Fixed marker substituted for a secret value in log / error output. */
export const SECRET_MASK = '***';

/**
 * Every `{{resolve:...}}` expression this process has PROVEN resolves to a
 * secret, as a SET — uncollapsed by resolved value (issue #1910).
 *
 * This is the piece {@link RecordedSecretValues} structurally cannot supply.
 * That map is keyed by the resolved PLAINTEXT, so when two expressions resolve
 * to the same value it keeps only the last, and asking it whether the LOSING
 * expression was a secret answers "no" — for precisely the pair the path-based
 * redaction exists to separate. The losing leaf then falls through to the value
 * scan and is persisted holding its SIBLING's expression: a permanent spurious
 * UPDATE, and on the rollback-journal replay path a re-resolution of the wrong
 * reference against the live resource.
 *
 * EVERY secret expression is recorded, not only the `ssm` ones (issue
 * [#1916](https://github.com/go-to-k/cdkd/issues/1916)). Only `ssm` needs an
 * entry to answer "is this secret?" — a `secretsmanager` reference is secret by
 * SPELLING (see {@link isKnownSecretExpression}), decidable with no lookup and
 * no memory, while an `ssm` one is secret only when its parameter is a
 * `SecureString`, knowable only from the `GetParameter` response. But this set
 * answers a SECOND question: it is the CANDIDATE LIST
 * {@link positionByIntrinsicSkeleton} matches an intrinsic source leaf against,
 * and there the losing member of a collapsed
 * secretsmanager/secretsmanager pair must be nameable too. Holding only the ssm
 * half made the set's name a lie and left that pair unpositionable.
 *
 * One kind is deliberately still absent: an `ssm` reference whose `Type` came
 * back unclassifiable is treated as secret for THAT resolution but not pinned,
 * so the next pass re-asks AWS rather than inheriting a transient answer
 * (issue #1901). Recording it here would pin it for the process.
 *
 * It lives in THIS module rather than in the resolver even though the resolver
 * is its only writer, for two reasons. This module is the LEAF — the resolver
 * already imports it, so the store is reachable from the writer without adding
 * an edge, while the reverse (a leaf importing the resolver) would close a
 * cycle. And the READER is {@link isKnownSecretExpression} right here, so
 * homing it here means no call site has to thread it: the four sibling writers
 * #1910 fixes pass a position SOURCE and nothing else.
 *
 * Its lifetime NO LONGER matches the resolver's `cachedDynamicReferences`, and
 * that divergence is now deliberate (issue
 * [#1933](https://github.com/go-to-k/cdkd/issues/1933)). The resolved VALUES
 * moved onto the RESOLVER INSTANCE — one per stack, each carrying its own
 * region — because a value is only true for the region that read it. A VERDICT
 * is a statement about a reference's TYPE and has to be readable with no
 * resolver in hand: {@link isKnownSecretExpression} is consulted from the
 * redaction path, whose callers thread a position SOURCE and nothing else. So
 * this set stays process-wide while the values do not, and
 * `resetAccountInfoCache` now clears only this one.
 *
 * Process-wide is therefore CHOSEN here rather than inherited, and the choice
 * is what makes a stale verdict correctable: a resolver whose fresh
 * `GetParameter` reports a public `Type` RETRACTS the entry
 * ({@link forgetSecretExpression}) for every later reader, which a per-region
 * store would scope away. It is still not strictly sound across regions or
 * accounts in one run — the same expression can name a `SecureString` in one
 * region and a plain `String` in another — but note which way the imprecision
 * points in EACH direction now that the two stores can disagree. An entry only
 * ever GRANTS "persist the source leaf verbatim", so a verdict inherited from
 * another region can at worst store a public reference as an expression (a
 * spurious UPDATE, issue #1901's class), never a secret as plaintext. And the
 * opposite move — another region RETRACTING a verdict this stack still needs —
 * cannot un-redact anything either, because each of the resolver's own cache
 * entries carries the verdict that produced it and re-records on a hit without
 * consulting this set.
 */
const recordedSecretExpressions = new Set<string>();

/** Remember that `expression` resolves to a secret. Called by the resolver. */
export function recordSecretExpression(expression: string): void {
  recordedSecretExpressions.add(expression);
}

/**
 * Forget a previously recorded expression — the resolver's `SecureString`
 * verdict going the other way (an ssm parameter that turns out to be a plain
 * `String` / `StringList`, i.e. public config that must stay RESOLVED in
 * state).
 */
export function forgetSecretExpression(expression: string): void {
  recordedSecretExpressions.delete(expression);
}

/** Has `expression` been PROVEN to resolve to a secret this process? */
export function isRecordedSecretExpression(expression: string): boolean {
  return recordedSecretExpressions.has(expression);
}

/** Drop every remembered verdict. Paired with the resolver's cache reset. */
export function clearRecordedSecretExpressions(): void {
  recordedSecretExpressions.clear();
}

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a single alternation regex matching any recorded secret value, longest
 * first so an overlapping shorter secret cannot pre-empt a longer match. Returns
 * `undefined` when there is nothing worth scanning for.
 */
function buildNeedleRegex(values: Iterable<string>): RegExp | undefined {
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
 *   `src/analyzer/drift-normalize.ts` exists — and descending it positionally
 *   would write an expression onto the WRONG element while leaving the real
 *   secret in plaintext.
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
 *   The refusal is a FALL-BACK, not a stop: a refused leaf takes a WHOLE-VALUE
 *   redaction rather than being returned untouched. That is what lets the rule
 *   be set conservatively without giving up issue #1917. On a bag the pass
 *   really did resolve, the token-shaped plaintext is a key of `secrets`, so it
 *   is rewritten onto an expression; a previous generation's expression is not
 *   a key (it is an expression, not a plaintext), so it survives untouched. One
 *   test, two right answers, and neither depends on the caller having
 *   classified itself correctly.
 *
 *   Whole-value and not the full value scan: the scan's SUBSTRING arm would
 *   splice a short secret value found inside the token's own text into the
 *   reference. And "onto its own expression" is the ordinary case, not a
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
 *   deploy `redactOutputs` (3 sites)           template `Outputs`   TEMPLATE_DERIVED_RULES                VALUE SCAN
 *   `cdkd import` `properties`                 imported template    TEMPLATE_DERIVED_RULES                VALUE SCAN
 *   observed walk, template source             current template     TEMPLATE_SOURCED_RULES                VALUE SCAN
 *   `cdkd scrub` `properties` / `outputs`      TODAY's template     TEMPLATE_SOURCED_RULES                VALUE SCAN
 *   `cdkd scrub` observed walk                 REPOSITIONED props   STATE_SOURCED_CROSS_GENERATION_RULES  VALUE SCAN
 *   observed walk, own-record source           the record itself    STATE_SOURCED_READBACK_RULES          TAKE SOURCE
 *   `cdkd state refresh-observed`              the record itself    STATE_SOURCED_READBACK_RULES          TAKE SOURCE
 *   `cdkd drift --accept` new baseline         the record itself    STATE_SOURCED_READBACK_RULES          TAKE SOURCE
 *   `cdkd drift --revert` narrowed delta       revert baseline      STATE_SOURCED_READBACK_RULES          TAKE SOURCE
 *   deploy journal `previousState`             the record itself    STATE_SOURCED_READBACK_RULES          TAKE SOURCE
 *   rollback replay trailing record scrub      the record itself    STATE_SOURCED_READBACK_RULES          TAKE SOURCE
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
 * The `verdict` column answers ONLY the "bag leaf is a single complete
 * `{{resolve:...}}` token" question the table poses. The two
 * `STATE_SOURCED_*` readback constants additionally run
 * {@link refuseUncertifiedReadbackPositions} after the path pass, which is what
 * answers the shapes that question does not reach — a MIXED leaf, an array
 * that cannot pair, an unpaired element. See that function's own table.
 *
 * The two `the record itself` rows added last reach this through
 * `scrubResourceRecord` with NO `sourceProperties`, so they take the derived
 * readback constant: `DeployEngine.redactOperationsForJournal` scrubs a
 * `previousState` snapshot against its own untouched `properties`, and
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

/** An AWS readback projected from THIS record's own persisted STATE bag. */
export const STATE_SOURCED_READBACK_RULES: PathSourceRules = {
  descendArrays: false,
  trustAnyExpression: true,
  sourceIsSameGeneration: true,
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

function isDynamicReferenceString(value: unknown): value is string {
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
function isKnownSecretExpression(
  expression: string,
  secretExpressions: ReadonlySet<string>
): boolean {
  return (
    expression.startsWith('{{resolve:secretsmanager:') ||
    secretExpressions.has(expression) ||
    // The pass's own map collapsed every group of expressions sharing a
    // resolved value down to its last member, so the LOSING members reach this
    // arm and only this arm (issue #1910).
    isRecordedSecretExpression(expression)
  );
}

/**
 * Is this source leaf a SINGLE complete `{{resolve:...}}` token and nothing
 * else?
 *
 * Whole-leaf substitution is only correct for that shape. A MIXED leaf --
 * `pre{{resolve:ssm:/public}}-{{resolve:secretsmanager:x}}post`, i.e. anything
 * the resolver substituted INTO rather than replaced -- must fall to the value
 * scan, which rewrites just the secret substring. Substituting the whole leaf
 * there would re-introduce every other token in it, including a public ssm
 * reference the resolver deliberately left resolved (issue #1901).
 */
function isSingleDynamicReferenceToken(value: string): boolean {
  return /^\{\{resolve:[^{}]*\}\}$/.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Stands in for a source part the skeleton cannot know — an `Fn::Join` element
 * that is itself an intrinsic, or an `Fn::Sub` `${...}` variable.
 *
 * `[^}]*` rather than `.*` because a recorded expression's INNER text never
 * contains `}`: the resolver matches them with `/\{\{resolve:([^}]+)\}\}/`, so
 * the first `}` after `{{resolve:` is already the terminator. Excluding it
 * means a wildcard can never swallow one token's terminator and run into the
 * next, so a skeleton for ONE reference cannot match a candidate built from a
 * different one.
 */
const SKELETON_WILDCARD = '[^}]*';

/**
 * More wildcards than this and the skeleton is REFUSED outright.
 *
 * The bound is what actually closes the backtracking class; the collapse below
 * only closes one ARRANGEMENT of it. A skeleton with N wildcards makes a
 * FAILING match exponential in N — and failing is the common case, since the
 * pattern is tried against every recorded expression that is NOT this leaf's.
 * The collapse merges ADJACENT wildcards, so `${a}${b}${c}` becomes one; but
 * wildcards separated by a literal cannot merge and backtrack identically.
 * Measured against a failing candidate: `Fn::Sub '${a}x${b}x…'` at 6 wildcards
 * 17.7s and at 8 did not finish in two minutes, and a realistic
 * `Fn::Join['-', 9 x {Ref}]` against a hyphen-rich secret ARN took 855ms per
 * candidate. So the producer is the wildcard COUNT, not adjacency.
 *
 * What refusing costs is worth stating plainly rather than waving away, because
 * it is the SAME cost this module's residual note describes: a refused leaf
 * falls to the value scan, and for a colliding pair that means state holds the
 * SIBLING's reference, which `resolveReplayProps` re-resolves and applies. A
 * four-wildcard join carrying substantive literals CAN position uniquely, so
 * the bound does give something up. It is set where it is because the dominant
 * CDK shape carries exactly ONE wildcard (the secret ARN's `{Ref}`) and two or
 * three covers an account plus a region — and because the alternative at the
 * top of that trade is not "slightly better redaction" but a deploy that hangs
 * after its AWS mutations.
 */
const MAX_SKELETON_WILDCARDS = 3;

/**
 * A candidate longer than this REFUSES the whole positioning pass.
 *
 * The wildcard cap bounds the EXPONENT; this bounds the BASE. Cost at the cap
 * is polynomial in the candidate's length (~cubic, measured: 200 chars 4.9ms,
 * 1000 chars 192ms, and an adversarial all-separator 3000-char candidate 4.1s),
 * and candidate length is template-authored — `[^}]*` never crosses a `}`, so
 * the whole expression is one backtracking run. A real `{{resolve:...}}` is
 * 100-250 characters even with a full ARN and a JSON key, so this only excludes
 * the pathological.
 *
 * The whole pass is refused rather than that one candidate being SKIPPED, and
 * the difference is load-bearing: skipping shrinks the candidate set, so a
 * second match could go unseen and condition 2's "exactly one" would be decided
 * over a filtered list — turning a bound meant for speed into a silent
 * weakening of the fence. Refusing degrades to the value scan like every other
 * refusal here.
 */
const MAX_SKELETON_CANDIDATE_LENGTH = 512;

/**
 * Concatenate skeleton segments, dropping an empty one and COLLAPSING a run of
 * consecutive wildcards into one — then REFUSE (return `undefined`) when more
 * than {@link MAX_SKELETON_WILDCARDS} survive.
 *
 * The collapse is a correctness fix, not tidiness: `[^}]*[^}]*` is semantically
 * identical to `[^}]*`, but the engine has to try every split of the input
 * between them. Measured on a ~120-char candidate, before the collapse:
 * 4 adjacent wildcards 39ms, 5 ~1s, 6 20s, 8 did not finish in two minutes. Two
 * legal CFn shapes CDK can emit produce ADJACENT ones — an `Fn::Join` with an
 * EMPTY delimiter and consecutive non-string parts, and an `Fn::Sub` with
 * adjacent `${a}${b}` variables — and the collapse takes both to a single
 * wildcard. It does NOT close the class, which is why the cap exists beside it.
 *
 * This runs on the state-persist choke point, i.e. AFTER the AWS mutations and
 * BEFORE state is written, so a hang there strands real resources.
 *
 * An empty segment is dropped rather than appended because an empty DELIMITER
 * would otherwise sit between two wildcards and defeat the collapse. A
 * non-empty literal between two wildcards is what anchors the match, and those
 * are left exactly as they are — and counted.
 */
function joinSkeletonSegments(segments: readonly string[]): string | undefined {
  const out: string[] = [];
  let wildcards = 0;
  for (const segment of segments) {
    if (segment === '') continue;
    if (segment === SKELETON_WILDCARD) {
      if (out[out.length - 1] === SKELETON_WILDCARD) continue;
      wildcards += 1;
      if (wildcards > MAX_SKELETON_WILDCARDS) return undefined;
    }
    out.push(segment);
  }
  return out.join('');
}

/**
 * Build an anchored pattern describing what a `{{resolve:...}}` expression at
 * this INTRINSIC source leaf must look like — literal parts kept verbatim,
 * unknowable parts wildcarded (issue #1916).
 *
 * The dominant CDK shape is an `Fn::Join`, because `secret.secretValueFromJson(...)`
 * renders the secret's ARN as a `Ref` and CDK joins the pieces:
 *
 * ```json
 * {"Fn::Join": ["", ["{{resolve:secretsmanager:my-secret-", {"Ref": "AWS::AccountId"},
 *                    ":SecretString:password}}"]]}
 * ```
 *
 * which yields `^\{\{resolve:secretsmanager:my\-secret\-[^}]*:SecretString:password\}\}$`
 * — enough to tell that leaf's expression from its `:AWSCURRENT`-suffixed
 * sibling, which is precisely what the value map cannot do once the two
 * resolve to the same plaintext. `Fn::Sub` has the same shape via its literal
 * template string.
 *
 * Returns `undefined` for any source this cannot describe (a delimiter that is
 * itself an intrinsic, a non-array `Fn::Join`, a non-string `Fn::Sub`
 * template, an object that is not a single-key intrinsic at all), and the
 * caller then falls back to the value scan — i.e. to the pre-#1916 behavior.
 *
 * Exported for its TEST only. The reason is now CONVENIENCE rather than
 * necessity, and the distinction is worth keeping straight: before the wildcard
 * cap existed, driving the collapse through `redactSecretsForState` did not
 * fail on a timeout — catastrophic backtracking is SYNCHRONOUS, so it wedged
 * the vitest worker and the run never ended, which is a worse CI outcome than
 * the defect and indistinguishable from a slow machine. With the cap, dropping
 * the collapse turns that same input into a REFUSAL, so the behavior IS
 * observable through the public entry point. Asserting on the returned
 * pattern's shape is still the better fence — it names the invariant (how many
 * unknown spans survived) instead of a downstream consequence — but it is a
 * choice, not the only option.
 */
export function intrinsicSkeletonPattern(source: Record<string, unknown>): RegExp | undefined {
  const keys = Object.keys(source);
  if (keys.length !== 1) return undefined;
  const key = keys[0]!;

  if (key === 'Fn::Join') {
    const args = source[key];
    if (!Array.isArray(args) || args.length !== 2) return undefined;
    const [delimiter, parts] = args as [unknown, unknown];
    // A non-string delimiter is unknowable, and it sits BETWEEN every pair of
    // parts, so wildcarding it would erase most of the skeleton's specificity.
    if (typeof delimiter !== 'string' || !Array.isArray(parts)) return undefined;
    const separator = escapeRegExp(delimiter);
    const segments: string[] = [];
    parts.forEach((part, index) => {
      if (index > 0) segments.push(separator);
      segments.push(typeof part === 'string' ? escapeRegExp(part) : SKELETON_WILDCARD);
    });
    const body = joinSkeletonSegments(segments);
    return body === undefined ? undefined : new RegExp(`^${body}$`);
  }

  if (key === 'Fn::Sub') {
    const args = source[key];
    // Both forms: the bare template string, and the 2-arg `[template, vars]`.
    // The variable MAP is deliberately not consulted — a var can be bound to an
    // intrinsic, so only the `${...}` POSITIONS are reliably knowable.
    const template = typeof args === 'string' ? args : Array.isArray(args) ? args[0] : undefined;
    if (typeof template !== 'string') return undefined;
    const segments: string[] = [];
    let cursor = 0;
    const variable = /\$\{([^}]*)\}/g;
    let hit: RegExpExecArray | null;
    while ((hit = variable.exec(template)) !== null) {
      segments.push(escapeRegExp(template.slice(cursor, hit.index)));
      const inner = hit[1]!;
      // `${!Foo}` is CloudFormation's escape for a LITERAL `${Foo}`, so it is
      // known text rather than a substitution point.
      segments.push(
        inner.startsWith('!') ? escapeRegExp(`\${${inner.slice(1)}}`) : SKELETON_WILDCARD
      );
      cursor = hit.index + hit[0].length;
    }
    segments.push(escapeRegExp(template.slice(cursor)));
    const body = joinSkeletonSegments(segments);
    return body === undefined ? undefined : new RegExp(`^${body}$`);
  }

  return undefined;
}

/**
 * Position a leaf whose SOURCE is an intrinsic OBJECT, by matching the shape of
 * that intrinsic against the expressions this process recorded as secrets
 * (issue #1916).
 *
 * This is the residual {@link redactByPath} left behind. Its plain-string arm
 * persists the source leaf VERBATIM, which needs a source string to copy; when
 * the source leaf is an `Fn::Join` / `Fn::Sub` there is none, so the leaf fell
 * to the value scan — and the value map is keyed by the resolved PLAINTEXT, so
 * a colliding pair collapses there exactly as it did before #1904. That is the
 * DOMINANT CDK shape rather than an edge case: any secret reached through an L2
 * token renders the secret ARN as a `Ref`, hence an `Fn::Join`.
 *
 * Three conditions must ALL hold before an expression is persisted, and each
 * removes a different way of being wrong:
 *
 * 1. The bag leaf's WHOLE value is a recorded secret plaintext. The skeleton
 *    describes ONE complete `{{resolve:...}}` token, so a leaf that merely
 *    EMBEDS a secret (a join with surrounding text) is not this shape at all
 *    and must keep going to the value scan, which rewrites just the substring.
 * 2. EXACTLY ONE candidate matches. Two matching candidates mean the skeleton
 *    genuinely cannot separate them (`{Ref}` in the position that differs), and
 *    guessing would be the collapse this fix exists to remove, one step over.
 * 3. The match is not DEMONSTRABLY another value's expression. The pass's own
 *    map holds each surviving expression against the plaintext it resolved to,
 *    so a candidate recorded there under a DIFFERENT plaintext is refused. That
 *    is what fences a bag/source misalignment: a shape-plausible expression is
 *    rejected outright when the pass can see it resolved to something else. A
 *    candidate absent from that map is a collapsed LOSER, which is the case
 *    this whole function exists to serve, so it is accepted.
 *
 * Every rejection degrades to the value scan, i.e. to today's behavior, so no
 * case gets worse than it is without this pass.
 *
 * One residual is worth naming rather than leaving to be rediscovered: a single
 * WRONG candidate can win only when this leaf's own expression is in NEITHER
 * store — which is exactly an `ssm` reference whose `Type` came back
 * unclassifiable (deliberately unpinned per #1901) and which then lost the
 * value collapse. `recordedSecretExpressions` is process-wide, so the winner
 * could in principle come from another resource, and condition 3 cannot refuse
 * one the pass never recorded.
 *
 * **What that costs is a WRONG REFERENCE in state, not merely a noisy diff.**
 * Persisting another leaf's expression is the pre-#1904 failure exactly:
 * `resolveReplayProps` RE-RESOLVES the persisted expression against AWS and
 * hands the result to `provider.update`, so a rollback replays the wrong secret
 * — immediately, if the two references already resolve to different values. It
 * is narrow (unclassifiable-`ssm` leaves only) but it is not cosmetic, and an
 * earlier draft of this paragraph called it "a spurious UPDATE rather than a
 * disclosure", which understated it.
 *
 * There is deliberately NO {@link isKnownSecretExpression} check here, and the
 * asymmetry with {@link redactByPath}'s plain-string arm is principled rather
 * than an oversight. That arm's candidate is the SOURCE LEAF itself — arbitrary
 * template text, which genuinely can be a PUBLIC ssm reference that must stay
 * resolved in state (issue #1901), so it has to be tested. Here the candidates
 * come only from {@link recordedSecretExpressions} and from the values of a
 * {@link RecordedSecretValues} map, both of which the resolver populates ONLY
 * on a proven-secret verdict — so the test could never answer `false`, and an
 * unfalsifiable guard reads as protection while fencing nothing. Widening
 * either candidate source is what would make it necessary again.
 */
function positionByIntrinsicSkeleton(
  bag: string,
  source: Record<string, unknown>,
  secrets: RecordedSecretValues,
  secretExpressions: ReadonlySet<string>
): string | undefined {
  // Condition 1. The empty string is excluded for the reason the value pass
  // excludes it: it is not a distinguishing value.
  if (bag === '' || !secrets.has(bag)) return undefined;

  const pattern = intrinsicSkeletonPattern(source);
  if (!pattern) return undefined;

  // Condition 3's index, built ONCE rather than re-scanned per candidate. The
  // map is keyed by plaintext, so this walks it the other way: an expression the
  // pass recorded is here against the value it actually resolved to. A collapsed
  // LOSER is absent, which is the case this function exists to serve.
  //
  // It is NOT an inversion, because `secrets` need not be injective — one
  // expression CAN appear under two plaintexts. Taking the last such plaintext
  // would WEAKEN condition 3 (the scan it replaced refused when ANY entry
  // disagreed with `bag`), so a conflicting expression is poisoned to a sentinel
  // no bag can equal, which refuses it exactly as the scan did.
  //
  // The branch is HARD to reach from the resolver — one resolver's
  // `cachedDynamicReferences` yields one plaintext per expression, so a single
  // pass cannot produce two — but it is no longer unreachable from there since
  // that cache became per-resolver (issue #1933): two resolvers in two regions
  // legitimately resolve one expression to two different plaintexts, and a
  // caller merging their maps lands exactly here. It is reachable through this
  // module's API regardless, and it is FENCED, by the "recorded against MORE
  // THAN ONE plaintext" case. An earlier draft of this comment
  // claimed the divergence was unobservable, reasoning that `plaintextOf[E] ===
  // bag` implies `secrets.get(bag) === E` so accepting and falling back agree.
  // That misses the case where a SECOND candidate also matches: accepting `E`
  // then makes it two matches, which condition 2 refuses, and the answers
  // differ. Asserting something cannot be fenced suppresses the attempt, so it
  // needs the same evidence a fence does.
  //
  // `seen === undefined` is the whole test: `RecordedSecretValues` is keyed by
  // plaintext, so iterating it never yields one plaintext twice and a second
  // sighting of an expression is always a DIFFERENT plaintext.
  const CONFLICTING = Symbol('conflicting plaintext');
  const plaintextOf = new Map<string, string | symbol>();
  for (const [plaintext, expression] of secrets) {
    plaintextOf.set(expression, plaintextOf.has(expression) ? CONFLICTING : plaintext);
  }

  let matched: string | undefined;
  for (const candidate of new Set([...secretExpressions, ...recordedSecretExpressions])) {
    if (candidate.length > MAX_SKELETON_CANDIDATE_LENGTH) return undefined;
    if (!pattern.test(candidate)) continue;
    // Condition 3.
    const recordedPlaintext = plaintextOf.get(candidate);
    if (recordedPlaintext !== undefined && recordedPlaintext !== bag) continue;
    // Condition 2.
    if (matched !== undefined) return undefined;
    matched = candidate;
  }
  return matched;
}

/**
 * Keys tried, in order, when pairing two arrays whose ORDER cannot be trusted
 * (issue #1915).
 *
 * Both are the identity field of an unordered CloudFormation list that really
 * does carry secrets: `Name` is the ECS `ContainerDefinitions[]` /
 * `Environment[]` / `Secrets[]` and CodeBuild `EnvironmentVariables[]` shape,
 * `Key` is the `Tags[]` shape the drift normalizer already keys on
 * (`canonicalizeTagListsDeep` in `src/analyzer/drift-normalize.ts`). The list
 * is deliberately SHORT: an entry is only useful when it is a genuine identity,
 * and a wrong entry costs a refused pairing rather than a wrong one (see
 * {@link identityKeyFor}), so widening it buys little and has to be justified
 * per shape.
 *
 * Worth naming rather than leaving to be rediscovered: `drift-normalize.ts`
 * deliberately moved its GENERAL case OFF heuristics like this one, onto
 * provider-DECLARED paths (`getDriftUnorderedPaths` + `matchesPathPrefix`),
 * after issue #1783 showed a heuristic claiming order-independence for a list
 * that was order-SIGNIFICANT (`KeySchema`). Only its `Tags[]` pass is still a
 * heuristic. This module diverges on purpose, because the two failure modes are
 * not comparable: there, a wrong claim SUPPRESSES real drift; here, the worst a
 * wrong pairing key can do is fail the uniqueness test and refuse, leaving the
 * leaf exactly where the value scan already had it. If that ever stops being
 * true — if a pairing gains the power to DELETE or REORDER rather than only to
 * rewrite a matched leaf — this list has to move to a declared seam too.
 */
const ARRAY_IDENTITY_KEYS = ['Name', 'Key'] as const;

/**
 * Is every element of `items` a plain object carrying a NON-EMPTY OWN string at
 * `key`, with no two elements sharing a value?
 *
 * `Object.hasOwn` for the same reason the object walk below uses it: without
 * it the prototype chain answers for a key like `constructor`, and while state
 * that came from `JSON.parse` cannot carry one, this module is called with
 * caller-constructed bags too and the two walks disagreeing is the kind of gap
 * that only shows up once something else changes.
 *
 * The empty string is excluded because it is not a distinguishing identity —
 * the same reason the value scan refuses it as a needle. Two elements both
 * carrying `Name: ''` would otherwise pair on "equality" that means nothing.
 */
function isUniquelyKeyedBy(items: readonly unknown[], key: string): boolean {
  if (items.length === 0) return false;
  const seen = new Set<string>();
  for (const item of items) {
    if (!isPlainObject(item) || !Object.hasOwn(item, key)) return false;
    const id = item[key];
    if (typeof id !== 'string' || id === '') return false;
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/**
 * Pick a key that identifies the elements of BOTH arrays, or `undefined` when
 * none does (issue #1915).
 *
 * This is what lets a leaf nested in an ARRAY be positioned on a path where
 * positional descent is refused. `descendArrays: false` is not a claim that the
 * bag and source elements are unrelated — it is a claim that their ORDER does
 * not correspond, because AWS does not preserve list order (the reason
 * `src/analyzer/drift-normalize.ts` exists). Matching by an identity FIELD
 * answers the order objection directly instead of working around it, so the
 * relaxation is sound on every rules constant and is deliberately NOT gated on
 * one.
 *
 * Requiring uniqueness WITHIN each array is what makes a pairing impossible to
 * get wrong: pairing is by string EQUALITY, so a bag element can only ever meet
 * the source element carrying the same identity, and uniqueness means there is
 * at most one of those. A key that is not really an identity (a repeated enum
 * value) fails the uniqueness test and refuses the whole pairing rather than
 * producing a plausible-looking wrong one. An element with no partner is not
 * guessed at either — it falls to the value scan, exactly as the whole array
 * did before.
 *
 * Keys are tried in {@link ARRAY_IDENTITY_KEYS} order and the FIRST one that
 * qualifies on both sides wins; a key that fails does not veto the next one.
 *
 * Two shapes this deliberately does NOT reach, stated so they are bounds rather
 * than surprises — both fail closed, leaving the leaf to the value scan:
 *
 * - **The identity field itself holds a secret.** The source element carries
 *   `{Name: '{{resolve:...}}'}` and the bag element the resolved plaintext, so
 *   the two never pair and the element's other leaves are not reached either.
 *   Closing it would mean pairing on a field whose two sides are KNOWN to
 *   differ, i.e. exactly the guessing the uniqueness rule exists to forbid. On
 *   the unchanged-resource path the value scan is also a no-op, so such a leaf
 *   keeps its plaintext — narrow (an identity field is a name, not a
 *   credential) but real.
 * - **Arrays of arrays.** `M: [[{Name, Value}]]` pairs nothing, because the
 *   OUTER elements are arrays rather than plain objects and have no identity
 *   field to key on. Positional descent into the outer list would reintroduce
 *   the order assumption this function exists to avoid.
 */
function identityKeyFor(bag: readonly unknown[], source: readonly unknown[]): string | undefined {
  for (const key of ARRAY_IDENTITY_KEYS) {
    if (isUniquelyKeyedBy(bag, key) && isUniquelyKeyedBy(source, key)) return key;
  }
  return undefined;
}

/**
 * PATH-based redaction: walk `bag` alongside a SOURCE bag that still carries the
 * unresolved `{{resolve:...}}` expressions, and wherever the source leaf is such
 * a string, persist THAT string verbatim.
 *
 * This exists because value-keyed redaction cannot answer the question at all
 * when two expressions share one resolved value (issue #1904): the map is keyed
 * by the plaintext, so the two collapse and every site is rewritten to whichever
 * expression was recorded last — state then holds an expression the template
 * does not have at that leaf, and the stack takes a permanent spurious UPDATE.
 * Position is the only disambiguator, and the source bag supplies it.
 *
 * It also covers the case where there is no secrets map to consult at all
 * (issue #1900): an UNCHANGED resource is never resolved during a deploy, so its
 * `perResourceSecrets` entry is empty, and a live readback that echoes a secret
 * would be persisted in plaintext. Projecting from the resource's OWN state
 * record — which already holds the expressions — redacts it with no secret
 * fetch and no value matching.
 *
 * A source leaf that is an intrinsic OBJECT (`Fn::Join` / `Fn::Sub`) has no
 * string to copy, so it goes through {@link positionByIntrinsicSkeleton} first
 * (issue #1916): when the intrinsic's literal parts describe exactly one of the
 * recorded secret expressions, THAT is persisted. This is the dominant CDK
 * shape — an L2 secret token renders the ARN as a `Ref`, hence a join.
 *
 * The value scan is still applied wherever neither can answer: a leaf that
 * merely EMBEDS a secret inside surrounding text, an intrinsic whose skeleton
 * matches zero or several candidates, a diverged shape, a key the source lacks.
 * So the passes are complementary rather than alternatives — path where
 * position is knowable, skeleton where the position is an intrinsic, value
 * where neither is.
 */
function redactByPath(
  bag: unknown,
  source: unknown,
  secrets: RecordedSecretValues,
  rules: PathSourceRules,
  secretExpressions: ReadonlySet<string>
): unknown {
  if (isDynamicReferenceString(source) && typeof bag === 'string') {
    // A TEMPLATE source carries PUBLIC ssm expressions too, and those must stay
    // RESOLVED in state (#1901) or the diff compares a resolved desired side
    // against a stored expression forever. A STATE source cannot hold one.
    if (
      isSingleDynamicReferenceToken(source) &&
      (rules.trustAnyExpression || isKnownSecretExpression(source, secretExpressions))
    ) {
      // ...unless the BAG leaf is ALREADY a complete token of its own and the
      // source cannot certify that it describes the same GENERATION of this
      // resource (issues #1917 / its review). Then the two are two persisted
      // answers rather than a plaintext and its reference, and overwriting one
      // with the other is how a rolled-back or not-yet-deployed reference gets
      // reported as applied — see the generation table on `PathSourceRules`.
      //
      // Falling back to a WHOLE-VALUE redaction rather than returning `bag` is
      // what makes this safe to set conservatively: a token-shaped PLAINTEXT
      // this pass resolved is a key of `secrets` and is still rewritten onto its
      // own expression, while a previous generation's EXPRESSION is not a key
      // and survives. The refusal costs nothing on the bags that were genuinely
      // resolved here.
      //
      // WHOLE-VALUE, not the full value scan, and the difference is a defect
      // this went through once: the scan's other arm rewrites a secret found as
      // a SUBSTRING, and this leaf is a complete `{{resolve:...}}` token, so a
      // short secret VALUE occurring inside it (an ssm SecureString holding
      // `prod`, against `{{resolve:secretsmanager:prod/db:SecretString:pw}}`)
      // was spliced INTO the token. That mangles a persisted expression on
      // every `cdkd scrub` over already-clean state — full map, bag of
      // expressions by construction — and the replay then re-resolves the
      // wreckage, whose `[^}]+` stops at the first `}`, into a request for a
      // bogus secret id. See the same rule in `redactSecretsForState`'s walk,
      // which is where a leaf reached with no source is bounded; both spell it
      // out so neither can be removed by editing only the other.
      //
      // While BOTH exist, `redactSecretsForState(bag, secrets)` here would be
      // byte-equivalent — the walk's own token guard makes it whole-value-only
      // for this shape — so a mutation swapping the two is an equivalent mutant
      // rather than an uncovered case. The duplication is the point: delete
      // either guard and the other still holds, and each has its own probe.
      if (!rules.sourceIsSameGeneration && isSingleDynamicReferenceToken(bag)) {
        return secrets.get(bag) ?? bag;
      }
      // The source leaf IS what state should hold — exact, and immune to two
      // expressions sharing one resolved value.
      return source;
    }
    // Public reference: keep the resolved value, but still value-scan it so a
    // secret embedded beside it is redacted.
    return redactSecretsForState(bag, secrets);
  }
  if (typeof bag === 'string' && isPlainObject(source)) {
    // The source leaf is an intrinsic OBJECT, so there is no string to copy —
    // the residual #1904 left and #1916 closes. Deliberately NOT gated on
    // `rules`: `descendArrays` is about walking a LIST, `trustAnyExpression`
    // relaxes a check this arm does not make, and `sourceIsSameGeneration` is
    // already implied — condition 1 requires the bag leaf to be a plaintext
    // THIS pass recorded, which a previous generation's persisted expression
    // can never be, so the generation hazard cannot reach here. The candidates come only from
    // stores the resolver populates on a proven-secret verdict, so none can be
    // a public ssm reference (the perpetual-UPDATE hazard of issue #1901) —
    // see `positionByIntrinsicSkeleton`'s own doc, which explains why it holds
    // NO `isKnownSecretExpression` check.
    const positioned = positionByIntrinsicSkeleton(bag, source, secrets, secretExpressions);
    if (positioned !== undefined) return positioned;
    // Fall through to the value scan below on any refusal.
  }
  if (Array.isArray(bag) && Array.isArray(source)) {
    // KEYED descent FIRST (issue #1915). It is order-independent, so it is what
    // makes a secret nested in an array reachable at all on the
    // UNCHANGED-resource path, where positional descent is refused AND the
    // value scan is a no-op (the resource was never resolved this deploy, so
    // its `perResourceSecrets` entry is empty — the #1900 shape). Without it
    // that leaf keeps its plaintext in `observedProperties` forever while
    // `properties` correctly holds the expression.
    //
    // Chosen over the other candidate direction — seeding the value scan from
    // the SOURCE bag's own expression set — because that one cannot work here:
    // a value scan needs PLAINTEXT needles, and on the unchanged path no
    // plaintext is known for this resource at all. The source contributes
    // EXPRESSIONS, so seeding from it could only over-redact by position-blind
    // masking, which would destroy the drift baseline it is trying to protect.
    // Keying restores POSITION, which is the thing that was actually missing,
    // and it answers the `descendArrays: false` rationale on its own terms
    // rather than overriding it: the objection is ORDER, and a key does not
    // depend on order.
    //
    // It runs BEFORE the positional arm, not only where positional is refused,
    // and the ordering is deliberate. `descendArrays` rests on an assumption
    // this module states but cannot enforce — see the rules doc, "every
    // `effectiveProperties` producer TODAY preserves length and order". A
    // provider that reorders an equal-length `Tags[]` satisfies the length
    // check and mis-pairs by index, while the pairing that CANNOT mis-align is
    // right here. Preferring the one with no failure mode costs a Map build on
    // a list that would have paired identically anyway.
    const key = identityKeyFor(bag, source);
    if (key !== undefined) {
      const sourceIndexById = new Map<string, number>();
      source.forEach((item, i) => {
        sourceIndexById.set((item as Record<string, unknown>)[key] as string, i);
      });
      // `-1` marks a bag element whose identity the source does not carry.
      //
      // The casts are safe because `identityKeyFor` has already verified BOTH
      // sides: every element is a plain object with an OWN non-empty string at
      // `key`, unique within its array. Nothing structural ties the two, so if
      // that validation is ever relaxed these casts have to be revisited with
      // it.
      let orderPreserved = true;
      const partnerIndex = bag.map((item, i) => {
        const j = sourceIndexById.get((item as Record<string, unknown>)[key] as string);
        if (j === undefined) return -1;
        if (j !== i) orderPreserved = false;
        return j;
      });

      // An UNPAIRED element is guessed at positionally exactly when positional
      // descent would have been EXACT for the whole array anyway: the bag was
      // produced by resolving the source (`descendArrays`), the lengths agree,
      // and every pairing that DID happen sits at its own index — the last
      // being the check that the order assumption actually HELD here rather
      // than being assumed. Under those three, `source[i]` is necessarily
      // unclaimed for an unpaired `i` (any other bag element pairing with it
      // would have to sit at index `i` itself), so this cannot hand two bag
      // elements the same partner.
      //
      // The invariant is: keying must never pre-empt a positional descent that
      // would have been exact. Without this, keying ONE element pre-empted the
      // positional arm for ALL of them, and an unpaired leaf dropped to the
      // value scan — which on a colliding pair writes a SIBLING's expression,
      // the #1910 wrong-reference class, on a path (`STATE_DERIVED_RULES`, the
      // replay) that then applies it to AWS.
      //
      // When those three do NOT hold, an unpaired element falls to the value
      // scan and stays there. That is deliberate: on the UNCHANGED-resource
      // path (`descendArrays: false`, issue #1900) the value scan has no
      // needles at all, so refusing the whole array until EVERY element pairs
      // would let one AWS-added element un-redact the secrets that did pair —
      // the exact case issue #1915 exists to fix.
      //
      // Note there is no separate "did anything pair at all" gate, and its
      // absence is load-bearing rather than an omission. ZERO pairings means
      // the two sides are keyed on DISJOINT identities (a provider normalising
      // `Name` / `Key` in its `effectiveProperties`), and that case must not
      // pre-empt positional descent — but it no longer can: with no pairings
      // `orderPreserved` is vacuously true, so `positionalIsExact` reduces to
      // the positional arm's own condition and every element takes `source[i]`,
      // which is what falling through would have done. An earlier draft carried
      // an explicit `paired > 0` gate beside this; once the positional fallback
      // landed the gate became unreachable, and a guard that cannot change an
      // answer reads as protection while fencing nothing.
      const positionalIsExact =
        rules.descendArrays && bag.length === source.length && orderPreserved;
      return bag.map((item, i) => {
        const j = partnerIndex[i]!;
        if (j >= 0) return redactByPath(item, source[j], secrets, rules, secretExpressions);
        if (positionalIsExact) {
          return redactByPath(item, source[i], secrets, rules, secretExpressions);
        }
        return redactSecretsForState(item, secrets);
      });
    }
    if (rules.descendArrays && bag.length === source.length) {
      // No identity field on either side (a list of plain strings, a list of
      // objects with no `Name` / `Key`). Positional descent is sound here ONLY
      // because the bag was produced by resolving the source. An AWS readback
      // may be REORDERED, so that kind does not take this arm at all and falls
      // to the value scan rather than writing an expression onto a wrong
      // element.
      return bag.map((item, i) => redactByPath(item, source[i], secrets, rules, secretExpressions));
    }
  }
  if (isPlainObject(bag) && isPlainObject(source)) {
    // `Object.create(null)` (issue #1943's class): `JSON.parse` of an AWS
    // readback can produce an OWN `__proto__` key, and `out[k] = ...` on a
    // normal object invokes the prototype setter instead of defining it — so
    // the key would be silently dropped from the persisted bag and read as
    // phantom drift ever after.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(bag)) {
      // `Object.hasOwn`, not `k in source`: the prototype chain would answer for
      // `constructor` / `toString` and hand the walk a function as the source.
      out[k] = Object.hasOwn(source, k)
        ? redactByPath(v, source[k], secrets, rules, secretExpressions)
        : redactSecretsForState(v, secrets);
    }
    return out;
  }
  // Shapes diverged (an array whose length changed, a scalar where the source
  // has an object, a key the source lacks): fall back to the value scan, which
  // is strictly better than leaving the subtree unredacted.
  return redactSecretsForState(bag, secrets);
}

/**
 * Is this rules constant one whose BAG is an AWS readback and whose SOURCE is a
 * persisted STATE bag?
 *
 * Today that is {@link STATE_SOURCED_READBACK_RULES} alone: the path where the
 * secrets map can be EMPTY by construction (nothing was resolved), so the value
 * scan has no needles and POSITION is the only mechanism left. Derived from the
 * flags rather than compared against the constant so a future one with the same
 * shape is covered automatically. `trustAnyExpression` says the source is a
 * persisted record (holding no PUBLIC reference, so any `{{resolve:...}}` in it
 * is by construction a secret); `!descendArrays` says the bag came back from
 * AWS and may be reordered.
 *
 * `sourceIsSameGeneration` is the third conjunct and it is the one that took a
 * measurement to get right. Without it this also selected
 * {@link STATE_SOURCED_CROSS_GENERATION_RULES} — `cdkd scrub`'s observed walk,
 * whose `properties` have ALREADY been repositioned onto TODAY's template — and
 * taking a source subtree there rewrote a baseline holding the DEPLOYED
 * `:AWSPREVIOUS` reference onto the template's edited `:AWSCURRENT` one. That
 * is precisely the issue #1917 hazard, and `cdkd drift --revert` pushes the
 * baseline to AWS, so it would have applied a reference the stack never
 * deployed. A refusal may only take a source that is the same generation as the
 * bag beside it.
 *
 * A TEMPLATE-sourced caller is deliberately excluded: its source can carry a
 * public `ssm:` reference whose resolved value must STAY resolved (issue
 * #1901), and it always has a populated map, so the value scan already covers
 * the shapes below. So is the rollback replay
 * ({@link STATE_DERIVED_RULES}) — full map, and its bag descends positionally
 * because it was produced by resolving the source.
 */
function isReadbackProjectedFromState(rules: PathSourceRules): boolean {
  return rules.trustAnyExpression && !rules.descendArrays && rules.sourceIsSameGeneration;
}

/**
 * Does this subtree carry a dynamic reference anywhere?
 *
 * A BOOLEAN, not the occurrence COUNTS an earlier revision collected. The
 * counts existed to decide whether a bag "covered" every reference its source
 * carried, which was the vouching rule for taking a source array wholesale —
 * and that rule is gone (see the array arm), so counting would be a
 * measurement nothing reads.
 */
function subtreeHasDynamicReference(value: unknown): boolean {
  if (isDynamicReferenceString(value)) return true;
  if (Array.isArray(value)) return value.some(subtreeHasDynamicReference);
  if (isPlainObject(value)) return Object.values(value).some(subtreeHasDynamicReference);
  return false;
}

/** Every complete `{{resolve:...}}` token inside a string. */
function dynamicReferenceTokens(value: string): string[] {
  return value.match(/\{\{resolve:[^{}]*\}\}/g) ?? [];
}

/**
 * Does this MIXED leaf embed a reference that may be PUBLIC config?
 *
 * A plain `{{resolve:ssm:...}}` is classified by the parameter's TYPE, not by
 * its spelling (issue #1901): a `String` / `StringList` parameter is public and
 * is legitimately persisted RESOLVED. Substituting the expression over it gives
 * the drift baseline a value AWS does not hold, which is phantom drift on
 * ordinary config — and `--revert` then pushes the literal expression.
 *
 * `trustAnyExpression` is what would otherwise wave this through, and its
 * premise ("a persisted STATE bag holds no public expression") is documented as
 * FALSE in one place: `cdkd import`'s warn path can leave one there. The
 * whole-token arm accepts that risk knowingly and `cdkd drift --accept`
 * re-checks its write; the MIXED arm added later has no such re-check, so it
 * declines instead.
 *
 * A reference the resolver RECORDED as secret is kept: that is the ssm
 * `SecureString` case, where the verdict came off the same `GetParameter`
 * response that carried the value. `{{resolve:ssm-secure:` does not match this
 * prefix at all (the next character is `-`), so it is never refused here.
 *
 * The verdict store only carries signal where something RESOLVED, so this
 * splits on whether a secrets map exists at all.
 *
 * WITH a map, a pass resolved this bag: the engine's change detection walks
 * every template property with `skipDynamicReferences`, which only flips
 * `decrypt` on the ssm branch — the `GetParameter` still runs, a definitive
 * `SecureString` is recorded, and a parameter that comes back public has its
 * memo RETRACTED. Absence from the store is then real evidence of a public
 * parameter, and the resolved value is kept.
 *
 * WITHOUT one, absence means only that the question was never asked HERE. It
 * does not mean nothing was resolved: the deploy path resolves every template
 * property with `skipDynamicReferences`, which records or retracts the
 * `SecureString` verdict even for an UNCHANGED resource -- that bag simply is
 * not the one this call receives. The leaf is treated as
 * secret-bearing and refused. That is not merely the cautious branch, it is the
 * SAME premise the whole-token arm one level up already acts on: a PUBLIC
 * `String` / `StringList` reference is persisted RESOLVED (issue #1901), so a
 * `{{resolve:ssm:` token that SURVIVES in a persisted state bag is a
 * SecureString by construction. An earlier revision applied a stricter rule to
 * a MIXED leaf than to a whole token on the identical source, and that
 * inconsistency is what persisted a decrypted secret.
 *
 * ACCEPTED CONSEQUENCE, recorded rather than papered over: on the empty-map
 * paths a genuinely PUBLIC ssm mixed leaf is now OVER-redacted, so the baseline
 * no longer matches AWS and `cdkd drift` reports a phantom on it. That is
 * reachable only through the one documented hole in the premise above — `cdkd
 * import`'s warn path, which can leave a public expression in state. The trade
 * is deliberate and asymmetric: under-redaction persists a decrypted secret,
 * which is a disclosure and is what this lane exists to prevent, while
 * over-redaction is visible, recoverable and discloses nothing. Closing it
 * properly needs a real TYPE classification on these paths, which is issue
 * [#2012](https://github.com/go-to-k/cdkd/issues/2012)'s mechanism; the
 * over-redaction itself is tracked as issue
 * [#2036](https://github.com/go-to-k/cdkd/issues/2036).
 *
 * `tests/integration/secrets-dynamic-ref` is the end-to-end proof on BOTH
 * paths, and it is the only place the empty-map defect surfaced: Phase 1g
 * covers the populated-map deploy and Phase 1f the empty-map command.
 */
function mixedLeafMayCarryPublicReference(source: string, secrets: RecordedSecretValues): boolean {
  // NO MAP, NO EVIDENCE — so this cannot answer, and it must not pretend to.
  // `isRecordedSecretExpression` only ever says "yes" about a token some pass
  // RESOLVED, and the empty-map paths resolve nothing by construction (issue
  // #1926's own design decision). Reading absence as "public" there turned
  // every `{{resolve:ssm:` mixed leaf into a public one and persisted the
  // DECRYPTED SecureString — measured by the `secrets-dynamic-ref` integ, which
  // is the only place it showed: every unit assertion passed.
  if (secrets.size === 0) return false;
  return dynamicReferenceTokens(source).some(
    (token) => token.startsWith('{{resolve:ssm:') && !isRecordedSecretExpression(token)
  );
}

/**
 * Refuse to persist a readback leaf the path pass could not CERTIFY, at any
 * position the STATE source proves is secret-bearing (issue #1926 review).
 *
 * {@link redactByPath} substitutes only where the source leaf is a WHOLE
 * `{{resolve:...}}` token. On the paths {@link isReadbackProjectedFromState}
 * selects the secrets map may be EMPTY, so its value-scan fallback is a no-op,
 * and four shapes reached `state.json` holding the DECRYPTED value. Measured
 * against this module before this pass existed — three by `cdkd state
 * refresh-observed`, and the same three by a plain `cdkd deploy`, whose
 * `drainObservedCaptures` baseline reaches the persist choke point with exactly
 * this configuration. `cdkd scrub` is NOT one of them: its observed walk is
 * CROSS-generation, so {@link isReadbackProjectedFromState} excludes it by
 * design:
 *
 * ```text
 *   source leaf in the STATE record                  before        now
 *   -----------------------------------------------  ------------  ---------------
 *   `postgres://u:{{resolve:...}}@h` (MIXED string)   LEAK          take source
 *   ...the same MIXED leaf inside a PAIRED element    LEAK          take source
 *   `['--pw', '{{resolve:...}}']` (no identity key)   LEAK          LEAK (#2012)
 *   `[{Field, Val: '{{resolve:...}}'}]` (no `Name`)   LEAK          LEAK (#2012)
 *   an UNPAIRED element beside a paired one           LEAK          LEAK (#2012)
 *   an observed KEY the source does not carry         LEAK          LEAK (#2012)
 *   whole `{{resolve:...}}` token                     ok            ok
 *   `Environment[]` keyed by `Name` (issue #1915)     ok            ok
 *   PUBLIC ssm MIXED leaf, POPULATED map               ok            ok
 *   PUBLIC ssm MIXED leaf, EMPTY map                   ok            over-redacts
 * ```
 *
 * The last row is the price of the row above it and is tracked as issue
 * [#2036](https://github.com/go-to-k/cdkd/issues/2036): with no map nothing was
 * resolved, so nothing distinguishes a public parameter from a `SecureString`
 * and the leaf is refused. Phantom drift, not a disclosure — see
 * {@link mixedLeafMayCarryPublicReference} for why that is the right way to be
 * wrong here.
 *
 * What this pass closes is the row POSITION can actually justify: a leaf whose
 * KEY the source carries, where the source is the same generation and the only
 * thing the older code lacked was the willingness to substitute a leaf that was
 * not a WHOLE token. Everything it takes is the record's own value at the
 * record's own path.
 *
 * The four residual rows are one root cause, not four: no needle and no
 * position, so nothing distinguishes a resolved secret from an ordinary
 * literal. They are NOT closed by taking the source subtree, which an earlier
 * revision did and the issue #1915 fences correctly rejected — measured, it
 * rewrote `{Name:'', Value:'an-unrelated-literal'}` onto the expression and
 * turned an AWS-reported `[{Value:'x'}]` into `[{Name:'db', Value:<expr>}]`,
 * fabricating drift-baseline content AWS never reported that `cdkd drift
 * --revert` then pushes to the live resource. Redaction may not buy itself a
 * fabricated baseline.
 *
 * The MIXED row is the shape this module itself calls DOMINANT for CDK — an
 * `Fn::Join` around `secret.secretValueFromJson(...)`.
 *
 * TAKE SOURCE rather than a {@link SECRET_MASK} on the rows it does close, for
 * the same reason the whole-token arm does: a mask is not a value `cdkd drift`
 * can re-resolve, so it would report a permanent phantom — and `cdkd drift
 * --revert` pushes the BASELINE to AWS, so a masked baseline would write the
 * literal `***` onto the live resource (the issue #1498 / #1501 class).
 *
 * KNOWN RESIDUAL, the last row: an observed KEY the source object does not
 * carry has no source leaf to take and no needle to match. It is NOT refused
 * the way an unpaired array ELEMENT is, and the asymmetry is deliberate rather
 * than an oversight — an extra array element is a PEER of the secret-bearing
 * ones (another `Environment` entry), so suspicion is warranted and extras are
 * rare, while an extra object KEY is a different FIELD entirely (`Runtime`,
 * `FunctionArn`, `LastModified`) and is the NORM in an AWS readback. Refusing
 * those would empty the drift baseline of every secret-bearing resource.
 * Tracked as issue [#2012](https://github.com/go-to-k/cdkd/issues/2012).
 */
function refuseUncertifiedReadbackPositions(
  bag: unknown,
  source: unknown,
  secrets: RecordedSecretValues
): unknown {
  // The string arm, and BOTH of its guards were added after review measured
  // what their absence did.
  //
  // `typeof bag === 'string'` mirrors the sibling test in `redactByPath`, and
  // it is load-bearing rather than defensive: without it a source leaf of
  // `{{resolve:...}}` whose BAG is a container returned the scalar string,
  // turning `{Foo: {a: 1}}` into `{Foo: '{{resolve:...}}'}` — fabricating a
  // baseline AWS never reported, which is the exact thing this function refuses
  // to do at its own bottom and the principle this pass was built on. It is
  // reachable whenever a provider structures a leaf the template spells as a
  // reference, and the result is permanent phantom drift plus a `--revert` that
  // writes a string where AWS holds an object. With the guard, such a leaf
  // falls to the shape-divergence fallback and the bag is kept.
  //
  // NOT a no-op short-circuit, which an earlier revision of this comment
  // claimed: the fallback returns `bag`, so deleting this arm changes the
  // answer rather than reproducing it. (That claim WAS true when the fallback
  // still returned the source, and it stopped being true when the fallback was
  // narrowed. A comment asserting equivalence has to be re-measured whenever
  // either side moves.)
  if (isDynamicReferenceString(source) && typeof bag === 'string') {
    // A WHOLE token: `redactByPath` already decided this leaf, and returning
    // the source agrees with it.
    if (isSingleDynamicReferenceToken(source)) return source;
    // A MIXED leaf embedding something that may be PUBLIC config: keep the
    // resolved value AWS actually holds. See the predicate's own doc.
    if (mixedLeafMayCarryPublicReference(source, secrets)) return bag;
    return source;
  }
  // Nothing to protect in this subtree — return the bag by identity, which is
  // what keeps an ordinary readback (and any AWS-added element in it) intact.
  if (!subtreeHasDynamicReference(source)) return bag;
  if (isPlainObject(bag) && isPlainObject(source)) {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(bag)) {
      // `Object.hasOwn` rather than `k in source` keeps this walk consistent
      // with the two beside it; unlike there, no test can pin the difference —
      // both arms of this one return a value rather than a function, so a
      // prototype hit would produce the same output. Consistency is the whole
      // claim being made here.
      out[k] = Object.hasOwn(source, k)
        ? refuseUncertifiedReadbackPositions(v, source[k], secrets)
        : // The residual documented above: no source leaf, no needle.
          v;
    }
    return out;
  }
  if (Array.isArray(bag) && Array.isArray(source)) {
    // DESCEND ONLY. An element that pairs by identity (issue #1915) is walked
    // so a MIXED leaf inside it is still refused; an element that does NOT pair
    // is returned untouched.
    //
    // An earlier revision of this pass instead took the SOURCE array wholesale
    // whenever it could not vouch for the bag, which closed two more leak
    // shapes and was WRONG — the existing issue #1915 fences caught it, and
    // they are right. Measured, it rewrote `{Name:'', Value:'an-unrelated-
    // literal'}` into `Value: <expression>` (a FALSE redaction of a value that
    // was never a secret) and turned an AWS-reported `[{Value:'x'}]` into
    // `[{Name:'db', Value:<expression>}]` — fabricating baseline content AWS
    // never reported, which `cdkd drift --revert` then pushes to the live
    // resource. That is the issue #1917 / #1498 class this module already
    // refuses to commit elsewhere.
    //
    // So an UNPAIRABLE array keeps its plaintext, and that is a genuine
    // residual rather than an oversight: with an empty secrets map there is no
    // needle, and with no identity there is no position, so nothing can
    // distinguish a resolved secret from an ordinary literal. It is the
    // array-shaped twin of the unpaired-KEY residual below and is tracked with
    // it in issue [#2012](https://github.com/go-to-k/cdkd/issues/2012).
    const key = identityKeyFor(bag, source);
    if (key === undefined) return bag;
    const sourceByIdentity = new Map<string, unknown>();
    for (const item of source) {
      sourceByIdentity.set((item as Record<string, unknown>)[key] as string, item);
    }
    return bag.map((item) => {
      const partner = sourceByIdentity.get((item as Record<string, unknown>)[key] as string);
      return partner === undefined
        ? item
        : refuseUncertifiedReadbackPositions(item, partner, secrets);
    });
  }
  // Shapes diverged (a scalar where the source has a container, or the reverse)
  // while the source subtree still carries a reference. The bag is returned
  // UNCHANGED for the same reason the unpairable array is: substituting the
  // source here would fabricate a baseline AWS never reported. The one shape
  // that IS substituted is the string leaf at the top of this function, where
  // the position is exact and the source is the same generation.
  return bag;
}

/**
 * Deep-clone `bag`, replacing every occurrence of a recorded secret value with
 * the unresolved `{{resolve:...}}` expression it came from. A string whose WHOLE
 * value equals a secret is replaced by that secret's expression exactly; a
 * string that merely CONTAINS one (an `Fn::Join` / `Fn::Sub` result) has the
 * secret substring replaced in place. Returns the input by identity when there
 * is nothing to redact, so callers can persist the original object unchanged in
 * the common no-secret case.
 */
export function redactSecretsForState<T>(
  bag: T,
  secrets: RecordedSecretValues,
  source?: unknown,
  rules: PathSourceRules = TEMPLATE_DERIVED_RULES
): T {
  // The PATH pass runs even with no recorded secrets — that is the whole point
  // for an UNCHANGED resource, whose `perResourceSecrets` entry is empty
  // because it was never resolved this deploy (issue #1900).
  if (secrets.size === 0 && source === undefined) return bag;
  if (source !== undefined) {
    const positioned = redactByPath(bag, source, secrets, rules, new Set(secrets.values()));
    // The path pass certifies a WHOLE-TOKEN source leaf and nothing else, so on
    // the readback paths — where the map can be empty and the value scan is a
    // no-op — a MIXED leaf or an unpairable array still held plaintext. Every
    // caller of those paths inherits the refusal from here rather than
    // spelling it at the call site: `cdkd state refresh-observed`, the deploy's
    // own `drainObservedCaptures` baseline (through `scrubResourceRecord` at
    // the persist choke point), and any future one.
    //
    // NOT `cdkd scrub`: its observed walk passes
    // `STATE_SOURCED_CROSS_GENERATION_RULES`, whose `sourceIsSameGeneration:
    // false` makes the gate above return false. That is deliberate — scrub has
    // already repositioned `properties` onto TODAY's template — and it is
    // stated here because two earlier revisions of this comment listed scrub as
    // an inheritor, which the gate contradicts one screen away.
    return (
      isReadbackProjectedFromState(rules)
        ? refuseUncertifiedReadbackPositions(positioned, source, secrets)
        : positioned
    ) as T;
  }
  const regex = buildNeedleRegex(secrets.keys());
  // Even below the needle threshold, a NON-EMPTY whole-value match must still be
  // redacted. An empty-string secret is never a needle (it would match every
  // empty leaf and corrupt unrelated properties); a resolved secret of '' is
  // degenerate and the resolver does not record one.
  const wholeValueExpr = (s: string): string | undefined => (s === '' ? undefined : secrets.get(s));

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const whole = wholeValueExpr(value);
      if (whole !== undefined) return whole;
      // A leaf that is ALREADY a complete `{{resolve:...}}` token is an
      // EXPRESSION, not text that might embed a secret, so the substring arm
      // below must not touch it. Without this a recorded secret VALUE that
      // happens to occur inside the token's own text — a SecureString parameter
      // holding `prod`, inside
      // `{{resolve:secretsmanager:prod/db:SecretString:pw}}` — is spliced into
      // the reference, corrupting a persisted expression into one no service
      // can resolve. Reached with no source on the journal's `previousState`
      // walk and on `attributes`, so it is not reachable only through the
      // path pass.
      if (isSingleDynamicReferenceToken(value)) return value;
      if (!regex) return value;
      regex.lastIndex = 0;
      if (!regex.test(value)) return value;
      regex.lastIndex = 0;
      return value.replace(regex, (m) => secrets.get(m) ?? SECRET_MASK);
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value !== null && typeof value === 'object') {
      // Null-prototype for the same reason the path walk uses one: an own
      // `__proto__` key must land as DATA, not on the prototype.
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v);
      }
      return out;
    }
    return value;
  };

  return walk(bag) as T;
}

/**
 * Redact resolved secret plaintext out of one resource state record's
 * `properties` / `attributes` / `observedProperties`, replacing each secret
 * value with its unresolved expression. Returns a NEW record when any field
 * changed, or the input by identity when there are no secrets — so callers can
 * detect a no-op cheaply. Shared by the deploy engine's save choke point and
 * the `cdkd scrub` command so both scrub the same three fields identically.
 *
 * `observedRules` overrides the rules the `observedProperties` walk would
 * otherwise DERIVE from whether a `sourceProperties` bag was supplied. Exactly
 * one caller needs it and the reason is not obvious, so it is a parameter
 * rather than another derivation: `cdkd scrub` has already repositioned
 * `properties` against TODAY's template by the time it calls this, so the
 * "record's own properties" this walk falls back to are no longer the same
 * GENERATION as the observed bag beside them (issue #1917 review). Left
 * unspecified, the derivation below is right for every other caller, whose
 * `properties` reach this function untouched.
 */
export function scrubResourceRecord<
  T extends {
    properties: Record<string, unknown>;
    attributes?: Record<string, unknown>;
    observedProperties?: Record<string, unknown>;
  },
>(
  record: T,
  secrets: RecordedSecretValues,
  sourceProperties?: Record<string, unknown>,
  observedRules?: PathSourceRules
): T {
  // NOT `sourceProperties === undefined`: an UNCHANGED resource has neither a
  // secrets map nor a template bag, and its observed bag is exactly what needs
  // redacting (issue #1900) — so an early return gated on those two alone made
  // that half dead code.
  if (secrets.size === 0 && sourceProperties === undefined && !record.observedProperties) {
    return record;
  }
  const next = { ...record };
  next.properties = redactSecretsForState(record.properties, secrets, sourceProperties);
  if (record.attributes) next.attributes = redactSecretsForState(record.attributes, secrets);
  if (record.observedProperties) {
    // `observedProperties` is a live AWS readback, so its OWN source of truth is
    // the record's (already redacted) `properties` — a member whose stored value
    // is an expression must not be overwritten by the plaintext AWS echoes back
    // (issue #1900). When a `sourceProperties` bag was supplied it is the
    // template, which is the better source; otherwise fall back to the record's
    // own properties, which is what makes an UNCHANGED resource redactable at
    // all.
    // `next.properties`, not `record.properties`: the just-redacted bag is the
    // one that actually holds expressions. On the `cdkd scrub` path the original
    // is still plaintext, so using it would degrade this to the value scan.
    // The RULES differ by which source we ended up with, which is the whole
    // point of them being separate flags: a TEMPLATE source carries public ssm
    // expressions (so no blanket trust) and is a different generation from this
    // bag (so it may not overwrite a leaf that already holds an expression),
    // while the record's own untouched properties are neither (so the #1900
    // no-secrets-map path works). Neither descends arrays POSITIONALLY, because
    // this bag came back from AWS and AWS does not preserve list order — both
    // still descend by an element IDENTITY KEY, which is order-independent
    // (issue #1915).
    //
    // `observedRules` wins when the caller supplied one, because a caller can
    // know something this derivation cannot: that it already MOVED
    // `next.properties` to another generation. See the parameter's doc.
    next.observedProperties = redactSecretsForState(
      record.observedProperties,
      secrets,
      sourceProperties ?? next.properties,
      observedRules ??
        (sourceProperties === undefined ? STATE_SOURCED_READBACK_RULES : TEMPLATE_SOURCED_RULES)
    );
  }
  return next;
}

/**
 * Replace every recorded secret value inside `text` with {@link SECRET_MASK}.
 * Used on log lines and error messages where a resolved secret could otherwise
 * be echoed. Whole-value and embedded matches are both masked. Returns `text`
 * unchanged when there is nothing to mask.
 */
export function maskSecretsInText(text: string, secrets: RecordedSecretValues): string {
  if (secrets.size === 0) return text;
  // Whole-value masking first (covers below-threshold secrets that are the
  // entire string), then substring masking for the rest. An empty-string secret
  // is never matched (it would mask every empty string).
  if (text !== '' && secrets.has(text)) return SECRET_MASK;
  const regex = buildNeedleRegex(secrets.keys());
  if (!regex) return text;
  return text.replace(regex, SECRET_MASK);
}

/**
 * How deep {@link maskSecretsInError} follows a `cause` chain. A CYCLE is
 * already handled by the visited-set, so this bounds only a pathologically long
 * chain; the same bounded-walk shape `extractDeploymentEventError` (depth 10)
 * and the retry classifiers (depth 5) use. A link BEYOND the cap keeps its
 * original, UNMASKED message, and the last cloned link points at it.
 */
const ERROR_CAUSE_MASK_MAX_DEPTH = 20;

/**
 * The `cause` chain of `root`, root first, stopping at the first non-`Error`
 * link, at a link already visited (so a cycle terminates instead of hanging),
 * or at {@link ERROR_CAUSE_MASK_MAX_DEPTH}.
 */
function errorCauseChain(root: Error): Error[] {
  const chain: Error[] = [];
  const seen = new Set<Error>();
  let current: unknown = root;
  while (
    current instanceof Error &&
    !seen.has(current) &&
    chain.length < ERROR_CAUSE_MASK_MAX_DEPTH
  ) {
    seen.add(current);
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * Return `error` with {@link maskSecretsInText} applied to the `message` AND the
 * `stack` of every link in its `cause` chain, with everything else about each
 * link preserved (issue [#2038](https://github.com/go-to-k/cdkd/issues/2038)
 * review).
 *
 * Two bounds on that "every link", both stated here because the PUBLIC contract
 * is what a caller reads and neither is visible from the call site:
 * - The walk stops at {@link ERROR_CAUSE_MASK_MAX_DEPTH}. A chain longer than
 *   that keeps its remaining links' ORIGINAL, UNMASKED messages, and the last
 *   cloned link points straight at them.
 * - A `cause` that is not an `Error` (a string, a plain object) is carried
 *   through VERBATIM and is never masked — the walk has nothing to clone. No
 *   cdkd or AWS SDK site constructs one today, so this is a documented residual
 *   rather than a reachable leak, but a caller attaching arbitrary data as a
 *   `cause` must mask it itself. `src/cli/index.ts`'s `console.error` renders
 *   such a cause via `util.inspect`, so it WOULD reach the terminal.
 *
 * **Why an error and not just its text.** `formatError` (`src/utils/error-handler.ts`)
 * renders a `CdkdError`'s CAUSE as `Caused by: <cause.message>`, and `handleError`
 * logs that at `error` level for any failure that escapes a command — so a raw
 * provider error attached as a `ProvisioningError`'s cause reaches the terminal
 * verbatim, at DEFAULT verbosity, even when every log site that INTERPOLATED
 * the message masked it. Masking the string at each log site cannot close that:
 * the sink reads the error OBJECT.
 *
 * `formatError` is not the only such sink, and the second one is what makes the
 * CHAIN argument below concrete rather than hypothetical: `src/cli/index.ts`'s
 * top-level `main().catch(...)` does `console.error('Fatal error:', error)`,
 * which renders the whole object through `util.inspect` — every `[cause]` link
 * AND every link's `stack`. Measured: an outer `Error('top')` wrapping
 * `Error("Value 'hunter2' failed")` prints as
 * `Error: top ... { [cause]: Error: Value 'hunter2' failed ... }`. So a
 * multi-level sink exists TODAY, and it is why `stack` is masked below rather
 * than merely preserved.
 *
 * **Why the whole CHAIN and not just the top link.** Masking only `error.message`
 * looks sufficient because `formatError` renders one level — and it is not, in
 * two ways that a top-level-only fix gets exactly backwards. A provider that
 * wraps an AWS failure in a generic sentence (`new Error('the call failed',
 * { cause: awsError })`) leaves the plaintext ONE link down, where the
 * identity-return below then reports "nothing to mask" and hands back an object
 * still carrying it — the function's own contract says the returned error is
 * safe to render, and every later reader believes it. And `formatError`
 * rendering a single level is an implementation detail: one edit there (walking
 * the chain is the obvious improvement) re-opens the hole with nothing failing.
 * So the invariant is about the OBJECT, not about today's renderer.
 *
 * **Why a clone rather than assigning to `error.message`.** The argument is an
 * error cdkd did not create — usually the AWS SDK's — and mutating a caller's
 * object is visible to every other holder of it, including a retry loop that
 * may still classify it. Each link's clone copies the prototype and EVERY own
 * property descriptor, symbols included, so the three things that read a cause
 * chain keep working: `isMarkedNonRetryable` (a non-enumerable `Symbol.for`
 * marker), `extractDeploymentEventError` / `isThrottlingError` /
 * `isTransientServerError` (`$metadata`, `Code`, `name`), and the chain itself.
 * `Object.assign` would have dropped the marker, which is why the descriptors
 * form is used.
 *
 * `message`, `cause` and `stack` are the three descriptors deliberately NOT
 * copied through: each is re-defined per link, and copying a NON-CONFIGURABLE
 * original would make that re-definition throw. `cause` is rewired to the CLONE
 * of whatever it pointed at, in a second pass over the already-built clone map —
 * which is what makes a cyclic chain terminate rather than recurse. A `cause`
 * that is not an `Error` (a string, a plain object) keeps its original
 * descriptor verbatim.
 *
 * **Why `stack` is re-defined as DATA rather than copied.** V8 installs `stack`
 * as an own ACCESSOR whose getter reads a slot the engine attaches to an error
 * IT created, so copying that descriptor onto an `Object.create` clone yields a
 * getter with nothing behind it and `clone.stack` reads `undefined` (measured).
 * That is not a leak today — the clone is only ever reached as a `cause`, and
 * `handleError` prints the TOP-level error's stack — but this function is
 * exported and generic, so a future top-level caller would get back an error
 * with no trace at all. The clone therefore carries a masked COPY of the
 * original's stack text, which both preserves the trace and closes the sink the
 * copy would otherwise open: a stack's first line embeds the message, so an
 * unmasked stack re-exposes exactly the plaintext the `message` mask removed —
 * and `util.inspect` prints it. An original with no readable string `stack`
 * (not an engine-created error) simply gets no own `stack`, as before.
 *
 * Returns the ORIGINAL object by identity when NOTHING ANYWHERE IN THE CHAIN
 * changed, so a non-secret failure keeps referential equality and the common
 * path allocates nothing.
 */
export function maskSecretsInError<T>(error: T, secrets: RecordedSecretValues): T {
  if (secrets.size === 0 || !(error instanceof Error)) return error;
  const chain = errorCauseChain(error);
  const maskedMessages = chain.map((link) => maskSecretsInText(link.message, secrets));
  if (maskedMessages.every((masked, i) => masked === chain[i]!.message)) return error;

  const clones = new Map<Error, Error>();
  for (const [i, original] of chain.entries()) {
    // `Reflect.ownKeys` rather than `Object.getOwnPropertyDescriptors` + delete:
    // the latter's return type has a REQUIRED index signature, so removing the
    // two keys re-defined below would need a cast. Symbols are included, which
    // is what carries `markNonRetryable`'s marker.
    const descriptors: Record<PropertyKey, PropertyDescriptor> = {};
    for (const key of Reflect.ownKeys(original)) {
      if (key === 'message' || key === 'cause' || key === 'stack') continue;
      const descriptor = Object.getOwnPropertyDescriptor(original, key);
      if (descriptor) descriptors[key] = descriptor;
    }
    const clone = Object.create(Object.getPrototypeOf(original) as object, descriptors) as Error;
    Object.defineProperty(clone, 'message', {
      value: maskedMessages[i]!,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    // Read through the accessor rather than copying its descriptor — see the
    // `stack` paragraph above. `typeof` rather than a truthiness test: an empty
    // stack string is a legitimate (if useless) trace and copying it changes
    // nothing, while a non-string means this object is not an engine-created
    // error and has no trace to carry.
    const originalStack: unknown = (original as { stack?: unknown }).stack;
    if (typeof originalStack === 'string') {
      Object.defineProperty(clone, 'stack', {
        value: maskSecretsInText(originalStack, secrets),
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    clones.set(original, clone);
  }
  for (const original of chain) {
    const causeDescriptor = Object.getOwnPropertyDescriptor(original, 'cause');
    if (!causeDescriptor) continue;
    const clone = clones.get(original)!;
    const causeValue = (original as { cause?: unknown }).cause;
    const replacement = causeValue instanceof Error ? clones.get(causeValue) : undefined;
    Object.defineProperty(
      clone,
      'cause',
      replacement
        ? {
            value: replacement,
            writable: true,
            // `=== true` rather than the raw field: under
            // `exactOptionalPropertyTypes` a descriptor's `enumerable` types as
            // `boolean | undefined`, and a real descriptor always has one.
            enumerable: causeDescriptor.enumerable === true,
            configurable: true,
          }
        : causeDescriptor
    );
  }
  return clones.get(error) as T;
}

/**
 * A caller-supplied capability that masks any secret this deploy resolved out
 * of an arbitrary string (issue #1932 item 3).
 *
 * This is the PROVIDER-FACING half of {@link maskSecretsInText}. Masking has
 * historically lived at two boundaries only — the deploy engine's error /
 * reason text and the resolver's own debug line — so a provider that
 * interpolates a RESOLVED property value into its own `logger.warn` sat
 * outside all of it. A provider cannot close that itself: `maskSecretsInText`
 * needs a {@link RecordedSecretValues} bag, and a provider has no way to reach
 * the one its caller's resolution pass produced.
 *
 * **Why a FUNCTION and not the bag itself.** The bag was the obvious threading
 * and was rejected on four counts:
 *
 * 1. **Precedent.** The codebase already answers "the callee needs masked
 *    output" by injecting the masked capability rather than the secrets:
 *    `src/cli/commands/drift.ts` hands `withRetry` a
 *    `{ logger: { debug: (msg) => logger.debug(maskSecretsInText(msg, secrets)) } }`,
 *    and `buildMfaConfigRequest` in the Cognito provider already takes an
 *    injected `logger?: { warn }`. This follows that shape instead of adding a
 *    second one.
 * 2. **Blast radius.** {@link RecordedSecretValues} is keyed by PLAINTEXT, so
 *    handing it over gives every one of ~130 providers the pass's secrets as
 *    iterable DATA — one `[...context.secrets.keys()]` in any of them is a
 *    leak strictly worse than the one being fixed. A `(text) => string` grants
 *    the capability with no read path back to the values.
 * 3. **Layering.** The bag would put a `src/deployment/**` VALUE import and
 *    the `RecordedSecretValues` type into `src/provisioning/**`. The function
 *    keeps both out: a provider imports the {@link SecretMasker} alias from
 *    `src/types/resource.ts` (which re-exports it, as it does `DeleteContext`)
 *    and never names the bag. Stated precisely because an earlier draft
 *    claimed the provider "needs no new import at all", which stopped being
 *    true once the provider took the masker as a helper parameter — and a
 *    structurally re-declared `(text: string) => string` was the wrong way to
 *    keep it true, since it only bought a way to drift from the contract.
 * 4. **It can be WIDENED without touching a provider.** What a masker covers
 *    is the caller's decision, so growing cdkd's notion of "sensitive" — see
 *    the `NoEcho` gap below — changes the deploy engine alone. Threading the
 *    bag would freeze the provider contract to today's secret model.
 *
 * A masked LOGGER (injecting `{ warn }` that masks) was rejected too: providers
 * are registered as SINGLETONS (`registry.register(type, new XProvider())`) and
 * serve concurrent resources, so there is no per-call logger seam to replace
 * and no safe place to stash one. The masker is per-CALL for exactly that
 * reason, which is also why a provider must never cache it on `this`.
 *
 * **What it does NOT cover — THREE gaps, not one.** The first is about which
 * values are known; the other two are about how a caller USES the masker, and
 * both are why {@link SecretMaskingContext} tells providers to mask the VALUE
 * rather than the finished line:
 *
 * 1. **Escaping / stringification.** A masker matches by literal occurrence,
 *    so anything that TRANSFORMS the value before it lands in the text defeats
 *    it. `JSON.stringify` escapes `"`, `\` and newlines — so a Secrets
 *    Manager JSON document, the commonest real secret shape, no longer occurs
 *    in the string being masked and passes through verbatim. Measured, not
 *    theorised. Mask before you stringify.
 * 2. **The needle floor.** {@link maskSecretsInText} masks an exact
 *    whole-value match at any length, but only SCANS for substrings of at
 *    least {@link MIN_NEEDLE_LENGTH} characters. Masking a finished message
 *    can only reach the scan, so a 1-3 character secret survives it.
 * 3. **`NoEcho` parameters**, below.
 *
 * On the model itself: it covers only what cdkd's dynamic-reference secret
 * model records: `{{resolve:secretsmanager:...}}` and `{{resolve:ssm-secure:...}}` /
 * `SecureString` ssm resolutions. A `NoEcho: true` template PARAMETER is
 * outside that model by construction — the resolver redacts it in its own
 * debug line (`stringifyParameterForLog`) but never records the value, and the
 * same limit is already documented at `outputs-export-alias.ts`. So
 * `EnabledMfas: {Ref: SomeNoEchoParam}` is NOT masked by this, and no masker
 * built from a {@link RecordedSecretValues} bag could be: that map exists to
 * rewrite a plaintext back onto the `{{resolve:...}}` expression it came from,
 * and a `Ref` has no such expression. Recording `NoEcho` values into it would
 * therefore also change what {@link redactSecretsForState} PERSISTS, which is
 * a separate behavior change and is filed on its own (issue #1998).
 *
 * That residual is NOT log-only, which is worth stating because the obvious
 * assumption is that it is: a `NoEcho` value quoted back inside an AWS ERROR
 * reaches `deployments/*.jsonl`, because the event masker works from this same
 * bag and the bag never holds a `NoEcho` value. So it is PERSISTED exposure.
 * The dynamic-reference case this contract fixes really is log-only — that
 * path's errors already pass through {@link maskSecretsInText} — so do not
 * carry the log-only framing across to the `NoEcho` one.
 */
export type SecretMasker = (text: string) => string;

/**
 * Bind a {@link RecordedSecretValues} bag into a {@link SecretMasker} for a
 * caller to hand to a provider.
 *
 * The bag is captured BY REFERENCE and read on every call, and there is
 * deliberately NO `secrets.size === 0` short-circuit here: collapsing an empty
 * bag to the identity function at BIND time would go permanently blind to
 * everything added afterwards. {@link maskSecretsInText} makes that check at
 * CALL time, where it is correct and costs a `Map.size` read.
 *
 * Stated as a property rather than a live requirement, because it is worth
 * being exact about: every caller today FILLS its bag before binding — the
 * rollback executor's arms run `resolveReplayProps` first and only then build
 * the masker, and the deploy engine resolves before it calls the provider — so
 * a bind-time short-circuit would pass every existing integration. It is the
 * ORDER, not the reference capture, that makes them work now, and the order is
 * the kind of thing a later refactor reverses without noticing. The unit test
 * `masks values added to the bag AFTER the masker was built` is what holds the
 * property up on its own.
 */
export function createSecretMasker(secrets: RecordedSecretValues): SecretMasker {
  return (text: string) => maskSecretsInText(text, secrets);
}
