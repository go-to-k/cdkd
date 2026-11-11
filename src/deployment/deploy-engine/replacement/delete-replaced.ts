/**
 * The delete of the OLD resource after a create-first replacement
 * (`deleteReplacedAfterCreate`).
 * Moved out of `deploy-engine/replacement.ts` (go-to-k/cdkd#5835), which
 * re-exports every symbol it exported, so no importer changes.
 */
import type { NoEchoDeleteValues } from '../../noecho-delete-reresolution.js';
import { secretNameBagFor } from '../masking.js';
import type { ResourceDeleteResult, ResourceProvider } from '../../../types/resource.js';
import type { ResourceState, SupersededResourceRecord } from '../../../types/state.js';
import {
  SUPERSEDED_KEPT_REMEDY,
  addSuperseded,
  canRecordSuperseded,
  removeSuperseded,
  retryWhileInUse,
} from '../../superseded-resources.js';
import { green } from '../../../utils/colors.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { deleteSkipReason, deleteSkippedMessage } from '../../delete-outcome.js';
import { replacedDeleteFailureVerdict } from '../../rollback-executor/replaced-survivor.js';
import { reportDeleteGuards } from '../../delete-guard-scope.js';
import { isStandaloneInlinePolicyType } from '../../inline-policy-claims.js';
import { withPrintingSecrets } from '../../resource-secrets-scope.js';
import {
  type RecordedSecretValues,
  createUnionSecretMasker,
  maskSecretsInText,
} from '../../secret-redaction.js';
import { replacementDeleteContext } from './delete-context.js';
import type { ReplacementRunState, ReplacementDeps } from './run-state.js';

/**
 * The delete of a replaced resource once its replacement EXISTS. A failure
 * or a skip warns rather than fails the resource (issue #1762): the new
 * resource is created and about to be recorded, so the old one is untracked
 * either way, and failing here would roll back a replacement that
 * succeeded. Neither is recorded as a retention: both mark the old resource
 * as one that may survive (`replacedOldMaySurvive`, go-to-k/cdkd#2631), so a
 * rollback reads AWS for it before re-creating it. The delete
 * error is masked with `secrets` BEFORE it is rendered: a provider can echo
 * a resolved value.
 */
export async function deleteReplacedAfterCreate(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  logicalId: string,
  oldResourceType: string,
  currentResource: ResourceState,
  deleteProvider: ResourceProvider,
  deleteProperties: Record<string, unknown>,
  finalSnapshotIdentifier: string | undefined,
  updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined,
  secrets: RecordedSecretValues,
  /** The layer `deleteProvider` was routed to, for a guard row (issue #2422). */
  deleteProvisionedBy: 'sdk' | 'cc-api' | undefined,
  /** go-to-k/cdkd#4682: today's values at the old record's NoEcho coordinates. */
  noEchoDeleteValues?: NoEchoDeleteValues,
  /** go-to-k/cdkd#4900: the post-DAG retry, which warns rather than defers. */
  isRetry = false
): Promise<void> {
  // Initialized because the catch below can leave it unassigned.
  let deleteResult: void | ResourceDeleteResult = undefined;
  let deleteFailed = false;
  // go-to-k/cdkd#4821: a replaced standalone inline policy (`PolicyName` /
  // `RoleName` are create-only) removes its OLD name here, right after its
  // create; another writer of this deploy may have just put that name on the
  // same principal (a swap of names with an `AWS::IAM::Policy`). Only those
  // types are handed the predicate, so every other replacement is unchanged.
  const inlinePolicyClaimed = isStandaloneInlinePolicyType(oldResourceType)
    ? deps.inlinePolicyClaimedFor(oldResourceType, logicalId, deps.deployStateResources())
    : undefined;
  try {
    const sendDelete = (): Promise<void | ResourceDeleteResult> =>
      deleteProvider.delete(
        logicalId,
        currentResource.physicalId,
        oldResourceType,
        deleteProperties,
        {
          expectedRegion: deps.stackRegion,
          forceDataDelete: deps.options.forceStatefulRecreation === true,
          ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
          ...replacementDeleteContext(deps, updateReplacePolicy),
          // Issue #4157: the identity evidence of the record deleted.
          recordedAttributes: currentResource.attributes,
          recordedCreateOnlyDrops: currentResource.acceptedCreateOnlyDrops,
          // go-to-k/cdkd#4043: where the record holds a NoEcho mask.
          recordedNoEchoLeaves: currentResource.noEchoLeaves,
          ...(noEchoDeleteValues !== undefined && { noEchoDeleteValues }),
          ...(inlinePolicyClaimed && { inlinePolicyClaimed }),
          // go-to-k/cdkd#2007: the bag the call logs under and the delete
          // error below is masked with.
          maskSecrets: createUnionSecretMasker([
            secrets,
            secretNameBagFor(deps.secretsRun(), logicalId),
          ]),
        }
      );
    deleteResult = await withPrintingSecrets(secrets, () =>
      // go-to-k/cdkd#5111: the post-DAG retry waits out an "in use" refusal
      // whose user this deploy already moved off (a deleted load balancer's
      // listeners go asynchronously); the first attempt defers instead.
      isRetry ? retryWhileInUse(sendDelete, () => deps.interrupted()) : sendDelete()
    );
  } catch (deleteError) {
    const deleteMsg = maskSecretsInText(describeAwsFailure(deleteError).detail, secrets);
    deleteFailed = true;
    // go-to-k/cdkd#2631: before the deferral below, whose retry runs only
    // after this row's op is journaled (and not at all if the deploy fails
    // first; `execute.ts` re-stamps the op after it). A retry that then
    // deletes it leaves the mark: the rollback's read finds it gone and
    // re-creates, as it would have.
    // A retry never upgrades an earlier `'unconfirmed'`: that delete may
    // still be running.
    run.replacedOldMaySurvive.set(
      logicalId,
      run.replacedOldMaySurvive.get(logicalId) === 'unconfirmed'
        ? 'unconfirmed'
        : replacedDeleteFailureVerdict(deleteError)
    );
    // go-to-k/cdkd#4900: a resource this deploy has yet to update may still
    // use the old one (an endpoint on a replaced revision refuses its
    // delete), so the first failure inside a deploy's DAG is retried once
    // after the rest of the deploy, as CloudFormation's cleanup phase
    // deletes old resources only after every update.
    const deferred = run.deferredReplacedDeletes;
    if (!isRetry && deferred !== undefined) {
      deps.logger.info(
        safeMsg`  Could not delete old ${logicalId} (${currentResource.physicalId}) yet: ${deleteMsg}. Retrying after the rest of the deploy.`
      );
      // go-to-k/cdkd#5111: recorded BEFORE the row's save, which persists it:
      // a deploy killed before the retry below left the old resource in AWS
      // with no record at all.
      recordSupersededForDeferral(run, deps, logicalId, currentResource, {
        updateReplacePolicy,
        finalSnapshotIdentifier,
        noEchoDeleteValues,
        inlinePolicyClaimed,
      });
      deferred.set(logicalId, {
        physicalId: currentResource.physicalId,
        resourceType: oldResourceType,
        provisionedBy: deleteProvisionedBy,
        failureMessage: deleteMsg,
        retry: () =>
          deleteReplacedAfterCreate(
            run,
            deps,
            logicalId,
            oldResourceType,
            currentResource,
            deleteProvider,
            deleteProperties,
            finalSnapshotIdentifier,
            updateReplacePolicy,
            secrets,
            deleteProvisionedBy,
            noEchoDeleteValues,
            true
          ),
      });
      return;
    }
    // Always a warning, a not-found included: an "already gone" read off the
    // MESSAGE cannot be made safe (go-to-k/cdkd#3236) — a logical id like
    // `PageNotFound`, or a delete failing on a KMS key or role "not found"
    // while the old resource is alive, would silence the one line telling
    // the user an untracked resource may be left.
    // go-to-k/cdkd#5111: the retry of a recorded delete keeps the record.
    const kept = isRetry && run.supersededEntries.has(logicalId);
    deps.logger.warn(
      kept
        ? safeMsg`  ⚠ Failed to delete old resource ${logicalId} (${currentResource.physicalId}): ${deleteMsg}. ${SUPERSEDED_KEPT_REMEDY}.`
        : safeMsg`  ⚠ Failed to delete old resource ${logicalId} (${currentResource.physicalId}): ${deleteMsg}`
    );
  }
  // go-to-k/cdkd#5111: a retry that deleted it, or that the provider skipped
  // (warned below as untracked), drops the record.
  const recorded = isRetry ? run.supersededEntries.get(logicalId) : undefined;
  if (recorded !== undefined && !deleteFailed && run.supersededHost !== undefined) {
    removeSuperseded(run.supersededHost, recorded);
    run.supersededEntries.delete(logicalId);
  }
  // Issue #2422.
  reportDeleteGuards(deleteResult, {
    physicalId: currentResource.physicalId,
    resourceType: oldResourceType,
    provisionedBy: deleteProvisionedBy,
  });
  const skipReason = deleteSkipReason(deleteResult);
  if (skipReason !== undefined) {
    // A skip does not say the delete was not sent (a custom-resource handler
    // that refused DID get it), so it never licenses a re-adopt.
    run.replacedOldMaySurvive.set(logicalId, 'unconfirmed');
    // go-to-k/cdkd#4043 (review MEDIUM-3): the old resource survives
    // untracked, so the row is a PARTIAL update and the deploy exits 2 unless
    // `--allow-unaddressed` (the #1819 survivor contract), not a clean one.
    run.replacedDeleteSkips.set(
      logicalId,
      `the replaced ${oldResourceType} (${currentResource.physicalId}) was not deleted (${skipReason}) and is no longer tracked by cdkd`
    );
    deps.logger.warn(
      safeMsg`  ⚠ ${deleteSkippedMessage(
        logicalId,
        currentResource.physicalId,
        skipReason,
        'while cleaning up the replaced resource',
        // No command on this line, and the id is the only trace left of the
        // resource: show it, bounded, rather than describe it
        // (go-to-k/cdkd#4265).
        { commandFreeLine: true }
      )}. Delete it manually — it is no longer tracked in state.`
    );
  } else if (!deleteFailed) {
    // go-to-k/cdkd#2631: the retry deleted it, so the mark goes: a rollback's
    // read of an eventually consistent API could still see the old resource
    // and re-adopt a deleted id.
    if (isRetry) run.replacedOldMaySurvive.delete(logicalId);
    deps.logger.info(
      isRetry
        ? safeMsg`  ${green('✓')} Old ${logicalId} (${currentResource.physicalId}) deleted`
        : safeMsg`  ${green('✓')} Old resource deleted`
    );
  }
}

/**
 * go-to-k/cdkd#5111: record a deferred delete's old resource on the deploy's
 * live state, BEFORE the row's save persists it, so a deploy killed before
 * the deferred delete runs leaves it tracked rather than lost. Only when a
 * later run can send the delete with this run's context
 * (`canRecordSuperseded`).
 */
export function recordSupersededForDeferral(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  logicalId: string,
  oldResource: ResourceState,
  context: {
    updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;
    finalSnapshotIdentifier: string | undefined;
    noEchoDeleteValues: NoEchoDeleteValues | undefined;
    inlinePolicyClaimed: unknown;
  }
): void {
  const host = run.supersededHost;
  if (
    host === undefined ||
    !canRecordSuperseded(oldResource, {
      noEchoDeleteValues: context.noEchoDeleteValues,
      inlinePolicyClaimed: context.inlinePolicyClaimed,
    }) ||
    // Never an id ANOTHER record of this deploy holds: a later run would
    // delete that live resource. (This row's own record still names the old
    // id until the row completes; an equal new id never reaches here.)
    Object.entries(deps.deployStateResources()).some(
      ([id, record]) => id !== logicalId && record?.physicalId === oldResource.physicalId
    )
  ) {
    return;
  }
  const entry: SupersededResourceRecord = {
    logicalId,
    supersededAt: Date.now(),
    state: oldResource,
    ...(context.updateReplacePolicy !== undefined && {
      updateReplacePolicy: context.updateReplacePolicy,
    }),
    ...(context.finalSnapshotIdentifier !== undefined && {
      finalSnapshotIdentifier: context.finalSnapshotIdentifier,
    }),
    ...(deps.options.forceStatefulRecreation === true && { forceDataDelete: true as const }),
    ...(deps.options.skipFinalSnapshot === true && { skipFinalSnapshot: true as const }),
  };
  addSuperseded(host, entry);
  run.supersededEntries.set(logicalId, entry);
}
