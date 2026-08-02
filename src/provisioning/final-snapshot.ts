import {
  CreateSnapshotCommand,
  DescribeSnapshotsCommand,
  type EC2Client,
} from '@aws-sdk/client-ec2';
import { CdkdError } from '../utils/error-handler.js';

/** Minimal logger surface used here (avoids coupling to the full Logger type). */
type InfoLogger = { info(message: string): void; debug(message: string): void };

/**
 * `DeletionPolicy: Snapshot` support (issue #1352).
 *
 * CloudFormation creates a final snapshot BEFORE deleting a resource whose
 * `DeletionPolicy` is `Snapshot`. cdkd historically treated the policy as
 * `Delete` (no snapshot — silent data loss vs CFn, live-A/B-confirmed on
 * `AWS::EC2::Volume`). The destroy paths now honor the policy through the
 * two mechanisms below; a Snapshot-tagged type supported by NEITHER is
 * refused with an actionable error unless `--skip-final-snapshot` opts into
 * the data loss.
 *
 * The full CFn-documented Snapshot-capable type list (CFn refuses the
 * attribute on anything else): AWS::EC2::Volume, AWS::ElastiCache::CacheCluster,
 * AWS::ElastiCache::ReplicationGroup, AWS::Neptune::DBCluster,
 * AWS::RDS::DBCluster, AWS::RDS::DBInstance, AWS::Redshift::Cluster,
 * AWS::DocDB::DBCluster.
 */

/**
 * Types whose delete API takes an atomic final-snapshot parameter. The
 * destroy paths generate a snapshot identifier and pass it via
 * `DeleteContext.finalSnapshotIdentifier`; the type's SDK provider flips its
 * delete call from `SkipFinalSnapshot: true` to the final-snapshot form.
 */
export const ATOMIC_FINAL_SNAPSHOT_TYPES: ReadonlySet<string> = new Set([
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBCluster',
  'AWS::Neptune::DBCluster',
  'AWS::DocDB::DBCluster',
  'AWS::ElastiCache::CacheCluster',
]);

/**
 * Types with no atomic delete parameter, where cdkd snapshots explicitly
 * BEFORE the (routing-layer-agnostic) delete. `AWS::EC2::Volume` is
 * CC-API-routed, so the pre-delete snapshot lives at the destroy call sites,
 * not in a provider.
 */
export const PRE_DELETE_SNAPSHOT_TYPES: ReadonlySet<string> = new Set(['AWS::EC2::Volume']);

/**
 * CFn-documented Snapshot-capable types cdkd cannot snapshot yet (issue
 * #1353): named in the refusal error so users know the policy is valid,
 * just unimplemented — as opposed to a template mistake.
 */
export const UNSUPPORTED_FINAL_SNAPSHOT_TYPES: ReadonlySet<string> = new Set([
  'AWS::Redshift::Cluster',
  'AWS::ElastiCache::ReplicationGroup',
]);

/** Can cdkd honor `DeletionPolicy: Snapshot` for this type? */
export function supportsFinalSnapshot(resourceType: string): boolean {
  return (
    ATOMIC_FINAL_SNAPSHOT_TYPES.has(resourceType) || PRE_DELETE_SNAPSHOT_TYPES.has(resourceType)
  );
}

/**
 * Build the final-snapshot identifier for an atomic-parameter delete.
 *
 * Constraints are the intersection of the RDS / Neptune / DocDB snapshot
 * identifier rules and the ElastiCache snapshot name rules: start with a
 * letter, letters/digits/hyphens only, no consecutive or trailing hyphen.
 * The physical id already satisfies the source API's naming rules; it is
 * lowercased (RDS canonicalizes to lowercase anyway) and defensively
 * re-sanitized. A UTC timestamp suffix keeps repeated destroys of a
 * re-created same-name resource from colliding; within ONE destroy run the
 * identifier is generated once per resource, so delete retries reuse it.
 */
export function buildFinalSnapshotIdentifier(physicalId: string, now: Date = new Date()): string {
  const ts = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..*$/, '')
    .replace('T', '-')
    .toLowerCase();
  let base = physicalId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(base)) base = `r${base}`;
  // Total <= 255 (RDS limit); leave room for the suffix.
  const suffix = `-final-${ts}`;
  base = base.slice(0, 255 - suffix.length).replace(/-+$/, '');
  return `${base}${suffix}`;
}

/** Tag key marking a cdkd-created final snapshot of an EBS volume. */
export const EBS_FINAL_SNAPSHOT_TAG_KEY = 'cdkd:final-snapshot-of';

/** Test seam (matches the `describe-type.ts` / macro-expander pattern). */
export const finalSnapshotDelays = {
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

const EBS_SNAPSHOT_POLL_INTERVAL_MS = 5_000;
const EBS_SNAPSHOT_TIMEOUT_MS = 60 * 60 * 1_000;

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isVolumeNotFound(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'InvalidVolume.NotFound' || errMsg(error).includes('InvalidVolume.NotFound');
}

/**
 * Create (or resume waiting on) the final EBS snapshot of a volume and wait
 * until it completes, mirroring CloudFormation's observable behavior — CFn
 * deletes the volume only after the final snapshot is done.
 *
 * Idempotent across destroy re-runs: an existing pending/completed snapshot
 * carrying the `cdkd:final-snapshot-of: <volumeId>` tag is reused instead of
 * creating a second one.
 *
 * @returns the snapshot id, or `null` when the volume no longer exists
 *   (nothing to snapshot; the subsequent delete is idempotent too).
 */
export async function createEbsFinalSnapshot(
  client: EC2Client,
  volumeId: string,
  logicalId: string,
  logger: InfoLogger
): Promise<string | null> {
  let snapshotId: string | undefined;
  try {
    const existing = await client.send(
      new DescribeSnapshotsCommand({
        OwnerIds: ['self'],
        Filters: [
          { Name: `tag:${EBS_FINAL_SNAPSHOT_TAG_KEY}`, Values: [volumeId] },
          { Name: 'status', Values: ['pending', 'completed'] },
        ],
      })
    );
    snapshotId = existing.Snapshots?.[0]?.SnapshotId;
    if (snapshotId) {
      logger.debug(
        `Reusing existing final snapshot ${snapshotId} for ${logicalId} (${volumeId}) from a previous destroy attempt`
      );
    }
  } catch (probeError) {
    // Best-effort reuse probe — fall through to CreateSnapshot.
    logger.debug(`Final-snapshot reuse probe failed for ${volumeId}: ${errMsg(probeError)}`);
  }

  if (!snapshotId) {
    try {
      const created = await client.send(
        new CreateSnapshotCommand({
          VolumeId: volumeId,
          Description: `cdkd final snapshot for ${volumeId} (DeletionPolicy: Snapshot)`,
          TagSpecifications: [
            {
              ResourceType: 'snapshot',
              Tags: [{ Key: EBS_FINAL_SNAPSHOT_TAG_KEY, Value: volumeId }],
            },
          ],
        })
      );
      snapshotId = created.SnapshotId;
    } catch (createError) {
      if (isVolumeNotFound(createError)) {
        logger.debug(
          `Volume ${volumeId} no longer exists — skipping final snapshot for ${logicalId}`
        );
        return null;
      }
      throw new CdkdError(
        `Failed to create the final snapshot for ${logicalId} (${volumeId}) required by ` +
          `DeletionPolicy: Snapshot: ${errMsg(createError)}. The volume was NOT deleted.`,
        'FINAL_SNAPSHOT_FAILED'
      );
    }
  }
  if (!snapshotId) {
    throw new CdkdError(
      `CreateSnapshot for ${logicalId} (${volumeId}) returned no snapshot id. The volume was NOT deleted.`,
      'FINAL_SNAPSHOT_FAILED'
    );
  }

  logger.info(
    `Creating final snapshot ${snapshotId} for ${logicalId} (${volumeId}) — DeletionPolicy: Snapshot`
  );

  const deadline = Date.now() + EBS_SNAPSHOT_TIMEOUT_MS;
  for (;;) {
    const described = await client.send(
      new DescribeSnapshotsCommand({ SnapshotIds: [snapshotId] })
    );
    const state = described.Snapshots?.[0]?.State;
    if (state === 'completed') {
      logger.info(`Final snapshot ${snapshotId} completed for ${logicalId} (${volumeId})`);
      return snapshotId;
    }
    if (state === 'error') {
      throw new CdkdError(
        `Final snapshot ${snapshotId} for ${logicalId} (${volumeId}) entered 'error' state. ` +
          `The volume was NOT deleted.`,
        'FINAL_SNAPSHOT_FAILED'
      );
    }
    if (Date.now() >= deadline) {
      throw new CdkdError(
        `Timed out waiting for final snapshot ${snapshotId} of ${logicalId} (${volumeId}) to ` +
          `complete. The volume was NOT deleted; the snapshot continues in AWS — re-run the ` +
          `destroy once it completes (the existing snapshot is reused, not duplicated).`,
        'FINAL_SNAPSHOT_TIMEOUT'
      );
    }
    await finalSnapshotDelays.sleep(EBS_SNAPSHOT_POLL_INTERVAL_MS);
  }
}

/**
 * Build the refusal error for a Snapshot-tagged type cdkd cannot snapshot.
 * Thrown by the destroy call sites BEFORE any delete is issued.
 */
export function unsupportedFinalSnapshotError(
  logicalId: string,
  resourceType: string,
  skipFlagHint: string
): CdkdError {
  const known = UNSUPPORTED_FINAL_SNAPSHOT_TYPES.has(resourceType)
    ? ' cdkd does not implement final snapshots for this type yet (issue #1353).'
    : ` cdkd does not implement final snapshots for this type (CloudFormation itself only supports Snapshot on: EC2 Volume, ElastiCache CacheCluster / ReplicationGroup, Neptune / RDS / DocDB clusters, RDS instances, Redshift clusters).`;
  return new CdkdError(
    `${logicalId} (${resourceType}) has DeletionPolicy: Snapshot, but${known} ` +
      `Deleting it now would destroy its data WITHOUT the final snapshot the policy promises. ` +
      `Re-run with ${skipFlagHint} to delete WITHOUT a final snapshot (DATA LOSS), or retain ` +
      `the resource (DeletionPolicy: Retain) and delete it manually after snapshotting.`,
    'FINAL_SNAPSHOT_UNSUPPORTED'
  );
}
