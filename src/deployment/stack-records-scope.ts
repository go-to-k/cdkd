import { AsyncLocalStorage } from 'node:async_hooks';
import { shouldRetainResource, type ResourceState } from '../types/state.js';

/**
 * The state records of the stack whose provider call is in flight
 * (go-to-k/cdkd#4492), for a provider whose AWS object can be held by more
 * than one record of the same stack.
 *
 * Read today only by `AWS::EC2::SecurityGroupIngress`: two of its records
 * (or one plus an inline rule of an `AWS::EC2::SecurityGroup` record) can
 * describe the SAME AWS rule — CDK cannot dedupe a rule whose port is a token,
 * such as an Aurora cluster's `Endpoint.Port` beside an explicit `3306`. AWS
 * holds one rule for both, so a create answers `InvalidPermission.Duplicate`
 * for the second, and a delete of either revokes the rule the other needs.
 *
 * WHY AN ASYNC-LOCAL STORE rather than a `CreateContext` / `DeleteContext`
 * field: one provider reads it, on two arms, and the delete is reached from
 * over a dozen call sites; binding it once per operation keeps those sites
 * unchanged. ABSENT (a caller outside a deploy, destroy or rollback, such as
 * `cdkd drift --revert`) is "no other record known".
 */
export interface StackRecordsView {
  /**
   * The stack's records as they stand now, this operation's completed writes
   * included. Read when called: the bag grows and shrinks as the operation
   * runs.
   */
  readonly live: () => Iterable<readonly [string, ResourceState]>;
  /**
   * The records whose AWS resource outlives this operation: the live ones it
   * will not delete, plus any it drops from state but RETAINS in AWS. A
   * record another concurrent delete of the same operation is about to remove
   * is NOT a survivor, or two concurrent deletes of one shared rule would each
   * leave it for the other.
   */
  readonly survivors: () => Iterable<readonly [string, ResourceState]>;
  /**
   * The creates and updates of this operation still in flight, so a provider
   * whose write met its sibling's identical resource can wait for that
   * sibling to settle instead of refusing (two twins dispatched together).
   * Only a deploy has any.
   */
  readonly inFlight?: () => Iterable<InFlightWrite>;
  /** The logical ids of this view's writes now waiting on a sibling. */
  readonly waiting?: Set<string>;
}

/** A create or update the deploy has dispatched and not yet settled. */
export interface InFlightWrite {
  readonly logicalId: string;
  readonly resourceType: string;
  /** The resolved properties the write sends; `undefined` until resolved. */
  readonly properties: () => Record<string, unknown> | undefined;
  /**
   * `true` once the write completed and its record is in `live`, `false` once
   * it failed. Never rejects.
   */
  readonly settled: Promise<boolean>;
}

/**
 * Wait for `sibling` to settle on behalf of `self`, answering what it settled
 * to — or `undefined` without waiting when `sibling` is itself waiting (on
 * `self`, or on anything): two writes that both met an identical resource
 * neither made would otherwise wait on each other forever. The check and the
 * mark are one synchronous step, so of two such writes exactly one waits.
 */
export async function awaitInFlightSibling(
  view: StackRecordsView,
  self: string,
  sibling: InFlightWrite
): Promise<boolean | undefined> {
  const waiting = view.waiting;
  if (waiting === undefined || waiting.has(sibling.logicalId)) return undefined;
  waiting.add(self);
  try {
    return await sibling.settled;
  } finally {
    waiting.delete(self);
  }
}

const stackRecordsStore = new AsyncLocalStorage<StackRecordsView | undefined>();

/**
 * Bound by the deploy engine around a stack's provisioning, by the rollback
 * executor around a replay, and by the destroy runner around each delete.
 * Each binding REPLACES an outer one, so a nested child stack never reads its
 * parent's records.
 */
export function withStackRecords<T>(view: StackRecordsView | undefined, fn: () => T): T {
  return stackRecordsStore.run(view, fn);
}

/** The bound view, or `undefined` when none is. */
export function getStackRecords(): StackRecordsView | undefined {
  return stackRecordsStore.getStore();
}

/**
 * A deploy's view. `records` is the bag the engine provisions into; `deleting`
 * the logical ids its DELETE phase removes, whose concurrent deletes must not
 * count each other as survivors. A DELETE that retains its resource
 * (`DeletionPolicy: Retain`) drops the record but leaves the resource, so its
 * pre-deploy record (`before`) survives.
 *
 * `unsettled` names a record whose UPDATE is in flight: its resource may be
 * about to move away (or be revoked and re-made), so it is in NEITHER view
 * until its update completes — two concurrent updates moving off one shared
 * rule would otherwise each leave it to the other. A PENDING update is not
 * unsettled: its record still describes what AWS serves.
 */
export function deployStackRecordsView(
  records: Record<string, ResourceState>,
  before: Record<string, ResourceState>,
  deleting: ReadonlySet<string>,
  unsettled: (logicalId: string) => boolean = () => false,
  inFlight?: () => Iterable<InFlightWrite>
): StackRecordsView {
  const settled = (): Array<[string, ResourceState]> =>
    Object.entries(records).filter(([lid]) => !unsettled(lid));
  return {
    ...(inFlight && { inFlight, waiting: new Set<string>() }),
    live: settled,
    survivors: () => [
      ...settled().filter(([lid]) => !deleting.has(lid)),
      ...Object.entries(before).filter(
        ([lid, record]) => deleting.has(lid) && shouldRetainResource(record.deletionPolicy)
      ),
    ],
  };
}

/**
 * A destroy's view: every record is deleted, so only the retained ones
 * survive.
 */
export function destroyStackRecordsView(records: Record<string, ResourceState>): StackRecordsView {
  return {
    live: () => Object.entries(records),
    survivors: () =>
      Object.entries(records).filter(([, record]) => shouldRetainResource(record.deletionPolicy)),
  };
}

/**
 * A rollback replay's view. The replay runs one op at a time and removes a
 * record as it deletes its resource, so every live record survives the op in
 * flight: the last holder of a shared resource sees no other. A record the
 * replay drops but leaves in AWS — `DeletionPolicy: Retain`, or a logical id
 * passed to `--orphan` — survives too, from its record as the replay began.
 */
export function replayStackRecordsView(
  records: Record<string, ResourceState>,
  orphanLogicalIds: ReadonlySet<string> = new Set()
): StackRecordsView {
  // `=== 'Retain'`, not `shouldRetainResource`: the replay keeps a rolled-back
  // CREATE only under `Retain` (`rollback-executor/plan.ts`), deleting it under
  // `RetainExceptOnCreate`, while a deploy or destroy keeps both.
  const kept = Object.entries(records).filter(
    ([lid, record]) => record.deletionPolicy === 'Retain' || orphanLogicalIds.has(lid)
  );
  return {
    live: () => Object.entries(records),
    survivors: () => [
      ...Object.entries(records),
      ...kept.filter(([lid]) => !Object.hasOwn(records, lid)),
    ],
  };
}
