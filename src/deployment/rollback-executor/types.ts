import type { DeploymentEvent } from '../../types/deployment-events.js';
import type { ResourceState, StackOrphanRecord } from '../../types/state.js';
import type { Logger } from '../../types/config.js';
import type { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { type PreDeleteSnapshotClients } from '../../provisioning/final-snapshot.js';
import { type RecordedSecretValues } from '../secret-redaction.js';

/**
 * Completed operation record for rollback tracking. Pushed by the deploy
 * engine in completion order, only after the operation succeeded, and
 * serialized verbatim into the rollback journal (issue #1183). Because
 * `ResourceState.properties` are post-intrinsic resolved values, replay
 * needs neither the template nor a synth.
 */
export interface CompletedOperation {
  /** Logical ID of the resource */
  logicalId: string;
  /** Type of change that was applied */
  changeType: 'CREATE' | 'UPDATE' | 'DELETE';
  /** Resource type (e.g., "AWS::S3::Bucket") */
  resourceType: string;
  /**
   * Provisioning layer the resource ran on. Load-bearing for rollback
   * dispatch — a CC-routed CREATE must roll back via the CC provider's
   * delete, NOT the SDK provider's (#614). Populated from the routing
   * decision (CREATE) or from the previous state (UPDATE / DELETE).
   * `undefined` falls back to legacy SDK semantics for legacy state.
   */
  provisionedBy?: 'sdk' | 'cc-api' | undefined;
  /** Previous resource state (for UPDATE rollback) */
  previousState?: ResourceState | undefined;
  /** Physical ID of newly created resource (for CREATE rollback) */
  physicalId?: string | undefined;
  /** Properties used for creation (for CREATE rollback / delete) */
  properties?: Record<string, unknown> | undefined;
  /**
   * Whether the deploy deliberately left the OLD physical resource alive
   * (`UpdateReplacePolicy: Retain`) instead of deleting it on a replacement
   * (issue [#2603](https://github.com/go-to-k/cdkd/issues/2603)).
   *
   * Stamped on EVERY completed UPDATE, not only a replacement: a plain
   * in-place update records `false`, which is both true and inert, because the
   * only reader is {@link classifyRollbackOp}'s replacement arm. Recording it
   * unconditionally is what keeps ABSENT meaning "written by a binary that
   * predates this field" and nothing else.
   *
   * The verdict the engine ACTED ON, recorded at the moment it acted, rather
   * than something {@link classifyRollbackOp} re-derives. The engine reads
   * `UpdateReplacePolicy` from the TEMPLATE being applied ("what is the user
   * applying now?"); the classifier used to read it from
   * `previousState.updateReplacePolicy` ("what did the last deploy record?"),
   * and those two answers differ on precisely the deploy that CHANGES the
   * attribute — in both directions, and the second is the worse one:
   *
   *   - ADDING `Retain`: old resource orphaned, previous state carries no
   *     policy → the classifier picked `reverse-replacement` and re-CREATED a
   *     resource that was still alive.
   *   - DROPPING `Retain`: old resource correctly deleted, previous state
   *     still carries `Retain` → the classifier picked
   *     `reverse-replacement-readopt` and pointed state at a physical id that
   *     no longer exists, with no re-create and nothing downstream to notice.
   *
   * ADDITIVE field, no `journalVersion` bump — same precedent as
   * `RollbackJournalSegment.failedOperations`. `undefined` means a journal
   * written by a pre-#2603 binary, where the old previous-state read is the
   * only information available and stays the fallback; every op a current
   * binary writes carries an explicit `true` / `false`, so the fallback is
   * unreachable for them.
   *
   * Set only for a DELIBERATE retention. A cleanup delete that failed, was
   * skipped, or was blocked by a failed final snapshot also leaves the old
   * resource alive, but the deploy cannot vouch for that — those record
   * `false` and keep the re-create behaviour (issue
   * [#2631](https://github.com/go-to-k/cdkd/issues/2631)).
   */
  oldResourceRetained?: boolean | undefined;
  /**
   * The type of the resource that existed BEFORE this UPDATE — the state
   * record's `resourceType` (issue
   * [#2668](https://github.com/go-to-k/cdkd/issues/2668)).
   *
   * {@link resourceType} is the TEMPLATE's type, so on a `Type` change it names
   * only the NEW resource. A replacement has two halves with two types: the
   * replay re-creates the OLD resource through THIS type's provider and deletes
   * the new one through {@link resourceType}'s. Read through
   * {@link resolveReplacementOldType}, never directly.
   *
   * ADDITIVE, no `journalVersion` bump — same precedent as
   * {@link oldResourceRetained}: an older binary ignores it, and an ABSENT
   * value means a journal written before this field, for which
   * `previousState.resourceType` (the same value, journaled all along inside
   * the previous record) is the fallback.
   */
  previousResourceType?: string | undefined;
  /**
   * go-to-k/cdkd#4615: the provider's `wasReplaced` answer for an UPDATE that
   * ran through its `update()`. `false` means the resource was updated in
   * place even if its physical id changed (an SQS QueuePolicy's id is its
   * first queue, an SNS TopicPolicy's its topic list), so the rollback reverts
   * it in place. Absent (a replacement arm, or an older binary's journal):
   * a changed physical id still reads as a replacement.
   */
  wasReplaced?: boolean | undefined;
}

/**
 * Record of the resource operation that FAILED mid-deploy (issue #1198).
 * At most a handful per journal segment (usually one — the op whose failure
 * stopped the deploy; concurrent siblings can add more). Unlike a
 * {@link CompletedOperation}, the operation did NOT complete, so the remote
 * state of the resource is unknown — reverting it is opt-in
 * (`cdkd rollback --revert-failed`).
 */
export interface FailedOperation {
  /** Logical ID of the resource */
  logicalId: string;
  /** Type of change that was being applied when it failed */
  changeType: 'CREATE' | 'UPDATE' | 'DELETE';
  /** Resource type (e.g., "AWS::S3::Bucket") */
  resourceType: string;
  /** Provisioning layer the op was routed through (see CompletedOperation). */
  provisionedBy?: 'sdk' | 'cc-api' | undefined;
  /** Pre-op resource state (UPDATE / DELETE; undefined for CREATE). */
  previousState?: ResourceState | undefined;
  /**
   * Physical ID at op start, if one was known. Undefined for an ordinary
   * failed CREATE; set on one whose provider proved its create call had
   * returned before the failure ({@link physicalIdRecoveredFromError}).
   */
  physicalId?: string | undefined;
  /**
   * `true` when {@link physicalId} is the resource a failed CREATE made
   * before it failed, proved by the provider's `markCreatedBeforeFailure`
   * (go-to-k/cdkd#1710). No state record holds that resource, so it is what
   * separates "delete the orphan" from #1198's "a previous `--revert-failed`
   * already removed it": both are a physical id with no state record. Absent
   * on a journal an older binary wrote, which keeps the skip. `false` is
   * `demoteSupersededOrphans`'s verdict that later activity may own the
   * resource: skipped with a warning, never deleted.
   */
  physicalIdRecoveredFromError?: boolean | undefined;
  /**
   * The template's `DeletionPolicy`, journaled with
   * {@link physicalIdRecoveredFromError} (go-to-k/cdkd#1710): the orphan has
   * no state record to read the policy off, and a plain delete would destroy
   * what `Retain` / `Snapshot` promised to keep.
   */
  deletionPolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;
  /**
   * go-to-k/cdkd#4604: set, with {@link replacedResourceType}, on a proven
   * orphan journaled beside a failed replacement UPDATE — the NEW resource the
   * replacement's create made before failing. The state record under the same
   * logical id is the resource that replacement was replacing; while it still
   * names this physical id and type it is not a later owner of the orphan, so
   * the classifier does not read it as a mismatch, and no arm acting on the
   * orphan touches that record.
   */
  replacedPhysicalId?: string | undefined;
  /** The type of the record {@link replacedPhysicalId} names. */
  replacedResourceType?: string | undefined;
  /**
   * `true` when the replacement deleted the resource {@link replacedPhysicalId}
   * names (or found it gone) before its create ran: the record names a
   * resource that no longer exists, which the failed UPDATE's rollback warns
   * about instead of settling as a no-op.
   */
  replacedResourceDeleted?: boolean | undefined;
  /**
   * go-to-k/cdkd#4604, on a failed replacement UPDATE: its create made the new
   * resource, journaled beside it as a replacement orphan, so this op applied
   * nothing to the record it names (`create-first`: the old resource is
   * untouched; `delete-first`: the replacement removed it). Read without the
   * orphan's entry, which an interrupted rollback can settle alone.
   */
  replacementOrphaned?: 'create-first' | 'delete-first' | undefined;
  /**
   * The intrinsic-RESOLVED desired properties the failed op attempted to
   * apply, if resolution got that far. Load-bearing for the revert: a
   * Cloud-Control-routed revert patches previous-vs-attempted, so without
   * this the patch would be empty and the revert a no-op.
   */
  attemptedProperties?: Record<string, unknown> | undefined;
}

/** Collaborators the executor needs (no synth-side dependencies). */
export interface RollbackExecutorContext {
  providerRegistry: ProviderRegistry;
  /** Region the resources live in — threaded into each provider delete. */
  region: string;
  logger: Logger;
  /**
   * Optional structured-event sink. The command wires a
   * `DeploymentEventsStore`; the in-process engine forwards its own
   * best-effort recorder. `undefined` disables event emission.
   */
  recordEvent?: (event: Omit<DeploymentEvent, 'timestamp'>) => void;
  /**
   * Region-pinned AWS clients for the `PRE_DELETE_SNAPSHOT_TYPES` snapshot
   * calls a `DeletionPolicy: Snapshot` CREATE rollback makes (issue #1358).
   * Structurally satisfied by `AwsClients`. Absent falls back to the
   * `getAwsClients()` process-global — see
   * {@link prepareCreateRollbackFinalSnapshot} for why pinning matters.
   */
  finalSnapshotClients?: PreDeleteSnapshotClients | undefined;
  /**
   * `--skip-final-snapshot`: delete a `DeletionPolicy: Snapshot` rolled-back
   * CREATE WITHOUT its final snapshot (explicit data-loss opt-out). Mirrors
   * `DeployEngineOptions.skipFinalSnapshot`.
   */
  skipFinalSnapshot?: boolean | undefined;
  /**
   * The PRODUCER regions this stack's persisted cross-stack reads name --
   * `StackState.imports[].sourceRegion` plus `StackState.outputReads[].sourceRegion`,
   * as produced by {@link producerRegionsFromState} (issue
   * [#2057](https://github.com/go-to-k/cdkd/issues/2057)).
   *
   * Read ONLY by {@link classifyReplaySecretRegion}, and only to answer one
   * question: could a region-LESS `{{resolve:...}}` expression in a replayed bag
   * have come from a region other than {@link RollbackExecutorContext.region}?
   * Since #1934 a cross-stack consumer resolves a redacted secret expression in
   * the PRODUCER's region and then records the PRODUCER's spelling into its own
   * state -- and that spelling carries no region. The replay here rebuilds its
   * resolver from `region` alone, so without this list it re-resolves the
   * producer's expression against the consumer's region and writes whatever a
   * same-named secret holds THERE onto a live resource.
   *
   * A list rather than a boolean because the refusal message has to NAME the
   * regions the user must reconcile; empty / absent means "no cross-stack read
   * on record", which is the overwhelmingly common case and leaves the replay
   * behaviourally unchanged.
   *
   * BOTH CALLERS PASS IT, and how each derives it differs in a way that
   * matters:
   *
   *  - `cdkd rollback` (`src/cli/commands/rollback.ts`) passes
   *    `producerRegionsFromState(baseState)` — whatever the last save
   *    persisted.
   *  - `DeployEngine.rollbackExecutorContext(previousState, stackName)` passes the UNION
   *    of the pre-deploy snapshot and THIS session's `recordedImports` /
   *    `recordedOutputReads` (`crossStackReadsForPartialSave`). That union is
   *    not belt-and-braces: a rollback journal exists only after a FAILED
   *    deploy, and until the same review round fixed it every non-success save
   *    persisted the PRE-deploy snapshot alone — so the cross-region read a
   *    failing deploy INTRODUCED was never on record, this list came back
   *    empty, and the refusal was inert on precisely the deploy that needs it.
   *
   * The ARN-named arm needs no list at all and is live regardless of either.
   */
  importedProducerRegions?: readonly string[] | undefined;
  /**
   * `true` when {@link importedProducerRegions} may be MISSING regions: this
   * replay is a nested child's, and its parent's producer regions could not be
   * established (go-to-k/cdkd#4174). A child receives a parent's cross-region
   * value only as a Parameter and records the parent's region-less spelling,
   * which its own reads do not explain, so every region-less secret reference
   * is refused rather than resolved in {@link region}.
   */
  producerRegionsIncomplete?: boolean | undefined;
  /**
   * True when this replay reverts a nested CHILD for its parent's rollback
   * (`revertNestedChildFromJournal`). `cdkd rollback --orphan` reaches only the
   * replay of the stack it is run on, and a direct rollback of the child is
   * refused while the parent's run is unsettled, so no command reaches this
   * replay's ops: the three refusals print no `--orphan` line here
   * (go-to-k/cdkd#3845).
   */
  nestedChildRevert?: boolean | undefined;
  /**
   * The nested child's stack name (`<parent>~<id>`) when this replay is that
   * child engine's OWN in-process rollback inside its parent's deploy. Its
   * segment stays in the child's journal, and only a rollback of the child
   * honours `--orphan` for its ops (the parent's replays it only through
   * `--revert-failed`, as a child revert `--orphan` does not reach), so the
   * three refusals' `--orphan` command names the child stack
   * (go-to-k/cdkd#3859).
   */
  nestedChildStack?: string | undefined;
  /**
   * The deploy's own bag for a logical id, supplied only by the IN-PROCESS
   * rollback (`DeployEngine`), read for its LOG-ONLY needles alone
   * (go-to-k/cdkd#1998): a `NoEcho` parameter's value the failed deploy
   * consumed. The replay re-resolves a journal that holds no parameter to
   * `Ref`, so without this a provider revert line, a thrown message or a
   * rollback event quoting the value would print it. Its map entries are NOT
   * copied: the op's own re-resolution is what positions the redaction.
   */
  logOnlyNeedlesFor?: ((logicalId: string) => RecordedSecretValues | undefined) | undefined;
}

/** The action the planner / replayer decided for a single op. */
export type RollbackActionKind =
  | 'delete' // CREATE rollback → delete the resource
  | 'delete-with-final-snapshot' // CREATE rollback → snapshot, then delete (DeletionPolicy Snapshot)
  | 'orphan-retain' // CREATE rollback → orphan (DeletionPolicy Retain)
  | 'orphan-flag' // op skipped by --orphan; leaves resource, updates state
  | 'revert' // UPDATE rollback → restore previous properties
  | 'reverse-replacement' // replacement rollback → re-create old, delete new (#1199)
  | 'reverse-replacement-readopt' // replacement w/ Retain'd old → delete new, re-adopt old (#1199)
  | 'skip-already-done' // idempotent skip (already reverted / already gone)
  | 'skip-mismatch' // CREATE physical id changed by a later attempt
  | 'skip-absent' // UPDATE target no longer in state
  | 'refuse-replacement-routing' // replacement whose OLD type cannot be routed — op fails, segment kept (#2668)
  | 'unrecoverable-delete'; // DELETE cannot be restored

/** The action decided for a FAILED in-flight op (issue #1198, --revert-failed). */
export type FailedOpActionKind =
  | 'revert-failed-update' // force-apply previousState over the half-applied update
  | 'delete-failed-create' // a partially-recorded CREATE → delete it
  | 'delete-failed-create-with-final-snapshot' // ↑ under DeletionPolicy Snapshot (#1362)
  | 'orphan-failed-create-retain' // ↑ under DeletionPolicy Retain → leave in AWS (#1362)
  | 'skip-failed-unknown' // failed CREATE with nothing recorded — cannot act
  | 'skip-failed-noop' // failed DELETE (resource still in place) / already handled
  | 'skip-failed-replaced-deleted' // failed replacement UPDATE whose delete-first removed the old resource (#4604) — warned
  | 'skip-failed-superseded' // proven failed-CREATE orphan later activity may own (#1710) — warned, nothing deleted
  | 'skip-failed-mismatch' // failed CREATE whose recorded physical id state no longer names — warned, nothing deleted (go-to-k/cdkd#4552)
  | 'skip-failed-absent' // failed UPDATE with no previousState / not in state
  | 'skip-failed-type-change'; // failed UPDATE that was a Type change — no in-place revert exists (#2668)

/**
 * The routing layer a planned op resolves to — the state record's, falling
 * back to the journaled op's (see {@link effectiveProvisionedBy}). Stamped
 * onto the plan so the preview can consult the SAME mechanism matrix the
 * replay will (issue #1366); without it the label could only see the
 * journaled value and would describe a route the delete may not take.
 */
type PlannedRoute = {
  /** Required (not optional): a plan item that forgot to resolve the route
   * would silently label a cc-api-routed atomic type as snapshottable — the
   * exact defect #1366 fixes. `undefined` is a legitimate VALUE (legacy state
   * with no routing on either side), so it must be passed explicitly. */
  effectiveProvisionedBy: 'sdk' | 'cc-api' | undefined;
};

/** One planned failed-op revert (rendered by the command's plan preview). */
export interface FailedOpPlanItem extends PlannedRoute {
  op: FailedOperation;
  action: FailedOpActionKind;
}

/** One planned rollback action (rendered by the command's plan preview). */
export interface RollbackPlanItem extends PlannedRoute {
  op: CompletedOperation;
  action: RollbackActionKind;
  /** For a replacement op (previousState.physicalId !== op.physicalId). */
  replacement: boolean;
  /**
   * The replacement's NEW physical resource declares `UpdateReplacePolicy:
   * Retain`, so the replay will NOT delete it (issue
   * [#2598](https://github.com/go-to-k/cdkd/issues/2598)).
   *
   * Threaded onto the plan item for the same reason `effectiveProvisionedBy`
   * is: the preview is the one thing the user reads before confirming, and
   * both `reverse-replacement` labels say "delete new" unconditionally. A
   * label promising a delete the replay is about to skip is the issue #1366
   * class one layer over — there it was a promised final snapshot, here it is
   * a promised deletion, and the direction that matters is the same (the
   * preview must not describe an outcome the run will not produce).
   *
   * Always present on a replacement item; `false` everywhere else, including
   * for CREATE ops whose own retention is `DeletionPolicy` and already shows
   * as `orphan-retain`.
   */
  retainsNewResource: boolean;
}

/**
 * Outcome of {@link replayFailedOperations}: the shared counters plus the
 * failed ops that are STILL pending (revert threw, or unprocessed due to an
 * interrupt). The command persists this list back onto the journal segment
 * so a re-run only re-attempts what is genuinely outstanding — a
 * successfully-reverted op must never be re-issued (its attempted-properties
 * diff side would patch-undo changes that no longer exist).
 */
export interface FailedOpReplayResult extends RollbackReplayResult {
  remainingFailedOps: FailedOperation[];
}

/** Outcome of replaying a list of ops (one journal segment). */
export interface RollbackReplayResult {
  /** Provider delete/update threw (best-effort caught). Blocks segment pop. */
  failures: number;
  /**
   * Outcomes that carry a warning: the skips counted in {@link skipped}, plus
   * a reverted op that left a survivor (a retained or undeletable new copy).
   * Do NOT block segment pop, but map to exit 2.
   */
  warnings: number;
  /**
   * The ops the replay DECLINED and left exactly as the failed deploy left
   * them (physical-id mismatch, absent record or baseline, unrecoverable
   * DELETE), each also counted in {@link warnings} and recorded as a
   * `ROLLBACK_RESOURCE_SKIPPED` event (go-to-k/cdkd#3338). The automatic
   * rollback keeps its journal segment when this is non-zero: dropping it
   * would delete the record of an op that was never reverted.
   */
  skipped: number;
  interrupted: boolean;
  /**
   * Resources this replay left in AWS under `DeletionPolicy: Retain` and
   * dropped from state (issue #2934), each carrying the `ResourceState` that
   * was discarded.
   *
   * Returned rather than written here because this module owns no state
   * backend: BOTH callers — the engine's automatic rollback and the standalone
   * `cdkd rollback` — persist it onto {@link StackState.orphans} themselves.
   * The next deploy re-adopts the resource instead of colliding with the
   * deterministic name it still holds.
   *
   * Always an array, never `undefined`, so a caller cannot silently skip the
   * persist by reading a missing field as "nothing to do".
   */
  orphaned: StackOrphanRecord[];
}

/** Spelled locally: importing the CLI's copy would invert the layer direction. */
export const NESTED_STACK_RESOURCE_TYPE = 'AWS::CloudFormation::Stack';

export const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * The op fields the old-type readers below need. A `FailedOperation` satisfies it
 * through `previousState` alone: it carries no `previousResourceType`.
 */
export type OldTypeSources = Pick<
  CompletedOperation,
  'resourceType' | 'previousResourceType' | 'previousState'
>;
