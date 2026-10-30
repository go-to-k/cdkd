/**
 * The superseded resources a stack still has to delete (go-to-k/cdkd#5111):
 * the old copy of a replaced resource whose delete was refused inside the
 * deploy (an in-use target group a listener still points at). The deploy
 * records each one in `StackState.supersededResources` the moment it defers
 * the delete, so a deploy killed before its cleanup leaves the resource
 * tracked, not lost. Plain helpers over the field; the deploy's retry lives
 * in `deploy-engine/superseded-retry.ts`, the destroy's in
 * `cli/commands/destroy-runner.ts`.
 */
import { replacementDeletePolicy } from '../provisioning/final-snapshot.js';
import type { ResourceDeleteResult, ResourceProvider } from '../types/resource.js';
import type { ResourceState, StackState, SupersededResourceRecord } from '../types/state.js';
import { reportDeleteGuards } from './delete-guard-scope.js';
import { deleteSkipReason } from './delete-outcome.js';

/**
 * The well-formed entries of `state.supersededResources`. A malformed entry
 * (a hand edit) is not acted on, and stays in the array for a writer that
 * carries the field verbatim.
 */
export function supersededResourcesOf(
  state: Pick<StackState, 'supersededResources'> | null | undefined
): SupersededResourceRecord[] {
  const rows: unknown = state?.supersededResources;
  if (!Array.isArray(rows)) return [];
  return rows.filter(isSupersededResourceRecord);
}

export function isSupersededResourceRecord(row: unknown): row is SupersededResourceRecord {
  if (typeof row !== 'object' || row === null) return false;
  const entry = row as Record<string, unknown>;
  const record = entry['state'];
  if (typeof entry['logicalId'] !== 'string') return false;
  if (typeof record !== 'object' || record === null) return false;
  const { physicalId, resourceType, properties } = record as Record<string, unknown>;
  return (
    typeof physicalId === 'string' &&
    physicalId !== '' &&
    typeof resourceType === 'string' &&
    resourceType !== '' &&
    typeof properties === 'object' &&
    properties !== null &&
    !Array.isArray(properties)
  );
}

/**
 * Whether a record of `resources` holds the entry's physical id, under ANY
 * type. A rollback that took the old copy back holds it, and so does a
 * delete-first replacement that re-created the resource under the same id:
 * deleting the entry would delete that live resource. An equal id under
 * another type may name a different resource (#2668), but the safe answer
 * is still "held": cdkd never deletes an id one of its records names.
 */
export function isSupersededHeld(
  entry: SupersededResourceRecord,
  resources: Record<string, ResourceState>
): boolean {
  return supersededHolderOf(entry, resources) !== undefined;
}

/**
 * The record naming the entry's physical id, if any. A holder of ANOTHER
 * type may be a different resource that happens to share the string (an IAM
 * role and a function both called `foo`): the entry is still never deleted,
 * but its caller warns that the superseded copy may be left in AWS.
 */
export function supersededHolderOf(
  entry: SupersededResourceRecord,
  resources: Record<string, ResourceState>
): ResourceState | undefined {
  const holders = Object.values(resources).filter(
    (record) =>
      typeof record === 'object' && record !== null && record.physicalId === entry.state.physicalId
  );
  // A same-type holder first: it is the one that took the copy back.
  return holders.find((record) => record.resourceType === entry.state.resourceType) ?? holders[0];
}

/**
 * Held by a record of the SAME type: a rollback took the copy back, or a
 * same-id re-create made it live again. Dropped silently; another type's
 * holder is left for the retry or destroy, which warns.
 */
export function isSupersededHeldBySameType(
  entry: SupersededResourceRecord,
  resources: Record<string, ResourceState>
): boolean {
  return Object.values(resources).some(
    (record) =>
      typeof record === 'object' &&
      record !== null &&
      record.physicalId === entry.state.physicalId &&
      record.resourceType === entry.state.resourceType
  );
}

/** The warning for an entry dropped because a record of another type names its id. */
export function supersededHeldByOtherTypeWarning(
  entry: SupersededResourceRecord,
  holderType: string
): string {
  return (
    `the superseded ${entry.state.resourceType} of ${entry.logicalId} (${entry.state.physicalId}) ` +
    `was not deleted: a ${holderType} record of this stack has the same physical id, and cdkd never ` +
    `deletes an id a record names. If the ${entry.state.resourceType} still exists, delete it by hand; ` +
    `it is no longer tracked in state.`
  );
}

/** Record `entry` on `host` (the deploy's live state). */
export function addSuperseded(
  host: Pick<StackState, 'supersededResources'>,
  entry: SupersededResourceRecord
): void {
  // One entry per resource: a re-recorded one replaces the earlier entry, or
  // a later run would delete (and count) it twice.
  const others = (Array.isArray(host.supersededResources) ? host.supersededResources : []).filter(
    (row) =>
      !isSupersededResourceRecord(row) ||
      row.state.physicalId !== entry.state.physicalId ||
      row.state.resourceType !== entry.state.resourceType
  );
  host.supersededResources = [...others, entry];
}

/**
 * Whether a deferred delete of `record` can be recorded for a later run
 * (go-to-k/cdkd#5111): only when that run can send the delete with the
 * context this run had. Not for a record holding a NoEcho mask (its delete
 * needs values only this run re-resolved) nor an IAM inline policy (its
 * delete asks this run's records whether another writer took the name, #4821);
 * those keep the in-memory deferral and its warning.
 */
export function canRecordSuperseded(
  record: ResourceState,
  deleteContext: { noEchoDeleteValues?: unknown; inlinePolicyClaimed?: unknown }
): boolean {
  if (deleteContext.noEchoDeleteValues !== undefined) return false;
  if (deleteContext.inlinePolicyClaimed !== undefined) return false;
  if (Array.isArray(record.noEchoLeaves) && record.noEchoLeaves.length > 0) return false;
  return !INLINE_POLICY_TYPES.has(record.resourceType);
}

const INLINE_POLICY_TYPES = new Set([
  'AWS::IAM::Policy',
  'AWS::IAM::RolePolicy',
  'AWS::IAM::UserPolicy',
  'AWS::IAM::GroupPolicy',
]);

/**
 * Forget `entry` (by identity) on `host`; the field goes when it empties, so
 * a stack that never superseded anything keeps a byte-identical record.
 */
export function removeSuperseded(
  host: Pick<StackState, 'supersededResources'>,
  entry: SupersededResourceRecord
): void {
  if (!Array.isArray(host.supersededResources)) return;
  const remaining = host.supersededResources.filter((row) => row !== entry);
  if (remaining.length === 0) delete host.supersededResources;
  else host.supersededResources = remaining;
}

/**
 * go-to-k/cdkd#5064: a rollback save's `supersededResources`: the state's own
 * entries, plus the new resources a renamed reversal's deferred delete has yet
 * to remove (`pending`). Nothing when there are none of the latter, so the
 * carried field stays as it was.
 */
export function supersededAfterRollback(
  base: Pick<StackState, 'supersededResources'>,
  pending: Pick<StackState, 'supersededResources'>
): Pick<StackState, 'supersededResources'> {
  const added = Array.isArray(pending.supersededResources) ? pending.supersededResources : [];
  if (added.length === 0) return {};
  const own = Array.isArray(base.supersededResources) ? base.supersededResources : [];
  return { supersededResources: [...own, ...added] };
}

/** The remedy a kept entry's warning names. */
export const SUPERSEDED_KEPT_REMEDY =
  'cdkd keeps it in state: the next `cdkd deploy` of this stack retries the delete, and ' +
  '`cdkd destroy` deletes it';

/** `state` without `supersededResources`, for a writer that writes its own. */
export function withoutSuperseded<T extends Pick<StackState, 'supersededResources'>>(
  state: T
): Omit<T, 'supersededResources'> {
  const { supersededResources: _dropped, ...rest } = state;
  return rest;
}

/** What {@link deleteSupersededEntry} did: deleted, not deleted (a provider's reason), or failed. */
export type SupersededDeleteOutcome =
  | { kind: 'deleted' }
  | { kind: 'notDeleted'; reason: string }
  | { kind: 'failed'; error: unknown };

/**
 * Send the delete of one superseded resource, as the replacement that
 * superseded it would have: its `UpdateReplacePolicy`, final snapshot and
 * `--force-stateful-recreation` consent, against the record it was
 * recorded with. Never throws; a provider skip is reported, not success.
 */
export async function deleteSupersededEntry(
  entry: SupersededResourceRecord,
  input: {
    provider: ResourceProvider;
    region: string;
    /** `cdkd destroy --remove-protection`. */
    removeProtection?: boolean;
    maskSecrets: (text: string) => string;
    /** Set by `cdkd destroy` only (`DeleteContext.stackDestroy`). */
    stackDestroy?: boolean;
    /** An interrupt: stop waiting out an "in use" refusal. */
    stop: () => boolean;
    /** Send once, without waiting out an "in use" refusal (a deploy's carried retry). */
    once?: boolean;
  }
): Promise<SupersededDeleteOutcome> {
  const record = entry.state;
  let result: void | ResourceDeleteResult;
  try {
    const send = (): Promise<void | ResourceDeleteResult> =>
      input.provider.delete(
        entry.logicalId,
        record.physicalId,
        record.resourceType,
        record.properties,
        {
          expectedRegion: input.region,
          ...(entry.forceDataDelete === true && { forceDataDelete: true }),
          ...(entry.finalSnapshotIdentifier !== undefined && {
            finalSnapshotIdentifier: entry.finalSnapshotIdentifier,
          }),
          deletionPolicy: replacementDeletePolicy(entry.updateReplacePolicy),
          ...(entry.skipFinalSnapshot === true && { skipFinalSnapshot: true }),
          ...(input.removeProtection === true && { removeProtection: true }),
          ...(input.stackDestroy === true && { stackDestroy: true }),
          recordedAttributes: record.attributes,
          recordedNoEchoLeaves: record.noEchoLeaves,
          maskSecrets: input.maskSecrets,
        }
      );
    result = input.once === true ? await send() : await retryWhileInUse(send, input.stop);
  } catch (error) {
    return { kind: 'failed', error };
  }
  // Issue #2422: into the caller's guard sink, when it binds one.
  reportDeleteGuards(result, {
    physicalId: record.physicalId,
    resourceType: record.resourceType,
    provisionedBy: record.provisionedBy,
  });
  const reason = deleteSkipReason(result);
  return reason === undefined ? { kind: 'deleted' } : { kind: 'notDeleted', reason };
}

/**
 * How long a superseded resource's delete waits out an "in use" refusal
 * (go-to-k/cdkd#5111). Its user was updated or deleted earlier in the same
 * run, and AWS can take a while to see it: a load balancer's delete removes
 * its listeners asynchronously, and the old target group they pointed at
 * refuses its delete until then. Mutable for tests only.
 */
export const supersededInUseRetry = { attempts: 6, delayMs: 10_000 };

/** AWS error names that mean "another resource still uses this one". */
const IN_USE_ERROR_NAMES = new Set([
  'ResourceInUseException',
  'ResourceInUse',
  'DependencyViolation',
]);

/**
 * A Lambda web function revision an endpoint still routes to (409
 * `ConflictException: ... endpoints [<name>] are using it`, go-to-k/cdkd#4900).
 * Narrowed to that message: the class alone also means "not Active yet".
 */
const IN_USE_CONFLICT = /\bare using it\b/;

/** Whether `error` (or an error it wraps) is an "in use" refusal. */
export function isInUseRefusal(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current !== undefined && depth < 8; depth++) {
    if (typeof current !== 'object' || current === null) return false;
    const { name, message } = current as { name?: unknown; message?: unknown };
    if (typeof name === 'string' && IN_USE_ERROR_NAMES.has(name)) return true;
    if (
      name === 'ConflictException' &&
      typeof message === 'string' &&
      IN_USE_CONFLICT.test(message)
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Run `send` (one delete call), again while it fails with an "in use"
 * refusal, up to {@link supersededInUseRetry}; any other outcome is final.
 * `stop` ends the waiting early (an interrupt).
 */
export async function retryWhileInUse<T>(send: () => Promise<T>, stop: () => boolean): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (attempt >= supersededInUseRetry.attempts || stop() || !isInUseRefusal(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, supersededInUseRetry.delayMs));
      // An interrupt during the wait sends nothing more.
      if (stop()) throw error;
    }
  }
}

/**
 * Whether a record lists any superseded resource -- or a field it cannot
 * read, which may (a record that could own a resource is never "empty").
 */
export function holdsSupersededResources(record: { supersededResources?: unknown }): boolean {
  const rows = record.supersededResources;
  return rows !== undefined && (!Array.isArray(rows) || rows.length > 0);
}
