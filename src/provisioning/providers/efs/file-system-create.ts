import type { EFSProvider } from '../efs-provider.js';
import {
  CreateFileSystemCommand,
  DeleteFileSystemCommand,
  DescribeFileSystemsCommand,
  FileSystemNotFound,
  FileSystemAlreadyExists,
  type CreateFileSystemCommandInput,
  type FileSystemDescription,
  type PerformanceMode,
  type ThroughputMode,
} from '@aws-sdk/client-efs';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import {
  earliestDefined,
  reserveStackCreateToken,
  type StackCreateToken,
} from '../create-token-ledger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  isAmbiguousOutcomeError,
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
  markReplayMayCollide,
} from '../../../deployment/retryable-errors.js';
import type { ResourceCreateResult } from '../../../types/resource.js';
import { type MaskedLogSinks } from '../../masked-retry-logger.js';
import { withPasteableAwsProfile } from '../../../utils/pasteable-aws-profile.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { earliestOwnCreationTime, serverClockReading, withServerClock } from '../server-clock.js';

// ─── AWS::EFS::FileSystem ──────────────────────────────────────────

/**
 * The stack's create-token ledger was started in this deploy, so a create
 * of `logicalId` an EARLIER cdkd version sent and never recorded -- an
 * interrupted deploy -- holds the nonce-free token `base`, which this create
 * no longer sends: that file system is not handed back, and bills until
 * deleted. Name it (go-to-k/cdkd#4438). Best-effort: a lookup that fails is
 * only logged.
 */
export async function warnOfPreLedgerHolder(
  this: EFSProvider,
  logicalId: string,
  base: string,
  log: MaskedLogSinks
): Promise<void> {
  try {
    const response = await this.getClient().send(
      new DescribeFileSystemsCommand({ CreationToken: base })
    );
    for (const holder of response.FileSystems ?? []) {
      // One on its way out (a recreate's delete) is not left behind.
      if (holder.LifeCycleState === 'deleting' || holder.LifeCycleState === 'deleted') continue;
      log.warn(
        safeMsg`EFS file system ${holder.FileSystemId ?? '<unknown id>'} holds the creation token cdkd versions without a create-token ledger sent for ${logicalId}, and this create does not take it over. It was kept by an earlier destroy or replacement, or left by an interrupted create of an earlier cdkd version. It may hold data: inspect it before deleting it.`
      );
    }
  } catch (error) {
    log.debug(
      safeMsg`Could not look up an EFS file system an earlier cdkd version created for ${logicalId}: ${
        describeAwsFailure(error).detail
      }`
    );
  }
}

export async function createFileSystem(
  this: EFSProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceCreateResult> {
  log.debug(`Creating EFS FileSystem ${logicalId}`);

  // The CreationToken is EFS's idempotency key. A CreateFileSystem whose
  // token is already bound to a file system in this account and region does
  // NOT create a second one: EFS refuses it with `FileSystemAlreadyExists`,
  // naming the existing file system's id (CreateFileSystem API reference).
  // So the token must be STABLE across `withRetry` re-invocations of THIS
  // create — a replay after a lost response then learns the id from that
  // refusal, see `sendCreateFileSystem` — DIFFER between the old and new
  // file system during a property-driven REPLACEMENT (the deploy engine
  // creates the new FS while the old still exists, so hash ONLY the
  // immutable, createOnly inputs), and be SCOPED to this stack, or a second
  // copy of this stack in the account is refused (go-to-k/cdkd#4428).
  // `stackScopedCreateToken` owns all three; `reserveStackCreateToken` adds
  // the stack's create-token ledger (go-to-k/cdkd#4438): a nonce replaced
  // whenever cdkd lets go of resources it made, and a marker of this create
  // persisted before it is sent. EFS caps the token at 64 characters.
  const reservation = await reserveStackCreateToken({
    logicalId,
    immutableInputs: [
      properties['AvailabilityZoneName'],
      properties['Encrypted'],
      properties['KmsKeyId'],
      properties['PerformanceMode'],
    ],
    maxLength: 64,
  });
  const creationToken = reservation.value;
  if (reservation.ledgerStartedThisDeploy) {
    await this.warnOfPreLedgerHolder(logicalId, reservation.base, log);
  }

  const tags = properties['FileSystemTags'] as Array<{ Key: string; Value: string }> | undefined;

  // Track creation so a post-ACTIVE control-plane failure (LifecyclePolicies
  // / BackupPolicy / FileSystemPolicy / FileSystemProtection) best-effort
  // rolls back the just-created file system rather than orphaning it.
  let fileSystemId: string | undefined;
  let fileSystemLeftBehind = false;

  try {
    const created = await this.sendCreateFileSystem(logicalId, resourceType, reservation, {
      CreationToken: creationToken,
      Encrypted: properties['Encrypted'] as boolean | undefined,
      KmsKeyId: properties['KmsKeyId'] as string | undefined,
      PerformanceMode: properties['PerformanceMode'] as PerformanceMode | undefined,
      ThroughputMode: properties['ThroughputMode'] as ThroughputMode | undefined,
      ProvisionedThroughputInMibps: properties['ProvisionedThroughputInMibps'] as
        | number
        | undefined,
      // AvailabilityZoneName — One Zone EFS. Rides on CreateFileSystem and
      // is immutable (create-only); a change later is routed through
      // DELETE+CREATE by the replacement-detection layer.
      AvailabilityZoneName: properties['AvailabilityZoneName'] as string | undefined,
      Tags: tags?.map((t) => ({ Key: t.Key, Value: t.Value })),
    });

    fileSystemId = created.fileSystemId;
    // go-to-k/cdkd#5511: report before the availability wait.
    reportCreatedResource(logicalId, resourceType, fileSystemId);

    // Wait for FileSystem to become available
    const available = await this.waitForFileSystemAvailable(
      fileSystemId,
      logicalId,
      resourceType,
      log
    );
    const arn = created.arn ?? available.FileSystemArn;

    // LifecyclePolicies / BackupPolicy / FileSystemPolicy /
    // FileSystemProtection do NOT ride on CreateFileSystem — each is a
    // separate post-ACTIVE control-plane call. AWS rejects them against a
    // still-creating file system, which is why they run after the wait
    // above. Each is wrapped in transient-control-plane retry because
    // back-to-back EFS control-plane ops can collide.
    await this.applyLifecyclePolicies(fileSystemId, properties['LifecyclePolicies'], log);
    await this.applyBackupPolicy(fileSystemId, properties['BackupPolicy'], log);
    await this.applyFileSystemPolicy(
      fileSystemId,
      properties['FileSystemPolicy'],
      properties['BypassPolicyLockoutSafetyCheck'],
      log
    );
    await this.applyFileSystemProtection(fileSystemId, properties['FileSystemProtection'], log);

    log.debug(`Successfully created EFS FileSystem ${logicalId}: ${fileSystemId}`);
    // Confirmed: a later create with this token is a NEW create, not a replay.
    this.unconfirmedCreationTokens.delete(creationToken);

    return {
      physicalId: fileSystemId,
      attributes: {
        Arn: arn,
        FileSystemId: fileSystemId,
      },
    };
  } catch (error) {
    // Atomicity: if CreateFileSystem succeeded but a post-ACTIVE step failed,
    // the file system exists but create() is about to throw without
    // returning its physicalId — the deploy engine can't roll it back, so
    // best-effort delete it here to avoid an orphan + a "CreationToken
    // already in use" failure on the next deploy attempt.
    if (fileSystemId !== undefined) {
      // The file system itself was created: a later "already exists" is an
      // auxiliary call's, not this file system's collision (#3826).
      markAuxiliaryFailure(error, logicalId);
      try {
        await this.getClient().send(new DeleteFileSystemCommand({ FileSystemId: fileSystemId }));
        // Deleted, so no longer a file system a replay may adopt.
        this.unconfirmedCreationTokens.delete(creationToken);
        retractCreatedResource(logicalId, resourceType, fileSystemId);
        log.debug(`Rolled back partially-created EFS FileSystem ${fileSystemId}`);
      } catch (cleanupError) {
        fileSystemLeftBehind = true;
        // The class at warn, AWS's text at debug (go-to-k/cdkd#2319): a
        // denied DeleteFileSystem names the caller's assumed-role ARN.
        const cleanupFailure = describeAwsFailure(cleanupError);
        const cleanupHead = `Failed to roll back partially-created EFS FileSystem ${fileSystemId}: `;
        if (cleanupFailure.redacted) log.debug(`${cleanupHead}${cleanupFailure.detail}`);
        // `summary` is the class for an AWS failure and the text itself for a
        // cdkd-authored one.
        log.warn(`${cleanupHead}${cleanupFailure.summary}`);
      }
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown =
      error instanceof ProvisioningError
        ? error
        : this.wrapMaskedError(
            log,
            error,
            (text) =>
              new ProvisioningError(
                `Failed to create EFS FileSystem ${logicalId}: ${text}`,
                resourceType,
                logicalId,
                undefined,
                cause
              )
          );
    // go-to-k/cdkd#4583: the rollback delete failed, so this file system has no
    // state record; name it for the failed-CREATE journal.
    if (fileSystemLeftBehind && fileSystemId !== undefined) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, fileSystemId);
    }
    throw thrown;
  }
}

/**
 * Send `CreateFileSystem`, and recognise a REPLAY of this process's own
 * create (go-to-k/cdkd#4428).
 *
 * EFS's two documents disagree about a repeated creation token. The
 * CreateFileSystem API reference says the repeat is refused with
 * `FileSystemAlreadyExists`, naming the existing file system's id, and that
 * this refusal is how a client "can learn of its existence"; the EFS User
 * Guide's "Creation token and idempotency" section says a reuse within one
 * minute of a successful request returns the original request's details.
 * Both are handled. A success is taken only when the file system it
 * returns was created after this create's first send -- otherwise it is a
 * file system this create did not make and is refused as below. Every such
 * comparison runs on AWS's clock (`earliestOwnCreationTime`, from the
 * response's HTTP `Date`), so a host clock running fast never refuses an
 * ordinary create. A refusal is read by the
 * state of the file system it names:
 *
 *  - `deleting` / `deleted`, or a read-back that finds it gone or fails
 *    transiently: the token is still bound to a file system on its way out
 *    — in steady state, the one a delete-first re-create
 *    (`--recreate-via-*`, the `--replace` delete-first fallback, a rollback
 *    re-create) just deleted, since `deleteFileSystem` does not wait for it
 *    to be gone — or ownership is unknown. EFS's own error is rethrown so the
 *    caller's message keeps its "already exists" wording, which those sites'
 *    retry filter (`isRecreateRetryableError`, message-based) waits out. It
 *    is stamped `markReplayMayCollide`, so `isNameCollisionErrorFrom`
 *    withholds the collision verdict and no delete-first site acts on a
 *    holder whose ownership cdkd has not established.
 *  - live, and this process may have made it: ADOPTED. That needs BOTH an
 *    earlier attempt of this create that sent the token -- in this process
 *    and never confirmed (an AMBIGUOUS failure, or an answered create whose
 *    later step failed without the cleanup deleting it), or recorded by the
 *    stack's create-token ledger in an earlier run (#4438) -- or an SDK
 *    resend of this very request (`$metadata.attempts > 1`), AND a
 *    `CreationTime` no earlier than the first such send, on AWS's clock
 *    (re-measured from this response, so an earlier run's local time is
 *    skew-corrected by today's reading). The time check is what keeps a file
 *    system made under this token outside the ledger -- under an earlier
 *    cdkd, or kept while the ledger could not be updated -- from being
 *    adopted and then deleted by the partial-create cleanup.
 *  - anything else: refused, non-retryably, in words a name-collision
 *    classifier does not match — a `--replace` delete-first would delete the
 *    LIVE old file system and then collide again, since what holds the token
 *    is not it.
 */
export async function sendCreateFileSystem(
  this: EFSProvider,
  logicalId: string,
  resourceType: string,
  reservation: StackCreateToken,
  input: CreateFileSystemCommandInput & { CreationToken: string }
): Promise<{ fileSystemId: string; arn: string | undefined }> {
  const token = input.CreationToken;
  const sentAt = Date.now();
  // An earlier attempt of this create: in this process, or -- through the
  // stack's create-token ledger -- in an earlier run that was interrupted
  // before it recorded the file system (go-to-k/cdkd#4438).
  const earlierSentAt = earliestDefined(
    this.unconfirmedCreationTokens.get(token),
    reservation.earlierFirstSentAt
  );
  const firstSentAt = earlierSentAt ?? sentAt;
  // Records AWS's `Date` for the answered attempt -- the refusal's too.
  const command = withServerClock(new CreateFileSystemCommand(input));
  try {
    const response = await this.getClient().send(command);
    if (!response.FileSystemId) {
      throw new ProvisioningError(
        `EFS CreateFileSystem for ${logicalId} returned no FileSystemId`,
        resourceType,
        logicalId
      );
    }
    // The EFS User Guide reads a reuse within about a minute of a
    // successful request as RETURNING that request's file system, so a
    // success can also hand back one this create did not make -- one an
    // earlier destroy kept a moment ago. Taken only when created after this
    // create's first send, as on the refusal arm below.
    const createdAt = response.CreationTime?.getTime();
    if (
      createdAt === undefined ||
      createdAt < earliestOwnCreationTime(firstSentAt, serverClockReading(command))
    ) {
      throw markNonRetryable(
        new ProvisioningError(
          this.foreignHolderMessage(
            logicalId,
            token,
            response.FileSystemId,
            createdAt === undefined
              ? ' The create answered with no creation time, so cdkd cannot tell whether this deploy made it.'
              : ' The create answered with it, but it predates this create.'
          ),
          resourceType,
          logicalId
        )
      );
    }
    // This process now holds a file system under the token. Until
    // `createFileSystem` returns it (or deletes it), a retry's refusal is
    // this create's own; that method drops the entry at either point.
    this.unconfirmedCreationTokens.set(token, firstSentAt);
    return { fileSystemId: response.FileSystemId, arn: response.FileSystemArn };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    const alreadyExists =
      error instanceof FileSystemAlreadyExists ||
      (error as { name?: string } | undefined)?.name === 'FileSystemAlreadyExists';
    if (!alreadyExists) {
      // Only an ambiguous failure can have left a file system behind; a
      // declared failure (a 4xx, a throttle) made none, so it adds nothing,
      // and it clears nothing an EARLIER ambiguous attempt recorded.
      if (isAmbiguousOutcomeError(error)) {
        this.unconfirmedCreationTokens.set(token, firstSentAt);
      }
      throw error;
    }
    const named = (error as { FileSystemId?: unknown }).FileSystemId;
    const holderId = typeof named === 'string' && named !== '' ? named : undefined;
    const attempts = (error as { $metadata?: { attempts?: unknown } }).$metadata?.attempts;
    const sdkReplayed = typeof attempts === 'number' && attempts > 1;

    let holder: FileSystemDescription | undefined;
    let holderUnreadable: string | undefined;
    if (holderId !== undefined) {
      try {
        const described = await this.getClient().send(
          new DescribeFileSystemsCommand({ FileSystemId: holderId })
        );
        holder = described.FileSystems?.[0];
      } catch (describeError) {
        // Gone by now (it finished deleting after the refusal), or a read
        // that may answer on the next attempt: EFS's own error goes back to
        // the caller, whose retry decides — a delete-first re-create's next
        // attempt finds the token free. Only a definite refusal to read (an
        // access denial) is reported as unreadable.
        if (
          describeError instanceof FileSystemNotFound ||
          (describeError as { name?: string } | undefined)?.name === 'FileSystemNotFound' ||
          isTransientServerError(describeError) ||
          isThrottlingError(describeError)
        ) {
          throw markReplayMayCollide(error);
        }
        holderUnreadable = describeAwsFailure(describeError).summary;
      }
    }

    if (holder?.LifeCycleState === 'deleting' || holder?.LifeCycleState === 'deleted') {
      throw markReplayMayCollide(error);
    }

    const createdAt = holder?.CreationTime?.getTime();
    const madeAfterFirstSend =
      createdAt !== undefined &&
      createdAt >= earliestOwnCreationTime(firstSentAt, serverClockReading(command));
    if (
      holderId !== undefined &&
      (earlierSentAt !== undefined || sdkReplayed) &&
      madeAfterFirstSend
    ) {
      this.logger.debug(
        safeMsg`EFS CreateFileSystem for ${logicalId} was a replay of this stack's own earlier create; using ${holderId}`
      );
      this.unconfirmedCreationTokens.set(token, firstSentAt);
      return { fileSystemId: holderId, arn: holder?.FileSystemArn };
    }

    this.unconfirmedCreationTokens.delete(token);
    const why =
      holderUnreadable !== undefined
        ? ` cdkd could not read it back (${holderUnreadable}), so it cannot tell whether this deploy made it.`
        : '';
    throw markNonRetryable(
      new ProvisioningError(
        this.foreignHolderMessage(logicalId, token, holderId, why),
        resourceType,
        logicalId,
        undefined,
        error instanceof Error ? error : undefined
      )
    );
  }
}

/**
 * The refusal message for a creation token held by a file system this create
 * did not make (go-to-k/cdkd#4428). Thrown non-retryable, and worded so no
 * name-collision classifier reads it as one.
 */
export function foreignHolderMessage(
  this: EFSProvider,
  logicalId: string,
  token: string,
  holderId: string | undefined,
  why: string
): string {
  return `EFS refused CreateFileSystem for ${logicalId}: the creation token cdkd derives for this stack's file system (${token}) is held by file system ${holderId ?? '(not named by EFS)'}, which is NOT recorded in cdkd state and was not created by this deploy.${why} It is not one this deploy, or an interrupted earlier deploy of this stack, made: it was created under this token by an earlier cdkd version, or a completed deploy recorded it and cdkd later let go of it, and it may hold data. Inspect it with: ${withPasteableAwsProfile('aws efs describe-file-systems')} --creation-token ${token} -- then import it into this stack, or delete it once you are sure its data is not needed, and deploy again.`;
}

export async function waitForFileSystemAvailable(
  this: EFSProvider,
  fileSystemId: string,
  logicalId: string,
  resourceType: string,
  log: MaskedLogSinks
): Promise<FileSystemDescription> {
  const pollIntervalMs = 2000;
  const maxWaitMs = 60000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const response = await this.getClient().send(
      new DescribeFileSystemsCommand({ FileSystemId: fileSystemId })
    );
    const fs = response.FileSystems?.[0];
    if (fs?.LifeCycleState === 'available') {
      return fs;
    }
    log.debug(`FileSystem ${fileSystemId} state: ${fs?.LifeCycleState ?? 'unknown'}, waiting...`);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new ProvisioningError(
    `Timed out waiting for EFS FileSystem ${fileSystemId} to become available (60s)`,
    resourceType,
    logicalId,
    fileSystemId
  );
}
