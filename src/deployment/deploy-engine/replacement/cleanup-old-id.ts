/**
 * The delete of the OLD physical id an in-place update left behind
 * (go-to-k/cdkd#6117): a custom resource whose `Update` handler answered a new
 * `PhysicalResourceId`.
 */
import type { NoEchoDeleteValues } from '../../noecho-delete-reresolution.js';
import type { ResourceProvider } from '../../../types/resource.js';
import type { ResourceState } from '../../../types/state.js';
import { displayPhysicalId } from '../../../provisioning/secret-physical-id.js';
import { safeMsg } from '../../../utils/display-safe.js';
import type { RecordedSecretValues } from '../../secret-redaction.js';
import { deleteReplacedAfterCreate, recordSupersededForDeferral } from './delete-replaced.js';
import type { ReplacementRunState, ReplacementDeps } from './run-state.js';

/**
 * CloudFormation treats a changed `PhysicalResourceId` from a custom
 * resource's `Update` as a replacement: once the stack update succeeded, its
 * cleanup phase sends the handler `RequestType: Delete` for the OLD id with
 * the OLD properties. Here that delete joins the deploy's deferred deletes
 * (go-to-k/cdkd#4900), which run only after every change of the deploy
 * succeeded; a failed deploy never sends it, so its rollback finds the old id
 * as the update left it. The old record is kept in state until then
 * (go-to-k/cdkd#5111), so a deploy killed first leaves it for the next deploy
 * or `cdkd destroy`.
 *
 * The payload is the old record's properties, with the record's NoEcho
 * coordinates re-resolved from today's template (`noEchoDeleteValues`,
 * go-to-k/cdkd#4682); the custom-resource provider skips, rather than sends,
 * a payload still holding a mask. A failed or skipped delete warns naming the
 * old id and never fails the deploy, as in CloudFormation's cleanup phase;
 * a skip counts the row as a partial update, as for every replaced resource
 * whose delete was skipped (go-to-k/cdkd#4043).
 *
 * `UpdateReplacePolicy: Retain` keeps the old id: no delete is sent, as
 * CloudFormation retains a replaced resource under it.
 */
export async function deleteOldIdAfterDeploy(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  input: {
    logicalId: string;
    /** The record the update ran against: the old id, type and properties. */
    oldResource: ResourceState;
    deleteProvider: ResourceProvider;
    deleteProvisionedBy: 'sdk' | 'cc-api' | undefined;
    updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | undefined;
    secrets: RecordedSecretValues;
    noEchoDeleteValues: NoEchoDeleteValues | undefined;
  }
): Promise<void> {
  const { logicalId, oldResource } = input;
  const shownOldId = displayPhysicalId(oldResource.resourceType, oldResource.physicalId);
  if (input.updateReplacePolicy === 'Retain') {
    deps.logger.info(
      safeMsg`  ${logicalId} has UpdateReplacePolicy: Retain — its old physical id (${shownOldId}) is not sent a Delete and is no longer tracked by cdkd`
    );
    return;
  }
  const send = (isRetry: boolean): Promise<void> =>
    deleteReplacedAfterCreate(
      run,
      deps,
      logicalId,
      oldResource.resourceType,
      oldResource,
      input.deleteProvider,
      oldResource.properties ?? {},
      undefined,
      input.updateReplacePolicy,
      input.secrets,
      input.deleteProvisionedBy,
      input.noEchoDeleteValues,
      isRetry
    );
  const deferred = run.deferredReplacedDeletes;
  if (deferred === undefined) {
    // Outside a deploy's DAG there is no cleanup phase to wait for.
    deps.logger.info(safeMsg`  Deleting old ${logicalId} (${shownOldId})...`);
    await send(false);
    return;
  }
  recordSupersededForDeferral(run, deps, logicalId, oldResource, {
    updateReplacePolicy: input.updateReplacePolicy,
    finalSnapshotIdentifier: undefined,
    noEchoDeleteValues: input.noEchoDeleteValues,
    inlinePolicyClaimed: undefined,
  });
  deferred.set(logicalId, {
    physicalId: oldResource.physicalId,
    resourceType: oldResource.resourceType,
    provisionedBy: input.deleteProvisionedBy,
    failureMessage: undefined,
    retry: () => send(true),
  });
  deps.logger.info(
    safeMsg`  ${logicalId}'s old physical id (${shownOldId}) is deleted after the rest of the deploy succeeds`
  );
}
