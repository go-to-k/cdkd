import { hasNoCloudControlHandlers } from '../../provisioning/unsupported-types.js';
import { ccBrokenReason } from '../../provisioning/provider-registry.js';
import {
  lostChildActions,
  noChangeChildrenOfRecreatedParents,
  survivesParent,
} from '../child-of-recreated-parent.js';
import { shownType } from '../recreate-target-readers.js';
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
  exportNamesCarriedFrom,
  orphansAfterRollback,
  orphansCarriedFrom,
  skippedOutputsCarriedFrom,
} from '../../types/state.js';
import { cyan, red } from '../../utils/colors.js';
import { safeMsg } from '../../utils/display-safe.js';
import { pasteableCommand } from '../../utils/pasteable-command.js';
import { DagExecutor } from '../dag-executor.js';
import { withSharedDrainBudget } from '../drain-budget.js';
import type { SettledNestedRows } from '../nested-child-journal.js';
import type { CompletedOperation, FailedOperation } from '../rollback-executor.js';
import { isRefusedBeforeApplying } from '../prior-attempt-scope.js';
import { createdBeforeFailure } from '../../provisioning/auxiliary-failure.js';
import { deployStackRecordsView, type InFlightWrite } from '../stack-records-scope.js';

declare module '../deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    executeDeployment: OmitThisParameter<typeof executeDeployment>;
    /** @internal */
    persistStateAfterOutputFailure: OmitThisParameter<typeof persistStateAfterOutputFailure>;
  }
}

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
  this: DeployEngine,
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
  const concurrency = this.options.concurrency!;
  this.deployChanges = changes;
  const newResources: Record<string, ResourceState> = { ...currentState.resources };
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
  // Tracked here so the FIRST per-resource save sweeps the legacy key; we
  // don't want to delete it on every save.
  let pendingMigration = migrationPending;

  // Serialize per-resource state saves to avoid ETag conflicts from concurrent writes
  let saveChain: Promise<void> = Promise.resolve();
  const saveStateAfterResource = (logicalId: string): void => {
    if (currentEtag === undefined) return;
    saveChain = saveChain.then(async () => {
      try {
        const partialState: StackState = {
          version: STATE_SCHEMA_VERSION_CURRENT,
          region: this.stackRegion,
          stackName: currentState.stackName,
          resources: newResources,
          outputs: currentState.outputs,
          ...exportNamesCarriedFrom(currentState),
          ...skippedOutputsCarriedFrom(currentState),
          ...orphansCarriedFrom(currentState),
          // Issue #2057: the UNION of the pre-deploy snapshot and what THIS
          // session resolved. See `crossStackReadsForPartialSave` — writing the
          // snapshot alone left a failed deploy's persisted record denying a
          // cross-stack read its own resources were built from.
          ...crossStackReadsForPartialSave(
            currentState,
            this.recordedImports,
            this.recordedOutputReads,
            this.crossStackReadKeyNormalizer()
          ),
          lastModified: Date.now(),
        };
        // Migration is a one-shot tail on the first save; subsequent saves
        // overwrite the new key in-place under optimistic locking.
        const migrate = pendingMigration;
        const expectedEtag = migrate ? undefined : currentEtag;
        currentEtag = await this.stateBackend.saveState(
          stackName,
          this.stackRegion,
          this.withParentInfo(partialState),
          { ...(expectedEtag !== undefined && { expectedEtag }), migrateLegacy: migrate }
        );
        if (migrate) pendingMigration = false;
        this.logger.debug(`State saved after ${logicalId}`);
      } catch (error) {
        this.logger.warn(
          `Failed to save state after ${logicalId}: ${error instanceof Error ? error.message : String(error)}`
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
  this.stackRecordsView = deployStackRecordsView(
    newResources,
    currentState.resources,
    deleteChanges,
    (logicalId) => startedUpdates.has(logicalId) && !settledUpdates.has(logicalId),
    () => [...inFlightWrites.values()].map(({ write }) => write)
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
      this.logger.info(
        `${cyan('Deploying')} ${cyan(createUpdateIds.length)} resource(s) (DAG: ${executionLevels.length} levels, max parallel: ${concurrency})`
      );

      const createUpdateExecutor = new DagExecutor<ResourceChange>();
      const provisionable = new Set(createUpdateIds);
      for (const id of createUpdateIds) {
        const allDeps = this.dagBuilder.getDirectDependencies(dag, id);
        // Only carry deps that are themselves being provisioned in this phase;
        // NO_CHANGE / DELETE / non-DAG deps are already satisfied.
        const deps = new Set(allDeps.filter((d) => provisionable.has(d)));
        createUpdateExecutor.add({
          id,
          dependencies: deps,
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
          recreatedUnderSameId: this.recreatedUnderSameId,
          recordedTypeOf: (id) =>
            Object.hasOwn(newResources, id) ? newResources[id]?.resourceType : undefined,
          conditions,
        });
        for (const id of lostIds) {
          const change = changes.get(id)!;
          change.changeType = 'UPDATE';
          change.propertyChanges = [];
          this.logger.info(
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
              this.dagBuilder.getDirectDependencies(dag, id).filter((d) => executor.has(d))
            ),
            state: 'pending',
            data: changes.get(id)!,
          });
        }
        for (const node of executor.values()) {
          if (node.state !== 'pending') continue;
          for (const dep of this.dagBuilder.getDirectDependencies(dag, node.id)) {
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
            properties: () => this.attemptedResolvedProps.get(logicalId),
            settled,
          },
          settle,
        });
        // Settled on EVERY exit (a `finally`), so a twin waiting on this write
        // can never hang on bookkeeping that throws below.
        let succeeded = false;
        try {
          try {
            await this.provisionResource(
              logicalId,
              change,
              newResources,
              stackName,
              template,
              parameterValues,
              conditions,
              actualCounts,
              progress
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
          this.interrupted = true;
          this.interruptCause ??= 'sibling-failure';
          // #1198: journal the failed op's pre-op state + attempted
          // properties so `cdkd rollback --revert-failed` can act on it.
          //
          // go-to-k/cdkd#4356: except a CREATE refused before anything was
          // applied that recorded no physical id. There is nothing of this
          // stack's to revert, and the record could only say "delete it
          // manually" about the resource that refused it — another owner's.
          const refused = isRefusedBeforeApplying(provisionError, logicalId);
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
          const createdId =
            change.changeType === 'CREATE' && statePhysicalId === undefined
              ? createdBeforeFailure(provisionError, logicalId, change.resourceType)
              : undefined;
          failedOperations.push({
            logicalId,
            changeType: change.changeType as 'CREATE' | 'UPDATE',
            resourceType: change.resourceType,
            provisionedBy:
              createdId !== undefined
                ? 'sdk'
                : (newResources[logicalId]?.provisionedBy ?? previousState?.provisionedBy),
            ...(previousState && { previousState }),
            physicalId: createdId ?? statePhysicalId,
            ...(createdId !== undefined && {
              physicalIdRecoveredFromError: true,
              deletionPolicy: journaledOrphanPolicy(
                this.extractTemplateAttributes(template, logicalId).deletionPolicy
              ),
            }),
            // go-to-k/cdkd#4355: a failed op whose attempted bag is
            // provably not this stack's resource (a refusal, or a write AWS
            // definitely rejected) journals no attempted bag. The bag is what a later deploy
            // reads as "this stack attempted that resource"
            // (`priorAttemptsInJournal`), and `--revert-failed` reverts an
            // UPDATE FROM it — both would then act on a resource the
            // refusal found belonging to someone else.
            ...(!refused && {
              attemptedProperties: this.attemptedResolvedProps.get(logicalId),
            }),
          });
          // go-to-k/cdkd#4604: the same proof on a REPLACEMENT — the UPDATE
          // above names the resource being replaced, and the new one its
          // create made is recorded nowhere else. Journaled beside it as a
          // proven orphan of the same logical id, naming the replaced record
          // so the classifier does not read that record as a later owner.
          // Not on a nested-stack row: a grandchild stack sharing its logical
          // id and type marks its own create, which its own journal records,
          // and this row's replacement keeps its physical id.
          const heldRecord = newResources[logicalId] ?? previousState;
          const replaced =
            change.changeType === 'UPDATE' &&
            change.resourceType !== 'AWS::CloudFormation::Stack' &&
            statePhysicalId !== undefined &&
            heldRecord?.physicalId === statePhysicalId
              ? heldRecord
              : undefined;
          const replacementCreatedId = replaced
            ? createdBeforeFailure(provisionError, logicalId, change.resourceType)
            : undefined;
          if (
            replaced !== undefined &&
            replacementCreatedId !== undefined &&
            replacementCreatedId !== replaced.physicalId
          ) {
            failedOperations.push({
              logicalId,
              changeType: 'CREATE',
              resourceType: change.resourceType,
              provisionedBy: 'sdk',
              physicalId: replacementCreatedId,
              physicalIdRecoveredFromError: true,
              deletionPolicy: journaledOrphanPolicy(
                this.extractTemplateAttributes(template, logicalId).deletionPolicy
              ),
              replacedPhysicalId: replaced.physicalId,
              replacedResourceType: replaced.resourceType,
              ...(!refused && {
                attemptedProperties: this.attemptedResolvedProps.get(logicalId),
              }),
            });
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
            oldResourceRetained: this.retainedOldOnReplacement.has(logicalId),
          }),
          // go-to-k/cdkd#4615: the provider's own answer, where an `update()`
          // gave one; absent, the rollback infers a replacement from a changed
          // physical id, as it does for a journal an older binary wrote.
          ...(change.changeType === 'UPDATE' &&
            this.updateWasReplaced.has(logicalId) && {
              wasReplaced: this.updateWasReplaced.get(logicalId),
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
        });

        saveStateAfterResource(logicalId);
        if (this.recreatedUnderSameId.has(logicalId)) enqueueLostChildren(createUpdateExecutor);
      };

      try {
        await createUpdateExecutor.execute(concurrency, provisionNode, () => this.interrupted);
      } finally {
        // Wait for any pending per-resource state saves before the next phase or
        // before propagating an error — prevents partial-save races.
        await saveChain;
      }

      // If SIGINT fired AND there is still un-provisioned work (some nodes
      // remained pending because dispatch was cancelled), surface it as an
      // explicit interruption so the catch path saves partial state.
      // If every node already completed before SIGINT landed, treat the deploy
      // as fully successful — matches the prior level-loop's "loop exits, no
      // check" behaviour at the very end of execution.
      if (this.interrupted && this.hasPending(createUpdateExecutor)) {
        throw new InterruptedError(this.interruptCause ?? 'user');
      }
    }

    // Step 2: Process DELETE operations in reverse dependency order.
    if (deleteChanges.size > 0) {
      this.logger.info(`${red('Deleting')} ${red(deleteChanges.size)} resource(s)`);

      const deleteDeps = this.buildDeletionDependencies(deleteChanges, currentState);
      const deleteExecutor = new DagExecutor<ResourceChange>();
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
              deleteOutcome = await this.provisionResource(
                logicalId,
                change,
                newResources,
                stackName,
                template,
                parameterValues,
                conditions,
                actualCounts,
                progress
              );
            } catch (provisionError) {
              this.interrupted = true;
              this.interruptCause ??= 'sibling-failure';
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

            saveStateAfterResource(logicalId);
          },
          () => this.interrupted
        );
      } finally {
        await saveChain;
      }

      if (this.interrupted && this.hasPending(deleteExecutor)) {
        throw new InterruptedError(this.interruptCause ?? 'user');
      }
    }
  } catch (error) {
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
      ...this.restoredLostChildren,
      ...completedOperations.map((op) => op.logicalId),
    ]);
    for (const logicalId of this.updatesThatSentNothing) written.delete(logicalId);
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
            op.attemptedProperties !== undefined && !this.updatesThatSentNothing.has(op.logicalId)
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
        return this.providerRegistry.getProviderType?.(type) === 'sdk'
          ? safeMsg`--recreate-via-sdk-provider ${logicalId} (adding the --prefer-sdk-route the refusal names, if it is refused over a property the SDK provider does not cover)`
          : undefined;
      }
      const noCcRoute =
        hasNoCloudControlHandlers(type) ||
        this.providerRegistry.ccRouteUnavailableReason?.(type) !== undefined ||
        ccBrokenReason(type) !== undefined;
      return noCcRoute
        ? undefined
        : safeMsg`--recreate-via-cc-api ${logicalId} (which moves it to Cloud Control)`;
    };
    for (const lost of lostChildActions({
      templateResources: template.Resources ?? {},
      records: newResources,
      recreatedUnderSameId: this.recreatedUnderSameId,
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
        this.logger.warn(
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
        this.logger.warn(
          safeMsg`  ⚠ ${lost.logicalId} (${childType}) went with a resource this deploy re-created under the same id, and restoring it failed: its state record is dropped, so the next deploy creates it again.`.concat(
            mayStillBeLive
          )
        );
      } else if (lost.action === 'forget') {
        Reflect.deleteProperty(newResources, lost.logicalId);
        this.logger.warn(
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
          properties: { ...record.properties, ...lost.trimmed },
        };
        const lists = Object.keys(lost.trimmed).join(' / ');
        this.logger.warn(
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
          properties: { ...record.properties, ...lost.trimmed },
        };
        this.logger.warn(
          safeMsg`  ⚠ ${lost.logicalId} (${childType}) was removed from a resource this deploy re-created under the same id, and the deploy failed before writing it again: the next deploy writes it there again (its record keeps only the holders it is still on).`.concat(
            mayStillBeLive
          )
        );
      }
    }

    // Save partial state BEFORE rollback to track all successfully provisioned
    // resources (including those that completed concurrently with the one that
    // failed). This prevents orphaned resources — resources that exist in AWS
    // but not in the state file.
    try {
      const preRollbackState: StackState = {
        version: STATE_SCHEMA_VERSION_CURRENT,
        region: this.stackRegion,
        stackName: currentState.stackName,
        resources: newResources,
        outputs: currentState.outputs,
        ...exportNamesCarriedFrom(currentState),
        ...skippedOutputsCarriedFrom(currentState),
        ...orphansCarriedFrom(currentState),
        // Issue #2057: the UNION of the pre-deploy snapshot and what THIS
        // session resolved. See `crossStackReadsForPartialSave` — writing the
        // snapshot alone left a failed deploy's persisted record denying a
        // cross-stack read its own resources were built from.
        ...crossStackReadsForPartialSave(
          currentState,
          this.recordedImports,
          this.recordedOutputReads,
          this.crossStackReadKeyNormalizer()
        ),
        lastModified: Date.now(),
      };
      const migrate = pendingMigration;
      const expectedEtag = migrate ? undefined : currentEtag;
      currentEtag = await this.stateBackend.saveState(
        stackName,
        this.stackRegion,
        this.withParentInfo(preRollbackState),
        { ...(expectedEtag !== undefined && { expectedEtag }), migrateLegacy: migrate }
      );
      if (migrate) pendingMigration = false;
      this.logger.debug('Partial state saved before rollback (orphaned resource tracking)');
    } catch (saveError) {
      this.logger.warn(
        `Failed to save partial state before rollback: ${saveError instanceof Error ? saveError.message : String(saveError)}`
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
      this.interruptCause === 'user'
    ) {
      await this.writeRollbackJournalSegment(
        stackName,
        completedOperations,
        failedOperations,
        'interrupted',
        initialDeploy
      );
      this.logger.info(
        `Partial state saved (${Object.keys(newResources).length} resources). ` +
          "Run deploy again to resume, 'cdkd rollback' to revert, or destroy to clean up."
      );
      throw error;
    }

    // Deployment failed — attempt rollback unless --no-rollback is set
    if (this.options.noRollback) {
      // Record a journal segment so `cdkd rollback` can revert the failed
      // deploy later instead of only fixing forward / destroying.
      await this.writeRollbackJournalSegment(
        stackName,
        completedOperations,
        failedOperations,
        'no-rollback-failure',
        initialDeploy
      );
      this.logger.warn('Deployment failed. --no-rollback is set, skipping rollback.');
      this.logger.warn(
        safeMsg`Partial state has been saved. ${this.recoveryHint(
          "Run 'cdkd deploy' to resume, 'cdkd rollback' to revert, or destroy to clean up."
        )}`
      );
    } else {
      // Automatic in-process rollback. Write a journal segment FIRST so a
      // rollback that dies partway (crash / network / per-op failure)
      // leaves the segment behind and becomes resumable via `cdkd
      // rollback`; the segment is deleted after a clean replay + save.
      autoRollbackJournaled = await this.writeRollbackJournalSegment(
        stackName,
        completedOperations,
        failedOperations,
        'auto-rollback-started',
        initialDeploy
      );
      const rollbackResult = await this.performRollback(
        completedOperations,
        newResources,
        stackName,
        currentState,
        failedOperations,
        currentState.orphans ?? []
      );
      // go-to-k/cdkd#3338: a SKIPPED op was never reverted, so the segment
      // recording it is kept, as for a failure: settling it would delete the
      // only record of a resource the rollback left as the failed deploy did.
      // A survivor warning (a retained new copy) is not a skip: its op WAS
      // reverted, and its event names the survivor.
      autoRollbackClean =
        autoRollbackJournaled && rollbackResult.failures === 0 && rollbackResult.skipped === 0;
      if (rollbackResult.failures === 0 && rollbackResult.skipped > 0) {
        // The kept segment also keeps the failed op's record, which the next
        // deploy's generic note (a plain `cdkd rollback`, which discards it)
        // no longer points at, so name `--revert-failed` here. Not for a
        // nested child: its stack-less `cdkd rollback` would resolve to the
        // top-level stack (go-to-k/cdkd#3864).
        this.logger.warn(
          safeMsg`The automatic rollback could not revert ${rollbackResult.skipped} operation(s) ` +
            `(see the warnings above; each is recorded as a ROLLBACK_RESOURCE_SKIPPED event).` +
            // A failed journal write already warned that nothing was kept.
            (autoRollbackJournaled ? ` The rollback journal keeps them.` : '')
        );
        // Only over a segment THIS attempt wrote: otherwise nothing was kept,
        // and `--revert-failed` would act on an OLDER attempt's record.
        if (
          autoRollbackJournaled &&
          this.options.parentStackInfo === undefined &&
          failedOperations.some((op) => op.changeType !== 'DELETE')
        ) {
          this.logger.warn(
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
      rollbackSettledNested = rollbackResult.settledNested;
      rollbackRemainingFailedOps = rollbackResult.remainingFailedOps;
    }

    // Save state after rollback (reflects rolled-back resource state).
    // This is critical: if rollback deleted resources, the state must reflect
    // that. Otherwise, next deploy will think deleted resources still exist.
    try {
      const postRollbackState: StackState = {
        version: STATE_SCHEMA_VERSION_CURRENT,
        region: this.stackRegion,
        stackName: currentState.stackName,
        resources: newResources,
        outputs: currentState.outputs,
        ...exportNamesCarriedFrom(currentState),
        ...skippedOutputsCarriedFrom(currentState),
        ...orphansAfterRollback(currentState, rollbackOrphans),
        // Issue #2057: the UNION of the pre-deploy snapshot and what THIS
        // session resolved. See `crossStackReadsForPartialSave` — writing the
        // snapshot alone left a failed deploy's persisted record denying a
        // cross-stack read its own resources were built from.
        ...crossStackReadsForPartialSave(
          currentState,
          this.recordedImports,
          this.recordedOutputReads,
          this.crossStackReadKeyNormalizer()
        ),
        lastModified: Date.now(),
      };
      await this.stateBackend.saveState(
        stackName,
        this.stackRegion,
        this.withParentInfo(postRollbackState),
        {
          ...(currentEtag !== undefined && { expectedEtag: currentEtag }),
        }
      );
      this.logger.debug('State saved after deployment failure');
      // Auto-rollback replayed cleanly AND the post-rollback state save
      // succeeded — the pre-deploy baseline is restored, so settle the
      // journal (issue #1183): drop it entirely, or — when the segment
      // carries failed in-flight op(s) — keep a failed-only segment so
      // `cdkd rollback --revert-failed` still works (issue #1208). A
      // partial / failed rollback keeps the full segment so `cdkd
      // rollback` can resume.
      if (autoRollbackClean) {
        await this.settleNestedChildrenAfterCleanRollback(
          stackName,
          rollbackSettledNested,
          await this.settleJournalAfterCleanRollback(
            stackName,
            rollbackRemainingFailedOps,
            initialDeploy
          )
        );
      }
    } catch (saveError) {
      // ETag mismatch from per-resource saves — force overwrite with fresh ETag
      this.logger.debug(
        `Retrying state save after rollback (ETag mismatch): ${saveError instanceof Error ? saveError.message : String(saveError)}`
      );
      try {
        const freshState = await this.stateBackend.getState(stackName, this.stackRegion);
        const freshEtag = freshState?.etag;
        const postRollbackState: StackState = {
          version: STATE_SCHEMA_VERSION_CURRENT,
          region: this.stackRegion,
          stackName: currentState.stackName,
          resources: newResources,
          outputs: currentState.outputs,
          ...exportNamesCarriedFrom(currentState),
          ...skippedOutputsCarriedFrom(currentState),
          ...orphansAfterRollback(currentState, rollbackOrphans),
          // Issue #2057: the UNION of the pre-deploy snapshot and what THIS
          // session resolved. See `crossStackReadsForPartialSave` — writing the
          // snapshot alone left a failed deploy's persisted record denying a
          // cross-stack read its own resources were built from.
          ...crossStackReadsForPartialSave(
            currentState,
            this.recordedImports,
            this.recordedOutputReads,
            this.crossStackReadKeyNormalizer()
          ),
          lastModified: Date.now(),
        };
        await this.stateBackend.saveState(
          stackName,
          this.stackRegion,
          this.withParentInfo(postRollbackState),
          {
            ...(freshEtag !== undefined && { expectedEtag: freshEtag }),
          }
        );
        this.logger.debug('State saved after deployment failure (retry succeeded)');
        if (autoRollbackClean) {
          await this.settleNestedChildrenAfterCleanRollback(
            stackName,
            rollbackSettledNested,
            await this.settleJournalAfterCleanRollback(
              stackName,
              rollbackRemainingFailedOps,
              initialDeploy
            )
          );
        }
      } catch (retryError) {
        this.logger.warn(
          `Failed to save state after rollback: ${retryError instanceof Error ? retryError.message : String(retryError)}`
        );
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
      this.resolveOutputs(
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
    // `this.outputSecrets` — the outputs' own substituted references — and
    // `resolveOutputs` filled `this.outputsTemplateSource` with the
    // unresolved values that position
    // them (#1910).
    const resolvedOutputsBeforeRedaction = outputs;
    outputs = this.redactOutputs(outputs);
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
    this.rememberRecoverableMaskedOutputs(stackName, resolvedOutputsBeforeRedaction, outputs);
  } catch (outputError) {
    await this.persistStateAfterOutputFailure(
      stackName,
      currentState,
      newResources,
      currentEtag,
      pendingMigration
    );
    // Every resource op succeeded here — provisioning was clean, only
    // output resolution failed — so rolling back is a legitimate use case
    // (issue #1183). Record a journal segment so `cdkd rollback` can revert.
    await this.writeRollbackJournalSegment(
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
      region: this.stackRegion,
      stackName: currentState.stackName,
      resources: newResources,
      ...orphansCarriedFrom(currentState),
      outputs,
      // Always written, `[]` included: on this path the bag was re-resolved,
      // so the set is KNOWN (issue #2193). Absent would read as "not known".
      exportNames: [...this.resolvedExportNames],
      // This pass's skipped set, omitted when empty (issue #2740). Copied,
      // like the `exportNames` / `imports` spreads beside it.
      ...(this.skippedOutputs && { skippedOutputs: { ...this.skippedOutputs } }),
      ...(this.recordedImports.length > 0 && { imports: [...this.recordedImports] }),
      ...(this.recordedOutputReads.length > 0 && {
        outputReads: [...this.recordedOutputReads],
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
  this: DeployEngine,
  stackName: string,
  currentState: StackState,
  newResources: Record<string, ResourceState>,
  currentEtag: string | undefined,
  pendingMigration: boolean
): Promise<void> {
  const buildState = (): StackState => ({
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: this.stackRegion,
    stackName: currentState.stackName,
    resources: newResources,
    outputs: currentState.outputs,
    ...exportNamesCarriedFrom(currentState),
    ...skippedOutputsCarriedFrom(currentState),
    ...orphansCarriedFrom(currentState),
    // Issue #2057: the UNION, like every other non-success save. This one
    // used to write `[...this.recordedImports]` WHOLESALE, copying the
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
      this.recordedImports,
      this.recordedOutputReads,
      this.crossStackReadKeyNormalizer()
    ),
    lastModified: Date.now(),
  });
  try {
    const expectedEtag = pendingMigration ? undefined : currentEtag;
    await this.stateBackend.saveState(
      stackName,
      this.stackRegion,
      this.withParentInfo(buildState()),
      {
        ...(expectedEtag !== undefined && { expectedEtag }),
        migrateLegacy: pendingMigration,
      }
    );
    this.logger.debug('State saved after output resolution failure');
  } catch (saveError) {
    this.logger.debug(
      `Retrying state save after output resolution failure (ETag mismatch): ${saveError instanceof Error ? saveError.message : String(saveError)}`
    );
    try {
      const freshState = await this.stateBackend.getState(stackName, this.stackRegion);
      const freshEtag = freshState?.etag;
      await this.stateBackend.saveState(
        stackName,
        this.stackRegion,
        this.withParentInfo(buildState()),
        {
          ...(freshEtag !== undefined && { expectedEtag: freshEtag }),
        }
      );
      this.logger.debug('State saved after output resolution failure (retry succeeded)');
    } catch (retryError) {
      this.logger.warn(
        `Failed to save state after output resolution failure: ${retryError instanceof Error ? retryError.message : String(retryError)} — resources were provisioned but not recorded; run deploy again to reconcile.`
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
