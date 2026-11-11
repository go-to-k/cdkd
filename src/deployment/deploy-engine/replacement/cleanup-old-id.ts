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
import { removeSuperseded } from '../../superseded-resources.js';
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
 * CloudFormation retains a replaced resource under it. So does `Snapshot`
 * (unless `--skip-final-snapshot`): a custom resource has no snapshot, and
 * every other replacement delete refuses the policy for such a type before
 * deleting, which this one, run after the deploy, cannot do.
 *
 * Never an id another record of the stack names when the delete is sent
 * (two custom resources swapping names): cdkd never deletes an id a record
 * names, as the superseded retry and `cdkd destroy` do not.
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
    /**
     * go-to-k/cdkd#4682: today's values at the old record's NoEcho
     * coordinates. Called here so a failure to compute them never fails the
     * update that already succeeded.
     */
    noEchoDeleteValues: () => Promise<NoEchoDeleteValues | undefined>;
  }
): Promise<void> {
  const { logicalId, oldResource } = input;
  const shownOldId = displayPhysicalId(oldResource.resourceType, oldResource.physicalId);
  const keptBy =
    input.updateReplacePolicy === 'Retain'
      ? 'Retain'
      : input.updateReplacePolicy === 'Snapshot' && deps.options.skipFinalSnapshot !== true
        ? 'Snapshot'
        : undefined;
  if (keptBy !== undefined) {
    const line = safeMsg`  ${logicalId} has UpdateReplacePolicy: ${keptBy} — its old physical id (${shownOldId}) is not sent a Delete and is no longer tracked by cdkd`;
    if (keptBy === 'Retain') deps.logger.info(line);
    else deps.logger.warn(`${line} (a custom resource takes no snapshot)`);
    return;
  }
  let noEchoDeleteValues: NoEchoDeleteValues | undefined;
  try {
    noEchoDeleteValues = await input.noEchoDeleteValues();
  } catch {
    // Its text is not shown: it may carry a re-resolved value.
    deps.logger.warn(
      safeMsg`  ⚠ ${logicalId}'s old physical id (${shownOldId}) is not sent a Delete: cdkd could not prepare its properties. It is no longer tracked by cdkd; delete what the handler made under it manually`
    );
    return;
  }
  const send = async (isRetry: boolean): Promise<void> => {
    const others = Object.fromEntries(
      Object.entries(deps.deployStateResources()).filter(([id]) => id !== logicalId)
    );
    const holderId = Object.entries(others).find(
      ([, record]) => record?.physicalId === oldResource.physicalId
    )?.[0];
    if (holderId !== undefined) {
      deps.logger.warn(
        safeMsg`  ⚠ ${logicalId}'s old physical id (${shownOldId}) is not sent a Delete: ${holderId} records the same physical id, and cdkd never deletes an id a record names`
      );
      const recorded = run.supersededEntries.get(logicalId);
      if (recorded !== undefined && run.supersededHost !== undefined) {
        removeSuperseded(run.supersededHost, recorded);
        run.supersededEntries.delete(logicalId);
      }
      return;
    }
    await deleteReplacedAfterCreate(
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
      noEchoDeleteValues,
      isRetry
    );
  };
  const deferred = run.deferredReplacedDeletes;
  if (deferred === undefined) {
    // Not reached by a deploy (`executeDeployment` sets the map for its whole
    // DAG); a caller outside one has no cleanup phase to wait for.
    deps.logger.info(safeMsg`  Deleting old ${logicalId} (${shownOldId})...`);
    await send(false);
    return;
  }
  recordSupersededForDeferral(run, deps, logicalId, oldResource, {
    updateReplacePolicy: input.updateReplacePolicy,
    finalSnapshotIdentifier: undefined,
    noEchoDeleteValues,
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
