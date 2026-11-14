import type { EFSProvider } from '../efs-provider.js';
import { cdkdRemedy, deployReplaceCommand } from '../../../utils/pasteable-command.js';
import {
  UpdateFileSystemCommand,
  DeleteFileSystemCommand,
  PutLifecycleConfigurationCommand,
  PutBackupPolicyCommand,
  PutFileSystemPolicyCommand,
  DeleteFileSystemPolicyCommand,
  UpdateFileSystemProtectionCommand,
  FileSystemNotFound,
  type ThroughputMode,
  type LifecyclePolicy,
  type Status,
  type ReplicationOverwriteProtection,
} from '@aws-sdk/client-efs';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceUpdateResult } from '../../../types/resource.js';
import { createMaskedLogSinks, type MaskedLogSinks } from '../../masked-retry-logger.js';

export async function updateFileSystem(
  this: EFSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks,
  /** The desired bag is a state replay or an AWS readback, not the template. */
  stateBorneDesired: boolean
): Promise<ResourceUpdateResult> {
  // Defensive guard: any non-mutable diff means the replacement-detection
  // layer should have routed this through DELETE+CREATE — if we reach
  // here with an Encrypted / KmsKeyId / PerformanceMode / AvailabilityZoneName
  // change, refuse to silently apply a partial update.
  const immutableKeys = [
    'Encrypted',
    'KmsKeyId',
    'PerformanceMode',
    'AvailabilityZoneName',
  ] as const;
  for (const key of immutableKeys) {
    const next = properties[key];
    const prev = previousProperties[key];
    if (next !== undefined && prev !== undefined && JSON.stringify(next) !== JSON.stringify(prev)) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `AWS EFS FileSystem ${key} is immutable on AWS — UpdateFileSystem does not accept ${key}; the property is fixed at creation. Re-deploy with ${deployReplaceCommand(true)} (the type is in cdkd's stateful-recreate guard set, so a bare --replace is refused a second time with STATEFUL_REPLACE_BLOCKED), or destroy + redeploy the stack.`
      );
    }
  }

  const newThroughputMode = properties['ThroughputMode'] as ThroughputMode | undefined;
  const newProvisioned = properties['ProvisionedThroughputInMibps'] as number | undefined;
  const oldThroughputMode = previousProperties['ThroughputMode'] as ThroughputMode | undefined;
  const oldProvisioned = previousProperties['ProvisionedThroughputInMibps'] as number | undefined;

  // Removal semantics (issue #1160, efs batch) — live CFn A/B 2026-08-11
  // split the SUSPECT row in two:
  //  - Removing ThroughputMode alone from a NON-provisioned file system is
  //    RETAINED by CloudFormation (elastic stayed elastic through a CFn
  //    removal update), so the pass-through skip below is CFn parity there.
  //    Pinned by a negative unit test — do not "fix" it into a divergence.
  //  - Removing ThroughputMode + ProvisionedThroughputInMibps from a
  //    'provisioned' file system IS reset by CloudFormation to the create
  //    default 'bursting' (provisioned@1MiBps -> bursting, Provisioned
  //    cleared). UpdateFileSystem itself merges (an absent field keeps the
  //    live value), so mirror CFn by sending ThroughputMode: 'bursting'
  //    explicitly. This also stops provisioned-throughput billing, which
  //    the pre-fix silent drop kept running.
  //  - A template with ThroughputMode: 'provisioned' and no
  //    ProvisionedThroughputInMibps (e.g. the value removed while the mode
  //    is kept) is REJECTED by CloudFormation: live CFn A/B
  //    go-to-k/cdkd#5547, alone and beside a tag + lifecycle change, failed
  //    with "Throughput value must be specified for provisioned throughput
  //    mode." before any EFS mutation (no UpdateFileSystem in CloudTrail),
  //    rolled back, and the value stayed 2 MiB/s. A bursting -> provisioned
  //    switch with no value fails there too (the EFS API refuses it). So
  //    refuse up front, before any call, with CFn's message (below) — only
  //    when the throughput would CHANGE (a value-less provisioned record on
  //    both sides sends nothing for it, so the rest of the update goes on),
  //    and only on the template path: a state replay (rollback, drift
  //    revert) warns and leaves the live throughput as it is, since the
  //    user cannot edit a state record through the template.
  //  - Removing ONLY ThroughputMode from a 'provisioned' file system while
  //    keeping ProvisionedThroughputInMibps is RETAINED by CloudFormation
  //    (live CFn A/B, go-to-k/cdkd#5464: provisioned@1MiBps stayed so for
  //    2 min after UPDATE_COMPLETE), so sending nothing is parity — pinned
  //    by a negative unit test.
  const throughputValueMissing =
    newThroughputMode === 'provisioned' &&
    newProvisioned === undefined &&
    (oldProvisioned !== undefined || oldThroughputMode !== 'provisioned');
  if (throughputValueMissing) {
    if (!stateBorneDesired) {
      throw new ProvisioningError(
        `Failed to update EFS FileSystem ${logicalId}: Throughput value must be specified for provisioned throughput mode. ` +
          `The template sets ThroughputMode: provisioned without ProvisionedThroughputInMibps, which CloudFormation rejects too. ` +
          `Set ProvisionedThroughputInMibps, or change ThroughputMode (e.g. to bursting or elastic).`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    log.warn(
      `EFS FileSystem ${logicalId}: the desired properties (from cdkd state or an AWS readback, not the template) set ThroughputMode: provisioned without ProvisionedThroughputInMibps, ` +
        `which AWS rejects; leaving the file system's throughput as it is on AWS and applying the rest of the update. ` +
        `Its throughput may now differ from the record: run ${cdkdRemedy('cdkd drift')} to see it.`
    );
  }
  const effectiveThroughputMode =
    newThroughputMode === undefined &&
    newProvisioned === undefined &&
    oldThroughputMode === 'provisioned'
      ? ('bursting' as ThroughputMode)
      : newThroughputMode;

  const throughputModeChanged =
    !throughputValueMissing &&
    effectiveThroughputMode !== undefined &&
    effectiveThroughputMode !== oldThroughputMode;
  const provisionedChanged = newProvisioned !== undefined && newProvisioned !== oldProvisioned;

  // Separate post-create control-plane properties — each compares deep so a
  // changed nested value (or a removal) fires its own Put*/Update* call.
  const changed = (key: string): boolean =>
    JSON.stringify(properties[key]) !== JSON.stringify(previousProperties[key]);
  const lifecycleChanged = changed('LifecyclePolicies');
  const backupChanged = changed('BackupPolicy');
  const policyChanged = changed('FileSystemPolicy') || changed('BypassPolicyLockoutSafetyCheck');
  const protectionChanged = changed('FileSystemProtection');
  // FileSystemTags is tag-updatable in the CFn schema (go-to-k/cdkd#5464):
  // CloudFormation retags in place, and a removed key is untagged.
  const tagsChanged = changed('FileSystemTags');
  if (tagsChanged) {
    refuseMalformedDesiredTags(
      properties['FileSystemTags'],
      resourceType,
      logicalId,
      physicalId,
      'FileSystemTags'
    );
  }

  if (
    !throughputModeChanged &&
    !provisionedChanged &&
    !lifecycleChanged &&
    !backupChanged &&
    !policyChanged &&
    !protectionChanged &&
    !tagsChanged
  ) {
    // No mutable diff — nothing to do (silent success, matching the
    // wider provider convention). Drift comparator wouldn't have
    // surfaced this resource if there was no diff to start with.
    log.debug(`No mutable diff for EFS FileSystem ${logicalId}, skipping update`);
    return { physicalId, wasReplaced: false };
  }

  log.debug(`Updating EFS FileSystem ${logicalId}: ${physicalId}`);

  try {
    if (throughputModeChanged || provisionedChanged) {
      await this.getClient().send(
        new UpdateFileSystemCommand({
          FileSystemId: physicalId,
          ...(throughputModeChanged && { ThroughputMode: effectiveThroughputMode }),
          ...(provisionedChanged && { ProvisionedThroughputInMibps: newProvisioned }),
        })
      );

      // EFS UpdateFileSystem is async; wait until the FileSystem state
      // returns to `available` so the comparator's next read sees the
      // final values rather than `updating`.
      await this.waitForFileSystemAvailable(physicalId, logicalId, resourceType, log);
    }

    // Post-create control-plane diffs — separate Put*/Update* APIs. Each is
    // applied only when its value changed. A REMOVAL resets each one, as
    // CloudFormation does (live CFn A/B, go-to-k/cdkd#1160, 2026-10-28):
    // LifecyclePolicies -> cleared; FileSystemPolicy -> DeleteFileSystemPolicy;
    // BackupPolicy -> DISABLED and FileSystemProtection -> ENABLED arrive
    // here already injected (`removalDefaults`). Every reset call is
    // accepted on a file system already at that default.
    if (lifecycleChanged) {
      await this.applyLifecyclePolicies(
        physicalId,
        properties['LifecyclePolicies'],
        log,
        previousProperties['LifecyclePolicies']
      );
    }
    if (backupChanged) {
      await this.applyBackupPolicy(physicalId, properties['BackupPolicy'], log);
    }
    if (policyChanged) {
      if (
        properties['FileSystemPolicy'] === undefined &&
        previousProperties['FileSystemPolicy'] !== undefined
      ) {
        await this.deleteFileSystemPolicy(physicalId, log);
      } else {
        await this.applyFileSystemPolicy(
          physicalId,
          properties['FileSystemPolicy'],
          properties['BypassPolicyLockoutSafetyCheck'],
          log
        );
      }
    }
    if (protectionChanged) {
      await this.applyFileSystemProtection(physicalId, properties['FileSystemProtection'], log);
    }
    if (tagsChanged) {
      await this.applyTagDiff(
        physicalId,
        resourceType,
        logicalId,
        previousProperties['FileSystemTags'],
        properties['FileSystemTags'],
        log
      );
    }

    log.debug(`Successfully updated EFS FileSystem ${logicalId}`);

    return { physicalId, wasReplaced: false };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update EFS FileSystem ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

// ─── Post-ACTIVE control-plane helpers ─────────────────────────────
//
// LifecyclePolicies / BackupPolicy / FileSystemPolicy / FileSystemProtection
// are NOT settable on CreateFileSystem — each has its own EFS API
// (PutLifecycleConfiguration / PutBackupPolicy / PutFileSystemPolicy /
// UpdateFileSystemProtection). Called from both create() (after ACTIVE) and
// update() (only when the value changed). Each is idempotent and wrapped in
// retryOnTransientControlPlane because back-to-back EFS control-plane ops can
// collide with an IncorrectFileSystemLifeCycleState / "in progress" error.

/**
 * Apply `LifecyclePolicies` via `PutLifecycleConfiguration`. CFn shape is an
 * array of `{ TransitionToIA?, TransitionToPrimaryStorageClass?,
 * TransitionToArchive? }`. An empty / dropped array clears all lifecycle
 * policies (PutLifecycleConfiguration with `LifecyclePolicies: []`).
 */
export async function applyLifecyclePolicies(
  this: EFSProvider,
  fileSystemId: string,
  spec: unknown,
  log: MaskedLogSinks,
  previousSpec?: unknown
): Promise<void> {
  if (spec === undefined) {
    // Removal (new absent, previous present): clear all policies.
    if (previousSpec === undefined) return;
  }
  const policies = (spec as LifecyclePolicy[] | undefined) ?? [];
  await this.retryOnTransientControlPlane(
    () =>
      this.getClient().send(
        new PutLifecycleConfigurationCommand({
          FileSystemId: fileSystemId,
          LifecyclePolicies: policies,
        })
      ),
    `set LifecyclePolicies on ${fileSystemId}`,
    log
  );
  log.debug(`Set ${policies.length} LifecyclePolicy entry(ies) on EFS FileSystem ${fileSystemId}`);
}

/**
 * Apply `BackupPolicy` via `PutBackupPolicy`. CFn shape is
 * `{ Status: 'ENABLED' | 'DISABLED' }`.
 */
export async function applyBackupPolicy(
  this: EFSProvider,
  fileSystemId: string,
  spec: unknown,
  log: MaskedLogSinks
): Promise<void> {
  if (spec === undefined || spec === null) return;
  const status = (spec as { Status?: string }).Status;
  if (status === undefined) return;
  await this.retryOnTransientControlPlane(
    () =>
      this.getClient().send(
        new PutBackupPolicyCommand({
          FileSystemId: fileSystemId,
          BackupPolicy: { Status: status as Status },
        })
      ),
    `set BackupPolicy on ${fileSystemId}`,
    log
  );
  log.debug(`Set BackupPolicy Status=${log.value(status)} on EFS FileSystem ${fileSystemId}`);
}

/**
 * Apply `FileSystemPolicy` via `PutFileSystemPolicy`. The CFn `FileSystemPolicy`
 * property is a JSON policy *object* but the SDK's `Policy` field is a JSON
 * *string*, so an object value is `JSON.stringify`'d. `BypassPolicyLockoutSafetyCheck`
 * is a field ON `PutFileSystemPolicy` (not a standalone resource property), so
 * the two wire together.
 */
export async function applyFileSystemPolicy(
  this: EFSProvider,
  fileSystemId: string,
  policy: unknown,
  bypass: unknown,
  log: MaskedLogSinks
): Promise<void> {
  if (policy === undefined || policy === null) return;
  const policyString = typeof policy === 'string' ? policy : JSON.stringify(policy);
  await this.retryOnTransientControlPlane(
    () =>
      this.getClient().send(
        new PutFileSystemPolicyCommand({
          FileSystemId: fileSystemId,
          Policy: policyString,
          BypassPolicyLockoutSafetyCheck: bypass === undefined ? undefined : Boolean(bypass),
        })
      ),
    `set FileSystemPolicy on ${fileSystemId}`,
    log
  );
  log.debug(`Set FileSystemPolicy on EFS FileSystem ${fileSystemId}`);
}

/**
 * Remove the file system's access policy via `DeleteFileSystemPolicy` — what
 * CloudFormation sends when `FileSystemPolicy` leaves the template
 * (go-to-k/cdkd#1160). Succeeds when no policy is attached.
 */
export async function deleteFileSystemPolicy(
  this: EFSProvider,
  fileSystemId: string,
  log: MaskedLogSinks
): Promise<void> {
  await this.retryOnTransientControlPlane(
    () => this.getClient().send(new DeleteFileSystemPolicyCommand({ FileSystemId: fileSystemId })),
    `delete FileSystemPolicy on ${fileSystemId}`,
    log
  );
  log.debug(`Deleted FileSystemPolicy on EFS FileSystem ${fileSystemId}`);
}

/**
 * Apply `FileSystemProtection` via `UpdateFileSystemProtection`. CFn shape is
 * `{ ReplicationOverwriteProtection: 'ENABLED' | 'DISABLED' | 'REPLICATING' }`.
 */
export async function applyFileSystemProtection(
  this: EFSProvider,
  fileSystemId: string,
  spec: unknown,
  log: MaskedLogSinks
): Promise<void> {
  if (spec === undefined || spec === null) return;
  const protection = (spec as { ReplicationOverwriteProtection?: string })
    .ReplicationOverwriteProtection;
  if (protection === undefined) return;
  await this.retryOnTransientControlPlane(
    () =>
      this.getClient().send(
        new UpdateFileSystemProtectionCommand({
          FileSystemId: fileSystemId,
          ReplicationOverwriteProtection: protection as ReplicationOverwriteProtection,
        })
      ),
    `set FileSystemProtection on ${fileSystemId}`,
    log
  );
  log.debug(
    `Set ReplicationOverwriteProtection=${log.value(protection)} on EFS FileSystem ${fileSystemId}`
  );
}

export async function deleteFileSystem(
  this: EFSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting EFS FileSystem ${logicalId}: ${physicalId}`);

  try {
    await this.getClient().send(
      new DeleteFileSystemCommand({
        FileSystemId: physicalId,
      })
    );
    this.logger.debug(`Successfully deleted EFS FileSystem ${logicalId}`);
  } catch (error) {
    if (error instanceof FileSystemNotFound) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`EFS FileSystem ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
    throw this.wrapDeleteError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete EFS FileSystem ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
