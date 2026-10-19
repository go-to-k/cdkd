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
 * Whether a record of `resources` holds the entry's resource: the same
 * physical id under the same type. A rollback that took the old copy back
 * holds it, and it must not be deleted.
 */
export function isSupersededHeld(
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

/** Whether `error` (or an error it wraps) is an "in use" refusal. */
export function isInUseRefusal(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current !== undefined && depth < 8; depth++) {
    if (typeof current !== 'object' || current === null) return false;
    const name = (current as { name?: unknown }).name;
    if (typeof name === 'string' && IN_USE_ERROR_NAMES.has(name)) return true;
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
