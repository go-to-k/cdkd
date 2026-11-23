import { redactOutputs, rememberRecoverableMaskedOutputs } from './masking.js';
import { phaseScopeForStack, timePhase } from '../../utils/phase-timings.js';
import { writeRollbackJournalSegment } from './rollback.js';
import { warnUnretriedReplacedDeletes } from './replacement.js';
import { queueNestedCleanup, runCleanupPhase } from './nested-cleanup.js';
import {
  NestedCleanupQueue,
  getNestedCleanupQueue,
  withNestedCleanupQueue,
} from '../nested-cleanup-scope.js';
import {
  isSupersededHeldBySameType,
  removeSuperseded,
  supersededResourcesOf,
} from '../superseded-resources.js';
import {
  type DeployEngine,
  type ProvisionCounts,
  type ResourceOutcomeSignal,
  InterruptedError,
  crossStackReadsForPartialSave,
} from '../deploy-engine.js';
import type { DagBuilder } from '../../analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import {
  type ResourceChange,
  type ResourceState,
  STATE_SCHEMA_VERSION_CURRENT,
  type StackState,
  type SupersededResourceRecord,
  exportNamesCarriedFrom,
  stackInstanceIdCarriedFrom,
  orphansCarriedFrom,
  skippedOutputsCarriedFrom,
} from '../../types/state.js';
import { cyan, red } from '../../utils/colors.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { asIsMessage, safeMsg } from '../../utils/display-safe.js';
import { DagExecutor } from '../dag-executor.js';
import {
  buildDeletionDependencies,
  hasPending,
  nearestMemberDependencies,
} from './dependencies.js';
import { orderInlinePolicyWriters } from '../inline-policy-claims.js';
import { withSharedDrainBudget } from '../drain-budget.js';
import type { CompletedOperation, FailedOperation } from '../rollback-executor.js';
import { deployStackRecordsView, type InFlightWrite } from '../stack-records-scope.js';
import { resolveOutputs } from './outputs.js';
import { withTemplateDependencies } from './record-shape.js';
import { provisionResource } from './provision.js';
import { retiredNameGenerationsAfter } from '../../state/name-generation.js';
import { type ReportedCreateToSettle, recordUnsettledMarks } from './execute/helpers.js';
import { enqueueLostChildren } from './execute/lost-children.js';
import { provisionCreateUpdateNode } from './execute/provision-node.js';
import { settleFailedDeployRecords } from './execute/failed-deploy-records.js';
import { rollbackFailedDeploy } from './execute/rollback-after-failure.js';
import type { DeployRun } from './execute/run.js';
import { pruneStoppedSiblingMembersBestEffort } from './observed-capture.js';
import { refuseDeferredExportChanges } from './deploy-flow/plan-checks.js';
import { type ForceQuitFlushRegistrar, withForceQuitFlushScope } from '../force-quit-journal.js';
import { forceQuitFlusher } from './execute/force-quit-flush.js';
import type { AffectedExport } from '../export-change-guard.js';

/**
 * Execute deployment by processing resources via event-driven DAG dispatch.
 *
 * - CREATE/UPDATE follow forward dependency order (a node starts as soon as
 *   ALL of its dependencies are completed — does not wait for unrelated
 *   siblings in the same "level")
 * - DELETE follows reverse dependency order (a node starts as soon as all
 *   resources that depend ON it have finished deleting)
 *
 * A ROOT engine (no `parentStackInfo`) binds the nested cleanup queue its
 * descendants' cleanup phases wait in (go-to-k/cdkd#6398). Every run's
 * force-quit flusher (go-to-k/cdkd#6894) is removed when the run settles.
 */
export function executeDeployment(
  ...args: ExecuteDeploymentArgs
): ReturnType<typeof executeDeploymentBody> {
  const [engine] = args;
  const run = (): ReturnType<typeof executeDeploymentBody> =>
    withForceQuitFlushScope((register) => executeDeploymentBody(register, ...args));
  if (engine.options.parentStackInfo !== undefined) return run();
  return withNestedCleanupQueue(new NestedCleanupQueue(), run);
}

type ExecuteDeploymentArgs =
  Parameters<typeof executeDeploymentBody> extends [ForceQuitFlushRegistrar, ...infer Rest]
    ? Rest
    : never;

async function executeDeploymentBody(
  registerForceQuitFlush: ForceQuitFlushRegistrar,
  engine: DeployEngine,
  template: CloudFormationTemplate,
  currentState: StackState,
  changes: Map<string, ResourceChange>,
  dag: ReturnType<DagBuilder['buildGraph']>,
  executionLevels: string[][],
  stackName: string,
  /** The pre-resolution snapshot for the skipped-outputs digests (issue #2740); see `doDeploy`. */
  outputsDigestSource: CloudFormationTemplate,
  parameterValues?: Record<string, unknown>,
  conditions?: Record<string, boolean>,
  currentEtag?: string,
  progress?: { current: number; total: number },
  migrationPending = false,
  /** go-to-k/cdkd#6865: exports judged once the custom resources they read are updated. */
  deferredExports: readonly AffectedExport[] = []
): Promise<{
  state: StackState;
  actualCounts: ProvisionCounts;
  /** Issue #3754: journaled by a NESTED engine on success. */
  completedOperations: CompletedOperation[];
}> {
  const concurrency = engine.options.concurrency!;
  // go-to-k/cdkd#6398: the queue a root engine drains at its cleanup phase.
  const nestedCleanups =
    engine.options.parentStackInfo === undefined ? getNestedCleanupQueue() : undefined;
  engine.deployChanges = changes;
  const newResources: Record<string, ResourceState> = { ...currentState.resources };
  // go-to-k/cdkd#4821: read by a replacement's delete of its old copy.
  engine.deployStateResources = newResources;
  const actualCounts: ProvisionCounts = {
    created: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    deleteSkipped: 0,
    updatePartial: 0,
    nestedUpdatePartial: 0,
  };
  const completedOperations: CompletedOperation[] = [];
  // #1198: the op(s) that FAILED mid-deploy (usually one; concurrent
  // siblings can add more). Journaled alongside completedOperations so
  // `cdkd rollback --revert-failed` can optionally revert them.
  const failedOperations: FailedOperation[] = [];
  // go-to-k/cdkd#5511: the failed operations whose deadline fired with no
  // mark, completed from their provider's report when the failure is saved.
  const reportedCreatesToSettle: ReportedCreateToSettle[] = [];
  // Tracked here so the FIRST per-resource save sweeps the legacy key; we
  // don't want to delete it on every save.
  let pendingMigration = migrationPending;

  // go-to-k/cdkd#5200: inert unless CDKD_PHASE_TIMINGS=1.
  const phaseScope = phaseScopeForStack(stackName, engine.stackRegion);
  // Serialize per-resource state saves to avoid ETag conflicts from concurrent writes
  let saveChain: Promise<void> = Promise.resolve();
  // go-to-k/cdkd#5200: at most ONE save waits behind the one in flight. A
  // queued save builds its state from the live records when it STARTS, so it
  // already carries every resource that completes before then, and a second
  // queued save would write the same records again: a completion that finds a
  // save queued joins it instead of queueing another S3 write.
  let queuedSave: string[] | undefined;
  // One per-resource save of the live records; rejects when the save fails.
  const savePartialState = async (savedFor: string): Promise<void> => {
    const partialState: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: engine.stackRegion,
      stackName: currentState.stackName,
      resources: newResources,
      outputs: currentState.outputs,
      ...exportNamesCarriedFrom(currentState),
      ...skippedOutputsCarriedFrom(currentState),
      ...orphansCarriedFrom(currentState),
      ...stackInstanceIdCarriedFrom(currentState),
      // Issue #2057: the UNION of the pre-deploy snapshot and what THIS
      // session resolved. See `crossStackReadsForPartialSave` — writing the
      // snapshot alone left a failed deploy's persisted record denying a
      // cross-stack read its own resources were built from.
      ...crossStackReadsForPartialSave(
        currentState,
        engine.recordedImports,
        engine.recordedOutputReads,
        engine.crossStackReadKeyNormalizer()
      ),
      lastModified: Date.now(),
    };
    // Migration is a one-shot tail on the first save; subsequent saves
    // overwrite the new key in-place under optimistic locking.
    const migrate = pendingMigration;
    const expectedEtag = migrate ? undefined : currentEtag;
    currentEtag = await timePhase(phaseScope, 'per-resource save', () =>
      engine.stateBackend.saveState(
        stackName,
        engine.stackRegion,
        engine.withParentInfo(partialState),
        { ...(expectedEtag !== undefined && { expectedEtag }), migrateLegacy: migrate }
      )
    );
    if (migrate) pendingMigration = false;
    engine.logger.debug(safeMsg`State saved after ${savedFor}`);
  };
  const saveStateAfterResource = (logicalId: string): void => {
    if (currentEtag === undefined) return;
    if (queuedSave !== undefined) {
      queuedSave.push(logicalId);
      return;
    }
    const savedIds = [logicalId];
    queuedSave = savedIds;
    saveChain = saveChain.then(async () => {
      // Started: a completion from here on is not in this save's records, so
      // it queues the next one. Before any await.
      queuedSave = undefined;
      const savedFor = savedIds.join(', ');
      try {
        await savePartialState(savedFor);
      } catch (error) {
        engine.logger.warn(
          safeMsg`Failed to save state after ${savedFor}: ${asIsMessage(describeAwsFailure(error).detail)}`
        );
      }
    });
  };
  // go-to-k/cdkd#6824: the write-ahead of a rotated secret send. The record
  // goes live in memory first, so any save from here on (a queued one
  // included) carries it; this save is awaited and its failure is the
  // caller's, which then sends nothing.
  engine.writeAheadRecord = async (logicalId: string, record: ResourceState): Promise<void> => {
    if (currentEtag === undefined) {
      throw new Error('there is no state record to write ahead to');
    }
    newResources[logicalId] = record;
    const ahead = saveChain.then(() => savePartialState(`${logicalId} (write-ahead)`));
    saveChain = ahead.catch(() => undefined);
    await ahead;
  };

  // Separate DELETE operations from CREATE/UPDATE
  const deleteChanges = new Set(
    Array.from(changes.entries())
      .filter(([_, change]) => change.changeType === 'DELETE')
      .map(([logicalId]) => logicalId)
  );

  // go-to-k/cdkd#4492: the stack's records, for a provider whose AWS object two
  // records of this stack can share (a `SecurityGroupIngress` rule). A record
  // whose UPDATE is IN FLIGHT is in neither view until it completes; a pending
  // one still describes what AWS serves, and stays.
  const startedUpdates = new Set<string>();
  const settledUpdates = new Set<string>();
  // Every create / update in flight, with the promise its settlement resolves:
  // a write that met its twin's identical rule waits for it (#4492).
  const inFlightWrites = new Map<string, { write: InFlightWrite; settle: (ok: boolean) => void }>();
  engine.stackRecordsView = deployStackRecordsView(
    newResources,
    currentState.resources,
    deleteChanges,
    (logicalId) => startedUpdates.has(logicalId) && !settledUpdates.has(logicalId),
    () => [...inFlightWrites.values()].map(({ write }) => write),
    // go-to-k/cdkd#6722: created by this deploy, or replaced by an update
    // that answered `wasReplaced`: the record's identity id is the one this
    // run's create answered, so an attach to it needs no compare read.
    (logicalId) =>
      engine.replacementRun.updateWasReplaced.get(logicalId) === true ||
      completedOperations.some((op) => op.logicalId === logicalId && op.changeType === 'CREATE')
  );
  engine.replacementRun.deferredReplacedDeletes = new Map();
  // go-to-k/cdkd#5111: a deferred delete records its old resource here, so the
  // row's save persists it; the ones an earlier deploy recorded are retried at
  // the cleanup below.
  engine.replacementRun.supersededHost = currentState;
  const carriedSuperseded = supersededResourcesOf(currentState).filter((entry) => {
    // One a record holds again (`cdkd rollback` took it back) leaves the live
    // record too, so no later recording duplicates it.
    if (!isSupersededHeldBySameType(entry, currentState.resources)) return true;
    removeSuperseded(currentState, entry);
    return false;
  });

  const run: DeployRun = {
    engine,
    template,
    currentState,
    changes,
    dag,
    stackName,
    parameterValues,
    conditions,
    progress,
    newResources,
    actualCounts,
    completedOperations,
    failedOperations,
    reportedCreatesToSettle,
    phaseScope,
    saveStateAfterResource,
    deleteChanges,
    startedUpdates,
    settledUpdates,
    inFlightWrites,
  };

  // go-to-k/cdkd#6894: a force-quit or a closed terminal exits before any
  // segment below is written; this flusher writes one for the operations so
  // far. Taken back where this run's own path takes journaling over; the
  // scope removes it when the run settles. In memory: an uninterrupted deploy
  // makes no extra call.
  let createUpdateExecutor: DagExecutor<ResourceChange> | undefined;
  let deleteExecutor: DagExecutor<ResourceChange> | undefined;
  const forceQuit = registerForceQuitFlush(
    forceQuitFlusher(
      run,
      { executors: () => [createUpdateExecutor, deleteExecutor], saveChain: () => saveChain },
      currentEtag === undefined
    )
  );

  try {
    // Step 1: Process CREATE/UPDATE via event-driven DAG dispatch.
    // A node starts as soon as ALL of its dependencies are completed, rather
    // than waiting for an entire "level" of unrelated siblings to finish.
    const createUpdateIds: string[] = [];
    for (const [id, change] of changes.entries()) {
      if (deleteChanges.has(id)) continue;
      if (change.changeType === 'NO_CHANGE') continue;
      createUpdateIds.push(id);
    }

    if (createUpdateIds.length > 0) {
      engine.logger.info(
        safeMsg`${cyan('Deploying')} ${cyan(createUpdateIds.length)} resource(s) (DAG: ${executionLevels.length} levels, max parallel: ${concurrency})`
      );

      const createUpdates = new DagExecutor<ResourceChange>(phaseScope);
      createUpdateExecutor = createUpdates;
      const provisionable = new Set(createUpdateIds);
      // Only deps that are themselves being provisioned in this phase are
      // carried, but a NO_CHANGE dep is walked THROUGH to the provisioned ones
      // behind it (#6244): `MyRes` → unchanged provider function → changed
      // `onEvent` function still waits for `onEvent`.
      const createUpdateDeps = nearestMemberDependencies(
        createUpdateIds,
        (id) => engine.dagBuilder.getDirectDependencies(dag, id),
        (id) => provisionable.has(id)
      );
      // go-to-k/cdkd#4227: rows writing the same inline policy name on the same
      // IAM principal run one after another; every other row is untouched. A
      // lost child enqueued later (below) re-puts only its own names onto a
      // principal re-created under the same id, and takes no such edge.
      const levelOf = new Map<string, number>();
      executionLevels.forEach((level, at) => {
        for (const id of level) levelOf.set(id, at);
      });
      for (const { before, after } of orderInlinePolicyWriters({
        writes: createUpdateIds,
        changes,
        templateResources: template.Resources ?? {},
        stateResources: currentState.resources,
        dependencies: createUpdateDeps,
        rank: (id) => levelOf.get(id) ?? Number.MAX_SAFE_INTEGER,
      })) {
        engine.logger.debug(
          safeMsg`${after} waits for ${before}: both write an inline policy name on the same IAM principal`
        );
      }
      for (const id of createUpdateIds) {
        createUpdates.add({
          id,
          dependencies: createUpdateDeps.get(id)!,
          state: 'pending',
          data: changes.get(id)!,
        });
      }

      const provisionNode = (node: { id: string; data: ResourceChange }): Promise<void> =>
        provisionCreateUpdateNode(
          run,
          createUpdates,
          (executor) => enqueueLostChildren(run, executor),
          node
        );

      try {
        await createUpdates.execute(concurrency, provisionNode, () => engine.interrupted);
      } finally {
        // Wait for any pending per-resource state saves before the next phase or
        // before propagating an error — prevents partial-save races.
        await timePhase(phaseScope, 'wait for queued saves (create/update)', () => saveChain);
      }

      // If SIGINT fired AND there is still un-provisioned work (some nodes
      // remained pending because dispatch was cancelled), surface it as an
      // explicit interruption so the catch path saves partial state.
      // If every node already completed before SIGINT landed, treat the deploy
      // as fully successful — matches the prior level-loop's "loop exits, no
      // check" behaviour at the very end of execution.
      if (engine.interrupted && hasPending(createUpdates)) {
        throw new InterruptedError(engine.interruptCause ?? 'user');
      }
    }

    // go-to-k/cdkd#6865: an export reading a custom resource this deploy
    // updated is refused now if its value moved and a consumer outside the run
    // imports it. Inside this `try`, before any DELETE, so the refusal takes
    // the failure path below: the automatic rollback re-sends each custom
    // resource's previous properties (CloudFormation's order: update, then the
    // export check, then the rollback), and `--no-rollback` journals instead.
    await refuseDeferredExportChanges(engine, {
      stackName,
      deferred: deferredExports,
      currentState,
      resolve: (value) => {
        const context = engine.outputsDeps().buildResolverContext(
          {
            template,
            resources: newResources,
            ...(parameterValues && { parameters: parameterValues }),
            ...(conditions && { conditions }),
          },
          stackName
        );
        return engine.resolver.resolve(value, context);
      },
    });

    // Step 2: Process DELETE operations in reverse dependency order.
    if (deleteChanges.size > 0) {
      engine.logger.info(safeMsg`${red('Deleting')} ${red(deleteChanges.size)} resource(s)`);

      const deleteDeps = buildDeletionDependencies(deleteChanges, currentState, engine.logger);
      const deletes = new DagExecutor<ResourceChange>(phaseScope);
      deleteExecutor = deletes;
      for (const id of deleteChanges) {
        deletes.add({
          id,
          dependencies: deleteDeps.get(id) ?? new Set(),
          state: 'pending',
          data: changes.get(id)!,
        });
      }

      try {
        await deletes.execute(
          concurrency,
          async (node) => {
            const logicalId = node.id;
            const change = node.data;

            const previousState = currentState.resources[logicalId]
              ? { ...currentState.resources[logicalId] }
              : undefined;

            let deleteOutcome: ResourceOutcomeSignal | void;
            try {
              deleteOutcome = await timePhase(
                phaseScope,
                'resource delete',
                () =>
                  provisionResource(
                    engine,
                    logicalId,
                    change,
                    newResources,
                    stackName,
                    template,
                    parameterValues,
                    conditions,
                    actualCounts,
                    progress
                  ),
                `${logicalId} ${change.resourceType}`
              );
            } catch (provisionError) {
              engine.interrupted = true;
              engine.interruptCause ??= 'sibling-failure';
              // #1198: a failed DELETE leaves the resource in place — the
              // record documents it in the journal (no revert needed).
              failedOperations.push({
                logicalId,
                changeType: 'DELETE',
                resourceType: change.resourceType,
                provisionedBy: previousState?.provisionedBy,
                ...(previousState && { previousState }),
                physicalId: previousState?.physicalId,
              });
              throw provisionError;
            }

            // Issue #1762: a skipped DELETE is NOT a completed operation.
            // Journaling it would make `cdkd rollback` re-CREATE a resource
            // that was never deleted — colliding on its name at best, and
            // producing a second live copy at worst. The state record was
            // kept, so there is nothing to revert and nothing to persist
            // beyond what is already there.
            if (deleteOutcome) return;

            completedOperations.push({
              logicalId,
              changeType: 'DELETE',
              resourceType: change.resourceType,
              provisionedBy: previousState?.provisionedBy,
              previousState,
            });
            // go-to-k/cdkd#5064 phase 2: the record left the stack (deleted, or
            // kept under Retain), so a later create of its logical id asks for
            // the next generation's name -- never one this copy held. Every save
            // carries the field through `stackInstanceIdCarriedFrom`.
            if (previousState !== undefined && newResources[logicalId] === undefined) {
              Object.assign(
                currentState,
                retiredNameGenerationsAfter(currentState, [{ logicalId, record: previousState }])
              );
            }

            saveStateAfterResource(logicalId);
          },
          () => engine.interrupted
        );
      } finally {
        await timePhase(phaseScope, 'wait for queued saves (delete)', () => saveChain);
      }

      if (engine.interrupted && hasPending(deletes)) {
        throw new InterruptedError(engine.interruptCause ?? 'user');
      }
    }
  } catch (error) {
    // go-to-k/cdkd#5380: again here, for a mark a provider made after its
    // resource's own failure was recorded (the per-resource deadline abandons
    // the call, which may still reach its irreversible write).
    recordUnsettledMarks(engine, newResources);
    warnUnretriedReplacedDeletes(
      engine.replacementRun,
      engine.replacementDeps(),
      engine.interruptCause === 'user' ? 'interrupted' : 'failed'
    );
    // go-to-k/cdkd#6398: the children's queued cleanups never run; the
    // rollback below reverts each child from its journal, re-adopting them.
    nestedCleanups?.abandon(engine.interruptCause === 'user' ? 'interrupted' : 'failed');
    // `initialDeploy` (issue #1183): the failed deploy was the FIRST deploy
    // (no prior state loaded). Captured BEFORE the partial-state save below,
    // which reassigns `currentEtag`. Recorded on the journal segment so
    // `cdkd rollback` deletes state.json entirely once everything is unwound.
    const initialDeploy = currentEtag === undefined;

    await settleFailedDeployRecords(run);
    // go-to-k/cdkd#6343: a sibling write that succeeded before the failure
    // stays under `--no-rollback`; the next deploy no longer sees the change.
    pruneStoppedSiblingMembersBestEffort(
      engine.logger,
      currentState.resources,
      newResources,
      engine.replacementRun,
      template
    );

    // Save partial state BEFORE rollback to track all successfully provisioned
    // resources (including those that completed concurrently with the one that
    // failed). This prevents orphaned resources — resources that exist in AWS
    // but not in the state file.
    try {
      const preRollbackState: StackState = {
        version: STATE_SCHEMA_VERSION_CURRENT,
        region: engine.stackRegion,
        stackName: currentState.stackName,
        resources: newResources,
        outputs: currentState.outputs,
        ...exportNamesCarriedFrom(currentState),
        ...skippedOutputsCarriedFrom(currentState),
        ...orphansCarriedFrom(currentState),
        ...stackInstanceIdCarriedFrom(currentState),
        // Issue #2057: the UNION of the pre-deploy snapshot and what THIS
        // session resolved. See `crossStackReadsForPartialSave` — writing the
        // snapshot alone left a failed deploy's persisted record denying a
        // cross-stack read its own resources were built from.
        ...crossStackReadsForPartialSave(
          currentState,
          engine.recordedImports,
          engine.recordedOutputReads,
          engine.crossStackReadKeyNormalizer()
        ),
        lastModified: Date.now(),
      };
      const migrate = pendingMigration;
      const expectedEtag = migrate ? undefined : currentEtag;
      currentEtag = await engine.stateBackend.saveState(
        stackName,
        engine.stackRegion,
        engine.withParentInfo(preRollbackState),
        { ...(expectedEtag !== undefined && { expectedEtag }), migrateLegacy: migrate }
      );
      if (migrate) pendingMigration = false;
      engine.logger.debug('Partial state saved before rollback (orphaned resource tracking)');
    } catch (saveError) {
      engine.logger.warn(
        safeMsg`Failed to save partial state before rollback: ${asIsMessage(describeAwsFailure(saveError).detail)}`
      );
    }

    // go-to-k/cdkd#6894: a force-quit flush that already started writes this
    // run's segment; a second one would replay the same operations twice.
    if (forceQuit.takeOver()) {
      await rollbackFailedDeploy(run, error, initialDeploy, currentEtag);
    }

    throw error;
  }

  // Resolve outputs. Under --strict-getatt an unresolvable Output makes
  // resolveOutputs THROW (instead of warn-and-skip). By this point EVERY
  // resource operation already succeeded in AWS, and the throw would
  // propagate through doDeploy's catch-less try — skipping the final
  // saveState. On a FIRST deploy `currentEtag` is undefined so the
  // incremental per-resource saves were no-ops too: rethrowing without a
  // save would leave every created resource invisible to cdkd (no state,
  // no rollback; a re-run collides with "already exists"). Persist the
  // provisioning result FIRST, then rethrow so the deploy still fails
  // (review blocker on issue #1111 item 2).
  let outputs: Record<string, unknown>;
  try {
    // ONE drain budget for the whole pass, not one per output (issue
    // #2563). `resolveOutputs` walks `template.Outputs` sequentially and
    // calls `resolve` per output, so without this the DRAIN GRACE spendable
    // here -- after every resource exists in AWS, before `saveState`, with
    // the S3 lock held -- was `#outputs x` the cap rather than the cap, and
    // CloudFormation allows 200 outputs. It bounds the GRACE, not the pass:
    // the cap arms on a rejection, so a lookup that hangs without one is as
    // unbounded here as it ever was. The trade the wrap makes is on
    // `withSharedDrainBudget`.
    outputs = await withSharedDrainBudget(() =>
      resolveOutputs(
        engine.outputsRun,
        engine.outputsDeps(),
        template,
        newResources,
        stackName,
        outputsDigestSource,
        parameterValues,
        conditions
      )
    );
    // Redact resolved secrets out of outputs before they flow to the exports
    // index / deploy summary / state (GHSA fix). The state save
    // (`withParentInfo`), the exports-index `updateForStack` and
    // `buildDisplayOutputs` each redact this bag again when they read it
    // (issue #2814). `redactOutputs` folds the outputs pass map into
    // `engine.outputsRun.outputSecrets` — the outputs' own substituted
    // references — and `resolveOutputs` filled `engine.outputsRun.outputsTemplateSource`
    // with the unresolved values that position
    // them (#1910).
    const resolvedOutputsBeforeRedaction = outputs;
    outputs = redactOutputs(engine.maskingDeps(), outputs);
    // Issue #2274: remember, FOR THIS PROCESS ONLY, the plaintext behind any
    // output the redaction just replaced with the mask. Every cross-stack
    // route — a nested stack's `Outputs.<Key>`, `Fn::ImportValue`,
    // `Fn::GetStackOutput` — reads the producer's PERSISTED outputs, so
    // without this the first deploy of a consumer whose producer exports a
    // `NoEcho` custom-resource value would land on `***` and be refused: a
    // template that deployed before this feature. See
    // `recoverableMaskedOutputs` for why the key is a COORDINATE and not a
    // bare plaintext.
    // ONE call site, and it is here: an output that a LATER `redactOutputs`
    // newly masks — one folding in a needle a part recorded after this
    // point (issue #2814) — never enters the recoverable store. An
    // in-process cross-stack consumer of that output is then refused on
    // `***` instead of being served the plaintext, which is the fail-safe
    // direction and the reason this is stated rather than fixed.
    rememberRecoverableMaskedOutputs(
      engine.maskingDeps(),
      stackName,
      resolvedOutputsBeforeRedaction,
      outputs
    );
  } catch (outputError) {
    // go-to-k/cdkd#6894: journaled below, unless a force-quit flush did.
    const journalHere = forceQuit.takeOver();
    // go-to-k/cdkd#6398: the cleanup phase runs only once the outputs
    // resolved, so the journal written below never sits over deletes already
    // made; the deferred deletes are left for a rollback or the next deploy.
    warnUnretriedReplacedDeletes(engine.replacementRun, engine.replacementDeps(), 'failed');
    nestedCleanups?.abandon('failed');
    // go-to-k/cdkd#6343: every provider call succeeded, so each stopped write did.
    pruneStoppedSiblingMembersBestEffort(
      engine.logger,
      currentState.resources,
      newResources,
      engine.replacementRun,
      template
    );
    await persistStateAfterOutputFailure(
      engine,
      stackName,
      currentState,
      newResources,
      currentEtag,
      pendingMigration
    );
    // Every resource op succeeded here — provisioning was clean, only
    // output resolution failed — so rolling back is a legitimate use case
    // (issue #1183). Record a journal segment so `cdkd rollback` can revert.
    if (journalHere) {
      await writeRollbackJournalSegment(
        engine.rollbackDeps(),
        stackName,
        completedOperations,
        failedOperations,
        'no-rollback-failure',
        currentEtag === undefined
      );
    }
    throw outputError;
  }

  // The record a successful deploy returns, built after the cleanup phase
  // (whose drops it carries through `stackInstanceIdCarriedFrom`); also what
  // a cleanup phase that threw persists, as every output already resolved.
  const successState = (): StackState => ({
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: engine.stackRegion,
    stackName: currentState.stackName,
    resources: newResources,
    ...orphansCarriedFrom(currentState),
    ...stackInstanceIdCarriedFrom(currentState),
    outputs,
    // Always written, `[]` included: on this path the bag was re-resolved,
    // so the set is KNOWN (issue #2193). Absent would read as "not known".
    exportNames: [...engine.outputsRun.resolvedExportNames],
    // This pass's skipped set, omitted when empty (issue #2740). Copied,
    // like the `exportNames` / `imports` spreads beside it.
    ...(engine.outputsRun.skippedOutputs && {
      skippedOutputs: { ...engine.outputsRun.skippedOutputs },
    }),
    ...(engine.recordedImports.length > 0 && { imports: [...engine.recordedImports] }),
    ...(engine.recordedOutputReads.length > 0 && {
      outputReads: [...engine.recordedOutputReads],
    }),
    lastModified: Date.now(),
  });

  // go-to-k/cdkd#6894: every operation and output landed. The cleanup phase
  // below deletes superseded resources, which a segment written over it would
  // not describe, so a force-quit from here on journals nothing, as before;
  // one whose flush already started stops this run before any delete.
  if (!forceQuit.takeOver()) throw new InterruptedError('user');

  // go-to-k/cdkd#4900: CloudFormation's cleanup phase, for the deletes a
  // still-unupdated dependent refused inside the DAG. After the outputs
  // resolved (go-to-k/cdkd#6398): an output failure writes a rollback journal
  // segment, which must not describe deletes already made.
  if (engine.interrupted) {
    warnUnretriedReplacedDeletes(engine.replacementRun, engine.replacementDeps(), 'interrupted');
    nestedCleanups?.abandon('interrupted');
  } else {
    // go-to-k/cdkd#5111: a deploy that deleted or replaced anything may have
    // just removed what used a carried entry (a deleted load balancer's
    // listeners go asynchronously), so it waits out an "in use" refusal as
    // its own retry does; any other deploy sends once.
    const releasedSomething =
      deleteChanges.size > 0 ||
      completedOperations.some(
        (op) =>
          op.changeType === 'UPDATE' &&
          op.previousState !== undefined &&
          op.physicalId !== undefined &&
          op.physicalId !== op.previousState.physicalId
      );
    const cleanup = (
      carried: readonly SupersededResourceRecord[],
      counts: { updated: number; updatePartial: number }
    ): Promise<void> =>
      runCleanupPhase(engine, {
        stackName,
        counts,
        completedOperations,
        host: currentState,
        carried,
        resources: newResources,
        releasedSomething,
      });
    // go-to-k/cdkd#6398: the ROOT runs its descendants' queued passes first,
    // in the order they finished, then its own: a child's old resource goes
    // before the parent's old resource it used (an old instance before the
    // old subnet a parameter handed it), dependents first as within a stack.
    if (nestedCleanups !== undefined) {
      const { updatePartial } = await nestedCleanups.runAll(
        { interrupted: () => engine.interrupted },
        engine.logger
      );
      actualCounts.updatePartial += updatePartial;
      actualCounts.nestedUpdatePartial += updatePartial;
    }
    // A nested child's cleanup waits for the ROOT deploy's success instead.
    const queued = queueNestedCleanup(engine, stackName, currentState, (stillOwed, counts) =>
      cleanup(carriedSuperseded.filter(stillOwed), counts)
    );
    if (queued) {
      engine.logger.debug(
        safeMsg`Cleanup of ${stackName} waits for the root stack's deploy to succeed`
      );
    } else {
      try {
        await cleanup(carriedSuperseded, actualCounts);
      } catch (cleanupError) {
        // A pass that threw fails the deploy as it did inside the DAG, but
        // every change and output landed, so it ends as an output failure
        // does: state persisted, a journal segment for `cdkd rollback`
        // carrying each op's re-stamped verdict, no automatic rollback.
        warnUnretriedReplacedDeletes(engine.replacementRun, engine.replacementDeps(), 'failed');
        await persistStateAfterOutputFailure(
          engine,
          stackName,
          currentState,
          newResources,
          currentEtag,
          pendingMigration,
          // The outputs resolved: the record carries them, not the previous
          // deploy's, which may name an old resource the pass deleted.
          { state: successState, after: 'the cleanup phase failed' }
        );
        await writeRollbackJournalSegment(
          engine.rollbackDeps(),
          stackName,
          completedOperations,
          failedOperations,
          'no-rollback-failure',
          currentEtag === undefined
        );
        throw cleanupError;
      }
    }
  }

  // go-to-k/cdkd#6308: a record no provider call rewrote (a NO_CHANGE row, a
  // DependsOn-only change) takes today's dependencies, so destroy orders by
  // the template this deploy left in place. Success only, and removals only
  // in a nested child, whose operations a failed parent reverts: see the helper.
  Object.assign(
    newResources,
    withTemplateDependencies(newResources, template, {
      removalsOnly: engine.options.parentStackInfo !== undefined,
    })
  );

  return {
    state: successState(),
    actualCounts,
    completedOperations,
  };
}

/**
 * Persist state after provisioning fully succeeded but output resolution
 * threw (only reachable under `--strict-getatt`, whose promotion fires
 * AFTER the rollback catch block). The persisted shape mirrors the
 * success-path state EXCEPT for outputs:
 *
 * - `resources`: this run's provisioning result (`newResources`) — every
 *   create/update/delete landed in AWS, so state must record it.
 * - `imports` / `outputReads`: this run's `recordedImports` /
 *   `recordedOutputReads` (the provisioning that produced them succeeded;
 *   dropping them would desync the strong-reference records from AWS —
 *   matters on the update-deploy path where the pre-deploy snapshot may
 *   be stale).
 * - `outputs`: the PREVIOUSLY persisted map — resolveOutputs threw before
 *   producing a new one, mirroring what a resource-failure persist keeps.
 *   The exports index is deliberately NOT updated (it stays consistent
 *   with the old outputs that remain in state).
 *
 * ETag handling mirrors the post-rollback save: expected-ETag first (or
 * unconditional when `pendingMigration` — same as the per-resource save),
 * then a fresh-ETag retry, then warn. Best-effort: the deploy error being
 * rethrown is the primary signal; a failed save only warns.
 */
export async function persistStateAfterOutputFailure(
  engine: DeployEngine,
  stackName: string,
  currentState: StackState,
  newResources: Record<string, ResourceState>,
  currentEtag: string | undefined,
  pendingMigration: boolean,
  /**
   * go-to-k/cdkd#6398: a cleanup phase that threw after the outputs resolved
   * persists the success-path record (`state`) instead, under its own wording.
   */
  override?: { state: () => StackState; after: string }
): Promise<void> {
  const after = override?.after ?? 'output resolution failure';
  const buildState =
    override?.state ??
    ((): StackState => ({
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: engine.stackRegion,
      stackName: currentState.stackName,
      resources: newResources,
      outputs: currentState.outputs,
      ...exportNamesCarriedFrom(currentState),
      ...skippedOutputsCarriedFrom(currentState),
      ...orphansCarriedFrom(currentState),
      ...stackInstanceIdCarriedFrom(currentState),
      // Issue #2057: the UNION, like every other non-success save. This one
      // used to write `[...engine.recordedImports]` WHOLESALE, copying the
      // SUCCESS path's shape onto a path that is not one — provisioning
      // succeeded, but output resolution threw, and the caller writes a
      // rollback journal segment and rethrows, so `cdkd rollback` reads
      // exactly this record. A deploy that no longer re-resolves a
      // cross-stack read (the reference moved, or the resource holding it had
      // no diff this run) therefore came through here with an EMPTY
      // `recordedOutputReads`, the field was omitted, and the producer region
      // the previous record carried was erased from under a
      // `properties.Value` that still holds the producer's region-less
      // spelling. `producerRegionsFromState` then returned `[]` and the replay
      // resolved it locally.
      ...crossStackReadsForPartialSave(
        currentState,
        engine.recordedImports,
        engine.recordedOutputReads,
        engine.crossStackReadKeyNormalizer()
      ),
      lastModified: Date.now(),
    }));
  try {
    const expectedEtag = pendingMigration ? undefined : currentEtag;
    await engine.stateBackend.saveState(
      stackName,
      engine.stackRegion,
      engine.withParentInfo(buildState()),
      {
        ...(expectedEtag !== undefined && { expectedEtag }),
        migrateLegacy: pendingMigration,
      }
    );
    engine.logger.debug(safeMsg`State saved after ${after}`);
  } catch (saveError) {
    engine.logger.debug(
      safeMsg`Retrying state save after ${after} (ETag mismatch): ${asIsMessage(describeAwsFailure(saveError).detail)}`
    );
    try {
      const freshState = await engine.stateBackend.getState(stackName, engine.stackRegion);
      const freshEtag = freshState?.etag;
      await engine.stateBackend.saveState(
        stackName,
        engine.stackRegion,
        engine.withParentInfo(buildState()),
        {
          ...(freshEtag !== undefined && { expectedEtag: freshEtag }),
        }
      );
      engine.logger.debug(safeMsg`State saved after ${after} (retry succeeded)`);
    } catch (retryError) {
      engine.logger.warn(
        safeMsg`Failed to save state after ${after}: ${asIsMessage(describeAwsFailure(retryError).detail)} — resources were provisioned but not recorded; run deploy again to reconcile.`
      );
    }
  }
}
