import {
  currentNameGeneration,
  getCurrentStackInstanceId,
} from '../../../provisioning/resource-name.js';
import { timePhase } from '../../../utils/phase-timings.js';
import { type ResourceChange } from '../../../types/state.js';
import { DagExecutor } from '../../dag-executor.js';
import { extractTemplateAttributes } from '../record-shape.js';
import type { FailedOperation } from '../../rollback-executor.js';
import { isRefusedBeforeApplying } from '../../prior-attempt-scope.js';
import { isReplacementNameRefusal } from '../name-collision.js';
import { abandonedRequestOf } from '../../../provisioning/wait-abandoned.js';
import {
  createdBeforeFailure,
  createdResourceIdentityBeforeFailure,
} from '../../../provisioning/auxiliary-failure.js';
import {
  CreatedResourceSink,
  collectCreatedResources,
} from '../../../provisioning/created-resource-sink.js';
import { provisionResource } from '../provision.js';
import { withNameGenerationReached } from '../../../state/name-generation.js';
import {
  deadlineFiredFor,
  journalOrphanIdentity,
  journaledOrphanPolicy,
  recordUnsettledMarks,
  replacementOrphanOpFor,
} from './helpers.js';
import type { DeployRun } from './run.js';

/** go-to-k/cdkd#4604: types whose replacement's new resource is never journaled (see execute). */
const NO_REPLACEMENT_ORPHAN_TYPES: ReadonlySet<string> = new Set([
  'AWS::CloudFormation::Stack',
  'AWS::SQS::QueuePolicy',
  'AWS::SNS::TopicPolicy',
]);

/**
 * One CREATE / UPDATE node of the create/update DAG phase (go-to-k/cdkd#5835:
 * moved out of `executeDeployment`, whose closure it was).
 */
export async function provisionCreateUpdateNode(
  run: DeployRun,
  createUpdateExecutor: DagExecutor<ResourceChange>,
  enqueueLostChildren: (executor: DagExecutor<ResourceChange>) => void,
  node: { id: string; data: ResourceChange }
): Promise<void> {
  const {
    engine,
    template,
    currentState,
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
    startedUpdates,
    settledUpdates,
    inFlightWrites,
  } = run;
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
    const markedCreatedId = createdBeforeFailure(provisionError, logicalId, change.resourceType);
    const createdId =
      change.changeType === 'CREATE' && statePhysicalId === undefined ? markedCreatedId : undefined;
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
      change.changeType === 'CREATE' && statePhysicalId === undefined && createdId === undefined
        ? abandonedRequestOf(provisionError)
        : undefined;
    // The parser refuses any other token shape, and an unreadable
    // journal would cost every entry, so an odd one is not journaled.
    const pendingRequest =
      abandoned?.operation === 'CREATE' && /^[-A-Za-z0-9+/=]{1,128}$/.test(abandoned.requestToken)
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
      newResources[logicalId] = withNameGenerationReached(heldNow, logicalId, attemptedGeneration);
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
    // go-to-k/cdkd#6120: the old id is still live, so the rollback sends the
    // new one an Update with the old properties instead of re-creating it.
    ...(change.changeType === 'UPDATE' &&
      engine.replacementRun.oldIdLeftForCleanup.has(logicalId) && {
        oldPhysicalIdLeftForCleanup: true as const,
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
}
