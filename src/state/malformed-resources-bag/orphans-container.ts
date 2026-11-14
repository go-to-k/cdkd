/**
 * The `orphans` container: its predicate, read-only repair, refusals, and warning.
 *
 * Part of `src/state/malformed-resources-bag.ts`, which re-exports every public name here.
 */
import { CdkdError } from '../../utils/error-handler.js';
import { cdkdRemedy, proseQuoted } from '../../utils/pasteable-command.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import type { LockRecoveryContext } from '../lock-contention-message.js';
import type { StackState } from '../../types/state.js';
import { STATE_RESOURCES_MALFORMED, absentIfEmpty } from './core.js';
import {
  dropRecordLine,
  withheldListingPointer,
  confirmKeyListing,
  destroyAccountClause,
} from './account-args.js';
import {
  mayNameTargetWithDestructiveRemedy,
  stackClause,
  inspectCommand,
  inspectClause,
} from './inspect-command.js';

/**
 * The name `cdkd diff`'s preview prints for an `orphans` container it could not
 * read, beside {@link UNREADABLE_RESOURCES_MAP_ROW}'s for the resource map — a
 * display name rendered from the node's container field, for the reason that
 * constant gives.
 */
export const UNREADABLE_ORPHANS_CONTAINER_ROW = '(orphans container)';

/**
 * Whether the `orphans` CONTAINER is the list every reader of it assumes
 * (issue go-to-k/cdkd#3379).
 *
 * `parseStateBody` validates the record root and its schema version and returns
 * the cast record otherwise unchanged, so a hand-edited or planted
 * `"orphans": "abc"`, `5`, `{}` or `{"length": 1}` survives the load and every
 * reader reaches it on a bare `?? []`, `?.length` or `?.map`.
 *
 * ABSENT IS READABLE, for the reason {@link hasReadableOutputs}'s note gives
 * for its own container and one that is sharper here: an absent `orphans` is
 * the ORDINARY record. A stack that never had a failed deploy has no orphan
 * list at all, `JSON.stringify` drops the key when it is undefined, and
 * `orphansAfterRollback` returns `{}` on `previous.orphans === undefined`
 * WITH nothing newly orphaned — the pair of conditions that keeps such a
 * record byte-identical. Warning or refusing on absence would fire on
 * almost every record in a bucket.
 *
 * `null` is NOT readable, which is where this parts from a bare `?? []`: that
 * admits `null` silently, and the shapes this exists to catch are exactly the
 * ones it cannot see.
 *
 * The ENTRIES are a separate question with a separate answer —
 * {@link unreadableOrphanRecords}, which `cdkd orphan` refuses on through
 * {@link refuseMalformedOrphansForOrphan} (go-to-k/cdkd#3344). This one says
 * only that the container is a list.
 */
export function hasReadableOrphans(state: Pick<StackState, 'orphans'>): boolean {
  return state.orphans === undefined || Array.isArray(state.orphans);
}

/**
 * For a READ-ONLY command: replace an unreadable `orphans` container with an
 * empty list so the command can report the rest of the record, and return
 * whether it did, so the caller can warn with
 * {@link malformedOrphansWarning} and report the container among what it could
 * not read.
 *
 * AT THE LOAD, the placement rule
 * {@link repairMalformedResourcesForReadOnly}'s note records: `cdkd diff`
 * reaches the container through `currentState.orphans?.length` before its
 * adoption preview, so a guard written at the preview leaves the dereference
 * above it — and for a STRING that dereference is the one that lies, since
 * `'abc'.length` is 3 and the preview then walks characters.
 *
 * READ-ONLY commands only, for the reason {@link refuseMalformedState} gives:
 * a container laundered into a well-formed empty one is permanent, and for
 * this container it also erases the only record that resources were left
 * behind in AWS by an earlier failed deploy.
 */
export function repairMalformedOrphansForReadOnly(state: StackState): boolean {
  if (hasReadableOrphans(state)) return false;
  state.orphans = [];
  return true;
}

/**
 * The warning a caller of {@link repairMalformedOrphansForReadOnly} emits.
 *
 * Its own text rather than any of the three above, the rule this module's
 * every message follows: what continuing EMPTY costs here is not a diff's
 * left-hand side or a rendered view's rows but the record's evidence that
 * resources from an earlier failed deploy are still live in AWS. A reader who
 * sees no adoption preview and no orphan warning will conclude the stack has
 * none.
 *
 * Identifiers are sanitized in the PROSE and GATED in the command — named
 * shell-quoted only when the shared gate admits them, a quoted hole otherwise
 * ({@link inspectCommand}) — and the command is emitted LAST and UNWRAPPED,
 * for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedOrphansWarning(
  rawStackName: string,
  rawRegion: string,
  recovery?: LockRecoveryContext
): string {
  // {@link absentIfEmpty} at the boundary, then the shared clause and command.
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${stackClause(stackName, region)} has no readable 'orphans' list — the ` +
    `record is malformed or truncated. Readers reach it on a bare '?? []' or '?.length', which ` +
    `admits a string, a number, a plain object and null alike: a string is WALKED, one garbage ` +
    `orphan per character, and the others read as no orphans at all. Continuing with it EMPTY: ` +
    `this view previews no adoption and names no orphan, which is NOT the same as the record ` +
    `holding none — resources from an earlier failed deploy may still be live in AWS. ${inspectClause(stackName, region, recovery)}See the ` +
    `stored value with: ` +
    inspectCommand(stackName, region, recovery)
  );
}

/**
 * The refusal text for a command that can WRITE the record.
 *
 * A DIFFERENT text from the warning because the danger is different and worse:
 * the reshaping reader is also a writer. `orphansAfterRollback` walks the
 * container with `for...of`, so over `"abc"` it returns a list holding `"c"`,
 * and `cdkd rollback` SAVES that record — a damaged container rewritten into a
 * differently damaged one, silently. `cdkd deploy`'s adoption pass assigns
 * `currentState.orphans` from what it read, and `cdkd destroy` proceeds through
 * resource deletion to `deleteState` having never reported the orphans it could
 * not read.
 *
 * Identifiers are sanitized in the PROSE and GATED in the command — named
 * shell-quoted only when the shared gate admits them, a quoted hole otherwise
 * ({@link inspectCommand}) — and the command is emitted LAST and UNWRAPPED,
 * for the reasons {@link safeIdentifier}'s note gives.
 */
export function malformedOrphansRefusalMessage(
  rawStackName: string,
  rawRegion: string,
  /** The caller's account flags, carried by the inspect command (go-to-k/cdkd#3909). */
  recovery?: LockRecoveryContext
): string {
  // {@link absentIfEmpty} at the boundary, then the shared clause and command.
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${stackClause(stackName, region)} has no readable 'orphans' list — the ` +
    `record is malformed or truncated. This command can WRITE state, so it refuses rather than ` +
    `continuing: a string container is WALKED one character at a time and written back as a ` +
    `list of character-shaped orphan records, and every other unreadable shape reads as no ` +
    `orphans at all — so a run would delete or adopt against a record whose evidence of ` +
    `resources left live in AWS by an earlier failed deploy it never read. Repair or remove the ` +
    `record first, and no cdkd command repairs this container: rewriting it to [] by hand ` +
    `discards the very evidence this refusal is protecting. ${inspectClause(stackName, region, recovery)}Inspect the record with: ` +
    inspectCommand(stackName, region, recovery)
  );
}

/**
 * The DESTROY refusal text for this container (go-to-k/cdkd#3379 review).
 *
 * Its own text rather than {@link malformedOrphansRefusalMessage}, for the
 * reason every text in this module is its own: that one says the container
 * would be RESHAPED and written back, which is the rollback mechanism, and a
 * destroy never reshapes it — `buildDestroySnapshot` carries the container
 * verbatim through `...rest` into every save it makes, and then either REMOVES
 * the record (the clean path) or writes that snapshot as the final state, with
 * the container intact, on the error / interrupt / skip arm. What a destroy
 * does with the container instead is DECIDE: the count feeds `stillEmpty`, and
 * the orphan warning above it is the operator's only notice that resources from
 * an earlier failed deploy are still live in AWS.
 *
 * It also owes the remedy the sibling destroy refusal owes, and for the same
 * reason go-to-k/cdkd#3161 raised against refusing a cleanup command at all: an
 * operator who wants the record gone needs a way to do it. `cdkd state orphan`
 * is that way and reads no `orphans` container, so pointing at it is sound —
 * the same exactness split as {@link malformedDestroyResourcesRefusalMessage},
 * since a name that does not render faithfully must not become a command
 * against a record that may not be the damaged one.
 */
export function malformedDestroyOrphansRefusalMessage(
  stackName: string,
  region: string,
  /** See {@link malformedDestroyResourcesRefusalMessage} (go-to-k/cdkd#3909). */
  recovery?: LockRecoveryContext
): string {
  const exact = mayNameTargetWithDestructiveRemedy(stackName, region);
  const listing = withheldListingPointer(recovery);
  // Both arms continue `stackClause`'s own sentence rather than starting a new
  // one after it: the no-identity clause ends open ("The state record this
  // command loaded"), so a second sentence bolted on renders without a verb —
  // and that is the arm a planted identity reaches.
  const detail =
    `${stackClause(exact ? stackName : undefined, exact ? region : undefined)} has no readable ` +
    `'orphans' list — the record is malformed or truncated.`;
  const remedy = exact
    ? `To drop the record deliberately and ` +
      `leave every live resource standing, run ${proseQuoted(cdkdRemedy('cdkd state orphan'))} against the stack and the ` +
      `region THE RECORD'S S3 KEY holds. It is spelled as a template on its own line below ` +
      `rather than handed over ready to run, because that command DELETES a record and a key ` +
      `segment is chosen by anyone who can write this bucket: the key says WHICH record this ` +
      `is, which is not the same as vouching for it as a delete target. Confirm the key with ` +
      `${confirmKeyListing(recovery)} — a legacy record shows none, and for one of those the ` +
      `flag must be OMITTED or it selects nothing.`
    : `This record's stack name or region does NOT render exactly, so this message names no ` +
      `target and offers no command against one. List the records with ` +
      `${listing.pointer}.`;
  const prose =
    `${detail} This command DELETES state, so it refuses rather than continuing: an unreadable ` +
    `container counts as no orphans, so the run would proceed through resource deletion to ` +
    `removing state.json while the record's evidence that an earlier failed deploy left ` +
    `resources live in AWS was never read — and that evidence goes with the record. Reading it ` +
    `as EMPTY is that outcome rather than an alternative to it, so there is no repair available ` +
    `here. Repair or remove the record first. ${remedy}` +
    destroyAccountClause(recovery);
  // ONE COMMAND PER LINE, for the reason
  // {@link malformedDestroyResourcesRefusalMessage}'s note gives
  // (go-to-k/cdkd#3516). go-to-k/cdkd#3379 shipped both commands on one line
  // with the pasteable READ last, which put the substituted region AFTER the
  // template an operator has to fill the holes of by hand.
  return [
    prose,
    ...(!exact && listing.line !== undefined ? [listing.line] : []),
    `Inspect the record: ${inspectCommand(exact ? stackName : undefined, exact ? region : undefined, recovery)}`,
    ...(exact ? [dropRecordLine(recovery)] : []),
  ].join('\n');
}

/**
 * The destroy-path twin of {@link refuseMalformedOrphans}, carrying the text
 * above. Both destroy reads take this one: the entry read and the under-lock
 * re-read, which is the record `stillEmpty` and `deleteState` act on.
 */
export function refuseMalformedOrphansForDestroy(
  state: Pick<StackState, 'orphans'>,
  stackName: string,
  region: string,
  /** See {@link malformedDestroyOrphansRefusalMessage}. */
  recovery?: LockRecoveryContext
): void {
  if (hasReadableOrphans(state)) return;
  throw markNonRetryable(
    new CdkdError(
      malformedDestroyOrphansRefusalMessage(stackName, region, recovery),
      STATE_RESOURCES_MALFORMED
    )
  );
}

/**
 * For a command that can WRITE state: refuse a record whose `orphans` container
 * cannot be read.
 *
 * A SIBLING of {@link refuseMalformedState} and {@link refuseMalformedOutputs}
 * rather than a widening of either, for the reason that pair already records: a
 * record can be malformed in one container alone, and the refusal a user sees
 * must name the container that is broken.
 *
 * CALL IT AT THE LOAD, above the first expression that reads the container, and
 * on a destroy at the UNDER-LOCK re-read as well — that re-read is the record
 * the run goes on to act on.
 */
export function refuseMalformedOrphans(
  state: Pick<StackState, 'orphans'>,
  stackName: string,
  region: string,
  /** See {@link malformedOrphansRefusalMessage}. */
  recovery?: LockRecoveryContext
): void {
  if (hasReadableOrphans(state)) return;
  // `markNonRetryable` for the reason {@link refuseMalformedOutputs} carries
  // it: `cdkd deploy` is a caller, a nested child's deploy runs inside the
  // parent's `withRetry(provider.create)`, and the verdict comes from a
  // PERSISTED record no retry can change.
  throw markNonRetryable(
    new CdkdError(
      malformedOrphansRefusalMessage(stackName, region, recovery),
      STATE_RESOURCES_MALFORMED
    )
  );
}
