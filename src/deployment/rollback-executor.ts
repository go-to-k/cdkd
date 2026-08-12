/**
 * Rollback executor (issue #1183).
 *
 * The reusable engine that reverts a list of {@link CompletedOperation}s —
 * extracted from `DeployEngine` so BOTH callers drive identical semantics:
 *
 * - `DeployEngine` runs it in-process after a failed deploy (automatic
 *   rollback, unchanged behavior except the two fixes below).
 * - The standalone `cdkd rollback` command runs it against a persisted
 *   rollback journal (issue #1183 §journal), so a `--no-rollback` /
 *   interrupted / partially-failed-auto-rollback deploy can be reverted
 *   later.
 *
 * The executor deliberately depends only on `ProviderRegistry`, the stack
 * region, a logger, and an optional event recorder + per-op state-save
 * hook. It does NOT touch `DagBuilder` / `DiffCalculator` / the synthesizer
 * / `ExportIndexStore`, so the command can construct it without any of the
 * engine's synth-side collaborators (rollback never publishes
 * outputs/exports).
 *
 * Two deliberate behavior fixes vs. the pre-extraction in-process path
 * (both are pre-existing gaps; fixing them once benefits both callers):
 *
 * 1. **DeletionPolicy on CREATE rollback** — rolling a CREATE back IS a
 *    delete as far as the policy is concerned (CloudFormation semantics), so
 *    the CURRENT state record's `DeletionPolicy` decides what happens:
 *    - `Retain` → ORPHANED (removed from state, left in AWS). The policy
 *      says KEEP the resource, so cdkd does.
 *    - `Snapshot` → final snapshot, THEN delete (issue #1358), through the
 *      same mechanism matrix as the deploy engine's
 *      `prepareFinalSnapshotForDelete`: atomic delete parameter for the
 *      SDK-routed `ATOMIC_FINAL_SNAPSHOT_TYPES`, an explicit pre-delete
 *      snapshot for `PRE_DELETE_SNAPSHOT_TYPES`, refusal for every other
 *      Snapshot shape (cc-api routing included) unless
 *      `--skip-final-snapshot` opts into the data loss. This arm ORPHANED
 *      alongside `Retain` until #1358: when this file was written cdkd could
 *      not create a final snapshot at all, so leaving the resource behind
 *      was the only non-destructive option — but it silently handed the user
 *      an untracked, billing resource that state no longer knew about.
 *      `src/provisioning/final-snapshot.ts` (#1352 / #1353) removed the
 *      constraint, so the policy is now honored literally.
 *    - `RetainExceptOnCreate` (which exists precisely to allow cleanup of
 *      failed creates) and absent / `Delete` → DELETE.
 * 2. **Idempotent replay skip rules** — so a partially-failed rollback can
 *    be re-run safely (also harmless for the in-process caller, which
 *    replays each op exactly once).
 */

import type { DeploymentEvent } from '../types/deployment-events.js';
import { extractDeploymentEventError } from '../types/deployment-events.js';
import type { ResourceState } from '../types/state.js';
import type {
  CreateContext,
  ResourceCreateResult,
  ResourceProvider,
  ResourceUpdateResult,
} from '../types/resource.js';
import type { Logger } from '../types/config.js';
import type { ProviderRegistry } from '../provisioning/provider-registry.js';
import { STATEFUL_TYPES } from '../provisioning/stateful-types.js';
import {
  ATOMIC_FINAL_SNAPSHOT_TYPES,
  buildFinalSnapshotIdentifier,
  ccRoutedFinalSnapshotError,
  createPreDeleteFinalSnapshot,
  finalSnapshotMechanism,
  unsupportedFinalSnapshotError,
  type PreDeleteSnapshotClients,
} from '../provisioning/final-snapshot.js';
import { getAwsClients } from '../utils/aws-clients.js';
import { withRetry } from './retry.js';
import {
  isNameCollisionError,
  isNameCooldownError,
  isRecreateRetryableError,
} from './retryable-errors.js';

/** The `--skip-final-snapshot` flag name cited by every refusal below. */
const SKIP_FINAL_SNAPSHOT_FLAG = '--skip-final-snapshot';

/**
 * The {@link CreateContext} every reverse-replacement re-create passes
 * (issue #1463). Both arms of that path — the create-first attempt and the
 * delete-new-first retry — revive the OLD resource from
 * `previousState.properties`, i.e. from a cdkd STATE record rather than the
 * template, so a provider pre-flight refusal has no template-side remedy and
 * must downgrade to a warning. Declared once so the two arms cannot drift.
 *
 * These are the only create call sites that can DECLARE a replay. The deploy
 * engine's five sites (CREATE, the property-driven replacement, the
 * `--recreate-via-*` destroy-then-create, the `--replace` delete-first
 * fallback, and the update-failure replacement) are all driven by freshly
 * resolved TEMPLATE properties, so they deliberately pass no context and the
 * refusal stands where the user can edit the input.
 *
 * The remaining call sites are the providers that re-create inside their own
 * `update()` (`this.create(...)` in ACM certificate / IAM managed policy / IAM
 * role / Lambda permission / SNS subscription). Those are NOT template-driven
 * — this executor's `revert` arm calls `provider.update(...)` with
 * `previousState.properties`, so they forward a STATE record on a replay — but
 * they CANNOT receive a context, because `update()` has no context parameter.
 * The constraint that follows is on providers, not on this constant: a
 * provider with a create-side pre-flight refusal must not re-create inside
 * `update()`. See `CreateContext` in `src/types/resource.ts`.
 */
const REPLAYING_STATE_CREATE_CONTEXT: CreateContext = { replayingState: true };

/**
 * Which provisioning layer a delete must be judged against: the CURRENT
 * state record wins (it is what state says AWS holds right now), with the
 * journaled op's routing as the legacy-state fallback. Shared by both
 * Snapshot paths below so the cc-api test cannot drift between them.
 */
function effectiveProvisionedBy(
  record: Pick<ResourceState, 'provisionedBy'> | undefined,
  fallbackProvisionedBy?: 'sdk' | 'cc-api'
): 'sdk' | 'cc-api' | undefined {
  return record?.provisionedBy ?? fallbackProvisionedBy;
}

/**
 * `UpdateReplacePolicy: Snapshot` on a rollback's delete-of-the-NEW-resource
 * (issue #1354): honor it where it costs nothing — an atomic-final-snapshot
 * type on the SDK route gets a generated identifier threaded into the delete
 * context. Every other Snapshot shape (pre-delete types, cc-api routing)
 * keeps the plain delete DELIBERATELY: the rollback executor's delete-new is
 * load-bearing for same-name re-creation (refusing it would strand the
 * revert half-done), and the new resource was created by the very deploy
 * being reverted. Recorded as a scope decision on issue #1354.
 *
 * NOT the same call as the rolled-back-CREATE path
 * ({@link prepareCreateRollbackFinalSnapshot}, issue #1358): there the
 * resource is being deleted under `DeletionPolicy` and a shape cdkd cannot
 * snapshot is REFUSED rather than plain-deleted, because the user is losing
 * a resource that existed before this op — nothing downstream depends on
 * that delete succeeding.
 */
export function rollbackFinalSnapshotId(
  resourceType: string,
  record: Pick<ResourceState, 'physicalId' | 'updateReplacePolicy' | 'provisionedBy'>,
  fallbackProvisionedBy?: 'sdk' | 'cc-api'
): string | undefined {
  if (record.updateReplacePolicy !== 'Snapshot') return undefined;
  if (!ATOMIC_FINAL_SNAPSHOT_TYPES.has(resourceType)) return undefined;
  if (effectiveProvisionedBy(record, fallbackProvisionedBy) === 'cc-api') return undefined;
  return buildFinalSnapshotIdentifier(record.physicalId, resourceType);
}

/**
 * `DeletionPolicy: Snapshot` on a rolled-back CREATE (issue #1358) — the
 * executor's copy of the deploy engine's `prepareFinalSnapshotForDelete`
 * mechanism matrix, run BEFORE the delete. Shared with the FAILED in-flight
 * CREATE's delete (`--revert-failed`, issue #1362) so the two sibling paths
 * cannot drift; that caller's op is a {@link FailedOperation}, hence the
 * structural parameter type:
 *
 *   - atomic type, SDK-routed → returns the generated identifier for the
 *     provider's atomic final-snapshot delete parameter.
 *   - atomic type, cc-api-routed → refuses (Cloud Control's DeleteResource
 *     has no final-snapshot parameter; `CloudControlProvider.delete` also
 *     fail-closes on the context field as defense-in-depth).
 *   - `PRE_DELETE_SNAPSHOT_TYPES` → creates the snapshot and waits for it
 *     here, then returns undefined (the subsequent delete is plain).
 *   - anything else Snapshot-tagged → refuses.
 *
 * Refusals are plain throws so `replaySingle`'s per-op catch counts them as
 * a failure (which blocks the segment pop and keeps the journal for a
 * re-run) — deliberately NOT a silent fall-back to orphaning, which is the
 * very leak #1358 fixes.
 */
async function prepareCreateRollbackFinalSnapshot(
  op: Pick<CompletedOperation, 'logicalId' | 'resourceType' | 'physicalId'>,
  provisionedBy: 'sdk' | 'cc-api' | undefined,
  ctx: RollbackExecutorContext
): Promise<string | undefined> {
  const { logicalId, resourceType } = op;
  // Callers reach this only past the SAME falsy physical-id guard:
  // `replaySingle`'s `!op.physicalId` early return, or `classifyFailedOp`'s
  // `skip-failed-unknown` arm on the `--revert-failed` path.
  const physicalId = op.physicalId!;
  // ONE matrix, shared with the plan preview (issue #1366) so the label the
  // user confirms cannot promise a snapshot this function is about to refuse.
  switch (finalSnapshotMechanism(resourceType, provisionedBy)) {
    case 'atomic-delete-parameter':
      return buildFinalSnapshotIdentifier(physicalId, resourceType);
    case 'pre-delete-snapshot':
      // Region-pinned clients: `getAwsClients()` is a process-global that a
      // concurrent stack's deploy can repoint at ANOTHER region
      // (`--stack-concurrency > 1` + multi-region apps); a wrong-region
      // snapshot call 404s as a NotFound, which would be read as "source
      // gone" and skip the snapshot. Prefer the caller-scoped clients on the
      // context (mirrors `DeployEngineOptions.finalSnapshotClients`).
      await createPreDeleteFinalSnapshot(
        resourceType,
        physicalId,
        logicalId,
        ctx.finalSnapshotClients ?? getAwsClients(),
        ctx.logger
      );
      return undefined;
    case 'refuse-cc-routed':
      throw ccRoutedFinalSnapshotError(logicalId, resourceType, SKIP_FINAL_SNAPSHOT_FLAG);
    case 'refuse-unsupported-type':
      throw unsupportedFinalSnapshotError(logicalId, resourceType, SKIP_FINAL_SNAPSHOT_FLAG);
  }
}

/**
 * Retry schedule for a re-create that must wait out a name-release delay:
 * an async delete's late name release ("already exists") or the SQS 60s
 * same-name cooldown (issue #1206). 2s/4s/8s then capped at 10s over 8
 * retries ≈ 64s of total sleep — enough to cover the full cooldown window.
 */
const RECREATE_RETRY_SCHEDULE = {
  maxRetries: 8,
  initialDelayMs: 2_000,
  maxDelayMs: 10_000,
} as const;

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
  /** Physical ID at op start, if one was known (undefined for CREATE). */
  physicalId?: string | undefined;
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
  | 'unrecoverable-delete'; // DELETE cannot be restored

/** The action decided for a FAILED in-flight op (issue #1198, --revert-failed). */
export type FailedOpActionKind =
  | 'revert-failed-update' // force-apply previousState over the half-applied update
  | 'delete-failed-create' // a partially-recorded CREATE → delete it
  | 'delete-failed-create-with-final-snapshot' // ↑ under DeletionPolicy Snapshot (#1362)
  | 'orphan-failed-create-retain' // ↑ under DeletionPolicy Retain → leave in AWS (#1362)
  | 'skip-failed-unknown' // failed CREATE with nothing recorded — cannot act
  | 'skip-failed-noop' // failed DELETE (resource still in place) / already handled
  | 'skip-failed-absent'; // failed UPDATE with no previousState / not in state

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
   * Skips that carry a warning (physical-id mismatch, absent-on-update,
   * unrecoverable DELETE). Do NOT block segment pop, but map to exit 2.
   */
  warnings: number;
  interrupted: boolean;
}

/**
 * True when the op recorded a replacement (old physical id differs from the
 * new one). The old physical resource is already gone / orphaned, so an
 * in-place revert is best-effort — the plan labels these explicitly.
 */
export function isReplacementOp(op: CompletedOperation): boolean {
  return (
    op.changeType === 'UPDATE' &&
    op.previousState?.physicalId !== undefined &&
    op.previousState.physicalId !== op.physicalId
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * Classify what a single op WILL do against the current state, without
 * touching AWS. Pure — used both by the command's plan preview and by the
 * replayer (which re-derives the action to stay in lock-step with the
 * plan). `orphanLogicalIds` mirrors `cdk rollback --orphan`.
 */
export function classifyRollbackOp(
  op: CompletedOperation,
  stateResources: Record<string, ResourceState>,
  orphanLogicalIds: Set<string>
): RollbackActionKind {
  const replacement = isReplacementOp(op);

  if (op.changeType === 'DELETE') return 'unrecoverable-delete';

  if (orphanLogicalIds.has(op.logicalId)) return 'orphan-flag';

  if (op.changeType === 'CREATE') {
    const current = stateResources[op.logicalId];
    if (!current) return 'skip-already-done';
    if (op.physicalId !== undefined && current.physicalId !== op.physicalId) {
      return 'skip-mismatch';
    }
    // The CURRENT record's DeletionPolicy governs the rollback delete
    // (issue #1358): `Retain` keeps the resource (orphan), `Snapshot`
    // snapshots it first, everything else plain-deletes.
    const policy = current.deletionPolicy;
    if (policy === 'Retain') return 'orphan-retain';
    if (policy === 'Snapshot') return 'delete-with-final-snapshot';
    return 'delete';
  }

  // UPDATE
  const current = stateResources[op.logicalId];
  if (!current) return 'skip-absent';
  if (replacement) {
    // Replacement op (#1199): the OLD physical resource was destroyed (or
    // orphaned under UpdateReplacePolicy: Retain) and the NEW one carries a
    // different physical id. An in-place revert is guaranteed to throw on
    // the immutable property, so reverse the replacement instead.
    if (current.physicalId === op.previousState!.physicalId) {
      // State already points at the old physical id — a prior reverse-
      // replacement (or manual fix) already reverted this op.
      return 'skip-already-done';
    }
    if (op.physicalId !== undefined && current.physicalId !== op.physicalId) {
      // Neither the old nor the recorded new id. An AUTO-NAMED resource
      // re-created by a prior reverse-replacement lands here (its fresh
      // physical id matches neither) — recognize it by the properties
      // already matching the previous state. Anything else is a later
      // attempt's replacement; manual attention required.
      if (deepEqual(current.properties, op.previousState!.properties)) {
        return 'skip-already-done';
      }
      return 'skip-mismatch';
    }
    // `Retain` orphaned the old resource instead of deleting it (the deploy
    // engine's create-then-destroy path skips the delete; the delete-first
    // fallbacks refuse Retain outright), so the old resource still exists
    // and can be re-adopted without a re-create. `Snapshot` is NOT retained
    // on replacement (the engine plain-deletes) — it re-creates like the
    // default policy.
    const retained = op.previousState!.updateReplacePolicy === 'Retain';
    return retained ? 'reverse-replacement-readopt' : 'reverse-replacement';
  }
  if (op.previousState && deepEqual(current.properties, op.previousState.properties)) {
    // Already reverted (idempotent re-run).
    return 'skip-already-done';
  }
  return 'revert';
}

/**
 * Classify what reverting a FAILED in-flight op (issue #1198) will do
 * against the current state, without touching AWS. Pure — used by both the
 * command's `--revert-failed` plan preview and {@link replayFailedOperations}.
 */
export function classifyFailedOp(
  op: FailedOperation,
  stateResources: Record<string, ResourceState>
): FailedOpActionKind {
  if (op.changeType === 'DELETE') {
    // The delete FAILED, so the resource is still in place and state still
    // records it — there is nothing to revert.
    return 'skip-failed-noop';
  }
  const current = stateResources[op.logicalId];
  if (op.changeType === 'CREATE') {
    // A failed CREATE normally records nothing (the provider threw before
    // returning a physical id) — the remote state is unknown. Falsy, not
    // `=== undefined`: an empty physical id identifies nothing, and letting
    // it through would reach a delete (and a final-snapshot identifier) built
    // from `''`. Matches `replaySingle`'s `!op.physicalId` guard on the
    // completed-CREATE path, which is what lets both share
    // `prepareCreateRollbackFinalSnapshot`.
    if (!op.physicalId) return 'skip-failed-unknown';
    if (!current) return 'skip-failed-noop'; // already cleaned up (re-run)
    if (current.physicalId !== op.physicalId) return 'skip-failed-noop';
    // The CURRENT record's DeletionPolicy governs this delete exactly as it
    // governs the COMPLETED-CREATE rollback above (issue #1362). Reaching
    // here means AWS did provision the resource (a physical id is recorded
    // AND state agrees), so it is a real resource the policy speaks about —
    // "the CREATE failed" is not a licence to ignore the user's Retain /
    // Snapshot. CloudFormation applies the policy to a failed create's
    // rollback delete too; `RetainExceptOnCreate` exists precisely to opt
    // OUT of that for `Retain`, and it keeps deleting here.
    const policy = current.deletionPolicy;
    if (policy === 'Retain') return 'orphan-failed-create-retain';
    if (policy === 'Snapshot') return 'delete-failed-create-with-final-snapshot';
    return 'delete-failed-create';
  }
  // UPDATE
  if (!current || !op.previousState) return 'skip-failed-absent';
  return 'revert-failed-update';
}

/** Build the plan items for a segment's failed ops (issue #1198). */
export function planFailedOps(
  failedOps: FailedOperation[],
  stateResources: Record<string, ResourceState>
): FailedOpPlanItem[] {
  return failedOps.map((op) => ({
    op,
    action: classifyFailedOp(op, stateResources),
    effectiveProvisionedBy: effectiveProvisionedBy(stateResources[op.logicalId], op.provisionedBy),
  }));
}

/**
 * Build the full ordered plan for a list of ops (one segment). Mirrors the
 * replay order: UPDATE/DELETE first (reverse completion order), then CREATE
 * deletions in dependency-aware order.
 */
export function planRollback(
  operations: CompletedOperation[],
  stateResources: Record<string, ResourceState>,
  orphanLogicalIds: Set<string> = new Set()
): RollbackPlanItem[] {
  const { createOps, otherOps } = partitionOps(operations);
  const ordered: CompletedOperation[] = [
    ...[...otherOps].reverse(),
    ...sortRollbackCreates(createOps, stateResources),
  ];
  return ordered.map((op) => ({
    op,
    action: classifyRollbackOp(op, stateResources, orphanLogicalIds),
    replacement: isReplacementOp(op),
    effectiveProvisionedBy: effectiveProvisionedBy(stateResources[op.logicalId], op.provisionedBy),
  }));
}

function partitionOps(operations: CompletedOperation[]): {
  createOps: CompletedOperation[];
  otherOps: CompletedOperation[];
} {
  const createOps: CompletedOperation[] = [];
  const otherOps: CompletedOperation[] = [];
  for (const op of operations) {
    if (op.changeType === 'CREATE') createOps.push(op);
    else otherOps.push(op);
  }
  return { createOps, otherOps };
}

/**
 * Replay a list of completed operations against `stateResources` (mutated in
 * place), reverting each. Best-effort: a provider failure is caught, warned,
 * and counted; replay continues.
 *
 * - UPDATE / DELETE first (reverse completion order), then CREATE deletions
 *   in reverse dependency order (dependents deleted before dependencies).
 * - `afterOp` is invoked after each op that MUTATED state (so the command can
 *   persist state incrementally, mirroring `saveStateAfterResource`). The
 *   in-process engine passes no `afterOp` and saves state once at the end.
 * - `isInterrupted` is polled between ops; when it flips true, replay stops
 *   (the pending op is left for a re-run).
 */
export async function replayRollback(
  operations: CompletedOperation[],
  stateResources: Record<string, ResourceState>,
  stackName: string,
  ctx: RollbackExecutorContext,
  options: {
    orphanLogicalIds?: Set<string>;
    afterOp?: (logicalId: string) => Promise<void> | void;
    isInterrupted?: () => boolean;
  } = {}
): Promise<RollbackReplayResult> {
  const orphanLogicalIds = options.orphanLogicalIds ?? new Set<string>();
  const result: RollbackReplayResult = { failures: 0, warnings: 0, interrupted: false };

  if (operations.length === 0) {
    ctx.logger.info('No completed operations to roll back.');
    return result;
  }

  ctx.logger.info(`Rolling back ${operations.length} completed operation(s)...`);
  ctx.recordEvent?.({ eventType: 'ROLLBACK_STARTED', stackName });

  const { createOps, otherOps } = partitionOps(operations);

  // Step 1: UPDATE/DELETE rollbacks in reverse completion order.
  for (let i = otherOps.length - 1; i >= 0; i--) {
    if (options.isInterrupted?.()) {
      result.interrupted = true;
      break;
    }
    await replaySingle(
      otherOps[i]!,
      stateResources,
      stackName,
      ctx,
      orphanLogicalIds,
      result,
      options.afterOp,
      options.isInterrupted
    );
  }

  // Step 2: CREATE rollbacks (deletions) in dependency-aware order.
  if (!result.interrupted && createOps.length > 0) {
    const sorted = sortRollbackCreates(createOps, stateResources);
    for (const op of sorted) {
      if (options.isInterrupted?.()) {
        result.interrupted = true;
        break;
      }
      await replaySingle(
        op,
        stateResources,
        stackName,
        ctx,
        orphanLogicalIds,
        result,
        options.afterOp,
        options.isInterrupted
      );
    }
  }

  ctx.logger.info('Rollback completed. Some resources may remain if deletion failed.');
  ctx.recordEvent?.({ eventType: 'ROLLBACK_FINISHED', stackName });
  return result;
}

/**
 * `provider.update()` for a rollback arm, retried unless the provider opts out.
 *
 * Both rollback UPDATE arms need the same three things, and getting any of
 * them wrong is only visible on a recovery path (issue #1461):
 *
 *  - **Retry.** A provider `update()` can issue reads as well as writes (Glue
 *    does a pre-update `GetTable`), and the callers' best-effort catch counts
 *    a transient failure as a real one and moves on, leaving state unreverted.
 *    `deploy-engine.ts` and `drift.ts` have always wrapped their calls; these
 *    arms did not.
 *  - **`disableOuterRetry`.** `CustomResourceProvider` and
 *    `NestedStackProvider` set it AND implement `update()`. Re-invoking a
 *    Custom Resource derives a FRESH RequestId + pre-signed response URL, so
 *    the first attempt's response lands at an S3 key nobody polls — the exact
 *    hang the flag exists to prevent. Those providers retry internally.
 *  - **Interrupt.** `replayRollback` polls interrupts only BETWEEN ops, so an
 *    un-threaded `isInterrupted` leaves Ctrl-C dead for the length of the
 *    backoff schedule (~47s) per op.
 *
 * Returns the provider's result so the caller can honour
 * `effectiveProperties` (issue #1644) — both revert arms used to write the
 * previous state record back verbatim, dropping a narrowing the provider had
 * just announced and leaving the record describing something AWS does not
 * hold.
 */
async function updateWithRollbackRetry(
  provider: ResourceProvider,
  args: Parameters<ResourceProvider['update']>,
  logicalId: string,
  logger: RollbackExecutorContext['logger'],
  isInterrupted: (() => boolean) | undefined
): Promise<ResourceUpdateResult> {
  if (provider.disableOuterRetry) {
    // Single-shot — the provider handles transient errors internally, and an
    // outer retry would invalidate its per-call invariant state.
    return await provider.update(...args);
  }
  return await withRetry(() => provider.update(...args), logicalId, {
    logger,
    ...(isInterrupted && {
      isInterrupted,
      onInterrupted: () => new Error('Rollback interrupted while retrying a resource update'),
    }),
  });
}

/**
 * The state record to store after a rollback UPDATE arm (issue #1644).
 *
 * The bag handed to `update()` on both arms IS `restored.properties`, so a
 * returned `effectiveProperties` is its complete replacement — no per-key
 * delta is needed here (unlike `drift --revert`, which sends a merged bag).
 * Everything else on the record — physical id, attributes, dependencies,
 * policies — is the restored resource's and must survive untouched.
 */
function recordAfterRollbackUpdate(
  restored: ResourceState,
  result: ResourceUpdateResult | undefined
): ResourceState {
  // Copied, not aliased: the record outlives the call and a provider is free to
  // keep mutating the object it handed back. The optional `result` mirrors the
  // same tolerance `drift.ts`'s capture applies — a provider that resolves
  // `undefined` must not crash a recovery path.
  return result?.effectiveProperties
    ? { ...restored, properties: { ...result.effectiveProperties } }
    : restored;
}

/**
 * The `properties` override to merge into the state record rebuilt after the
 * reverse-replacement replay-CREATE (issue #1682) — the create-side twin of
 * {@link recordAfterRollbackUpdate}.
 *
 * The bag handed to `create()` on both arms of that path IS `prev.properties`,
 * so — exactly as on the UPDATE side — a returned `effectiveProperties` is its
 * complete replacement and no per-key delta is needed. Without this the arm
 * rebuilt the record from `prev.properties` unconditionally, so a provider that
 * deliberately SUBSTITUTED a malformed block on a replay (the `replayWarn`
 * downgrade of issue #1544) announced the substitution into a void and the
 * phantom drift it exists to close survived the rollback.
 *
 * Falls back to the restored record's own `properties` when the provider
 * reported nothing — the pre-#1682 behavior — rather than blanking the record.
 * An empty object is a legitimate COMPLETE answer (a provider that sent
 * nothing), so the gate is presence and not emptiness; `{}` is truthy in JS, so
 * it flows through as the recorded bag rather than falling back.
 *
 * Applied on the name-idempotent ADOPT path too (`adoptedLiveNewResource`).
 * That arm's warning says state records "the pre-replacement properties", and
 * it still does: a substitution repairs an unusable field of that same
 * pre-replacement bag, it does not swap in the new generation's values.
 */
function recordedPropertiesAfterReplayCreate(
  restored: Omit<ResourceState, 'observedProperties'>,
  result: ResourceCreateResult
): ResourceState['properties'] {
  // Copied, not aliased: the record outlives the call and a provider is free
  // to keep mutating the object it handed back.
  return result.effectiveProperties ? { ...result.effectiveProperties } : restored.properties;
}

async function replaySingle(
  op: CompletedOperation,
  stateResources: Record<string, ResourceState>,
  stackName: string,
  ctx: RollbackExecutorContext,
  orphanLogicalIds: Set<string>,
  result: RollbackReplayResult,
  afterOp?: (logicalId: string) => Promise<void> | void,
  isInterrupted?: () => boolean
): Promise<void> {
  const action = classifyRollbackOp(op, stateResources, orphanLogicalIds);
  const { logger } = ctx;
  /**
   * The route a CREATE-rollback arm resolved for this op (issue #1366) —
   * hoisted so the shared catch's ROLLBACK_RESOURCE_FAILED reports the route
   * the delete was going to take, which is the one a refusal is about. Stays
   * `undefined` on the UPDATE / replacement arms, where the catch keeps the
   * journaled value (those arms resolve their own routing separately).
   */
  let createRollbackRoute: 'sdk' | 'cc-api' | undefined;

  try {
    switch (action) {
      case 'unrecoverable-delete': {
        logger.warn(
          `  Rollback: Cannot restore deleted resource ${op.logicalId} (${op.resourceType}) — resource has already been deleted`
        );
        result.warnings++;
        return;
      }

      case 'skip-already-done': {
        logger.debug(`  Rollback: ${op.logicalId} already reverted, skipping`);
        return;
      }

      case 'skip-mismatch': {
        logger.warn(
          `  Rollback: Skipping ${op.logicalId} — its physical id changed since the failed deploy ` +
            `(replaced by a later attempt); manual attention may be required`
        );
        result.warnings++;
        return;
      }

      case 'skip-absent': {
        logger.warn(
          `  Rollback: Cannot restore ${op.logicalId} — resource no longer in state, skipping`
        );
        result.warnings++;
        return;
      }

      case 'orphan-flag': {
        if (op.changeType === 'CREATE') {
          // --orphan on a CREATE: leave the resource in AWS, drop it from
          // state (it is not part of the pre-deploy baseline).
          //
          // Route resolved BEFORE the record is dropped, same as the
          // `orphan-retain` arm (issue #1366): the comment below promises the
          // two orphan triggers emit the SAME event, so they must resolve
          // `provisionedBy` the same way too.
          const orphanFlagProvisionedBy = effectiveProvisionedBy(
            stateResources[op.logicalId],
            op.provisionedBy
          );
          createRollbackRoute = orphanFlagProvisionedBy;
          delete stateResources[op.logicalId];
          logger.info(`  Rollback: Orphaning created resource ${op.logicalId} (--orphan)`);
          await afterOp?.(op.logicalId);
          // Emit the same rollback event as the DeletionPolicy-orphan path
          // (`orphan-retain`) so `cdkd events` surfaces the orphaned resource
          // consistently regardless of which orphan trigger fired.
          ctx.recordEvent?.({
            eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
            stackName,
            operation: 'CREATE',
            logicalId: op.logicalId,
            resourceType: op.resourceType,
            ...(orphanFlagProvisionedBy && { provisionedBy: orphanFlagProvisionedBy }),
          });
        } else {
          // --orphan on an UPDATE: leave the resource at its new properties;
          // keep state as-is so it keeps describing AWS truth.
          logger.info(`  Rollback: Leaving ${op.logicalId} at its new state (--orphan)`);
        }
        return;
      }

      case 'orphan-retain': {
        // DeletionPolicy Retain on a rolled-back CREATE: orphan instead of
        // delete (the policy says KEEP the resource). `Snapshot` used to
        // land here too — see the module header + issue #1358.
        //
        // Resolved BEFORE the record is dropped: the event reports the
        // resource's effective route (issue #1366), and the record — the
        // authoritative side — is about to go away.
        const orphanProvisionedBy = effectiveProvisionedBy(
          stateResources[op.logicalId],
          op.provisionedBy
        );
        createRollbackRoute = orphanProvisionedBy;
        delete stateResources[op.logicalId];
        logger.info(
          `  Rollback: Leaving ${op.logicalId} (${op.resourceType}) in AWS ` +
            `(DeletionPolicy: Retain) — removed from state`
        );
        await afterOp?.(op.logicalId);
        ctx.recordEvent?.({
          eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
          stackName,
          operation: 'CREATE',
          logicalId: op.logicalId,
          resourceType: op.resourceType,
          ...(orphanProvisionedBy && { provisionedBy: orphanProvisionedBy }),
        });
        return;
      }

      case 'delete':
      case 'delete-with-final-snapshot': {
        if (!op.physicalId) {
          logger.warn(`  Rollback: Cannot delete ${op.logicalId} — no physical ID recorded`);
          result.warnings++;
          return;
        }
        // `DeletionPolicy: Snapshot` (issue #1358): snapshot BEFORE the
        // delete. Deliberately ahead of the delete's own call so a refusal /
        // snapshot failure leaves the resource intact (and counts as a
        // failure, keeping the journal for a re-run) rather than deleting
        // the data the policy promised to preserve. `--skip-final-snapshot`
        // is the explicit data-loss opt-out and degrades to a plain delete.
        //
        // The routing layer is resolved ONCE and used for BOTH the snapshot
        // gate and the provider lookup below: the gate's cc-api refusal is
        // only meaningful if it judges the route the delete will actually
        // take, and the delete-of-the-NEW-resource site already resolves it
        // this way (`current.provisionedBy ?? op.provisionedBy`).
        const deleteProvisionedBy = effectiveProvisionedBy(
          stateResources[op.logicalId],
          op.provisionedBy
        );
        createRollbackRoute = deleteProvisionedBy;
        const snapshotPolicy = action === 'delete-with-final-snapshot';
        const takeFinalSnapshot = snapshotPolicy && ctx.skipFinalSnapshot !== true;
        let finalSnapshotIdentifier: string | undefined;
        if (takeFinalSnapshot) {
          finalSnapshotIdentifier = await prepareCreateRollbackFinalSnapshot(
            op,
            deleteProvisionedBy,
            ctx
          );
        }
        logger.info(
          `  Rollback: Deleting created resource ${op.logicalId} (${op.resourceType})` +
            (takeFinalSnapshot ? ' — DeletionPolicy: Snapshot' : '') +
            // Make the opt-out auditable: without this the line is
            // byte-identical to a plain delete, so neither the log nor
            // `cdkd events` records that a Snapshot-policy resource was
            // destroyed with no snapshot.
            (snapshotPolicy && !takeFinalSnapshot
              ? ' — DeletionPolicy: Snapshot NOT taken (--skip-final-snapshot)'
              : '')
        );
        // Route via the SAME provider the CREATE landed on (#614).
        const { provider } = ctx.providerRegistry.getProviderFor({
          resourceType: op.resourceType,
          provisionedBy: deleteProvisionedBy,
        });
        await provider.delete(op.logicalId, op.physicalId, op.resourceType, op.properties, {
          expectedRegion: ctx.region,
          ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
        });
        delete stateResources[op.logicalId];
        logger.info(`  Rollback: ${op.logicalId} deleted successfully`);
        await afterOp?.(op.logicalId);
        ctx.recordEvent?.({
          eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
          stackName,
          operation: 'CREATE',
          logicalId: op.logicalId,
          resourceType: op.resourceType,
          // The route the delete ACTUALLY took, not the journaled one
          // (issue #1366) — a legacy journal entry can disagree with the
          // state record, and the record is what the delete was routed by.
          ...(deleteProvisionedBy && { provisionedBy: deleteProvisionedBy }),
        });
        return;
      }

      case 'reverse-replacement-readopt': {
        // Replacement rollback where UpdateReplacePolicy: Retain orphaned
        // the OLD physical resource (issue #1199): it still exists with its
        // data, so delete the NEW resource and point state back at the old
        // one — a true clean revert, no re-create needed.
        const current = stateResources[op.logicalId]!;
        const prev = op.previousState!;
        logger.info(
          `  Rollback: Reversing replacement of ${op.logicalId} (${op.resourceType}) — ` +
            `deleting the new resource and re-adopting the retained old one (${prev.physicalId})`
        );
        const { provider: newDeleteProvider } = ctx.providerRegistry.getProviderFor({
          resourceType: op.resourceType,
          provisionedBy: current.provisionedBy ?? op.provisionedBy,
        });
        {
          const finalSnapshotIdentifier = rollbackFinalSnapshotId(
            op.resourceType,
            current,
            op.provisionedBy
          );
          await newDeleteProvider.delete(
            op.logicalId,
            current.physicalId,
            op.resourceType,
            current.properties,
            {
              expectedRegion: ctx.region,
              ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
            }
          );
        }
        stateResources[op.logicalId] = prev;
        logger.info(`  Rollback: ${op.logicalId} restored to the retained old resource`);
        await afterOp?.(op.logicalId);
        ctx.recordEvent?.({
          eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
          stackName,
          operation: 'UPDATE',
          logicalId: op.logicalId,
          resourceType: op.resourceType,
          ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
        });
        return;
      }

      case 'reverse-replacement': {
        // Replacement rollback (issue #1199): the OLD physical resource is
        // already destroyed, so an in-place update against the NEW resource
        // would throw on the immutable property. Instead re-CREATE the old
        // resource from its journaled previousState and delete the new one.
        const current = stateResources[op.logicalId]!;
        const prev = op.previousState!;
        logger.info(
          `  Rollback: Reversing replacement of ${op.logicalId} (${op.resourceType}) — ` +
            `re-creating the old resource and deleting the new one`
        );
        // Advisory only (issue #1199 non-goal: data cannot be recovered —
        // surface clearly rather than silently "revert"). NOT counted in
        // result.warnings: the reverse-replacement op itself succeeds, and
        // warnings map to exit code 2.
        if (STATEFUL_TYPES.has(op.resourceType)) {
          logger.warn(
            `  ⚠ ${op.logicalId} (${op.resourceType}) is a stateful type — the old physical ` +
              `resource's data was destroyed by the replacement and CANNOT be recovered; the ` +
              `re-created resource starts empty.`
          );
        }
        // Route the re-create via the OLD resource's recorded layer and the
        // new resource's delete via ITS layer (they can differ — e.g. a
        // --recreate-via-cc-api migration).
        const { provider: createProvider } = ctx.providerRegistry.getProviderFor({
          resourceType: op.resourceType,
          provisionedBy: prev.provisionedBy,
        });
        const { provider: newDeleteProvider } = ctx.providerRegistry.getProviderFor({
          resourceType: op.resourceType,
          provisionedBy: current.provisionedBy ?? op.provisionedBy,
        });

        // Create-first (the old resource's revival is the point; if it fails
        // the new resource survives untouched). A user-supplied physical name
        // still held by the NEW resource collides — delete the new one first,
        // then retry the create with a bounded collision retry (async deletes
        // release the name late), mirroring the deploy engine's --replace
        // delete-first fallback.
        let deletedNewFirst = false;
        // Typed as the full provider contract (issue #1682): the narrower
        // local shape this used to declare hid `effectiveProperties`, so the
        // record rebuild below could not honour it even in principle.
        let createResult: ResourceCreateResult;
        try {
          // The initial create-first attempt retries ONLY the SQS name
          // cooldown (issue #1206): the forward replacement deleted the OLD
          // name moments ago (create-then-destroy with a changed name), so a
          // rollback within 60s deterministically hits QueueDeletedRecently.
          // A genuine collision must NOT be retried here — it falls through
          // to the delete-new-first fallback below instead.
          createResult = await withRetry(
            () =>
              createProvider.create(
                op.logicalId,
                op.resourceType,
                { ...prev.properties },
                REPLAYING_STATE_CREATE_CONTEXT
              ),
            op.logicalId,
            {
              ...RECREATE_RETRY_SCHEDULE,
              logger,
              ...(isInterrupted && {
                isInterrupted,
                onInterrupted: () =>
                  new Error('Rollback interrupted while waiting out the name cooldown'),
              }),
              isRetryable: isNameCooldownError,
            }
          );
        } catch (createError) {
          const msg = createError instanceof Error ? createError.message : String(createError);
          const nameCollision = isNameCollisionError(msg);
          if (!nameCollision) throw createError;
          logger.info(
            `  Rollback: re-create collided with the new resource's name — deleting the new ` +
              `resource (${current.physicalId}) first...`
          );
          {
            const finalSnapshotIdentifier = rollbackFinalSnapshotId(
              op.resourceType,
              current,
              op.provisionedBy
            );
            await newDeleteProvider.delete(
              op.logicalId,
              current.physicalId,
              op.resourceType,
              current.properties,
              {
                expectedRegion: ctx.region,
                ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
              }
            );
          }
          deletedNewFirst = true;
          // Persist the intermediate truth (resource currently absent) so an
          // interrupted re-run doesn't chase a deleted physical id.
          delete stateResources[op.logicalId];
          await afterOp?.(op.logicalId);
          try {
            createResult = await withRetry(
              () =>
                createProvider.create(
                  op.logicalId,
                  op.resourceType,
                  { ...prev.properties },
                  REPLAYING_STATE_CREATE_CONTEXT
                ),
              op.logicalId,
              {
                ...RECREATE_RETRY_SCHEDULE,
                logger,
                // Mirror the deploy engine's delete-first fallback: honor
                // SIGINT mid-sleep instead of blocking up to ~64s.
                ...(isInterrupted && {
                  isInterrupted,
                  onInterrupted: () =>
                    new Error('Rollback interrupted while waiting for the old name to release'),
                }),
                isRetryable: isRecreateRetryableError,
              }
            );
          } catch (recreateError) {
            // The new resource is already gone — say so, because the resource
            // is now absent from both AWS and state.
            throw new Error(
              `Failed to re-create the old ${op.logicalId} after the new resource ` +
                `(${current.physicalId}) was already deleted: ` +
                `${recreateError instanceof Error ? recreateError.message : String(recreateError)}. ` +
                `The resource is now absent — fix forward with 'cdkd deploy'.`
            );
          }
        }

        // Issue #1247 — rollback sibling of the deploy engine's #1238
        // NAMED_REPLACEMENT_IDEMPOTENT_CREATE guard: a name-idempotent Create
        // API does NOT collide when the NEW resource still holds the same
        // user-supplied name — it silently returns the LIVE new resource's
        // physicalId as the "re-created old" one. Since deletedNewFirst is
        // false on this path, the delete-new step below would then delete the
        // very resource this op just recorded in state. Skip the delete and
        // ADOPT the live resource (warn + exit-2 warning) instead of
        // hard-failing:
        // - Rollback is a RECOVERY flow: failing the segment would block the
        //   segment pop and strand the user in a replay loop that can never
        //   succeed (every re-run re-classifies the op as reverse-replacement
        //   and hits the same idempotent create), while adopting keeps the
        //   resource alive and lets the rollback settle.
        // - Re-applying the old properties via provider.update() is
        //   deliberately NOT attempted: the op was classified
        //   reverse-replacement precisely because the reverted property is
        //   immutable in place, so that update would throw the very
        //   immutable-property error this branch exists to avoid.
        // - Auto-falling-back to delete-new-first + re-create (the collision
        //   path above) is also NOT done: on a collision the Create THREW, so
        //   deleting the name holder is the only way to finish the revert —
        //   here the Create RETURNED the only live copy, and deleting it on
        //   speculation risks total resource loss if the re-create then fails
        //   (and, unlike deploy, rollback has no --replace-style opt-in to
        //   accept that risk).
        // State is rebuilt from previousState below (the intended
        // post-rollback record), so the not-re-applied properties surface via
        // `cdkd drift` / the next `cdkd deploy` for reconciliation. When
        // deletedNewFirst is true the same-id outcome is the EXPECTED result
        // (re-acquiring the name after the new resource is gone) — exempt,
        // mirroring the deploy-side guard's delete-first exemption.
        const adoptedLiveNewResource =
          !deletedNewFirst && createResult.physicalId === current.physicalId;
        if (adoptedLiveNewResource) {
          logger.warn(
            `  ⚠ ${op.logicalId} (${op.resourceType}): the re-create returned the LIVE new ` +
              `resource (${current.physicalId}) instead of re-creating the old one — its ` +
              `Create API is name-idempotent and the new resource still holds the same ` +
              `user-supplied name. Skipping the delete-new step (it would delete that very ` +
              `resource). The old resource's ORIGINAL properties may NOT have been re-applied; ` +
              `state now records the pre-replacement properties, so run ` +
              `'cdkd drift ${stackName}' to inspect and 'cdkd deploy' to reconcile, or rename ` +
              `the resource to make the replacement reversible.`
          );
          result.warnings++;
        }

        // Rebuild the record from the previous state, but NEVER carry the
        // OLD physical resource's attributes / observedProperties over — the
        // re-created resource has fresh identifiers (ARNs etc.), and stale
        // cached attributes would poison later Fn::GetAtt resolution and
        // drift comparison. Mirrors the deploy engine's replacement path,
        // which constructs the record fresh from the create result — including
        // the provider's `effectiveProperties` (issue #1682), which replaces
        // the previous record's `properties` when it reported one.
        const { observedProperties: _staleObserved, ...prevRecord } = prev;
        stateResources[op.logicalId] = {
          ...prevRecord,
          physicalId: createResult.physicalId,
          attributes: createResult.attributes ?? {},
          properties: recordedPropertiesAfterReplayCreate(prevRecord, createResult),
        };
        await afterOp?.(op.logicalId);

        if (!deletedNewFirst && !adoptedLiveNewResource) {
          try {
            const finalSnapshotIdentifier = rollbackFinalSnapshotId(
              op.resourceType,
              current,
              op.provisionedBy
            );
            await newDeleteProvider.delete(
              op.logicalId,
              current.physicalId,
              op.resourceType,
              current.properties,
              {
                expectedRegion: ctx.region,
                ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
              }
            );
          } catch (deleteError) {
            logger.warn(
              `  Rollback: old ${op.logicalId} re-created, but deleting the new resource ` +
                `(${current.physicalId}) failed: ` +
                `${deleteError instanceof Error ? deleteError.message : String(deleteError)}. ` +
                `Delete it manually — it is no longer tracked in state.`
            );
            result.warnings++;
          }
        }
        logger.info(
          adoptedLiveNewResource
            ? `  Rollback: ${op.logicalId} adopted the live resource (${createResult.physicalId}) ` +
                `— replacement NOT fully reversed (name-idempotent Create API)`
            : `  Rollback: ${op.logicalId} replacement reversed (old resource re-created as ` +
                `${createResult.physicalId})`
        );
        ctx.recordEvent?.({
          eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
          stackName,
          operation: 'UPDATE',
          logicalId: op.logicalId,
          resourceType: op.resourceType,
          ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
        });
        return;
      }

      case 'revert': {
        if (!op.previousState) {
          logger.warn(`  Rollback: Cannot restore ${op.logicalId} — no previous state available`);
          result.warnings++;
          return;
        }
        // Bound before the retry closure below: the narrowing from the guard
        // above does not survive into a deferred callback.
        const previousState = op.previousState;
        const current = stateResources[op.logicalId];
        if (!current) {
          logger.warn(
            `  Rollback: Cannot restore ${op.logicalId} — resource not found in current state`
          );
          result.warnings++;
          return;
        }
        logger.info(`  Rollback: Restoring ${op.logicalId} (${op.resourceType}) to previous state`);
        // Route via the provider that owns the resource right now per state.
        const { provider } = ctx.providerRegistry.getProviderFor({
          resourceType: op.resourceType,
          provisionedBy: op.provisionedBy,
        });
        // See {@link updateWithRollbackRetry} for why this is not a bare
        // `provider.update()` and not a bare `withRetry` either.
        const revertResult = await updateWithRollbackRetry(
          provider,
          [
            op.logicalId,
            current.physicalId,
            op.resourceType,
            previousState.properties,
            current.properties,
          ],
          op.logicalId,
          logger,
          isInterrupted
        );
        stateResources[op.logicalId] = recordAfterRollbackUpdate(previousState, revertResult);
        logger.info(`  Rollback: ${op.logicalId} restored successfully`);
        await afterOp?.(op.logicalId);
        ctx.recordEvent?.({
          eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
          stackName,
          operation: 'UPDATE',
          logicalId: op.logicalId,
          resourceType: op.resourceType,
          ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
        });
        return;
      }
    }
  } catch (rollbackError) {
    // Best-effort: warn and continue with remaining rollbacks.
    logger.warn(
      `  Rollback failed for ${op.logicalId} (${op.changeType}): ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
    );
    logger.warn('  Continuing with remaining rollback operations...');
    result.failures++;
    const failedRoute = createRollbackRoute ?? op.provisionedBy;
    ctx.recordEvent?.({
      eventType: 'ROLLBACK_RESOURCE_FAILED',
      stackName,
      operation: op.changeType,
      logicalId: op.logicalId,
      resourceType: op.resourceType,
      ...(failedRoute && { provisionedBy: failedRoute }),
      error: extractDeploymentEventError(rollbackError),
    });
  }
}

/**
 * Revert a segment's FAILED in-flight operations (issue #1198). Opt-in via
 * `cdkd rollback --revert-failed` — the failed resource's remote state is
 * unknown (the op died partway), so force-applying `previousState` is a
 * deliberate user decision, never the default. Runs BEFORE the segment's
 * completed ops (the failed op is the newest work of the failed deploy).
 *
 * Best-effort like {@link replayRollback}: per-op failures are caught,
 * warned, and counted.
 */
export async function replayFailedOperations(
  failedOps: FailedOperation[],
  stateResources: Record<string, ResourceState>,
  stackName: string,
  ctx: RollbackExecutorContext,
  options: {
    afterOp?: (logicalId: string) => Promise<void> | void;
    isInterrupted?: () => boolean;
    /**
     * Emit the ROLLBACK_STARTED / ROLLBACK_FINISHED envelope around the
     * failed-op replay. The command passes true for a failed-only segment
     * (zero completed ops), where `replayRollback` returns early without
     * emitting the envelope — keeping `cdkd events` output symmetric.
     */
    emitEnvelope?: boolean;
  } = {}
): Promise<FailedOpReplayResult> {
  const result: FailedOpReplayResult = {
    failures: 0,
    warnings: 0,
    interrupted: false,
    remainingFailedOps: [],
  };
  const { logger } = ctx;
  const emitEnvelope = options.emitEnvelope === true && failedOps.length > 0;
  if (emitEnvelope) ctx.recordEvent?.({ eventType: 'ROLLBACK_STARTED', stackName });

  // Ops still pending after this replay: revert threw, or never reached due
  // to an interrupt. Everything else (reverted, deleted, or skipped — a skip
  // has nothing left to act on and its warning was already shown once) is
  // considered handled and drops out of the journal.
  const pending = new Set<FailedOperation>();

  for (let i = failedOps.length - 1; i >= 0; i--) {
    if (options.isInterrupted?.()) {
      result.interrupted = true;
      for (let j = i; j >= 0; j--) pending.add(failedOps[j]!);
      break;
    }
    const op = failedOps[i]!;
    const action = classifyFailedOp(op, stateResources);
    // The route a CREATE arm resolved (issue #1366), so the shared catch's
    // ROLLBACK_RESOURCE_FAILED names the route the delete was going to take —
    // the one a Snapshot refusal is about. Undefined on the UPDATE arm.
    let createRollbackRoute: 'sdk' | 'cc-api' | undefined;
    try {
      switch (action) {
        case 'skip-failed-noop': {
          logger.info(
            `  Rollback: failed ${op.changeType} of ${op.logicalId} (${op.resourceType}) ` +
              `left nothing to revert, skipping`
          );
          break;
        }

        case 'skip-failed-unknown': {
          logger.warn(
            `  Rollback: failed CREATE of ${op.logicalId} (${op.resourceType}) recorded no ` +
              `physical id — if it was partially created in AWS, delete it manually`
          );
          result.warnings++;
          break;
        }

        case 'skip-failed-absent': {
          logger.warn(
            `  Rollback: cannot revert failed UPDATE of ${op.logicalId} — no previous state ` +
              `available, skipping`
          );
          result.warnings++;
          break;
        }

        case 'orphan-failed-create-retain': {
          // `DeletionPolicy: Retain` on a FAILED in-flight CREATE (issue
          // #1362): the resource WAS provisioned (physical id recorded, state
          // agrees), so the policy applies to its rollback delete — keep it
          // in AWS and drop the record, exactly as the completed-CREATE
          // rollback does. `RetainExceptOnCreate` deliberately does NOT land
          // here; it keeps deleting.
          //
          // Resolved BEFORE the record is dropped (issue #1366): the event
          // reports the resource's effective route, and the record — the
          // authoritative side — is about to go away.
          const orphanProvisionedBy = effectiveProvisionedBy(
            stateResources[op.logicalId],
            op.provisionedBy
          );
          createRollbackRoute = orphanProvisionedBy;
          delete stateResources[op.logicalId];
          logger.info(
            `  Rollback: leaving partially-created ${op.logicalId} (${op.resourceType}) in AWS ` +
              `(DeletionPolicy: Retain) — removed from state`
          );
          await options.afterOp?.(op.logicalId);
          ctx.recordEvent?.({
            eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
            stackName,
            operation: 'CREATE',
            logicalId: op.logicalId,
            resourceType: op.resourceType,
            ...(orphanProvisionedBy && { provisionedBy: orphanProvisionedBy }),
          });
          break;
        }

        case 'delete-failed-create':
        case 'delete-failed-create-with-final-snapshot': {
          // Resolve the routing layer ONCE and use it for BOTH the snapshot
          // gate and the provider lookup (the #1358 alignment): the gate's
          // cc-api refusal is only meaningful if it judges the route the
          // delete actually takes. The state record wins over the journaled
          // op for the same reason it does on the completed-CREATE path.
          const deleteProvisionedBy = effectiveProvisionedBy(
            stateResources[op.logicalId],
            op.provisionedBy
          );
          createRollbackRoute = deleteProvisionedBy;
          // `DeletionPolicy: Snapshot` (issue #1362): snapshot BEFORE the
          // delete, through the same mechanism matrix as the completed-CREATE
          // rollback. A shape cdkd cannot snapshot is REFUSED (per-op
          // failure, journal kept) rather than plain-deleted — a half-created
          // resource that is not snapshot-capable YET (an RDS instance still
          // `creating` rejects a final-snapshot delete) becomes snapshot-able
          // once it settles, so a re-run can finish the job. Destroying the
          // data on the first refusal would be unrecoverable;
          // `--skip-final-snapshot` is the explicit opt-out.
          const snapshotPolicy = action === 'delete-failed-create-with-final-snapshot';
          const takeFinalSnapshot = snapshotPolicy && ctx.skipFinalSnapshot !== true;
          let finalSnapshotIdentifier: string | undefined;
          if (takeFinalSnapshot) {
            finalSnapshotIdentifier = await prepareCreateRollbackFinalSnapshot(
              op,
              deleteProvisionedBy,
              ctx
            );
          }
          logger.info(
            `  Rollback: deleting partially-created ${op.logicalId} (${op.resourceType}) ` +
              `(--revert-failed)` +
              (takeFinalSnapshot ? ' — DeletionPolicy: Snapshot' : '') +
              // Keep the opt-out auditable: without this the line is
              // byte-identical to a plain delete, so nothing records that a
              // Snapshot-policy resource was destroyed with no snapshot.
              (snapshotPolicy && !takeFinalSnapshot
                ? ' — DeletionPolicy: Snapshot NOT taken (--skip-final-snapshot)'
                : '')
          );
          const { provider } = ctx.providerRegistry.getProviderFor({
            resourceType: op.resourceType,
            provisionedBy: deleteProvisionedBy,
          });
          // Pass the ATTEMPTED properties so template-borne data-guard
          // opt-ins (issue #1340: CDK auto-delete tags, EmptyOnDelete) stay
          // visible to the provider's delete — with `undefined` a
          // partially-created bucket/repo that already received data would
          // guard-fail this rollback delete even though the template opted in.
          await provider.delete(
            op.logicalId,
            op.physicalId!,
            op.resourceType,
            op.attemptedProperties,
            {
              expectedRegion: ctx.region,
              ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
            }
          );
          delete stateResources[op.logicalId];
          await options.afterOp?.(op.logicalId);
          ctx.recordEvent?.({
            eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
            stackName,
            operation: 'CREATE',
            logicalId: op.logicalId,
            resourceType: op.resourceType,
            // The route the delete ACTUALLY took (issue #1366).
            ...(deleteProvisionedBy && { provisionedBy: deleteProvisionedBy }),
          });
          break;
        }

        case 'revert-failed-update': {
          const current = stateResources[op.logicalId]!;
          const prev = op.previousState!;
          logger.info(
            `  Rollback: force-reverting failed UPDATE of ${op.logicalId} (${op.resourceType}) ` +
              `to its pre-deploy properties (--revert-failed; remote state is unknown)`
          );
          const { provider } = ctx.providerRegistry.getProviderFor({
            resourceType: op.resourceType,
            provisionedBy: op.provisionedBy ?? current.provisionedBy,
          });
          // Previous side of the diff = the ATTEMPTED properties (what the
          // failed op may have partially applied), so a patch-based provider
          // generates ops that undo them. Falls back to the current state
          // properties when resolution never got that far.
          // See {@link updateWithRollbackRetry} — same three concerns as the
          // `revert` arm (retry / disableOuterRetry / interrupt).
          const revertFailedResult = await updateWithRollbackRetry(
            provider,
            [
              op.logicalId,
              current.physicalId,
              op.resourceType,
              prev.properties,
              op.attemptedProperties ?? current.properties,
            ],
            op.logicalId,
            logger,
            options.isInterrupted
          );
          stateResources[op.logicalId] = recordAfterRollbackUpdate(prev, revertFailedResult);
          logger.info(`  Rollback: ${op.logicalId} reverted successfully`);
          await options.afterOp?.(op.logicalId);
          ctx.recordEvent?.({
            eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
            stackName,
            operation: 'UPDATE',
            logicalId: op.logicalId,
            resourceType: op.resourceType,
            ...(op.provisionedBy && { provisionedBy: op.provisionedBy }),
          });
          break;
        }
      }
    } catch (revertError) {
      logger.warn(
        `  Rollback failed for failed-op ${op.logicalId} (${op.changeType}): ` +
          `${revertError instanceof Error ? revertError.message : String(revertError)}`
      );
      result.failures++;
      pending.add(op);
      const failedRoute = createRollbackRoute ?? op.provisionedBy;
      ctx.recordEvent?.({
        eventType: 'ROLLBACK_RESOURCE_FAILED',
        stackName,
        operation: op.changeType,
        logicalId: op.logicalId,
        resourceType: op.resourceType,
        ...(failedRoute && { provisionedBy: failedRoute }),
        error: extractDeploymentEventError(revertError),
      });
    }
  }
  if (emitEnvelope) ctx.recordEvent?.({ eventType: 'ROLLBACK_FINISHED', stackName });
  result.remainingFailedOps = failedOps.filter((op) => pending.has(op));
  return result;
}

/**
 * Sort CREATE rollback operations so that resources depending on others are
 * deleted first (reverse dependency order), using state dependencies. Same
 * algorithm as the pre-extraction `DeployEngine.sortRollbackCreates`.
 */
export function sortRollbackCreates(
  createOps: CompletedOperation[],
  stateResources: Record<string, ResourceState>,
  logger?: Logger
): CompletedOperation[] {
  const opMap = new Map<string, CompletedOperation>();
  const deleteIds = new Set<string>();
  for (const op of createOps) {
    opMap.set(op.logicalId, op);
    deleteIds.add(op.logicalId);
  }

  const dependedBy = new Map<string, Set<string>>();
  for (const id of deleteIds) {
    if (!dependedBy.has(id)) dependedBy.set(id, new Set());
  }

  for (const id of deleteIds) {
    const resource = stateResources[id];
    if (!resource?.dependencies) continue;
    for (const dep of resource.dependencies) {
      if (!deleteIds.has(dep)) continue;
      // id depends on dep → dep must be deleted AFTER id
      if (!dependedBy.has(dep)) dependedBy.set(dep, new Set());
      dependedBy.get(dep)!.add(id);
    }
  }

  const sorted: CompletedOperation[] = [];
  let remaining = new Set(deleteIds);

  while (remaining.size > 0) {
    const level: string[] = [];
    for (const id of remaining) {
      const dependents = dependedBy.get(id);
      const hasPendingDependents = dependents
        ? [...dependents].some((d) => remaining.has(d))
        : false;
      if (!hasPendingDependents) level.push(id);
    }

    if (level.length === 0) {
      logger?.warn(
        `Circular dependency detected in rollback order, processing remaining ${remaining.size} resources`
      );
      for (const id of remaining) {
        const op = opMap.get(id);
        if (op) sorted.push(op);
      }
      break;
    }

    for (const id of level) {
      const op = opMap.get(id);
      if (op) sorted.push(op);
    }
    remaining = new Set([...remaining].filter((id) => !level.includes(id)));
  }

  logger?.debug(`Rollback CREATE deletion order: ${sorted.map((op) => op.logicalId).join(' → ')}`);
  return sorted;
}
