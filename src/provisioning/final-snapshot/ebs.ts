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
  finalSnapshotWaitStopped,
  startedAtOrAfter,
  type InfoLogger,
  type PreDeleteSnapshotOptions,
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
 * Idempotent across destroy re-runs: an in-flight (`pending`) snapshot
 * carrying the `cdkd:final-snapshot-of: <volumeId>` tag is resumed instead of
 * creating a second one, whatever its age: it is at most one snapshot's
 * duration old, as the Redshift / ElastiCache helpers' in-flight rule. A
 * `completed` one is reused only when it started at or after this delete
 * attempt's start (`attemptStartedAt`, go-to-k/cdkd#6473): one from an older
 * attempt whose delete failed predates the writes the volume took since.
 * Reusing a `completed` snapshot at all is safe HERE (and only here) because
 * an EBS volume id is AWS-generated and never reused, so the tag can only
 * ever point at THIS volume's data — unlike the name-keyed Redshift /
 * ElastiCache APIs, whose user-chosen ids repeat across generations (see
 * `RESUMABLE_SNAPSHOT_STATUS`). A caller deleting a replaced resource's old
 * copy bounds both to a snapshot started for that delete
 * (`reuseStartedAtOrAfter`, go-to-k/cdkd#6463).
 *
 * @returns the snapshot id, or `null` when the volume no longer exists
 *   (nothing to snapshot; the subsequent delete is idempotent too).
 */
export async function createEbsFinalSnapshot(
  client: EC2Client,
  volumeId: string,
  logicalId: string,
  logger: InfoLogger,
  options: PreDeleteSnapshotOptions = {}
): Promise<string | null> {
  let snapshotId: string | undefined;
  try {
    const existing = await client.send(
      new DescribeSnapshotsCommand({
        OwnerIds: ['self'],
        Filters: [
          { Name: `tag:${EBS_FINAL_SNAPSHOT_TAG_KEY}`, Values: [volumeId] },
          // go-to-k/cdkd#6473: a snapshot of ANOTHER volume carrying the tag
          // (a hand-applied or copied tag) never stands in for this one.
          { Name: 'volume-id', Values: [volumeId] },
          { Name: 'status', Values: ['pending', 'completed'] },
        ],
      })
    );
    // go-to-k/cdkd#6463: under a bound, only a snapshot AWS started for this
    // delete stands in; an older one predates writes the volume took since.
    // go-to-k/cdkd#6473: without one, an in-flight snapshot is resumed
    // whatever its age, and a completed one only from this attempt.
    const bound = options.reuseStartedAtOrAfter;
    const completedBound = bound ?? options.attemptStartedAt ?? Date.now();
    snapshotId = existing.Snapshots?.find((s) =>
      startedAtOrAfter(s.StartTime, s.State === 'pending' ? bound : completedBound)
    )?.SnapshotId;
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
            `re-run the destroy (a snapshot still in progress is resumed, not duplicated).`,
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
          `destroy (a snapshot still in progress is resumed; once completed, the re-run ` +
          `takes a fresh one, which holds any writes since).`,
        'FINAL_SNAPSHOT_TIMEOUT'
      );
    }
    if (options.stop?.() === true) {
      throw finalSnapshotWaitStopped(snapshotId, logicalId, volumeId, 'volume');
    }
    await finalSnapshotDelays.sleep(PRE_DELETE_SNAPSHOT_POLL_INTERVAL_MS);
  }
}
