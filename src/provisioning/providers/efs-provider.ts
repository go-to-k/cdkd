import {
  EFSClient,
  CreateFileSystemCommand,
  UpdateFileSystemCommand,
  DeleteFileSystemCommand,
  CreateMountTargetCommand,
  DeleteMountTargetCommand,
  DescribeMountTargetsCommand,
  ModifyMountTargetSecurityGroupsCommand,
  CreateAccessPointCommand,
  DeleteAccessPointCommand,
  DescribeFileSystemsCommand,
  DescribeAccessPointsCommand,
  type DescribeAccessPointsCommandOutput,
  DescribeLifecycleConfigurationCommand,
  DescribeBackupPolicyCommand,
  DescribeMountTargetSecurityGroupsCommand,
  DescribeFileSystemPolicyCommand,
  PutLifecycleConfigurationCommand,
  PutBackupPolicyCommand,
  PutFileSystemPolicyCommand,
  UpdateFileSystemProtectionCommand,
  FileSystemNotFound,
  MountTargetNotFound,
  AccessPointNotFound,
  AccessPointAlreadyExists,
  FileSystemAlreadyExists,
  type CreateFileSystemCommandInput,
  type FileSystemDescription,
  type PerformanceMode,
  type ThroughputMode,
  type LifecyclePolicy,
  type Status,
  type ReplicationOverwriteProtection,
  type AccessPointDescription,
  type CreateAccessPointCommandInput,
  type PosixUser,
  type RootDirectory,
} from '@aws-sdk/client-efs';
import { getLogger } from '../../utils/logger.js';
import { safeMsg } from '../../utils/display-safe.js';
import { definedAttributes } from '../attribute-map.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import { acquireIdempotencyToken } from './idempotency-token.js';
import {
  earliestDefined,
  reserveStackCreateToken,
  type StackCreateToken,
} from './create-token-ledger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { withRetry } from '../../deployment/retry.js';
import { isInterruptedWaitError, startInterruptWatch } from '../interrupt-watch.js';
import {
  isAmbiguousOutcomeError,
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
  markReplayMayCollide,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { RESOURCE_NOT_FOUND, type ResourceNotFound } from '../../types/resource.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
} from '../../types/resource.js';
import {
  createMaskedLogSinks,
  type MaskedLogSinks,
  type MaskerFn,
} from '../masked-retry-logger.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { withPasteableAwsProfile } from '../../utils/pasteable-aws-profile.js';
import { markAuxiliaryFailure } from '../auxiliary-failure.js';
import { earliestOwnCreationTime, serverClockReading, withServerClock } from './server-clock.js';

/**
 * Whether an access point's `PosixUser` is the one a `CreateAccessPoint`
 * request asked for (issue #3894), used to confirm an adoption.
 *
 * EFS puts an unset POSIX user on the wire as `null` (measured through the
 * AWS CLI, issue #2442), and the SDK deserializer drops that null member, so
 * the description reaches here without the key. An absent request therefore
 * matches a described user that is absent OR null. `SecondaryGids` is a set,
 * so an omitted list equals an empty one and order is ignored.
 */
function samePosixUser(
  requested: PosixUser | undefined,
  described: PosixUser | null | undefined
): boolean {
  if (requested == null || described == null) return requested == null && described == null;
  const gids = (user: PosixUser): string =>
    JSON.stringify([...new Set(user.SecondaryGids ?? [])].sort((a, b) => a - b));
  return (
    requested.Uid === described.Uid &&
    requested.Gid === described.Gid &&
    gids(requested) === gids(described)
  );
}

/**
 * Whether an access point's `RootDirectory` is the one a `CreateAccessPoint`
 * request asked for (issue #3894), used to confirm an adoption.
 *
 * EFS reads an omitted `RootDirectory` back as `{ Path: "/" }` (measured,
 * issue #2442), so both sides are read through that default before
 * comparing; comparing raw would decline every adoption of a default-root
 * access point. A root with `CreationInfo` but no `Path` is ASSUMED to default
 * the same way -- unmeasured, and the `?? '/'` on both sides matches whether
 * EFS answers `/` or omits the member. `Permissions` is an octal string (`^[0-7]{3,4}$`), so `755`
 * and `0755` are the same mode.
 */
function sameRootDirectory(
  requested: RootDirectory | undefined,
  described: RootDirectory | null | undefined
): boolean {
  if ((requested?.Path ?? '/') !== (described?.Path ?? '/')) return false;
  const want = requested?.CreationInfo ?? undefined;
  const have = described?.CreationInfo ?? undefined;
  if (want === undefined || have === undefined) return want === undefined && have === undefined;
  const mode = (p: string | undefined): number | string | undefined =>
    p !== undefined && /^[0-7]+$/.test(p) ? parseInt(p, 8) : p;
  return (
    want.OwnerUid === have.OwnerUid &&
    want.OwnerGid === have.OwnerGid &&
    mode(want.Permissions) === mode(have.Permissions)
  );
}

/**
 * SDK Provider for AWS EFS resources
 *
 * Supports:
 * - AWS::EFS::FileSystem
 * - AWS::EFS::MountTarget
 * - AWS::EFS::AccessPoint
 *
 * EFS CreateFileSystem/CreateAccessPoint are synchronous.
 * MountTarget requires polling until state becomes "available".
 */
export class EFSProvider implements ResourceProvider {
  private client: EFSClient | undefined;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('EFSProvider');
  /**
   * File-system creation tokens under which THIS process may hold a file
   * system that no `createFileSystem` call has yet returned or deleted: the
   * create was answered and a later step failed, or the create ended
   * AMBIGUOUS (a 5xx, a timeout, a reset) with no response read. Each maps to
   * the time of the FIRST such send. Only such a token's
   * `FileSystemAlreadyExists` can be a replay of this process's own create —
   * see `sendCreateFileSystem`. The token is stack- and region-scoped, so one
   * entry never speaks for another stack.
   */
  private readonly unconfirmedCreationTokens = new Map<string, number>();

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::EFS::FileSystem',
      new Set([
        'FileSystemTags',
        'Encrypted',
        'KmsKeyId',
        'PerformanceMode',
        'ThroughputMode',
        'ProvisionedThroughputInMibps',
        'AvailabilityZoneName',
        'LifecyclePolicies',
        'BackupPolicy',
        'FileSystemPolicy',
        'BypassPolicyLockoutSafetyCheck',
        'FileSystemProtection',
      ]),
    ],
    ['AWS::EFS::MountTarget', new Set(['FileSystemId', 'SubnetId', 'SecurityGroups'])],
    [
      'AWS::EFS::AccessPoint',
      new Set(['FileSystemId', 'PosixUser', 'RootDirectory', 'AccessPointTags']),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::EFS::FileSystem',
      new Map<string, string>([
        [
          'ReplicationConfiguration',
          'Cross-region EFS replication (CreateReplicationConfiguration) provisions a separate destination file system in another region with its own lifecycle, KMS key, and availability-zone placement; replicating + then tearing down the destination on destroy is a multi-resource, cross-region orchestration that is out of scope for the single-resource SDK provider. Tracked as a follow-up to issue #609.',
        ],
      ]),
    ],
    [
      'AWS::EFS::AccessPoint',
      new Map<string, string>([
        [
          'ClientToken',
          'cdkd supplies its own retry-stable ClientToken on CreateAccessPoint (issues #2039 and #2080), so a template-supplied value would be overwritten. The SDK does not own this field either: measured against @aws-sdk/client-efs 3.1018.0, an omitted ClientToken is auto-filled with a FRESH uuid per attempt, which leaves a retried 500 free to mint a second access point, while a caller-supplied value goes on the wire verbatim.',
        ],
      ]),
    ],
  ]);

  private getClient(): EFSClient {
    if (!this.client) {
      this.client = new EFSClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.client;
  }

  /**
   * A `create()` / `update()` failure wrap quoting the caught error's text
   * masked (issue #2177): AWS quotes a rejected request value back (a subnet,
   * a KMS key, a policy) off the RESOLVED `properties` bag. The `cause` stays
   * unmasked, and a message the mask changed is stamped so the retry
   * classifiers read that chain (`wrapMaskedAwsError`, issue #4244). A method,
   * so `gen-update-wrap-coverage` sees the catch that throws it as a wrap.
   */
  private wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return wrapMaskedAwsError(mask, error, build);
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  /**
   * Each `create()` / `update()` builds ONE masked sink set from its own
   * context (issue #2177, `.claude/rules/provider-masking.md`) and routes every
   * log line and wrapped AWS error text through it. EFS has no user-chosen
   * physical name, so there is no derived-name needle: the bag values reaching
   * a message are the `BackupPolicy` / `FileSystemProtection` enums, masked
   * RAW, and AWS error text that can quote a request value back.
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
    switch (resourceType) {
      case 'AWS::EFS::FileSystem':
        return this.createFileSystem(logicalId, resourceType, properties, log);
      case 'AWS::EFS::MountTarget':
        return this.createMountTarget(logicalId, resourceType, properties, log);
      case 'AWS::EFS::AccessPoint':
        return this.createAccessPoint(logicalId, resourceType, properties, log);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  /**
   * Mutable surfaces by resource type:
   *  - `AWS::EFS::FileSystem` → `UpdateFileSystem` (ThroughputMode,
   *    ProvisionedThroughputInMibps). Other property changes
   *    (Encrypted / KmsKeyId / PerformanceMode / etc.) are routed
   *    through DELETE+CREATE by the replacement-detection layer; if a
   *    diff somehow includes them, defensively reject.
   *  - `AWS::EFS::MountTarget` → `ModifyMountTargetSecurityGroups`
   *    (SecurityGroups only). IpAddress / SubnetId / FileSystemId are
   *    immutable.
   *  - `AWS::EFS::AccessPoint` → no mutable surface; AWS recreates on
   *    every change. Reject so `cdkd drift --revert` surfaces a clear
   *    "use --replace" hint.
   */
  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
    switch (resourceType) {
      case 'AWS::EFS::FileSystem':
        return this.updateFileSystem(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties,
          log
        );
      case 'AWS::EFS::MountTarget':
        return this.updateMountTarget(logicalId, physicalId, resourceType, properties, log);
      case 'AWS::EFS::AccessPoint':
        return Promise.reject(
          new ResourceUpdateNotSupportedError(
            resourceType,
            logicalId,
            'AWS EFS AccessPoint has no in-place update API — there is no UpdateAccessPoint command; every property change requires DeleteAccessPoint + CreateAccessPoint. Re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.'
          )
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  private async updateFileSystem(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks
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
      if (
        next !== undefined &&
        prev !== undefined &&
        JSON.stringify(next) !== JSON.stringify(prev)
      ) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `AWS EFS FileSystem ${key} is immutable on AWS — UpdateFileSystem does not accept ${key}; the property is fixed at creation. Re-deploy with cdkd deploy --replace --force-stateful-recreation (the type is in cdkd's stateful-recreate guard set, so a bare --replace is refused a second time with STATEFUL_REPLACE_BLOCKED), or destroy + redeploy the stack.`
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
    //  - Removing ONLY ProvisionedThroughputInMibps while keeping
    //    ThroughputMode: 'provisioned' is deferred (no wire shape can reset
    //    it — the API requires a value while the mode is provisioned, and
    //    there is no documented default to reset to).
    const effectiveThroughputMode =
      newThroughputMode === undefined &&
      newProvisioned === undefined &&
      oldThroughputMode === 'provisioned'
        ? ('bursting' as ThroughputMode)
        : newThroughputMode;

    const throughputModeChanged =
      effectiveThroughputMode !== undefined && effectiveThroughputMode !== oldThroughputMode;
    const provisionedChanged = newProvisioned !== undefined && newProvisioned !== oldProvisioned;

    // Separate post-create control-plane properties — each compares deep so a
    // changed nested value (or a removal) fires its own Put*/Update* call.
    const changed = (key: string): boolean =>
      JSON.stringify(properties[key]) !== JSON.stringify(previousProperties[key]);
    const lifecycleChanged = changed('LifecyclePolicies');
    const backupChanged = changed('BackupPolicy');
    const policyChanged = changed('FileSystemPolicy') || changed('BypassPolicyLockoutSafetyCheck');
    const protectionChanged = changed('FileSystemProtection');

    if (
      !throughputModeChanged &&
      !provisionedChanged &&
      !lifecycleChanged &&
      !backupChanged &&
      !policyChanged &&
      !protectionChanged
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
      // applied only when its value changed (a removal clears LifecyclePolicies;
      // BackupPolicy / FileSystemPolicy / FileSystemProtection have no clean
      // "drop" mapping in CFn, so a pure removal is a deliberate no-op).
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
        await this.applyFileSystemPolicy(
          physicalId,
          properties['FileSystemPolicy'],
          properties['BypassPolicyLockoutSafetyCheck'],
          log
        );
      }
      if (protectionChanged) {
        await this.applyFileSystemProtection(physicalId, properties['FileSystemProtection'], log);
      }

      log.debug(`Successfully updated EFS FileSystem ${logicalId}`);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log.mask,
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

  private async updateMountTarget(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceUpdateResult> {
    log.debug(`Updating EFS MountTarget ${logicalId}: ${physicalId}`);

    const securityGroups = properties['SecurityGroups'] as string[] | undefined;
    if (securityGroups === undefined) {
      // Nothing mutable to apply (IpAddress / SubnetId / FileSystemId are
      // immutable on MountTarget). Silent success keeps `cdkd drift
      // --revert` consistent with the wider provider convention when
      // only immutable fields differ.
      log.debug(`No mutable diff for EFS MountTarget ${logicalId}, skipping update`);
      return { physicalId, wasReplaced: false };
    }

    try {
      await this.getClient().send(
        new ModifyMountTargetSecurityGroupsCommand({
          MountTargetId: physicalId,
          SecurityGroups: securityGroups,
        })
      );

      log.debug(`Successfully updated EFS MountTarget ${logicalId}`);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log.mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update EFS MountTarget ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::EFS::FileSystem':
        return this.deleteFileSystem(logicalId, physicalId, resourceType, context);
      case 'AWS::EFS::MountTarget':
        return this.deleteMountTarget(logicalId, physicalId, resourceType, context);
      case 'AWS::EFS::AccessPoint':
        return this.deleteAccessPoint(logicalId, physicalId, resourceType, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── AWS::EFS::FileSystem ──────────────────────────────────────────

  /**
   * The stack's create-token ledger was started in this deploy, so a create
   * of `logicalId` an EARLIER cdkd version sent and never recorded -- an
   * interrupted deploy -- holds the nonce-free token `base`, which this create
   * no longer sends: that file system is not handed back, and bills until
   * deleted. Name it (go-to-k/cdkd#4438). Best-effort: a lookup that fails is
   * only logged.
   */
  private async warnOfPreLedgerHolder(
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

  private async createFileSystem(
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
          log.debug(`Rolled back partially-created EFS FileSystem ${fileSystemId}`);
        } catch (cleanupError) {
          log.warn(
            `Failed to roll back partially-created EFS FileSystem ${fileSystemId}: ${
              describeAwsFailure(cleanupError).detail
            }`
          );
        }
      }
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log.mask,
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
  private async sendCreateFileSystem(
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
  private foreignHolderMessage(
    logicalId: string,
    token: string,
    holderId: string | undefined,
    why: string
  ): string {
    return `EFS refused CreateFileSystem for ${logicalId}: the creation token cdkd derives for this stack's file system (${token}) is held by file system ${holderId ?? '(not named by EFS)'}, which is NOT recorded in cdkd state and was not created by this deploy.${why} It is not one this deploy, or an interrupted earlier deploy of this stack, made: it was created under this token by an earlier cdkd version, or a completed deploy recorded it and cdkd later let go of it, and it may hold data. Inspect it with: ${withPasteableAwsProfile('aws efs describe-file-systems')} --creation-token ${token} -- then import it into this stack, or delete it once you are sure its data is not needed, and deploy again.`;
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
  private async applyLifecyclePolicies(
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
    log.debug(
      `Set ${policies.length} LifecyclePolicy entry(ies) on EFS FileSystem ${fileSystemId}`
    );
  }

  /**
   * Apply `BackupPolicy` via `PutBackupPolicy`. CFn shape is
   * `{ Status: 'ENABLED' | 'DISABLED' }`.
   */
  private async applyBackupPolicy(
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
  private async applyFileSystemPolicy(
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
   * Apply `FileSystemProtection` via `UpdateFileSystemProtection`. CFn shape is
   * `{ ReplicationOverwriteProtection: 'ENABLED' | 'DISABLED' | 'REPLICATING' }`.
   */
  private async applyFileSystemProtection(
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

  /**
   * Retry an EFS control-plane call on the transient "settling" errors AWS
   * returns when two file-system-modifying operations land back-to-back (e.g.
   * a `PutLifecycleConfiguration` immediately followed by a `PutBackupPolicy`).
   * `IncorrectFileSystemLifeCycleState` / `ThrottlingException` /
   * `ConflictException` and the message-pattern set below are the same class.
   * Backoff: ~2s,4s,8s,16s,30s,30s... bounded to ~2min total.
   *
   * `log` is the calling operation's masked sink: the per-attempt line carries
   * AWS's own text, which can quote the request (a `FileSystemPolicy` document
   * included) back.
   */
  private async retryOnTransientControlPlane<T>(
    op: () => Promise<T>,
    label: string,
    log: MaskedLogSinks,
    maxAttempts = 8
  ): Promise<T> {
    let delayMs = 2000;
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (error) {
        // `.detail`, never `.summary`: the classifier below matches AWS's OWN
        // wording, which `.summary` replaces with the wire name alone. Same text as
        // the `instanceof Error ?` ternary it replaced, minus that ternary's throw.
        const msg = describeAwsFailure(error).detail;
        const name = error instanceof Error ? error.name : '';
        const transient =
          /in progress|please retry|incorrect file system life ?cycle state|being (updated|modified)|try again/i.test(
            msg
          ) ||
          name === 'IncorrectFileSystemLifeCycleState' ||
          name === 'ConflictException' ||
          name === 'ThrottlingException';
        if (!transient || attempt >= maxAttempts) throw error;
        log.debug(
          `Transient error on "${label}" (attempt ${attempt}/${maxAttempts}): ${msg} — retrying in ${delayMs}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 30000);
      }
    }
  }

  private async deleteFileSystem(
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
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`EFS FileSystem ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete EFS FileSystem ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async waitForFileSystemAvailable(
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

  // ─── AWS::EFS::MountTarget ─────────────────────────────────────────

  private async createMountTarget(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    log.debug(`Creating EFS MountTarget ${logicalId}`);

    const fileSystemId = properties['FileSystemId'] as string | undefined;
    if (!fileSystemId) {
      throw new ProvisioningError(
        `FileSystemId is required for EFS MountTarget ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const subnetId = properties['SubnetId'] as string | undefined;
    if (!subnetId) {
      throw new ProvisioningError(
        `SubnetId is required for EFS MountTarget ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const securityGroups = properties['SecurityGroups'] as string[] | undefined;

    try {
      const response = await this.getClient().send(
        new CreateMountTargetCommand({
          FileSystemId: fileSystemId,
          SubnetId: subnetId,
          SecurityGroups: securityGroups,
        })
      );

      const mountTargetId = response.MountTargetId!;
      log.debug(
        `Created EFS MountTarget ${logicalId}: ${mountTargetId}, waiting for available state`
      );

      // Poll until mount target is available
      await this.waitForMountTargetAvailable(mountTargetId, logicalId, resourceType, log);

      log.debug(`Successfully created EFS MountTarget ${logicalId}: ${mountTargetId}`);

      return {
        physicalId: mountTargetId,
        attributes: {},
      };
    } catch (error) {
      if (error instanceof ProvisioningError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log.mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create EFS MountTarget ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            undefined,
            cause
          )
      );
    }
  }

  private async waitForMountTargetAvailable(
    mountTargetId: string,
    logicalId: string,
    resourceType: string,
    log: MaskedLogSinks
  ): Promise<void> {
    const pollIntervalMs = 5000;
    const maxWaitMs = 120000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const response = await this.getClient().send(
        new DescribeMountTargetsCommand({
          MountTargetId: mountTargetId,
        })
      );

      const mountTarget = response.MountTargets?.[0];
      if (mountTarget?.LifeCycleState === 'available') {
        return;
      }

      log.debug(
        `MountTarget ${mountTargetId} state: ${mountTarget?.LifeCycleState ?? 'unknown'}, waiting...`
      );

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new ProvisioningError(
      `Timed out waiting for EFS MountTarget ${mountTargetId} to become available (120s)`,
      resourceType,
      logicalId,
      mountTargetId
    );
  }

  private async deleteMountTarget(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting EFS MountTarget ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteMountTargetCommand({
          MountTargetId: physicalId,
        })
      );

      // Wait for mount target to be fully deleted
      await this.waitForMountTargetDeleted(physicalId, logicalId);

      this.logger.debug(`Successfully deleted EFS MountTarget ${logicalId}`);
    } catch (error) {
      if (error instanceof MountTargetNotFound) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`EFS MountTarget ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete EFS MountTarget ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async waitForMountTargetDeleted(mountTargetId: string, logicalId: string): Promise<void> {
    const pollIntervalMs = 5000;
    const maxWaitMs = 120000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const response = await this.getClient().send(
          new DescribeMountTargetsCommand({
            MountTargetId: mountTargetId,
          })
        );

        const mountTarget = response.MountTargets?.[0];
        if (!mountTarget) {
          return;
        }

        this.logger.debug(
          `MountTarget ${mountTargetId} state: ${mountTarget.LifeCycleState ?? 'unknown'}, waiting for deletion...`
        );
      } catch (error) {
        if (error instanceof MountTargetNotFound) {
          return;
        }
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    this.logger.warn(
      `Timed out waiting for EFS MountTarget ${mountTargetId} deletion for ${logicalId} (120s)`
    );
  }

  // ─── AWS::EFS::AccessPoint ─────────────────────────────────────────

  private async createAccessPoint(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    log.debug(`Creating EFS AccessPoint ${logicalId}`);

    const fileSystemId = properties['FileSystemId'] as string | undefined;
    if (!fileSystemId) {
      throw new ProvisioningError(
        `FileSystemId is required for EFS AccessPoint ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const posixUser = properties['PosixUser'] as
      | { Uid: number; Gid: number; SecondaryGids?: number[] }
      | undefined;

    const rootDirectory = properties['RootDirectory'] as
      | {
          Path?: string;
          CreationInfo?: {
            OwnerUid: number;
            OwnerGid: number;
            Permissions: string;
          };
        }
      | undefined;

    const tags = properties['AccessPointTags'] as Array<{ Key: string; Value: string }> | undefined;

    // Issue #2039's mechanism applied to `CreateAccessPoint`; issue
    // [#2080](https://github.com/go-to-k/cdkd/issues/2080) names its absence.
    // The deploy engine wraps every `create()` in an outer transient-error
    // retry and issue #2026 made a bare HTTP 5xx one of them, so a request that
    // actually SUCCEEDED server-side before its response was lost re-enters
    // here from the top. Without a stable token the replay mints a SECOND
    // access point that no state record names, so `cdkd destroy` never reaches
    // it.
    //
    // The field was never simply ABSENT from the wire. EFS models `ClientToken`
    // with Smithy's `idempotencyToken` trait, so the SDK auto-fills it when the
    // caller omits it -- with a fresh value PER REQUEST. Measured against
    // `@aws-sdk/client-efs` 3.1018.0 by capturing two identical sends:
    // `846a541f-ada4-44c5-9d13-f7f32596a5f0` then
    // `d84cafec-c6bb-4be3-b333-696796347e33`. That is the shape issue #2080
    // calls worse than no token at all -- the call site reads as idempotent and
    // behaves exactly as if it were not -- and the same probe shows a
    // caller-supplied value reaching the wire verbatim, which is why the
    // `unhandledByDesign` rationale above no longer says the SDK owns this.
    //
    // DERIVATION. `acquireIdempotencyToken` (per-process nonce, memoised for
    // the life of one create, retired on success), NOT the deterministic
    // sha256-of-immutable-inputs this same file uses for a file system's
    // `CreationToken`.
    //
    // Deliberately NOT argued from a retirement window. EFS publishes no
    // retirement period for a `CreateAccessPoint` `ClientToken`: the only such
    // statement in the EFS User Guide ("Creation token and idempotency", one
    // minute) sits in a section whose examples are file-system CREATION
    // tokens, and the `CreateAccessPoint` API reference describes the repeat
    // unconditionally, as `AccessPointAlreadyExists` with no window attached.
    // Treat the duration as unknown; the choice does not need it, because the
    // process-scoped derivation is right under BOTH readings:
    //
    //  - If the token IS retired quickly, a value stable across runs buys
    //    nothing -- no two `cdkd deploy` invocations are that close together on
    //    one create -- while it would put a `--replace` delete-then-create
    //    inside the replay window of the access point it had just deleted,
    //    which is the hazard `IdempotencyToken.release` exists to prevent.
    //  - If it instead binds for the access point's LIFETIME (what the API
    //    reference reads like, and what makes the file system's `CreationToken`
    //    hash correct for THAT call), a deterministic hash is worse still: any
    //    re-create whose immutable inputs are unchanged -- a forced
    //    `--replace`, or a redeploy after a lost state record -- would collide
    //    with the live access point instead of creating one.
    //
    // Either way the helper's guarantee is the one this fix needs: identical
    // across every attempt of ONE create, and never handed out again after it.
    //
    // `maxLength: 64` and the helper's default `cdkd-<hex>` spelling are the
    // documented constraints: "up to 64 ASCII characters", pattern `.+`
    // (CreateAccessPoint API reference), so no charset override is needed.
    const clientToken = acquireIdempotencyToken({
      scope: 'CreateAccessPoint',
      logicalId,
      maxLength: 64,
    });

    try {
      const response = await this.createOrAdoptAccessPoint(logicalId, resourceType, log, {
        ClientToken: clientToken.value,
        FileSystemId: fileSystemId,
        PosixUser: posixUser
          ? {
              Uid: Number(posixUser.Uid),
              Gid: Number(posixUser.Gid),
              SecondaryGids: posixUser.SecondaryGids?.map(Number),
            }
          : undefined,
        RootDirectory: rootDirectory
          ? {
              Path: rootDirectory.Path,
              CreationInfo: rootDirectory.CreationInfo
                ? {
                    OwnerUid: Number(rootDirectory.CreationInfo.OwnerUid),
                    OwnerGid: Number(rootDirectory.CreationInfo.OwnerGid),
                    Permissions: rootDirectory.CreationInfo.Permissions,
                  }
                : undefined,
            }
          : undefined,
        Tags: tags?.map((t) => ({ Key: t.Key, Value: t.Value })),
      });

      const accessPointId = response.AccessPointId!;
      const arn = response.AccessPointArn!;

      log.debug(`Successfully created EFS AccessPoint ${logicalId}: ${accessPointId}`);

      // Success path ONLY, per `acquireIdempotencyToken`'s contract: releasing
      // on the failure path would hand the next attempt a different token and
      // reinstate the duplicate-create window the token exists to close.
      clientToken.release();

      return {
        physicalId: accessPointId,
        attributes: {
          Arn: arn,
          AccessPointId: accessPointId,
        },
      };
    } catch (error) {
      // A decline from `createOrAdoptAccessPoint` is ALREADY the diagnosis, and
      // re-wrapping it names the logical id twice while burying the remediation
      // command. Same guard as `route53-provider.ts` and
      // `fsx-filesystem-provider.ts`.
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log.mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create EFS AccessPoint ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            undefined,
            cause
          )
      );
    }
  }

  /**
   * `CreateAccessPoint`, with the retry-replay case ADOPTED rather than failed
   * (issue [#2080](https://github.com/go-to-k/cdkd/issues/2080)).
   *
   * EFS REFUSES a repeated token -- `AccessPointAlreadyExists`, naming the
   * first access point's id -- which is what issue #2442 measured on real EFS,
   * whether or not the repeat's parameters matched. The first attempt's access point is then live AND absent from
   * state, which is the orphan the token exists to prevent, now with a failed
   * deploy on top, so this arm is the ORDINARY recovery path for a lost
   * response. A REPLAY of the first response was never observed, but nothing
   * documents that it cannot happen (see the DERIVATION note in
   * `createAccessPoint`); if it does, this method returns it like any other
   * success. `route53-provider.ts`'s `createOrAdoptHostedZone` is the same
   * pattern for the same issue family.
   *
   * Adoption is CONFIRMED rather than assumed, on four axes: the token (cdkd
   * mints a per-process value, so only an attempt of THIS create can hold it --
   * the parameter type requires one, so there is no "both undefined" way to
   * satisfy the comparison vacuously), the file system, and the `PosixUser` and
   * `RootDirectory` (issue #3894). The last three are structural rather than
   * contingent on the engine resolving properties once per create, which is
   * true today and is not this method's to rely on: because the refusal does
   * not depend on the parameters, a token re-sent with different ones would
   * otherwise be adopted. `PosixUser` and `RootDirectory` are compared through
   * EFS's defaults (`samePosixUser`, `sameRootDirectory`).
   *
   * Every way the confirmation can fail -- no id on the error, a read-back that
   * throws, a token, file system, POSIX user or root directory that does not
   * match, a description with no ARN -- DECLINES the adoption, says so at `warn`, and rethrows carrying the
   * AWS error as `cause`. A conflict cdkd cannot attribute to itself is not
   * something to paper over, and a lookup failure must never REPLACE the
   * diagnosis: a missing `elasticfilesystem:DescribeAccessPoints` permission
   * would otherwise surface as `AccessDenied` and send the next reader after a
   * permissions problem instead of the token collision that actually happened.
   *
   * The rethrow is WRAPPED rather than bare, and that is load-bearing rather
   * than cosmetic. `DeployEngine`'s replacement path classifies a failed
   * create-first attempt with `isNameCollisionErrorFrom`, which credits
   * `already exists` / `AlreadyExists` only when the TOP-LEVEL message relays
   * it -- and the raw AWS conflict carries both. A token collision misread as
   * a physical-NAME collision is not a cosmetic mistake: under `UpdateReplacePolicy: Retain` it
   * produces advice about renaming a resource that has no name, and under
   * `--replace` it falls back to delete-first, which DELETES the old access
   * point and then re-creates with the same still-unreleased token -- colliding
   * again, against the orphan rather than the old resource. Before this change
   * the create path could not raise an already-exists shape at all, so the
   * exposure arrives with the token. The AWS error is preserved as `cause`, so
   * nothing is lost; only the string the engine classifies on changes.
   */
  private async createOrAdoptAccessPoint(
    logicalId: string,
    resourceType: string,
    log: MaskedLogSinks,
    input: CreateAccessPointCommandInput & { ClientToken: string }
  ): Promise<Pick<AccessPointDescription, 'AccessPointId' | 'AccessPointArn'>> {
    try {
      return await this.getClient().send(new CreateAccessPointCommand(input));
    } catch (error) {
      // `instanceof` alone is not enough -- but NOT for the reason it looks
      // like. Smithy's `ServiceException[Symbol.hasInstance]` matches on
      // `$fault && $metadata && name === this.name` rather than on prototype
      // identity, so a duplicate `@aws-sdk/client-efs` copy in the tree is
      // ALREADY covered by `instanceof`. What the string comparison adds is the
      // shape that carries the right `name` and none of the marker fields: a
      // re-thrown plain object, or a transport wrapper that lost them.
      const alreadyExists =
        error instanceof AccessPointAlreadyExists ||
        (error as { name?: string } | undefined)?.name === 'AccessPointAlreadyExists';
      if (!alreadyExists) {
        throw error;
      }
      // Everything below DECLINES rather than throws bare -- see the wrapping
      // note on this method. No message here interpolates a value out of
      // `properties`: `FileSystemId` can be an intrinsic that resolved to a
      // secret, and a provider's own `logger` line reaches no engine masking
      // sink (`.claude/rules/provider-masking.md`); `log` masks every line
      // here anyway, but only as a fallback. The logical id and the access
      // point id identify the resource without it.
      //
      // AWS-AUTHORED text is withheld for the same reason and one more. This
      // message is THROWN, so it reaches the durable `deployments/{runId}.jsonl`
      // event store, which outlives `cdkd destroy` -- and the headline
      // population of the read-back arm is a missing
      // `elasticfilesystem:DescribeAccessPoints`, whose AWS message names the
      // account id, the deploy role and the session. `describeAwsFailure` is
      // the repo's answer (`src/utils/aws-failure-text.ts`): its `summary`
      // names the failure CLASS and goes in the thrown message, its `detail`
      // carries AWS's own words to `debug`.
      //
      // Withholding that text also closes a classification channel, which is
      // the point of the wrap on this method rather than a bonus. AWS's
      // `AccessDenied` wording contains `not authorized to perform`, which is
      // an `IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS` entry
      // (`src/deployment/retryable-errors.ts`), so interpolating it made a
      // PERMANENTLY missing grant retry on the dense IAM-propagation cadence --
      // 27 attempts re-issuing `CreateAccessPoint` for a permission that will
      // never appear. The trade is deliberate and one-directional: this decline
      // is now TERMINAL, which is right for a grant that is absent rather than
      // propagating.
      const decline = (reason: string): never => {
        log.warn(
          `CreateAccessPoint for ${logicalId} was refused because the idempotency token cdkd sent is already bound to an access point, and cdkd declined to adopt it: ${reason}.`
        );
        // `markNonRetryable` rather than trusting the wording: the message
        // interpolates a user-chosen `logicalId`, and
        // `RETRYABLE_ERROR_MESSAGE_PATTERNS` holds whitespace-free entries
        // (`DependencyViolation`, `QueueDeletedRecently`, ...), so a logical id
        // containing one would flip this deliberately-terminal decline back to
        // retryable.
        throw markNonRetryable(
          new ProvisioningError(
            `EFS refused CreateAccessPoint for ${logicalId}: the idempotency token cdkd sent is already bound to an access point, and cdkd could not confirm that access point is the one this deploy created (${reason}). That access point is NOT recorded in cdkd state -- find it with: ${withPasteableAwsProfile('aws efs describe-access-points')} --query "AccessPoints[?ClientToken=='${input.ClientToken}']"`,
            resourceType,
            logicalId,
            undefined,
            error instanceof Error ? error : undefined
          )
        );
      };

      const existingId = (error as { AccessPointId?: string } | undefined)?.AccessPointId;
      if (!existingId) {
        return decline('the conflict named no AccessPointId to read back');
      }

      let existing: AccessPointDescription | undefined;
      try {
        // RETRIED, because declining here costs more than declining anywhere
        // else in this method: a transient 500 on the CONFIRMATION would fail
        // the deploy AND leave the access point the first attempt created
        // live and unrecorded -- precisely the orphan the token exists to
        // prevent. The outer engine retry cannot cover it: `isTransientServerError`
        // walks `.cause`, which holds the 409 conflict rather than this 500.
        // Transient 5xx AND throttles. A modeled `@throws` list is not
        // exhaustive -- `DescribeAccessPoints` models only
        // `AccessPointNotFound` / `BadRequest` / `FileSystemNotFound` /
        // `InternalServerError`, yet AWS returns an unmodeled throttle on any
        // operation, arriving by NAME or as HTTP 429. Neither is a
        // `TRANSIENT_SERVER_ERROR_STATUS_CODES` entry, so a 5xx-only predicate
        // declines a throttled confirmation and strands the SAME orphan a 5xx
        // would. (Do not re-derive this from the modeled list and conclude the
        // clause is dead: EFS's own `ThrottlingException` is modeled on
        // `CreateAccessPoint`, not here.) An `AccessDenied` stays terminal
        // either way -- it is a grant that is absent rather
        // than propagating, and retrying it would spend the schedule on a
        // permission that will never appear -- the same waste the withheld
        // message above removes from the OUTER retry. Passing an explicit
        // predicate also opts out of the dense IAM-propagation ceiling.
        //
        // The watch is per-WAIT and never on `this` -- the provider is a
        // singleton serving concurrent resources, so a shared watch would let
        // one resource's Ctrl-C abort another's retry. Disposed in a `finally`.
        const watch = startInterruptWatch(`EFS AccessPoint ${logicalId} (adoption read-back)`);
        let described: DescribeAccessPointsCommandOutput;
        try {
          described = await withRetry(
            () =>
              this.getClient().send(new DescribeAccessPointsCommand({ AccessPointId: existingId })),
            logicalId,
            {
              maxRetries: 3,
              isRetryable: (_text, err) => isThrottlingError(err) || isTransientServerError(err),
              // The masked sink, not `this.logger`: `withRetry` puts AWS's
              // own text in its per-attempt and give-up lines (issue #2050).
              logger: log,
              isInterrupted: watch.isInterrupted,
              onInterrupted: watch.onInterrupted,
            }
          );
        } finally {
          watch.dispose();
        }
        existing = described.AccessPoints?.[0];
      } catch (lookupError) {
        // An INTERRUPT is not a lookup failure, and must escape before
        // `decline` can re-label it. `decline` sets `cause` to the
        // CreateAccessPoint conflict, which ERASES the interrupt from the
        // chain that `isInterruptedWaitError` walks -- so a Ctrl-C landing in
        // the backoff above would reach `deploy-engine.ts`'s failure branch
        // and roll the whole stack back automatically. That is the exact
        // outcome `interrupt-watch.ts` exists to prevent, and threading the
        // interrupt is what created the window. Same guard as
        // `dynamodb-globaltable-provider.ts` and `elbv2-provider.ts`.
        if (isInterruptedWaitError(lookupError)) throw lookupError;
        // The lookup error must never REPLACE the diagnosis, so the token
        // collision stays the headline and AWS's own words go to `debug`.
        const failure = describeAwsFailure(lookupError);
        log.debug(`Read-back of access point ${existingId} failed with: ${failure.detail}`);
        return decline(`reading access point ${existingId} back failed: ${failure.summary}`);
      }

      if (existing === undefined) {
        return decline(`access point ${existingId} could not be read back`);
      }
      if (existing.ClientToken !== input.ClientToken) {
        return decline(`access point ${existingId} carries a different ClientToken`);
      }
      if (existing.FileSystemId !== input.FileSystemId) {
        return decline(`access point ${existingId} belongs to a different file system`);
      }
      // EFS refuses a repeated token whether or not its parameters match
      // (issue #2442), so the token alone does not prove the access point is
      // the one THIS request described. The reasons name the field, never its
      // value -- same withholding as every other reason here.
      if (!samePosixUser(input.PosixUser, existing.PosixUser)) {
        return decline(`access point ${existingId} has a different PosixUser`);
      }
      if (!sameRootDirectory(input.RootDirectory, existing.RootDirectory)) {
        return decline(`access point ${existingId} has a different RootDirectory`);
      }
      if (!existing.AccessPointId) {
        return decline(`access point ${existingId} was read back without an id`);
      }
      if (!existing.AccessPointArn) {
        return decline(`access point ${existingId} was read back without an ARN`);
      }
      // An access point already on its way out, or wedged, must not be
      // recorded as this stack's physical id: the next command would resolve
      // state to a resource AWS is deleting or one that can never become
      // usable. `available`, `creating` and `updating` all pass -- this
      // provider has no access-point waiter, and a `creating` access point is
      // the normal answer to a replayed create.
      if (
        existing.LifeCycleState === 'deleting' ||
        existing.LifeCycleState === 'deleted' ||
        existing.LifeCycleState === 'error'
      ) {
        return decline(
          `access point ${existingId} is ${existing.LifeCycleState} rather than usable`
        );
      }

      log.warn(
        `CreateAccessPoint was replayed after a lost response; adopting the access point ${existing.AccessPointId} the previous attempt already created instead of creating a second one`
      );
      return existing;
    }
  }

  private async deleteAccessPoint(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting EFS AccessPoint ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteAccessPointCommand({
          AccessPointId: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted EFS AccessPoint ${logicalId}`);
    } catch (error) {
      if (error instanceof AccessPointNotFound) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`EFS AccessPoint ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete EFS AccessPoint ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Read the AWS-current EFS resource configuration in CFn-property shape.
   *
   * Dispatch per resource type:
   *  - `FileSystem` → `DescribeFileSystems` filtered by id (PerformanceMode,
   *    ThroughputMode, Encrypted, KmsKeyId, ProvisionedThroughputInMibps,
   *    AvailabilityZoneName, FileSystemProtection), plus optional
   *    `DescribeLifecycleConfiguration`, `DescribeBackupPolicy`, and
   *    `DescribeFileSystemPolicy` enrichment. Each enrichment call is wrapped
   *    in its own try/catch so a "not configured" error on any of them omits
   *    the corresponding key without failing the whole snapshot.
   *  - `AccessPoint` → `DescribeAccessPoints` filtered by id (PosixUser,
   *    RootDirectory).
   *  - `MountTarget` → `DescribeMountTargets` (FileSystemId, SubnetId)
   *    plus `DescribeMountTargetSecurityGroups` for the SG list (always-
   *    emit `[]` when AWS reports none so a console-side ADD on a
   *    previously-unconfigured mount target is detectable).
   *
   * `FileSystemTags` (the CFn property name on `AWS::EFS::FileSystem`) is
   * surfaced from the same `DescribeFileSystems` response — `aws:*`
   * auto-tags filtered, key omitted when empty. `AccessPoint` and
   * `MountTarget` are not surfaced for tags here (`AccessPointTags` would
   * mirror this approach but the test scope below covers `FileSystem`
   * only; further coverage can land in a follow-up).
   * Returns `RESOURCE_NOT_FOUND` when the resource is gone (`*NotFound`, or an
   * empty describe list for the id).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    switch (resourceType) {
      case 'AWS::EFS::FileSystem':
        return this.readFileSystem(physicalId);
      case 'AWS::EFS::AccessPoint':
        return this.readAccessPoint(physicalId);
      case 'AWS::EFS::MountTarget':
        return this.readMountTarget(physicalId);
      default:
        return undefined;
    }
  }

  private async readFileSystem(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let fs;
    let listed: readonly unknown[] | undefined;
    try {
      const resp = await this.getClient().send(
        new DescribeFileSystemsCommand({ FileSystemId: physicalId })
      );
      listed = resp.FileSystems;
      fs = resp.FileSystems?.[0];
    } catch (err) {
      if (err instanceof FileSystemNotFound) return RESOURCE_NOT_FOUND;
      throw err;
    }
    // An empty list for the requested id is AWS saying it is gone; an absent
    // list (empty body) keeps `undefined`.
    if (!fs) return listed?.length === 0 ? RESOURCE_NOT_FOUND : undefined;

    const result: Record<string, unknown> = {};
    if (fs.PerformanceMode !== undefined) result['PerformanceMode'] = fs.PerformanceMode;
    if (fs.ThroughputMode !== undefined) result['ThroughputMode'] = fs.ThroughputMode;
    if (fs.Encrypted !== undefined) result['Encrypted'] = fs.Encrypted;
    if (fs.KmsKeyId !== undefined) result['KmsKeyId'] = fs.KmsKeyId;
    if (fs.ProvisionedThroughputInMibps !== undefined) {
      result['ProvisionedThroughputInMibps'] = fs.ProvisionedThroughputInMibps;
    }
    // AvailabilityZoneName (One Zone EFS) and FileSystemProtection ride on the
    // same DescribeFileSystems response.
    if (fs.AvailabilityZoneName !== undefined) {
      result['AvailabilityZoneName'] = fs.AvailabilityZoneName;
    }
    if (fs.FileSystemProtection?.ReplicationOverwriteProtection !== undefined) {
      result['FileSystemProtection'] = {
        ReplicationOverwriteProtection: fs.FileSystemProtection.ReplicationOverwriteProtection,
      };
    }

    // LifecyclePolicies — separate call, "not configured" omits the key.
    try {
      const resp = await this.getClient().send(
        new DescribeLifecycleConfigurationCommand({ FileSystemId: physicalId })
      );
      const policies = resp.LifecyclePolicies ?? [];
      // Emit-when-present: only surface the key when AWS actually reports
      // lifecycle policies. An always-emitted `[]` placeholder would diverge
      // from every other backfilled prop's emit-when-present invariant and is
      // a latent footgun for a future drift --revert that diffs the other
      // direction (AWS snapshot -> template).
      if (policies.length > 0) {
        result['LifecyclePolicies'] = policies.map((p) => {
          const out: Record<string, unknown> = {};
          if (p.TransitionToIA !== undefined) out['TransitionToIA'] = p.TransitionToIA;
          if (p.TransitionToPrimaryStorageClass !== undefined) {
            out['TransitionToPrimaryStorageClass'] = p.TransitionToPrimaryStorageClass;
          }
          if (p.TransitionToArchive !== undefined) {
            out['TransitionToArchive'] = p.TransitionToArchive;
          }
          return out;
        });
      }
    } catch (err) {
      // "Not configured" is service-specific; FileSystemNotFound on this call
      // means the FS itself is gone between the two calls.
      if (err instanceof FileSystemNotFound) return RESOURCE_NOT_FOUND;
      // Other errors (e.g. PolicyNotFound, AccessDenied) — omit the key,
      // don't fail the whole snapshot.
      const e = err as { name?: string };
      if (e.name !== 'PolicyNotFound') {
        // Best-effort: log and continue. Drift comparator only descends into
        // keys present in state, so an absent key cannot fire false drift.
      }
    }

    // BackupPolicy — separate call, "not configured" omits the key.
    try {
      const resp = await this.getClient().send(
        new DescribeBackupPolicyCommand({ FileSystemId: physicalId })
      );
      if (resp.BackupPolicy?.Status !== undefined) {
        result['BackupPolicy'] = { Status: resp.BackupPolicy.Status };
      }
    } catch (err) {
      if (err instanceof FileSystemNotFound) return RESOURCE_NOT_FOUND;
      // PolicyNotFound or similar — omit the key.
    }

    // FileSystemPolicy — separate DescribeFileSystemPolicy call. AWS returns
    // the policy as a JSON string; the CFn property is a policy object, so
    // parse it back so the drift comparator compares object-to-object.
    // "PolicyNotFound" (no policy attached) omits the key.
    try {
      const resp = await this.getClient().send(
        new DescribeFileSystemPolicyCommand({ FileSystemId: physicalId })
      );
      if (resp.Policy !== undefined) {
        try {
          result['FileSystemPolicy'] = JSON.parse(resp.Policy);
        } catch {
          // Non-JSON policy string (should not happen) — surface verbatim.
          result['FileSystemPolicy'] = resp.Policy;
        }
      }
    } catch (err) {
      if (err instanceof FileSystemNotFound) return RESOURCE_NOT_FOUND;
      // PolicyNotFound or similar — omit the key.
    }

    // FileSystemTags from the same DescribeFileSystems response.
    const tags = normalizeAwsTagsToCfn(fs.Tags);
    result['FileSystemTags'] = tags;

    return result;
  }

  private async readAccessPoint(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let ap;
    let listed: readonly unknown[] | undefined;
    try {
      const resp = await this.getClient().send(
        new DescribeAccessPointsCommand({ AccessPointId: physicalId })
      );
      listed = resp.AccessPoints;
      ap = resp.AccessPoints?.[0];
    } catch (err) {
      if (err instanceof AccessPointNotFound) return RESOURCE_NOT_FOUND;
      throw err;
    }
    // An empty list for the requested id is AWS saying it is gone; an absent
    // list (empty body) keeps `undefined`.
    if (!ap) return listed?.length === 0 ? RESOURCE_NOT_FOUND : undefined;

    const result: Record<string, unknown> = {};
    if (ap.FileSystemId !== undefined) result['FileSystemId'] = ap.FileSystemId;
    if (ap.PosixUser) {
      const posix: Record<string, unknown> = {};
      if (ap.PosixUser.Uid !== undefined) posix['Uid'] = ap.PosixUser.Uid;
      if (ap.PosixUser.Gid !== undefined) posix['Gid'] = ap.PosixUser.Gid;
      if (ap.PosixUser.SecondaryGids && ap.PosixUser.SecondaryGids.length > 0) {
        posix['SecondaryGids'] = [...ap.PosixUser.SecondaryGids];
      }
      if (Object.keys(posix).length > 0) result['PosixUser'] = posix;
    }
    if (ap.RootDirectory) {
      const root: Record<string, unknown> = {};
      if (ap.RootDirectory.Path !== undefined) root['Path'] = ap.RootDirectory.Path;
      if (ap.RootDirectory.CreationInfo) {
        const ci: Record<string, unknown> = {};
        if (ap.RootDirectory.CreationInfo.OwnerUid !== undefined) {
          ci['OwnerUid'] = ap.RootDirectory.CreationInfo.OwnerUid;
        }
        if (ap.RootDirectory.CreationInfo.OwnerGid !== undefined) {
          ci['OwnerGid'] = ap.RootDirectory.CreationInfo.OwnerGid;
        }
        if (ap.RootDirectory.CreationInfo.Permissions !== undefined) {
          ci['Permissions'] = ap.RootDirectory.CreationInfo.Permissions;
        }
        if (Object.keys(ci).length > 0) root['CreationInfo'] = ci;
      }
      if (Object.keys(root).length > 0) result['RootDirectory'] = root;
    }
    return result;
  }

  private async readMountTarget(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let mt;
    let listed: readonly unknown[] | undefined;
    try {
      const resp = await this.getClient().send(
        new DescribeMountTargetsCommand({ MountTargetId: physicalId })
      );
      listed = resp.MountTargets;
      mt = resp.MountTargets?.[0];
    } catch (err) {
      if (err instanceof MountTargetNotFound) return RESOURCE_NOT_FOUND;
      throw err;
    }
    // An empty list for the requested id is AWS saying it is gone; an absent
    // list (empty body) keeps `undefined`.
    if (!mt) return listed?.length === 0 ? RESOURCE_NOT_FOUND : undefined;

    const result: Record<string, unknown> = {};
    if (mt.FileSystemId !== undefined) result['FileSystemId'] = mt.FileSystemId;
    if (mt.SubnetId !== undefined) result['SubnetId'] = mt.SubnetId;

    // SecurityGroups via DescribeMountTargetSecurityGroups. Always-emit
    // `[]` placeholder when AWS reports none so a console-side ADD on a
    // previously-unconfigured mount target is detectable on the v3
    // observedProperties baseline.
    let securityGroups: string[] = [];
    try {
      const sgResp = await this.getClient().send(
        new DescribeMountTargetSecurityGroupsCommand({ MountTargetId: physicalId })
      );
      securityGroups = (sgResp.SecurityGroups ?? []).filter(
        (s): s is string => typeof s === 'string'
      );
    } catch {
      // Best-effort.
    }
    result['SecurityGroups'] = securityGroups;

    return result;
  }

  /**
   * Adopt an existing EFS resource into cdkd state.
   *
   * Supported types:
   *  - `AWS::EFS::FileSystem` — full tag-based lookup via
   *    `DescribeFileSystems` with `Tags` inline on each item.
   *  - `AWS::EFS::AccessPoint` — full tag-based lookup via
   *    `DescribeAccessPoints` with `Tags` inline on each item.
   *  - `AWS::EFS::MountTarget` — override-only (mount targets are
   *    not taggable; auto lookup is impractical).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::EFS::FileSystem':
        return this.importFileSystem(input);
      case 'AWS::EFS::AccessPoint':
        return this.importAccessPoint(input);
      case 'AWS::EFS::MountTarget':
        if (input.knownPhysicalId) {
          return { physicalId: input.knownPhysicalId, attributes: {} };
        }
        return null;
      default:
        return null;
    }
  }

  private async importFileSystem(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        const resp = await this.getClient().send(
          new DescribeFileSystemsCommand({ FileSystemId: input.knownPhysicalId })
        );
        const fs = resp.FileSystems?.[0];
        return fs?.FileSystemId ? { physicalId: fs.FileSystemId, attributes: {} } : null;
      } catch (err) {
        if (err instanceof FileSystemNotFound) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources; a file system reaching here needs an explicit
    // `--resource` override.
    return null;
  }

  private async importAccessPoint(
    input: ResourceImportInput
  ): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        const resp = await this.getClient().send(
          new DescribeAccessPointsCommand({ AccessPointId: input.knownPhysicalId })
        );
        const ap = resp.AccessPoints?.[0];
        // Issue #3627: the same map `create()` records; the physical id is
        // `fsap-...`, so without `Arn` the resolver's shape guard refused
        // `Fn::GetAtt [AccessPoint, Arn]`.
        return ap?.AccessPointId
          ? {
              physicalId: ap.AccessPointId,
              attributes: definedAttributes({
                Arn: ap.AccessPointArn,
                AccessPointId: ap.AccessPointId,
              }),
            }
          : null;
      } catch (err) {
        if (err instanceof AccessPointNotFound) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk (issue #1134): the tag can never exist on a
    // real resource, so the walk could not match. An access point reaching
    // here needs an explicit `--resource` override.
    return null;
  }
}
