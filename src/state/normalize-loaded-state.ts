import type { StackState } from '../types/state.js';

/**
 * Give a freshly-loaded `StackState` an object-valued `resources` bag, so the
 * READ-ONLY and RECOVERY commands can report on a malformed `state.json`
 * instead of aborting on it (issue go-to-k/cdkd#3018).
 *
 * `parseStateBody` deliberately does not validate the inner shape, so a
 * hand-edited or truncated record can reach a command with `resources` absent
 * or `null`. Every such command then dies on a raw
 * `TypeError: Cannot convert undefined or null to object` from the first
 * `Object.keys` / `in` / index read — naming no stack, no key and no remedy,
 * from exactly the commands (`diff`, `scrub`, `orphan`, `import`) a user
 * reaches for WHEN the state is broken.
 *
 * WHY THIS IS AT THE LOAD SITE AND NOT AT EACH LOOP. The first cut of #3018
 * put `?? {}` on the twelve `Object.entries(state.resources)` loops, which is
 * inert: every one of those flows dereferences the bag EARLIER — `!(id in
 * state.resources)`, `hasOwnProperty.call(state.resources, id)`,
 * `state.resources[logicalId]` — so the abort still happened, one line up, and
 * the guards only made it look handled. One normalization per load covers the
 * whole flow behind it, including helpers that take the state as a parameter
 * (`orphan-rewriter`, `diff-calculator`, `collectCcApiRoutes`).
 *
 * WHY THIS IS NOT IN `S3StateBackend.getState`. `deploy` and `destroy` read
 * through the same backend, and for them a malformed bag must stay fatal: an
 * empty `resources` reads as "nothing is deployed", so a silently-normalized
 * load would make the next `deploy` CREATE every resource the record had lost
 * track of and the next `destroy` delete nothing. Aborting is the right answer
 * there; it is only the non-mutating and recovery commands that are better
 * served by proceeding. So the normalization is opt-in, per command.
 *
 * Mutates the object in place — callers hold the reference the backend gave
 * them, and an etag-paired `saveState` must write back the record that was
 * read.
 *
 * Returns whether it repaired anything, and EVERY caller warns on `true`. A
 * silent repair is its own defect: proceeding is what the user wants, but
 * `No plaintext secrets found` / `No changes detected` over a record whose
 * resource map was unreadable is a clean verdict about nothing. The warning is
 * the difference between "cdkd looked and found nothing" and "cdkd had nothing
 * to look at".
 */
export function normalizeLoadedState(state: StackState): boolean {
  if (state.resources === null || state.resources === undefined) {
    state.resources = {};
    return true;
  }
  return false;
}

/** The warning text every caller of {@link normalizeLoadedState} emits. */
export function malformedResourcesWarning(stackName: string, region: string): string {
  return (
    `State for '${stackName}' (${region}) has no readable 'resources' map — the record is ` +
    `malformed or truncated. Continuing with an EMPTY resource set: this command's output ` +
    `describes zero resources, which is not the same as the stack having none. Inspect the ` +
    `record with 'cdkd state show ${stackName} --stack-region ${region} --json' before acting ` +
    `on it, and do NOT run 'cdkd deploy' or 'cdkd destroy' against it — both would treat the ` +
    `stack as empty.`
  );
}
