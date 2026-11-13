import type { StackOrphanRecord, StackState } from './stack-state.js';

/**
 * Returns true when a recorded `DeletionPolicy` should prevent cdkd from
 * deleting the underlying AWS resource. `Retain` and `RetainExceptOnCreate`
 * both keep the resource around; `Delete` / `Snapshot` / undefined all
 * fall through to the normal delete path. Shared between
 * `runDestroyForStack` (state-only, no template) and `DeployEngine`'s
 * DELETE branch (state-preferred, template-fallback) so the two paths
 * cannot drift on the policy semantics. Lives here (not in
 * deploy-engine or destroy-runner) because both consumers already
 * depend on this module — placing it in either would create a cycle.
 */
export function shouldRetainResource(
  deletionPolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined
): boolean {
  return deletionPolicy === 'Retain' || deletionPolicy === 'RetainExceptOnCreate';
}

/**
 * Can this container be read as the record map its type claims it is?
 *
 * THE single plain-object test behind every malformed-bag guard in the repo.
 * `parseStateBody` validates the root object and the schema version and
 * nothing inside, so a hand-edited or truncated record reaches a consumer with
 * `resources` / `outputs` / `attributes` / `properties` holding a string, a
 * list, a number or `null`. `Object.entries` walks a string or a list as
 * readily as a map, so either FABRICATES entries. `in` and `Object.hasOwn`
 * behave differently per shape and neither is a guard: `in` THROWS on a
 * string, a number and `null`, but ANSWERS on a list (`0 in [1,2]` and
 * `'length' in [1,2]` are both `true`), while `Object.hasOwn` ANSWERS on a
 * string and a list alike (`Object.hasOwn('abcdef', '0')` is `true`) and
 * throws ONLY on `null` / `undefined` — the one pair a `?? {}` upstream has
 * usually already absorbed, which is what makes it look like a guard. Do not
 * read a nearby `in` as already catching the list case. Widened past
 * `null` / `undefined` for
 * exactly that reason: `[]`, `5` and `"ab"` all survive `Object.entries` and
 * yield a bag that is empty or, for the string, absurd.
 *
 * WHY IT LIVES HERE rather than beside the guards that grew out of it. Its
 * first home was `src/state/malformed-resources-bag.ts`, which still re-exports
 * it so no importer moved; it came down to this module when
 * {@link importableOutputKeys} needed it (go-to-k/cdkd#3192). That helper sits
 * in `src/types/**`, the layer every other one imports and which imports
 * nothing itself, so the alternative — `src/types/state.ts` importing from
 * `src/state/**` — inverts the layering AND pulls that module's
 * `error-handler` / `display-safe` / `lock-contention-message` chain into the
 * one module the whole codebase depends on. Same move, same reason, as
 * `DEFAULT_STATE_PREFIX` in `src/state/state-prefix.ts`: home the leaf in the
 * layer that needs it, re-export from where it was.
 *
 * Spelling this test a second time at any call site is what the single export
 * exists to prevent: the copies could then drift, and the one that drifted
 * would fabricate again while looking guarded. Enumerate the consumers with
 * `grep -rn "isReadableBag" src/` rather than from a list here — three
 * successive enumerations of them, written by reasoning, came out incomplete.
 *
 * What it does NOT decide is whether a given container is malformed. That is a
 * per-container call, because ABSENCE means different things: an absent
 * `resources` bag is a defect, while an absent `outputs` bag is an ordinary
 * record `cdkd scrub` round-trips on purpose. Each caller pairs this predicate
 * with its own absence rule.
 */
export function isReadableBag(container: unknown): boolean {
  return typeof container === 'object' && container !== null && !Array.isArray(container);
}

/**
 * What KIND of value a record's `region` field holds, as a bounded token safe
 * to print at default verbosity (issue
 * [#3328](https://github.com/go-to-k/cdkd/issues/3328)).
 *
 * The VALUE is never safe there: a body region is chosen by anyone able to
 * write that key, and a line reading `body region 'eu-west-1'` hands an
 * operator a region to aim a destructive re-run at — the misdirection half of
 * that issue. Its kind is the answer to "what is wrong with this record"
 * without being the answer to "which region should I use", and the result is
 * one of TEN fixed strings (`null`, `an array`, and an article plus each of
 * `typeof`'s eight), so no input can forge a line through it.
 *
 * `probeLegacyState` reaches the same JUDGEMENT one field over and does NOT
 * call this — it renders a bare `typeof` into a sentence a unit case pins
 * verbatim (`'region' is number, not a string`). Two spellings of a bounded
 * token, deliberately not collapsed: the two are not interchangeable strings,
 * and changing that one is a message change with its own fence.
 *
 * `null` and arrays are named rather than left as `object`, the way
 * `parseStateBody` names its own refused roots — `typeof null` is `'object'`,
 * which would report the two most likely hand-edit shapes as the same thing.
 * The article is computed because `a object` reads as a defect in the very
 * diagnostic the reader is being asked to trust.
 *
 * HOME: this module rather than beside either caller, for the reason
 * {@link isReadableBag}'s note gives — `src/state/s3-state-backend.ts`
 * (`adoptKeyRegion`, which produces the divergence) and
 * `src/state/malformed-resources-bag.ts` (the destroy refusal that renders it)
 * both need it, and the second is imported by modules that `vi.mock` the
 * first wholesale.
 */
export function describeRegionValueKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  return `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`;
}

/**
 * The keys of `state.outputs` an `Fn::ImportValue` may bind to (issue
 * [#2193](https://github.com/go-to-k/cdkd/issues/2193)) — THE predicate
 * behind "what does this stack export". Four readers used to answer that
 * by walking `outputs` wholesale (the exports index on update and on
 * rebuild, the resolver's state scan, and the local-command loader's
 * `Fn::ImportValue` fallback scan), and each therefore took a plain Output
 * name for an export; they all go through here now, so the rule cannot
 * drift between them.
 *
 * A record whose `exportNames` is unknown (pre-v9, or a v9 partial save that
 * carried a pre-v9 bag forward) keeps the legacy rule — every key — until
 * its next deploy writes the set. A known set is intersected with the bag:
 * an alias whose value did not resolve publishes nothing, and a name the
 * bag does not hold cannot be served.
 *
 * `outputs` is typed required but every consumer treats it as optional (a
 * state file may simply have none), so it is read defensively here too.
 *
 * ## Two FAIL-CLOSED arms for a malformed record (go-to-k/cdkd#3192)
 *
 * Both answer `[]` — "this record exports nothing" — and neither repairs the
 * record or throws. The reasoning is the same for both and is a property of
 * WHERE this function sits: it is a pure predicate with no stack name, no
 * region and no writer of its own, reached from the exports-index rebuild, the
 * deploy-time resolver's state scan, `cdkd diff`'s no-change merge and the
 * local-command loader. Throwing here would be the bare `TypeError`
 * go-to-k/cdkd#3018 set out to remove, renamed; and refusing the whole
 * operation over ONE foreign record would take every OTHER stack's
 * `Fn::ImportValue` down with it. Publishing nothing from a record whose
 * export set cannot be read is the only answer that fabricates nothing and
 * destroys nothing — the damaged record is left exactly as it is, for the
 * write-capable commands (`cdkd orphan` / `import` / `scrub`) to REFUSE by
 * name.
 *
 * 1. `outputs` is not a readable bag. `Object.keys('abcdef')` is
 *    `['0'...'5']`, so the pre-fix code published one fabricated export per
 *    CHARACTER into `cdkd/_index/<region>/exports.json` — the shared index
 *    every consumer's `Fn::ImportValue` binds against. {@link isReadableBag}
 *    is the test, so an ABSENT bag keeps answering `[]` exactly as the old
 *    `?? {}` did; no verdict moves on a healthy or an absent record.
 * 2. `exportNames` is present but not an array. `state.exportNames.filter(...)`
 *    threw `TypeError: state.exportNames.filter is not a function` on a
 *    hand-edited non-array or `null`, from `cdkd diff` among others. Falling
 *    back to the `undefined` arm instead would be fail-OPEN in the one
 *    direction #2193 exists to close — every plain Output name published as an
 *    export — so a corrupt set is read as an EMPTY set, not as an unknown one.
 *    A non-string element is dropped for the same reason: `Object.hasOwn` does
 *    not throw on one, it COERCES, so `exportNames: [0]` would otherwise
 *    publish the bag's `"0"` key. The filter is the identity on every healthy
 *    `string[]`.
 */
export function importableOutputKeys(state: Pick<StackState, 'outputs' | 'exportNames'>): string[] {
  if (!hasReadableExportSet(state)) return [];
  const outputs = state.outputs;
  if (state.exportNames === undefined) return Object.keys(outputs);
  return state.exportNames.filter(
    (name) => typeof name === 'string' && Object.hasOwn(outputs, name)
  );
}

/**
 * The record's `ResourceState.acceptedCreateOnlyDrops` as a set. A
 * missing field, a non-array, or a non-string entry is NO evidence: the field
 * licenses a refusal, so an unreadable one must not.
 */
export function acceptedCreateOnlyDropsOf(record: unknown): ReadonlySet<string> {
  if (record === null || typeof record !== 'object') return new Set();
  const value = (record as { acceptedCreateOnlyDrops?: unknown }).acceptedCreateOnlyDrops;
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((entry): entry is string => typeof entry === 'string'));
}

/**
 * Whether {@link importableOutputKeys} can answer from this record at all —
 * the two fail-closed arms of its own doc, as ONE predicate a caller can ask
 * (issue go-to-k/cdkd#3192).
 *
 * It exists because `[]` is a real answer: a stack that exports nothing and a
 * record whose export set could not be read produce the identical empty list,
 * and a caller that must SAY which one it got cannot re-derive the difference
 * from the list. `ExportIndexStore`'s rebuild is that caller — a silent
 * fail-closed there would leave the next `Fn::ImportValue` miss naming the
 * consumer rather than the damaged producer record.
 *
 * ONE spelling shared with {@link importableOutputKeys}, which calls this
 * rather than repeating the two tests: a second copy could drift, and the copy
 * that drifted would report a record readable while the key list stayed empty,
 * or the reverse.
 *
 * `outputs` absent answers FALSE here, unlike
 * `malformed-resources-bag.ts`'s `hasReadableOutputs`, and the difference is
 * the QUESTION rather than a disagreement: that one asks "is this record
 * damaged" (an absent bag is an ordinary record), this one asks "can an export
 * set be read off it" (it cannot). A caller that must tell absent from damaged
 * tests for absence first, as the exports-index rebuild does.
 */
export function hasReadableExportSet(state: Pick<StackState, 'outputs' | 'exportNames'>): boolean {
  if (!isReadableBag(state.outputs)) return false;
  if (state.exportNames === undefined) return true;
  if (!Array.isArray(state.exportNames)) return false;
  // A NON-EMPTY set whose every element is a non-string is DAMAGED, not
  // "exports nothing" (review of go-to-k/cdkd#3206). Without this arm,
  // `exportNames: [0]` answered READABLE while {@link importableOutputKeys}
  // answered `[]`, so the exports-index rebuild dropped that producer with no
  // warning — the same silent contribute-nothing shape the warning exists to
  // close, one level down. It was nearly written off on the argument that
  // closing it means making "readable" mean "yields at least one KEY", which
  // would fire on the legitimate `exportNames: []`; that is not the only
  // available predicate, and this one is narrower.
  //
  // `some`, NOT `every`: the question is whether ANY element is usable. Two
  // legitimate shapes stay READABLE that an `every` test would reject — `[]`,
  // which is how a record says it exports nothing, and `['Real', 0]`, where
  // dropping the `0` still leaves `Real` to publish. Only a set with nothing
  // usable in it at all is damaged. The residual is deliberate and bounded: a
  // PARTIALLY non-string set publishes its usable names and says nothing about
  // the dropped ones.
  return state.exportNames.length === 0 || state.exportNames.some((n) => typeof n === 'string');
}

/** `state.outputs` narrowed to its {@link importableOutputKeys}. */
export function importableOutputs(
  state: Pick<StackState, 'outputs' | 'exportNames'>
): Record<string, unknown> {
  // Narrowed through the SAME predicate {@link importableOutputKeys} uses, not
  // a bare `?? {}`: the key list is already empty for an unreadable bag, so
  // this changes no verdict — it keeps the indexing below from being the one
  // expression in the pair that would still read off a string if the key list
  // ever stopped dominating it.
  const outputs = isReadableBag(state.outputs) ? state.outputs : {};
  // `Object.create(null)`, NOT `{}`: a JSON-parsed `state.outputs` can carry an
  // OWN key named `__proto__` (JSON.parse makes it own, not the setter), and an
  // `Export.Name` of `__proto__` would then reach this reconstruction. Assigning
  // `picked['__proto__'] = value` onto a plain object literal walks the prototype
  // setter — the key vanishes from the bag fed to the exports index / resolver,
  // and an object value pollutes `picked`'s prototype. Same defense the resolver
  // uses at `intrinsic-function-resolver.ts` (do not "simplify" back to `{}`).
  const picked: Record<string, unknown> = Object.create(null);
  for (const name of importableOutputKeys(state)) picked[name] = outputs[name];
  return picked;
}

/**
 * The `exportNames` half of a record whose `outputs` bag is being CARRIED
 * FORWARD unchanged rather than re-resolved (a partial save on a failed
 * deploy, `cdkd import` over an existing record). The two travel together:
 * carrying the bag without its set would turn a known-exports record back
 * into a "not known" one, and inventing `[]` for a pre-v9 bag would deny
 * every consumer of a stack that never had the chance to write the set.
 * Spread this next to `outputs: previous.outputs` — never write the field
 * by hand at such a site.
 */
export function exportNamesCarriedFrom(
  previous: Pick<StackState, 'exportNames'>
): Pick<StackState, 'exportNames'> {
  return previous.exportNames === undefined ? {} : { exportNames: previous.exportNames };
}

/**
 * Carry {@link StackState.stackInstanceId} and
 * {@link StackState.retiredNameGenerations} across a rebuild (state schema
 * v13, go-to-k/cdkd#5064): absent stays absent, present stays as it was,
 * VERBATIM (a malformed value is the reader's to refuse, never a writer's to
 * drop).
 *
 * **Every** field-enumerating `StackState` literal must spread this, beside
 * {@link orphansCarriedFrom}. A dropped id is silent and turns the stack into
 * a legacy one for every later reader. Spread-form writers
 * (`{ ...previous, ... }`) carry it already; they spread it too, so the rule
 * has no exception to remember
 * (`tests/unit/state/stack-instance-id-carriers.test.ts`).
 */
export function stackInstanceIdCarriedFrom(
  previous:
    | Pick<
        StackState,
        | 'stackInstanceId'
        | 'stackIdFromInstance'
        | 'retiredNameGenerations'
        | 'supersededResources'
        | 'pendingMovesOut'
        | 'terminationProtection'
      >
    | null
    | undefined
): Pick<
  StackState,
  | 'stackInstanceId'
  | 'stackIdFromInstance'
  | 'retiredNameGenerations'
  | 'supersededResources'
  | 'pendingMovesOut'
  | 'terminationProtection'
> {
  // go-to-k/cdkd#5064: the lifetime's retired name generations travel with
  // its id -- a writer that dropped them would hand a re-added resource a
  // name an earlier copy of it held.
  // go-to-k/cdkd#5111: so do the superseded resources still to delete -- a
  // writer that dropped them would leave live resources with no record.
  return {
    ...(previous?.stackInstanceId !== undefined && { stackInstanceId: previous.stackInstanceId }),
    // go-to-k/cdkd#6170: so does the marker choosing its `AWS::StackId` tail
    // -- a writer that dropped it would flip the stack back to `.../cdkd` and
    // replace every resource named from it. VERBATIM, as the id is: a
    // malformed marker is `stackIdTailOf`'s to refuse, and dropping it would
    // turn that refusal into the silent `.../cdkd` fallback.
    ...(previous?.stackIdFromInstance !== undefined && {
      stackIdFromInstance: previous.stackIdFromInstance,
    }),
    ...(previous?.retiredNameGenerations !== undefined && {
      retiredNameGenerations: previous.retiredNameGenerations,
    }),
    ...(previous?.supersededResources !== undefined && {
      supersededResources: previous.supersededResources,
    }),
    // go-to-k/cdkd#5212: so does an unfinished refactor move -- a writer that
    // dropped it would let this stack's next deploy delete a resource the
    // move's destination already holds.
    ...(previous?.pendingMovesOut !== undefined && {
      pendingMovesOut: previous.pendingMovesOut,
    }),
    // go-to-k/cdkd#5238: so does the deployed stack's termination protection
    // -- a writer that dropped it would let `cdkd state destroy` delete a
    // protected stack. Only `true` is carried: a hand-edited other value
    // protects nothing and is not repeated.
    ...(previous?.terminationProtection === true && { terminationProtection: true }),
  };
}

/**
 * The `skippedOutputs` field to write when a save carries the PREVIOUS
 * record's `outputs` bag forward instead of re-resolving it (issue #2740). The
 * record describes that bag — which keys the deploy that wrote it could not
 * resolve — so it travels with the bag, exactly like {@link
 * exportNamesCarriedFrom}: absent stays absent, present stays as it was. A
 * writer that re-resolves outputs does NOT call this; it writes the set the
 * resolution produced, or omits the field when nothing was skipped.
 */
export function skippedOutputsCarriedFrom(
  previous: Pick<StackState, 'skippedOutputs'>
): Pick<StackState, 'skippedOutputs'> {
  return previous.skippedOutputs === undefined ? {} : { skippedOutputs: previous.skippedOutputs };
}

/**
 * Carry {@link StackState.orphans} across a rebuild that does not re-decide it
 * (issue #2934): absent stays absent, present stays as it was.
 *
 * **Every** field-enumerating `StackState` literal must spread this. The field
 * is the only record that a `Retain`-orphaned resource exists at all, so a save
 * that omits it does not merely lose a hint — it makes a live, billing AWS
 * resource untrackable and re-opens the deploy loop the record closes. That is
 * a stronger duty than {@link skippedOutputsCarriedFrom}'s, whose loss costs a
 * diff preview.
 *
 * Writers that re-DECIDE the set do not call this: the rollback arms append,
 * and the deploy drops an entry once it has been adopted or found absent from
 * AWS. Spread-form writers (`{ ...previous, ... }`) carry the field already and
 * need nothing.
 */
export function orphansCarriedFrom(
  previous: Pick<StackState, 'orphans'>
): Pick<StackState, 'orphans'> {
  return previous.orphans === undefined ? {} : { orphans: previous.orphans };
}

/**
 * The `orphans` set a post-rollback save should persist (issue #2934): what the
 * record already carried, plus what THIS rollback just left in AWS.
 *
 * A merge rather than a carry, because a rollback both inherits and produces.
 * Keyed by `logicalId`, newest wins: a resource orphaned twice (deploy fails,
 * user retries, it fails again) has one live AWS resource, and the later record
 * describes the deploy that actually left it there. Keeping both would make the
 * next adoption pick arbitrarily between two states of the same resource.
 *
 * Returns `{}` when there is nothing on either side, so a stack that has never
 * orphaned anything keeps a byte-identical `state.json` and an old binary sees
 * exactly what it saw before.
 */
export function orphansAfterRollback(
  previous: Pick<StackState, 'orphans'>,
  newlyOrphaned: readonly StackOrphanRecord[]
): Pick<StackState, 'orphans'> {
  if (previous.orphans === undefined && newlyOrphaned.length === 0) return {};
  const byLogicalId = new Map<string, StackOrphanRecord>();
  for (const entry of previous.orphans ?? []) byLogicalId.set(entry.logicalId, entry);
  for (const entry of newlyOrphaned) byLogicalId.set(entry.logicalId, entry);
  return { orphans: [...byLogicalId.values()] };
}
