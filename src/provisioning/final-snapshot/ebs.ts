import {
  CreateSnapshotCommand,
  DescribeSnapshotsCommand,
  type EC2Client,
} from '@aws-sdk/client-ec2';
import { CdkdError } from '../../utils/error-handler.js';
import {
  EBS_FINAL_SNAPSHOT_TAG_KEY,
  PRE_DELETE_SNAPSHOT_POLL_INTERVAL_MS,
  PRE_DELETE_SNAPSHOT_TIMEOUT_MS,
  errMsg,
  failureSentence,
  finalSnapshotDelays,
  finalSnapshotFailure,
  type InfoLogger,
} from './shared.js';

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
 * creating a second one. Reusing a `completed` snapshot is safe HERE (and
 * only here) because an EBS volume id is AWS-generated and never reused, so
 * the tag can only ever point at THIS volume's data — unlike the name-keyed
 * Redshift / ElastiCache APIs, whose user-chosen ids repeat across
 * generations and therefore only resume an in-flight snapshot (see
 * {@link RESUMABLE_SNAPSHOT_STATUS}).
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
      const head = `Failed to create the final snapshot for ${logicalId} (${volumeId}) required by DeletionPolicy: Snapshot`;
      throw finalSnapshotFailure(
        `${head}: ${failureSentence(logger, head, createError)} The volume was NOT deleted.`,
        createError
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

  const deadline = Date.now() + PRE_DELETE_SNAPSHOT_TIMEOUT_MS;
  // EC2 is eventually consistent: a just-created snapshot id can 404
  // (`InvalidSnapshot.NotFound`) on the first polls. Tolerate it briefly.
  let notFoundPolls = 0;
  for (;;) {
    let state: string | undefined;
    try {
      const described = await client.send(
        new DescribeSnapshotsCommand({ SnapshotIds: [snapshotId] })
      );
      state = described.Snapshots?.[0]?.State;
      notFoundPolls = 0;
    } catch (pollError) {
      const name = pollError instanceof Error ? pollError.name : '';
      const isSnapshotNotFound =
        name === 'InvalidSnapshot.NotFound' ||
        errMsg(pollError).includes('InvalidSnapshot.NotFound');
      if (isSnapshotNotFound && ++notFoundPolls <= 24) {
        state = undefined; // still propagating — keep polling
      } else {
        // Wrap EVERY poll failure in the typed FINAL_SNAPSHOT error. This is
        // load-bearing beyond nice messaging: the destroy call sites'
        // idempotent-delete heuristics match "not found" / "does not exist"
        // SUBSTRINGS and would otherwise read a raw poll error as "resource
        // already deleted", dropping a live volume from state WITHOUT
        // deleting it. The call sites rethrow FINAL_SNAPSHOT_* errors before
        // applying those heuristics.
        const head = `Failed while waiting for final snapshot ${snapshotId} of ${logicalId} (${volumeId})`;
        throw finalSnapshotFailure(
          `${head}: ${failureSentence(logger, head, pollError)} The volume was NOT deleted; ` +
            `re-run the destroy (the snapshot is reused, not duplicated).`,
          pollError
        );
      }
    }
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
    await finalSnapshotDelays.sleep(PRE_DELETE_SNAPSHOT_POLL_INTERVAL_MS);
  }
}
