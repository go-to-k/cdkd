import { CdkdError } from '../utils/error-handler.js';
import { displaySafe } from '../utils/display-safe.js';
import type { StackState } from '../types/state.js';

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
function hasReadableResources(state: StackState): boolean {
  const bag: unknown = state.resources;
  return typeof bag === 'object' && bag !== null && !Array.isArray(bag);
}

/**
 * The shared explanation, in the terms the reader needs: what is wrong, what
 * to look at, and what NOT to do next.
 *
 * Both arguments go through `displaySafe` because neither is trusted on every
 * path that reaches here — a stack name can arrive from an `Fn::GetStackOutput`
 * argument or an S3 key — and the text embeds them in a command line the
 * message tells the user to RUN. `ConsoleLogger` sanitizes a logger's extra
 * ARGS, never the message string, so the sanitizing has to happen here.
 */
function malformedStateDetail(stackName: string, region: string): string {
  const stack = displaySafe(stackName, { asciiOnly: true });
  const reg = displaySafe(region, { asciiOnly: true });
  return (
    `State for '${stack}' (${reg}) has no readable 'resources' map — the record is malformed ` +
    `or truncated. Inspect it with 'cdkd state show ${stack} --stack-region ${reg} --json'. ` +
    `Do NOT run 'cdkd deploy' or 'cdkd destroy' against it: both read the same map, and an ` +
    `unreadable one is indistinguishable from an empty stack, so deploy would re-CREATE every ` +
    `resource and destroy would delete none of them.`
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

/** The warning a caller of {@link repairMalformedResourcesForReadOnly} emits. */
export function malformedResourcesWarning(stackName: string, region: string): string {
  return `${malformedStateDetail(stackName, region)} Continuing with an EMPTY resource set: this command's output describes zero resources, which is not the same as the stack having none.`;
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
  throw new CdkdError(
    `${malformedStateDetail(stackName, region)} This command can WRITE state, so it refuses ` +
      `rather than continuing: saving over a record whose resource map could not be read would ` +
      `replace the evidence with a well-formed empty one and lose it permanently. Repair or ` +
      `remove the record first.`,
    'STATE_RESOURCES_MALFORMED'
  );
}
