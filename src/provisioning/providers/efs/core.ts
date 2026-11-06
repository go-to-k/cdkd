import type { EFSProvider } from '../efs-provider.js';
import { EFSClient, TagResourceCommand, UntagResourceCommand } from '@aws-sdk/client-efs';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { type DeleteContext } from '../../region-check.js';
import { planTagDiff, tagPlanWarning } from '../../tag-list.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import { type ResourceNotFound } from '../../../types/resource.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
} from '../../../types/resource.js';
import { createMaskedLogSinks, type MaskedLogSinks } from '../../masked-retry-logger.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from '../ambiguous-create.js';
import { isAuxiliaryFailure } from '../../auxiliary-failure.js';
import { markNotGone } from '../../not-gone.js';
import { withRemovalDefaults } from '../../update-removal.js';

export function getClient(this: EFSProvider): EFSClient {
  if (!this.client) {
    // Built together with the mount target create client, so both capture
    // the identity active at this ONE call (issue #4639).
    this.client = new EFSClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
    this.mountTargetCreateClient = withoutServerErrorRetries(
      new EFSClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      })
    );
  }
  return this.client;
}

/**
 * The client `CreateMountTarget` goes through: SDK retries on, except a 5xx
 * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
 * keeps the full SDK retry. `CreateFileSystem` and `CreateAccessPoint` stay
 * on the shared client: each carries a cdkd-set idempotency token, so the
 * SDK's replay of either is answered with the resource the first send made.
 *
 * `CreateMountTarget` carries no idempotency token and a file system holds
 * at most one mount target per Availability Zone, so the SDK's own replay of
 * a 5xx whose request had succeeded collides with the mount target the
 * first send made, and that `MountTargetConflict` surfaced from the engine's
 * FIRST attempt as a mount target somebody else holds. Refused here, the 5xx
 * reaches the deploy engine's retry, which marks the create as possibly
 * replayed (`withRetry`, #3978). Nothing is adopted on that collision: an
 * Availability Zone is not attribution (`docs/provider-rules.md`, "Adopt
 * only on EXACT attribution").
 */
export function getMountTargetCreateClient(this: EFSProvider): EFSClient {
  this.getClient();
  return this.mountTargetCreateClient as EFSClient;
}

/**
 * The failure wrap every `create()` / `update()` / `delete()` catch throws.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
 * caller's assumed-role ARN. AWS's own text goes to `log.debug` (masked), and
 * the wrap is stamped `markRedactedCause`, so the retry classifiers read the
 * withheld text on the `cause` chain. An "already exists" is restated
 * ({@link relayedNameCollision}), unless a post-create call raised it
 * ({@link isAuxiliaryFailure}). A non-`Error` throw is withheld like an AWS
 * one, unstamped (it has no chain).
 *
 * A cdkd-authored or transport error keeps its text masked (issue #2177): AWS quotes a rejected request value back (a subnet,
 * a KMS key, a policy) off the RESOLVED `properties` bag. The `cause` stays
 * unmasked, and a message the mask CHANGED is stamped too
 * (`wrapMaskedAwsError`, issue #4244). A delete builds its sinks from
 * `DeleteContext.maskSecrets`, and checks its `*NotFound` by type before it
 * wraps, so no "already deleted" reading depends on AWS's wording.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call. A method, so `gen-update-wrap-coverage`
 * sees the catch that throws it as a wrap.
 */
export function wrapMaskedError(
  this: EFSProvider,
  log: MaskedLogSinks,
  error: unknown,
  build: (maskedText: string) => ProvisioningError
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return wrapMaskedAwsError(log.mask, error, build);
  log.debug(build(log.mask(failure.detail)).message);
  // Not restated when a post-create call raised it (#3826): "it" would read
  // as this resource.
  const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
  const wrapped = build(`${log.mask(failure.summary)}${relay}`);
  return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
}

/**
 * {@link wrapMaskedError} for a delete catch. The wrap names an AWS failure
 * by its CLASS, and the delete classifiers read `NotFound` in a message as
 * "already deleted": a class naming ANOTHER object's not-found (this
 * resource's own not-found returned before the wrap) is marked
 * `markNotGone`, so the record is kept (go-to-k/cdkd#2319).
 */
export function wrapDeleteError(
  this: EFSProvider,
  log: MaskedLogSinks,
  error: unknown,
  build: (maskedText: string) => ProvisioningError
): ProvisioningError {
  const thrown = this.wrapMaskedError(log, error, build);
  return error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
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
export async function create(
  this: EFSProvider,
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
      return this.createMountTarget(logicalId, resourceType, properties, log, context);
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
 *    ProvisionedThroughputInMibps), the post-create Put* / Update* calls,
 *    and `TagResource` / `UntagResource` (FileSystemTags). Other property
 *    changes (Encrypted / KmsKeyId / PerformanceMode / etc.) are routed
 *    through DELETE+CREATE by the replacement-detection layer; if a
 *    diff somehow includes them, defensively reject.
 *  - `AWS::EFS::MountTarget` → `ModifyMountTargetSecurityGroups`
 *    (SecurityGroups only). IpAddress / IpAddressType / Ipv6Address /
 *    SubnetId / FileSystemId are immutable.
 *  - `AWS::EFS::AccessPoint` → `TagResource` / `UntagResource`
 *    (AccessPointTags, the one property the CFn schema leaves updatable;
 *    go-to-k/cdkd#5464). Any other change is refused so `cdkd drift
 *    --revert` surfaces a clear "use --replace" hint.
 */
export function update(
  this: EFSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
  properties = withRemovalDefaults(
    this.removalDefaults,
    resourceType,
    properties,
    previousProperties,
    context
  );
  switch (resourceType) {
    case 'AWS::EFS::FileSystem':
      return this.updateFileSystem(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        log,
        context?.replayingState === true || context?.desiredFromAwsReadback === true
      );
    case 'AWS::EFS::MountTarget':
      return this.updateMountTarget(logicalId, physicalId, resourceType, properties, log);
    case 'AWS::EFS::AccessPoint':
      return this.updateAccessPoint(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        log
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

/**
 * Apply a tag diff to an EFS file system or access point (both are tagged
 * by id through `TagResource` / `UntagResource`; go-to-k/cdkd#5464).
 * `TagResource` only adds or overwrites, so a key the template dropped —
 * or the whole property removed — is untagged explicitly, as CloudFormation
 * does. Both sides go through `planTagDiff`: an unreadable record untags
 * nothing. The desired side must already have passed
 * `refuseMalformedDesiredTags`.
 */
export async function applyTagDiff(
  this: EFSProvider,
  resourceId: string,
  resourceType: string,
  logicalId: string,
  recorded: unknown,
  desired: unknown,
  log: MaskedLogSinks
): Promise<void> {
  const plan = planTagDiff(recorded, desired);
  const warning = tagPlanWarning(plan, resourceType, logicalId);
  if (warning !== undefined) log.warn(warning);
  if (plan.remove.length > 0) {
    await this.retryOnTransientControlPlane(
      () =>
        this.getClient().send(
          new UntagResourceCommand({ ResourceId: resourceId, TagKeys: plan.remove })
        ),
      `UntagResource ${resourceId}`,
      log
    );
  }
  if (plan.set.size > 0) {
    await this.retryOnTransientControlPlane(
      () =>
        this.getClient().send(
          new TagResourceCommand({
            ResourceId: resourceId,
            Tags: [...plan.set].map(([Key, Value]) => ({ Key, Value })),
          })
        ),
      `TagResource ${resourceId}`,
      log
    );
  }
}

export async function deleteImpl(
  this: EFSProvider,
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
export async function retryOnTransientControlPlane<T>(
  this: EFSProvider,
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
export async function readCurrentState(
  this: EFSProvider,
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
export async function importImpl(
  this: EFSProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  switch (input.resourceType) {
    case 'AWS::EFS::FileSystem':
      return this.importFileSystem(input);
    case 'AWS::EFS::AccessPoint':
      return this.importAccessPoint(input);
    case 'AWS::EFS::MountTarget':
      return this.importMountTarget(input);
    default:
      return null;
  }
}
