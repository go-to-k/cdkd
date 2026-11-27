/**
 * The superseded resources a stack still has to delete (go-to-k/cdkd#5111):
 * the old copy of a replaced resource whose delete was refused inside the
 * deploy (an in-use target group a listener still points at), or a custom
 * resource's old physical id, whose delete waits for the deploy to succeed
 * (go-to-k/cdkd#6117). The deploy
 * records each one in `StackState.supersededResources` the moment it defers
 * the delete, so a deploy killed before its cleanup leaves the resource
 * tracked, not lost. Plain helpers over the field; the deploy's retry lives
 * in `deploy-engine/superseded-retry.ts`, the destroy's in
 * `cli/commands/destroy-runner.ts`.
 */
import {
  type PreDeleteSnapshotClients,
  PRE_DELETE_SNAPSHOT_TYPES,
  createPreDeleteFinalSnapshot,
  replacementDeletePolicy,
} from '../provisioning/final-snapshot.js';
import { CdkdError } from '../utils/error-handler.js';
import { displayPhysicalId } from '../provisioning/secret-physical-id.js';
import {
  type HolderJudgement,
  incomparableHolderNote,
  isUnreadHolder,
  judgeJournaledHolder,
  notOursHolderCause,
  unreadHolderCause,
} from './journaled-holder.js';
import type { ResourceDeleteResult, ResourceProvider } from '../types/resource.js';
import type { ResourceState, StackState, SupersededResourceRecord } from '../types/state.js';
import { reportDeleteGuards } from './delete-guard-scope.js';
import { deleteSkipReason } from './delete-outcome.js';
import { readsNoEchoDeleteValues } from './noecho-delete-reresolution.js';
import { isMarkedNonRetryable } from './retryable-errors.js';
import { equalIdNamesDifferentResources } from './type-change-guard.js';

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

/**
 * `entries` in the order their deletes must run (go-to-k/cdkd#6770): an entry
 * goes once no other remaining entry depends on it, by its record's
 * `dependencies` — a replaced instance profile before the replaced role it
 * holds, a replaced `UserToGroupAddition` before its group — as the cleanup
 * phase orders a deploy's own deferred deletes. Entries no dependency orders
 * keep their order; a cycle keeps what is left in its order.
 */
export function supersededDependentsFirst<T extends SupersededResourceRecord>(
  entries: readonly T[]
): T[] {
  const ordered: T[] = [];
  let pending = [...entries];
  while (pending.length > 0) {
    const dependedOn = new Set<string>();
    for (const entry of pending) {
      const deps: unknown = entry.state.dependencies;
      if (!Array.isArray(deps)) continue;
      for (const dep of deps) {
        if (typeof dep === 'string' && dep !== entry.logicalId) dependedOn.add(dep);
      }
    }
    const wave = pending.filter((entry) => !dependedOn.has(entry.logicalId));
    if (wave.length === 0) {
      ordered.push(...pending);
      break;
    }
    ordered.push(...wave);
    pending = pending.filter((entry) => !wave.includes(entry));
  }
  return ordered;
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
 * Whether two records of one type under one physical id name the SAME
 * resource (go-to-k/cdkd#7088). Not always: a stage on another API, a
 * permission on another function, an ingress rule from another source or a
 * table in another database carries the same id
 * (`equalIdNamesDifferentResources`). Where that cannot tell (a masked
 * value, a missing key) the answer is "the same", as before.
 *
 * Two ingress records of one source holding different recorded `sgr-` ids
 * are still the same rule here: AWS holds one rule per source, and the old
 * record's id may be dead (revoked by hand), in which case its delete matches
 * the live rule by properties, the new record's own rule.
 */
export function namesSameResource(a: ResourceState, b: ResourceState): boolean {
  if (a.physicalId !== b.physicalId || a.resourceType !== b.resourceType) return false;
  return !equalIdNamesDifferentResources({
    resourceType: a.resourceType,
    physicalId: a.physicalId,
    oldProperties: a.properties,
    newProperties: b.properties,
  });
}

/** Two superseded entries for one resource of one logical id (go-to-k/cdkd#7088). */
export function sameSupersededEntry(
  a: SupersededResourceRecord,
  b: SupersededResourceRecord
): boolean {
  return a.logicalId === b.logicalId && namesSameResource(a.state, b.state);
}

const isRecord = (record: unknown): record is ResourceState =>
  typeof record === 'object' && record !== null;

/**
 * The record naming the entry's physical id, if any. A holder of ANOTHER
 * type may be a different resource that happens to share the string (an IAM
 * role and a function both called `foo`): the entry is still never deleted,
 * but its caller warns that the superseded copy may be left in AWS. A record
 * of the SAME type holds it only when it names the same resource
 * ({@link namesSameResource}): the new stage on another API does not hold
 * the old one (go-to-k/cdkd#7088).
 */
export function supersededHolderOf(
  entry: SupersededResourceRecord,
  resources: Record<string, ResourceState>
): ResourceState | undefined {
  const holders = Object.values(resources).filter(
    (record) =>
      isRecord(record) &&
      record.physicalId === entry.state.physicalId &&
      (record.resourceType !== entry.state.resourceType || namesSameResource(entry.state, record))
  );
  // A same-type holder first: it is the one that took the copy back.
  return holders.find((record) => record.resourceType === entry.state.resourceType) ?? holders[0];
}

/**
 * Held by a record of the SAME type naming the same resource
 * ({@link namesSameResource}): a rollback took the copy back, or a same-id
 * re-create made it live again. Dropped silently; another type's holder is
 * left for the retry or destroy, which warns.
 */
export function isSupersededHeldBySameType(
  entry: SupersededResourceRecord,
  resources: Record<string, ResourceState>
): boolean {
  return Object.values(resources).some(
    (record) => isRecord(record) && namesSameResource(entry.state, record)
  );
}

/** The warning for an entry dropped because a record of another type names its id. */
export function supersededHeldByOtherTypeWarning(
  entry: SupersededResourceRecord,
  holderType: string
): string {
  return (
    `the superseded ${entry.state.resourceType} of ${entry.logicalId} (${displayPhysicalId(entry.state.resourceType, entry.state.physicalId)}) ` +
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
    (row) => !isSupersededResourceRecord(row) || !namesSameResource(row.state, entry.state)
  );
  host.supersededResources = [...others, entry];
}

/**
 * Whether a deferred delete of `record` can be recorded for a later run
 * (go-to-k/cdkd#5111): only when that run can send the delete with the
 * context this run had.
 *
 * A record holding a NoEcho mask is recorded only for a deploy's deferral of
 * the record state already holds (`persistedRecord`, go-to-k/cdkd#6445), and
 * never when its delete reads this run's re-resolved values
 * ({@link deleteNeedsThisRunsNoEchoValues}): every other provider's delete
 * gets the record's properties, mask included, and its `noEchoLeaves`, which
 * a later run sends exactly as this one would. That record is masked, and the
 * deploy's persist path scrubs the entry as it does an orphan's. A rollback's
 * record may be one this run wrote, so without `persistedRecord` a NoEcho mask
 * still refuses. A delete that needs this run's values is never persisted: a
 * secret value never goes to state.
 *
 * Not an IAM inline policy either: its delete asks this run's records whether
 * another writer took the name (#4821). Its replacement deletes the old
 * policy right away and never defers (go-to-k/cdkd#6445): both policies
 * attached for the rest of the deploy would grant the union of their
 * permissions, and deferring buys nothing, since the rollback journal
 * re-creates the policy document exactly.
 */
export function canRecordSuperseded(
  record: ResourceState,
  deleteContext: {
    noEchoDeleteValues?: unknown;
    inlinePolicyClaimed?: unknown;
    /** A deploy's replaced record, as loaded from state (go-to-k/cdkd#6445). */
    persistedRecord?: boolean;
  }
): boolean {
  if (deleteNeedsThisRunsNoEchoValues(record, deleteContext.noEchoDeleteValues)) return false;
  if (
    deleteContext.persistedRecord !== true &&
    Array.isArray(record.noEchoLeaves) &&
    record.noEchoLeaves.length > 0
  ) {
    return false;
  }
  if (deleteContext.inlinePolicyClaimed !== undefined) return false;
  return !INLINE_POLICY_TYPES.has(record.resourceType);
}

/**
 * go-to-k/cdkd#6445: whether the delete of `record` reads values only this
 * run re-resolved (`DeleteContext.noEchoDeleteValues`, go-to-k/cdkd#4682): a
 * custom resource's, or a nested stack's handing them to its child, when the
 * record holds a NoEcho mask or this run re-resolved one. A later run has
 * no such values (the superseded retry and `cdkd destroy` send none), so its
 * handler would be skipped. Such a delete is deferred in memory only.
 */
export function deleteNeedsThisRunsNoEchoValues(
  record: Pick<ResourceState, 'resourceType' | 'noEchoLeaves'>,
  noEchoDeleteValues: unknown
): boolean {
  if (noEchoDeleteValues !== undefined) return true;
  return (
    readsNoEchoDeleteValues(record.resourceType) &&
    Array.isArray(record.noEchoLeaves) &&
    record.noEchoLeaves.length > 0
  );
}

/**
 * go-to-k/cdkd#6445: the IAM inline policy types, whose replaced delete never
 * defers: both policies attached would grant the union of their permissions.
 */
export function isInlinePolicyType(resourceType: string): boolean {
  return INLINE_POLICY_TYPES.has(resourceType);
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
 * to remove (`pending`).
 *
 * go-to-k/cdkd#6374: minus every own entry a record of the same type names
 * after the rollback (`resources`): a replacement's old resource, deferred to
 * the cleanup phase, that the rollback re-adopted. It is the stack's own
 * resource again, and an entry left beside its record would tell a later
 * reader it awaits a delete. It is the whole field: a save spreading the old
 * state must leave the old field out (`withoutSuperseded`), or an empty
 * answer keeps what the rollback took back.
 */
export function supersededAfterRollback(
  base: Pick<StackState, 'supersededResources'>,
  pending: Pick<StackState, 'supersededResources'>,
  resources: Record<string, ResourceState>
): Pick<StackState, 'supersededResources'> {
  const added = Array.isArray(pending.supersededResources) ? pending.supersededResources : [];
  const own = ownNotPending(base, added).filter(
    (entry) => !isSupersededResourceRecord(entry) || !isSupersededHeldBySameType(entry, resources)
  );
  const all = [...own, ...added];
  return all.length > 0 ? { supersededResources: all } : {};
}

/**
 * `base`'s entries, minus one naming the same resource as a pending entry
 * (go-to-k/cdkd#6120): a save must not carry the same id twice.
 */
function ownNotPending(
  base: Pick<StackState, 'supersededResources'>,
  added: readonly SupersededResourceRecord[]
): SupersededResourceRecord[] {
  const own = Array.isArray(base.supersededResources) ? base.supersededResources : [];
  return own.filter((entry) => !added.some((a) => namesSameResource(a.state, entry.state)));
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

/**
 * What {@link deleteSupersededEntry} did: deleted, not deleted (a provider's
 * reason), or failed. go-to-k/cdkd#6668, for an entry carrying `identity`:
 * `gone` (nothing holds the name, so no delete was sent) and `notOurs` (a
 * holder PROVEN not the stack's, left alone; `cause` names the attribute,
 * never a value). Both drop the entry. A holder that could not be read is
 * `failed`, unsent, and keeps it.
 */
export type SupersededDeleteOutcome =
  | { kind: 'deleted' }
  | { kind: 'gone' }
  | { kind: 'notOurs'; cause: string }
  | { kind: 'notDeleted'; reason: string }
  | {
      kind: 'failed';
      error: unknown;
      /**
       * go-to-k/cdkd#6463: the entry to keep in place of the one sent, set
       * when the owed pre-delete snapshot was taken before the delete
       * failed: it no longer owes one, so a later attempt takes no second.
       */
      replacement?: SupersededResourceRecord;
    };

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
    /** `DeleteContext.maskStackSecretNames` (go-to-k/cdkd#6772). */
    maskStackSecretNames?: (text: string) => string;
    /** Set by `cdkd destroy` only (`DeleteContext.stackDestroy`). */
    stackDestroy?: boolean;
    /** An interrupt: stop waiting out an "in use" refusal. */
    stop: () => boolean;
    /** Send once, without waiting out an "in use" refusal (a deploy's carried retry). */
    once?: boolean;
    /**
     * go-to-k/cdkd#6463: the stack's region-pinned clients and a masked
     * logger, for an entry that still owes its pre-delete snapshot. Without
     * them such an entry fails, unsent.
     */
    preDeleteSnapshot?: {
      clients: PreDeleteSnapshotClients;
      logger: { info(message: string): void; debug(message: string): void };
    };
    /**
     * go-to-k/cdkd#6668: the provider of the entry's TYPE, for an entry
     * carrying `identity` (the routed `provider` of a Cloud Control record
     * reads no holder). Without it such an entry fails, unsent.
     */
    holderProvider?: () => Pick<ResourceProvider, 'replacedSurvivorIdentity'>;
    /** go-to-k/cdkd#6668: where an `identity` that cannot be compared is warned about. */
    warn?: (message: string) => void;
  }
): Promise<SupersededDeleteOutcome> {
  const record = entry.state;
  // go-to-k/cdkd#6668: before anything is sent (a snapshot included), the
  // holder of the name, when the deferral journaled its generation. Read
  // only for such an entry: an ordinary deploy or destroy reads nothing.
  if (Object.prototype.hasOwnProperty.call(entry, 'identity')) {
    const journaled: unknown = entry.identity;
    // A malformed value (a hand edit) or no reader compares with nothing, in
    // this run or any later one: warned, then the by-name delete below.
    const judged: HolderJudgement =
      typeof journaled !== 'string' || journaled === ''
        ? { incomparable: 'the recorded generation is malformed' }
        : input.holderProvider === undefined
          ? { incomparable: 'cdkd reads no holder for this resource type' }
          : await judgeJournaledHolder({
              provider: input.holderProvider,
              resourceType: record.resourceType,
              physicalId: record.physicalId,
              region: input.region,
              journaled,
              interrupted: input.stop,
            });
    if (judged === 'gone') return { kind: 'gone' };
    if (isUnreadHolder(judged)) {
      return {
        kind: 'failed',
        // No final period: callers append ". <remedy>".
        error: new CdkdError(
          `No delete was sent: ${unreadHolderCause(judged)}`,
          'SUPERSEDED_HOLDER_UNREAD'
        ),
      };
    }
    if (typeof judged === 'object' && 'incomparable' in judged) {
      input.warn?.(incomparableHolderNote(judged.incomparable));
    } else if (judged !== 'ours') {
      return { kind: 'notOurs', cause: notOursHolderCause(record.resourceType, judged.notOurs) };
    }
  }
  // go-to-k/cdkd#6463: a create-first replacement of a pre-delete-snapshot
  // type (an EBS volume, a Redshift cluster, an ElastiCache replication
  // group) records its owed snapshot as `finalSnapshotIdentifier`; no other
  // writer puts one on these types. The snapshot is taken here, as the
  // deferred delete would have, and the delete then carries no identifier.
  // The entry's own `skipFinalSnapshot` consent is the only one that counts.
  const owesSnapshot =
    entry.skipFinalSnapshot !== true &&
    entry.finalSnapshotIdentifier !== undefined &&
    PRE_DELETE_SNAPSHOT_TYPES.has(record.resourceType);
  if (owesSnapshot) {
    if (input.preDeleteSnapshot === undefined) {
      return {
        kind: 'failed',
        error: new CdkdError(
          `The final snapshot of ${entry.logicalId}'s superseded ${record.resourceType} ` +
            `could not be taken here. The resource was NOT deleted.`,
          'FINAL_SNAPSHOT_FAILED'
        ),
      };
    }
    // A Redshift snapshot can wait for an hour: none starts once stopped.
    if (input.stop()) {
      return {
        kind: 'failed',
        error: new CdkdError(
          `The run was interrupted before the final snapshot of ${entry.logicalId}'s ` +
            `superseded ${record.resourceType}. The resource was NOT deleted.`,
          'FINAL_SNAPSHOT_FAILED'
        ),
      };
    }
    try {
      // The copy is live: one AWS calls unsnapshottable (paused, modifying)
      // refuses, never deletes unsnapshotted.
      await createPreDeleteFinalSnapshot(
        record.resourceType,
        record.physicalId,
        entry.logicalId,
        input.preDeleteSnapshot.clients,
        input.preDeleteSnapshot.logger,
        {
          refuseUnsnapshottableState: true,
          // A snapshot started since the deferral: this delete's, resumed.
          reuseStartedAtOrAfter: Number.isFinite(entry.supersededAt)
            ? entry.supersededAt
            : Date.now(),
          stop: input.stop,
        }
      );
    } catch (error) {
      return { kind: 'failed', error };
    }
  }
  const { finalSnapshotIdentifier: _taken, ...snapshotTaken } = entry;
  const failed = (error: unknown): SupersededDeleteOutcome =>
    owesSnapshot
      ? { kind: 'failed', error, replacement: snapshotTaken }
      : { kind: 'failed', error };
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
          // A pre-delete-snapshot type's identifier is only the owed mark,
          // never the delete's (its Cloud Control delete refuses one), also
          // under the entry's own `skipFinalSnapshot` consent.
          ...(entry.finalSnapshotIdentifier !== undefined &&
            !PRE_DELETE_SNAPSHOT_TYPES.has(record.resourceType) && {
              finalSnapshotIdentifier: entry.finalSnapshotIdentifier,
            }),
          deletionPolicy: replacementDeletePolicy(entry.updateReplacePolicy),
          ...(entry.skipFinalSnapshot === true && { skipFinalSnapshot: true }),
          ...(input.removeProtection === true && { removeProtection: true }),
          ...(input.stackDestroy === true && { stackDestroy: true }),
          recordedAttributes: record.attributes,
          recordedCreateOnlyDrops: record.acceptedCreateOnlyDrops,
          recordedNoEchoLeaves: record.noEchoLeaves,
          // go-to-k/cdkd#6309: a custom resource's Delete payload types.
          recordedTypedPayloadLeaves: record.typedPayloadLeaves,
          maskSecrets: input.maskSecrets,
          ...(input.maskStackSecretNames !== undefined && {
            maskStackSecretNames: input.maskStackSecretNames,
          }),
        }
      );
    result = input.once === true ? await send() : await retryWhileInUse(send, input.stop);
  } catch (error) {
    return failed(error);
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
 * Whether `error` (or an error it wraps) is an "in use" refusal, or a bare
 * `ConflictException` (go-to-k/cdkd#6589): CloudWatch Logs refuses the delete
 * of a delivery source a delivery uses with one. Not Cloud Control's
 * `ResourceConflict` nor `ResourceConflictException`, which mean another
 * operation is in progress. Wider than {@link isInUseRefusal}, so only for
 * wording a hint, never for retrying.
 */
export function isInUseOrConflictRefusal(error: unknown): boolean {
  if (isInUseRefusal(error)) return true;
  for (let current: unknown = error, depth = 0; current !== undefined && depth < 8; depth++) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as { name?: unknown }).name === 'ConflictException') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Run `send` (one delete call), again while it fails with an "in use"
 * refusal, up to {@link supersededInUseRetry}; any other outcome is final.
 * A refusal marked non-retryable is final too, even when an "in use" AWS
 * error rides in its cause chain: the provider already waited it out (an Auto
 * Scaling group's scale-in, go-to-k/cdkd#6466), and repeating the attempt
 * would multiply that wait. `stop` ends the waiting early (an interrupt).
 */
export async function retryWhileInUse<T>(send: () => Promise<T>, stop: () => boolean): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (
        attempt >= supersededInUseRetry.attempts ||
        stop() ||
        !isInUseRefusal(error) ||
        isMarkedNonRetryable(error)
      ) {
        throw error;
      }
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
