import { type RecordedSecretValues, SECRET_MASK, mergeResolvedPairs } from './pairs.js';
import { MIN_NEEDLE_LENGTH } from './rules.js';

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
 * is its only writer, for two reasons. This family is the LEAF — the resolver
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
 * ({@link pinScopedSecretVerdict}) for every later reader of THIS set. It is
 * still not strictly sound across regions or accounts in one run — the same
 * expression can name a `SecureString` in one region and a plain `String` in
 * another — but note which way the imprecision points in EACH direction now
 * that the two stores can disagree. An entry only ever GRANTS "persist the
 * source leaf verbatim", so a verdict inherited from another region can at
 * worst store a public reference as an expression (a spurious UPDATE, issue
 * #1901's class), never a secret as plaintext. And the opposite move — another
 * region RETRACTING a verdict this stack still needs — cannot un-redact
 * anything either, because each of the resolver's own cache entries carries the
 * verdict that produced it and re-records on a hit without consulting this set.
 *
 * The RESOLVER does not read this set (issue
 * [#4105](https://github.com/go-to-k/cdkd/issues/4105)). Its skip arm asks
 * {@link isScopedSecretVerdict} for its OWN scope instead, because there a
 * foreign region's `SecureString` verdict skipped the lookup and left a public
 * `String` token unresolved on every diff. The scoped half is written beside
 * this set by the same call and is never retracted by another scope, so a
 * stack keeps its own verdict whatever another region last said.
 */
export const recordedSecretExpressions = new Set<string>();

/**
 * expression -> the SCOPES that pinned a definitive SECRET verdict for it
 * (issue #4105). Written only beside {@link recordedSecretExpressions}, by
 * {@link pinScopedSecretVerdict}.
 */
const secretVerdictScopes = new Map<string, Set<string>>();

/** Remember that `expression` resolves to a secret, with no scope. */
export function recordSecretExpression(expression: string): void {
  recordedSecretExpressions.add(expression);
}

/**
 * Forget a previously recorded expression, in every scope — the resolver's
 * `SecureString` verdict going the other way (an ssm parameter that turns out
 * to be a plain `String` / `StringList`, i.e. public config that must stay
 * RESOLVED in state). The resolver itself retracts through
 * {@link pinScopedSecretVerdict}, which keeps other scopes' entries.
 */
export function forgetSecretExpression(expression: string): void {
  recordedSecretExpressions.delete(expression);
  secretVerdictScopes.delete(expression);
}

/**
 * Pin `scope`'s DEFINITIVE verdict on `expression` (issue #4105). `scope`
 * names where the answer was read — the resolver's region and credential
 * identity — and is opaque here.
 *
 * The process-wide set takes the verdict exactly as before the scope existed:
 * added on secret, deleted on public, whichever scope last answered. The
 * scoped half changes only `scope`'s own entry.
 */
export function pinScopedSecretVerdict(scope: string, expression: string, secret: boolean): void {
  const scopes = secretVerdictScopes.get(expression);
  if (secret) {
    if (scopes) scopes.add(scope);
    else secretVerdictScopes.set(expression, new Set([scope]));
    recordedSecretExpressions.add(expression);
    return;
  }
  if (scopes?.delete(scope) && scopes.size === 0) secretVerdictScopes.delete(expression);
  recordedSecretExpressions.delete(expression);
}

/**
 * Has `scope` ITSELF pinned `expression` as secret? False for a verdict another
 * scope pinned, and for an unscoped {@link recordSecretExpression} entry.
 */
export function isScopedSecretVerdict(scope: string, expression: string): boolean {
  return secretVerdictScopes.get(expression)?.has(scope) === true;
}

/** Has `expression` been PROVEN to resolve to a secret this process? */
export function isRecordedSecretExpression(expression: string): boolean {
  return recordedSecretExpressions.has(expression);
}

/** Drop every remembered verdict. Paired with the resolver's cache reset. */
export function clearRecordedSecretExpressions(): void {
  recordedSecretExpressions.clear();
  secretVerdictScopes.clear();
}

/**
 * `{{resolve:ssm:...}}` expressions PROVEN to name a public (`String` /
 * `StringList`) parameter, per bag INSTANCE (issue
 * [#2036](https://github.com/go-to-k/cdkd/issues/2036)), each with the public
 * VALUE the proving lookup returned. `false` is a contradiction no later proof
 * can lift.
 *
 * Keyed by the bag, never by the bare expression, and that is the whole
 * design. PR #2415 withdrew a process-wide public store because the same
 * parameter NAME in another region or account can be a `SecureString`: a
 * verdict written in one scope and never contradicted un-redacted the other.
 * A bag is one resource's pass, and its writers are the lookups made FOR that
 * bag — the resolver resolving that record's own references in the region
 * that answers for them (`cdkd drift`), or `PublicSsmProver.proofBagFor`
 * asking in the record's own region (`cdkd state refresh-observed`). A view or
 * copy of a bag does NOT inherit it: the reader then finds no proof and
 * over-redacts, which is the safe direction.
 *
 * The VALUE is what makes a TYPE answer usable as evidence about a READBACK.
 * The type is read now, while the readback holds whatever the last deploy
 * resolved, and a parameter retyped since (a SecureString recreated as a
 * `String`), or a same-named public parameter in the wrong region, answers
 * "public" about a value that was a secret. So the reader admits a leaf only
 * when the readback EQUALS the source with every token replaced by its proven
 * value (`mixedLeafProvenPublic` in `redact-path.ts`): a public parameter's own value, not a
 * statement about some other one.
 *
 * Read through {@link provenPublicValue} — by `mixedLeafMayCarryPublicReference`'s
 * empty-map arm and by the prover copying a probe's proof into a record bag.
 */
const provenPublicExpressions = new WeakMap<RecordedSecretValues, Map<string, string | false>>();

function proofsOf(bag: RecordedSecretValues): Map<string, string | false> {
  let proofs = provenPublicExpressions.get(bag);
  if (!proofs) {
    proofs = new Map();
    provenPublicExpressions.set(bag, proofs);
  }
  return proofs;
}

/**
 * Record that this pass's lookup proved `expression` names a public parameter
 * whose value is `value`. A second proof with a DIFFERENT value is a
 * contradiction: the pass cannot say which value the readback holds.
 */
export function recordProvenPublicExpression(
  bag: RecordedSecretValues,
  expression: string,
  value: string
): void {
  const proofs = proofsOf(bag);
  const prior = proofs.get(expression);
  if (prior === false) return;
  proofs.set(expression, prior === undefined || prior === value ? value : false);
}

/**
 * Record that this pass saw `expression` answer anything OTHER than a public
 * type (a `SecureString`, or a type too anomalous to classify), or that it was
 * resolved as a secret elsewhere in this record. Sticky.
 */
export function contradictProvenPublicExpression(
  bag: RecordedSecretValues,
  expression: string
): void {
  proofsOf(bag).set(expression, false);
}

/**
 * The PROVEN public value of `expression` for this bag, or `undefined` on any
 * doubt: no proof, a contradiction, the bag itself holding a resolved secret
 * under this expression, or any scope's process-wide SECRET verdict for it.
 * The last one can only cost an over-redaction, which is the direction this
 * module is allowed to be wrong in.
 */
export function provenPublicValue(
  bag: RecordedSecretValues,
  expression: string
): string | undefined {
  const value = provenPublicExpressions.get(bag)?.get(expression);
  if (value === undefined || value === false) return undefined;
  if (recordedSecretExpressions.has(expression)) return undefined;
  for (const recorded of bag.values()) {
    if (recorded === expression) return undefined;
  }
  return value;
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
 * whole or not at all. A leaf that merely CONTAINS a `NoEcho` value is
 * therefore masked WHOLE rather than in place (go-to-k/cdkd#2453); see
 * {@link containmentNeedlesOf}.
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
export function isMaskOnlyPlaintext(secrets: RecordedSecretValues, plaintext: string): boolean {
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
export type WalkedContainers = Set<object>;

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
 * `CustomResourceProvider.delete` reads it back from, which can then no
 * longer address the handler and SKIPS the delete, keeping the record
 * (go-to-k/cdkd#3938). Such a value is not
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
 * WHOLE leaves only, matching the arm the excluded registration is served on:
 * a custom resource's own `Data` is registered without the containment mark
 * ({@link containmentValuesOf}), so it never reaches the containment arm, and
 * a plaintext that merely OCCURS inside a property is not something this
 * exclusion has to answer for.
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
 * Register the values of a provider result's `NoEcho`-declared attributes as
 * MASK-ONLY needles in `secrets` (issue #2274), so the record built from that
 * result stores `***` there — and return the declaration that registered
 * anything: `true` for the whole bag, the declared names actually returned,
 * or `undefined` when nothing was registered.
 *
 * The shared half of every writer that persists a provider's `attributes`: the
 * deploy engine's `registerNoEchoAttributes` (which also remembers the returned
 * declaration so a dependent's `Fn::GetAtt` is masked too), and the rollback
 * executor's record rebuilds (go-to-k/cdkd#4434), which persist the attributes
 * a replayed `create()` / `update()` returned — a custom resource answering
 * `NoEcho: true` would otherwise land in `state.json` in the clear.
 *
 * `ownProperties` is the resource's own RESOLVED property bag; its whole string
 * leaves are excluded, so a handler echoing its inputs into `Data` cannot mask
 * cdkd's own `ServiceToken` back at it (go-to-k/cdkd#3938).
 *
 * The per-name arm counts only names the returned bag OWNS: a declaration is
 * evidence about a VALUE, and with no value there is no needle to record.
 */
export function recordNoEchoAttributeValues(
  result: {
    attributes?: Record<string, unknown> | undefined;
    noEchoAttributes?: boolean | undefined;
    noEchoAttributeNames?: readonly string[] | undefined;
  },
  secrets: RecordedSecretValues,
  ownProperties?: Record<string, unknown>
): true | Set<string> | undefined {
  const attributes = result.attributes;
  if (attributes === undefined) return undefined;
  const excluded = ownProperties === undefined ? undefined : wholeStringLeavesOf(ownProperties);
  if (result.noEchoAttributes === true) {
    recordMaskOnlyValuesIn(attributes, secrets, excluded);
    return true;
  }
  const names = (result.noEchoAttributeNames ?? []).filter((name) =>
    Object.hasOwn(attributes, name)
  );
  if (names.length === 0) return undefined;
  for (const name of names) recordMaskOnlyValuesIn(attributes[name], secrets, excluded);
  return new Set(names);
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
 * treating it as a mask would refuse ordinary values. That is why a leaf
 * EMBEDDING a `NoEcho` value is persisted as the whole mask rather than
 * with an inline one (go-to-k/cdkd#2453): it stays recognisable here.
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
 * The mask-only plaintexts of a pass that are a `NoEcho` value SUPPLIED IN THIS
 * DEPLOY (go-to-k/cdkd#3662), keyed by the pass's map exactly like
 * {@link resolvedPairsOf}: a copy of the map is a different pass and starts
 * with none.
 *
 * WHY A SIDE SET, when the sentinel value is otherwise the whole marker: the
 * mask-only class has TWO populations and one question tells them apart. A
 * `NoEcho` value (a handler's `Data`, or a producer output recovered from this
 * process) is fresh evidence that can differ from what the record's `***`
 * stood for. A DERIVED needle (`Fn::Base64` over a `{{resolve:...}}` input,
 * issue #2759) is the encoding of a secret whose reference the record already
 * positions, and treating it as fresh would update that resource on every
 * deploy — measured on the #3662 review round with a Base64 `UserData`. The
 * engine's no-change skip asks {@link carriesFreshNoEchoValue}, and only the
 * first population answers it.
 */
export const freshNoEchoValuesOf = new WeakMap<RecordedSecretValues, Set<string>>();

function freshNoEchoSet(secrets: RecordedSecretValues): Set<string> {
  return sideSetOf(freshNoEchoValuesOf, secrets);
}

/**
 * The mask-only plaintexts of a pass that a persisted leaf may not CONTAIN
 * (go-to-k/cdkd#2453) — the population {@link containmentNeedlesOf} reads,
 * keyed by the pass's map like {@link freshNoEchoValuesOf}.
 *
 * Only the RESOLVER's writers add to it: a `NoEcho` value registered by
 * {@link recordFreshNoEchoValuesIn}, and a derived `Fn::Base64` needle
 * ({@link recordDerivedMaskOnlyValue}). Both are values the resolver
 * substituted into a leaf, so either can sit inside a longer one. The other
 * mask-only writers stay whole-leaf: the custom resource's OWN `Data`
 * registration, whose values (a region, an account id) can be substrings of
 * its own `ServiceToken`, the ARN `CustomResourceProvider.delete` reads back;
 * and the `drift` write paths' live-value registrations, which would otherwise
 * mask unrelated leaves of the baseline they write.
 */
export const containmentValuesOf = new WeakMap<RecordedSecretValues, Set<string>>();

export function sideSetOf(
  table: WeakMap<RecordedSecretValues, Set<string>>,
  secrets: RecordedSecretValues
): Set<string> {
  let set = table.get(secrets);
  if (set === undefined) {
    set = new Set();
    table.set(secrets, set);
  }
  return set;
}

/**
 * {@link recordMaskOnlyValue} for the `Fn::Base64` encoding of a secret-bearing
 * input: a DERIVED needle, whole-leaf like every mask-only value and also
 * matched by CONTAINMENT (go-to-k/cdkd#2453), since `Fn::Join` / `Fn::Sub` can
 * embed the encoding in a longer leaf, where it decodes straight back to the
 * secret. Not FRESH (see {@link freshNoEchoValuesOf}).
 */
export function recordDerivedMaskOnlyValue(secrets: RecordedSecretValues, plaintext: string): void {
  recordMaskOnlyValue(secrets, plaintext);
  if (isMaskOnlyPlaintext(secrets, plaintext))
    sideSetOf(containmentValuesOf, secrets).add(plaintext);
}

/**
 * {@link recordMaskOnlyValuesIn} for a `NoEcho` value supplied in THIS deploy,
 * which additionally marks each leaf it registered as FRESH (see
 * {@link freshNoEchoValuesOf}). The three writers are the ones that hold such a
 * value: the resolver's `Fn::GetAtt` note for a resource whose provider
 * declared `NoEcho` earlier in this run, the cross-stack recovery of an output
 * this process masked, and `Fn::Base64` over an input that embeds one.
 *
 * Each such leaf is also a CONTAINMENT needle ({@link containmentValuesOf}),
 * unless it EQUALS one of `publicTokens` (go-to-k/cdkd#2453): values state
 * already holds in the clear — the region, the stack name, the producing
 * custom resource's `ServiceToken` and each of its `:`-separated segments (the
 * account id, the function name). A handler echoing one under `NoEcho` would
 * otherwise flatten every ARN of every dependent. Such a value is not
 * handler-GENERATED, so leaving it out of the containment arm costs no
 * secrecy; it stays a whole-leaf needle as before. EQUALITY, never
 * containment: a generated value that merely occurs inside the stack name
 * (`prod` in `myapp-prod-stack`) is still a secret, and stays a needle.
 */
export function recordFreshNoEchoValuesIn(
  value: unknown,
  secrets: RecordedSecretValues,
  excluded?: ReadonlySet<string>,
  publicTokens?: ReadonlySet<string>
): void {
  recordMaskOnlyValuesIn(value, secrets, excluded);
  const fresh = freshNoEchoSet(secrets);
  const containment = sideSetOf(containmentValuesOf, secrets);
  const seen: WalkedContainers = new Set();
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      // Only a leaf the call above really registered: an excluded one, one
      // under the floor, or one carrying an expression stays out.
      if (excluded?.has(node) !== true && isMaskOnlyPlaintext(secrets, node)) {
        fresh.add(node);
        if (publicTokens?.has(node) !== true) containment.add(node);
      }
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
 * The fresh mask-only plaintexts of a pass that a `NoEcho: true` template
 * PARAMETER supplied (go-to-k/cdkd#4043), as opposed to a custom resource's
 * handler or a recovered output. The engine reads the two classes differently:
 * a parameter's value is confirmed by a readback whatever the property's
 * replacement class, and a create-only property it feeds is never replaced on
 * that readback's word (maintainer decision on #4043), while the
 * custom-resource class keeps the go-to-k/cdkd#3729 table.
 */
export const noEchoParameterValuesOf = new WeakMap<RecordedSecretValues, Set<string>>();

/**
 * Record a `NoEcho` parameter's resolved value as a FRESH mask-only needle of
 * the pass (the value arm, go-to-k/cdkd#4043 §3.1): every string leaf is
 * registered by {@link recordFreshNoEchoValuesIn} and marked as the parameter
 * class. A leaf under `MIN_NEEDLE_LENGTH`, or a number, registers nothing; the
 * positional arm covers it.
 */
export function recordNoEchoParameterFreshValue(
  value: unknown,
  secrets: RecordedSecretValues,
  publicTokens?: ReadonlySet<string>
): void {
  recordFreshNoEchoValuesIn(value, secrets, undefined, publicTokens);
  const parameterClass = sideSetOf(noEchoParameterValuesOf, secrets);
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      if (isMaskOnlyPlaintext(secrets, node)) parameterClass.add(node);
      return;
    }
    if (Array.isArray(node)) for (const item of node) walk(item);
  };
  walk(value);
}

/**
 * A copy of `secrets` without the FRESH `NoEcho` entries (a parameter's value,
 * a declared attribute's, a recovered output's), with the uncollapsed pairs
 * and the remaining side-set marks carried: the map the persist walk reads
 * for the dynamic-reference arms alone, which the migration witness compares
 * a pre-v11 record against (go-to-k/cdkd#4043). A record a pre-v11 binary
 * wrote holds `***` for a custom resource's own declared value already, so
 * dropping that class here confirms nothing it should not.
 */
export function withoutNoEchoParameterEntries(secrets: RecordedSecretValues): RecordedSecretValues {
  const fresh = freshNoEchoValuesOf.get(secrets);
  if (fresh === undefined || fresh.size === 0) return secrets;
  const copy: RecordedSecretValues = new Map();
  for (const [plaintext, expression] of secrets) {
    if (expression === SECRET_MASK && fresh.has(plaintext)) continue;
    copy.set(plaintext, expression);
  }
  mergeResolvedPairs(secrets, copy);
  carryMaskOnlyMarks(secrets, copy);
  return copy;
}

/**
 * Mark an already-registered fresh mask-only `plaintext` as the PARAMETER
 * class: a value DERIVED from a parameter's (its `Fn::Base64` encoding) is
 * read the way the value itself is.
 */
export function markNoEchoParameterClass(secrets: RecordedSecretValues, plaintext: string): void {
  if (isMaskOnlyPlaintext(secrets, plaintext))
    sideSetOf(noEchoParameterValuesOf, secrets).add(plaintext);
}

/**
 * Is `plaintext` a fresh value of `secrets` that a `NoEcho` PARAMETER supplied?
 *
 * Only while its map entry is still the mask (go-to-k/cdkd#4043 review round
 * 12): the resolver's dynamic-reference seam overwrites an entry with its
 * secret expression (a `{{resolve:...}}` resolving to the same plaintext),
 * while this side set keeps the mark. A stale mark must not make a secret
 * pair read as a `NoEcho` parameter's value.
 */
export function isNoEchoParameterPlaintext(
  secrets: RecordedSecretValues,
  plaintext: string
): boolean {
  return (
    noEchoParameterValuesOf.get(secrets)?.has(plaintext) === true &&
    isMaskOnlyPlaintext(secrets, plaintext)
  );
}

/** The `NoEcho` PARAMETER values of `secrets` whose map entry is still the mask. */
export function noEchoParameterPlaintextsOf(secrets: RecordedSecretValues): string[] {
  return [...(noEchoParameterValuesOf.get(secrets) ?? [])].filter((plaintext) =>
    isMaskOnlyPlaintext(secrets, plaintext)
  );
}

/**
 * Carry the FRESH mark of `plaintext` from `from` into `to`, when `from` marks
 * it and `to` holds it as mask-only (go-to-k/cdkd#3717). The one caller is the
 * resolver's inherited-parameter recording in a nested CHILD: the parent's
 * bag for the `AWS::CloudFormation::Stack` row is where a `NoEcho` value this
 * deploy supplied was marked, and the child resource reading the parameter
 * records the pair into its OWN bag, a different pass — which is exactly the
 * copy {@link freshNoEchoValuesOf} otherwise starts empty, so without this the
 * child's no-change skip read the new value's `***` as equal to its record.
 * The CONTAINMENT mark ({@link containmentValuesOf}) travels too, including for
 * a derived needle that carries no fresh mark (go-to-k/cdkd#2453).
 */
export function carryFreshNoEchoMark(
  from: RecordedSecretValues,
  to: RecordedSecretValues,
  plaintext: string
): void {
  if (!isMaskOnlyPlaintext(to, plaintext)) return;
  // Containment FIRST, and not gated on freshness: a derived `Fn::Base64`
  // needle is never fresh, and a child leaf embedding it must still be masked.
  if (containmentValuesOf.get(from)?.has(plaintext) === true) {
    sideSetOf(containmentValuesOf, to).add(plaintext);
  }
  if (freshNoEchoValuesOf.get(from)?.has(plaintext) === true) freshNoEchoSet(to).add(plaintext);
  if (noEchoParameterValuesOf.get(from)?.has(plaintext) === true) {
    sideSetOf(noEchoParameterValuesOf, to).add(plaintext);
  }
}

/**
 * Carry both mask-only side sets of `from` into `to`, for every plaintext `to`
 * holds as mask-only — the half of {@link mergeResolvedPairs} that is not
 * about pairs.
 */
export function carryMaskOnlyMarks(from: RecordedSecretValues, to: RecordedSecretValues): void {
  for (const table of [freshNoEchoValuesOf, containmentValuesOf, noEchoParameterValuesOf]) {
    const marks = table.get(from);
    if (marks === undefined) continue;
    for (const plaintext of marks) {
      if (isMaskOnlyPlaintext(to, plaintext)) sideSetOf(table, to).add(plaintext);
    }
  }
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
 * needle. Closing it means a scope-aware read here; the resolver's own read is
 * scoped since issue #4105, but this reader has no resolver and so no scope.
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
