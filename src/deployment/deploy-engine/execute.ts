import { hasNoCloudControlHandlers } from '../../provisioning/unsupported-types.js';
import {
  currentNameGeneration,
  getCurrentStackInstanceId,
} from '../../provisioning/resource-name.js';
import { ccBrokenReason } from '../../provisioning/provider-registry.js';
import {
  lostChildActions,
  noChangeChildrenOfRecreatedParents,
  survivesParent,
} from '../child-of-recreated-parent.js';
import { shownType } from '../recreate-target-readers.js';
import { redactOutputs, rememberRecoverableMaskedOutputs } from './masking.js';
import { phaseScopeForStack, timePhase } from '../../utils/phase-timings.js';
import {
  performRollback,
  recoveryHint,
  settleJournalAfterCleanRollback,
  settleNestedChildrenAfterCleanRollback,
  writeRollbackJournalSegment,
} from './rollback.js';
import { retryDeferredReplacedDeletes, warnUnretriedReplacedDeletes } from './replacement.js';
import { retryCarriedSupersededResources } from './superseded-retry.js';
import { secretNameBagFor } from './masking.js';
import { withPrintingSecrets } from '../resource-secrets-scope.js';
import { unionOfSecretBags } from '../secret-redaction.js';
import { orphanRecordsPrintingBag } from '../secret-name-needles.js';
import {
  isSupersededHeldBySameType,
  removeSuperseded,
  supersededAfterRollback,
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
import { isInterruptedWaitError } from '../../provisioning/interrupt-watch.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import {
  type ResourceChange,
  type ResourceState,
  STATE_SCHEMA_VERSION_CURRENT,
  type StackOrphanRecord,
  type StackState,
  type SupersededResourceRecord,
  exportNamesCarriedFrom,
  stackInstanceIdCarriedFrom,
  orphansAfterRollback,
  orphansCarriedFrom,
  skippedOutputsCarriedFrom,
} from '../../types/state.js';
import { cyan, red } from '../../utils/colors.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { asIsMessage, safeMsg } from '../../utils/display-safe.js';
import { pasteableCommand } from '../../utils/pasteable-command.js';
import { DagExecutor } from '../dag-executor.js';
import { buildDeletionDependencies, hasPending } from './dependencies.js';
import { extractTemplateAttributes, withPropertiesMarksOf } from './record-shape.js';
import { orderInlinePolicyWriters } from '../inline-policy-claims.js';
import { withSharedDrainBudget } from '../drain-budget.js';
import type { SettledNestedRows } from '../nested-child-journal.js';
import type { CompletedOperation, FailedOperation } from '../rollback-executor.js';
import { isRefusedBeforeApplying } from '../prior-attempt-scope.js';
import { isReplacementNameRefusal } from './name-collision.js';
import { abandonedRequestOf } from '../../provisioning/wait-abandoned.js';
import {
  createdBeforeFailure,
  createdResourceIdentityBeforeFailure,
} from '../../provisioning/auxiliary-failure.js';
import {
  CreatedResourceSink,
  collectCreatedResources,
} from '../../provisioning/created-resource-sink.js';
import { ResourceTimeoutError } from '../../utils/error-handler.js';
import { orphanNeedsIdentity, readResourceIdentity } from '../rollback-executor/orphan-identity.js';
import { deployStackRecordsView, type InFlightWrite } from '../stack-records-scope.js';
import { resolveOutputs } from './outputs.js';
import { provisionResource } from './provision.js';
import {
  unsettledItemsTopKey,
  withUnsettledItems,
  withUnsettledProperties,
} from '../../state/unsettled-properties.js';
import {
  retiredAfterRollback,
  type RolledBackCreate,
  retiredNameGenerationsAfter,
  withNameGenerationReached,
} from '../../state/name-generation.js';

/** go-to-k/cdkd#4604: types whose replacement's new resource is never journaled (see execute). */
const NO_REPLACEMENT_ORPHAN_TYPES: ReadonlySet<string> = new Set([
  'AWS::CloudFormation::Stack',
  'AWS::SQS::QueuePolicy',
  'AWS::SNS::TopicPolicy',
]);

/**
 * Execute deployment by processing resources via event-driven DAG dispatch.
 *
 * - CREATE/UPDATE follow forward dependency order (a node starts as soon as
 *   ALL of its dependencies are completed — does not wait for unrelated
 *   siblings in the same "level")
 * - DELETE follows reverse dependency order (a node starts as soon as all
 *   resources that depend ON it have finished deleting)
 */
export async function executeDeployment(
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
  migrationPending = false
): Promise<{
  state: StackState;
  actualCounts: ProvisionCounts;
  /** Issue #3754: journaled by a NESTED engine on success. */
  completedOperations: CompletedOperation[];
}> {
  const concurrency = engine.options.concurrency!;
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
      } catch (error) {
        engine.logger.warn(
          safeMsg`Failed to save state after ${savedFor}: ${asIsMessage(describeAwsFailure(error).detail)}`
        );
      }
    });
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
    () => [...inFlightWrites.values()].map(({ write }) => write)
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

      const createUpdateExecutor = new DagExecutor<ResourceChange>(phaseScope);
      const provisionable = new Set(createUpdateIds);
      const createUpdateDeps = new Map<string, Set<string>>();
      for (const id of createUpdateIds) {
        const allDeps = engine.dagBuilder.getDirectDependencies(dag, id);
        // Only carry deps that are themselves being provisioned in this phase;
        // NO_CHANGE / DELETE / non-DAG deps are already satisfied.
        createUpdateDeps.set(id, new Set(allDeps.filter((d) => provisionable.has(d))));
      }
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
        createUpdateExecutor.add({
          id,
          dependencies: createUpdateDeps.get(id)!,
          state: 'pending',
          data: changes.get(id)!,
        });
      }

      // go-to-k/cdkd#4444: a resource re-created under the same id by the
      // update-failure fallback (`ResourceUpdateNotSupportedError` -> delete,
      // create) took what AWS stored inside it along, but the diff never
      // promoted its readers -- the parent was an in-place UPDATE row -- so
      // such a child is a `NO_CHANGE` row no executor holds. Each is turned
      // into an UPDATE the engine re-creates (or re-puts) through the same
      // lost-child arm, and added to the RUNNING executor as soon as its
      // parent completes, so it is restored in DAG order right after the
      // parent, as the replacement arm's children are, rather than after
      // every other node (a later sibling's failure would then have left it
      // missing). A pending node that reads it now waits for it; one already
      // dispatched resolved its old id (harmless while the re-created child
      // keeps its id: the name-addressed children the fallback reaches today,
      // a log group's streams and filters).
      const enqueueLostChildren = (executor: DagExecutor<ResourceChange>): void => {
        const lostIds = noChangeChildrenOfRecreatedParents({
          changes,
          skip: deleteChanges,
          templateResources: template.Resources ?? {},
          recreatedUnderSameId: engine.replacementRun.recreatedUnderSameId,
          recordedTypeOf: (id) =>
            Object.hasOwn(newResources, id) ? newResources[id]?.resourceType : undefined,
          conditions,
        });
        for (const id of lostIds) {
          const change = changes.get(id)!;
          change.changeType = 'UPDATE';
          change.propertyChanges = [];
          engine.logger.info(
            survivesParent(change.resourceType)
              ? safeMsg`  ${id} was attached to a resource the update-failure fallback re-created under the same name: attaching it again`
              : safeMsg`  ${id} went with a resource the update-failure fallback re-created under the same id: re-creating it`
          );
        }
        if (progress) progress.total += lostIds.length;
        for (const id of lostIds) {
          executor.add({
            id,
            dependencies: new Set(
              engine.dagBuilder.getDirectDependencies(dag, id).filter((d) => executor.has(d))
            ),
            state: 'pending',
            data: changes.get(id)!,
          });
        }
        for (const node of executor.values()) {
          if (node.state !== 'pending') continue;
          for (const dep of engine.dagBuilder.getDirectDependencies(dag, node.id)) {
            if (lostIds.includes(dep)) node.dependencies.add(dep);
          }
        }
      };

      const provisionNode = async (node: { id: string; data: ResourceChange }): Promise<void> => {
        const logicalId = node.id;
        const change = node.data;

        const previousState = currentState.resources[logicalId]
          ? { ...currentState.resources[logicalId] }
          : undefined;

        if (change.changeType === 'UPDATE') startedUpdates.add(logicalId);
        let settle!: (ok: boolean) => void;
        const settled = new Promise<boolean>((resolve) => {
          settle = resolve;
        });
        inFlightWrites.set(logicalId, {
          write: {
            logicalId,
            resourceType: change.resourceType,
            properties: () => engine.attemptedResolvedProps.get(logicalId),
            settled,
          },
          settle,
        });
        // Settled on EVERY exit (a `finally`), so a twin waiting on this write
        // can never hang on bookkeeping that throws below.
        let succeeded = false;
        // go-to-k/cdkd#5511: what this operation's provider reported its create
        // call made, for when the deadline fires: it rejects while the
        // provider keeps running and drops the error its
        // `markCreatedBeforeFailure` would have carried. Read when the failure
        // is saved (`settleReportedCreates`). Fresh per operation;
        // its retries share it, as they share the carried mark.
        const createdSink = new CreatedResourceSink(logicalId, change.resourceType);
        try {
          try {
            await timePhase(
              phaseScope,
              `resource ${change.changeType.toLowerCase()}`,
              () =>
                collectCreatedResources(createdSink, () =>
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
                  )
                ),
              `${logicalId} ${change.resourceType}`
            );
            // Before the settle: an UPDATE twin re-asked after it is settled.
            settledUpdates.add(logicalId);
            succeeded = true;
          } finally {
            inFlightWrites.delete(logicalId);
            settle(succeeded);
          }
        } catch (provisionError) {
          // Signal interruption so that long-running operations (e.g., CloudFront
          // waitForDeployed) in sibling tasks abort promptly instead of blocking
          // until their own polling timeouts fire.
          engine.interrupted = true;
          engine.interruptCause ??= 'sibling-failure';
          // go-to-k/cdkd#5380: before any later save, so a sibling's
          // per-resource save already persists what this update left
          // unsettled. Only the in-place UPDATE path marks.
          if (change.changeType === 'UPDATE') recordUnsettledMarks(engine, newResources, logicalId);
          // #1198: journal the failed op's pre-op state + attempted
          // properties so `cdkd rollback --revert-failed` can act on it.
          //
          // go-to-k/cdkd#4356: except a CREATE refused before anything was
          // applied that recorded no physical id. There is nothing of this
          // stack's to revert, and the record could only say "delete it
          // manually" about the resource that refused it — another owner's.
          const refused = isRefusedBeforeApplying(provisionError, logicalId);
          // go-to-k/cdkd#5064: a replacement refused before applying (the
          // generated-name guard's refusal included) or on its name made nothing
          // under the generation it asked for, so that generation is neither
          // journaled as reached nor raised past: the retry asks for the name
          // the refusal names (and its `cdkd import` advice adopts).
          const attemptedGeneration =
            change.changeType === 'UPDATE' &&
            !refused &&
            !isReplacementNameRefusal(provisionError, logicalId)
              ? engine.replacementRun.attemptedNameGeneration.get(logicalId)
              : undefined;
          const statePhysicalId = newResources[logicalId]?.physicalId ?? previousState?.physicalId;
          if (refused && change.changeType === 'CREATE' && statePhysicalId === undefined) {
            throw provisionError;
          }
          // go-to-k/cdkd#1710: a CREATE whose provider PROVED its create call
          // returned before the failure. The resource exists, no state record
          // holds it, and this journal entry is the only record of it — so it
          // carries the id, its provenance and the template's DeletionPolicy
          // for `--revert-failed`. Only the provider's mark proves it:
          // `ProvisioningError.physicalId` also names resources a create
          // collided with or never made. Only SDK providers mark (the Cloud
          // Control route deletes its own remnant), hence the route. A refused
          // CREATE with no state id never reaches here (thrown above).
          const markedCreatedId = createdBeforeFailure(
            provisionError,
            logicalId,
            change.resourceType
          );
          const createdId =
            change.changeType === 'CREATE' && statePhysicalId === undefined
              ? markedCreatedId
              : undefined;
          // go-to-k/cdkd#4604: the same proof on a REPLACEMENT — the UPDATE
          // above names the resource being replaced, and the new one its
          // create made is recorded nowhere else. Journaled beside it as a
          // proven orphan of the same logical id, naming the replaced record
          // so the classifier does not read that record as a later owner.
          // Not on a nested-stack row: a grandchild stack sharing its logical
          // id and type marks its own create, which its own journal records,
          // and this row's replacement keeps its physical id. Not on a policy
          // attachment whose id is its comma-joined targets: a new id can
          // share targets with the replaced record, so deleting it would clear
          // the old one's (neither type is replaced today).
          const heldRecord = newResources[logicalId] ?? previousState;
          const replaced =
            change.changeType === 'UPDATE' &&
            !NO_REPLACEMENT_ORPHAN_TYPES.has(change.resourceType) &&
            statePhysicalId !== undefined &&
            statePhysicalId !== '' &&
            // False only for a running record with no physical id, where
            // `statePhysicalId` fell back to the pre-deploy record's: no single
            // record is then the one being replaced.
            heldRecord?.physicalId === statePhysicalId
              ? heldRecord
              : undefined;
          const replacementCreatedId = replaced ? markedCreatedId : undefined;
          const orphanedBy =
            replaced !== undefined &&
            replacementCreatedId !== undefined &&
            replacementCreatedId !== replaced.physicalId
              ? { record: replaced, createdId: replacementCreatedId }
              : undefined;
          // go-to-k/cdkd#3252: a Cloud Control CREATE whose wait was
          // abandoned may still make its resource. Its token is journaled so
          // the next deploy, destroy or rollback re-polls it, with the policy
          // a resource it turns out to have made is deleted under.
          const abandoned =
            change.changeType === 'CREATE' &&
            statePhysicalId === undefined &&
            createdId === undefined
              ? abandonedRequestOf(provisionError)
              : undefined;
          // The parser refuses any other token shape, and an unreadable
          // journal would cost every entry, so an odd one is not journaled.
          const pendingRequest =
            abandoned?.operation === 'CREATE' &&
            /^[-A-Za-z0-9+/=]{1,128}$/.test(abandoned.requestToken)
              ? { requestToken: abandoned.requestToken, abandonedAt: Date.now() }
              : undefined;
          const failedOp: FailedOperation = {
            logicalId,
            changeType: change.changeType as 'CREATE' | 'UPDATE',
            resourceType: change.resourceType,
            provisionedBy:
              createdId !== undefined
                ? 'sdk'
                : pendingRequest !== undefined
                  ? 'cc-api'
                  : (newResources[logicalId]?.provisionedBy ?? previousState?.provisionedBy),
            ...(pendingRequest !== undefined && {
              pendingCloudControlRequest: pendingRequest,
              deletionPolicy: journaledOrphanPolicy(
                extractTemplateAttributes(template, logicalId).deletionPolicy
              ),
            }),
            ...(previousState && { previousState }),
            physicalId: createdId ?? statePhysicalId,
            ...(createdId !== undefined && {
              physicalIdRecoveredFromError: true,
              deletionPolicy: journaledOrphanPolicy(
                extractTemplateAttributes(template, logicalId).deletionPolicy
              ),
            }),
            // go-to-k/cdkd#4355: a failed op whose attempted bag is
            // provably not this stack's resource (a refusal, or a write AWS
            // definitely rejected) journals no attempted bag. The bag is what a later deploy
            // reads as "this stack attempted that resource"
            // (`priorAttemptsInJournal`), and `--revert-failed` reverts an
            // UPDATE FROM it — both would then act on a resource the
            // refusal found belonging to someone else.
            // The UPDATE says so itself, so it never reads as a revert of
            // the old resource even once its orphan's entry is gone (an
            // interrupted rollback can settle one and not the other).
            // go-to-k/cdkd#4690: the old resource is gone even when the create
            // made nothing, which `replacementOrphaned` cannot say.
            ...(change.changeType === 'UPDATE' &&
              engine.replacementRun.oldDeletedBeforeCreate.has(logicalId) && {
                oldDeletedBeforeCreate: true,
              }),
            // go-to-k/cdkd#5064 phase 2: the generation the failed replacement
            // asked for, which `--revert-failed` records as reached; on a
            // CREATE, the one its name was derived at, which the settle of an
            // abandoned Cloud Control create recognizes that name by.
            ...(attemptedGeneration !== undefined && {
              nameGeneration: attemptedGeneration,
            }),
            ...(change.changeType === 'CREATE' &&
              getCurrentStackInstanceId() !== undefined && {
                nameGeneration: currentNameGeneration(logicalId) ?? 0,
              }),
            ...(orphanedBy !== undefined && {
              replacementOrphaned: engine.replacementRun.oldDeletedBeforeCreate.has(logicalId)
                ? ('delete-first' as const)
                : ('create-first' as const),
            }),
            ...(!refused && {
              attemptedProperties: engine.attemptedResolvedProps.get(logicalId),
            }),
          };
          failedOperations.push(failedOp);
          // go-to-k/cdkd#5064 phase 2: the failed replacement's create may have
          // made a resource under the generation it asked for. The record moves
          // past it however the failure is then rolled back (or left), so no
          // retry asks for that name again. A killed deploy never reaches here:
          // its re-run derives the same generation and meets its own resource.
          const heldNow = newResources[logicalId];
          if (attemptedGeneration !== undefined && heldNow !== undefined) {
            newResources[logicalId] = withNameGenerationReached(
              heldNow,
              logicalId,
              attemptedGeneration
            );
          }
          let replacementOrphanOp: FailedOperation | undefined;
          if (orphanedBy !== undefined) {
            replacementOrphanOp = replacementOrphanOpFor(
              engine,
              template,
              logicalId,
              change.resourceType,
              orphanedBy.record,
              orphanedBy.createdId,
              refused
            );
            failedOperations.push(replacementOrphanOp);
          }
          // go-to-k/cdkd#5511: this operation's deadline fired, which drops the
          // provider's later (marked) error, so what the provider reported to
          // `createdSink` when its create call returned stands in for the mark.
          // Read when the failure is persisted (`settleReportedCreates`), not
          // here: the abandoned call may still report (a create returning late)
          // or retract (its cleanup deleting what it made). Any other error is
          // the provider's own, whose mark, or deliberate lack of one, stays
          // the only proof.
          if (
            markedCreatedId === undefined &&
            ((change.changeType === 'CREATE' && statePhysicalId === undefined) ||
              replaced !== undefined) &&
            deadlineFiredFor(provisionError, logicalId)
          ) {
            reportedCreatesToSettle.push({
              sink: createdSink,
              failedOp,
              ...(replaced !== undefined && { replaced }),
              refused,
            });
          }
          // go-to-k/cdkd#4655: the token naming the resource just made.
          const orphanOp = createdId !== undefined ? failedOp : replacementOrphanOp;
          if (orphanOp !== undefined) {
            await journalOrphanIdentity(
              engine,
              orphanOp,
              createdResourceIdentityBeforeFailure(provisionError, logicalId, change.resourceType)
            );
          }
          throw provisionError;
        }

        completedOperations.push({
          logicalId,
          changeType: change.changeType as 'CREATE' | 'UPDATE',
          resourceType: change.resourceType,
          // Snapshot the routing layer just landed on the resource
          // (CREATE = the auto-route decision; UPDATE = the state's
          // sticky / re-evaluated layer). Threads into rollback so a
          // CC-routed CREATE rolls back via the CC delete path —
          // closing the silent-data-corruption hazard the v7 schema
          // bump was designed to prevent.
          provisionedBy: newResources[logicalId]?.provisionedBy ?? previousState?.provisionedBy,
          previousState,
          physicalId: newResources[logicalId]?.physicalId,
          properties: newResources[logicalId]?.properties,
          // Issue #2603: the retain verdict this deploy ACTED ON, so the
          // rollback classifier stops re-deriving it from
          // `previousState.updateReplacePolicy` — a different source
          // that disagrees on exactly the deploy which adds or drops the
          // attribute. Stamped on every UPDATE, including a `false` for
          // a replacement that deleted the old resource: an ABSENT field
          // is what a pre-#2603 journal looks like, and the classifier
          // falls back to the old (wrong) read for those, so recording
          // only the `true` case would leave the DROP direction live.
          ...(change.changeType === 'UPDATE' && {
            oldResourceRetained: engine.replacementRun.retainedOldOnReplacement.has(logicalId),
            // go-to-k/cdkd#4690: the reversal deletes the new resource first
            // when the forward deleted the old one first.
            oldDeletedBeforeCreate: engine.replacementRun.oldDeletedBeforeCreate.has(logicalId),
          }),
          // go-to-k/cdkd#2631: the cleanup delete did not confirm the old
          // resource gone, so the rollback reads AWS before re-creating it.
          ...(change.changeType === 'UPDATE' &&
            engine.replacementRun.replacedOldMaySurvive.has(logicalId) && {
              oldResourceMaySurvive: engine.replacementRun.replacedOldMaySurvive.get(logicalId),
            }),
          // go-to-k/cdkd#4615: the provider's own answer, where an `update()`
          // gave one; absent, the rollback infers a replacement from a changed
          // physical id, as it does for a journal an older binary wrote.
          ...(change.changeType === 'UPDATE' &&
            engine.replacementRun.updateWasReplaced.has(logicalId) && {
              wasReplaced: engine.replacementRun.updateWasReplaced.get(logicalId),
            }),
          // Issue #2668: `resourceType` above is the TEMPLATE's type, so
          // on a Type change the journal would otherwise name only the
          // NEW one and the rollback would re-create the OLD resource
          // through the new type's provider. Stamped on every UPDATE that
          // has a previous record, for the reason `oldResourceRetained`
          // is: ABSENT then means "written by a binary that predates this
          // field" and nothing else.
          ...(change.changeType === 'UPDATE' &&
            previousState !== undefined && {
              previousResourceType: previousState.resourceType,
            }),
          // go-to-k/cdkd#5064 phase 2: a replacement that moved the record to a
          // new name generation; a rollback records it as reached.
          ...(change.changeType === 'UPDATE' &&
            engine.replacementRun.attemptedNameGeneration.has(logicalId) &&
            newResources[logicalId]?.nameGeneration !== undefined && {
              nameGeneration: newResources[logicalId]!.nameGeneration,
            }),
        });

        saveStateAfterResource(logicalId);
        if (engine.replacementRun.recreatedUnderSameId.has(logicalId))
          enqueueLostChildren(createUpdateExecutor);
      };

      try {
        await createUpdateExecutor.execute(concurrency, provisionNode, () => engine.interrupted);
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
      if (engine.interrupted && hasPending(createUpdateExecutor)) {
        throw new InterruptedError(engine.interruptCause ?? 'user');
      }
    }

    // Step 2: Process DELETE operations in reverse dependency order.
    if (deleteChanges.size > 0) {
      engine.logger.info(safeMsg`${red('Deleting')} ${red(deleteChanges.size)} resource(s)`);

      const deleteDeps = buildDeletionDependencies(deleteChanges, currentState, engine.logger);
      const deleteExecutor = new DagExecutor<ResourceChange>(phaseScope);
      for (const id of deleteChanges) {
        deleteExecutor.add({
          id,
          dependencies: deleteDeps.get(id) ?? new Set(),
          state: 'pending',
          data: changes.get(id)!,
        });
      }

      try {
        await deleteExecutor.execute(
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

      if (engine.interrupted && hasPending(deleteExecutor)) {
        throw new InterruptedError(engine.interruptCause ?? 'user');
      }
    }

    // go-to-k/cdkd#4900: CloudFormation's cleanup phase, for the deletes a
    // still-unupdated dependent refused inside the DAG.
    if (engine.interrupted) {
      warnUnretriedReplacedDeletes(engine.replacementRun, engine.replacementDeps(), 'interrupted');
    } else {
      try {
        await retryDeferredReplacedDeletes(
          engine.replacementRun,
          engine.replacementDeps(),
          stackName,
          actualCounts
        );
      } finally {
        // go-to-k/cdkd#2631: the ops were journaled with the FIRST failure's
        // verdict; a retry that failed differently (a waiter that gave up)
        // must not leave a later rollback re-adopting on the first one —
        // nor a retry pass that threw before returning.
        for (const op of completedOperations) {
          if (op.changeType !== 'UPDATE') continue;
          const verdict = engine.replacementRun.replacedOldMaySurvive.get(op.logicalId);
          // A retry that deleted it dropped the verdict: so does the op.
          if (verdict !== undefined) op.oldResourceMaySurvive = verdict;
          else delete op.oldResourceMaySurvive;
        }
      }
      // go-to-k/cdkd#5111: an earlier deploy's, after this deploy's own.
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
      await retryCarriedSupersededResources(engine, currentState, carriedSuperseded, newResources, {
        waitInUse: releasedSomething,
      });
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
    // `initialDeploy` (issue #1183): the failed deploy was the FIRST deploy
    // (no prior state loaded). Captured BEFORE the partial-state save below,
    // which reassigns `currentEtag`. Recorded on the journal segment so
    // `cdkd rollback` deletes state.json entirely once everything is unwound.
    const initialDeploy = currentEtag === undefined;

    // go-to-k/cdkd#4443: a resource AWS stored inside a parent this deploy
    // destroyed and re-created under the same id went with the old parent;
    // the UPDATE arm restores it, but this deploy failed before it did. Its
    // record would survive (the rollback keeps an equal-id parent as done)
    // and every later deploy would diff it unchanged, so forget it: the next
    // deploy creates it. Before every save below, the interrupt path's
    // included.
    // Written: restored, or any completed operation -- minus a re-put child on
    // Cloud Control, whose completed update sent nothing.
    const written = new Set([
      ...engine.replacementRun.restoredLostChildren,
      ...completedOperations.map((op) => op.logicalId),
    ]);
    for (const logicalId of engine.replacementRun.updatesThatSentNothing) written.delete(logicalId);
    // A child whose own write was ATTEMPTED and then threw (a deadline race, a
    // lost response, a definite AWS rejection -- only EC2 marks a refusal as
    // never applied, so the rest all carry an attempted bag; a multi-holder put
    // that landed on one holder) may be live in AWS: it keeps its record,
    // accepting the old fail-open for that narrower set, rather than risk an
    // untracked live grant. Applied LAST, so nothing above can undo it.
    // ...except one whose provider reported it sent NOTHING before the throw
    // (a later step failed): nothing could have reached AWS, so it is
    // unwritten and forgotten. A child that threw BEFORE that word stays
    // attempted -- an accepted fail-open (the PR's known edges).
    const attempted = new Set(
      failedOperations
        .filter(
          (op) =>
            op.attemptedProperties !== undefined &&
            !engine.replacementRun.updatesThatSentNothing.has(op.logicalId)
        )
        .map((op) => op.logicalId)
    );
    const recoveryFlagFor = (
      logicalId: string,
      record: { resourceType: string; provisionedBy?: string | undefined }
    ): string | undefined => {
      const type = record.resourceType;
      if (record.provisionedBy === 'cc-api') {
        // The validator can still refuse it while the template uses a
        // property the SDK provider does not cover; its refusal names the
        // `--prefer-sdk-route` that lets it through.
        return engine.providerRegistry.getProviderType?.(type) === 'sdk'
          ? safeMsg`--recreate-via-sdk-provider ${logicalId} (adding the --prefer-sdk-route the refusal names, if it is refused over a property the SDK provider does not cover)`
          : undefined;
      }
      const noCcRoute =
        hasNoCloudControlHandlers(type) ||
        engine.providerRegistry.ccRouteUnavailableReason?.(type) !== undefined ||
        ccBrokenReason(type) !== undefined;
      return noCcRoute
        ? undefined
        : safeMsg`--recreate-via-cc-api ${logicalId} (which moves it to Cloud Control)`;
    };
    for (const lost of lostChildActions({
      templateResources: template.Resources ?? {},
      records: newResources,
      recreatedUnderSameId: engine.replacementRun.recreatedUnderSameId,
      written,
      conditions,
    })) {
      const record = newResources[lost.logicalId]!;
      const childType = shownType(record.resourceType);
      // The one recovery flag the validator accepts for this record, or
      // none: `validate.ts` refuses --recreate-via-cc-api on a record already
      // on Cloud Control or a type with no usable Cloud Control route (no
      // handlers, an SDK opt-out, or a 'cc-broken' type), and
      // --recreate-via-sdk-provider on an SDK record or a type with no SDK
      // provider.
      const recovery = recoveryFlagFor(lost.logicalId, record);
      // Kept only while that way back exists. Without one (an SDK-recorded
      // IAM `Policy`, topic or queue policy, or `EventInvokeConfig`), keeping
      // the record would leave a possibly-missing Deny with no recovery, so
      // the ordinary forget / trim applies: those types' creates are
      // overwrite-style puts, which the next deploy re-writes whatever landed,
      // or else the next CREATE collides loudly (a Cloud Control-only alias or
      // log stream that did land).
      // A resource merely ATTACHED to the parent (go-to-k/cdkd#4461) is
      // always trimmed instead: re-attaching is idempotent (`Attach*Policy`,
      // `AddUserToGroup`; an instance profile that kept its role fails loudly),
      // while the flag would destroy and re-create the resource itself -- for
      // a user, revoking its access keys -- to redo one attach.
      if (
        attempted.has(lost.logicalId) &&
        recovery !== undefined &&
        !survivesParent(record.resourceType)
      ) {
        engine.logger.warn(
          safeMsg`  ⚠ ${lost.logicalId} (${childType}) went with a resource this deploy re-created under the same id; restoring it failed, and its state record is kept because the write may have reached AWS. If it is missing there, re-run the deploy with `.concat(
            recovery,
            ' to write it again.'
          )
        );
        continue;
      }
      // An attempted write forgotten for lack of a recovery flag may still be
      // live on the parent, and once its record is gone nothing removes it.
      // The parent is named with its physical id too: that is what a hand
      // removal in AWS has to look up.
      const parentPhysicalId = newResources[lost.parent]?.physicalId;
      const parentShown =
        parentPhysicalId !== undefined && parentPhysicalId !== ''
          ? safeMsg`${lost.parent} (${parentPhysicalId})`
          : safeMsg`${lost.parent}`;
      const mayStillBeLive = attempted.has(lost.logicalId)
        ? safeMsg` Its write may still be on `.concat(
            parentShown,
            safeMsg`: if ${lost.logicalId} is removed from the template before the next deploy, remove it from that resource by hand.`
          )
        : '';
      if (lost.action === 'forget' && mayStillBeLive !== '') {
        Reflect.deleteProperty(newResources, lost.logicalId);
        engine.logger.warn(
          safeMsg`  ⚠ ${lost.logicalId} (${childType}) went with a resource this deploy re-created under the same id, and restoring it failed: its state record is dropped, so the next deploy creates it again.`.concat(
            mayStillBeLive
          )
        );
      } else if (lost.action === 'forget') {
        Reflect.deleteProperty(newResources, lost.logicalId);
        engine.logger.warn(
          safeMsg`  ⚠ ${lost.logicalId} (${childType}) went with a resource this deploy re-created under the same id, and the deploy failed before restoring it: it is gone from AWS and the resource runs without it until the next deploy, which creates it again (its state record is dropped).`
        );
      } else if (survivesParent(record.resourceType)) {
        // go-to-k/cdkd#4461: the resource exists; only its attachment to the
        // re-created principal is gone. An attach that partly landed is NOT
        // in the trimmed record: harmless while the template keeps naming
        // the principal (the next attach is idempotent), and a delete of the
        // resource detaches whatever IAM lists, but a list that drops the
        // principal before the next deploy diffs unchanged and leaves the
        // landed attachment untracked.
        newResources[lost.logicalId] = {
          ...record,
          // go-to-k/cdkd#5076: the trimmed lists only drop elements of the
          // record's own lists, so the copy keeps the bag's redaction marks.
          properties: withPropertiesMarksOf(record.properties, {
            ...record.properties,
            ...lost.trimmed,
          }),
        };
        const lists = Object.keys(lost.trimmed).join(' / ');
        engine.logger.warn(
          safeMsg`  ⚠ ${lost.logicalId} (${childType}) lost its attachment to a resource this deploy re-created under the same name, and the deploy failed before attaching it again: its record keeps only the attachments that survived, so the next deploy attaches it again.`.concat(
            attempted.has(lost.logicalId)
              ? safeMsg` Its attach may already have landed on `.concat(
                  parentShown,
                  safeMsg`: if ${lost.logicalId}'s ${lists} stops naming it before the next deploy, nothing will detach it, so detach it by hand.`
                )
              : ''
          )
        );
      } else {
        newResources[lost.logicalId] = {
          ...record,
          // go-to-k/cdkd#5076: the trimmed lists only drop elements of the
          // record's own lists, so the copy keeps the bag's redaction marks.
          properties: withPropertiesMarksOf(record.properties, {
            ...record.properties,
            ...lost.trimmed,
          }),
        };
        engine.logger.warn(
          safeMsg`  ⚠ ${lost.logicalId} (${childType}) was removed from a resource this deploy re-created under the same id, and the deploy failed before writing it again: the next deploy writes it there again (its record keeps only the holders it is still on).`.concat(
            mayStillBeLive
          )
        );
      }
    }

    // go-to-k/cdkd#5511: as late as possible before the first save, so a
    // report or retraction an abandoned provider call made after its deadline
    // is reflected. One made after this point is not.
    await settleReportedCreates(engine, template, failedOperations, reportedCreatesToSettle);

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

    // Set true when an automatic rollback replayed with zero per-op
    // failures and zero skips — gates the post-save journal deletion below.
    let autoRollbackClean = false;
    // Whether this attempt's `auto-rollback-started` segment was written: the
    // settle below pops the NEWEST segment, which without one is an OLDER
    // attempt's revert record (go-to-k/cdkd#4356 review). The nested settle is
    // skipped with it, so after a FAILED write a reverted child's pending
    // segments for this run stay until the next top-level success sweeps them.
    let autoRollbackJournaled = false;
    // Resources this deploy's rollback left in AWS under `DeletionPolicy: Retain`
    // (issue #2934). Stays empty when no rollback ran, so the saves below
    // spread nothing and a stack that never orphaned keeps a byte-identical
    // record.
    let rollbackOrphans: StackOrphanRecord[] = [];
    // go-to-k/cdkd#5064: the CREATEs that rollback took back; each logical
    // id's generation retires, so the next create asks for a new name.
    let rollbackCreates: RolledBackCreate[] = [];
    // go-to-k/cdkd#5064: the new copies the rollback left in AWS to delete.
    let rollbackSuperseded: SupersededResourceRecord[] = [];
    // The nested rows the automatic rollback actually reverted (issue
    // #3754): only their children's pending segments are settled with it.
    let rollbackSettledNested: SettledNestedRows = new Map();
    // The failed ops the clean-rollback settle keeps for `--revert-failed`:
    // all but the proven failed-CREATE orphans the rollback handled
    // (go-to-k/cdkd#4584).
    let rollbackRemainingFailedOps: FailedOperation[] = failedOperations;

    // On SIGINT, skip rollback — just save partial state, record a rollback
    // journal segment so the interrupted deploy is REVERTIBLE (not just
    // resumable), and let the caller exit.
    //
    // A user interrupt reaches this catch in three shapes, and all three must
    // take this branch — the other one rolls the stack back on a Ctrl-C:
    //
    //  - the engine's own `InterruptedError`, raised by its between-ops poll;
    //  - an `InterruptedWaitError` from a provider's wait, WRAPPED by the
    //    provider's `ProvisioningError` (issue #2040), which
    //    `isInterruptedWaitError` finds on the cause chain;
    //  - an `InterruptedError` WRAPPED by `provisionResource`'s own
    //    `ProvisioningError`: one raised by this engine's retry backoff
    //    (`onInterrupted`), or by a NESTED child engine's poll, which reaches
    //    the parent through `NestedStackProvider` (go-to-k/cdkd#3875).
    //
    // The last shape is keyed on this engine's own `interruptCause`, not on
    // the class: `InterruptedError` does not carry its cause, and a child's
    // `'sibling-failure'` one must still roll back. The SIGINT handler sets
    // `'user'` before any poll or backoff can observe the signal, and a row
    // failure's `??= 'sibling-failure'` never overwrites it.
    if (
      error instanceof InterruptedError ||
      isInterruptedWaitError(error) ||
      engine.interruptCause === 'user'
    ) {
      await writeRollbackJournalSegment(
        engine.rollbackDeps(),
        stackName,
        completedOperations,
        failedOperations,
        'interrupted',
        initialDeploy
      );
      engine.logger.info(
        safeMsg`Partial state saved (${Object.keys(newResources).length} resources). ` +
          "Run deploy again to resume, 'cdkd rollback' to revert, or destroy to clean up."
      );
      throw error;
    }

    // Deployment failed — attempt rollback unless --no-rollback is set
    if (engine.options.noRollback) {
      // Record a journal segment so `cdkd rollback` can revert the failed
      // deploy later instead of only fixing forward / destroying.
      await writeRollbackJournalSegment(
        engine.rollbackDeps(),
        stackName,
        completedOperations,
        failedOperations,
        'no-rollback-failure',
        initialDeploy
      );
      engine.logger.warn('Deployment failed. --no-rollback is set, skipping rollback.');
      engine.logger.warn(
        safeMsg`Partial state has been saved. ${recoveryHint(
          engine.rollbackDeps(),
          "Run 'cdkd deploy' to resume, 'cdkd rollback' to revert, or destroy to clean up."
        )}`
      );
    } else {
      // Automatic in-process rollback. Write a journal segment FIRST so a
      // rollback that dies partway (crash / network / per-op failure)
      // leaves the segment behind and becomes resumable via `cdkd
      // rollback`; the segment is deleted after a clean replay + save.
      autoRollbackJournaled = await writeRollbackJournalSegment(
        engine.rollbackDeps(),
        stackName,
        completedOperations,
        failedOperations,
        'auto-rollback-started',
        initialDeploy
      );
      const rollbackResult = await performRollback(
        engine.rollbackDeps(),
        completedOperations,
        newResources,
        stackName,
        currentState,
        failedOperations,
        currentState.orphans ?? [],
        // go-to-k/cdkd#5505: the revert acts on THIS run's marks only (never a
        // name an earlier deploy left), waits for an abandoned call of the
        // failed update and records its late marks first. Once a revert is
        // handled, the record says what stays unsettled (its proof decides), so
        // the post-rollback save below must not re-add the engine's copy of
        // those names; a mark that arrives later still records.
        {
          runMarks: (logicalId) => ({
            names: engine.unsettledMarks.get(logicalId) ?? new Set(),
            items: engine.unsettledItemMarks.get(logicalId) ?? new Map(),
          }),
          stillRunning: (logicalId) => engine.inFlightBodies.get(logicalId),
          recordMarks: (logicalId) => recordUnsettledMarks(engine, newResources, logicalId),
          onReverted: (logicalId, settled) => dropUnsettledMarks(engine, logicalId, settled),
        }
      );
      // go-to-k/cdkd#3338: a SKIPPED op was never reverted, so the segment
      // recording it is kept, as for a failure: settling it would delete the
      // only record of a resource the rollback left as the failed deploy did.
      // A survivor warning (a retained new copy) is not a skip: its op WAS
      // reverted, and its event names the survivor.
      autoRollbackClean =
        autoRollbackJournaled &&
        rollbackResult.failures === 0 &&
        rollbackResult.skipped === 0 &&
        // A Ctrl-C left ops unreverted: the segment stays for `cdkd rollback`.
        !rollbackResult.interrupted;
      if (
        rollbackResult.interrupted &&
        rollbackResult.failures === 0 &&
        rollbackResult.skipped === 0
      ) {
        // go-to-k/cdkd#5118: the user's Ctrl-C stopped the replay part-way.
        // A nested child is recovered through its top-level stack. A failed
        // journal write already warned that nothing was kept.
        const remedy = autoRollbackJournaled
          ? recoveryHint(
              engine.rollbackDeps(),
              'The rollback journal keeps them; finish the rollback with: ' +
                pasteableCommand('cdkd rollback', [{ value: stackName, hole: 'stack' }]).command
            )
          : '';
        engine.logger.warn(
          safeMsg`The automatic rollback was interrupted before it reverted every operation. ${remedy}`
        );
      }
      if (rollbackResult.failures === 0 && rollbackResult.skipped > 0) {
        // The kept segment also keeps the failed op's record, which the next
        // deploy's generic note (a plain `cdkd rollback`, which discards it)
        // no longer points at, so name `--revert-failed` here. Not for a
        // nested child: its stack-less `cdkd rollback` would resolve to the
        // top-level stack (go-to-k/cdkd#3864).
        engine.logger.warn(
          safeMsg`The automatic rollback could not revert ${rollbackResult.skipped} operation(s) ` +
            `(see the warnings above; each is recorded as a ROLLBACK_RESOURCE_SKIPPED event).` +
            // A failed journal write already warned that nothing was kept.
            (autoRollbackJournaled ? ` The rollback journal keeps them.` : '')
        );
        // Only over a segment THIS attempt wrote: otherwise nothing was kept,
        // and `--revert-failed` would act on an OLDER attempt's record.
        if (
          autoRollbackJournaled &&
          engine.options.parentStackInfo === undefined &&
          // What the replay left, not every failed op: one it settled (a
          // replacement's UPDATE warned about with its orphan) is gone, and a
          // `--revert-failed` would only repeat its warning.
          rollbackResult.remainingFailedOps.some((op) => op.changeType !== 'DELETE')
        ) {
          engine.logger.warn(
            safeMsg`The record of the operation that failed is kept too. Revert it with: ${
              pasteableCommand('cdkd rollback', [
                { value: stackName, hole: 'stack' },
                { literal: '--revert-failed' },
              ]).command
            }`
          );
        }
      }
      // Hoisted out of this block because both saves below sit outside it
      // (issue #2934) — the post-rollback save and its ETag-mismatch retry —
      // and neither can see `rollbackResult`.
      rollbackOrphans = rollbackResult.orphaned;
      rollbackCreates = rollbackResult.rolledBackCreates;
      rollbackSuperseded = rollbackResult.superseded;
      rollbackSettledNested = rollbackResult.settledNested;
      rollbackRemainingFailedOps = rollbackResult.remainingFailedOps;
    }

    // Save state after rollback (reflects rolled-back resource state).
    // This is critical: if rollback deleted resources, the state must reflect
    // that. Otherwise, next deploy will think deleted resources still exist.
    // go-to-k/cdkd#5380: a mark a provider made while the rollback ran.
    recordUnsettledMarks(engine, newResources);
    try {
      const postRollbackState: StackState = {
        version: STATE_SCHEMA_VERSION_CURRENT,
        region: engine.stackRegion,
        stackName: currentState.stackName,
        resources: newResources,
        outputs: currentState.outputs,
        ...exportNamesCarriedFrom(currentState),
        ...skippedOutputsCarriedFrom(currentState),
        ...orphansAfterRollback(currentState, rollbackOrphans),
        ...stackInstanceIdCarriedFrom(currentState),
        // go-to-k/cdkd#5064: a renamed reversal's new copy left to delete.
        ...supersededAfterRollback(currentState, { supersededResources: rollbackSuperseded }),
        // go-to-k/cdkd#5064: what the rollback left in AWS is not taken back,
        // and a CREATE it took back is named anew by the next create.
        ...retiredAfterRollback(currentState, rollbackOrphans, rollbackCreates),
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
      await engine.stateBackend.saveState(
        stackName,
        engine.stackRegion,
        engine.withParentInfo(postRollbackState),
        {
          ...(currentEtag !== undefined && { expectedEtag: currentEtag }),
        }
      );
      engine.logger.debug('State saved after deployment failure');
      // Auto-rollback replayed cleanly AND the post-rollback state save
      // succeeded — the pre-deploy baseline is restored, so settle the
      // journal (issue #1183): drop it entirely, or — when the segment
      // carries failed in-flight op(s) — keep a failed-only segment so
      // `cdkd rollback --revert-failed` still works (issue #1208). A
      // partial / failed rollback keeps the full segment so `cdkd
      // rollback` can resume.
      if (autoRollbackClean) {
        await settleNestedChildrenAfterCleanRollback(
          engine.rollbackDeps(),
          stackName,
          rollbackSettledNested,
          await settleJournalAfterCleanRollback(
            engine.rollbackDeps(),
            stackName,
            rollbackRemainingFailedOps,
            initialDeploy
          )
        );
      }
    } catch (saveError) {
      // ETag mismatch from per-resource saves — force overwrite with fresh ETag
      engine.logger.debug(
        safeMsg`Retrying state save after rollback (ETag mismatch): ${asIsMessage(describeAwsFailure(saveError).detail)}`
      );
      try {
        const freshState = await engine.stateBackend.getState(stackName, engine.stackRegion);
        const freshEtag = freshState?.etag;
        recordUnsettledMarks(engine, newResources);
        const postRollbackState: StackState = {
          version: STATE_SCHEMA_VERSION_CURRENT,
          region: engine.stackRegion,
          stackName: currentState.stackName,
          resources: newResources,
          outputs: currentState.outputs,
          ...exportNamesCarriedFrom(currentState),
          ...skippedOutputsCarriedFrom(currentState),
          ...orphansAfterRollback(currentState, rollbackOrphans),
          ...stackInstanceIdCarriedFrom(currentState),
          ...supersededAfterRollback(currentState, { supersededResources: rollbackSuperseded }),
          ...retiredAfterRollback(currentState, rollbackOrphans, rollbackCreates),
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
        await engine.stateBackend.saveState(
          stackName,
          engine.stackRegion,
          engine.withParentInfo(postRollbackState),
          {
            ...(freshEtag !== undefined && { expectedEtag: freshEtag }),
          }
        );
        engine.logger.debug('State saved after deployment failure (retry succeeded)');
        if (autoRollbackClean) {
          await settleNestedChildrenAfterCleanRollback(
            engine.rollbackDeps(),
            stackName,
            rollbackSettledNested,
            await settleJournalAfterCleanRollback(
              engine.rollbackDeps(),
              stackName,
              rollbackRemainingFailedOps,
              initialDeploy
            )
          );
        }
      } catch (retryError) {
        engine.logger.warn(
          safeMsg`Failed to save state after rollback: ${asIsMessage(describeAwsFailure(retryError).detail)}`
        );
        // go-to-k/cdkd#5064: the rollback said these stay in state; that save
        // is the one that failed, so name them. An id can spell a
        // secret-derived name (#3869): printed under each entry's bags.
        for (const entry of rollbackSuperseded) {
          withPrintingSecrets(
            unionOfSecretBags([
              secretNameBagFor(engine.secretsRun, entry.logicalId),
              orphanRecordsPrintingBag([entry]),
            ]),
            () =>
              engine.logger.warn(
                safeMsg`  ${entry.logicalId}'s new ${entry.state.resourceType} ` +
                  safeMsg`(${entry.state.physicalId}) the rollback left to delete is NOT recorded: ` +
                  'delete it manually.'
              )
          );
        }
      }
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
    await writeRollbackJournalSegment(
      engine.rollbackDeps(),
      stackName,
      completedOperations,
      failedOperations,
      'no-rollback-failure',
      currentEtag === undefined
    );
    throw outputError;
  }

  return {
    state: {
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
    },
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
  pendingMigration: boolean
): Promise<void> {
  const buildState = (): StackState => ({
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
  });
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
    engine.logger.debug('State saved after output resolution failure');
  } catch (saveError) {
    engine.logger.debug(
      safeMsg`Retrying state save after output resolution failure (ETag mismatch): ${asIsMessage(describeAwsFailure(saveError).detail)}`
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
      engine.logger.debug('State saved after output resolution failure (retry succeeded)');
    } catch (retryError) {
      engine.logger.warn(
        safeMsg`Failed to save state after output resolution failure: ${asIsMessage(describeAwsFailure(retryError).detail)} — resources were provisioned but not recorded; run deploy again to reconcile.`
      );
    }
  }
}

/**
 * The `DeletionPolicy` a proven failed-CREATE orphan is journaled with
 * (go-to-k/cdkd#1710). A value outside CloudFormation's four is journaled as
 * `Retain`: the policy picks whether `--revert-failed` deletes a resource only
 * this entry records, so an unreadable one keeps the resource rather than
 * falling through to a plain delete (and the journal parser refuses it).
 */
function journaledOrphanPolicy(
  policy: unknown
): 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined {
  if (policy === undefined) return undefined;
  return policy === 'Delete' ||
    policy === 'Retain' ||
    policy === 'Snapshot' ||
    policy === 'RetainExceptOnCreate'
    ? policy
    : 'Retain';
}

/**
 * Record what a failed in-place update left unsettled (go-to-k/cdkd#5380) on
 * the record the failure save writes: the marks its provider made through
 * `UpdateContext.markUnsettled`, unioned with the record's own. `only` limits
 * it to one logical id (the failed row, before its siblings' saves); without
 * it every pending mark is recorded, which catches one a provider made after
 * the engine had already given up on its call. A successful update and the
 * replacement fallback delete their entry first, so an entry here is a failed
 * update's.
 */
function recordUnsettledMarks(
  engine: DeployEngine,
  newResources: Record<string, ResourceState>,
  only?: string
): void {
  for (const [logicalId, marks] of engine.unsettledMarks) {
    if (only !== undefined && logicalId !== only) continue;
    if (marks.size === 0 || !Object.hasOwn(newResources, logicalId)) continue;
    newResources[logicalId] = withUnsettledProperties(newResources[logicalId]!, marks);
    // go-to-k/cdkd#5498: the items its accepted calls added, under those keys only.
    const items = engine.unsettledItemMarks.get(logicalId);
    if (items !== undefined && items.size > 0) {
      newResources[logicalId] = withUnsettledItems(newResources[logicalId]!, items);
    }
  }
}

/**
 * go-to-k/cdkd#5505: drop `names` (and the attempted items under them) from
 * the engine's pending marks for `logicalId`, once a revert proved them.
 */
function dropUnsettledMarks(
  engine: DeployEngine,
  logicalId: string,
  names: ReadonlySet<string>
): void {
  const marks = engine.unsettledMarks.get(logicalId);
  if (marks !== undefined) for (const name of names) marks.delete(name);
  const items = engine.unsettledItemMarks.get(logicalId);
  if (items !== undefined) {
    for (const path of [...items.keys()]) {
      if (names.has(unsettledItemsTopKey(path))) items.delete(path);
    }
  }
}

/**
 * go-to-k/cdkd#5511: whether `error` is (or wraps) the `ResourceTimeoutError`
 * this logical id's own deadline raised: `provisionResource` wraps it as the
 * `cause` of its `ProvisioningError`. Bounded; never throws.
 */
function deadlineFiredFor(error: unknown, logicalId: string): boolean {
  try {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
      if (current instanceof ResourceTimeoutError) return current.logicalId === logicalId;
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // Unreadable chain: not a deadline.
  }
  return false;
}

/** go-to-k/cdkd#5511: a failed operation whose sink is read at the save. */
interface ReportedCreateToSettle {
  readonly sink: CreatedResourceSink;
  /** The op already journaled for the failure (the CREATE, or the UPDATE). */
  readonly failedOp: FailedOperation;
  /** On a replacement, the record being replaced. */
  readonly replaced?: ResourceState;
  readonly refused: boolean;
}

/**
 * go-to-k/cdkd#5511: complete each deadline-failed operation from what its
 * provider reported, as its mark would have: the failed CREATE then names the
 * resource, and a replacement journals the new one as its orphan (#4604). A
 * sink the engine cleared (the resource reached state) or the provider
 * retracted from (its cleanup deleted it) adds nothing.
 */
async function settleReportedCreates(
  engine: DeployEngine,
  template: CloudFormationTemplate,
  failedOperations: FailedOperation[],
  pending: readonly ReportedCreateToSettle[]
): Promise<void> {
  for (const { sink, failedOp, replaced, refused } of pending) {
    const report = sink.report;
    if (report === undefined) continue;
    let orphanOp: FailedOperation;
    if (replaced === undefined) {
      failedOp.provisionedBy = 'sdk';
      failedOp.physicalId = report.physicalId;
      failedOp.physicalIdRecoveredFromError = true;
      failedOp.deletionPolicy = journaledOrphanPolicy(
        extractTemplateAttributes(template, failedOp.logicalId).deletionPolicy
      );
      orphanOp = failedOp;
    } else {
      if (report.physicalId === replaced.physicalId) continue;
      failedOp.replacementOrphaned = engine.replacementRun.oldDeletedBeforeCreate.has(
        failedOp.logicalId
      )
        ? 'delete-first'
        : 'create-first';
      orphanOp = replacementOrphanOpFor(
        engine,
        template,
        failedOp.logicalId,
        failedOp.resourceType,
        replaced,
        report.physicalId,
        refused
      );
      failedOperations.push(orphanOp);
    }
    await journalOrphanIdentity(engine, orphanOp, report.createdResourceIdentity);
  }
}

/**
 * go-to-k/cdkd#4604: the proven orphan a failed replacement's create made,
 * journaled beside the UPDATE naming `record`, the resource being replaced.
 */
function replacementOrphanOpFor(
  engine: DeployEngine,
  template: CloudFormationTemplate,
  logicalId: string,
  resourceType: string,
  record: ResourceState,
  createdId: string,
  refused: boolean
): FailedOperation {
  return {
    logicalId,
    changeType: 'CREATE',
    resourceType,
    provisionedBy: 'sdk',
    physicalId: createdId,
    physicalIdRecoveredFromError: true,
    deletionPolicy: journaledOrphanPolicy(
      extractTemplateAttributes(template, logicalId).deletionPolicy
    ),
    replacedPhysicalId: record.physicalId,
    replacedResourceType: record.resourceType,
    // The replacement deleted the old resource before its create:
    // the record names a resource that is gone.
    ...(engine.replacementRun.oldDeletedBeforeCreate.has(logicalId) && {
      replacedResourceDeleted: true,
    }),
    ...(!refused && {
      attemptedProperties: engine.attemptedResolvedProps.get(logicalId),
    }),
  };
}

/**
 * go-to-k/cdkd#4655: the token naming the resource just made, so a later
 * settle can tell it from one that reused its name. Read once, best-effort,
 * after the entry is pushed: a failed read only leaves the token out, never
 * the entry. The read delays the failure's journal write, so it is bounded
 * (`readResourceIdentity`'s timeout), skipped once the user has interrupted
 * the deploy, and skipped for an orphan no settle reads a token for (an exempt
 * type, or `Retain`, which deletes nothing). A provider that took the token
 * from its create call's response carried it (`carried`, on the mark or the
 * report): that is journaled with no read, since the failure being journaled
 * (a describe that cannot run) often fails the read too.
 */
async function journalOrphanIdentity(
  engine: DeployEngine,
  orphanOp: FailedOperation,
  carried: string | undefined
): Promise<void> {
  if (
    orphanOp.physicalId === undefined ||
    orphanOp.deletionPolicy === 'Retain' ||
    !orphanNeedsIdentity(orphanOp)
  ) {
    return;
  }
  if (carried !== undefined) {
    orphanOp.createdResourceIdentity = carried;
  } else if (engine.interruptCause !== 'user') {
    const identity = await readResourceIdentity(
      engine.providerRegistry,
      {
        resourceType: orphanOp.resourceType,
        physicalId: orphanOp.physicalId,
        provisionedBy: orphanOp.provisionedBy,
      },
      engine.stackRegion
    );
    if (typeof identity === 'string') orphanOp.createdResourceIdentity = identity;
  }
}
