/**
 * The `orphans` ROW class: the record predicates, the adoption-preview predicate, and their refusals and warnings.
 *
 * Part of `src/state/malformed-resources-bag.ts`, which re-exports every public name here.
 */
import { CdkdError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import { displayIdent } from '../../utils/display-safe.js';
import type { LockRecoveryContext } from '../lock-contention-message.js';
import { isReadableBag } from '../../types/state.js';
import type { StackState } from '../../types/state.js';
import { STATE_RESOURCES_MALFORMED, displayLogicalId, absentIfEmpty } from './core.js';
import { stackClause, inspectCommand, inspectClause } from './inspect-command.js';
import { orphanRefusal } from './orphan-refusal.js';
import { hasReadableOrphans } from './orphans-container.js';
import {
  NAMED_UNREADABLE_ENTRIES,
  isReadableResourceEntry,
  hasReadableAttributes,
} from './entries.js';

/**
 * The `orphans[]` twin of {@link malformedResourceEntriesWarning}, and a
 * SEPARATE text rather than a parameter on that one.
 *
 * The shared clause says "holds N resource record(s) … the remaining resources
 * only", which sends a reader to the wrong container: the id it names was read
 * from `orphans`, and what that clause describes is the `resources` map
 * (go-to-k/cdkd#3226 review round 5, M16). Neither "the id is not in
 * `resources`" nor "that map is healthy" is safe to assert — an already-managed
 * logical id appears in both containers, and both can be damaged in one record,
 * which is the case where BOTH texts fire for one stack in one run, opening with
 * the identical sentence and differing only in the id list. That is why the
 * container has to be IN the sentence rather than inferred from it.
 *
 * What it does NOT say, deliberately: that the record would have been adopted.
 * `planOrphanAdoption` decides that, and a record it would have declined for
 * an unrelated reason (already managed, a type this binary cannot route) is
 * dropped here just the same — promising an adoption that was never going to
 * happen is the {@link malformedResourcePropertiesWarning} over-claim one
 * container over.
 *
 * Identifiers take the same path as every other builder here: the stack at
 * `safeStackName`, the region at `safeRegion`, each id through
 * {@link displayLogicalId}, and the ids capped at
 * {@link NAMED_UNREADABLE_ENTRIES} with an overflow count — a record whose
 * `logicalId` is not a string arrives as `''` and renders as the
 * `UNRENDERABLE` stand-in.
 */
export function malformedOrphanRecordsWarning(
  rawStackName: string,
  rawRegion: string,
  logicalIds: readonly string[],
  /**
   * Does the CALLER also reject a torn `properties` / `attributes` map? Its two
   * callers take different predicates (go-to-k/cdkd#3500): `cdkd scrub
   * --dry-run` takes the writers' full one and passes `true`, while `cdkd diff`
   * takes {@link isPreviewableOrphanRecord} and keeps such a row for the
   * `properties` repair that names it. A diagnosis listing causes its caller does
   * not act on tells the operator to repair a map that was not why the row was
   * dropped.
   */
  alsoRejectsTornMaps: boolean,
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): string {
  // {@link absentIfEmpty} at the boundary, then the shared clause and command.
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${stackClause(stackName, region)} holds ${logicalIds.length} ` +
    `rollback-orphan record(s) in 'orphans' that cannot be read as resources — ` +
    `${namedOrphanRows(logicalIds)} — because they are not objects, have no string 'logicalId' ` +
    `or share it with another row, or their 'state' is not an object, names no resource type${
      alsoRejectsTornMaps
        ? `, has no non-empty string 'physicalId', or holds a 'properties' or 'attributes' map ` +
          `that is not an object`
        : ` or has no non-empty string 'physicalId'`
    }. Continuing ` +
    `WITHOUT them: ${
      alsoRejectsTornMaps
        ? `they are excluded from the secret scan, so nothing this run does can certify them`
        : `they are not previewed for adoption, and 'cdkd deploy' refuses the record over them ` +
          `rather than dropping them as this command does`
    }. These ids were read from 'orphans'; ` +
    `the 'resources' map carries its own warning when it is damaged too. ${inspectClause(stackName, region, recovery)}See the ` +
    `stored values with: ` +
    inspectCommand(stackName, region, recovery)
  );
}

/**
 * Is ONE `orphans[]` record PREVIEWABLE — the narrow half of
 * {@link isReadableOrphanRecord}, for `cdkd diff` alone (go-to-k/cdkd#3500).
 *
 * An object, a string `logicalId`, and a `state` that is a readable resource
 * entry with a non-empty string `physicalId`: everything the adoption preview
 * dereferences, and nothing more. The `physicalId` half is NOT inherited from
 * {@link isReadableResourceEntry} — see {@link hasStringPhysicalId} for why that
 * one stops at `resourceType` and why a ROW cannot. It
 * deliberately does not ask about that entry's `properties`, because `cdkd diff`
 * has a LATER answer for that one — `computeStackDiff` runs the `properties`
 * repair a second time over the adopted records and names what it emptied, which
 * `docs/cli-diff.md` and `.claude/rules/state-malformed-properties.md` both
 * describe. Dropping such a row here instead would make that repair unreachable
 * and silently retire a documented report. A torn `attributes` map rides through
 * for the same reason and gets NO later answer: stated rather than solved, and
 * the same residual `cdkd diff` had before this predicate existed.
 *
 * It CANNOT see rows sharing a `logicalId` (go-to-k/cdkd#3643), a LIST-level
 * defect — never filter a list with it alone; take
 * {@link previewableOrphanRecords} / {@link unpreviewableOrphanRecords}.
 *
 * Every WRITER takes the full predicate: none of them has a second answer, and
 * a torn `properties` map reaching a save is go-to-k/cdkd#3344's defect.
 */
export function isPreviewableOrphanRecord(record: unknown): boolean {
  if (!isReadableBag(record)) return false;
  if (typeof (record as { logicalId?: unknown }).logicalId !== 'string') return false;
  const entry = (record as { state?: unknown }).state;
  return isReadableResourceEntry(entry) && hasStringPhysicalId(entry);
}

/**
 * Does this resource entry carry a NON-EMPTY string `physicalId`?
 *
 * Its own helper rather than a clause spelled in each row predicate, so the two
 * cannot drift on it, and deliberately NOT folded into
 * {@link isReadableResourceEntry}: that one answers for a `resources` ENTRY,
 * where stopping at `resourceType` is a recorded decision — a row with a type and
 * no physical id fails per-resource where it is used and is reported by that
 * command in its own terms.
 *
 * An `orphans` ROW has no such second report, which is why it asks for more
 * (go-to-k/cdkd#3641 review). The record names a resource cdkd deliberately LEFT
 * LIVE in AWS, so the physical id is the only handle on it: `cdkd destroy`'s
 * pre-confirmation listing is the operator's only notice before the record is
 * deleted, and it rendered an absent id as an EMPTY field in the row they
 * approve. `planOrphanAdoption` dereferences it eight times over — including
 * `knownPhysicalId` on the provider call and `claims().has(...)` for a
 * cross-stack collision — so a row without one decides an adoption from
 * `undefined`.
 */
function hasStringPhysicalId(entry: unknown): boolean {
  const physicalId = (entry as { physicalId?: unknown }).physicalId;
  // NON-EMPTY, not merely a string (go-to-k/cdkd#3641 item o6). An empty id is
  // the same operator-facing outcome the check exists to close: `cdkd destroy`
  // lists the row with a blank field and deletes the record once approved, and
  // `planOrphanAdoption` resolves `''` against AWS and against other stacks'
  // claims. Nothing cdkd writes can produce it — a provider returns the real id —
  // so this refuses only a hand-damaged record.
  return typeof physicalId === 'string' && physicalId !== '';
}

/**
 * Can cdkd ADDRESS this `resources` record's resource in AWS — does it carry a
 * string `physicalId` with something other than whitespace in it
 * (go-to-k/cdkd#3211)?
 *
 * The per-resource half {@link isReadableResourceEntry} leaves to "where it is
 * used": the deploy asks it before each provider call that would address AWS
 * by the field, since a provider handed an absent or blank id fails, or answers
 * `*NotFound`, which a delete reads as ALREADY DELETED and drops the record of
 * a resource still live. Whitespace counts as blank here, unlike
 * {@link hasStringPhysicalId}: nothing cdkd writes produces either, and no AWS
 * identifier is whitespace.
 */
export function hasAddressablePhysicalId(entry: { physicalId?: unknown }): boolean {
  const physicalId = entry.physicalId;
  return typeof physicalId === 'string' && physicalId.trim() !== '';
}

/**
 * The text `cdkd deploy` raises for an UPDATE of a record failing
 * {@link hasAddressablePhysicalId} (go-to-k/cdkd#3211). A refusal of that one
 * resource, not the destroy's skip: a skipped update would end the deploy
 * without the template's change and resolve its dependents from the stale
 * record. The identity is the CALLER's, never the record's.
 */
export function unaddressableUpdateRefusalMessage(
  rawStackName: string,
  rawRegion: string,
  logicalId: string,
  resourceType: string,
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): string {
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${stackClause(stackName, region)} holds a record for ${displayIdent(logicalId)} ` +
    `(${displayIdent(resourceType)}) with no non-empty string 'physicalId', so cdkd cannot ` +
    `address that resource in AWS and did not try to update it. 'cdkd deploy' fails on it ` +
    `rather than skipping it, since a skipped update would end the deploy without the ` +
    `template's change. Nothing was sent for this resource. Repair the record's ` +
    `'physicalId' and re-run. ${inspectClause(stackName, region, recovery)}Inspect the record with: ` +
    inspectCommand(stackName, region, recovery)
  );
}

/**
 * The `orphans[]` records {@link isPreviewableOrphanRecord} rejects, PLUS every
 * row sharing its string `logicalId` with another row (go-to-k/cdkd#3643),
 * each by its `logicalId`, or `null` when it has no string one.
 *
 * `null` rather than {@link unreadableOrphanRecords}' `''` (go-to-k/cdkd#3339):
 * `cdkd diff --json` carries these ids raw, and `''` is also a legal string
 * `logicalId`, so a stand-in a record can spell could not tell a row with no id
 * from a row whose id is empty. A caller wanting the warning's names maps
 * `null` to `''` itself.
 */
export function unpreviewableOrphanRecords(
  state: Pick<StackState, 'orphans'>
): ReadonlyArray<string | null> {
  if (!Array.isArray(state.orphans)) return [];
  const rows = state.orphans as unknown[];
  const shared = sharedOrphanLogicalIds(rows);
  return rows
    .filter((record) => !isPreviewableOrphanRecord(record) || sharesLogicalId(record, shared))
    .map(orphanRowId);
}

/**
 * The rows `cdkd diff` KEEPS for the adoption preview: the complement of
 * {@link unpreviewableOrphanRecords}, homed beside it so the two cannot
 * disagree about a row (go-to-k/cdkd#3643). `[]` for a container that is not a
 * list, which {@link hasReadableOrphans} reports.
 *
 * Why not `orphans.filter(isPreviewableOrphanRecord)` at the call site, which is
 * what `cdkd diff` did: that predicate decides ONE record, and a shared
 * `logicalId` is a property of the LIST. Two rows carrying one id both pass it,
 * and `planOrphanAdoption` then keys its adoption map on that id, so the preview
 * shows ONE adoption for two rows — the collapse the writers now refuse.
 */
export function previewableOrphanRecords(
  state: Pick<StackState, 'orphans'>
): NonNullable<StackState['orphans']> {
  if (!Array.isArray(state.orphans)) return [];
  const rows = state.orphans as unknown[];
  const shared = sharedOrphanLogicalIds(rows);
  return rows.filter(
    (record) => isPreviewableOrphanRecord(record) && !sharesLogicalId(record, shared)
  ) as NonNullable<StackState['orphans']>;
}

/**
 * The string `logicalId`s that TWO OR MORE rows of `orphans` carry
 * (go-to-k/cdkd#3643) — `''` included, since an empty string is still a key.
 *
 * Such a record is MALFORMED, not merely unusual: no supported writer produces
 * one, because `orphansAfterRollback` merges by `logicalId` and keeps one row per
 * id. What a reader does with it is the loss the row predicate exists to refuse
 * for a MISSING id — `orphansAfterRollback` keeps only the LAST of the rows, and
 * the deploy's adoption pass writes `adopted[logicalId]` for each, so the first
 * row's resource stays live in AWS with nothing tracking it.
 *
 * Counted over EVERY row that is an object carrying a string id, not only the
 * rows the per-record predicate accepts: a torn row and a healthy one sharing an
 * id still say the record was edited or damaged, and keeping the healthy one
 * would have a read-only command preview, as the stack's only row of that id, a
 * row whose twin the writers refuse over. A `Map` rather than a plain object, so
 * an id spelled `__proto__` or `constructor` is counted rather than resolved
 * through the prototype.
 */
function sharedOrphanLogicalIds(rows: readonly unknown[]): ReadonlySet<string> {
  const seen = new Map<string, number>();
  for (const record of rows) {
    if (!isReadableBag(record)) continue;
    const id = (record as { logicalId?: unknown }).logicalId;
    if (typeof id !== 'string') continue;
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const shared = new Set<string>();
  for (const [id, count] of seen) if (count > 1) shared.add(id);
  return shared;
}

/** Does this row carry one of the {@link sharedOrphanLogicalIds}? */
function sharesLogicalId(record: unknown, shared: ReadonlySet<string>): boolean {
  if (shared.size === 0 || !isReadableBag(record)) return false;
  const id = (record as { logicalId?: unknown }).logicalId;
  return typeof id === 'string' && shared.has(id);
}

/**
 * How every `orphans` ROW helper names a row: its `logicalId`, or `''`
 * (rendered as the `UNRENDERABLE` stand-in) when it has no string one.
 */
function orphanRowName(record: unknown): string {
  return orphanRowId(record) ?? '';
}

/** A row's string `logicalId`, or `null` when it has none. */
function orphanRowId(record: unknown): string | null {
  const id = isReadableBag(record) ? (record as { logicalId?: unknown }).logicalId : undefined;
  return typeof id === 'string' ? id : null;
}

/**
 * Is ONE `orphans[]` record usable by a reader (go-to-k/cdkd#3500)?
 *
 * Split out of {@link unreadableOrphanRecords} rather than written a second
 * time, so the five WRITE-capable readers that take a row's fields off the cast
 * and the `cdkd orphan` refusal that predates them cannot disagree about which
 * rows are usable. `cdkd diff` deliberately disagrees for one class — see
 * {@link isPreviewableOrphanRecord}, which is the narrower half it takes. The two shapes answer different questions and share this verdict:
 * this one decides ONE record, that one names every record a state fails on.
 *
 * A reader needs all of it to hold, because it reaches the record as a WHOLE:
 * the record is an object, its `logicalId` is a string (a row with none keys
 * `orphansAfterRollback`'s merge map on `undefined`, so several of them collapse
 * into one), its `state` is a readable resource entry carrying a NON-EMPTY string
 * `physicalId` ({@link hasStringPhysicalId} carries why that is asked here and
 * not for a `resources` entry), and that entry's `properties` and `attributes`
 * maps are readable.
 *
 * It CANNOT see the one LIST-level defect: two rows sharing a string `logicalId`
 * collapse in the same merge map, and each of them passes this test
 * (go-to-k/cdkd#3643). So never filter a list with it alone — take
 * {@link unreadableOrphanRecords} (or, for `cdkd diff`,
 * {@link previewableOrphanRecords}), which add that check.
 */
export function isReadableOrphanRecord(record: unknown): boolean {
  // COMPOSED from the narrow half rather than re-spelling its four checks
  // (go-to-k/cdkd#3641, maintainer item o2): the two predicates are a SPLIT, and
  // the only difference that may ever exist between them is the maps below. Two
  // copies of the object / `logicalId` / entry / `physicalId` tests could drift
  // apart in the direction that matters — `cdkd diff` previewing an adoption a
  // writer would refuse, which is the defect this lane opened with.
  if (!isPreviewableOrphanRecord(record)) return false;
  const entry = (record as { state?: unknown }).state;
  return (
    isReadableBag((entry as { properties?: unknown }).properties) && hasReadableAttributes(entry)
  );
}

/**
 * The `orphans[]` records a reader cannot use: a record that is not an object
 * or has no string `logicalId`, or whose `state` is not a readable resource entry,
 * carries no non-empty string `physicalId`, or carries an unreadable `properties`
 * or `attributes` map
 * (go-to-k/cdkd#3344). The `logicalId` half is go-to-k/cdkd#3500's row
 * predicate: rows MISSING one all key the same map entry, and
 * `orphansAfterRollback` collapses those into one. EVERY row whose string
 * `logicalId` another row also carries is named too — each of them, since
 * nothing says which is the live resource (go-to-k/cdkd#3643,
 * {@link sharedOrphanLogicalIds}): those collapse in the same map by the same
 * mechanism, and it is the check {@link isReadableOrphanRecord} cannot make.
 * Folded in HERE so every refusal, the read-only repair and `cdkd orphan`
 * inherit it and no caller re-spells it.
 *
 * Every `ResourceState` question the `resources` side answers in separate
 * predicates, asked in ONE here: a rollback-orphan record is reached only as a
 * whole — `computeStackDiff` and the deploy's adoption pass splice the record
 * into `resources` — so which part of it is torn does not change what a caller
 * can do with it. Returns `[]` for a container that is not a list, which is
 * {@link hasReadableOrphans}'s to report. Each record is named by its
 * `logicalId`, or `''` (rendered as the `UNRENDERABLE` stand-in) when it has
 * no string one — the convention {@link malformedOrphanRecordsWarning} takes.
 */
export function unreadableOrphanRecords(state: Pick<StackState, 'orphans'>): readonly string[] {
  if (!Array.isArray(state.orphans)) return [];
  const rows = state.orphans as unknown[];
  const shared = sharedOrphanLogicalIds(rows);
  return rows.filter((record) => isUnusableOrphanRow(record, shared)).map(orphanRowName);
}

/**
 * The writers' per-row verdict with the list-level half applied: the ONE test
 * {@link unreadableOrphanRecords} names by and
 * {@link repairMalformedOrphanRecordsForReadOnly} drops by, so the rows a
 * dry run drops are exactly the rows the real run refuses over.
 */
function isUnusableOrphanRow(record: unknown, shared: ReadonlySet<string>): boolean {
  return !isReadableOrphanRecord(record) || sharesLogicalId(record, shared);
}

/**
 * Refuse a readable `orphans` list holding a record no reader can use, on a
 * path that can WRITE state (go-to-k/cdkd#3500).
 *
 * The CONTAINER pair beside this one ({@link refuseMalformedOrphans} and its
 * destroy twin) answers "is the field a list"; this answers "is every row in it
 * usable", and a list can fail the second while passing the first. One
 * predicate for both questions would be wrong in the direction that loses
 * evidence: `cdkd diff` repairs the container and must DROP a row, which is not
 * the same verdict.
 *
 * Marked non-retryable for {@link refuseMalformedOrphans}'s reason: a retry
 * cannot change a persisted record, and a nested child's deploy runs inside a
 * `withRetry`.
 *
 * `recovery` is the caller's account (go-to-k/cdkd#3909): the drop, listing
 * and inspect lines carry it through {@link accountArgs}. Its arms are pinned
 * by calling the message builder directly — `refuseMalformedOrphansForOrphan`
 * is NOT that route, since it raises a different text
 * ({@link malformedOrphansForOrphanRefusalMessage}).
 */
export function refuseMalformedOrphanRecords(
  state: Pick<StackState, 'orphans'>,
  stackName: string | undefined,
  region: string | undefined,
  recovery?: LockRecoveryContext
): void {
  const unreadable = unreadableOrphanRecords(state);
  if (unreadable.length === 0) return;
  throw markNonRetryable(
    new CdkdError(
      malformedOrphanRecordsRefusalMessage(stackName, region, unreadable, recovery),
      STATE_RESOURCES_MALFORMED
    )
  );
}

/**
 * The DESTROY twin of {@link refuseMalformedOrphanRecords}, carrying its own
 * text for the reason the container pair splits: a destroy neither walks the
 * record back into `resources` nor writes a reshaped one, so the writer text's
 * mechanism would be false here. What it does instead is REPORT the rows — the
 * operator's only notice that those resources stop being tracked — from fields
 * it never validates, and then remove the record.
 */
export function refuseMalformedOrphanRecordsForDestroy(
  state: Pick<StackState, 'orphans'>,
  stackName: string | undefined,
  region: string | undefined,
  /** See {@link refuseMalformedOrphanRecords}. */
  recovery?: LockRecoveryContext
): void {
  const unreadable = unreadableOrphanRecords(state);
  if (unreadable.length === 0) return;
  throw markNonRetryable(
    new CdkdError(
      malformedOrphanRecordsForDestroyRefusalMessage(stackName, region, unreadable, recovery),
      STATE_RESOURCES_MALFORMED
    )
  );
}

/**
 * The WRITER text {@link refuseMalformedOrphanRecords} raises.
 *
 * Its mechanism clause names THREE outcomes rather than one, because a reader
 * meets a different one per shape: a row MISSING its `logicalId` keys
 * `orphansAfterRollback`'s merge map on `undefined`, so rows missing it collapse
 * to one saved survivor (distinct NUMERIC ids do not — they stay distinct keys),
 * and rows SHARING a string one collapse the same way (go-to-k/cdkd#3643);
 * a row whose `state` is absent or null aborts wherever it is first
 * dereferenced; and a `state` that is a primitive or names no resource type
 * reads as `undefined` and is carried or reported as though it were a record.
 */
export function malformedOrphanRecordsRefusalMessage(
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
    `${stackClause(stackName, region)} holds ${logicalIds.length} rollback-orphan record(s) in ` +
      `'orphans' that cannot be read — ${namedOrphanRows(logicalIds)} — because the record has ` +
      `no string 'logicalId' or shares it with another row, or its 'state' is not an object, ` +
      `names no resource type, has no ` +
      `non-empty string 'physicalId', or holds a 'properties' or 'attributes' map that is not an ` +
      `object. This command can WRITE ` +
      `state, and ` +
      `what it would do with such a row is not one thing: 'cdkd rollback' merges by 'logicalId', ` +
      `so rows MISSING one, or SHARING one, key the same entry and only one of them survives ` +
      `into the record it saves, the others' resources left live in AWS with nothing tracking ` +
      `them; a row whose 'state' is absent or null aborts wherever it is first dereferenced, ` +
      `with an error naming neither the field nor the stack; and the quietest shape is neither — ` +
      `a 'state' that is a primitive, or an object naming no resource type, reads as 'undefined' ` +
      `and is carried or reported as if it were a record. It refuses rather than pick one of ` +
      `those outcomes.`,
    `Repair the record by hand rather than deleting it — it is the only record that an earlier ` +
      `failed deploy left its resource live in AWS.`,
    ORPHANS_DROP_CAVEAT
  );
}

/** The DESTROY text {@link refuseMalformedOrphanRecordsForDestroy} raises. */
export function malformedOrphanRecordsForDestroyRefusalMessage(
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
    `${stackClause(stackName, region)} holds ${logicalIds.length} rollback-orphan record(s) in ` +
      `'orphans' that cannot be read — ${namedOrphanRows(logicalIds)} — because the record has ` +
      `no string 'logicalId' or shares it with another row, or its 'state' is not an object, ` +
      `names no resource type, has no ` +
      `non-empty string 'physicalId', or holds a 'properties' or 'attributes' map that is not an ` +
      `object. This command DELETES ` +
      `state, and the record is the only evidence that those resources are live in AWS — so it ` +
      `refuses over any part of a row it cannot read rather than removing evidence it could not ` +
      `fully report. What the DAMAGE costs the report depends on which part is torn: the listing ` +
      `that tells you which resources stop being tracked prints the row's own 'logicalId', ` +
      `resource type and physical id, from fields nothing else validates, so it can abort before ` +
      `the confirmation naming nothing, or print a row with a field missing and let you approve ` +
      `the delete. A torn 'properties' or 'attributes' map the listing never reads is refused too, ` +
      `because what is discarded is the whole record. So are rows sharing one 'logicalId', though ` +
      `the listing would print each: no cdkd command writes such a record — the rollback save ` +
      `merges by id and every other save carries the list unchanged — so it was damaged or ` +
      `edited by hand, and deleting it would discard it before ` +
      `anyone decides which of those resources the stack still owns.`,
    `Repair the record by hand rather than deleting it — it is the only record that an earlier ` +
      `failed deploy left its resource live in AWS.`,
    ORPHANS_DROP_CAVEAT
  );
}

/**
 * The READ-ONLY disposition for the same rows: DROP them and return their
 * names, for a command that never writes the record back — `cdkd scrub
 * --dry-run` today.
 *
 * Returns the dropped names rather than a boolean because its caller reports
 * them: `cdkd scrub --dry-run` warns with them by name, and the stack joins the
 * audited-record refusal's list. `cdkd diff` does NOT call this — it needs the
 * narrower {@link isPreviewableOrphanRecord} and keeps the survivors itself. An
 * empty return means nothing was dropped and the list is untouched.
 */
export function repairMalformedOrphanRecordsForReadOnly(
  state: Pick<StackState, 'orphans'>
): readonly string[] {
  const unreadable = unreadableOrphanRecords(state);
  if (unreadable.length === 0) return [];
  // The `?? []` arm is UNREACHABLE and kept for the TYPE, which is worth saying
  // rather than leaving a reader to decide it is dead code (go-to-k/cdkd#3641
  // review): a non-empty `unreadable` proves the field is an array, but that proof
  // lives inside `unreadableOrphanRecords`, so nothing here narrows the optional
  // field and TS18048 is the result of dropping it. Re-spelling `Array.isArray`
  // beside the call would be the second copy this module exists to avoid.
  const rows = state.orphans ?? [];
  // Taken from the list BEFORE it is filtered: every row of a shared id goes,
  // which is what `unreadableOrphanRecords` just named (go-to-k/cdkd#3643).
  const shared = sharedOrphanLogicalIds(rows);
  state.orphans = rows.filter((record) => !isUnusableOrphanRow(record, shared));
  return unreadable;
}

/**
 * For `cdkd orphan`: refuse a record whose `orphans` list, or any record in
 * it, cannot be read (go-to-k/cdkd#3344).
 *
 * A THIRD entry point on the `orphans` container, beside
 * {@link refuseMalformedOrphans} and its destroy twin, because neither text is
 * true here. The rewrite neither walks nor rebuilds this container — it
 * spreads it through `carriedState` VERBATIM (measured: `"abc"` comes back
 * `"abc"`, a record whose `state.properties` is `"abcdef"` comes back byte for
 * byte) — so the rollback text's "written back as a list of character-shaped
 * orphan records" would be false. What this command does is SAVE it, report
 * success, and leave the damage for the next deploy or diff to meet.
 *
 * NOT scoped by the orphan set: these records are not in `resources`, so
 * `cdkd orphan` cannot name one, and its save keeps every one of them.
 */
export function refuseMalformedOrphansForOrphan(
  state: Pick<StackState, 'orphans'>,
  stackName: string | undefined,
  region: string | undefined,
  recovery?: LockRecoveryContext
): void {
  if (!hasReadableOrphans(state)) {
    throw new CdkdError(
      malformedOrphansForOrphanRefusalMessage(stackName, region, undefined, recovery),
      STATE_RESOURCES_MALFORMED
    );
  }
  const unreadable = unreadableOrphanRecords(state);
  if (unreadable.length === 0) return;
  throw new CdkdError(
    malformedOrphansForOrphanRefusalMessage(stackName, region, unreadable, recovery),
    STATE_RESOURCES_MALFORMED
  );
}

/**
 * The `--fail` / exit-3 reason `cdkd diff` reports for an `orphans` row it KEEPS
 * in the preview and `cdkd deploy` REFUSES (go-to-k/cdkd#3641 maintainer review,
 * M1).
 *
 * The two predicates disagree on exactly one class — a row whose `properties` or
 * `attributes` map is torn — and that disagreement is deliberate: `cdkd diff`
 * keeps such a row so the second `properties` repair can name it. What was
 * missing is the OTHER half of keeping it: the deploy refuses the whole record
 * over that same row, so a preview that says nothing lets `cdkd diff --fail`
 * exit 0 and the deploy the operator runs next refuse. That is the contract
 * `cdkd diff` states for the adoption preview, and this PR is what made it
 * false. Precisely which shapes: a torn `attributes` map, and a torn `properties`
 * map on a row the adoption did NOT take — an ADOPTED torn-`properties` row was
 * already refused at deploy through `calculateDiff` before this lane
 * (go-to-k/cdkd#3641 item o5), and it is the one the sibling arm reports.
 *
 * Homed HERE rather than in `diff-recursive.ts` for the reason every text in
 * this module is: it renders untrusted logical ids, so it needs
 * {@link namedOrphanRows} — the same cap, the same `displayLogicalId`, the same
 * `UNRENDERABLE` stand-in. It NAMES the rows as well as counting them, unlike
 * {@link deployRefusesPropertiesReason}'s count-only line in that file. It keeps
 * the names even though {@link malformedOrphanRowsKeptWarning} now names them
 * too: this reason ships in the `--json` payload, where "see the warning above"
 * has no referent — the same argument that sibling's doc makes for its own
 * shape.
 */
export function deployRefusesOrphanRowsReason(logicalIds: readonly string[]): string {
  return (
    `${logicalIds.length} rollback-orphan record(s) in 'orphans' — ${namedOrphanRows(logicalIds)} — ` +
    `carry a 'properties' or 'attributes' map that cannot be read. This preview KEEPS them, so ` +
    `any adoption shown for them is one 'cdkd deploy' will not perform: it refuses the record ` +
    `over the same rows, and the deploy this previews will not start.`
  );
}

/**
 * The WARNING `cdkd diff` prints for an `orphans` row it KEEPS and a writer
 * refuses (go-to-k/cdkd#3641 maintainer round 2, M1 continued).
 *
 * At every node the RUN REACHES with an adoption preview, which is narrower than
 * "every node" and the difference is not pedantry (round 4): a non-recursive run —
 * the default — returns before visiting any child, a state-only child being
 * DELETED is built with no `previewOrphanAdoption` so the whole row pass is
 * skipped, and any other caller omitting that option skips it too.
 *
 * The exit-3 reason beside this one is TOP-LEVEL only, which is
 * go-to-k/cdkd#3335's scope decision and right: the deploy skips an unchanged
 * nested-stack row, so a reason there would report a refusal over a deploy that
 * succeeds. What made that split SAFE for every other class is that each one
 * still warns at every node — and this class had no warning at all, because the
 * row is KEPT and {@link malformedOrphanRecordsWarning} speaks only for rows that
 * were DROPPED. So a changed nested child holding such a row printed nothing and
 * its deploy refused.
 *
 * It says what the row IS and what the deploy will do, and makes no claim about
 * what else happens to the row — which is where the first two spellings went
 * wrong (go-to-k/cdkd#3641 rounds 3 and 4). One said the map "is repaired and
 * named again over the records an adoption takes", false for every row that
 * survives the caller's subtraction; the next said nothing else repairs or
 * previews these rows, false for an ADOPTED row whose `properties` are healthy and
 * whose `attributes` are torn — the subtraction removes adopted torn-`properties`
 * names, not every adopted row, and `planOrphanAdoption` rebuilds that row's
 * attributes and previews the adopted resource. The row's disposition beyond
 * "kept" is the caller's business, not this sentence's.
 *
 * It says the deploy of THIS stack refuses, not that "the deploy this previews"
 * will not start (round 4 again): under `--recursive` this warning can name a row
 * in an UNCHANGED nested child, whose parent deploy skips that child and
 * succeeds. The stack the message already names is the one whose deploy refuses.
 */
export function malformedOrphanRowsKeptWarning(
  rawStackName: string,
  rawRegion: string,
  logicalIds: readonly string[],
  /** The caller's account flags, carried on the inspect command (go-to-k/cdkd#4159). */
  recovery?: LockRecoveryContext
): string {
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  return (
    `${stackClause(stackName, region)} holds ${logicalIds.length} rollback-orphan record(s) in ` +
    `'orphans' — ${namedOrphanRows(logicalIds)} — whose 'properties' or 'attributes' map is not ` +
    `an object. This preview KEEPS them. 'cdkd deploy' of THIS stack does NOT: it refuses the ` +
    `whole record over these rows and will not start until they are repaired. ${inspectClause(stackName, region, recovery)}See the stored ` +
    `values with: ` +
    inspectCommand(stackName, region, recovery)
  );
}

/**
 * The `<ids> and N more` fragment every `orphans` ROW text shares — the three
 * refusals and the warning — so a fifth cannot spell the cap differently
 * (go-to-k/cdkd#3500). Derive the list with
 * `grep -n "namedOrphanRows(" src/state/malformed-resources-bag/orphan-records.ts`.
 */
function namedOrphanRows(logicalIds: readonly string[]): string {
  const named = logicalIds
    .slice(0, NAMED_UNREADABLE_ENTRIES)
    .map((id) => displayLogicalId(id))
    .join(', ');
  const rest = logicalIds.length - NAMED_UNREADABLE_ENTRIES;
  return `${named}${rest > 0 ? ` and ${rest} more` : ''}`;
}

/** See {@link orphanRefusal}'s `dropCaveat`. */
const ORPHANS_DROP_CAVEAT =
  `; it also discards the 'orphans' list, the only record of resources an earlier failed ` +
  `deploy left live in AWS`;

/**
 * The text {@link refuseMalformedOrphansForOrphan} raises: the CONTAINER arm
 * when `logicalIds` is `undefined`, the RECORDS arm otherwise.
 *
 * Its third way out is not {@link SURVIVOR_THIRD_WAY_OUT}: a record in
 * `orphans` has no construct path, so `cdkd orphan` cannot remove it, and the
 * hand repair that remains must not be a deletion — the record is the only
 * evidence that an earlier failed deploy left its resource live in AWS.
 */
export function malformedOrphansForOrphanRefusalMessage(
  rawStackName: string | undefined,
  rawRegion: string | undefined,
  logicalIds: readonly string[] | undefined,
  recovery?: LockRecoveryContext
): string {
  const stackName = absentIfEmpty(rawStackName);
  const region = absentIfEmpty(rawRegion);
  const verbatim =
    `'cdkd orphan' carries it into the record it saves VERBATIM, without reading it, so it ` +
    `refuses rather than continuing — under '--dry-run' too, so a dry run never prints a plan ` +
    `the real run refuses.`;
  if (logicalIds === undefined) {
    return orphanRefusal(
      stackName,
      region,
      recovery,
      `${stackClause(stackName, region)} has no readable 'orphans' list — the record is ` +
        `malformed or truncated. ${verbatim} The next 'cdkd deploy' refuses the same record, so ` +
        `continuing would only report success over it and leave that refusal one command later.`,
      `'cdkd orphan' cannot address this list at all, and rewriting it to [] by hand discards ` +
        `the only record of resources an earlier failed deploy left live in AWS.`,
      ORPHANS_DROP_CAVEAT
    );
  }
  return orphanRefusal(
    stackName,
    region,
    recovery,
    `${stackClause(stackName, region)} holds ${logicalIds.length} rollback-orphan record(s) in ` +
      `'orphans' that cannot be read — ${namedOrphanRows(logicalIds)} — because the record has no ` +
      `string 'logicalId' or shares it with another row, or its 'state' is not an object, names ` +
      `no resource type, has no ` +
      `non-empty string 'physicalId', or holds a 'properties' or 'attributes' map that is not an ` +
      `object. The record is malformed or truncated. ${verbatim} Those records are not inert: they ` +
      `are what the next 'cdkd deploy' may re-adopt into 'resources' and what 'cdkd diff' ` +
      `previews for adoption, so continuing would report success over damage the next command meets.`,
    `'cdkd orphan' cannot remove such a record itself: it is not in 'resources', so it has no ` +
      `construct path. Repair the record by hand rather than deleting it — it is the only ` +
      `record that an earlier failed deploy left its resource live in AWS.`,
    ORPHANS_DROP_CAVEAT
  );
}
