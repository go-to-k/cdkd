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
 * The UNCOLLAPSED companion of a {@link RecordedSecretValues} map: for each map
 * instance, every `expression -> plaintext` pair the resolver recorded INTO IT,
 * keyed by EXPRESSION (issue [#2485](https://github.com/go-to-k/cdkd/issues/2485)).
 *
 * WHY IT EXISTS. The map is keyed by PLAINTEXT, so two expressions resolving to
 * one value keep ONE entry — whichever the resolver recorded last. A WHOLE-token
 * leaf is immune (the position pass copies its own source), but a leaf that
 * EMBEDS a token in a literal string is redacted by the value scan, which can
 * only write the map's surviving expression: the versioned sibling's, for a
 * template that spells the un-versioned one, and the next deploy diffs that
 * leaf forever. Recovering the losing expression needs evidence the map has
 * discarded, and it has to be PASS-LOCAL: `recordedSecretExpressions` is
 * process-wide and says only that an expression IS secret, never what it
 * resolved to in THIS resource — so it cannot tell "the source token lost the
 * map slot to its sibling" from "the source token was never resolved here"
 * (a previous generation's bag, where writing today's expression over the
 * framed value would record something that was never deployed).
 *
 * Keyed by the map INSTANCE, so the evidence is exactly as pass-local as the
 * map itself: a map the resolver populated (the deploy's `perResourceSecrets`
 * entry, and equally the map drift / scrub / import hand their own resolution)
 * carries the pairs of THAT resolution, while a map the resolver did not
 * populate — a derived needle map, a nested-stack inheritance copy, a
 * `new Map(secrets)` copy — starts with no entries here and takes the
 * pre-#2485 fall-through, the safe direction. A copy loses the evidence
 * deliberately: a copy is not the pass that resolved anything.
 *
 * `CONFLICTING_PLAINTEXT` marks an expression this map saw resolve to TWO
 * values (a region-pinned re-resolution of one spelling, say); it then vouches
 * for nothing, which is the same "answer nothing you cannot prove" rule
 * {@link plaintextIndexOf} applies to the collapsed map's reverse index.
 */
const resolvedPairsOf = new WeakMap<RecordedSecretValues, Map<string, string | symbol>>();

/**
 * Record that `expression` resolved to `plaintext` in the pass that owns
 * `secrets` — the resolver's recording seam calls this beside its
 * `secrets.set(plaintext, expression)`, so the two never disagree about which
 * pass the evidence belongs to. Mask-only map entries (value `SECRET_MASK`)
 * never pass through that seam — they came from no `{{resolve:...}}` token —
 * so nothing here special-cases the mask string: a secret whose plaintext
 * happens to BE `***` is a secret like any other.
 */
export function recordResolvedPair(
  secrets: RecordedSecretValues,
  expression: string,
  plaintext: string
): void {
  let pairs = resolvedPairsOf.get(secrets);
  if (pairs === undefined) {
    pairs = new Map();
    resolvedPairsOf.set(secrets, pairs);
  }
  const previous = pairs.get(expression);
  if (previous === undefined) pairs.set(expression, plaintext);
  else if (previous !== plaintext) pairs.set(expression, CONFLICTING_PLAINTEXT);
}

/**
 * Carry the resolved pairs of `from` into `to`, for the one copy of a
 * resolver-populated map that POSITIONS anything: the deploy engine accumulates
 * each stack's output resolution into its `outputSecrets` bag entry by entry,
 * and without this the copy would keep the collapsed entries while dropping the
 * evidence — so a literal `Output` embedding one of two same-plaintext
 * references would fall back to the value scan and persist the sibling's
 * expression. The engine's other entry-by-entry copy — an `Export.Name`'s
 * secrets into the pass map — deliberately does NOT call this (and `cdkd
 * scrub`'s name loop resolves through a VIEW whose pairs never reach the pass
 * map at all, issue #2531): a name never
 * positions a leaf, a value re-using the same token records its own pair at
 * the seam, and the only thing the merge could add is a CONFLICT (a
 * non-cacheable `{{resolve:ssm:X}}` whose value moved between the value pass
 * and the name's resolution), which would destroy positioning the value pass
 * had earned. A pair that conflicts across the two maps is marked conflicting
 * in `to`, the same rule {@link recordResolvedPair} applies within one map.
 *
 * Deliberately NOT a general "copy the map" helper: every other new map is a
 * different PASS, and starting it without evidence is the safe direction.
 */
export function mergeResolvedPairs(from: RecordedSecretValues, to: RecordedSecretValues): void {
  const pairs = resolvedPairsOf.get(from);
  if (pairs === undefined) return;
  for (const [expression, plaintext] of pairs) {
    if (typeof plaintext === 'string') recordResolvedPair(to, expression, plaintext);
    else {
      let target = resolvedPairsOf.get(to);
      if (target === undefined) {
        target = new Map();
        resolvedPairsOf.set(to, target);
      }
      target.set(expression, CONFLICTING_PLAINTEXT);
    }
  }
}

/**
 * The plaintext `expression` resolved to in the pass that owns `secrets`, or
 * `undefined` when that pass recorded nothing for it (or two different values).
 */
function resolvedPlaintextOf(
  secrets: RecordedSecretValues,
  expression: string
): string | undefined {
  const recorded = resolvedPairsOf.get(secrets)?.get(expression);
  return typeof recorded === 'string' ? recorded : undefined;
}

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
 * The plaintexts a pass recorded with NO EXPRESSION behind them — the
 * MASK-ONLY needle class (issue
 * [#2274](https://github.com/go-to-k/cdkd/issues/2274)).
 *
 * WHAT IT IS FOR. A Lambda-backed custom resource's handler can declare its
 * response `Data` sensitive with the documented `NoEcho: true` envelope field.
 * That value is GENERATED by the handler, so cdkd never substituted it from
 * anything: there is no `{{resolve:...}}` expression to rewrite it back onto,
 * which is exactly why {@link RecordedSecretValues} — a plaintext -> EXPRESSION
 * map — cannot hold it on its own terms. The value still must not sit in
 * `state.json`, so what gets persisted in its place is {@link SECRET_MASK}.
 *
 * WHY THE SAME MAP RATHER THAN A SECOND BAG. Every persistence reader in this
 * module already walks a `RecordedSecretValues` — `scrubResourceRecord`'s three
 * fields, the rollback journal's ops, the outputs bag, `maskSecretsInText`'s
 * log / error / event sites. Threading a parallel bag to each of them would be
 * a wide change with one place per reader to forget. Recording the pair as
 * `plaintext -> SECRET_MASK` means the whole-value arm of
 * {@link redactSecretsForState} substitutes the mask with no code change at
 * all, and every reader is covered by construction.
 *
 * THE SENTINEL VALUE **IS** THE MARKER — there is no side table, and an earlier
 * revision's `WeakMap<RecordedSecretValues, Set<string>>` was removed after a
 * mutation probe showed the extra conjunct could not be fenced AND pointed the
 * wrong way. Nothing but {@link recordMaskOnlyValue} ever writes
 * {@link SECRET_MASK} as a map VALUE (every other writer stores a whole
 * `{{resolve:...}}` token, and {@link recordCrossStackExpression} refuses
 * anything else), so the side table could only ever disagree about an entry
 * some future writer valued `***` by hand — and for THAT entry, withholding the
 * substring arm is the SAFE answer, which is what the side table would have
 * denied. Scope is unaffected: the MAP is already per-pass, so a mask cannot
 * reach another resource's bag any more than an expression can.
 *
 * THE ONE PLACE THE CLASSES MUST DIFFER: the SUBSTRING arm. Substituting an
 * EXPRESSION for a match inside a longer leaf is lossless — the persisted leaf
 * still names a value every downstream reader can re-resolve. Substituting a
 * MASK is not: an inline `***` is indistinguishable from a literal `***` a user
 * wrote, so no consumer can recognise it, and `cdkd drift --revert` /
 * `resolveReplayProps` would push the corrupted string to AWS. A mask is only
 * safe where it is RECOGNISABLE, and that means whole-leaf. So a mask-only
 * plaintext is excluded from the persist path's needle regex and reaches only
 * the whole-value arm — the same "weaker class, narrower blast radius" shape
 * PR #2415 established for its `inferred` needles, which likewise take a leaf
 * whole or not at all.
 *
 * {@link maskSecretsInText} is deliberately NOT narrowed the same way: its
 * output is a log line, an error message or an event, which nothing reads back
 * as a value, so a partial mask there costs nothing and closes an embedded
 * disclosure.
 */
/**
 * Record `plaintext` as MASK-ONLY in `secrets` — persist {@link SECRET_MASK} in
 * its place, with no expression to substitute (issue #2274).
 *
 * An EXPRESSION already recorded for the same plaintext WINS and this is a
 * no-op: an expression is strictly better than a mask (it is re-resolvable, it
 * survives `drift --revert` and the rollback replay, and it reaches the
 * substring arm), so a mask must never demote one. The reverse direction needs
 * no code: the resolver writes an expression straight into the map, and
 * {@link isMaskOnlyPlaintext} re-checks the map value, so a plaintext that
 * later acquires a real expression stops being mask-only immediately.
 *
 * A plaintext shorter than {@link MIN_NEEDLE_LENGTH} is REFUSED, and this floor
 * is the one place the mask class needs a bound the EXPRESSION class does not
 * (issue #2274 review). An expression-bearing needle below the threshold is
 * still substituted on the WHOLE-VALUE arm, and that is safe because the pair
 * came from a POSITION cdkd resolved: the leaf it rewrites provably held that
 * reference. A mask-only needle has no position behind it — it is a bare
 * plaintext the handler happened to return — so the whole-value arm masks EVERY
 * leaf equal to it, anywhere in the record. A handler answering
 * `Data: { Count: "7" }` would otherwise mask any property whose whole value is
 * `"7"`, unrecoverably (there is no expression to re-resolve) and on every
 * later run (the mask then trips `refuseRedactedAttributeReads`,
 * `refuseMaskedReplayBaseline` and the export blocker). The floor is the same
 * constant the substring arm already applies, so the two arms of this module
 * now agree about what is too short to be a distinguishing value.
 *
 * THE BOUND IS THE MODULE'S, NOT ONE THIS CHANNEL INVENTED, and it is stated
 * rather than overstated: {@link MIN_NEEDLE_LENGTH} is 4, so a FOUR-character
 * member (`"true"`) still becomes a needle and a property whose whole value is
 * `"true"` is still masked. Raising the floor here alone would fork the two
 * arms' idea of a distinguishing value, which is the disagreement the shared
 * constant exists to prevent. The remedy for that shape is a handler contract
 * — do not declare a whole response `NoEcho` when its `Data` mixes a secret
 * with short non-secret members — and it is asserted in
 * `secret-redaction-mask-only.test.ts` so the bound is a recorded decision
 * rather than a surprise.
 *
 * The empty string is refused by the same bound, and would be refused anyway
 * for the reason the value pass refuses it: it is not a distinguishing value,
 * and recording it would mask every empty leaf.
 */
export function recordMaskOnlyValue(secrets: RecordedSecretValues, plaintext: string): void {
  if (plaintext.length < MIN_NEEDLE_LENGTH) return;
  const existing = secrets.get(plaintext);
  if (existing !== undefined && existing !== SECRET_MASK) return;
  secrets.set(plaintext, SECRET_MASK);
}

/**
 * Is `plaintext` a MASK-ONLY entry of `secrets`?
 *
 * Read off the MAP, so a plaintext this module marked as mask-only and the
 * resolver later records WITH an expression stops being one immediately —
 * which matters, because that entry has earned the substring arm back.
 */
function isMaskOnlyPlaintext(secrets: RecordedSecretValues, plaintext: string): boolean {
  return secrets.get(plaintext) === SECRET_MASK;
}

/**
 * CYCLE SAFETY for the two mask-only walks, replacing the depth cap an earlier
 * revision used (issue #2274 review).
 *
 * The cap was ASYMMETRIC with the walk that WRITES the mask —
 * {@link redactSecretsForState}'s own walk and `redactByPath` are unbounded —
 * so a mask placed more than ten levels deep persisted while
 * {@link carriesSecretMask} read the record as clean, and the rollback replay,
 * the export blocker and `noteAttributeSecrecy` all missed it. That is the one
 * direction this pair must never fail in: a recognition test that under-reports
 * ships `***` to AWS. The recognition side's input is state JSON, not untrusted
 * handler output, so there was nothing for a depth cap to protect against
 * either.
 *
 * A `Set` of visited containers gives the safety the cap was reaching for
 * without capping DEPTH: a self-referential structure terminates, and a legal
 * deep one is still walked to the bottom. Both walks share it so the two can no
 * longer disagree about which values they can see.
 */
type WalkedContainers = Set<object>;

/**
 * Record every STRING LEAF of `value` as a MASK-ONLY needle in `secrets`.
 *
 * The bag-shaped twin of {@link recordMaskOnlyValue}, used where a whole
 * `Data` / attributes object is declared sensitive at once. Non-string leaves
 * are skipped deliberately: the redaction walk matches by string value, so
 * there is nothing to key a number or a boolean on, and both are far too
 * collision-prone to be useful needles even if there were.
 *
 * `excluded` is the set of plaintexts CDKD ITSELF SUPPLIED to the resource, and
 * passing it is what keeps a handler from masking cdkd's own inputs back at it
 * (issue #2274 review). A handler echoing its `event.ResourceProperties` into
 * `Data` — the shape the CDK `Provider` framework's samples encourage — makes
 * `Data.X` equal to the resource's own `ServiceToken`, and recording THAT as a
 * needle rewrites `properties.ServiceToken` to `***` in the very record
 * `CustomResourceProvider.delete` reads it back from, where `'***'` is a
 * truthy string that passes both of that method's guards. Such a value is not
 * handler-GENERATED at all — it is in the synthesized template already — so
 * excluding it costs no secrecy.
 */
export function recordMaskOnlyValuesIn(
  value: unknown,
  secrets: RecordedSecretValues,
  excluded?: ReadonlySet<string>
): void {
  const seen: WalkedContainers = new Set();
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      if (excluded?.has(node) === true) return;
      recordMaskOnlyValue(secrets, node);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const child of Object.values(node as Record<string, unknown>)) walk(child);
  };
  walk(value);
}

/**
 * Every WHOLE string leaf of `value`, as a set — the `excluded` argument
 * {@link recordMaskOnlyValuesIn} takes, built from the resource's own resolved
 * template properties.
 *
 * WHOLE leaves only, matching the arm the mask class is served on: a mask-only
 * needle never reaches the substring scan, so a plaintext that merely OCCURS
 * inside a property is not something this exclusion has to answer for.
 */
export function wholeStringLeavesOf(value: unknown): Set<string> {
  const leaves = new Set<string>();
  const seen: WalkedContainers = new Set();
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      leaves.add(node);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const child of Object.values(node as Record<string, unknown>)) walk(child);
  };
  walk(value);
  return leaves;
}

/**
 * Does `value` carry {@link SECRET_MASK} as a WHOLE string leaf?
 *
 * The recognition test every consumer of a REDACTED baseline shares (issue
 * #2274). A mask-only redaction is whole-leaf precisely so it stays
 * recognisable, and this is what recognises it — in the resolver (a persisted
 * attribute cdkd can no longer serve), in `cdkd drift` (a baseline that must
 * not be pushed by `--revert` nor overwritten by `--accept`), and in the
 * rollback replay (a desired bag that must not reach a provider).
 *
 * Whole-leaf EQUALITY, never containment: an inline `***` inside a longer
 * string is either a user's own literal or text this module never wrote, and
 * treating it as a mask would refuse ordinary values. The corresponding limit —
 * a NoEcho value EMBEDDED in a larger leaf keeps its plaintext — is the same
 * one the mask-only channel note above states, and is tracked separately.
 *
 * UNBOUNDED in depth, guarded by {@link WalkedContainers} — see that type for
 * why a depth cap here was a hole rather than a safety measure.
 */
export function carriesSecretMask(value: unknown): boolean {
  const seen: WalkedContainers = new Set();
  const walk = (node: unknown): boolean => {
    if (typeof node === 'string') return node === SECRET_MASK;
    if (node === null || typeof node !== 'object') return false;
    if (seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) return node.some((item) => walk(item));
    return Object.values(node as Record<string, unknown>).some((child) => walk(child));
  };
  return walk(value);
}

/**
 * The plaintexts the PERSIST path may scan for as SUBSTRINGS — every recorded
 * one except the mask-only class. See the mask-only channel note above for why the
 * mask class is whole-leaf only.
 */
function substringNeedlesOf(secrets: RecordedSecretValues): string[] {
  const needles: string[] = [];
  for (const plaintext of secrets.keys()) {
    if (!isMaskOnlyPlaintext(secrets, plaintext)) needles.push(plaintext);
  }
  return needles;
}

/**
 * The EXPRESSIONS a pass recorded — `secrets.values()` minus the mask-only
 * class, whose "expression" is the mask sentinel rather than a reference.
 *
 * Removing this filter is an EQUIVALENT MUTANT and no test can red on it —
 * stated rather than claimed pinned. {@link SECRET_MASK} is not a
 * dynamic-reference token, so neither `isKnownSecretExpression` nor a skeleton
 * pattern can ever accept it as a candidate. It is kept because a list
 * documented as "the expressions this pass recorded" must not silently contain
 * something that is not one: the day a candidate test stops requiring token
 * SHAPE, the sentinel would be live in it.
 */
function recordedExpressionsOf(secrets: RecordedSecretValues): Set<string> {
  const expressions = new Set<string>();
  for (const [plaintext, expression] of secrets) {
    if (!isMaskOnlyPlaintext(secrets, plaintext)) expressions.add(expression);
  }
  return expressions;
}

/**
 * The IN-RUN recovery channel for a stack OUTPUT this process masked (issue
 * [#2274](https://github.com/go-to-k/cdkd/issues/2274)).
 *
 * WHY IT EXISTS. Masking a `NoEcho` custom resource's `Data` on the way into
 * `state.json` is right within one stack, where `Fn::GetAtt` reads the value out
 * of the IN-MEMORY record and gets the plaintext. It breaks the moment the value
 * crosses a STACK boundary, because every cross-stack route reads the producer's
 * PERSISTED `state.outputs`: a nested stack's `Outputs.<Key>` (via
 * `NestedStackProvider.readChildOutputsAsAttributes`), `Fn::ImportValue` (via
 * the exports index or a state scan) and `Fn::GetStackOutput` all land on the
 * mask. Without this the FIRST deploy of a parent whose child exports such a
 * value would refuse — a template that deployed before this feature — which is
 * a regression rather than a trade.
 *
 * WHAT IT IS. `stack + region + output key -> the plaintext that key held
 * before redaction`, written at the moment the producer's outputs are redacted
 * and read at the three cross-stack sites above. It answers only for a producer
 * THIS PROCESS deployed in THIS run, which is exactly the population that has a
 * plaintext to hand back: a separate `cdkd deploy` of the consumer has none, and
 * that case is refused rather than guessed at.
 *
 * WHY THE COORDINATE, and not a plaintext-keyed set. A bare-plaintext store was
 * the shape PR #2415 was forced to WITHDRAW (`provenPublicExpressions`,
 * residual #2425): keyed on a value alone, one stack's answer is served to
 * another stack's identically-spelled read. Here the key names the producer
 * stack, its region and the output — so a hit is served only to a resolution
 * that asked for that exact output of that exact stack, i.e. to precisely the
 * reader that would have received the plaintext before this feature existed.
 * Nothing is widened.
 *
 * A RECOVERED VALUE IS STILL SECRET, and every reader re-registers it as a
 * mask-only needle in its OWN bag before using it — the recovery hands back the
 * value for the WIRE, never for persistence.
 */
const recoverableMaskedOutputs = new Map<string, unknown>();

function maskedOutputKey(stackName: string, region: string, outputKey: string): string {
  // NUL-separated for the reason `crossStackSourceKey` is: a `:` / `/` occurs
  // inside real stack names, regions and export names, so any printable
  // separator can be forged into another coordinate's key.
  return `${stackName}\u0000${region}\u0000${outputKey}`;
}

/**
 * Remember the plaintext an output held before {@link SECRET_MASK} replaced it.
 * See {@link recoverableMaskedOutputs}.
 */
export function recordRecoverableMaskedOutput(
  stackName: string,
  region: string,
  outputKey: string,
  plaintext: unknown
): void {
  recoverableMaskedOutputs.set(maskedOutputKey(stackName, region, outputKey), plaintext);
}

/**
 * The plaintext this process masked out of `stackName`'s `outputKey`, or
 * `undefined` when this run did not produce that output.
 *
 * `undefined` is the honest answer for a producer deployed by an EARLIER run:
 * the value is gone and cdkd must refuse rather than write the mask to AWS.
 */
export function recoverMaskedOutput(
  stackName: string,
  region: string,
  outputKey: string
): unknown | undefined {
  return recoverableMaskedOutputs.get(maskedOutputKey(stackName, region, outputKey));
}

/** Drop every remembered plaintext. Cleared on the `resetAccountInfoCache` lifetime. */
export function clearRecoverableMaskedOutputs(): void {
  recoverableMaskedOutputs.clear();
}

/**
 * Every cross-stack source leaf whose producer stored a WHOLE
 * `{{resolve:...}}` token, against the token the producer stored and the
 * plaintext it resolved to — SCOPED TO ONE RESOLUTION PASS (issue
 * [#2059](https://github.com/go-to-k/cdkd/issues/2059)).
 *
 * WHY A SECOND STORE, when {@link recordedSecretExpressions} already holds
 * every expression uncollapsed. That set is a CANDIDATE LIST, and
 * {@link positionByIntrinsicSkeleton} picks from it by matching the source
 * leaf's literal TEXT. `Fn::ImportValue` / `Fn::GetStackOutput` carry no text
 * about their expression at all — an export NAME bears no relation to the
 * producer's `{{resolve:...}}` string — so a text matcher can only ever REFUSE
 * for them, and a refusal falls through to the plaintext-keyed value scan,
 * which is the collapse. Two consumer leaves importing an `:AWSCURRENT` and an
 * `:AWSPREVIOUS` export of one secret momentarily resolve to the SAME plaintext
 * during a rotation, so both were persisted holding whichever expression was
 * recorded last, and `resolveReplayProps` then re-resolves the WRONG reference
 * against the live resource on a rollback or a `cdkd drift --revert`.
 *
 * What closes it is an ASSOCIATION rather than a matcher, and the resolver is
 * the only place both halves are in hand at once: it knows the source leaf it
 * is resolving AND the token the producer stored. This is where it puts them.
 *
 * THE SCOPE IS THE SAFETY ARGUMENT, and it took two rounds to get right, so the
 * history is recorded rather than left to be re-derived. The store began
 * PROCESS-WIDE — one module-level map, cleared with the resolver caches — and
 * that is unsound here for a reason no amount of narrowing reaches. The key is
 * not region-qualified: an `Fn::ImportValue` key carries no region at all and
 * an `Fn::GetStackOutput` that omits `Region` keys it empty, so ONE key
 * genuinely names TWO producers inside a single `cdkd deploy --all`, where
 * `deploy.ts` builds a resolver per stack region. A second stack's leaf was
 * then certified with the FIRST stack's region-pinned expression — a case the
 * value scan gets RIGHT, so it was a NEW wrong answer rather than a missed
 * improvement. Pairing each entry with its plaintext narrowed that but could
 * not close it: two regions holding the SAME value (a Secrets Manager
 * multi-region replica, a shared API key) pair happily, and "correct only while
 * replication holds" is a property nobody declared and nothing enforces.
 *
 * So the store is keyed by the RESOLUTION PASS's own {@link RecordedSecretValues}
 * bag, and a foreign entry is not merely refused — it cannot be REACHED. That
 * bag is already per-pass and already travels from the resolver context to the
 * redaction path (`DeployEngine.perResourceSecrets`, `cdkd scrub`'s
 * `perResourceSecrets`, `rollback-executor.ts`'s `secrets`, each storing the
 * very object the resolver mutated), so this is a scope change rather than new
 * plumbing, and no call site had to grow a parameter. A caller that hands the
 * redaction path a DIFFERENT bag from the one it resolved with — `cdkd state
 * refresh-observed`, whose map is empty by construction because it neither
 * synthesizes nor resolves — simply finds no associations and falls back to the
 * value scan, which is the direction a mismatch must fail in.
 *
 * A `WeakMap` so a pass's associations die with its bag. That replaces an
 * explicit clear paired with `resetAccountInfoCache`, which production never
 * called — and it is what keeps the PLAINTEXTS these entries hold from
 * outliving the pass that fetched them.
 *
 * Each entry still carries its plaintext, and the reader still refuses an entry
 * whose plaintext is not the bag it is certifying. That check is now
 * BELT-AND-BRACES against a foreign pass, and it is deliberately kept: inside
 * ONE pass it is still the only guard against a bag/source MISALIGNMENT, where
 * a readback bag holds a different resource's secret while the source leaf
 * still spells this import.
 *
 * ONE class of row is NOT written by the resolver: the `Ref` rows a nested-stack
 * CHILD inherits from its parent through
 * {@link inheritNestedStackParameterAssociations} (issue #2291). Those describe
 * a leaf whose producer is the PARENT ENGINE rather than a producer stack read
 * during this pass, so the writer is the engine and the association is copied in
 * at context-construction time. The reader below is unchanged for them — the
 * three conditions mean exactly what they mean for the resolver-written rows.
 *
 * A key recorded against a DIFFERENT (expression, plaintext) pair is POISONED
 * to {@link CONFLICTING_CROSS_STACK} rather than overwritten, and the reader
 * then refuses. Either half differing is enough: two expressions under one key
 * means the pass read one leaf identity two ways, and one expression under two
 * plaintexts is the same reference answering differently in two regions (the
 * issue [#1933](https://github.com/go-to-k/cdkd/issues/1933) shape, reachable
 * within one pass through a producer-region resolver). Guessing between them
 * would be the collapse this exists to remove, one step over. Every refusal
 * degrades to the value scan, i.e. to today's behavior, so no case gets worse.
 */
interface CrossStackAssociation {
  /** The WHOLE `{{resolve:...}}` token the producer's state held. */
  readonly expression: string;
  /** What that token resolved to when this pass read the producer. */
  readonly plaintext: string;
}

type CrossStackAssociations = Map<string, CrossStackAssociation | symbol>;

const crossStackAssociations = new WeakMap<RecordedSecretValues, CrossStackAssociations>();

/** Poison for a key seen against two different (expression, plaintext) pairs. */
const CONFLICTING_CROSS_STACK = Symbol('conflicting cross-stack association');

/**
 * Separator for the composite keys {@link crossStackSourceKey} builds.
 *
 * A NUL rather than a printable character because no AWS export name, stack
 * name, output name, region or role ARN can contain one, so no two distinct
 * source leaves can spell a single key. A printable separator (`:` / `|`) does
 * occur inside a real export name — CDK's own convention is
 * `Stack:ExportName` — which would let one leaf's key be read as another's.
 */
const CROSS_STACK_KEY_SEPARATOR = '\u0000';

/** A non-empty literal string, or `undefined` for anything else. */
function literalStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Split the STRING spelling of an `Fn::GetAtt` argument into its logical id and
 * its attribute name, or `undefined` when the string is not a well-formed one.
 *
 * THE ONE ANSWER TO "what arity does the string form accept", shared by the two
 * sites that must agree about it (issue
 * [#2270](https://github.com/go-to-k/cdkd/issues/2270)):
 * `IntrinsicFunctionResolver.resolveGetAtt`, which RESOLVES the reference, and
 * {@link crossStackSourceKey} below, which keys the same leaf for the persist
 * path. They were two spellings of one question and they disagreed -- the
 * resolver split on every dot and rejected anything but two segments, so the
 * key function copied that rule ("the string form only at exactly two
 * dot-separated segments, `resolveGetAtt` throws otherwise"). When #2270
 * widened the resolver to CloudFormation's actual rule, a paraphrase here would
 * have gone silently stale in the direction that matters: the resolver would
 * key a leaf the persist path refuses, and issue
 * [#2059](https://github.com/go-to-k/cdkd/issues/2059)'s per-leaf positioning
 * would degrade to the plaintext-keyed value scan for exactly the nested-stack
 * OUTPUT references that positioning exists for. A shared function cannot drift.
 *
 * IT LIVES HERE, in a module that is a LEAF by design (see the file header --
 * it imports nothing, because both the resolver and the deploy engine consume
 * it), rather than in the resolver: the resolver ALREADY imports this module,
 * so the dependency runs in the only direction that does not create a cycle.
 *
 * The rule is CloudFormation's: split on the FIRST dot only, because an
 * ATTRIBUTE NAME may itself contain dots (`Outputs.<Key>` on an
 * `AWS::CloudFormation::Stack`, `Endpoint.Address` on an RDS cluster), so
 * `Child.Outputs.Foo` parses as `["Child", "Outputs.Foo"]`. BOTH halves must be
 * non-empty, which is what still rejects the shapes the old arity test rejected
 * for a real reason -- a bare `MyResource` (no attribute), a leading `.Attr`
 * (no logical id) and a trailing `MyResource.` (empty attribute). `indexOf`
 * answers all three: -1, 0, and `length - 1` respectively.
 *
 * Callers differ only in what they DO with a refusal -- the resolver throws
 * `Invalid Fn::GetAtt format`, this module's key function returns `undefined`
 * and degrades to the value scan -- which is why this returns a value rather
 * than throwing.
 */
export function splitGetAttStringForm(
  getAtt: string
): { logicalId: string; attributeName: string } | undefined {
  const firstDot = getAtt.indexOf('.');
  if (firstDot <= 0 || firstDot === getAtt.length - 1) return undefined;
  return { logicalId: getAtt.slice(0, firstDot), attributeName: getAtt.slice(firstDot + 1) };
}

/**
 * The canonical key identifying a cross-stack source leaf, or `undefined` when
 * this leaf's identity is not LITERALLY COMPUTABLE from the source alone
 * (issue #2059).
 *
 * Both sides of {@link crossStackAssociations} call THIS function, which
 * is what makes the two keys byte-identical by construction: the resolver hands
 * it the raw intrinsic it is about to resolve, the redaction path hands it the
 * template source leaf at the position being persisted, and both are the same
 * template object. Deriving the writer's key from the resolver's RESOLVED
 * `exportName` / `stackName` instead would look equivalent and is not — the
 * persist path has only the source leaf, so the two spellings would have to be
 * proven equal at every slot rather than being the same string.
 *
 * REFUSAL IS THE POINT of the literal test. An export name that is itself an
 * `Fn::Sub` / `Fn::Join` / `Ref` resolves to something the persist path cannot
 * compute — it holds the unresolved template — so there is no honest key for it
 * and this returns `undefined`. The caller then falls back to today's behavior
 * (the skeleton pass, then the value scan) rather than guessing.
 *
 * The resolver's existing `origin` string is deliberately NOT reused: it is a
 * human-readable log label built from RESOLVED values and carrying prose
 * (`(producer X / Y)`), so it is neither derivable from the source leaf nor
 * stable.
 *
 * FIVE arms answer, and the enumeration is kept current because a stale one
 * reads as exhaustive: `Fn::ImportValue`, `Fn::GetStackOutput`, the `Fn::GetAtt`
 * on a nested-stack OUTPUT that issue #2055's read site re-resolves, the
 * single-placeholder `Fn::Sub` that normalizes ONTO that `Fn::GetAtt` key
 * (issue #2270 round 3 -- this list said THREE until issue #2291 noticed it had
 * been four since then), and the `Ref` to a nested-stack CHILD's own PARAMETER
 * (issue #2291). Every other leaf refuses.
 *
 * `Region` and `RoleArn` are OPTIONAL slots, and an ABSENT one keys as empty
 * while a PRESENT-but-non-literal one refuses. Absent has to be its own key
 * rather than being filled in with the resolver's own region: the persist path
 * cannot see that region, so a key built from it could not be recomputed.
 *
 * THE KEY IS THEREFORE NOT REGION-QUALIFIED, and an `Fn::ImportValue` key never
 * is at all — so it does NOT identify one producer on its own. Two stacks in
 * two regions carrying the identical leaf produce the identical key inside one
 * `cdkd deploy --all`, because `deploy.ts` builds a resolver per stack region.
 * An earlier revision of this note claimed the opposite ("one resolver region
 * answers them all"), and that false premise is exactly what let the store's
 * first shape certify one region's expression onto another region's resource.
 * What makes the key safe is not uniqueness but SCOPE:
 * {@link crossStackAssociations} is keyed by the resolution pass's own secrets
 * bag, so a key another pass recorded cannot be reached from here at all. Each
 * entry additionally carries the plaintext it resolved to, which is what
 * refuses a MISALIGNED entry inside one pass.
 *
 * A MULTI-KEY leaf (`{'Fn::ImportValue': 'X', Extra: 1}`) is the one exception
 * to "both sides compute the same string": the resolver reaches this function
 * having already selected the intrinsic, so it hands over a single-key object
 * and gets a key, while the redaction path sees the leaf as authored and
 * refuses on the `keys.length !== 1` test above. That asymmetry is FAIL-SAFE in
 * the only direction it can go — the writer records an association no reader
 * will ever look up — and such a leaf is not valid CloudFormation anyway.
 */
export function crossStackSourceKey(source: Record<string, unknown>): string | undefined {
  const keys = Object.keys(source);
  if (keys.length !== 1) return undefined;
  const key = keys[0]!;

  if (key === 'Fn::ImportValue') {
    const exportName = literalStringOrUndefined(source[key]);
    if (exportName === undefined) return undefined;
    return ['Fn::ImportValue', exportName].join(CROSS_STACK_KEY_SEPARATOR);
  }

  if (key === 'Fn::GetStackOutput') {
    const args = source[key];
    if (!isPlainObject(args)) return undefined;
    // `Object.hasOwn` on EVERY slot, required and optional alike (an earlier
    // revision read the two required ones straight off `args`, which contradicts
    // the rationale below). The resolver's own slot tests use `'X' in args`, and
    // the two agree for a JSON-parsed template — the only bag that can reach the
    // resolver — so this is the STRICTER of the two rather than a divergence: a
    // prototype-inherited slot yields no key here and the leaf falls back, which
    // is the fail-safe direction. They are deliberately not unified, because
    // doing so would loosen a key derivation to match a lookup.
    const stackName = Object.hasOwn(args, 'StackName')
      ? literalStringOrUndefined(args['StackName'])
      : undefined;
    const outputName = Object.hasOwn(args, 'OutputName')
      ? literalStringOrUndefined(args['OutputName'])
      : undefined;
    if (stackName === undefined || outputName === undefined) return undefined;
    const slots: string[] = ['Fn::GetStackOutput', stackName, outputName];
    for (const optional of ['Region', 'RoleArn'] as const) {
      const raw = Object.hasOwn(args, optional) ? args[optional] : undefined;
      if (raw === undefined || raw === null) {
        slots.push('');
        continue;
      }
      const literal = literalStringOrUndefined(raw);
      if (literal === undefined) return undefined;
      slots.push(literal);
    }
    return slots.join(CROSS_STACK_KEY_SEPARATOR);
  }

  // `Fn::GetAtt` on a NESTED-STACK OUTPUT (issue #2055's read site). The
  // resolver re-resolves such a leaf through `reresolveCrossStackValue` exactly
  // as it does the two arms above, so without a key here that arm passed
  // `undefined` and the persist path fell back to the plaintext-keyed value
  // scan. That fallback is only lossless while the plaintexts differ: a child
  // exporting `Cur` (`:AWSCURRENT`) and `Prev` (`:AWSPREVIOUS`) of ONE rotating
  // secret has both outputs resolve to the same value during the `AWSPENDING`
  // window, `recordedSecretValues` collapses them onto whichever expression was
  // recorded last, and BOTH parent properties then persist the survivor's
  // expression -- which `resolveReplayProps` re-resolves and applies to a live
  // resource on rollback, i.e. the WRONG stage. Keying by the consumer's own
  // leaf separates them.
  //
  // BOTH SIDES COMPUTE FROM THE RAW LEAF, which is what makes the two strings
  // identical by construction: the resolver hands over the `Fn::GetAtt`
  // argument exactly as authored (BEFORE it resolves an intrinsic attribute
  // name), and the persist path hands over the template source leaf at the
  // position being persisted. Deriving the resolver's half from its RESOLVED
  // `attributeName` would look equivalent and is not, for the same reason the
  // `Fn::ImportValue` note above gives.
  //
  // The two authored spellings are accepted on the SAME terms the resolver
  // accepts them, and for the string form that is now literally the same
  // FUNCTION rather than a restatement of its rule: {@link
  // splitGetAttStringForm} is what `resolveGetAtt` splits with too, so the two
  // cannot drift apart (issue #2270 -- see that helper for what the drift cost
  // and why the helper lives in this module). It splits on the FIRST dot, so a
  // nested stack's `Child.Outputs.Foo` keys identically to its array spelling
  // `["Child", "Outputs.Foo"]`; the array form is still accepted only at
  // exactly two elements. A NON-LITERAL attribute name refuses, because the
  // persist path holds the unresolved template and could not recompute it.
  // Every refusal degrades to today's behaviour (the skeleton pass, then the
  // value scan).
  if (key === 'Fn::GetAtt') {
    const raw = source[key];
    let logicalId: string | undefined;
    let attributeName: string | undefined;
    if (typeof raw === 'string') {
      // Both halves come back non-empty or the whole split refuses, so the
      // `literalStringOrUndefined` pass the array arm still needs would be a
      // no-op here.
      const split = splitGetAttStringForm(raw);
      if (split === undefined) return undefined;
      logicalId = split.logicalId;
      attributeName = split.attributeName;
    } else if (Array.isArray(raw) && raw.length === 2) {
      logicalId = literalStringOrUndefined(raw[0]);
      attributeName = literalStringOrUndefined(raw[1]);
    }
    if (logicalId === undefined || attributeName === undefined) return undefined;
    return ['Fn::GetAtt', logicalId, attributeName].join(CROSS_STACK_KEY_SEPARATOR);
  }

  // `Fn::Sub` over a SINGLE nested-stack output placeholder, normalized to the
  // `Fn::GetAtt` key above (issue
  // [#2270](https://github.com/go-to-k/cdkd/issues/2270), round 3).
  //
  // WHY THIS ARM EXISTS AT ALL: the same PR that made `${Child.Outputs.Foo}`
  // resolve CREATED a collapse population here. Before it, that placeholder was
  // kept as literal text and carried no secret; after it, the leaf resolves to a
  // plaintext and needs positioning like any other cross-stack read. It had
  // none -- this function refused every `Fn::Sub`, and `intrinsicSkeletonPattern`
  // cannot position it either (its wildcard is `[^}]*`, which cannot cross a
  // `{{resolve:...}}` token's own `}}`), so the leaf fell to the plaintext-keyed
  // value scan. A child exporting two staging labels of ONE rotating secret has
  // both resolve EQUAL during the `AWSPENDING` window, so both parent properties
  // persisted the SURVIVOR's expression and `resolveReplayProps` applied the
  // wrong stage to the live resource on a rollback / `cdkd drift --revert`.
  //
  // IT KEYS AS `Fn::GetAtt`, NOT AS `Fn::Sub`, and that is the whole mechanism
  // rather than a tidiness choice. The WRITER is `resolveGetAtt`, which
  // `resolveSub` calls with the bare placeholder TEXT (`Child.Outputs.Foo`), so
  // the key it records is `crossStackSourceKey({'Fn::GetAtt': 'Child.Outputs.Foo'})`
  // -- it never sees the `Fn::Sub` wrapper at all. Keying this leaf by its
  // `Fn::Sub` text would therefore produce a string the writer's half can never
  // equal, i.e. a key that looks present and never matches. Both halves instead
  // reach `splitGetAttStringForm` with the IDENTICAL substring.
  //
  // EXACTLY ONE PLACEHOLDER AND NOTHING ELSE. A template with surrounding text
  // (`sub-${Child.Outputs.Foo}-end`) resolves to a value that merely EMBEDS the
  // producer's token rather than BEING it, and `recordCrossStackExpression` is
  // whole-token only -- so such a leaf has no single expression to persist and
  // is refused here. `${!Literal}` is CloudFormation's ESCAPE and never resolves
  // anything, so it refuses on the `!` group. A `${Child}` Ref form refuses
  // because `splitGetAttStringForm` requires a dotted attribute -- there is no
  // `Fn::GetAtt` writer behind it.
  //
  // THE 2-ARG `[template, vars]` FORM IS ACCEPTED, but ONLY when the
  // placeholder is genuinely UNBOUND by the variable map. The test is the
  // WRITER's: `resolveSub` consults the map FIRST and a bound variable wins
  // outright, so a bound placeholder never reaches `resolveGetAtt` and no key
  // was ever recorded for it -- while an UNBOUND one falls through to the
  // same-stack lookup and IS keyed, identically to the bare-string form. An
  // earlier revision refused the whole 2-arg form on that first fact alone,
  // which left the unbound spelling in exactly the collapse this arm exists to
  // close (found by review; this PR created that population too, since
  // pre-#2270 the placeholder stayed literal).
  //
  // Dropping the guard and keying every 2-arg form would be the WRONG fix and
  // is worse than the bug: it would certify a leaf the writer never recorded,
  // i.e. attach some other leaf's expression to a bound-variable value. On this
  // path over-redaction beats under-redaction in the wrong direction --
  // `resolveReplayProps` re-resolves the persisted expression and `cdkd drift
  // --revert` PUSHES that baseline back to AWS.
  if (key === 'Fn::Sub') {
    const raw = source[key];
    let template: string | undefined;
    let variables: Record<string, unknown> | undefined;
    if (typeof raw === 'string') {
      template = raw;
    } else if (Array.isArray(raw) && raw.length === 2 && isPlainObject(raw[1])) {
      // Shapes outside `[string, object]` are left refused, but NOT because the
      // writer never records them -- measured, that is only true of some. Arity
      // 1, a `null` / number / string second element and a non-string template
      // all THROW during resolution (0 keys recorded). But `['${A.B}', ['x']]`
      // and a 3-element array both RESOLVE cleanly and ARE recorded, because
      // `resolveSub` destructures the first two elements and `Object.entries`
      // does not throw on an array. Those are refused here for a different
      // reason: CloudFormation rejects them, so the population is not worth
      // widening acceptance for. The refusal degrades to the plaintext-keyed
      // value scan -- whose dominant failure is COLLAPSE onto a colliding
      // sibling, not under-redaction (that is only the empty-map case). It is
      // still the better direction than certifying a key the writer never
      // recorded, on a path where `drift --revert` pushes the baseline to AWS.
      if (typeof raw[0] !== 'string') return undefined;
      template = raw[0];
      variables = raw[1];
    }
    if (template === undefined) return undefined;
    const only = /^\$\{(!)?([^}]*)\}$/.exec(template);
    if (only === null || only[1] === '!') return undefined;
    const varName = only[2] ?? '';
    // `in` over `(variables ?? {})`, NOT `Object.hasOwn`, and NOT guarded on
    // `variables !== undefined` -- this is the WRITER's predicate character for
    // character. `resolveSub` defaults `variables = {}` and always tests
    // `varNameStr in variables`, so BOTH arms here must test too: skipping it for
    // the bare-string form left the identical hole one line over.
    // `in` is a SUPERSET of `hasOwn`. For an INHERITED key the writer substitutes
    // locally and records NO key, while a `hasOwn` reader would not refuse and
    // would key the leaf -- certifying an expression the writer never recorded,
    // i.e. a sibling's. Condition 2 (`association.plaintext !== bag`) does NOT
    // fence that in the target population: two staging labels of one rotating
    // secret resolve EQUAL during `AWSPENDING`, which is why this arm exists.
    // Unreachable today -- it needs a dotted key on `Object.prototype`, and
    // `JSON.parse` makes `__proto__` an own property rather than polluting -- so
    // the old spelling was safe by a runtime property rather than by this code.
    if (varName in (variables ?? {})) return undefined;
    const split = splitGetAttStringForm(varName);
    if (split === undefined) return undefined;
    return ['Fn::GetAtt', split.logicalId, split.attributeName].join(CROSS_STACK_KEY_SEPARATOR);
  }

  // A `Ref` to a NESTED-STACK CHILD's own template PARAMETER (issue
  // [#2291](https://github.com/go-to-k/cdkd/issues/2291)).
  //
  // This is the DOWNWARD twin of the three arms above, and it is a cross-stack
  // leaf for exactly their reason: the value the leaf reads was produced by
  // ANOTHER stack's resolution. The parent resolves the child's `Parameters`
  // block and hands the child PLAINTEXT, so the child's source leaf is
  // `{Ref: <ParamName>}` -- an intrinsic OBJECT that carries no text about the
  // producer's `{{resolve:...}}` string at all. `intrinsicSkeletonPattern`
  // therefore cannot describe it (it has no literal segments to match a
  // candidate against), so before this arm the leaf fell to the plaintext-keyed
  // value scan. Two parameters resolving to ONE plaintext -- the same secret
  // and JSON key at two version-stage spellings, where `...:stage::` and
  // `...:stage:AWSCURRENT:` resolve identically -- therefore collapsed onto
  // whichever expression the parent recorded last, and `resolveReplayProps`
  // re-resolves the survivor, so `cdkd drift --revert` / rollback pushes the
  // WRONG secret VERSION to the live resource.
  //
  // BOTH SIDES COMPUTE FROM THE PARAMETER NAME. The writer is
  // {@link recordNestedStackParameterExpressions}, which keys the parent's
  // `Properties.Parameters` entries by NAME and reaches this function through
  // `crossStackSourceKey({ Ref: name })`; the persist path hands over the
  // child's template source leaf. Both are the same string by construction,
  // which is the property the `Fn::ImportValue` arm's note above is about.
  //
  // A `Ref` to a RESOURCE keys here too, and the reason that is safe is NOT the
  // one an earlier revision of this comment gave. It claimed CloudFormation
  // requires `Parameters` and `Resources` logical ids to be unique across one
  // template, so the two populations could not overlap. cdkd never submits a
  // template to CloudFormation, so it inherits no such validation, and
  // `IntrinsicFunctionResolver.resolveRef` gives a RESOURCE precedence over a
  // same-named PARAMETER -- so a colliding template resolves the RESOURCE while
  // this key still spells the parameter name, and the association IS reached
  // (measured in review).
  //
  // What actually fences it is {@link positionByCrossStackSource}'s conditions
  // 1 and 2: the leaf's resolved value must be a plaintext in THIS resource's
  // bag AND must equal the plaintext the association was recorded against. For
  // a `Ref` to a resource that value is the resource's PHYSICAL ID, so the
  // collision only certifies anything if a physical id is byte-identical to the
  // inherited secret -- at which point every plaintext-keyed path in this module
  // already rewrites it, and the answer taken is the expression that value was
  // genuinely resolved from. The guard is the VALUE test, not a namespace claim.
  //
  // A pseudo parameter (`{Ref: 'AWS::Region'}`) is likewise keyed and, unlike
  // the resource case, is verified inert: no writer ever records a pseudo name,
  // so the lookup always misses. It is deliberately NOT special-cased -- a name
  // test here would be a second spelling of "what the writer records", and the
  // writer is the authority.
  if (key === 'Ref') {
    const parameterName = literalStringOrUndefined(source[key]);
    if (parameterName === undefined) return undefined;
    return ['Ref', parameterName].join(CROSS_STACK_KEY_SEPARATOR);
  }

  return undefined;
}

/**
 * Remember, FOR THE PASS THAT OWNS `secrets`, that the cross-stack source leaf
 * keyed by `key` reads a producer value that IS the whole `{{resolve:...}}`
 * token `expression`, and that this pass saw it resolve to `plaintext`. Called
 * by the resolver, and only for a token it PROVED secret.
 *
 * `secrets` is the pass's own {@link RecordedSecretValues} bag, used as the
 * SCOPE KEY — the same object the redaction path will be handed. See
 * {@link crossStackAssociations} for why the scope, not the pairing, is what
 * makes this sound.
 */
export function recordCrossStackExpression(
  secrets: RecordedSecretValues,
  key: string,
  expression: string,
  plaintext: string
): void {
  // SHAPE INVARIANT, at the store boundary rather than at the caller. The two
  // payload parameters are both `string`, so the type system cannot see a
  // SWAPPED call — and a swap is not merely a wrong answer here: the reader
  // returns `expression` to be persisted, so a stored `{expression: <plaintext>}`
  // writes a SECRET into `state.json` as soon as a token-shaped bag satisfies
  // the conditions above it (the issue #1917 shape does). Unreachable from the
  // one caller today; this makes it unreachable from any caller, which is the
  // difference between a guarded call site and an invariant.
  //
  // It NARROWS rather than closes, and the residual is worth naming: a swap
  // whose plaintext is ITSELF a complete `{{resolve:...}}` token passes this
  // test, because issue #1917 exists precisely because a secret's VALUE can look
  // like one and nothing distinguishes them from the string alone. So this takes
  // a swap from "persists any secret" to "persists a token-shaped secret", and
  // the seam's own gate covers the rest.
  if (!isSingleDynamicReferenceToken(expression)) return;

  let associations = crossStackAssociations.get(secrets);
  if (associations === undefined) {
    associations = new Map();
    crossStackAssociations.set(secrets, associations);
  }
  storeAssociation(associations, key, expression, plaintext);
}

/**
 * The store's WRITE rule, shared by {@link recordCrossStackExpression} and
 * {@link recordNestedStackParameterExpressions} so the two tables cannot drift
 * apart on what a second sighting means.
 *
 * A key recorded against a DIFFERENT (expression, plaintext) pair is POISONED
 * to {@link CONFLICTING_CROSS_STACK} rather than overwritten; an already
 * poisoned key stays poisoned, because a third sighting cannot un-contradict
 * the first two. Every reader refuses a poisoned key, which degrades to the
 * value scan — today's behaviour — rather than guessing between the two.
 *
 * WHAT IS AND IS NOT FENCED, stated because a reader would otherwise assume the
 * whole thing is (review of issue #2291). The POISON-vs-OVERWRITE decision IS
 * fenced: a second sighting under a THIRD expression makes the two outcomes
 * differ (poison refuses and falls back; overwriting would certify the third),
 * and a case asserts it. Nothing fences the branch from
 * {@link recordNestedStackParameterExpressions}'s side in PRODUCTION, because
 * that writer runs once per resource bag and `Object.entries` cannot yield one
 * name twice — the poison is reachable only through this module's API. It is
 * kept as an INVARIANT, not claimed as covered behaviour.
 *
 * The `isSingleDynamicReferenceToken` shape invariant is deliberately NOT here:
 * it belongs to each writer, which is where the parameters are named and where
 * a swap could be introduced.
 */
function storeAssociation(
  associations: CrossStackAssociations,
  key: string,
  expression: string,
  plaintext: string
): void {
  const seen = associations.get(key);
  if (seen === undefined) {
    associations.set(key, { expression, plaintext });
    return;
  }
  if (typeof seen === 'symbol') return;
  if (seen.expression !== expression || seen.plaintext !== plaintext) {
    associations.set(key, CONFLICTING_CROSS_STACK);
  }
}

/**
 * The `AWS::CloudFormation::Stack` type string, named once because the recorder
 * below gates on it and the tests assert against the same population.
 *
 * DUPLICATED, deliberately: `intrinsic-function-resolver.ts` declares the same
 * literal under the same name (for the `Outputs.<Name>` re-resolution of issue
 * #2055). This module is a LEAF by design -- see the file header, it imports
 * nothing, because both the resolver and the deploy engine consume it -- so
 * importing that spelling would close a cycle, and exporting this one for the
 * resolver to import would make the leaf a source of values rather than of
 * pure functions. The two cannot drift into DISAGREEMENT in any way that
 * matters: an AWS resource type string is fixed by AWS, and a typo in either
 * copy makes that copy's gate simply never fire (no-op), never fire wrongly.
 */
const NESTED_STACK_RESOURCE_TYPE = 'AWS::CloudFormation::Stack';

/**
 * What a PARENT stack's resolution proved about each `Parameters` entry of an
 * `AWS::CloudFormation::Stack` row it is about to provision, keyed by the
 * child's PARAMETER NAME (issue
 * [#2291](https://github.com/go-to-k/cdkd/issues/2291)).
 *
 * WHY A THIRD STORE, when {@link crossStackAssociations} already holds
 * per-leaf associations. This one is OUTBOUND: it is written against the
 * PARENT's bag and describes leaves of the CHILD's template, so it has to be
 * transported across the engine boundary before any reader can use it. The
 * child's per-resource bag then receives those entries as ORDINARY
 * {@link crossStackAssociations} rows (see
 * {@link inheritNestedStackParameterAssociations}), which is what lets the
 * existing three-condition reader answer for them with no new arm.
 *
 * KEEPING THE TWO TABLES SEPARATE IS LOAD-BEARING, not tidiness. A child engine
 * that itself owns a grandchild `AWS::CloudFormation::Stack` row records the
 * GRANDCHILD's parameter names against the CHILD's bag — the same bag that
 * already carries the child's own INBOUND `Ref` associations. Writing both into
 * one table means a grandchild parameter sharing a NAME with a child parameter
 * poisons the child's entry (two expressions under one key), so a leaf that was
 * being certified correctly falls back to the value scan the moment a
 * same-named parameter appears one level down. Two tables make the collision
 * impossible rather than unlikely.
 *
 * A `WeakMap` keyed by the parent pass's own bag, for the reason
 * {@link crossStackAssociations} gives: the entries hold PLAINTEXT, and they
 * must not outlive the pass that fetched them.
 */
const nestedStackParameterExpressions = new WeakMap<RecordedSecretValues, CrossStackAssociations>();

/**
 * Record, for the pass that owns `secrets`, which `{{resolve:...}}` expression
 * each `Parameters` entry of a nested-stack row was resolved FROM (issue
 * #2291). No-op for every other resource type.
 *
 * THE EXPRESSIONS COME FROM THE POSITION PASS, not from `secrets`, and that is
 * the whole reason this works at all. `RecordedSecretValues` is keyed by
 * PLAINTEXT, so two parameters resolving to one value have already collapsed to
 * a single entry there by the time this runs — asking the map which expression
 * a given parameter came from returns the SURVIVOR for both. What has not
 * collapsed is the parent's own template: `Properties.Parameters.<Name>` still
 * holds each entry's own source leaf. So this walks the parent's resolved
 * parameter bag against that source with {@link redactSecretsForState}, which
 * is exactly the machinery the parent's persist path already uses and which
 * certifies PER LEAF (measured on this issue: the parent's own two properties
 * come out correct while the child's collapse onto one). Deriving the answer
 * from the positioner rather than restating its rules is what keeps this from
 * drifting away from the persist path.
 *
 * THE `rules` PARAMETER IS THE CALLER'S GENERATION CLAIM, not a knob. The
 * DEPLOY path passes {@link TEMPLATE_DERIVED_RULES} (the default): its source is
 * the parent's TEMPLATE, which can carry a PUBLIC `ssm:` reference that must
 * stay resolved (issue #1901) and which cannot certify the generation of
 * anything. The rollback REPLAY passes {@link STATE_DERIVED_RULES}, because its
 * source is the JOURNAL record — a persisted bag holding no public expressions,
 * and the same generation the bag was resolved from one statement earlier. That
 * is the identical pairing `redactRollbackRecord` already makes for the record
 * it positions, so the two replay walks now agree about what their source is.
 *
 * "No public expressions" carries the carve-out {@link PathSourceRules} states
 * and this note must not restate without it: `cdkd import` warns and persists
 * the RAW template intrinsic, so a public `ssm:` token CAN sit in a record. The
 * replay then CERTIFIES one the deploy default would refuse, at a cost bounded
 * to the issue #1901 class — a spurious UPDATE over a value state should hold
 * resolved, never a disclosure, since an expression is what gets persisted
 * either way. See the replay call sites for why gating on
 * {@link isKnownSecretExpression} is the wrong way to close it.
 *
 * FOUR REFUSALS, each degrading to today's behaviour (the child leaf falls to
 * the plaintext-keyed value scan):
 *
 * 1. REFUSAL — the resolved parameter value is not a WHOLE recorded plaintext.
 *    A parameter the parent built with an `Fn::Sub` merely EMBEDS the secret,
 *    so there is no single expression the child's leaf could be persisted as.
 *    It also bounds what this store HOLDS: an entry carries a plaintext, and
 *    remembering one this pass never resolved has no purpose.
 * 2. REFUSAL — the expression is not a single complete `{{resolve:...}}` token.
 *    The same test {@link recordCrossStackExpression} applies at its own
 *    boundary, spelled here because this writer populates a DIFFERENT table.
 *    This is what rejects an embedded case that survived refusal 1 (a value
 *    scan produced `postgres://u:{{resolve:...}}@host`, which is not a token).
 * 3. REFUSAL — the expression may never EQUAL the plaintext it is recorded
 *    against. The reader returns the expression to be PERSISTED, so an entry
 *    whose two halves coincide hands a SECRET back as though it were a
 *    reference.
 *
 *    THIS IS REACHABLE, and an earlier revision of this note called it an
 *    unreachable invariant and told the next reader not to try to fence it.
 *    That was wrong twice over: wrong on the fact, and wrong to assert it,
 *    because {@link plaintextIndexOf}'s own note records the rule that
 *    "asserting something cannot be fenced suppresses the attempt, so it needs
 *    the same evidence a fence does" -- and no such evidence existed. The
 *    reaching shape is the issue
 *    [#1917](https://github.com/go-to-k/cdkd/issues/1917) family: a
 *    SELF-REFERENTIAL secret, whose stored VALUE is byte-identical to its own
 *    `{{resolve:...}}` text, so the pass records `SELF -> SELF`. The route is
 *    NOT the value scan the old note named. It is {@link redactByPath}'s
 *    `!sourceIsSameGeneration && isSingleDynamicReferenceToken(bag)` arm, which
 *    returns `secrets.get(bag) ?? bag` -- and for a self-referential secret
 *    that IS the bag. Under {@link STATE_DERIVED_RULES} the same input arrives
 *    by the other door (`sourceIsSameGeneration` is true, so the arm takes
 *    `return source`, which is the same string again), so both callers reach it.
 *    Fenced by the self-referential case in
 *    `secret-redaction-nested-parameter-source.test.ts`.
 */
export function recordNestedStackParameterExpressions(
  secrets: RecordedSecretValues,
  resourceType: string,
  resolvedProperties: unknown,
  sourceProperties: unknown,
  rules: PathSourceRules = TEMPLATE_DERIVED_RULES
): void {
  if (resourceType !== NESTED_STACK_RESOURCE_TYPE) return;
  if (secrets.size === 0) return;
  if (!isPlainObject(resolvedProperties) || !isPlainObject(sourceProperties)) return;
  // `Object.hasOwn` for the reason the walks in this module use it: without it
  // the prototype chain can answer for a key a caller-constructed bag lacks.
  if (!Object.hasOwn(resolvedProperties, 'Parameters')) return;
  if (!Object.hasOwn(sourceProperties, 'Parameters')) return;
  const resolvedParameters = resolvedProperties['Parameters'];
  const sourceParameters = sourceProperties['Parameters'];
  if (!isPlainObject(resolvedParameters) || !isPlainObject(sourceParameters)) return;

  const positioned = redactSecretsForState(
    resolvedParameters,
    secrets,
    sourceParameters,
    rules
  ) as Record<string, unknown>;

  let table = nestedStackParameterExpressions.get(secrets);
  for (const [name, resolvedValue] of Object.entries(resolvedParameters)) {
    // Refusal 1.
    //
    // ITS STRING-ONLY HALF IS NOT A GAP, and this note exists so the next lane
    // does not "fix" it into certifying a shape production cannot deliver.
    // Issue [#2327](https://github.com/go-to-k/cdkd/issues/2327) was FILED
    // naming this test as the second broken half of the list-typed collapse,
    // beside the diff side. Measured against `NestedStackProvider` while fixing
    // that issue: `extractParameters` (`src/provisioning/providers/nested-stack-provider.ts`)
    // REFUSES a non-scalar parent-side parameter value outright -- "Parameters
    // must be scalars (string / number / boolean)" -- and it runs immediately
    // after this recorder, so an array `resolvedValue` here can never reach a
    // child engine at all. The parent therefore always hands the child a
    // STRING, and the ARRAY the issue is about is produced INSIDE the child by
    // its own `Type` coercion. That is why #2327 changed the two READ sides and
    // left this WRITE side exactly as it was.
    if (typeof resolvedValue !== 'string' || !secrets.has(resolvedValue)) continue;
    const expression = positioned[name];
    if (typeof expression !== 'string') continue;
    // Refusal 2.
    if (!isSingleDynamicReferenceToken(expression)) continue;
    // Refusal 2b — the position pass has to have CERTIFIED this leaf, not
    // merely fallen through to the value scan.
    //
    // `redactSecretsForState` returns a value either way, and for a leaf it
    // REFUSES it returns `secrets.get(resolvedValue)` — the collapsed map's
    // SURVIVOR. Recording that would store the survivor under the LOSING
    // parameter's name and label it certified, which is the collapse this whole
    // store exists to remove, arriving through the store itself.
    //
    // For a whole-token STRING source, "certified" has an exact spelling:
    // `redactByPath`'s source arm returns the SOURCE LEAF verbatim, so a
    // MISMATCH proves it did not fire. Not an iff, and the earlier wording said
    // so wrongly: the value scan COINCIDES with the source for the WINNING
    // parameter, whose survivor expression IS its own source leaf. The test is
    // therefore sound in the direction it is used -- it only ever REFUSES -- and
    // an entry it lets through on that coincidence is the survivor, which every
    // reader produces on a refusal anyway. Found by the `rules` probe: an `ssm`
    // reference whose `SecureString` verdict this process has not pinned fails
    // `isKnownSecretExpression` under {@link TEMPLATE_DERIVED_RULES}, takes the
    // public-reference branch, and value-scanned its way to the sibling's
    // expression — so the losing parameter of an unpinned ssm pair was recorded
    // against the WRONG reference.
    //
    // An INTRINSIC source has no such identity to test (both positioners return
    // a candidate on success and `undefined` on refusal, and the caller cannot
    // see which), so it is left as it is: there the fallback yields the survivor
    // too, which is exactly what every reader produces on a refusal anyway, so
    // the entry cannot change an answer.
    const sourceLeaf = sourceParameters[name];
    if (typeof sourceLeaf === 'string' && expression !== sourceLeaf) continue;
    // Refusal 3 — reachable via a self-referential secret; see the doc above.
    if (expression === resolvedValue) continue;
    // Refusal 4 — this pass SAW this expression resolve to something ELSE
    // (issue [#2327](https://github.com/go-to-k/cdkd/issues/2327) review).
    //
    // This is {@link certifiedExpressionForLeaf}'s condition 3, moved to WRITE
    // time, and the move is the whole point rather than an optimisation. That
    // condition reads the bag's VALUES through {@link plaintextIndexOf}, and
    // the two readers of this table hold DIFFERENT bags: the DIFF side gets the
    // parent's own map, the PERSIST side the issue #2087-scoped per-resource
    // child bag, whose values are each parameter's OWN expression. So the same
    // association could pass condition 3 on one side and fail it on the other
    // -- and it did. MEASURED over a sweep of bag configurations: with
    // `EXPR_A` also recorded against a DIFFERENT plaintext (the issue #1933
    // two-regions shape), the persist side certified `EXPR_A` while the diff
    // side refused and fell back to the survivor, on 4 of 16 configurations.
    //
    // The consequence is the one this whole store exists to prevent, one shape
    // over: the child persists the ONE expression this pass has direct evidence
    // resolves to a different plaintext, and `resolveReplayProps` re-resolves
    // it, so a rollback or `cdkd drift --revert` applies the WRONG secret.
    //
    // REFUSING IS CORRECT HERE, not a capitulation to the asymmetry. The
    // question "did this pass watch this expression resolve to something else"
    // is about the RESOLUTION, which happened in the PARENT -- so the parent's
    // map is the bag that can answer it, and the child's cannot: it holds only
    // what the parent handed down. Deciding once, here, is what makes the two
    // readers see the same table by construction rather than by two evaluations
    // agreeing. Both sides then degrade to the plaintext-keyed value scan
    // together, which is the pre-#2291 behaviour and the same answer they gave
    // before this arm existed.
    //
    // The read-time condition 3 STAYS. It still serves
    // {@link crossStackAssociations}'s other writers, which have no second
    // reader and no write-time twin, and for THIS family it is now belt and
    // braces -- on the diff side it is vacuous (same bag, same verdict), and on
    // the persist side it can only refuse, which the sweep below finds no
    // surviving association to do.
    const seenResolvingTo = plaintextIndexOf(secrets).get(expression);
    if (seenResolvingTo !== undefined && seenResolvingTo !== resolvedValue) continue;
    if (table === undefined) {
      table = new Map();
      nestedStackParameterExpressions.set(secrets, table);
    }
    storeAssociation(table, name, expression, resolvedValue);
  }
}

/**
 * Copy a parent pass's per-PARAMETER associations onto a nested-stack CHILD
 * resource's own bag, as ordinary {@link crossStackAssociations} rows keyed by
 * `{Ref: <ParamName>}` (issue #2291).
 *
 * Called by the child {@link DeployEngine} once per resolver context, so each
 * child resource's fresh bag carries them. Pre-seeding every resource this way
 * does NOT reintroduce issue #2087's over-redaction: an association can only
 * change an answer through {@link positionByCrossStackSource}'s condition 1,
 * which requires the bag leaf to be a plaintext THIS resource's bag holds — and
 * since #2087 that is true only of resources whose own resolution consumed the
 * parameter. The scoping still comes from the plaintext bag; this table only
 * decides WHICH expression such a leaf takes.
 *
 * Nothing is copied when the parent recorded nothing, which is every non-nested
 * caller and every nested one whose parameters carry no secret.
 */
export function inheritNestedStackParameterAssociations(
  childSecrets: RecordedSecretValues,
  parentSecrets: RecordedSecretValues
): void {
  const table = nestedStackParameterExpressions.get(parentSecrets);
  if (table === undefined || table.size === 0) return;
  let associations = crossStackAssociations.get(childSecrets);
  for (const [name, association] of table) {
    const key = crossStackSourceKey({ Ref: name });
    if (key === undefined) continue;
    if (associations === undefined) {
      associations = new Map();
      crossStackAssociations.set(childSecrets, associations);
    }
    // A poisoned parent entry is copied AS the poison, so the child refuses for
    // the same reason the parent could not answer.
    //
    // NO PRODUCTION PATH DISCRIMINATES THIS, which is a narrower claim than the
    // one an earlier revision made ("no test can") — and that one was FALSE,
    // disproved in review by constructing the case through this module's own
    // API. Copying the poison and dropping the entry differ as soon as anything
    // writes the SAME key on the child bag afterwards: with the copy the key
    // stays poisoned and the reader refuses, without it the later write lands on
    // an empty slot and CERTIFIES. `recordCrossStackExpression` is exactly such
    // a writer, so a test reaches it (and now does).
    //
    // Production cannot, because the resolver only ever builds a `sourceKey`
    // from `Fn::ImportValue` / `Fn::GetStackOutput` / `Fn::GetAtt` and never
    // from a `Ref`, so no production writer can collide with an inherited
    // parameter key. That is the same standard the sibling note on
    // {@link storeAssociation} uses — "reachable only through this module's
    // API" — and it is the accurate one here.
    if (typeof association === 'symbol') {
      associations.set(key, association);
      continue;
    }
    storeAssociation(associations, key, association.expression, association.plaintext);
  }
}

/**
 * The expression a nested-stack child's PARAMETER was resolved from, or
 * `undefined` when this pass cannot certify one (issue #2291).
 *
 * The DIFF-side twin of {@link positionByCrossStackSource}, and it must exist
 * or the fix trades one bug for another. The child's persisted state now holds
 * each parameter-fed leaf's OWN expression, so the desired side of the next
 * diff has to hold it too; the engine's `redactParametersForDiff` rewrites the
 * parameter bag through the plaintext-keyed map alone, which hands BOTH members
 * of a coinciding pair the survivor's expression. The two sides would then
 * never match for the losing parameter: a perpetual UPDATE on every deploy of
 * such a child, which is issue #2087's user-visible symptom arriving through a
 * different door.
 *
 * `parentSecrets` is the INHERITED bag — the parent's own per-resource map, the
 * object this table is keyed by — not the child resource's bag.
 *
 * The same THREE conditions the persist side applies, because it is literally
 * the same code: {@link certifiedExpressionForLeaf} OWNS the question and both
 * halves call it. See that function for why condition 3 is not subsumed by
 * condition 2.
 *
 * RETURNS AN ARRAY for a LIST-typed parameter (issue
 * [#2327](https://github.com/go-to-k/cdkd/issues/2327)), through the same
 * {@link certifiedListForLeaf} the persist side reaches from
 * {@link positionListByCrossStackSource}. `coerceParameterTypedValue` splits a
 * `CommaDelimitedList` parameter's STRING into an array before either side sees
 * it, so a scalar answer here would be compared against an array in state and
 * report a change forever — this function's own failure mode, one shape over.
 *
 * TWO CALLERS, and the widened return type is why the second one asks a
 * different question. `redactParametersForDiff` assigns the result into a
 * `Record<string, unknown>` and needs the whole parameter's answer, array
 * included. `IntrinsicFunctionResolver.recordInheritedParameterSecrets` writes
 * into a `Map<string, string>` keyed by PLAINTEXT, so it asks this per
 * PLAINTEXT — passing the carried plaintext rather than the parameter's value —
 * and keeps only a `string` answer. That is not a workaround for the type: a
 * plaintext-keyed bag has one slot per plaintext, and the question it needs
 * answered is "does THIS parameter certify THIS plaintext", which is the same
 * question for a scalar and for an element of a list.
 */
export function inheritedParameterExpression(
  parentSecrets: RecordedSecretValues,
  parameterName: string,
  resolvedValue: unknown
): string | unknown[] | undefined {
  const association = nestedStackParameterExpressions.get(parentSecrets)?.get(parameterName);
  if (association === undefined || typeof association === 'symbol') return undefined;

  // A LIST-typed parameter (issue #2327). `coerceParameterTypedValue` split the
  // parent's STRING into an array before this side ever saw it, so the answer
  // has to be an array too — a string here would make the desired side a scalar
  // against an array in state and report a change forever, which is the very
  // failure this function exists to prevent, one shape over.
  //
  // THE SAME {@link certifiedListForLeaf} THE PERSIST SIDE CALLS, not a second
  // spelling of it. The two halves have to agree element for element; sharing
  // the rule is what makes that a property of the code.
  if (Array.isArray(resolvedValue)) {
    return certifiedListForLeaf(parentSecrets, association, resolvedValue);
  }

  return certifiedExpressionForLeaf(parentSecrets, association, resolvedValue);
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
 *   deploy `redactOutputs` (3 sites)           template `Outputs`   TEMPLATE_SOURCED_RULES                VALUE SCAN
 *   `cdkd import` `properties`                 imported template    TEMPLATE_DERIVED_RULES                VALUE SCAN
 *   observed walk, template source             current template     TEMPLATE_SOURCED_RULES                VALUE SCAN
 *   `cdkd scrub` `properties`                  TODAY's template     TEMPLATE_SOURCED_RULES                VALUE SCAN
 *   `cdkd scrub` `outputs`                     TODAY's template     TEMPLATE_SOURCED_RULES                VALUE SCAN
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
 * (`src/deployment/intrinsic-function-resolver.ts`) scans with
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
 * NOT affected: they take `STATE_SOURCED_READBACK_RULES`, which sets
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
const DYNAMIC_REFERENCE_INNER_CHAR = '[^}]';

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Stands in for a source part the skeleton cannot know — an `Fn::Join` element
 * that is itself an intrinsic, or an `Fn::Sub` `${...}` variable.
 *
 * Built from {@link DYNAMIC_REFERENCE_INNER_CHAR} rather than `.` because a
 * recorded expression's INNER text never contains `}`: the resolver matches
 * them with `/\{\{resolve:([^}]+)\}\}/`, so the first `}` after `{{resolve:` is
 * already the terminator. Excluding it means a wildcard can never swallow one
 * token's terminator and run into the next, so a skeleton for ONE reference
 * cannot match a candidate built from a different one.
 *
 * Zero-or-more here, unlike {@link DYNAMIC_REFERENCE_INNER}: this stands in for
 * an unknown SPAN, which may legitimately be empty (an `Fn::Join` part that
 * resolved to `''`), whereas a token with no inner text is not a token.
 */
const SKELETON_WILDCARD = `${DYNAMIC_REFERENCE_INNER_CHAR}*`;

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

/** Poison for an expression this pass recorded against two different plaintexts. */
const CONFLICTING_PLAINTEXT = Symbol('conflicting plaintext');

/**
 * Walk a {@link RecordedSecretValues} the OTHER way: every expression the pass
 * recorded, against the plaintext it actually resolved to.
 *
 * This is condition 3's index, built ONCE per positioning call rather than
 * re-scanned per candidate. A collapsed LOSER is absent from it, which is the
 * case both callers exist to serve.
 *
 * It is NOT an inversion, because `secrets` need not be injective — one
 * expression CAN appear under two plaintexts. Taking the last such plaintext
 * would WEAKEN condition 3 (the scan it replaced refused when ANY entry
 * disagreed with `bag`), so a conflicting expression is poisoned to a sentinel
 * no bag can equal, which refuses it exactly as the scan did.
 *
 * The branch is HARD to reach from the resolver — one resolver's
 * `cachedDynamicReferences` yields one plaintext per expression, so a single
 * pass cannot produce two — but it is no longer unreachable from there since
 * that cache became per-resolver (issue #1933): two resolvers in two regions
 * legitimately resolve one expression to two different plaintexts, and a caller
 * merging their maps lands exactly here. It is reachable through this module's
 * API regardless, and it is FENCED, by the "recorded against MORE THAN ONE
 * plaintext" case. An earlier draft of this comment claimed the divergence was
 * unobservable, reasoning that `plaintextOf[E] === bag` implies
 * `secrets.get(bag) === E` so accepting and falling back agree. That misses the
 * case where a SECOND candidate also matches: accepting `E` then makes it two
 * matches, which condition 2 refuses, and the answers differ. Asserting
 * something cannot be fenced suppresses the attempt, so it needs the same
 * evidence a fence does.
 *
 * `has` is the whole test: `RecordedSecretValues` is keyed by plaintext, so
 * iterating it never yields one plaintext twice and a second sighting of an
 * expression is always a DIFFERENT plaintext.
 *
 * SHARED by {@link positionByIntrinsicSkeleton} and
 * {@link positionByCrossStackSource} (issue #2059) rather than copied into the
 * second: the poisoning rule is the subtle half of condition 3, and two copies
 * are two places for it to be relaxed independently.
 */
function plaintextIndexOf(secrets: RecordedSecretValues): Map<string, string | symbol> {
  const plaintextOf = new Map<string, string | symbol>();
  for (const [plaintext, expression] of secrets) {
    plaintextOf.set(expression, plaintextOf.has(expression) ? CONFLICTING_PLAINTEXT : plaintext);
  }
  return plaintextOf;
}

/**
 * THE THREE CONDITIONS, in ONE place, over one bag and one already-resolved
 * association (issue [#2327](https://github.com/go-to-k/cdkd/issues/2327)).
 *
 * Three call sites ask this same question and every one of them must answer it
 * identically or the PERSIST side and the DIFF side disagree — which is not a
 * hypothetical: the two halves must produce the same expression for the same
 * leaf, or the desired side of the next diff never matches what was persisted
 * and the resource reports a change on every deploy (issue #2087's symptom,
 * arriving through a second spelling of one predicate). The sites are
 * {@link positionByCrossStackSource} (persist, string leaf),
 * {@link certifiedListForLeaf} (persist and diff, list leaf) and
 * {@link inheritedParameterExpression} (diff, whole parameter). THIS FUNCTION
 * OWNS THE QUESTION; none of them re-spells it.
 *
 * 1. The leaf's WHOLE value is a recorded secret plaintext. A leaf that merely
 *    EMBEDS a secret is not this shape and must keep going to the value scan,
 *    which rewrites just the substring. This is also what keeps a PUBLIC
 *    reference out (issue #1901): the resolver records a plaintext only on a
 *    proven-secret verdict, so a public parameter's value is not a key here.
 *    The empty string is excluded for the reason the value pass excludes it: it
 *    is not a distinguishing value.
 * 2. The association is ABOUT THIS LEAF — the plaintext the WRITER recorded
 *    beside the expression equals the leaf. Within one pass this is the only
 *    guard against a bag/source MISALIGNMENT: a readback bag can hold a
 *    DIFFERENT resource's secret while the source leaf still spells this
 *    import, and condition 3 cannot refuse that (it must ACCEPT an expression
 *    absent from the pass's map, since the collapsed loser is absent too).
 * 3. The match is not DEMONSTRABLY another value's expression, over the
 *    {@link plaintextIndexOf} index. NOT subsumed by condition 2: that one
 *    compares what the WRITER recorded, this one what THIS pass's own map
 *    holds, and they can disagree when one reference answers differently in two
 *    regions (issue #1933). The collapsed LOSER is absent from the index, so it
 *    passes — which is the case this whole mechanism exists to serve.
 */
function certifiedExpressionForLeaf(
  secrets: RecordedSecretValues,
  association: CrossStackAssociation,
  leaf: unknown
): string | undefined {
  // Condition 1.
  if (typeof leaf !== 'string' || leaf === '') return undefined;
  if (!secrets.has(leaf)) return undefined;
  // Condition 2.
  if (association.plaintext !== leaf) return undefined;
  // Condition 3.
  const recordedPlaintext = plaintextIndexOf(secrets).get(association.expression);
  if (recordedPlaintext !== undefined && recordedPlaintext !== leaf) return undefined;
  return association.expression;
}

/**
 * Apply {@link certifiedExpressionForLeaf} to every ELEMENT of a list leaf
 * (issue [#2327](https://github.com/go-to-k/cdkd/issues/2327)).
 *
 * WHAT "POSITION" MEANS FOR A LIST ELEMENT, which is the question that killed
 * the earlier attempt in issue #2012 and has to be answered before any array
 * may be certified: **it is not the index.** There is no source ARRAY to align
 * against — a list leaf's source is ONE intrinsic standing for the whole list —
 * so an index-based pairing would have nothing on the other side to pair WITH,
 * and inventing one is exactly the fabrication issue #2012 refused. What
 * certifies an element is its OWN VALUE, through condition 1 and condition 2
 * above. Order is therefore irrelevant: a reordered array certifies
 * identically, and an element the conditions do not reach is left exactly where
 * the value scan would have left it.
 *
 * NOTHING IS FABRICATED. The output array has the SAME length and the SAME
 * element ORDER as the input; every element is either an expression certified
 * from that element's own recorded plaintext, or the value-scan answer this
 * module already produces for it. No element is added, dropped, reordered, or
 * copied from the source — so there is no baseline content here that
 * `cdkd drift --revert` could push to AWS but AWS never reported. That is the
 * constraint the issue #2012 review imposed, satisfied structurally rather than
 * argued around.
 *
 * SHARED BY BOTH HALVES, and that sharing is load-bearing rather than tidy: the
 * persist side reaches it through {@link positionListByCrossStackSource} and
 * the diff side through {@link inheritedParameterExpression}, with the same
 * association content on either side ({@link inheritNestedStackParameterAssociations}
 * copies the parent's rows onto the child bag). Two spellings that agreed on
 * every case but one would reintroduce the perpetual UPDATE at that one case.
 *
 * Returns `undefined` when NO element was certified, so every caller falls
 * through to the value scan and keeps its identity-return: with an empty
 * secrets map (the issue #1900 unchanged-resource path) condition 1 refuses
 * every element, so this costs one walk and changes nothing.
 */
function certifiedListForLeaf(
  secrets: RecordedSecretValues,
  association: CrossStackAssociation,
  bag: readonly unknown[]
): unknown[] | undefined {
  // CERTIFY FIRST, and only then build the output. The refusal path is the
  // COMMON one -- every leaf whose source keys to an association but whose
  // elements are public, and every array on a pass with an empty bag -- and
  // `redactSecretsForState` rebuilds a needle regex per call, so mapping the
  // whole array before discovering nothing was certified cost N regex builds
  // that {@link redactByPath} then paid again on its own fallback scan.
  const certified = bag.map((element) => certifiedExpressionForLeaf(secrets, association, element));
  if (certified.every((expression) => expression === undefined)) return undefined;
  return bag.map((element, i) => certified[i] ?? redactSecretsForState(element, secrets));
}

/**
 * The association {@link crossStackAssociations} holds for a SOURCE leaf, or
 * `undefined` when this pass has none (or a poisoned one) for it.
 */
function associationForSource(
  source: Record<string, unknown>,
  secrets: RecordedSecretValues
): CrossStackAssociation | undefined {
  const key = crossStackSourceKey(source);
  if (key === undefined) return undefined;
  // THIS PASS's associations and no others. A pass that recorded nothing —
  // `cdkd state refresh-observed`, whose bag is empty by construction — finds
  // no bucket and falls through, which is the same answer it gets today.
  const associations = crossStackAssociations.get(secrets);
  if (associations === undefined) return undefined;
  // A poisoned key reads back as the symbol, so this refuses an absent
  // association and a conflicting one in one move.
  const association = associations.get(key);
  if (association === undefined || typeof association === 'symbol') return undefined;
  return association;
}

/**
 * Position a leaf whose SOURCE is a CROSS-STACK intrinsic object
 * (`Fn::ImportValue` / `Fn::GetStackOutput`), by looking its identity up in the
 * association the RESOLVER recorded while it read the producer (issue
 * [#2059](https://github.com/go-to-k/cdkd/issues/2059)).
 *
 * This is the residual {@link positionByIntrinsicSkeleton} leaves behind, and
 * it needs a different mechanism rather than one more skeleton arm.
 * {@link intrinsicSkeletonPattern} is a TEXT matcher over the source leaf's
 * literals, and these two intrinsics carry no text about their expression at
 * all: `Fn::ImportValue`'s only literal is the export NAME, and
 * `Fn::GetStackOutput`'s are `StackName` / `OutputName` / `Region`, none of
 * which bears any relation to the producer's `{{resolve:...}}` string. A
 * pure-wildcard skeleton is not a fallback either — {@link SKELETON_WILDCARD}
 * is `[^}]*`, which cannot cross a token's own `}}` — so it would match zero
 * candidates and always refuse, i.e. degrade to the collapse. The association
 * has to come from the one place that holds both halves at once, which is
 * {@link crossStackAssociations}.
 *
 * THE THREE CONDITIONS ARE {@link certifiedExpressionForLeaf}'s and are stated
 * ONLY there. They were re-enumerated here until issue #2327 extracted the
 * owner, and the copy had already drifted from it three ways within the same
 * change -- it dropped the empty-string clause, it explained condition 2 by a
 * scoping story ({@link crossStackAssociations} being per-pass) that is not the
 * owner's OTHER caller's, and it said "three intrinsic spellings" when
 * {@link crossStackSourceKey} answers for five. A rationale that drifts inside
 * one PR is the argument against duplicating it.
 *
 * There is deliberately NO "exactly one candidate" test (the neighbour's
 * condition 2): this is a LOOKUP rather than a search, so the ambiguity that
 * test exists to catch shows up here as a key recorded against two different
 * associations, which {@link recordCrossStackExpression} already poisons at
 * WRITE time.
 *
 * WHY THIS IS A POSITION CERTIFICATION AND NOT A WIDENING. The issue #1915
 * fences rejected an earlier attempt that took the SOURCE subtree whenever the
 * bag could not be vouched for, because it rewrote a `{Name: '', Value:
 * 'an-unrelated-literal'}` pair. Nothing here can do that: the answer is never
 * the source subtree, it is an expression a WRITER recorded against this exact
 * leaf identity; the arm fires only for the spellings
 * {@link crossStackSourceKey} can key; and
 * condition 1 still demands that the bag leaf be a plaintext this pass
 * resolved. Every rejection degrades to {@link positionByIntrinsicSkeleton} and
 * then to the value scan, i.e. to today's behavior.
 */
function positionByCrossStackSource(
  bag: string,
  source: Record<string, unknown>,
  secrets: RecordedSecretValues
): string | undefined {
  const association = associationForSource(source, secrets);
  if (association === undefined) return undefined;
  // The three conditions live in ONE place (issue #2327). An earlier revision
  // spelled them here and again on the diff side; keeping one owner is what
  // makes "the two halves agree" a property of the code rather than of a
  // reviewer noticing.
  return certifiedExpressionForLeaf(secrets, association, bag);
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

  const plaintextOf = plaintextIndexOf(secrets);

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
 * The ONE-span frame shared by {@link positionByEmbeddedSpan} and
 * {@link learnMixedLeafNeedle}: a source holding exactly one `{{resolve:...}}`
 * token, and a bag that starts with the source's prefix and ends with its
 * suffix with something non-empty between them that is NOT itself a complete
 * token (an already-redacted record is a persisted answer, not a plaintext).
 * `undefined` for any other shape. One helper rather than two copies so the
 * two refusals cannot drift apart.
 */
function singleSpanFrame(
  bag: string,
  source: string
): { token: string; prefix: string; suffix: string; middle: string } | undefined {
  const spans = dynamicReferenceSpans(source);
  if (spans.length !== 1) return undefined;
  const [span] = spans as [{ start: number; end: number }];
  const token = source.slice(span.start, span.end);
  const prefix = source.slice(0, span.start);
  const suffix = source.slice(span.end);
  if (bag.length <= prefix.length + suffix.length) return undefined;
  if (!bag.startsWith(prefix) || !bag.endsWith(suffix)) return undefined;
  const middle = bag.slice(prefix.length, bag.length - suffix.length);
  if (isSingleDynamicReferenceToken(middle)) return undefined;
  return { token, prefix, suffix, middle };
}

/**
 * Position a literal source leaf that EMBEDS exactly one `{{resolve:...}}`
 * token — `postgres://app-svc:{{resolve:ssm-secure:NAME}}@db/app` — by the
 * span the source states, writing `prefix + token + suffix` (issue
 * [#2485](https://github.com/go-to-k/cdkd/issues/2485)).
 *
 * WHY THE VALUE SCAN IS NOT ENOUGH HERE. The scan writes the map's surviving
 * expression for a plaintext, and the map keeps one expression per plaintext:
 * a whole-value `NAME:1` sibling that resolved LAST leaves `NAME:1` as the only
 * expression for the value, so the embedded leaf persists the versioned
 * spelling for a template that spells `NAME`, and the deploy diff — expression
 * against expression — reports that leaf on every run. The whole-token arm of
 * {@link redactByPath} is immune because it copies its own source; this arm
 * gives the one-span literal leaf the same immunity.
 *
 * THE EVIDENCE, and why the shape of the frame is not enough on its own: the
 * frame check (`bag` starts with the source's prefix and ends with its suffix,
 * with something between) is what {@link learnMixedLeafNeedle} already uses to
 * LEARN a needle, and it proves only that the bag has the source's shape. The
 * bag can also be a PREVIOUS generation's (`cdkd scrub`, a state-sourced walk)
 * with an earlier plaintext framed exactly like this, and writing today's
 * token over it would record an expression that was never deployed at that
 * position — the hazard `sourceIsSameGeneration` exists for on the whole-token
 * arm. So the middle must EQUAL what THIS pass recorded the source token
 * resolving to ({@link recordResolvedPair}, per map instance): that is evidence
 * of this resolution, not of shape, and it is absent by construction for every
 * bag this pass did not produce. It is also what keeps a PUBLIC `ssm` token
 * resolved (issue #1901) — the resolver records only secret verdicts — and what
 * keeps a mask-only `NoEcho` value out (never recorded).
 *
 * WHAT THIS EVIDENCE DOES NOT CLAIM, stated because a reviewer asked: it does
 * not prove the bag was produced FROM this source. A previous generation's bag
 * whose framed middle happens to EQUAL a plaintext this pass resolved the
 * source token to (`cdkd scrub` walking an old record against today's template,
 * or a failed deploy persisting an old bag) takes this arm and persists TODAY's
 * expression at that position. That is not a new claim: the value scan the
 * arm replaces rewrites that same plaintext onto one of THIS pass's expressions
 * regardless of generation — the map holds no other — so the class of answer
 * is unchanged and only the choice within it improves (the source's own
 * token rather than the map's survivor). The generation hazard this arm must
 * not create is the whole-token arm's: a middle that is ALREADY an expression
 * (a persisted answer from another generation), which the token refusal below
 * keeps out — and, by the same argument, any leaf the value scan would NOT
 * rewrite to exactly `prefix + survivor + suffix`: a middle shorter than the
 * scan's needle floor (an embedded 1-3 character secret stays the scan's
 * documented residual — issue #2516 tracks closing it with a bound that
 * proves the bag's generation, which this evidence does not), a whole leaf
 * that is itself another recorded plaintext, a needle starting in the prefix
 * and overlapping the middle. The
 * arm checks that equivalence against the scan's own answer rather than
 * re-deriving the scan's rules. Pinned by the cross-generation cases in
 * `secret-redaction-embedded-span.test.ts`.
 *
 * One shape reaches this arm that a reader may not expect: a WHOLE-token
 * source that FAILED the whole-token arm's `isKnownSecretExpression` gate (an
 * `ssm` token whose type came back unclassifiable and which lost the map slot
 * to a sibling). Its "frame" is empty, and if this pass recorded it resolving
 * to the bag it is written back as itself — an expression, and the leaf's own,
 * where the scan wrote the survivor. Stated so it is not mistaken for a leak.
 *
 * Everything else keeps the pre-#2485 fall-through: two or more spans (which
 * span produced which value is genuinely ambiguous when they share one), an
 * `Fn::Sub` / `Fn::Join` source (an object, not this arm at all — issue #2320's
 * placeholder primitive), a frame mismatch, a middle that is itself a complete
 * token (an already-redacted record, per the same refusal
 * {@link learnMixedLeafNeedle} makes), and a middle this pass cannot vouch for.
 *
 * The frame is copied from the SOURCE, not scanned. A needle occurring in the
 * literal frame would be a reference the template never had at that offset —
 * the fabricated-baseline direction {@link preferPositionDecisions} refuses —
 * and the whole-token arm returns its source unscanned for the same reason.
 *
 * RETURNS THE VALUE SCAN'S ANSWER ON EVERY REFUSAL, not `undefined`: the scan
 * is computed once, here, for `(bag, secrets)` — the arm's bound below compares
 * against it, and every fall-through IS it — so the compared value provably
 * comes from the same bag and map the arm positions. An earlier revision took
 * the scan as a parameter, which left the bound one wrong caller away from
 * comparing against a scan of some other bag with no type error.
 */
function positionByEmbeddedSpan(
  bag: string,
  source: string,
  secrets: RecordedSecretValues
): string {
  const scanned = redactSecretsForState(bag, secrets);
  const frame = singleSpanFrame(bag, source);
  if (frame === undefined) return scanned;
  const { token, prefix, suffix, middle } = frame;
  const recorded = resolvedPlaintextOf(secrets, token);
  if (recorded === undefined || recorded !== middle) return scanned;
  // THE SAME CLASS OF ANSWER AS THE VALUE SCAN, proven rather than argued: the
  // arm accepts only a leaf the scan itself would rewrite to
  // `prefix + <the map's survivor for the middle> + suffix` — the middle and
  // nothing else. That is what makes the substitution a CHOICE among this
  // pass's expressions rather than a new claim: below the scan's needle floor
  // the scan leaves the middle alone (so does this arm); where another
  // recorded plaintext matches the WHOLE leaf, or starts in the prefix and
  // overlaps the middle, the scan's whole-value / leftmost precedence picks
  // that needle instead (so does this arm, by falling through to it). See the
  // generation note in the docstring for why this bound matters.
  const survivor = secrets.get(middle);
  // A type-narrowing formality, not a reachable refusal: `recorded === middle`
  // already implies an entry for `middle` — both resolver seams `set` the
  // entry beside `recordResolvedPair`, the one `mergeResolvedPairs` caller
  // copies the entries first, and nothing deletes from a `RecordedSecretValues`
  // map. Kept in the fail-closed shape rather than as a non-null assertion.
  if (survivor === undefined) return scanned;
  if (scanned !== prefix + survivor + suffix) return scanned;
  return prefix + token + suffix;
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
 * - **Arrays of arrays.** `M: [[{Name, Value}]]` pairs nothing HERE, because the
 *   OUTER elements are arrays rather than plain objects and have no identity
 *   field to key on. Blind positional descent into the outer list would
 *   reintroduce the order assumption this function exists to avoid. On the
 *   READBACK paths it is no longer a dead end:
 *   {@link refuseUncertifiedReadbackPositions} (issue #2012) walks the outer
 *   list positionally when {@link unkeyedArrayPairsByAnchors} says the inner
 *   elements' own anchors vouch for the alignment, which meets the order
 *   objection instead of ignoring it. The gate decides; it does not walk. Everywhere else — and whenever
 *   those anchors do not match — the shape still falls to the value scan.
 */
function identityKeyFor(bag: readonly unknown[], source: readonly unknown[]): string | undefined {
  for (const key of ARRAY_IDENTITY_KEYS) {
    if (isUniquelyKeyedBy(bag, key) && isUniquelyKeyedBy(source, key)) return key;
  }
  return undefined;
}

/**
 * Position the ELEMENTS of an array leaf whose SOURCE is an intrinsic OBJECT,
 * by the same leaf-identity lookup {@link positionByCrossStackSource} performs
 * for a string leaf (issue
 * [#2327](https://github.com/go-to-k/cdkd/issues/2327)).
 *
 * A child parameter declared `CommaDelimitedList` is coerced by
 * `coerceParameterTypedValue` into an ARRAY before any of this runs, so a
 * leaf the child template spells `{Ref: <Param>}` arrives beside an intrinsic
 * OBJECT as an array — a shape NO arm matched, which dropped it to the
 * plaintext-keyed value scan and handed BOTH members of a coinciding pair the
 * survivor's expression. `docs/cli-reference.md` names `CommaDelimitedList` as
 * an ALLOWED spelling for a secret-bearing nested-stack parameter, so it is
 * reachable rather than theoretical.
 *
 * The element rule, what it refuses and why nothing is fabricated all live on
 * {@link certifiedListForLeaf}, which the DIFF side calls too. TWO further
 * refusals belong to THIS site rather than to the shared rule:
 *
 * 1. REFUSAL — a source leaf {@link crossStackSourceKey} cannot key, or one
 *    this pass recorded no association for. Both fall to the value scan, i.e.
 *    to today's behaviour.
 * 2. REFUSAL — {@link positionByIntrinsicSkeleton} is deliberately NOT tried
 *    element-wise, and the asymmetry with the string arm is structural rather
 *    than caution. {@link intrinsicSkeletonPattern} accepts exactly `Fn::Join`
 *    and `Fn::Sub`, both of which produce a STRING; an array bag beside one of
 *    them is a SHAPE DIVERGENCE, not a position. Matching a per-element pattern
 *    built from text that describes the whole joined string would be a guess of
 *    precisely the kind condition 2 of that function exists to refuse.
 *
 * NOT GATED ON `rules`, for the reason the string arm next door is not: the
 * certification rests on the element being a plaintext THIS pass recorded,
 * which a previous generation's persisted expression can never be, and it never
 * depends on the two sides being positionally aligned. In practice only the
 * TEMPLATE-sourced walks can reach it at all — every STATE-sourced source leaf
 * is a persisted value, not an intrinsic object — but the safety does not rest
 * on that.
 */
function positionListByCrossStackSource(
  bag: readonly unknown[],
  source: Record<string, unknown>,
  secrets: RecordedSecretValues
): unknown[] | undefined {
  const association = associationForSource(source, secrets);
  if (association === undefined) return undefined;
  return certifiedListForLeaf(secrets, association, bag);
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
 * A source leaf that is an intrinsic OBJECT has no string to copy, so it goes
 * through two positioning passes before the value scan, in this order:
 *
 * - {@link positionByCrossStackSource} (issue #2059), for the two CROSS-STACK
 *   spellings `Fn::ImportValue` / `Fn::GetStackOutput`. Those carry no text
 *   about their expression at all, so the skeleton below structurally cannot
 *   describe them; instead the RESOLVER recorded, while reading the producer,
 *   which `{{resolve:...}}` token this exact leaf identity reads.
 * - {@link positionByIntrinsicSkeleton} (issue #1916), for `Fn::Join` /
 *   `Fn::Sub`: when the intrinsic's literal parts describe exactly one of the
 *   recorded secret expressions, THAT is persisted. This is the dominant CDK
 *   shape — an L2 secret token renders the ARN as a `Ref`, hence a join.
 *
 * An ARRAY leaf beside such an intrinsic OBJECT — the shape a
 * `CommaDelimitedList` nested-stack parameter produces once the child has
 * coerced it — is positioned ELEMENT-WISE by
 * {@link positionListByCrossStackSource} (issue #2327). What certifies an
 * element there is its own recorded plaintext rather than its index, so nothing
 * is aligned against a source array that does not exist; see that function for
 * the two shapes it refuses.
 *
 * The value scan is still applied wherever none can answer: a leaf that merely
 * EMBEDS a secret inside surrounding text, an intrinsic whose skeleton matches
 * zero or several candidates, a cross-stack leaf whose identity is not
 * literally computable, a diverged shape, a key the source lacks. So the passes
 * are complementary rather than alternatives — path where position is knowable,
 * association where the position is a cross-stack read, skeleton where it is a
 * describable intrinsic, value where none is.
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
      // WHOLE-VALUE, not the full value scan, and the difference WAS a defect
      // this went through once: the scan's other arm rewrote a secret found as
      // a SUBSTRING, and this leaf is a complete `{{resolve:...}}` token, so a
      // short secret VALUE occurring inside it (an ssm SecureString holding
      // `prod`, against `{{resolve:secretsmanager:prod/db:SecretString:pw}}`)
      // was spliced INTO the token. That mangles a persisted expression on
      // every `cdkd scrub` over already-clean state — full map, bag of
      // expressions by construction — and the replay then re-resolves the
      // wreckage, whose `[^}]+` stops at the first `}`, into a request for a
      // bogus secret id.
      //
      // The scan no longer does that to a leaf of THIS shape since issue
      // [#1935](https://github.com/go-to-k/cdkd/issues/1935) — it keeps a match
      // that lies STRICTLY INSIDE a complete `{{resolve:...}}` span, and a
      // whole-token leaf is one span end to end, so every match in it is either
      // strictly inside (kept) or coextensive with it, and coextensive means
      // the whole leaf, which the whole-value arm above already answered. So
      // this arm and the full scan now agree here for TWO independent reasons
      // rather than one.
      //
      // NOT "never rewrites inside a span", which an earlier revision of this
      // comment said: a needle that STRADDLES or CONTAINS a span does consume
      // span text, deliberately, because refusing it left the plaintext in
      // state. The exception is about a match SHORTER than the span it sits
      // in — see {@link scanLeaf}'s own table. Both guards are still spelled
      // out, and neither may be removed by editing only the other: each has its
      // own probe.
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
    // A literal leaf EMBEDDING one token, positioned by the span its source
    // states — exact where the value scan is ambiguous (issue #2485). On every
    // refusal (a public reference, an embedded token this pass cannot vouch
    // for) the arm returns the value scan of the leaf itself, computed once
    // inside it, so a secret embedded beside the token is still redacted.
    return positionByEmbeddedSpan(bag, source, secrets);
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
    //
    // The CROSS-STACK arm runs FIRST (issue #2059). It answers for the
    // spellings the skeleton pass structurally cannot describe
    // (`Fn::ImportValue` / `Fn::GetStackOutput` carry no text about their
    // expression, and a nested-stack child's `{Ref: <Param>}` carries none
    // either — issue #2291), so the two are disjoint rather than competing today; the
    // order is what keeps them disjoint if the skeleton ever gains a
    // wildcard-only arm, since a lookup against a recorded leaf identity is
    // strictly better evidence than a pattern that matched everything.
    const certified = positionByCrossStackSource(bag, source, secrets);
    if (certified !== undefined) return certified;
    const positioned = positionByIntrinsicSkeleton(bag, source, secrets, secretExpressions);
    if (positioned !== undefined) return positioned;
    // Fall through to the value scan below on any refusal.
  }
  if (Array.isArray(bag) && isPlainObject(source)) {
    // The LIST-VALUED twin of the arm above (issue #2327). A child parameter
    // declared `CommaDelimitedList` is coerced by `coerceParameterTypedValue`
    // into an ARRAY before any of this runs, so a
    // leaf the child template spells `{Ref: <Param>}` arrives here as an array
    // beside an intrinsic OBJECT — a shape NO arm matched, which dropped it to
    // the plaintext-keyed value scan and handed BOTH members of a coinciding
    // pair the survivor's expression. That is issue #2291's collapse arriving
    // through the one door its string-only arms left open, and
    // `docs/cli-reference.md` names `CommaDelimitedList` as an ALLOWED spelling
    // for a secret-bearing nested-stack parameter, so it is reachable rather
    // than theoretical.
    //
    // See {@link positionListByCrossStackSource} for what POSITION means for an
    // element and for the two shapes this deliberately REFUSES.
    const positionedList = positionListByCrossStackSource(bag, source, secrets);
    if (positionedList !== undefined) return positionedList;
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
    //
    // "CANNOT mis-align" is a claim about THIS pairing — equality on a field
    // unique across both sides — and not about position generally. The anchor
    // pass in `refuseUncertifiedReadbackPositions` pairs by position and CAN
    // mis-align if its evidence is weak, which is why it carries a uniqueness
    // rule of its own (`unkeyedArrayPairsByAnchors`) rather than inheriting
    // this one's guarantee. Reading that guarantee as covering both is exactly
    // the mistake the #2012 review measured.
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

/**
 * Every complete `{{resolve:...}}` token inside a string.
 *
 * This was a FOURTH spelling of the token pattern (`[^{}]*`, global) and is
 * built from {@link DYNAMIC_REFERENCE_INNER} since issue #1936, so it agrees
 * with the resolver like every other predicate here.
 *
 * EXPORTED, and `drift.ts`'s `survivingDynamicReferences` calls it rather than
 * re-spelling the scan (issue #2088 review). The character CLASS was shared
 * from #1936, but the assembled PATTERN was still byte-duplicated in the two
 * files — which is how a later flag or anchor change re-forks exactly the way
 * the four spellings did.
 *
 * The pattern is a module-level constant. An earlier revision built a fresh
 * `RegExp` per call, justified as "a shared global instance carries
 * `lastIndex` between callers" — that is FALSE for this use and was measured:
 * `String.prototype.match` with a `/g` pattern sets `lastIndex` to 0 on entry
 * and leaves it 0, so no state crosses callers. The per-call construction was
 * compiling a pattern per string leaf at the persist choke point, which walks
 * every record. Do NOT call `.exec` / `.test` on this constant — those DO
 * advance `lastIndex`, which is exactly why the shared instance is safe only
 * for `.match`.
 *
 * Widening it changes one answer, in the SAFE direction for BOTH readers.
 *
 * `drift.ts`'s `survivingDynamicReferences` is the reader that is easy to
 * forget, because it lives in another file — it feeds the survivor REPORT
 * (`onUnresolved`, and through it the `unresolvedToken` cause), so seeing MORE
 * tokens can only report more, never less. Do not shorten this to "the only
 * reader": that sentence is what a later editor uses to bound the blast
 * radius of touching the class, and getting it wrong points them away from
 * the report / `--json` / `--accept` path where an unreported survivor would
 * surface.
 *
 * The other reader is the DECLARED direction for issue #1901:
 * {@link mixedLeafMayCarryPublicReference}, which asks whether a MIXED leaf
 * embeds a `{{resolve:ssm:` token the verdict store does not know. A token
 * carrying a `{` inside it used to be INVISIBLE here, so such a leaf was
 * always treated as secret-bearing and the source expression was substituted
 * over the resolved value. Now it is seen and classified by the same rule as
 * every other token — which, on a POPULATED map, means a genuinely public ssm
 * parameter keeps the resolved value it is supposed to keep.
 */
export const DYNAMIC_REFERENCE_TOKEN_SCAN = new RegExp(
  `\\{\\{resolve:${DYNAMIC_REFERENCE_INNER}\\}\\}`,
  'g'
);

export function dynamicReferenceTokens(value: string): string[] {
  return value.match(DYNAMIC_REFERENCE_TOKEN_SCAN) ?? [];
}

/**
 * Where each complete `{{resolve:...}}` token sits in the string, as
 * `[start, end)` offsets. The OFFSETS are what {@link dynamicReferenceTokens}
 * cannot give, and the value scan needs them to decide whether a needle match
 * lies inside a reference or merely beside one.
 *
 * `lastIndex` is reset before `matchAll`, and that is load-bearing rather than
 * defensive. `String.prototype.matchAll` does not MUTATE the pattern's
 * `lastIndex` — it clones — but it SEEDS the clone from it, so a caller that
 * left the shared constant dirty (the constant's own doc forbids `.exec` /
 * `.test` on it for exactly this reason) would make this function skip every
 * span before that offset, silently restoring the splice this offsets are used
 * to prevent. Measured, not assumed.
 */
function dynamicReferenceSpans(value: string): Array<{ start: number; end: number }> {
  DYNAMIC_REFERENCE_TOKEN_SCAN.lastIndex = 0;
  const spans: Array<{ start: number; end: number }> = [];
  for (const match of value.matchAll(DYNAMIC_REFERENCE_TOKEN_SCAN)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
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
 * NOT CLOSED here. Issue
 * [#2036](https://github.com/go-to-k/cdkd/issues/2036) tracks the price this
 * refusal pays: a genuinely PUBLIC ssm mixed leaf is OVER-redacted on the
 * empty-map paths, so the baseline no longer matches AWS. Giving the empty-map
 * path POSITIVE evidence (a store of PROVEN-public verdicts, which the
 * resolver's own `pinSecretVerdict` retraction already computes) was drafted in
 * PR #2415 and WITHDRAWN there: such a store is keyed on the bare expression
 * and lives for the whole process, so on a `cdkd deploy --all` spanning regions
 * a verdict recorded where the parameter is a plain `String` un-redacts a
 * SecureString of the same name in another region — measured, and the
 * un-redacting direction, which is worse than the over-redaction it fixes. Any
 * revival must key the verdict by SCOPE (region + account) at the READ side.
 *
 * The residual is therefore the whole population an empty map describes, which
 * is the state issue #2036 records. Refusing is still the right way to be wrong
 * here: under-redaction persists a decrypted secret, a disclosure and the thing
 * this lane exists to prevent, while over-redaction is visible, recoverable and
 * discloses nothing.
 *
 * `tests/integration/secrets-dynamic-ref` is the end-to-end proof, and it is
 * the only place the empty-map defect surfaced — every unit assertion passed.
 * Three of its phases pin a DIFFERENT map state for the same two leaves, which
 * is what makes the split observable rather than asserted: Phase 1 is the
 * populated-map deploy (the resource is being created), Phase 1g the EMPTY-map
 * deploy (the resource is UNCHANGED, so it has no per-resource map but the
 * resolver has still classified the parameter this run), and Phase 1f the
 * empty-map command, which classifies nothing and therefore still refuses. An
 * earlier revision of this sentence called Phase 1g the populated-map case,
 * which is the opposite of what that phase is built to reach.
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
 * Does this value carry an ORDINARY object prototype?
 *
 * `isPlainObject` answers `typeof === 'object' && !Array.isArray`, which admits
 * CLASS INSTANCES, and that is a hole under {@link deepEqualJsonValue}: an AWS
 * SDK v3 readback reaching `drainObservedCaptures` is PRE-JSON and really does
 * carry `Date` values (`LastModified`, `CreationDate`). `Object.keys(new
 * Date())` is `[]`, so without this check a `Date` compared equal to `{}` and
 * to every other `Date` -- an anchor that corroborates a pairing while proving
 * nothing. Widening `isPlainObject` itself was rejected: it is read by three
 * other walks whose behaviour would change with it, and the defect is in what
 * EQUALITY means here, not in what counts as a container.
 *
 * A `Date` anchor now corroborates NOTHING, so an element carrying one refuses
 * rather than pairs. That is the conservative direction this module always
 * takes -- the residual stays a refusal -- and it is stated because the
 * opposite reading (that a `Date` on both sides is evidence) is the one a
 * future edit will be tempted by.
 */
function hasPlainPrototype(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Structural equality over the JSON shapes this module walks (issue #2012).
 *
 * Own ENUMERABLE keys only, and a key count on both sides, so an inherited
 * field is not equality and neither is a bag that merely CONTAINS the source's
 * keys. That agrees with the two walks beside it -- `isUniquelyKeyedBy` and the
 * object arm of {@link refuseUncertifiedReadbackPositions} both use
 * `Object.hasOwn` -- and it matters here rather than being hygiene: this
 * predicate is the evidence an anchor pairing rests on, so a comparison that
 * reads the prototype chain would let a constructed bag corroborate a pairing
 * it does not actually match.
 *
 * `JSON.stringify` was the obvious alternative and is wrong twice over: it is
 * key-ORDER sensitive (an AWS readback routinely reorders object keys, which
 * says nothing about the values) and it silently drops `undefined`, so
 * `{A: undefined}` and `{}` would compare equal while their key counts differ.
 */
function deepEqualJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqualJsonValue(item, b[i]));
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    // See {@link hasPlainPrototype}: a `Date` has no own keys, so without this
    // the key-count arm below reports it equal to `{}` and to any other `Date`.
    if (!hasPlainPrototype(a) || !hasPlainPrototype(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => Object.hasOwn(b, k) && deepEqualJsonValue(a[k], b[k]));
  }
  return false;
}

/**
 * Is an equal SOURCE value at an anchor position actually EVIDENCE that the two
 * containers describe the same element?
 *
 * A NON-EMPTY STRING is, and deliberately nothing else is. This is the same bar
 * {@link isUniquelyKeyedBy} already applies to an identity field, and for the
 * same reason: `''` is not a distinguishing value (it is also why the value
 * scan refuses it as a needle), and a non-string carries so few inhabitants
 * that equality is nearly free -- `{Name: 1, Value: <literal>}` and `{Name: 1,
 * Value: <expression>}` agree on `Name` whether or not they are the same entry,
 * so pairing on it would copy a secret reference onto an unrelated literal.
 * Both shapes are pinned in `secret-redaction-array-identity.test.ts` on the
 * IDENTITY arm and again in `secret-redaction-anchor-pairing.test.ts` on this
 * one; an anchor that accepted them would reopen from the positional side
 * exactly what that arm refuses.
 *
 * Containers count when something inside them does, so a nested literal object
 * can anchor a pairing its own level cannot. That recursion is also why this
 * predicate ALONE is not enough, and the review that measured it is worth
 * recording: `AWS::AmazonMQ::Broker.Users` renders `Groups: ['admin']`
 * identically on every element, which is distinguishing by this test and yet
 * tells two users APART not at all. Distinguishing is a property of ONE value;
 * telling elements apart is a property of the WHOLE array, and
 * {@link unkeyedArrayPairsByAnchors} is where the second one is enforced.
 *
 * This is a REFINEMENT of the formulation recorded on issue #2012, which said
 * only "every position whose SOURCE carries no dynamic reference is deep-equal
 * on both sides". Taken literally that admits a pairing corroborated ONLY by
 * `Name: ''` or `Name: 1`, which is measurably wrong: the counterexample the
 * issue states (`{Name:'', Value:'lit'}` against `{Name:'db', Value:<expr>}`)
 * has DIFFERING names and refuses on inequality alone, but the fence actually
 * in the tree carries `Name: ''` on BOTH sides, where equality holds and only
 * this predicate stands between an unrelated literal and a false redaction.
 */
function isDistinguishingAnchor(value: unknown): boolean {
  if (typeof value === 'string') return value !== '';
  if (Array.isArray(value)) return value.some(isDistinguishingAnchor);
  if (isPlainObject(value)) return Object.values(value).some(isDistinguishingAnchor);
  return false;
}

/**
 * Stands in for a reference-bearing leaf inside an {@link anchorSignature}.
 *
 * Written UNQUOTED while `JSON.stringify` quotes every real string, so no
 * literal can spell it and collide with a masked reference.
 */
const ANCHOR_REFERENCE_MASK = '<ref>';

/**
 * The part of a SOURCE element the anchors can actually see: the element with
 * every reference-bearing leaf masked, serialized canonically.
 *
 * Two elements with the same signature are INDISTINGUISHABLE to this pass --
 * the anchors say the same thing about both -- so a permutation swapping them
 * preserves every anchor and the alignment is not determined. That is the
 * property {@link isUniquelyKeyedBy} enforces for an identity FIELD, restated
 * for a whole projection instead of a single key.
 *
 * The signature is ORDER-INSENSITIVE in both directions -- object keys AND list
 * elements are sorted -- and that is not cosmetic normalisation. Rule 3's
 * question is "could AWS hand these two elements back SWAPPED without the swap
 * being visible", so the projection has to quotient by everything AWS may
 * itself reorder. Outer list order is the gate's own subject; order WITHIN an
 * anchor's list is this function's, for exactly the reason `descendArrays:
 * false` exists at all. A first cut sorted only the keys, and the security
 * review measured the hole on `AWS::AmazonMQ::Broker.Users`: two users whose
 * `Groups` were `['admin','ops']` and `['ops','admin']` signed DIFFERENTLY, so
 * rule 3 passed while the anchors still deep-equalled position for position,
 * and a reordered `DescribeBroker` put the admin's `Username` / `Password`
 * expressions at the app user's index. Byte-identical anchor content was being
 * assumed -- the order assumption this module refuses everywhere else.
 *
 * Sorting FAILS CLOSED, which is why it is the right shape of fix: it can only
 * make two signatures COLLIDE that previously differed, never the reverse, so
 * its only possible effect is an extra refusal. A missed closure, never a leak.
 *
 * The asymmetry with {@link deepEqualJsonValue} is deliberate and must survive
 * a reader who notices it. That predicate stays order-SENSITIVE on lists
 * because rule 1 asks a different question -- "did AWS return THIS position
 * unchanged" -- and a reordered list is a changed position. Making rule 1
 * order-blind too would weaken the corroboration rather than align it; the case
 * pinning that is `REFUSES an anchor list REORDERED in place` in
 * `secret-redaction-anchor-pairing.test.ts`.
 */
function anchorSignature(source: unknown): string {
  if (isDynamicReferenceString(source)) return ANCHOR_REFERENCE_MASK;
  // ORDER-INSENSITIVE, and this sort is load-bearing rather than tidiness --
  // see the doc above before removing it.
  if (Array.isArray(source)) return `[${source.map(anchorSignature).sort().join(',')}]`;
  if (isPlainObject(source)) {
    return `{${Object.keys(source)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${anchorSignature(source[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(source) ?? 'undefined';
}

/**
 * ANCHOR PAIRING (issue #2012): do these two containers corroborate each other
 * position by position?
 *
 * Two conditions, both required:
 *
 * 1. every SOURCE key is present in the bag (objects) or the index counts match
 *    (arrays) — see the object arm for why containment rather than equality,
 *    and which of the two directions is the fabrication guard, and
 * 2. every position whose SOURCE carries no dynamic reference is deep-equal on
 *    both sides -- the *anchors*.
 *
 * Anchors are what make the pairing EVIDENCE rather than a guess: a position
 * AWS did not rewrite proves the two containers describe the same element. It
 * answers the `descendArrays: false` objection on its own terms the way keying
 * does -- a REORDERED list normally puts a different element under each index,
 * so its anchors stop matching and the whole array is refused.
 *
 * "Normally" is doing real work in that sentence, and an earlier revision of it
 * did not have the word. A reorder is INVISIBLE to the anchors when the
 * elements it swaps look the same to them, which is the whole subject of
 * {@link unkeyedArrayPairsByAnchors}. This function answers only "does position
 * i corroborate position i"; whether the array as a whole may be walked at all
 * is decided there, and nothing here is sufficient on its own.
 *
 * What it deliberately CANNOT buy is baseline content. Every substitution the
 * caller then makes is a STRING leaf at a position the bag already has, so a
 * corroborated pairing never adds a key, adds an element, or writes a scalar
 * over a container. The principle this module is built on -- **redaction may
 * not buy itself a fabricated baseline** -- is preserved structurally rather
 * than by a special case, which is what the first attempt at these rows (taking
 * the SOURCE array wholesale) failed to do.
 *
 * The cost, stated rather than discovered: one deep compare per candidate
 * position, and a yield that drops to ZERO as soon as AWS normalises any
 * sibling field in the same container. That is common, so this closes a SUBSET
 * of the shapes issue #2012 lists rather than all of them, and the residual
 * stays a refusal -- which is the correct direction to be wrong in here.
 */
function anchorsCorroboratePairing(
  bag: unknown,
  source: unknown,
  anchors: { distinguishing: number }
): boolean {
  // An ANCHOR position: the source spells no reference here, so AWS's own value
  // must match it exactly. Inequality is positive evidence the two containers
  // are NOT the same element, which is what refuses the counterexamples.
  if (!subtreeHasDynamicReference(source)) {
    if (!deepEqualJsonValue(bag, source)) return false;
    if (isDistinguishingAnchor(source)) anchors.distinguishing += 1;
    return true;
  }
  // A reference-bearing STRING leaf -- the position a corroborated pairing
  // exists to reach. The bag must still be a string: the caller refuses to
  // write a scalar over a container, and admitting one here would hand it a
  // pairing whose only reference-bearing position it must then decline.
  //
  // PRE-EXISTING and out of scope, recorded because this arm makes it reachable
  // somewhere new: `isDynamicReferenceString` is a SUBSTRING test for
  // `{{resolve:`, so a source LITERAL such as `'not a real {{resolve: token'`
  // is classed reference-bearing. It is therefore exempt from the deep-equality
  // an anchor would demand -- lowering the corroboration bar for its whole
  // container -- and is then written over whatever the readback holds. The
  // string arm of `refuseUncertifiedReadbackPositions` has always done this;
  // tightening the predicate moves every caller of it at once and belongs in
  // its own change rather than riding along here.
  if (isDynamicReferenceString(source)) return typeof bag === 'string';
  if (isPlainObject(source)) {
    if (!isPlainObject(bag)) return false;
    // CONTAINMENT, not equality: every SOURCE key must be present and must
    // corroborate, while a key only the BAG carries is allowed (issue #2036 /
    // #2012's row 6). The two directions are not symmetric and only one of them
    // was ever load-bearing:
    //
    //  - a source key the bag LACKS still refuses, on `Object.hasOwn` below.
    //    That is the fabrication direction — it is how an AWS-reported
    //    `[{Value:'x'}]` was stopped from becoming `[{Name:'db', Value:<expr>}]`
    //    — and nothing here relaxes it.
    //  - a bag key the source lacks used to refuse too, on a key-COUNT
    //    comparison. It bought nothing: the caller's walk maps over the BAG's
    //    keys and takes a source leaf only where `Object.hasOwn(source, k)`, so
    //    an extra bag key can neither be overwritten nor fabricated. What it
    //    cost was the whole element — an AWS readback ROUTINELY adds fields
    //    (`Arn`, `LastModified`, a defaulted flag), so one such field refused
    //    the pairing and every secret INSIDE that element kept its plaintext.
    //
    // The corroboration argument is unchanged by the relaxation, which is the
    // part worth checking rather than asserting. Rule 1's anchors are the
    // positions the SOURCE spells without a reference; an extra bag key is not
    // one of them, so it neither adds nor removes an anchor. Rule 3's
    // {@link anchorSignature} is computed on SOURCE elements alone, so
    // distinguishability is untouched. A permutation is still refused by the
    // anchors it breaks.
    //
    // Do NOT weaken this into "skip a missing bag key": that is a different
    // edit, it removes the fabrication guard, and it is the one the issue #2012
    // review measured as re-opening the false redaction that killed the first
    // attempt at these rows.
    const sourceKeys = Object.keys(source);
    return sourceKeys.every(
      (k) => Object.hasOwn(bag, k) && anchorsCorroboratePairing(bag[k], source[k], anchors)
    );
  }
  if (Array.isArray(source)) {
    if (!Array.isArray(bag) || bag.length !== source.length) return false;
    return source.every((item, i) => anchorsCorroboratePairing(bag[i], item, anchors));
  }
  return false;
}

/**
 * May this UNKEYED array be walked positionally? The gate the anchor relaxation
 * actually rests on (issue #2012 review).
 *
 * {@link anchorsCorroboratePairing} answers per POSITION. Asking it once for
 * the whole array and requiring one distinguishing anchor ANYWHERE in the
 * result -- which an earlier revision did -- is unsound in two INDEPENDENT
 * ways, both measured by review against real shapes rather than reasoned about:
 *
 * - **Evidence for one element was credited to another.** `[{Name:'db',
 *   Value:<exprA>}, {Name:'', Value:<exprB>}]` has a distinguishing anchor at
 *   index 0 and NONE at index 1, and the array-wide counter licensed both -- so
 *   an unrelated literal at index 1 took `<exprB>`. That is precisely the false
 *   redaction `isDistinguishingAnchor` exists to prevent, arriving through the
 *   counter's SCOPE instead of through its definition.
 * - **Equal anchors cannot detect a reorder.** `['--pw', <exprA>, '--pw',
 *   <exprB>]` against a readback holding the two values swapped matches every
 *   anchor at every index, because both anchors are `'--pw'` -- so each
 *   position was pinned to the OTHER secret's expression.
 *   `AWS::AmazonMQ::Broker.Users` is the shape that makes this real rather than
 *   contrived: no `Name`/`Key`, both `Username` and `Password` rendered through
 *   `secretValueFromJson`, and `Groups: ['admin']` equal on every element, so a
 *   `DescribeBroker` returning the users in the other order records the ADMIN
 *   credential's reference at the app user's position -- which `cdkd drift
 *   --revert` then pushes to the live broker.
 *
 * So the gate is:
 *
 * 1. **Every position corroborates**, with the counter scoped PER top-level
 *    element rather than shared across the array.
 * 2. **Every reference-bearing element carries its own evidence.** A CONTAINER
 *    must hold a distinguishing anchor INSIDE it: it has an interior where an
 *    identity could live, so the absence of one is meaningful. A BARE reference
 *    leaf has no interior, so absence says nothing about it and the only
 *    evidence available is the FRAME -- the array's non-reference-bearing
 *    elements, which must then supply a distinguishing anchor between them.
 *    That distinction is exactly what separates `['--pw', <expr>, '--verbose']`
 *    (CLOSES: the literal flags pin the one free slot) from `[{V:'us-east-1'},
 *    {V:<expr>}]` (REFUSES: the second element could hold anything, and
 *    overwriting it would erase a genuine out-of-band change from the drift
 *    baseline, so `cdkd drift` reports clean and `--revert` never sees it).
 * 3. **Reference-bearing elements are pairwise DISTINGUISHABLE**, by
 *    {@link anchorSignature}. Two elements the anchors describe identically
 *    admit a permutation that preserves every anchor, so the alignment is not
 *    determined and no amount of per-position equality makes it so.
 *
 * Checking uniqueness on the SOURCE side alone is sufficient, and the argument
 * is worth stating because the bag side looks like it needs checking too: rule
 * 1 has already established that the bag matches the source at every anchor
 * position, so the two projections are equal element-wise. If some permutation
 * other than the identity also satisfied the anchors, two SOURCE elements would
 * have to share a signature -- which rule 3 excludes. This is the same
 * multiset-correctness argument `isUniquelyKeyedBy` makes for a single field.
 *
 * NESTED arrays are not re-checked here, and do not need to be: the caller
 * recurses through {@link refuseUncertifiedReadbackPositions}, which re-enters
 * its own array arm for every nested list and consults this gate again with
 * that list's own elements. A nested array whose elements are indistinguishable
 * is therefore refused on its own terms while its parent may still pair.
 */
function unkeyedArrayPairsByAnchors(bag: readonly unknown[], source: readonly unknown[]): boolean {
  if (bag.length !== source.length) return false;

  const distinguishingPerElement: number[] = [];
  for (const [i, item] of source.entries()) {
    const anchors = { distinguishing: 0 };
    if (!anchorsCorroboratePairing(bag[i], item, anchors)) return false;
    distinguishingPerElement.push(anchors.distinguishing);
  }

  // The FRAME: elements the source spells with no reference at all. The loop
  // above has already proved each one deep-equal to its bag counterpart, so
  // these are the positions AWS demonstrably did not rewrite.
  const frameDistinguishing = source.reduce<number>(
    (total, item, i) =>
      subtreeHasDynamicReference(item) ? total : total + distinguishingPerElement[i]!,
    0
  );

  const signatures = new Set<string>();
  for (const [i, item] of source.entries()) {
    if (!subtreeHasDynamicReference(item)) continue;

    const signature = anchorSignature(item);
    if (signatures.has(signature)) return false;
    signatures.add(signature);

    if (distinguishingPerElement[i]! > 0) continue;
    // No evidence of its own. Only a BARE reference leaf may fall back on the
    // frame; a container with no distinguishing anchor inside it had somewhere
    // to carry one and did not.
    if (!isDynamicReferenceString(item) || frameDistinguishing === 0) return false;
  }
  return true;
}

/**
 * Marks a position one of the POSITION passes DECIDED, in the parallel tree
 * {@link refuseUncertifiedReadbackPositions} builds when asked to `mark`.
 *
 * A SENTINEL rather than a value comparison, and that distinction was a
 * security blocker on PR #2415. {@link preferPositionDecisions} first inferred
 * "not decided" from `refused === bag`, which cannot tell an UNDECIDED position
 * from one the pass decided IN FAVOUR of the value already there. Two shapes
 * hit it, both fabricating a baseline `cdkd drift --revert` then pushes:
 *
 * - the resolver's unsupported-service arm leaves a `{{resolve:...}}` token it
 *   has no arm for LITERAL (`ssm-secure:` was one until issue #2482), so AWS
 *   echoes it back and the source leaf EQUALS the bag leaf. The string arm returns `source` — a decision — and the equality made
 *   it look like no decision at all. (A BARE such token takes the whole-token
 *   arm and one embedded in text takes the mixed-leaf arm; both decide, and
 *   both were misread.)
 * - the empty-map arm that deliberately KEEPS a leaf returns `bag` by design.
 *
 * A symbol cannot be produced by any walk of JSON, so no readback value can
 * impersonate it.
 */
const POSITION_DECIDED = Symbol('position decided by a position pass');

/**
 * The (plaintext -> expression) pairs a LEARN pass has established, plus the
 * plaintexts it refuses to speak for.
 *
 * `poisoned` is not bookkeeping — it is the {@link recordedSecretExpressions}
 * collapse (issue #1910) arriving through this door. The map is keyed by the
 * resolved PLAINTEXT, so two expressions that resolve to the same value would
 * silently keep the last one learned and every OTHER occurrence of that value
 * in the record would take a SIBLING's expression. `cdkd drift --revert` and
 * `resolveReplayProps` both re-resolve a persisted expression against the live
 * resource, so that is a wrong-reference write, not a cosmetic mislabel. A
 * plaintext learned twice with two expressions is therefore struck out for the
 * rest of the record and the residual stays a refusal.
 */
interface DerivedNeedleCollector {
  readonly needles: Map<string, string>;
  readonly poisoned: Set<string>;
  /**
   * Plaintexts whose secret-ness is INFERRED rather than spelled, so they may
   * only ever rewrite a WHOLE leaf — see {@link expressionSecretIsInferred}.
   */
  readonly inferred: Set<string>;
}

/**
 * Record one (plaintext -> expression) pair, or strike the plaintext out.
 *
 * Below {@link MIN_NEEDLE_LENGTH} nothing is recorded, and this floor DECIDES
 * rather than mirrors. {@link buildNeedleRegex} applies the same threshold, so
 * a short needle is dropped from the SUBSTRING arm either way — but the value
 * scan's other arm is a WHOLE-VALUE lookup (`secrets.get(leaf)`) that matches
 * at ANY length, so without this line a two-character derived plaintext would
 * still rewrite every leaf equal to it. That is the false redaction with a
 * blast radius {@link expressionMaySeedANeedle} exists to bound, arriving by
 * length instead of by provenance: a public config value of `us` or `dev` is
 * exactly the kind of short plaintext a readback carries in a dozen unrelated
 * fields.
 */
function learnNeedle(
  collector: DerivedNeedleCollector,
  plaintext: string,
  expression: string
): void {
  if (plaintext.length < MIN_NEEDLE_LENGTH) return;
  if (collector.poisoned.has(plaintext)) return;
  // Recorded unconditionally, and its POSITION here is not load-bearing:
  // {@link expressionSecretIsInferred} is a pure function of the expression, so
  // a plaintext two DIFFERENT expressions claim is POISONED by the arms below
  // rather than narrowed, and one claimed twice by the SAME expression gets the
  // same class both times. An earlier revision of this comment claimed the early
  // placement made a both-classes plaintext keep the narrower radius; measured,
  // that case does not exist — and believing it would license deleting the
  // poison arm.
  if (expressionSecretIsInferred(expression)) collector.inferred.add(plaintext);
  const already = collector.needles.get(plaintext);
  if (already === undefined) {
    collector.needles.set(plaintext, expression);
    return;
  }
  if (already === expression) return;
  collector.needles.delete(plaintext);
  collector.poisoned.add(plaintext);
}

/**
 * The `{{resolve:<service>:` prefixes whose resolved value IS a secret,
 * whatever the parameter or secret is called.
 *
 * `ssm` is in the list and `ssm-secure` is spelled separately, because
 * `startsWith('{{resolve:ssm:')` is FALSE for `{{resolve:ssm-secure:` — the
 * next character is `-`. The two are disjoint tests, not one with a prefix
 * relationship, which is the trap `mixedLeafMayCarryPublicReference`'s own
 * comment already records from the other direction.
 */
const SECRET_BEARING_REFERENCE_PREFIXES = [
  '{{resolve:secretsmanager:',
  '{{resolve:ssm-secure:',
  '{{resolve:ssm:',
] as const;

/**
 * The prefixes whose SPELLING settles secret-ness, with no lookup and no
 * inference — the subset of {@link SECRET_BEARING_REFERENCE_PREFIXES} that
 * {@link expressionSecretIsInferred} treats as certain.
 *
 * An ALLOWLIST rather than "the admission list minus `{{resolve:ssm:`", and the
 * difference is what happens to the NEXT entry someone adds. Subtracting makes a
 * new prefix default to CERTAIN, i.e. to the WIDER blast radius, which is the
 * wrong direction to fail in; listing makes it default to inferred until someone
 * deliberately promotes it.
 */
const SPELLED_SECRET_REFERENCE_PREFIXES = [
  '{{resolve:secretsmanager:',
  '{{resolve:ssm-secure:',
] as const;

/**
 * Is this expression's secret-ness INFERRED rather than spelled?
 *
 * SPELLING, and ONLY spelling. `secretsmanager:` and `ssm-secure:` say what they
 * are, in a way that is true in every region and every account. A bare
 * `{{resolve:ssm:` token is not: it is accepted as secret-bearing on the #1901
 * premise (a public `String` is persisted RESOLVED, so a token SURVIVING in a
 * state bag is a `SecureString`), which is sound for the leaf itself and NOT
 * sound as a licence to rewrite every other leaf that merely CONTAINS the value.
 *
 * A RECORDED verdict deliberately does NOT promote one, even though it is a real
 * `GetParameter` answer. {@link recordedSecretExpressions} is keyed on the bare
 * expression and lives for the whole process, so on a `cdkd deploy --all` a
 * verdict pinned where the parameter is a `SecureString` is inherited where it
 * is a plain `String` — and the `skipDynamicReferences` diff path skips the
 * lookup on a `true` verdict, so the second region never retracts it. That is
 * the SAME region blindness this PR withdrew issue #2036's public store for; a
 * secret-direction verdict is safe to inherit for ADMISSION (it can only
 * over-redact a leaf) and is not safe for BLAST RADIUS. The cost of ignoring it
 * here is the substring arm for a verdict-backed, same-region ssm
 * `SecureString` on the empty-map path — a strict subset of the population the
 * no-verdict case already concedes, and in the same direction.
 *
 * The difference is a `--revert` WRITE. Measured on this module: a bare `ssm`
 * token whose value is `production` turned `my-production-logs` into
 * `my-{{resolve:ssm:/app/env}}-logs`, exactly the failure
 * {@link expressionMaySeedANeedle}'s own doc names — and if that parameter is in
 * fact public, the baseline now holds a value AWS never reported, which `cdkd
 * drift --revert` re-resolves and pushes, renaming the live bucket the day the
 * parameter changes.
 *
 * So evidence strength decides BLAST RADIUS, not admission: an inferred needle
 * still closes issue #2012's two rows, because both are WHOLE-VALUE positions
 * (an unpaired element and an observed key both hold the plaintext and nothing
 * else). Only the substring arm is withheld. Issue #2036's withdrawn verdict
 * store is what would promote these to certain; until it returns, scoped by
 * region and account, this is the honest bound.
 */
function expressionSecretIsInferred(expression: string): boolean {
  return !SPELLED_SECRET_REFERENCE_PREFIXES.some((prefix) => expression.startsWith(prefix));
}

/**
 * May this expression's resolved value be used as a REDACTION NEEDLE?
 *
 * A stricter question than "may this expression be persisted at this position",
 * which is what `trustAnyExpression` answers, and the difference is the whole
 * reason this predicate exists. Persisting a source leaf VERBATIM is bounded to
 * that one position; promoting the value it replaced to a needle rewrites EVERY
 * leaf in the record that equals it, so a wrong answer here is a false
 * redaction with a blast radius rather than a mislabelled leaf.
 *
 * Two classes, and each was measured rather than reasoned about:
 *
 * - a NON-SECRET SERVICE. `isSingleDynamicReferenceToken` accepts any
 *   `{{resolve:<anything>}}` spelling, and the resolver's unsupported-service
 *   arm WARNS and returns the literal — so AWS holds the token text itself and
 *   the leaf beside it is ordinary data. `cdkd drift`'s own
 *   `--revert does not register a live value for a look-alike spelling` case
 *   pins exactly this for its sibling registration path
 *   (`{{resolve:notaservice:/x}}`), and this predicate is what keeps the two
 *   commands answering it the same way.
 * - a plain `ssm` reference is ACCEPTED, on the same
 *   #1901 premise the whole-token arm one level up already acts on: a public
 *   `String` / `StringList` parameter is persisted RESOLVED, so a
 *   `{{resolve:ssm:` token SURVIVING in a persisted state bag is a
 *   `SecureString` by construction. Requiring a recorded verdict instead would
 *   make the needle unavailable on `cdkd state refresh-observed`, whose process
 *   resolves nothing and therefore records nothing — i.e. it would fail exactly
 *   where issue #2012 is reported. A PROVEN-public verdict would refine this,
 *   and issue #2036's store was to supply one; PR #2415 withdrew it as a
 *   cross-region disclosure, so a genuinely public parameter's resolved value
 *   CAN still seed a needle here. Bounded by the per-record scope and by
 *   {@link MIN_NEEDLE_LENGTH}, and visible as over-redaction rather than as a
 *   leak.
 */
function expressionMaySeedANeedle(expression: string): boolean {
  return (
    isRecordedSecretExpression(expression) ||
    SECRET_BEARING_REFERENCE_PREFIXES.some((prefix) => expression.startsWith(prefix))
  );
}

/**
 * Learn from a position whose SOURCE is a WHOLE `{{resolve:...}}` token.
 *
 * This is the strongest needle available on a readback path, and it asserts
 * nothing the walk was not already asserting: the caller is about to persist
 * `expression` OVER `bag` at this very position, which is the claim that `bag`
 * is that expression's resolved value. Reading the same claim back out as a
 * needle is free.
 *
 * TWO refusals, both narrow and both necessary:
 *
 * - a bag leaf that is ITSELF a complete token is not a plaintext at all. It is
 *   a record that was already redacted (a re-scrub, a second
 *   `refresh-observed`), and pairing it with itself would put a `{{resolve:...}}`
 *   string in the needle set, where the value scan's own token guard would then
 *   have to keep stepping over it.
 * - a token that does not name a SECRET-BEARING reference at all — see
 *   {@link expressionMaySeedANeedle}.
 */
function learnWholeTokenNeedle(
  collector: DerivedNeedleCollector,
  bag: string,
  source: string
): void {
  if (isSingleDynamicReferenceToken(bag)) return;
  if (!expressionMaySeedANeedle(source)) return;
  learnNeedle(collector, bag, source);
}

/**
 * Learn from a MIXED leaf — a reference embedded in surrounding text, which
 * this module calls the DOMINANT CDK shape (an `Fn::Join` around
 * `secret.secretValueFromJson(...)`).
 *
 * The caller is about to persist `source` over `bag`, i.e. it has already
 * decided the two are the same leaf one resolution apart. Extracting the
 * plaintext is then arithmetic rather than inference, PROVIDED the extraction
 * is unambiguous, which is what the guards below establish:
 *
 * - EXACTLY ONE span. With two references the text between them cannot be
 *   split between the two resolved values without guessing. This one is
 *   CONSERVATIVE rather than a correctness guard, and saying so is what stops
 *   the next reader treating it as load-bearing: with two RESOLVED references
 *   the frame check below refuses independently, because the computed SUFFIX
 *   would then contain a whole `{{resolve:...}}` token and a resolved readback
 *   cannot end with one. The shape it genuinely decides is a second reference
 *   that survives LITERALLY in the readback — the resolver's
 *   unsupported-service arm produces exactly that (`ssm-secure:` did until
 *   issue #2482; a spelling with no arm still does) — where the
 *   extraction would in fact be right and is declined anyway. Measured: a
 *   both-resolved fixture leaves this line unfenced.
 * - the source's literal PREFIX and SUFFIX must both be present at the ends of
 *   the bag. That is what proves the leaf really is this source resolved; AWS
 *   normalising any of the surrounding text refuses instead of yielding a
 *   needle sliced at the wrong offsets.
 * - the two must not overlap, and something must remain between them.
 *
 * Anchoring at the ENDS rather than searching is deliberate: a secret whose own
 * text repeats the suffix (`abc@h` inside `postgres://u:abc@h@h`) still slices
 * correctly, while an `indexOf` scan would cut it short.
 */
function learnMixedLeafNeedle(
  collector: DerivedNeedleCollector,
  bag: string,
  source: string
): void {
  // The frame — one span, prefix / suffix anchored at the ends, a non-empty
  // middle that is not itself a complete token — is `singleSpanFrame`, shared
  // with `positionByEmbeddedSpan` so the two refusals cannot drift. The token
  // refusal it carries is the one this function used to spell out here: a
  // slice that is ITSELF a complete `{{resolve:...}}` token is not a
  // plaintext, it is an already-redacted record (a re-scrub, a second
  // `refresh-observed`), and pairing it would put a reference string in the
  // needle set — the asymmetry with the whole-token arm the security review
  // found.
  const frame = singleSpanFrame(bag, source);
  if (frame === undefined) return;
  // The TOKEN, never the whole leaf. The needle's replacement is what gets
  // written wherever the plaintext is found NEXT, and those positions carry
  // only the secret — an AWS-added field holding the bare password, say. Pairing
  // it with the surrounding `postgres://u:...@h` frame would write a whole
  // connection string over a field AWS reported as a password: fabricated
  // baseline content, which `--revert` then pushes to the live resource. Pinned
  // by `learns from a MIXED leaf, which is the DOMINANT CDK shape`, which
  // measured exactly that output before this line said `token`.
  const { token, middle: plaintext } = frame;
  if (!expressionMaySeedANeedle(token)) return;
  learnNeedle(collector, plaintext, token);
}

/**
 * Read the mark tree one level down. It has the SAME shape as `refused` by
 * construction (one function, one set of inputs), but this stays defensive: a
 * missing level yields `undefined`, which reads as "not decided" and therefore
 * lets the scan act. That is the same answer the pre-mark code gave, so a shape
 * surprise cannot silently start SUPPRESSING redaction — but it fails toward
 * SCANNING, which is the fabrication direction the mark tree exists to stop.
 * Both are stated because neither default is free; the shapes are identical by
 * construction (one function, one set of inputs), so this arm is a backstop
 * rather than a policy.
 */
function asChild(marks: unknown, key: string): unknown {
  return isPlainObject(marks) && hasPlainPrototype(marks) ? marks[key] : undefined;
}

/** The array-arm twin of {@link asChild}; same fail-open, same reason. */
function asIndex(marks: unknown, index: number): unknown {
  return Array.isArray(marks) ? marks[index] : undefined;
}

/**
 * Merge the DERIVED-needle value scan back over the two POSITION passes, so the
 * scan can only ever ADD a rewrite and never EDIT one.
 *
 * WHY THIS EXISTS AT ALL. Issue #2012's fix has been through both orderings and
 * each has its own way of turning a redaction fix into a fabricated baseline —
 * the two are mirror images, which is why the answer is a merge rather than a
 * third choice of order:
 *
 * - SCAN FIRST (the first revision): a needle rewrites a frame LITERAL that
 *   happens to embed a learned plaintext, {@link unkeyedArrayPairsByAnchors} is
 *   then re-run against the SCANNED bag, the anchor no longer deep-equals its
 *   source, the whole array refuses, and a sibling MIXED leaf that position
 *   ALREADY redacted persists in plaintext. Under-redaction.
 * - SCAN LAST, unrestricted (the second): the scan now runs over leaves whose
 *   content came from the SOURCE. A needle occurring in the literal FRAME of a
 *   source-taken mixed leaf is replaced, so
 *   `postgres://appuser:{{resolve:secretsmanager:...}}@h/db` becomes
 *   `postgres://{{resolve:ssm:/app/db-user}}:{{resolve:...}}@h/db` when
 *   `appuser` is also some whole-token position's resolved value — a reference
 *   the template never had at that offset. `cdkd drift --revert` re-resolves the
 *   baseline before pushing it, so once that parameter's value changes the
 *   revert writes a DIFFERENT user to the live resource. Fabricated baseline,
 *   which is the bar {@link refuseUncertifiedReadbackPositions} refuses to break
 *   at its own bottom.
 *
 * THE RULE. A position the passes DECIDED is theirs; a position they left alone
 * belongs to the scan. Expressed as a walk over their OUTPUT rather than as a
 * second copy of their pairing logic, because a mirror of `identityKeyFor` /
 * `unkeyedArrayPairsByAnchors` would drift from the original and a needle
 * applied at a MIS-paired position is a false redaction everywhere it matches.
 * The shapes line up position-for-position for free: neither pass adds a key,
 * an element, or a scalar-over-container, so `refused` is `bag`'s own shape with
 * some leaves replaced.
 *
 * `typeof bag === 'string'` at the leaf: a derived needle can only ever rewrite
 * a STRING, so for every other leaf the two answers agree and taking `refused`
 * is free.
 *
 * KEEPING A NON-PLAIN LEAF INTACT takes the prototype guard on the object arm,
 * NOT that leaf rule, and an earlier revision of this comment claimed the
 * opposite — measured wrong. The scan's own walk rebuilds objects and turns a
 * `Date` the provider readback carries (`LastModified`) into `{}`; that
 * flattening predates this module's derived needles on the POPULATED-map path
 * (issue #2427). The object arm runs FIRST here and `isPlainObject` admits a
 * `Date`, so without `hasPlainPrototype` this walk did the flattening ITSELF —
 * newly extending #2427 to the EMPTY-map path, where the unchanged-resource
 * `drainObservedCaptures` baseline lives and where `cdkd drift --revert` pushes
 * the result to the live resource. With the guard a non-plain leaf falls
 * through to `refused`. That is the position passes' own answer — usually the
 * bag by identity, though NOT universally: their object arm has no prototype
 * guard of its own, so a non-plain leaf whose source subtree carries a
 * reference is already flattened one function earlier. Same defect as issue
 * #2427, one layer up, and out of this lane's scope.
 *
 * The net effect is byte-identical to the FIRST ordering on every input where
 * the un-certification did not fire — which is the whole point: it keeps that
 * ordering's intent and drops only its defect.
 */
function preferPositionDecisions(
  scanned: unknown,
  refused: unknown,
  bag: unknown,
  marks: unknown,
  inferred: RecordedSecretValues
): unknown {
  // `hasPlainPrototype`, and it is load-bearing rather than tidy:
  // {@link isPlainObject} admits ANY non-null non-array object, a `Date`
  // included, and `Object.entries(new Date())` is `[]` — so without this the
  // object arm rebuilt a readback `Date` as an empty object BEFORE the leaf
  // rule below could keep it, which is the very corruption the leaf rule is
  // documented as preventing. Measured on this tree: a bag of
  // `{A, Copy, LastModified: Date}` came back with `LastModified: {}`.
  if (
    isPlainObject(bag) &&
    hasPlainPrototype(bag) &&
    isPlainObject(refused) &&
    isPlainObject(scanned)
  ) {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(refused)) {
      out[k] = preferPositionDecisions(scanned[k], v, bag[k], asChild(marks, k), inferred);
    }
    return out;
  }
  if (
    Array.isArray(bag) &&
    Array.isArray(refused) &&
    Array.isArray(scanned) &&
    refused.length === bag.length &&
    scanned.length === bag.length
  ) {
    return refused.map((item, i) =>
      preferPositionDecisions(scanned[i], item, bag[i], asIndex(marks, i), inferred)
    );
  }
  // The scan owns a STRING leaf no position pass decided. `marks` answers the
  // second half exactly; `refused === bag` used to, and could not distinguish a
  // decision that AGREED with the bag — see {@link POSITION_DECIDED}.
  if (typeof bag !== 'string' || marks === POSITION_DECIDED) return refused;
  // `scanned` carries the CERTAIN needles at full strength. An INFERRED one may
  // only take a leaf WHOLE, so it applies here and only where the certain scan
  // left the leaf alone — see {@link expressionSecretIsInferred} for why the
  // substring arm is withheld from it.
  return scanned === bag ? (inferred.get(bag) ?? scanned) : scanned;
}

/**
 * The learned pairs, split by how strong the evidence for each one is.
 *
 * `certain` gets the full value scan (whole-value AND substring); `inferred`
 * gets a WHOLE-VALUE rewrite only. See {@link expressionSecretIsInferred}.
 */
interface DerivedNeedles {
  readonly certain: RecordedSecretValues;
  readonly inferred: RecordedSecretValues;
}

/**
 * DERIVED NEEDLES (issue [#2012](https://github.com/go-to-k/cdkd/issues/2012)):
 * the secrets map an empty-map readback path can build from its OWN two bags,
 * with no resolution, no AWS call and no new permission.
 *
 * THE PROBLEM THIS ANSWERS. On the readback paths the secrets map is empty by
 * construction (nothing was resolved), so the value scan has no needles and
 * POSITION is the only mechanism. Two shapes have no position to argue from and
 * kept their plaintext: an UNPAIRED array element beside a paired one, and an
 * observed KEY the source does not carry. Both are places {@link redactByPath}
 * ALREADY delegates to the value scan — it is the scan that had nothing to say.
 *
 * WHAT MAKES A NEEDLE AVAILABLE WITHOUT FETCHING. The same record almost always
 * carries the same secret at a position the pass DOES certify: the paired
 * sibling, the key the source does carry. Certifying such a position IS the
 * assertion that AWS's value there is that expression's resolved form — the
 * pass acts on it by persisting the expression over it. Reading that assertion
 * back out gives a plaintext, and a plaintext is exactly what the value scan
 * was missing. Issue #2012's own direction was to RESOLVE the record's
 * expressions to get one, which would have made `cdkd state refresh-observed`
 * and every deploy's observed capture FETCH secrets: a new IAM requirement, a
 * new failure mode and a new place plaintext lives. None of that is needed —
 * AWS already handed us the plaintext, in the very bag being redacted.
 *
 * `redactByPath`'s own comment argued the opposite direction and was right
 * about it: seeding the scan from the SOURCE's expressions cannot work, because
 * a scan needs PLAINTEXT needles. This seeds it from the BAG's values, which is
 * the half that exists.
 *
 * SCOPE, and why each bound is where it is:
 *
 * - ONLY the readback-projected rules. Every other caller either has a real map
 *   or has a source of a different generation, where a value learned from one
 *   generation must not rewrite the other.
 * - ONLY when the map is EMPTY, and this bound is load-bearing for a reason
 *   that is not obvious: {@link crossStackAssociations} and
 *   {@link nestedStackParameterExpressions} are `WeakMap`s keyed by the
 *   RecordedSecretValues INSTANCE, so handing the pipeline a different Map
 *   object would silently lose every association that pass recorded. With an
 *   empty map there are none to lose (an association is only ever recorded for
 *   a plaintext that map holds).
 * - the pairs are scoped to ONE record, exactly as `perResourceSecrets` is on
 *   the deploy path, so one resource's secret can never rewrite another's
 *   coinciding literal.
 *
 * WHERE THE RESULT IS APPLIED, and this is a SEQUENCING claim rather than a
 * scoping one: the returned map is handed to a plain VALUE pass over the RAW
 * bag, whose result is then MERGED over the output of both position passes by
 * {@link preferPositionDecisions}. It reaches neither position pass. Both naive
 * orderings are wrong and that function's doc has the measurements: scanning
 * FIRST lets a needle rewrite a frame LITERAL and un-certify an anchor pairing
 * (under-redaction), scanning LAST over their output lets one rewrite a literal
 * inside a leaf they took from SOURCE (a fabricated baseline). The merge is what
 * makes "a derived needle can only ADD rewrites" literally true.
 *
 * Returns `undefined` when nothing is learned, so the no-secret path skips the
 * scan and the merge entirely and stays byte-identical to the position passes'
 * own output.
 */
function deriveReadbackNeedles(
  bag: unknown,
  source: unknown,
  secrets: RecordedSecretValues,
  rules: PathSourceRules
): DerivedNeedles | undefined {
  if (!isReadbackProjectedFromState(rules)) return undefined;
  if (secrets.size > 0) return undefined;
  if (!subtreeHasDynamicReference(source)) return undefined;
  const collector: DerivedNeedleCollector = {
    needles: new Map(),
    poisoned: new Set(),
    inferred: new Set(),
  };
  // The LEARN pass. Its return value is discarded — it runs for the pairs its
  // certified positions establish, and it is the same function that decides
  // those positions on the substituting pass, so the two can never disagree
  // about what "certified" means. It reads the RAW `bag` for the same reason:
  // after the position passes those very positions hold the EXPRESSION, so the
  // plaintext half of every pair would be gone.
  refuseUncertifiedReadbackPositions(bag, source, secrets, collector);
  if (collector.needles.size === 0) return undefined;
  const certain = new Map<string, string>();
  const inferred = new Map<string, string>();
  for (const [plaintext, expression] of collector.needles) {
    (collector.inferred.has(plaintext) ? inferred : certain).set(plaintext, expression);
  }
  return { certain, inferred };
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
 *   `['--pw', '{{resolve:...}}']` (no identity key)   LEAK          take source*
 *   `[{Field, Val: '{{resolve:...}}'}]` (no `Name`)   LEAK          take source*
 *   ...either of those, but REORDERED / normalised    LEAK          LEAK (#2012)
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
 * The starred rows are the two ANCHOR PAIRING closed for issue #2012, and the
 * star is load-bearing: they close only when the pairing is CORROBORATED. Four
 * conditions, all required — the index counts match; every position the source
 * does not spell as a reference is deep-equal on both sides; every
 * reference-bearing ELEMENT carries its own distinguishing anchor, or, being a
 * bare reference leaf with no interior to carry one, leans on the array's
 * literal FRAME; and no two reference-bearing elements look alike to the
 * anchors. That is why the row beneath them exists. As soon as AWS reorders the
 * list or normalises any sibling field, the anchors stop matching and the same
 * two shapes refuse again, so the closure is a SUBSET of each row rather than
 * the whole of it.
 *
 * An earlier revision of this paragraph stated only the first two conditions
 * plus "at least one of them distinguishing", which was the gate BEFORE the
 * #2012 review — under it `['--pw', <exprA>, '--pw', <exprB>]` closes and
 * misattributes, so the text documented the defect as the design. See
 * {@link unkeyedArrayPairsByAnchors}, which is where all four live;
 * {@link anchorsCorroboratePairing} answers only one of them and its own doc
 * says nothing in it is sufficient alone.
 *
 * The residual rows are one root cause, not several: no needle and no
 * position, so nothing distinguishes a resolved secret from an ordinary
 * literal. They are NOT closed by taking the source subtree, which an earlier
 * revision did and the issue #1915 fences correctly rejected — measured, it
 * rewrote `{Name:'', Value:'an-unrelated-literal'}` onto the expression and
 * turned an AWS-reported `[{Value:'x'}]` into `[{Name:'db', Value:<expr>}]`,
 * fabricating drift-baseline content AWS never reported that `cdkd drift
 * --revert` then pushes to the live resource. Redaction may not buy itself a
 * fabricated baseline — which is also the bar anchor pairing had to clear, and
 * clears structurally: it only ever licenses a walk of positions the BAG
 * already has, so it can add no key, no element and no scalar-over-container.
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
 * The last two rows were the RESIDUAL and are closed by DERIVED NEEDLES (issue
 * #2012) — see {@link deriveReadbackNeedles}. Neither has a position to argue
 * from: an unpaired array element and an observed KEY the source does not carry
 * are both positions with no source leaf to take. What they never lacked was a
 * VALUE — the same plaintext usually sits at a position this pass DOES certify,
 * and certifying it is already an assertion that the value is that expression's
 * resolved form. Reading that assertion back out as a needle turns the value
 * scan on for the rest of the record without resolving anything.
 *
 * The extra-KEY asymmetry stays as it was and is worth restating, because the
 * needle does not replace it: an extra array element is a PEER of the
 * secret-bearing ones (another `Environment` entry), while an extra object KEY
 * is a different FIELD entirely (`Runtime`, `FunctionArn`, `LastModified`) and
 * is the NORM in an AWS readback. Refusing those wholesale would empty the
 * drift baseline of every secret-bearing resource, which is why they are
 * value-scanned rather than refused.
 *
 * `learn` is the LEARN PASS's collector and is `undefined` on the substituting
 * pass. It changes NO verdict — every branch below decides exactly what it
 * decided before — it only records the (plaintext, expression) pairs the
 * certified positions establish. Deriving them through this function rather
 * than a second walk is deliberate: the pairing rules (identity keys, anchor
 * corroboration, the refusals) are subtle enough that a mirror of them would
 * drift, and a needle learned from a MIS-paired position is a false redaction
 * everywhere it then matches.
 */
function refuseUncertifiedReadbackPositions(
  bag: unknown,
  source: unknown,
  secrets: RecordedSecretValues,
  learn?: DerivedNeedleCollector,
  // MARK MODE. Returns the same SHAPE with {@link POSITION_DECIDED} at every
  // position this pass decides, and the bag's own value everywhere else, so
  // {@link preferPositionDecisions} can ask "was this decided?" instead of
  // guessing from value equality. Running the real function rather than a
  // mirror of it is the point: the pairing rules (identity keys, anchor
  // corroboration, the refusals) decide which positions EXIST, and a second
  // copy of them would drift.
  mark?: boolean
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
    if (isSingleDynamicReferenceToken(source)) {
      // ...and the bag it replaces is that expression's resolved value, exactly
      // and with nothing inferred. That is the strongest needle available here.
      if (learn) learnWholeTokenNeedle(learn, bag, source);
      return mark ? POSITION_DECIDED : source;
    }
    // A MIXED leaf embedding something that may be PUBLIC config: keep the
    // resolved value AWS actually holds. See the predicate's own doc. KEEPING
    // is a decision like any other, which is why it marks.
    //
    // NO TEST FENCES THAT MARK, and the reason is structural rather than a gap:
    // the merge only runs when the map is EMPTY ({@link deriveReadbackNeedles}
    // returns `secrets` by identity otherwise), and with an empty map the
    // predicate above is constant `false`. So this arm and the mark tree cannot
    // both be live today. It is written correctly anyway because issue #2036's
    // withdrawn verdict store is what makes the predicate non-constant there,
    // and whoever revives it must not also have to rediscover this line.
    if (mixedLeafMayCarryPublicReference(source, secrets)) {
      return mark ? POSITION_DECIDED : bag;
    }
    if (learn) learnMixedLeafNeedle(learn, bag, source);
    return mark ? POSITION_DECIDED : source;
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
        ? refuseUncertifiedReadbackPositions(v, source[k], secrets, learn, mark)
        : // No source leaf here, so this pass has nothing to substitute. It is
          // no longer a residual, but the closure happens OUTSIDE this walk:
          // `redactSecretsForState` scans the RAW bag with the DERIVED needles
          // and {@link preferPositionDecisions} merges that result in wherever
          // neither position pass changed a leaf (issue #2012) — which is
          // exactly this position. What this walk hands on is therefore the raw
          // value, and the merged scan decides it. Neither naive ORDER works;
          // the reasons are measured on `preferPositionDecisions`.
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
    // An unpairable array therefore keeps its plaintext UNLESS the positions
    // themselves corroborate the alignment — the anchor pass added for issue
    // [#2012](https://github.com/go-to-k/cdkd/issues/2012), below. Where they
    // do not, the refusal stands for the original reason: with an empty secrets
    // map there is no needle, and with no identity there is no position, so
    // nothing can distinguish a resolved secret from an ordinary literal. That
    // remains the array-shaped twin of the unpaired-KEY residual below.
    const key = identityKeyFor(bag, source);
    if (key === undefined) {
      // ANCHOR PAIRING (issue #2012). No identity field, so the only thing that
      // can pair these is POSITION — and position alone is exactly what the
      // paragraph above refuses. What licenses it is corroboration: the index
      // counts match, every position the source does NOT spell as a reference
      // is deep-equal on both sides, each reference-bearing element carries its
      // own evidence, and no two of them look alike to the anchors. AWS's own
      // unrewritten values then vouch for the alignment, and a reorder they
      // cannot see is refused rather than guessed at. The last two conditions
      // are the review's, not the original formulation's, and the shapes that
      // forced them are named on `unkeyedArrayPairsByAnchors`.
      if (!unkeyedArrayPairsByAnchors(bag, source)) return bag;
      return bag.map((item, i) =>
        refuseUncertifiedReadbackPositions(item, source[i], secrets, learn, mark)
      );
    }
    const sourceByIdentity = new Map<string, unknown>();
    for (const item of source) {
      sourceByIdentity.set((item as Record<string, unknown>)[key] as string, item);
    }
    return bag.map((item) => {
      const partner = sourceByIdentity.get((item as Record<string, unknown>)[key] as string);
      return partner === undefined
        ? item
        : refuseUncertifiedReadbackPositions(item, partner, secrets, learn, mark);
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
    // BOTH POSITION PASSES FIRST, over the UNTOUCHED bag. `secrets` is EMPTY by
    // construction on every path {@link isReadbackProjectedFromState} selects,
    // so `redactByPath`'s value arms are no-ops and this pair is byte-identical
    // to the shipped pipeline. The DERIVED needles are then scanned over the RAW
    // bag and MERGED over this pair's output by
    // {@link preferPositionDecisions} — NOT run "after" it, which is a
    // distinction PR #2415 paid for twice.
    //
    // The first revision fed the derived map into `redactByPath` BEFORE the
    // refusal pass, and the security review probed the regression: the value
    // scan can rewrite a frame LITERAL that happens to contain a learned
    // plaintext (a coinciding anchor — exactly this issue's population), after
    // which `unkeyedArrayPairsByAnchors` re-runs against the SCANNED bag, the
    // rewritten anchor no longer deep-equals its source, the WHOLE array
    // refuses, and a sibling MIXED leaf that the shipped code redacts BY
    // POSITION persists in full plaintext. A derived needle could therefore
    // UN-CERTIFY a pairing — a regression of shipped redaction, in the
    // GHSA-p5qg-v9gv-hc7w disclosure direction.
    //
    // The second revision simply ran the scan LAST over their output, which is
    // the MIRROR defect — see {@link preferPositionDecisions}, where both are
    // measured and the merge that ends them is argued.
    const positioned = redactByPath(bag, source, secrets, rules, recordedExpressionsOf(secrets));
    if (!isReadbackProjectedFromState(rules)) return positioned as T;
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
    //
    // `secrets`, NOT the derived map, and this is the one line where the
    // distinction can turn a fix into a disclosure. The refusal pass reads its
    // map for exactly one decision — {@link mixedLeafMayCarryPublicReference} —
    // and that predicate SPLITS on whether a map exists: a non-empty map means
    // "a resolution pass ran, so absence from the verdict store is evidence of
    // a PUBLIC parameter, keep the resolved value". A DERIVED map satisfies
    // `size > 0` while proving nothing of the kind — nothing was resolved and
    // nothing could have been recorded — so handing it over would read every
    // `{{resolve:ssm:` mixed leaf as public and persist the decrypted
    // `SecureString`. That is the regression the `secrets-dynamic-ref` integ
    // caught before #1926 shipped, reachable again through a new door. Neither
    // the merge nor anything above softens it: the derived map still never
    // reaches this call.
    const refused = refuseUncertifiedReadbackPositions(positioned, source, secrets);
    // DERIVED NEEDLES (issue #2012), scanned over the RAW bag and MERGED over
    // the two passes above. On an empty-map readback path the value scan has
    // nothing to look for, which is why the two positionless shapes kept their
    // plaintext. This gives it needles taken from the record's OWN certified
    // positions — see {@link deriveReadbackNeedles}. Every other caller gets
    // `secrets` back by identity, so nothing else changes.
    //
    // The LEARN pass reads `bag`, the RAW readback, not `refused`: it needs the
    // pre-substitution values, since a position the refusal pass has already
    // rewritten onto its source expression no longer carries the plaintext the
    // pairing is made of.
    const derived = deriveReadbackNeedles(bag, source, secrets, rules);
    if (derived === undefined) return refused as T;
    // Scanned over the RAW bag, then merged so the passes above win wherever
    // they DECIDED a position — see {@link preferPositionDecisions} for the two
    // fabricated-baseline shapes the naive orderings produce. Scanning `bag`
    // rather than `refused` also means the scan never sees a persisted
    // expression, so it cannot splice a needle into one.
    // The MARK pass: the same walk again, over the same inputs, returning
    // POSITION_DECIDED wherever it decides. Cheap (in-memory, no needles, no
    // learning) and exact, because it IS the pass rather than a mirror of it.
    const marks = refuseUncertifiedReadbackPositions(positioned, source, secrets, undefined, true);
    return preferPositionDecisions(
      redactSecretsForState(bag, derived.certain),
      refused,
      bag,
      marks,
      derived.inferred
    ) as T;
  }
  // `substringNeedlesOf`, not `secrets.keys()`: the MASK-ONLY class (issue
  // #2274) is withheld from this scan and reaches the whole-value arm below
  // only. See the mask-only channel note above — an inline `***` cannot be told from
  // a user's own literal, so nothing downstream could recognise it and
  // `drift --revert` / the rollback replay would push the corrupted string to
  // AWS. Every EXPRESSION-bearing needle is unaffected, so a bag with no
  // mask-only entry produces a byte-identical regex.
  const regex = buildNeedleRegex(substringNeedlesOf(secrets));
  // Even below the needle threshold, a NON-EMPTY whole-value match must still be
  // redacted. An empty-string secret is never a needle (it would match every
  // empty leaf and corrupt unrelated properties); a resolved secret of '' is
  // degenerate and the resolver does not record one.
  //
  // This arm is ALSO where a mask-only entry is served: `secrets.get(s)` is
  // {@link SECRET_MASK} for one, so the leaf is replaced WHOLE.
  const wholeValueExpr = (s: string): string | undefined => (s === '' ? undefined : secrets.get(s));

  /**
   * The SUBSTRING arm for a leaf the resolver substituted INTO rather than
   * replaced. ONE rule over the WHOLE leaf (issue
   * [#1935](https://github.com/go-to-k/cdkd/issues/1935)):
   *
   * > replace every recorded-plaintext match EXCEPT one that lies STRICTLY
   * > INSIDE a complete `{{resolve:...}}` span.
   *
   * "Strictly inside" means contained by a span and SHORTER than it. The four
   * positions a match can take, and why each lands where it does:
   *
   * - **strictly inside a span** -> KEPT. This is the defect: a plaintext that
   *   happens to occur inside a token's own TEXT was spliced into the
   *   reference. Deploy 1 persists
   *   `jdbc://appdb:{{resolve:secretsmanager:appdb/creds:SecretString:password}}@host`;
   *   deploy 2 records an ssm SecureString whose plaintext is `appdb`; the walk
   *   wrote `{{resolve:secretsmanager:{{resolve:ssm:/app/dbname}}/creds:...}}`.
   *   `resolveReplayProps` scans with `([^}]+)`, which stops at the FIRST `}`,
   *   so the replay asks Secrets Manager for the secret id
   *   `{{resolve:ssm:/app/dbname` — rollback blocked, or garbage applied to a
   *   live resource. `cdkd scrub` writes the same wreckage into `properties`
   *   and `observedProperties`.
   * - **coextensive with a span** -> REPLACED. A secret whose resolved
   *   PLAINTEXT is itself a `{{resolve:...}}` string (issue #1917), embedded in
   *   a larger leaf. This is why "mask only OUTSIDE the spans" is wrong on its
   *   own: that plaintext IS a span, so span-skipping would stop redacting it
   *   and trade a mangling bug for a disclosure.
   * - **containing or straddling a span** -> REPLACED. A recorded plaintext
   *   that embeds a whole reference plus surrounding text. Nothing is spliced,
   *   because the whole reference is consumed by the replacement. An earlier
   *   revision of this fix expressed the rule as TWO rules — replace a span
   *   that is a recorded plaintext, value-scan the text between spans — and
   *   that form DROPPED this case at both ends (it is neither a whole span nor
   *   contained in the text between spans), persisting the plaintext in the
   *   clear where the pre-fix code had redacted it. A REGRESSION, caught by the
   *   security review, and the reason the rule is one predicate over the whole
   *   leaf rather than a split.
   * - **disjoint from every span** -> REPLACED. The ordinary embedded secret.
   *
   * Scanning the WHOLE leaf in ONE pass is also what preserves what needle
   * PRECEDENCE there is. {@link buildNeedleRegex} sorts alternatives
   * longest-first, which decides only between alternatives matching at the SAME
   * offset; the scan itself is LEFTMOST-first, so a shorter secret starting
   * EARLIER still wins and the tail of the longer one survives in the clear
   * (`zzABCDEFzz` with needles `ABCD` / `BCDEF` leaves `EF`). That is regex
   * semantics, identical before and after this change, and is not something
   * this rule claims to fix.
   *
   * What the single pass DOES restore is the same-offset ordering across a span
   * boundary. The two-rule form scanned each BETWEEN-span stretch separately,
   * so a long straddling needle was never even a candidate and a short one
   * starting later in the tail won by default — the leaf took the WRONG
   * expression, which the replay then re-resolves and applies (the issue #1910
   * class).
   *
   * TWO KNOWN RESIDUALS around a STRAY `{{resolve:` opener, both pinned by
   * tests rather than left as prose, and they fail in OPPOSITE directions
   * because the span grammar is greedy `[^}]+` (deliberately — it is the
   * resolver's own spelling, unified by issue #1936):
   *
   * - **no later `}}` in the leaf** -> no span, so a needle after the opener is
   *   REPLACED and the result reads as a reference to a bogus secret id.
   *   Identical to the pre-fix code. Refusing to redact there would leave
   *   PLAINTEXT behind two characters any string can contain.
   * - **a later `}}` anywhere in the leaf** -> the opener and that `}}` form
   *   ONE span swallowing everything between them, so a needle in that region
   *   is KEPT — the only shape where this rule redacts LESS than the code it
   *   replaced. Narrow but real, and the reachable carrier is named rather than
   *   waved at: the resolver shares this grammar, so such a leaf could not have
   *   resolved on the deploy path, which leaves an `observedProperties`
   *   READBACK (arbitrary text from AWS) as the way one arrives.
   *
   * Narrowing the span pattern here would close the second and open two worse
   * holes: it would re-fork the one grammar issue #1936 unified, and it would
   * make an ALREADY-MANGLED legacy leaf parse differently and be spliced again,
   * contradicting this change's own "not repaired, not made worse" property.
   * So the residual is documented, not fixed.
   */
  const scanLeaf = (value: string, needles: RegExp): string => {
    // Only a leaf that HOLDS a reference can have a span, and the dominant leaf
    // does not — so the offsets are computed only where they can matter.
    const spans = isDynamicReferenceString(value) ? dynamicReferenceSpans(value) : [];
    // No `lastIndex` reset before `replace`: `RegExp.prototype[Symbol.replace]`
    // sets it to 0 itself for a `/g` pattern. The reset before `.test` at the
    // call site is the one that IS needed.
    return value.replace(needles, (match: string, offset: number) => {
      const end = offset + match.length;
      const strictlyInsideASpan = spans.some(
        (span) =>
          span.start <= offset && end <= span.end && (span.start !== offset || span.end !== end)
      );
      if (strictlyInsideASpan) return match;
      // Unreachable today: `needles` is built from {@link substringNeedlesOf},
      // i.e. from `secrets.keys()` minus the mask-only class, so every match is
      // a key. (It was `secrets.keys()` verbatim before issue #2274 narrowed
      // the substring arm; the reachability argument is unchanged, since
      // narrowing the needle set can only REMOVE matches.) {@link SECRET_MASK}
      // anyway on a miss, and the polarity is the
      // whole point of keeping a dead branch — a caller that ever hands this
      // function a regex built from somewhere else gets a MASK rather than the
      // plaintext. An earlier revision made it identity on the grounds that the
      // branch cannot run; a branch that cannot run still has to fail in the
      // safe direction, because the day it runs is the day nobody is looking.
      return secrets.get(match) ?? SECRET_MASK;
    });
  };

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
      //
      // {@link scanLeaf} answers this shape identically, and the argument is
      // short enough to check: the whole-value arm above has already ruled out
      // the leaf BEING a recorded plaintext, so no match can be coextensive
      // with the single span covering it, and every other match is strictly
      // inside that span and therefore kept. It stays as an EARLY-OUT because
      // the whole-token leaf is what a re-scrub of already-clean state is made
      // of, and it costs a `matchAll` plus a string rebuild otherwise.
      //
      // Removing it is an EQUIVALENT mutant, so no test can red on it — stated
      // rather than claimed pinned, which an earlier revision of this comment
      // got wrong. What IS pinned is the ANSWER for this shape, so an edit that
      // makes the two paths disagree reds whichever one it broke.
      if (isSingleDynamicReferenceToken(value)) return value;
      // No needle can be a token-shaped plaintext either: the shortest possible
      // `{{resolve:x}}` is far longer than {@link MIN_NEEDLE_LENGTH}, so an
      // absent regex means nothing in this leaf can be rewritten at all.
      if (!regex) return value;
      // `.test` on a `/g` pattern ADVANCES `lastIndex`, so it is reset before
      // every use. A leaf holding no needle occurrence cannot be rewritten:
      // a span that is a recorded plaintext would be a needle match itself.
      regex.lastIndex = 0;
      if (!regex.test(value)) return value;
      return scanLeaf(value, regex);
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
 *
 * The MASK-ONLY class (issue #2274) participates here FULLY — `secrets.keys()`,
 * not the persist path's narrowed `substringNeedlesOf` — and the asymmetry is
 * deliberate rather than an oversight. The persist path withholds the substring
 * arm from a mask because an inline `***` is a value nothing downstream can
 * recognise or re-resolve; this output is a log line, an error message or an
 * event, which no consumer reads back as a value, so a partial mask costs
 * nothing and closes an EMBEDDED disclosure that would otherwise print. See
 * the mask-only channel note above.
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
 *
 * EXPORTED so a caller that RENDERS a chain walks exactly the links
 * {@link maskSecretsInError} masked — the two sets must be the same one. A
 * renderer with its own walk would eventually print a link past the depth cap,
 * which by that function's contract still carries its ORIGINAL, unmasked
 * message. `cdkd scrub`'s `--all` loop is the first such caller.
 */
export function errorCauseChain(root: Error): Error[] {
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
 *
 * A DIFFERENT `NoEcho` — the CUSTOM-RESOURCE RESPONSE field of the same name —
 * IS covered since issue #2274, through {@link recordMaskOnlyValue}. Do not
 * read that as closing #1998: a template PARAMETER's `NoEcho` and a custom
 * resource's `NoEcho` share only a spelling. The parameter case has a `Ref`
 * whose value cdkd must keep serving from state on every later deploy, so it
 * cannot take a mask on the same terms; the custom-resource case is a
 * handler-GENERATED value that arrives fresh with each invocation. #1998
 * remains open on its own Direction 2 (the persistence question), which #2274
 * answers only for the response field.
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
