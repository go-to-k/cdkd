/**
 * The delete context a replacement's delete of the OLD resource runs under,
 * and the final-snapshot gate that runs before it.
 * Moved out of `deploy-engine/replacement.ts` (go-to-k/cdkd#5835), which
 * re-exports every symbol it exported, so no importer changes.
 */
import {
  ATOMIC_FINAL_SNAPSHOT_TYPES,
  PRE_DELETE_SNAPSHOT_TYPES,
  type PreDeleteSnapshotOptions,
  buildFinalSnapshotIdentifier,
  ccRoutedInstanceTakesNoSnapshot,
  ccRoutedFinalSnapshotError,
  createPreDeleteFinalSnapshot,
  replacementDeletePolicy,
  unsupportedFinalSnapshotError,
} from '../../../provisioning/final-snapshot.js';
import { getAwsClients } from '../../../utils/aws-clients.js';
import type { ReplacementDeps } from './run-state.js';

/**
 * What a replacement's delete of the OLD resource tells the provider
 * (issue #4029): the governing `UpdateReplacePolicy`, and the
 * `--skip-final-snapshot` opt-out. `CloudControlProvider.delete` reads both
 * to keep an RDS cluster or instance off the registry handler, which would
 * otherwise take an untagged snapshot of its own.
 */
export function replacementDeleteContext(
  deps: ReplacementDeps,
  updateReplacePolicy: string | undefined
): {
  deletionPolicy: string;
  skipFinalSnapshot?: true;
} {
  return {
    deletionPolicy: replacementDeletePolicy(updateReplacePolicy),
    ...(deps.options.skipFinalSnapshot === true && { skipFinalSnapshot: true as const }),
  };
}

/**
 * The `Snapshot`-policy gate every engine delete site runs BEFORE its
 * delete (issues #1352 / #1353 / #1354). Given the resource's effective
 * policy for THIS delete (`DeletionPolicy` on the destroy / removal paths,
 * `UpdateReplacePolicy` on the replacement paths):
 *
 *   - not `Snapshot` (or `--skip-final-snapshot`) → no-op.
 *   - atomic type, SDK-routed → returns the generated identifier for the
 *     provider's atomic final-snapshot delete parameter.
 *   - atomic type, cc-api-routed → refuses (Cloud Control has no
 *     final-snapshot parameter; `CloudControlProvider.delete` also
 *     fail-closes on the context field as defense-in-depth), unless it is
 *     a live RDS read replica or cluster member: undefined, a plain delete
 *     (go-to-k/cdkd#6047).
 *   - `PRE_DELETE_SNAPSHOT_TYPES` (EC2 Volume / Redshift Cluster /
 *     ElastiCache ReplicationGroup) → creates the snapshot and waits for
 *     it here, then returns undefined (the subsequent delete is plain). A
 *     create-first replacement takes it at its delete instead
 *     ({@link prepareCreateFirstFinalSnapshot}).
 *   - anything else Snapshot-tagged → refuses.
 *
 * `mask` is the caller's secret masker, when it holds one: the snapshot
 * helper's info and debug lines (a withheld AWS failure's text among them,
 * go-to-k/cdkd#2319) go through it, as `rollback-executor/names.ts` does.
 */
export async function prepareFinalSnapshotForDelete(
  deps: ReplacementDeps,
  logicalId: string,
  resourceType: string,
  currentResource: { physicalId: string; provisionedBy?: 'sdk' | 'cc-api' | undefined },
  policy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined,
  mask?: (text: string) => string
): Promise<string | undefined> {
  const attemptStartedAt = Date.now();
  if (policy !== 'Snapshot' || deps.options.skipFinalSnapshot === true) return undefined;
  if (ATOMIC_FINAL_SNAPSHOT_TYPES.has(resourceType) && currentResource.provisionedBy !== 'cc-api') {
    return buildFinalSnapshotIdentifier(currentResource.physicalId, resourceType);
  }
  if (ATOMIC_FINAL_SNAPSHOT_TYPES.has(resourceType)) {
    // go-to-k/cdkd#6047: a live RDS read replica or cluster member is
    // deleted without one, as CloudFormation does.
    const takesNoSnapshot = await ccRoutedInstanceTakesNoSnapshot({
      resourceType,
      logicalId,
      physicalId: currentResource.physicalId,
      region: deps.stackRegion,
      logger: deps.logger,
      ...(mask !== undefined && { mask }),
    });
    if (takesNoSnapshot) return undefined;
    throw ccRoutedFinalSnapshotError(logicalId, resourceType, '--skip-final-snapshot');
  }
  if (PRE_DELETE_SNAPSHOT_TYPES.has(resourceType)) {
    // go-to-k/cdkd#6473: an EBS snapshot completed before this delete began
    // (an older attempt's) predates writes since; not reused.
    await takePreDeleteSnapshot(deps, logicalId, resourceType, currentResource.physicalId, mask, {
      attemptStartedAt,
    });
    return undefined;
  }
  throw unsupportedFinalSnapshotError(logicalId, resourceType, '--skip-final-snapshot');
}

/**
 * The CREATE-FIRST replacement's snapshot gate (go-to-k/cdkd#6463). As
 * {@link prepareFinalSnapshotForDelete}, except that a
 * `PRE_DELETE_SNAPSHOT_TYPES` member takes NO snapshot here: the snapshot
 * moves into the delete (`deleteReplacedAfterCreate`), which takes it right
 * before it sends the delete, inline or in the cleanup phase, so a deferred
 * delete's snapshot holds what the old copy held when it was deleted. The
 * returned identifier is then only the mark that the snapshot is still owed,
 * never the snapshot's name (the snapshot helper names it). A recorded
 * superseded entry carries it too, so a later run takes the snapshot before
 * its delete (`deleteSupersededEntry`), and an older cdkd's delete of that
 * entry fails closed instead of deleting it unsnapshotted: these three types
 * are Cloud Control routed, and that delete refuses a final-snapshot
 * identifier.
 */
export async function prepareCreateFirstFinalSnapshot(
  deps: ReplacementDeps,
  logicalId: string,
  resourceType: string,
  currentResource: { physicalId: string; provisionedBy?: 'sdk' | 'cc-api' | undefined },
  policy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined,
  mask?: (text: string) => string
): Promise<string | undefined> {
  if (
    policy === 'Snapshot' &&
    deps.options.skipFinalSnapshot !== true &&
    PRE_DELETE_SNAPSHOT_TYPES.has(resourceType)
  ) {
    return buildFinalSnapshotIdentifier(currentResource.physicalId, resourceType);
  }
  return prepareFinalSnapshotForDelete(
    deps,
    logicalId,
    resourceType,
    currentResource,
    policy,
    mask
  );
}

/** Whether a create-first delete still owes its pre-delete snapshot (go-to-k/cdkd#6463). */
export function owesPreDeleteSnapshot(
  resourceType: string,
  finalSnapshotIdentifier: string | undefined
): boolean {
  return finalSnapshotIdentifier !== undefined && PRE_DELETE_SNAPSHOT_TYPES.has(resourceType);
}

/**
 * Take a `PRE_DELETE_SNAPSHOT_TYPES` member's final snapshot and wait for it.
 * An in-flight snapshot an earlier attempt started is resumed, not
 * duplicated; `options` bounds which ones (go-to-k/cdkd#6463, #6473).
 */
export async function takePreDeleteSnapshot(
  deps: ReplacementDeps,
  logicalId: string,
  resourceType: string,
  physicalId: string,
  mask: ((text: string) => string) | undefined,
  options: PreDeleteSnapshotOptions
): Promise<void> {
  // Region-pinned clients: `getAwsClients()` is a process-global that a
  // concurrent stack's deploy can repoint at ANOTHER region
  // (`--stack-concurrency > 1` + multi-region apps); a wrong-region
  // snapshot call 404s as a NotFound, which would be read as "source
  // gone" and skip the snapshot. Prefer the engine-scoped clients
  // threaded via options.
  const logger =
    mask === undefined
      ? deps.logger
      : {
          info: (message: string) => deps.logger.info(mask(message)),
          debug: (message: string) => deps.logger.debug(mask(message)),
        };
  const clients = deps.options.finalSnapshotClients ?? getAwsClients();
  await createPreDeleteFinalSnapshot(resourceType, physicalId, logicalId, clients, logger, options);
}
