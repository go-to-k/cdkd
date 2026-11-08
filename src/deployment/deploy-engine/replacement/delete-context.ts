/**
 * The delete context a replacement's delete of the OLD resource runs under,
 * and the final-snapshot gate that runs before it.
 * Moved out of `deploy-engine/replacement.ts` (go-to-k/cdkd#5835), which
 * re-exports every symbol it exported, so no importer changes.
 */
import {
  ATOMIC_FINAL_SNAPSHOT_TYPES,
  PRE_DELETE_SNAPSHOT_TYPES,
  buildFinalSnapshotIdentifier,
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
 *     fail-closes on the context field as defense-in-depth).
 *   - `PRE_DELETE_SNAPSHOT_TYPES` (EC2 Volume / Redshift Cluster /
 *     ElastiCache ReplicationGroup) → creates the snapshot and waits for
 *     it here, then returns undefined (the subsequent delete is plain).
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
  if (policy !== 'Snapshot' || deps.options.skipFinalSnapshot === true) return undefined;
  if (ATOMIC_FINAL_SNAPSHOT_TYPES.has(resourceType) && currentResource.provisionedBy !== 'cc-api') {
    return buildFinalSnapshotIdentifier(currentResource.physicalId, resourceType);
  }
  if (ATOMIC_FINAL_SNAPSHOT_TYPES.has(resourceType)) {
    throw ccRoutedFinalSnapshotError(logicalId, resourceType, '--skip-final-snapshot');
  }
  if (PRE_DELETE_SNAPSHOT_TYPES.has(resourceType)) {
    // Region-pinned clients: `getAwsClients()` is a process-global that a
    // concurrent stack's deploy can repoint at ANOTHER region
    // (`--stack-concurrency > 1` + multi-region apps); a wrong-region
    // snapshot call 404s as a NotFound, which would be read as "source
    // gone" and skip the snapshot. Prefer the engine-scoped clients
    // threaded via options.
    await createPreDeleteFinalSnapshot(
      resourceType,
      currentResource.physicalId,
      logicalId,
      deps.options.finalSnapshotClients ?? getAwsClients(),
      mask === undefined
        ? deps.logger
        : {
            info: (message) => deps.logger.info(mask(message)),
            debug: (message) => deps.logger.debug(mask(message)),
          }
    );
    return undefined;
  }
  throw unsupportedFinalSnapshotError(logicalId, resourceType, '--skip-final-snapshot');
}
