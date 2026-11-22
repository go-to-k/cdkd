import { AsyncLocalStorage } from 'node:async_hooks';
import { shouldRetainResource, type ResourceState } from '../types/state.js';

/**
 * The state records of the stack whose provider call is in flight
 * (go-to-k/cdkd#4492), for a provider that needs to know what other records
 * of the same stack hold.
 *
 * Read by:
 * - `AWS::EC2::SecurityGroupIngress` and `AWS::EC2::SecurityGroup`
 *   (`providers/ec2/sg-ingress-{create,update}.ts`, `security-group.ts`): two
 *   ingress records (or one plus an inline rule of a security group record)
 *   can describe the SAME AWS rule — CDK cannot dedupe a rule whose port is a
 *   token, such as an Aurora cluster's `Endpoint.Port` beside an explicit
 *   `3306`. AWS holds one rule for both, so a create answers
 *   `InvalidPermission.Duplicate` for the second, and a delete of either
 *   revokes the rule the other needs.
 * - `AWS::S3::BucketPolicy` (`s3-bucket-policy-helpers.ts`,
 *   `providers/s3-bucket-policy-provider.ts`): another record holding the same
 *   bucket's policy (go-to-k/cdkd#6109), and the same-stack OAI records its
 *   live-policy comparison normalizes principals against.
 * - `AWS::IAM::Policy` (`providers/iam-policy/principal-identity.ts`): the
 *   recorded identity id of each in-stack principal the inline policy names,
 *   compared before the policy is removed from it by name (go-to-k/cdkd#6655),
 *   or put on it by name (go-to-k/cdkd#6722, where a deploy's
 *   `writtenFreshThisRun` spares the read of a principal this deploy created
 *   or replaced). The
 *   `AWS::IAM::ManagedPolicy` provider asks the same of the principals it
 *   attaches to or detaches from (go-to-k/cdkd#6722). These are the only
 *   readers a `cdkd drift --revert` reaches (go-to-k/cdkd#6734).
 * - `AWS::IAM::Role` / `AWS::IAM::Group` deletes that may strip their holders
 *   (`stack-own-holders.ts`, go-to-k/cdkd#6808): the stack's own instance
 *   profiles and member users, the only holders they remove.
 *
 * WHY AN ASYNC-LOCAL STORE rather than a `CreateContext` / `DeleteContext`
 * field: few providers read it, and the delete is reached from
 * over a dozen call sites; binding it once per operation keeps those sites
 * unchanged. ABSENT (a caller outside a deploy, destroy, rollback or drift
 * revert) is "no other record known". `cdkd drift --revert` binds a view of
 * its IAM principal records alone ({@link revertStackRecordsView}).
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
  /**
   * Whether THIS operation's own create of `logicalId`, or an update of it
   * that answered `wasReplaced`, succeeded (go-to-k/cdkd#6722): its record's
   * AWS-minted id is the one that create answered. Known from what the
   * engine dispatched, never inferred from the record's ids. Only a deploy
   * knows it: a destroy, a rollback replay and a drift revert leave it unset,
   * and their readers treat every record as written before them.
   */
  readonly writtenFreshThisRun?: (logicalId: string) => boolean;
  /**
   * The object one run's views share, keying the run's
   * {@link verifiedIdentityCache}: a destroy's, a replay's and a drift
   * revert's records bag (their per-call views share it), a deploy's own fresh object (built once
   * per run, and distinct from the bag its auto-rollback replays over). A
   * view without one caches nothing.
   */
  readonly runKey?: object;
  /**
   * The writes of the journal a rollback replays that no record may hold
   * (go-to-k/cdkd#6808): its failed ops, each with the properties it
   * attempted. What they name is the rolled-back run's, so a rollback delete
   * of a role or group strips the holders they add, as it does those a record
   * names (`stack-own-holders.ts`). Only a replay has any.
   */
  readonly journaledWrites?: () => Iterable<JournaledWrite>;
}

/** A write a replayed journal names ({@link StackRecordsView.journaledWrites}). */
export interface JournaledWrite {
  readonly resourceType: string;
  readonly physicalId?: string | undefined;
  readonly properties?: Readonly<Record<string, unknown>> | undefined;
  readonly attributes?: Readonly<Record<string, unknown>> | undefined;
}

const verifiedIdentityCaches = new WeakMap<object, Map<string, Promise<void>>>();

/**
 * go-to-k/cdkd#6722: the identity compares that MATCHED during the run `view`
 * belongs to, by a key naming the principal and its recorded ids, so each
 * in-stack principal is read at most once per deploy, destroy or rollback
 * replay. Only a match stays: a caller deletes an entry whose compare
 * rejected (a mismatch, an unreadable or denied read), so the next attempt
 * reads again; callers racing on one principal share its in-flight compare.
 * Keyed by the run's records bag ({@link StackRecordsView.runKey}): a new run
 * (a new bag) starts empty, and a nested stack's own bag has its own.
 */
export function verifiedIdentityCache(
  view: StackRecordsView | undefined
): Map<string, Promise<void>> | undefined {
  const key = view?.runKey;
  if (key === undefined) return undefined;
  let cache = verifiedIdentityCaches.get(key);
  if (cache === undefined) {
    cache = new Map();
    verifiedIdentityCaches.set(key, cache);
  }
  return cache;
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
  inFlight?: () => Iterable<InFlightWrite>,
  writtenFresh?: (logicalId: string) => boolean
): StackRecordsView {
  const settled = (): Array<[string, ResourceState]> =>
    Object.entries(records).filter(([lid]) => !unsettled(lid));
  return {
    ...(inFlight && { inFlight, waiting: new Set<string>() }),
    ...(writtenFresh && { writtenFreshThisRun: writtenFresh }),
    // Its own key, not the bag: the deploy's auto-rollback replays over the
    // SAME bag, and must not inherit the deploy's matches (it re-reads).
    runKey: {},
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
    runKey: records,
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
  orphanLogicalIds: ReadonlySet<string> = new Set(),
  /** The replayed journal's failed ops ({@link StackRecordsView.journaledWrites}). */
  failedOps: ReadonlyArray<{
    resourceType: string;
    physicalId?: string | undefined;
    attemptedProperties?: Record<string, unknown> | undefined;
  }> = []
): StackRecordsView {
  // `=== 'Retain'`, not `shouldRetainResource`: the replay keeps a rolled-back
  // CREATE only under `Retain` (`rollback-executor/plan.ts`), deleting it under
  // `RetainExceptOnCreate`, while a deploy or destroy keeps both.
  const kept = Object.entries(records).filter(
    ([lid, record]) => record.deletionPolicy === 'Retain' || orphanLogicalIds.has(lid)
  );
  return {
    runKey: records,
    live: () => Object.entries(records),
    survivors: () => [
      ...Object.entries(records),
      ...kept.filter(([lid]) => !Object.hasOwn(records, lid)),
    ],
    journaledWrites: () =>
      failedOps.map((op) => ({
        resourceType: op.resourceType,
        physicalId: op.physicalId,
        properties: op.attemptedProperties,
      })),
  };
}

/**
 * The record types a drift revert's view holds (go-to-k/cdkd#6734): the IAM
 * principals an `AWS::IAM::Policy` / `AWS::IAM::ManagedPolicy` update reads
 * and compares by recorded id before it puts, attaches, removes or detaches
 * its policy by name.
 */
export const REVERT_VIEW_RECORD_TYPES: ReadonlySet<string> = new Set([
  'AWS::IAM::Role',
  'AWS::IAM::Group',
  'AWS::IAM::User',
]);

/**
 * A `cdkd drift --revert` view over `records`, the stack's state as the
 * revert read it (go-to-k/cdkd#6734). Without one, an IAM policy's revert
 * saw every principal as outside the stack and put its policy on, or removed
 * it from, whoever holds the name.
 *
 * It holds the {@link REVERT_VIEW_RECORD_TYPES} records ALONE, so the IAM
 * principal compare is the only reader that sees anything. The others keep
 * their unbound behavior on a revert: the security group ingress and inline
 * rule holders would otherwise skip a description or rule a revert changes
 * today (the revert passes the group its own `siblingSgRuleIds` instead,
 * go-to-k/cdkd#6641), and the S3 bucket policy readers run on a create only,
 * which a revert never sends.
 *
 * Nothing is written fresh by a revert (`writtenFreshThisRun` unset), so each
 * in-stack principal with a recorded id is read; once per revert run, as the
 * records bag keys the run's {@link verifiedIdentityCache}. Nothing is
 * deleted, so every record survives.
 */
export function revertStackRecordsView(records: Record<string, ResourceState>): StackRecordsView {
  const principals = (): Array<[string, ResourceState]> =>
    Object.entries(records).filter(([, record]) =>
      REVERT_VIEW_RECORD_TYPES.has(record.resourceType)
    );
  return { runKey: records, live: principals, survivors: principals };
}
