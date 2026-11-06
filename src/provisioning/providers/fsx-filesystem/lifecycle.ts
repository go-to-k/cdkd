import type { FSxFileSystemProvider } from '../fsx-filesystem-provider.js';
import {
  DescribeFileSystemsCommand,
  FileSystemNotFound,
  type FileSystem,
} from '@aws-sdk/client-fsx';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { markNotGone } from '../../not-gone.js';
import type { ResourceIdentityVerdict } from '../../../types/resource.js';
import {
  FILE_SYSTEM_ID_PATTERN,
  FILE_SYSTEM_NOT_LIVE_LIFECYCLES,
  isTransientFsxError,
} from './shared.js';

/**
 * go-to-k/cdkd#4606: whether the file system a failed CREATE journaled (one
 * whose wait failed and whose cleanup delete failed too) is the one the
 * record under the same logical id holds (a fix-forward that created a new
 * one there).
 *
 * The identity is the `FileSystemId` FSx generates: the physical id the
 * create, the import and every variant (Lustre / Windows / ONTAP / OpenZFS,
 * from a backup or not) record, unique per account and region and never
 * reassigned, so two distinct ids in the stack's region name two distinct
 * file systems. Any other form is `'unknown'`. Equal ids are `'same'`
 * without a read. After the region check, the record's file system must
 * read back under its own id short of `DELETING` / `FAILED`, else
 * `'unknown'`; the journaled one is then `'different'` whether it reads
 * back under its own id (in any lifecycle) or FSx reports it gone.
 *
 * The type is never Cloud Control-routed (`disableCcApiFallback`), so every
 * journaled file system reaches this method.
 */
export async function isSameResource(
  this: FSxFileSystemProvider,
  journaledPhysicalId: string,
  record: { physicalId: string },
  resourceType: string,
  context: { expectedRegion: string }
): Promise<ResourceIdentityVerdict> {
  if (resourceType !== 'AWS::FSx::FileSystem') return 'unknown';
  if (
    !FILE_SYSTEM_ID_PATTERN.test(journaledPhysicalId) ||
    !FILE_SYSTEM_ID_PATTERN.test(record.physicalId)
  ) {
    return 'unknown';
  }
  if (journaledPhysicalId === record.physicalId) return 'same';
  const clientRegion = await this.getClient().config.region();
  if (clientRegion !== context.expectedRegion) return 'unknown';
  const recordRead = await this.readFileSystemForIdentity(record.physicalId);
  if (
    recordRead === undefined ||
    recordRead.id !== record.physicalId ||
    FILE_SYSTEM_NOT_LIVE_LIFECYCLES.has(recordRead.lifecycle ?? '')
  ) {
    return 'unknown';
  }
  const journaledRead = await this.readFileSystemForIdentity(journaledPhysicalId);
  return journaledRead?.id === record.physicalId ? 'same' : 'different';
}

/**
 * The id and lifecycle `DescribeFileSystems` reports for `fileSystemId`, or
 * `undefined` when FSx reports it gone (`FileSystemNotFound`). Any other
 * failure, and a response naming no file system, throws: "could not read"
 * never reads as "gone".
 */
export async function readFileSystemForIdentity(
  this: FSxFileSystemProvider,
  fileSystemId: string
): Promise<{ id: string; lifecycle: string | undefined } | undefined> {
  let response;
  try {
    response = await this.getClient().send(
      new DescribeFileSystemsCommand({ FileSystemIds: [fileSystemId] })
    );
  } catch (error) {
    if (error instanceof FileSystemNotFound) return undefined;
    throw error;
  }
  const fileSystems = response.FileSystems ?? [];
  if (fileSystems.length !== 1 || typeof fileSystems[0]?.FileSystemId !== 'string') {
    throw new Error('DescribeFileSystems did not return exactly the file system asked for');
  }
  return { id: fileSystems[0].FileSystemId, lifecycle: fileSystems[0].Lifecycle };
}

/**
 * Issue the polling `DescribeFileSystems` with bounded tolerance for
 * TRANSIENT errors (throttling / 5xx / connection resets): up to
 * `maxConsecutiveTransient` consecutive failures are absorbed (with the
 * normal poll delay) before the error propagates. A 5-10 minute create
 * poll at 15s intervals would otherwise turn a single throttle into a
 * spurious failure + best-effort rollback cycle. Non-transient errors
 * (incl. FileSystemNotFound) propagate immediately.
 */
export async function describeForPoll(
  this: FSxFileSystemProvider,
  fileSystemId: string,
  transientState: { count: number },
  maxConsecutiveTransient = 5
): Promise<FileSystem | undefined> {
  try {
    const response = await this.getClient().send(
      new DescribeFileSystemsCommand({ FileSystemIds: [fileSystemId] })
    );
    transientState.count = 0;
    return response.FileSystems?.[0];
  } catch (error) {
    const msg = describeAwsFailure(error).detail;
    if (isTransientFsxError(error) && transientState.count < maxConsecutiveTransient) {
      transientState.count += 1;
      this.logger.debug(
        `Transient DescribeFileSystems error while polling ${fileSystemId} (${transientState.count}/${maxConsecutiveTransient}): ${msg} — retrying`
      );
      // Signal "no data this round" — the caller's loop delay applies.
      return undefined;
    }
    throw error;
  }
}

export async function waitForFileSystemAvailable(
  this: FSxFileSystemProvider,
  fileSystemId: string,
  logicalId: string,
  resourceType: string,
  mask?: MaskerFn
): Promise<FileSystem> {
  const startTime = Date.now();
  const transientState = { count: 0 };

  while (Date.now() - startTime < this.maxWaitMs) {
    const fs = await this.describeForPoll(fileSystemId, transientState);
    const lifecycle = fs?.Lifecycle;

    if (fs && lifecycle === 'AVAILABLE') return fs;

    if (lifecycle === 'FAILED' || lifecycle === 'MISCONFIGURED') {
      throw this.wrapStatusReasonError(
        mask,
        fs?.FailureDetails?.Message,
        (text, cause) =>
          new ProvisioningError(
            `FSx FileSystem ${fileSystemId} entered lifecycle state ${lifecycle}: ${text}`,
            resourceType,
            logicalId,
            fileSystemId,
            cause
          )
      );
    }

    this.logger.debug(
      `FSx FileSystem ${fileSystemId} state: ${lifecycle ?? 'unknown'}, waiting...`
    );
    await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
  }

  throw new ProvisioningError(
    `Timed out waiting for FSx FileSystem ${fileSystemId} to become AVAILABLE (${Math.round(this.maxWaitMs / 60000)} min)`,
    resourceType,
    logicalId,
    fileSystemId
  );
}

/**
 * Wait until the async `FILE_SYSTEM_UPDATE` administrative action kicked
 * off by `UpdateFileSystem` completes (and the Lifecycle is AVAILABLE).
 * `STORAGE_OPTIMIZATION` actions are intentionally ignored — they can run
 * for hours after a capacity grow, and CloudFormation does not wait for
 * them either (`UPDATED_OPTIMIZING` counts as done). A FAILED update
 * action is a hard error carrying the action's failure message.
 *
 * `actionThresholdMs` scopes the wait to THIS update's actions: FSx keeps
 * terminal (COMPLETED / FAILED) actions in the history, so only actions
 * whose `RequestTime` is at or after the threshold are considered — a
 * PAST failed update must not fail this one's retry. An action without a
 * `RequestTime` is conservatively tracked.
 *
 * `requireActionObservation` guards the eventual-consistency race: when
 * the UpdateFileSystem response confirmed a newly-created action, the
 * wait refuses to return until an in-threshold action has been observed
 * in at least one Describe response — a lagging read replica could
 * otherwise briefly show none and cause a premature return with the
 * pre-update config. Terminal actions stay in the history, so the
 * observation is guaranteed to eventually succeed (bounded by
 * `maxWaitMs`).
 */
export async function waitForUpdateActionComplete(
  this: FSxFileSystemProvider,
  fileSystemId: string,
  logicalId: string,
  resourceType: string,
  actionThresholdMs: number,
  requireActionObservation: boolean,
  deadline: number,
  mask?: MaskerFn
): Promise<FileSystem> {
  const transientState = { count: 0 };
  let seenTrackedAction = false;

  while (Date.now() < deadline) {
    const fs = await this.describeForPoll(fileSystemId, transientState);

    if (fs) {
      const updateActions = (fs.AdministrativeActions ?? []).filter(
        (a) =>
          a.AdministrativeActionType === 'FILE_SYSTEM_UPDATE' &&
          (a.RequestTime === undefined || a.RequestTime.getTime() >= actionThresholdMs)
      );
      if (updateActions.length > 0) seenTrackedAction = true;
      const failed = updateActions.find((a) => a.Status === 'FAILED');
      if (failed) {
        throw this.wrapStatusReasonError(
          mask,
          failed.FailureDetails?.Message,
          (text, cause) =>
            new ProvisioningError(
              `FSx FileSystem ${fileSystemId} update failed (FILE_SYSTEM_UPDATE administrative action): ${text}`,
              resourceType,
              logicalId,
              fileSystemId,
              cause
            )
        );
      }
      const inProgress = updateActions.some(
        (a) => a.Status === 'PENDING' || a.Status === 'IN_PROGRESS'
      );
      const observationSatisfied = !requireActionObservation || seenTrackedAction;
      if (!inProgress && observationSatisfied && fs.Lifecycle === 'AVAILABLE') return fs;

      this.logger.debug(
        `FSx FileSystem ${fileSystemId} update in progress (lifecycle: ${fs.Lifecycle ?? 'unknown'}), waiting...`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
  }

  throw new ProvisioningError(
    `Timed out waiting for FSx FileSystem ${fileSystemId} update to complete (${Math.round(this.maxWaitMs / 60000)} min)`,
    resourceType,
    logicalId,
    fileSystemId
  );
}

export async function waitForFileSystemDeleted(
  this: FSxFileSystemProvider,
  fileSystemId: string,
  logicalId: string,
  resourceType: string,
  mask?: MaskerFn
): Promise<void> {
  const startTime = Date.now();
  const transientState = { count: 0 };

  while (Date.now() - startTime < this.maxWaitMs) {
    let fs: FileSystem | undefined;
    let sawResponse = true;
    try {
      fs = await this.describeForPoll(fileSystemId, transientState);
      if (fs === undefined && transientState.count > 0) {
        // Transient error absorbed — not a "gone" signal.
        sawResponse = false;
      }
    } catch (error) {
      if (error instanceof FileSystemNotFound) return;
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to poll FSx FileSystem ${fileSystemId} deletion: ${text}`,
            resourceType,
            logicalId,
            fileSystemId,
            cause
          )
      );
      // As in `delete()`: only the typed not-found above is gone.
      throw error instanceof Error && error.name.includes('NotFound')
        ? markNotGone(thrown)
        : thrown;
    }

    if (!fs && sawResponse) return;
    if (!fs) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      continue;
    }

    if (fs.Lifecycle === 'FAILED') {
      throw this.wrapStatusReasonError(
        mask,
        fs.FailureDetails?.Message,
        (text, cause) =>
          new ProvisioningError(
            `FSx FileSystem ${fileSystemId} entered lifecycle state FAILED during deletion: ${text}`,
            resourceType,
            logicalId,
            fileSystemId,
            cause
          )
      );
    }

    this.logger.debug(
      `FSx FileSystem ${fileSystemId} state: ${fs.Lifecycle ?? 'unknown'}, waiting for deletion...`
    );
    await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
  }

  throw new ProvisioningError(
    `Timed out waiting for FSx FileSystem ${fileSystemId} deletion (${Math.round(this.maxWaitMs / 60000)} min) — verify and delete it manually to stop billing`,
    resourceType,
    logicalId,
    fileSystemId
  );
}
