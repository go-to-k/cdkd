/**
 * The `outputs` container: its read-only repair, refusals per command, and warnings.
 *
 * Part of `src/state/malformed-resources-bag.ts`, which re-exports every public name here.
 */
import { CdkdError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import type { LockRecoveryContext } from '../lock-contention-message.js';
import type { StackState } from '../../types/state.js';
import { STATE_RESOURCES_MALFORMED, hasReadableOutputs, absentIfEmpty } from './core.js';
import { stackClause, inspectCommand, inspectClause } from './inspect-command.js';
import { inspectTail } from './orphan-refusal.js';

/**
 * The `outputs` half of {@link repairMalformedResourcesForReadOnly}, for a
 * READ-ONLY command that DIFFS the stored bag rather than rendering it
 * (go-to-k/cdkd#3189).
 *
 * `computeOutputsDiff` enumerates the stored bag twice, the second walk
 * emitting one `REMOVE` row per stored key today's template no longer declares.
 * It used to admit the bag on a bare `?? {}`, which covers `null` and
 * `undefined` only — so a hand-edited or truncated record whose `outputs` holds
 * a string or a list previewed the REMOVAL of outputs that never existed, one
 * row per character or element, each carrying a character of the record as its
 * `old:` side, with `cdkd diff --fail` exiting 1 on them.
 *
 * AT THE LOAD, for the reason
 * {@link repairMalformedResourcesForReadOnly}'s own note records and one more
 * that is specific to this container: `cdkd diff` dereferences the stored bag
 * BEFORE the walk that fabricates. `resolveTemplateOutputs` asks
 * `hasOwnProperty.call(storedOutputs, key)` for go-to-k/cdkd#2740's
 * skipped-output record and for go-to-k/cdkd#1942's literal `Export.Name`
 * verdict — which ANSWERS TRUE on a string for `'0'` or `'length'`, and THROWS
 * outright on `null` (`Cannot convert undefined or null to object`). So a guard
 * written at `computeOutputsDiff` alone leaves a wrong decision, or a raw
 * `TypeError`, one call above it.
 *
 * ABSENT IS EXEMPT AND `null` IS NOT, which is the one place this diverges from
 * {@link isReadableBag}'s verdict, and the split is measured rather than
 * stylistic. Both stored-bag lookups named above gate on
 * `storedOutputs !== undefined` before the `hasOwnProperty` call, so an ABSENT
 * bag never reaches one; every other consumer on the diff path carries its own
 * `?? {}` (`mergeNoChangeOutputs`'s `persisted`, `importableOutputKeys`, this
 * function's own walk). An absent bag is therefore inert, exactly the condition
 * under which `state.ts`'s `repairRenderedContainers` exempts it — and warning
 * would be a false positive on a record cdkd itself supports: `cdkd scrub`
 * round-trips a record with no `outputs` deliberately, refusing to materialize
 * `{}` over it, and the deploy's failure-path saves write
 * `outputs: currentState.outputs`, which `JSON.stringify` drops when it is
 * undefined. A `null` bag is NOT inert — it passes the `!== undefined` gate and
 * `hasOwnProperty.call(null, ...)` throws — so it is repaired and warned about
 * like any other unreadable shape.
 *
 * That leaves one clause of go-to-k/cdkd#3189's stated floor overridden on
 * purpose: it asked that a `null` bag "diff exactly as it does today and say
 * nothing", and diffing exactly as it does today means THROWING. Recorded on
 * the issue rather than silently traded.
 *
 * Mutates in place and returns whether it repaired anything; the caller warns
 * on `true` with {@link malformedOutputsWarning}. Read-only commands ONLY, for
 * the reason {@link refuseMalformedState} gives — a bag laundered into a
 * well-formed empty one is permanent, and for `outputs` it would also take the
 * exports index with it on the next write.
 */
export function repairMalformedOutputsForReadOnly(state: StackState): boolean {
  if (hasReadableOutputs(state)) return false;
  state.outputs = {};
  return true;
}

/** {@link malformedOutputsWarning}'s deploy sentence; its note says why this wording. */
const DEPLOY_REFUSES_OUTPUTS_SENTENCE =
  `'cdkd deploy' REFUSES this record when it loads it, over this same unreadable 'outputs' ` +
  `map, rather than rebuilding the map over it — repair the stored value before deploying.`;

/**
 * The warning a caller of {@link repairMalformedOutputsForReadOnly} emits.
 *
 * Deliberately neither {@link malformedResourcesWarning}'s text nor
 * {@link malformedRenderedContainersWarning}'s, because the CONSEQUENCE of
 * continuing empty differs from both. The resources text forbids
 * `cdkd deploy` / `cdkd destroy` because an unreadable resource MAP is
 * indistinguishable from an empty stack; the resource set is intact here. The
 * rendered-containers text says the view "shows no rows there" — true of a
 * renderer, false of a diff, which does not go quiet on an empty stored bag but
 * reports every resolved output as an `ADD`. Saying so is the point: an
 * operator who reads `ADD` rows for outputs the stack already has needs to know
 * the comparison lost its left-hand side.
 *
 * It also says the DEPLOY refuses this record, as the `properties` warning does
 * for its container (go-to-k/cdkd#3513) — {@link refuseMalformedOutputs} runs
 * at the deploy engine's state load on the same predicate this repair takes.
 * That is not an exit-code nicety: `cdkd diff` confines exit 3 to the
 * top-level stack (go-to-k/cdkd#3335), so on a nested child this sentence is
 * the only statement of it. Its own sentence, never the `properties` text's
 * "Do NOT run 'cdkd deploy'": that prohibition belongs to a record whose
 * resources cannot be read, and this one's are intact. "When it loads it", not
 * "the deploy will fail": a deploy skips an unchanged nested-stack row and never
 * loads that child's state.
 *
 * Identifiers are sanitized in the PROSE and GATED in the command — named
 * shell-quoted only when the shared gate admits them, a quoted hole otherwise
 * ({@link inspectCommand}) — and the command is emitted LAST and UNWRAPPED,
 * for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedOutputsWarning(
  rawStackName: string,
  rawRegion: string,
  recovery?: LockRecoveryContext
): string {
  // {@link absentIfEmpty} at the boundary, then the shared clause and command.
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${stackClause(stackName, region)} has no readable 'outputs' map — the ` +
    `record is malformed or truncated. Where the stored value is a string or a list, ` +
    `'Object.entries' walks it as readily as a map, so diffing it INVENTS a REMOVE row per ` +
    `character or element carrying the record's own characters; where it is a number, a boolean ` +
    `or null, it yields no comparison at all. Continuing with it EMPTY: every output this diff ` +
    `resolves is reported as an ADD and no stored key is reported as a REMOVE, which is not the ` +
    `same as the record holding none. ${DEPLOY_REFUSES_OUTPUTS_SENTENCE} ` +
    `${inspectClause(stackName, region, recovery)}See the stored value with: ` +
    inspectCommand(stackName, region, recovery)
  );
}

/**
 * The `outputs` half of {@link malformedStateRefusalMessage}, for the same
 * reason that one is exported separately from the throw: `cdkd scrub`'s exit
 * `1` is spoken for and it raises its own exit-2 class around this text.
 *
 * A DIFFERENT text from the `resources` refusal because the consequence of
 * continuing differs, the same way the three warnings in this module differ. The
 * `resources` message forbids `cdkd deploy` / `cdkd destroy` because an
 * unreadable resource MAP is indistinguishable from an empty stack; the resource
 * set is intact here. What is at stake instead is the SHARED exports index:
 * `cdkd/_index/<region>/exports.json` is rebuilt from these bags, and a string
 * bag published one fabricated export per character into the namespace every
 * other stack's `Fn::ImportValue` binds against.
 *
 * Identifiers are sanitized in the PROSE and GATED in the command — named
 * shell-quoted only when the shared gate admits them, a quoted hole otherwise
 * ({@link inspectCommand}) — and the command is emitted LAST and UNWRAPPED,
 * for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedOutputsRefusalMessage(
  rawStackName: string,
  rawRegion: string | undefined,
  /**
   * The caller's account flags: the inspect command carries them, and the
   * region-less legacy arm names the bucket from them — see {@link inspectTail}.
   */
  recovery?: LockRecoveryContext
): string {
  // {@link absentIfEmpty} at the boundary, then the shared clause and command.
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return inspectTail(
    `${stackClause(stackName, region)} has no readable 'outputs' map — the ` +
      `record is malformed or truncated. This command can WRITE state, so it refuses rather than ` +
      `continuing: it REBUILDS the bag before saving, and 'Object.entries' walks a string or a ` +
      `list as readily as a map, so a six-character value would be saved back as a well-formed ` +
      `six-key map (a null one as an empty map). That replaces the only signal anything is wrong ` +
      `with a legitimate-looking record, permanently — and the next deploy republishes it into ` +
      `the shared exports index every other stack's Fn::ImportValue resolves against. Repair or ` +
      `remove the record first.`,
    stackName,
    region,
    recovery
  );
}

/**
 * The line `ExportIndexStore`'s rebuild emits for a producer record whose
 * export set it could not read (issue go-to-k/cdkd#3192) — `outputs` not a
 * plain object, or `exportNames` present and not an array.
 *
 * A THIRD outputs text rather than {@link malformedOutputsWarning} because the
 * consequence is again different, which is the rule the two above already
 * follow. That one describes a DIFF continuing with an empty left-hand side.
 * This describes a record CONTRIBUTING NOTHING to a shared, region-wide index
 * other stacks resolve against — so the symptom a reader will actually meet is
 * a later `Fn::ImportValue` failing in a DIFFERENT stack, naming the consumer
 * and not this record. Saying which producer dropped out is the whole value of
 * the line.
 *
 * It says the rebuild CONTINUES, because it does: refusing would take every
 * other producer in the region down with it, and the index is best-effort by
 * design.
 *
 * Identifiers are sanitized in the PROSE and GATED in the command — named
 * shell-quoted only when the shared gate admits them, a quoted hole otherwise
 * ({@link inspectCommand}) — and the command is emitted LAST and UNWRAPPED,
 * for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedExportSourceWarning(
  rawStackName: string,
  rawRegion: string,
  recovery?: LockRecoveryContext
): string {
  // {@link absentIfEmpty} at the boundary, then the shared clause and command.
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${stackClause(stackName, region)} has no readable 'outputs' map or ` +
    `'exportNames' list — the record is malformed or truncated. It contributes NO exports to ` +
    `this region's index, which is not the same as the stack exporting none: an ` +
    `Fn::ImportValue of a name this stack really publishes will fail in the CONSUMER stack, ` +
    `naming that stack rather than this record. Continuing with the other producers — ` +
    `enumerating a string or a list here would instead publish one FABRICATED export per ` +
    `character or element. ${inspectClause(stackName, region, recovery)}See the stored values with: ` +
    inspectCommand(stackName, region, recovery)
  );
}

/**
 * The line a READ-ONLY command emits when a record's `exportNames` FIELD could
 * not be used (go-to-k/cdkd#3192 review) — present and not an array, or an
 * array with no usable name in it.
 *
 * Why a message at all, when the predicate already fails closed: before this
 * class was guarded, `cdkd diff` over such a record died with
 * `TypeError: state.exportNames.filter is not a function`. Failing closed
 * inside `importableOutputKeys` is right — it is a pure predicate reached from
 * five commands and holds no stack identity — but silently replacing a LOUD
 * wrong answer with a QUIET one is its own regression, and `cdkd diff` is
 * exactly the caller that DOES hold the identity. Without this it warned about
 * a damaged `outputs` bag on one line and said nothing about the damaged
 * `exportNames` on the same record.
 *
 * Deliberately NOT {@link malformedOutputsWarning}'s text: that one is about
 * the BAG, and the consequence differs. An unusable export SET does not lose
 * the comparison's left-hand side — every stored key is still diffed — it
 * makes the preview report no key as an export, so a row that would carry
 * `[export]` renders without it.
 *
 * Identifiers are sanitized in the PROSE and GATED in the command — named
 * shell-quoted only when the shared gate admits them, a quoted hole otherwise
 * ({@link inspectCommand}) — and the command is emitted LAST and UNWRAPPED,
 * for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedExportNamesWarning(
  rawStackName: string,
  rawRegion: string,
  recovery?: LockRecoveryContext
): string {
  // {@link absentIfEmpty} at the boundary, then the shared clause and command.
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${stackClause(stackName, region)} has an unusable 'exportNames' list — ` +
    `the record is malformed or truncated. It is read as an EMPTY export set, which is not the ` +
    `same as the record holding one: no stored key is reported as an export, so a row that ` +
    `should carry an '[export]' tag renders without it. Reading it as UNKNOWN instead would be ` +
    `worse — that falls back to the pre-v9 rule where every output name is importable. ${inspectClause(stackName, region, recovery)}See the ` +
    `stored value with: ` +
    inspectCommand(stackName, region, recovery)
  );
}

/**
 * For a command that can WRITE state: refuse a record whose `outputs` bag
 * cannot be read, instead of rebuilding it (issue go-to-k/cdkd#3192).
 *
 * The SIBLING of {@link refuseMalformedState}, and deliberately a second call
 * rather than a widening of that one. A record can be malformed in either
 * container alone, the two carry different consequences, and the refusal a user
 * sees must name the container that is actually broken — a `resources` message
 * printed over an intact resource map tells them not to run `cdkd deploy` for a
 * reason that does not hold.
 *
 * Why REFUSE and not {@link repairMalformedOutputsForReadOnly}, which is the
 * opposite answer for the same container one function up: repairing the bag and
 * then saving it IS the laundering this is here to stop. Measured, not
 * reasoned — `rewriteResourceReferences` turns `outputs: 'abcdef'` into
 * `{"0":"a",…,"5":"f"}` and `cdkd orphan` saves that; `cdkd scrub`'s
 * `redactUnaccountedOutputs` spreads the same string into a map and its
 * `outputsChanged` compare then satisfies the `recordsChanged > 0` write gate;
 * `cdkd import` carries a `null` bag through `?? {}`. Each one rewrites a
 * damaged record into a well-formed one and the evidence is gone.
 *
 * CALL IT AT THE LOAD, beside {@link refuseMalformedState} and above the first
 * expression that reads the bag — the placement rule
 * {@link repairMalformedResourcesForReadOnly}'s note records, for the reason it
 * records: a guard written at the rebuild leaves every earlier dereference in
 * front of it.
 */
export function refuseMalformedOutputs(
  state: Pick<StackState, 'outputs'>,
  stackName: string,
  /** See {@link refuseMalformedState}'s `region`. */
  region: string | undefined,
  /** See {@link malformedOutputsRefusalMessage}. */
  recovery?: LockRecoveryContext
): void {
  if (hasReadableOutputs(state)) return;
  // `markNonRetryable` for the reason its three siblings carry it, which holds
  // here identically and was simply missed: `cdkd deploy` is one of this
  // function's callers, a nested child's deploy runs inside the parent's
  // `withRetry(provider.create)`, the verdict comes from a PERSISTED record no
  // retry can change, and the message interpolates a caller-supplied stack name
  // a SUBSTRING-matching classifier can read as transient. Without it a child
  // whose `outputs` bag was damaged burned the full retry schedule while one
  // whose `resources` bag was damaged did not (review of go-to-k/cdkd#3161).
  // Issue #1838.
  throw markNonRetryable(
    new CdkdError(
      malformedOutputsRefusalMessage(stackName, region, recovery),
      STATE_RESOURCES_MALFORMED
    )
  );
}

/**
 * The DESTROY refusal text (issue
 * [#3207](https://github.com/go-to-k/cdkd/issues/3207)).
 *
 * A FOURTH outputs text rather than {@link malformedOutputsRefusalMessage},
 * for the reason every text in this module is its own: that one says the
 * command "REBUILDS the bag before saving", which is FALSE here. A destroy
 * never rebuilds the bag — its incremental preserve-writes CLEAR `outputs`
 * outright. What it does with the bag instead is DECIDE, and the decision is
 * the strong-reference pre-flight: `state.outputs && Object.keys(...).length >
 * 0` asks "might this stack be a producer?", and only a positive answer runs
 * the cross-stack scan that refuses to delete an exporter while an importer
 * exists.
 *
 * Both directions of that question are wrong on a damaged bag, which is why
 * repairing is not available here. A STRING or a LIST answers YES for the
 * wrong reason — `Object.keys('abcdef')` is six fabricated names — and a
 * `null`, a number or a boolean answers NO, so the scan is SKIPPED and the
 * destroy deletes a producer other stacks still `Fn::ImportValue` from.
 * Reading the bag as empty (the read-only repair) IS that second answer, so
 * the only answer that fabricates nothing and skips no protection is to stop.
 *
 * Identifiers are sanitized in the PROSE and GATED in the command — named
 * shell-quoted only when the shared gate admits them, a quoted hole otherwise
 * ({@link inspectCommand}) — and the command is emitted LAST and UNWRAPPED,
 * for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedDestroyOutputsRefusalMessage(
  rawStackName: string,
  rawRegion: string,
  /** The caller's account flags, carried by the inspect command (go-to-k/cdkd#3909). */
  recovery?: LockRecoveryContext
): string {
  // {@link absentIfEmpty} at the boundary, then the shared clause and command.
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${stackClause(stackName, region)} has no readable 'outputs' map — the ` +
    `record is malformed or truncated. This command DELETES state, so it refuses rather than ` +
    `continuing: it reads this bag to decide whether the stack might export anything, and that ` +
    `decision gates the cross-stack check that refuses to delete a producer another stack still ` +
    `imports from. A string or a list invents one export name per character or element; a null, ` +
    `a number or a boolean reads as 'exports nothing' and SKIPS the check entirely, deleting the ` +
    `record while consumers still resolve against it. Repair or remove the record first. ` +
    `${inspectClause(stackName, region, recovery)}Inspect it with: ` +
    inspectCommand(stackName, region, recovery)
  );
}

/**
 * For `cdkd destroy` / `cdkd state destroy`: refuse a record whose `outputs`
 * bag cannot be read (issue
 * [#3207](https://github.com/go-to-k/cdkd/issues/3207)).
 *
 * A SEPARATE call from {@link refuseMalformedOutputs} rather than a flag on
 * it, for the same reason {@link refuseMalformedOutputs} is separate from
 * {@link refuseMalformedState}: the refusal a user sees must describe what
 * THIS command would have done with the bag, and the two consequences are
 * different — see {@link malformedDestroyOutputsRefusalMessage}.
 *
 * CALL IT AT THE TOP OF THE DESTROY, above the strong-reference decision it
 * protects. The placement rule is
 * {@link repairMalformedResourcesForReadOnly}'s and applies unchanged.
 */
export function refuseMalformedOutputsForDestroy(
  state: Pick<StackState, 'outputs'>,
  stackName: string,
  region: string,
  /** See {@link malformedDestroyOutputsRefusalMessage}. */
  recovery?: LockRecoveryContext
): void {
  if (hasReadableOutputs(state)) return;
  // `markNonRetryable` because this decides from a PERSISTED record: a retry
  // cannot change the bag, and the message interpolates a template-derived
  // child name that a SUBSTRING-matching classifier reads as transient
  // (`does not exist` and `DependencyViolation` are live patterns). Issue #1838.
  throw markNonRetryable(
    new CdkdError(
      malformedDestroyOutputsRefusalMessage(stackName, region, recovery),
      STATE_RESOURCES_MALFORMED
    )
  );
}

/**
 * The NESTED-STACK refusal text (issue
 * [#3207](https://github.com/go-to-k/cdkd/issues/3207)).
 *
 * A FIFTH text, and the one whose damaged record and saved record are
 * DIFFERENT stacks. `NestedStackProvider.readChildOutputsAsAttributes` reads
 * the CHILD's persisted bag and rebuilds it into the PARENT's
 * `Outputs.<Key>` attributes; the parent's deploy then persists those
 * attributes into the parent's own record, where every `Fn::GetAtt` against
 * the nested stack resolves them — into live AWS calls. So a six-character
 * child bag becomes six fabricated parent attributes, and
 * {@link malformedOutputsRefusalMessage}'s "saved back as a well-formed
 * six-key map ... republished into the shared exports index" would name the
 * wrong record and the wrong blast radius.
 *
 * Identifiers are sanitized in the PROSE and GATED in the command — named
 * shell-quoted only when the shared gate admits them, a quoted hole otherwise
 * ({@link inspectCommand}) — and the command is emitted LAST and UNWRAPPED,
 * for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedNestedChildOutputsRefusalMessage(
  rawChildStackName: string,
  rawRegion: string,
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): string {
  // {@link absentIfEmpty} at the boundary, then the shared clause and command.
  const childStackName = absentIfEmpty(rawChildStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${stackClause(childStackName, region, 'nested stack child')} has no readable ` +
    `'outputs' map — the record is malformed or truncated. The parent's 'Outputs.<Key>' ` +
    `attributes are REBUILT from this bag and persisted into the PARENT's record, and ` +
    `'Object.entries' walks a string or a list as readily as a map — so a six-character value ` +
    `would become six fabricated parent attributes that every Fn::GetAtt against this nested ` +
    `stack then resolves into live AWS calls. The deploy refuses rather than fabricating them. ` +
    `Repair or remove the child's record first. ${inspectClause(childStackName, region, recovery)}Inspect it with: ` +
    inspectCommand(childStackName, region, recovery)
  );
}

/**
 * For the nested-stack provider: refuse a CHILD record whose `outputs` bag
 * cannot be read (issue [#3207](https://github.com/go-to-k/cdkd/issues/3207)).
 *
 * The provider itself calls no `saveState`, and that is why this is a refusal
 * rather than a repair anyway: what it returns becomes the parent's
 * `ResourceState.attributes`, which the parent's deploy engine persists. Being
 * write-capable THROUGH A CALLER is the same hazard as writing directly, and
 * repairing here would put a well-formed fabricated attribute set into the
 * parent's record with nothing left to say the child was damaged.
 */
export function refuseMalformedNestedChildOutputs(
  state: Pick<StackState, 'outputs'>,
  childStackName: string,
  region: string,
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): void {
  if (hasReadableOutputs(state)) return;
  // `markNonRetryable` because this decides from a PERSISTED record: a retry
  // cannot change the bag, and the message interpolates a template-derived
  // child name that a SUBSTRING-matching classifier reads as transient
  // (`does not exist` and `DependencyViolation` are live patterns). Issue #1838.
  throw markNonRetryable(
    new CdkdError(
      malformedNestedChildOutputsRefusalMessage(childStackName, region, recovery),
      STATE_RESOURCES_MALFORMED
    )
  );
}

/**
 * The warning the `cdkd local *` commands emit for a record whose `outputs`
 * bag they had to read as EMPTY (issue
 * [#3207](https://github.com/go-to-k/cdkd/issues/3207)).
 *
 * A SIXTH text, and the only one on this container for a READ-ONLY caller
 * other than {@link malformedOutputsWarning}. It is not that one because the
 * consequence differs the same way every text in this module differs: that one
 * describes a DIFF continuing with an empty left-hand side and reporting every
 * resolved output as an `ADD`. A local run reports no rows at all — it
 * SUBSTITUTES, so the visible effect is an environment variable or a
 * `Fn::GetStackOutput` / `Fn::ImportValue` reference that resolves to nothing
 * and is dropped with a per-key warning, which is what "the record holds no
 * outputs" also looks like.
 *
 * TWO call sites share it, deliberately: `S3LocalStateProvider.load` reading
 * the TARGET stack's record, and `buildCrossStackResolver`'s
 * `Fn::GetStackOutput` arm reading a PRODUCER's. The record named is whichever
 * one is damaged, and the consequence is identical — which is why one text is
 * right here and a second spelling would only drift.
 *
 * Read-only is a property of these callers rather than of the command:
 * `cdkd local` writes no `state.json`. It CAN write one DERIVED key —
 * `ExportIndexStore.load` rebuilds and PUTs `cdkd/_index/<region>/exports.json`
 * on a miss — and that write is already fail-closed and warned about by
 * `hasReadableExportSet` / {@link malformedExportSourceWarning}, so nothing
 * here can launder a record.
 *
 * Identifiers are sanitized in the PROSE and GATED in the command — named
 * shell-quoted only when the shared gate admits them, a quoted hole otherwise
 * ({@link inspectCommand}) — and the command is emitted LAST and UNWRAPPED,
 * for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedLocalOutputsWarning(
  rawStackName: string,
  rawRegion: string,
  recovery?: LockRecoveryContext
): string {
  // {@link absentIfEmpty} at the boundary, then the shared clause and command.
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${stackClause(stackName, region)} has no readable 'outputs' map — the ` +
    `record is malformed or truncated. 'Object.entries' walks a string or a list as readily as ` +
    `a map, so reading it would hand this local run one FABRICATED output per character or ` +
    `element. Continuing with it EMPTY: every reference to an output of this record resolves to ` +
    `nothing and is dropped, which is not the same as the record holding none. ${inspectClause(stackName, region, recovery)}See the stored ` +
    `value with: ` +
    inspectCommand(stackName, region, recovery)
  );
}
