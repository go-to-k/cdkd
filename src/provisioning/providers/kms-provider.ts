import { KMSClient, type CreateKeyCommandInput } from '@aws-sdk/client-kms';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { withoutServerErrorRetries, type AmbiguousCreateWindow } from './ambiguous-create.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { markRedactedCause, relayedNameCollision } from '../../deployment/retryable-errors.js';
import {
  createKey,
  regionArg,
  resumeKeyFromFailedAttempt,
  reportPossibleOrphanKeys,
} from './kms/key-create.js';
import {
  updateKey,
  liveKeyMatches,
  sendRotation,
  defaultKeyPolicy,
  applyTagDiff,
} from './kms/key-update.js';
import { deleteKey, deleteAlias } from './kms/delete.js';
import { createAlias, updateAlias } from './kms/alias.js';
import { readCurrentStateKey, readCurrentStateAlias, importImpl } from './kms/read-state.js';

export { resetKmsCreateRetryStateForTests } from './kms/shared.js';

/**
 * SDK Provider for AWS KMS resources
 *
 * Supports:
 * - AWS::KMS::Key
 * - AWS::KMS::Alias
 *
 * KMS CreateKey/CreateAlias are synchronous - the CC API adds unnecessary
 * polling overhead for operations that complete immediately.
 */
export class KMSProvider implements ResourceProvider {
  client: KMSClient | undefined;
  createClient: KMSClient | undefined;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('KMSProvider');

  /**
   * The failure wrap every create / update / delete catch builds.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
   * caller's assumed-role ARN (an alias's `AlreadyExistsException` names the
   * account id in the alias ARN too). AWS's own text goes to `debug` through the
   * operation's `maskSecrets` (`mask`), and the wrap is stamped
   * `markRedactedCause`, so the retry classifiers read the withheld text on the
   * `cause` chain (an IAM grant still propagating to `EnableKeyRotation` stays
   * retryable). An "already exists" is restated ({@link relayedNameCollision}).
   * A cdkd-authored or transport error, or a non-`Error` throw, keeps its text;
   * the deploy engine masks a thrown message. Both deletes check
   * `NotFoundException` by type before they wrap, so no "already deleted"
   * reading depends on AWS's wording.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  wrapCaughtError(
    mask: ((text: string) => string) | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!(error instanceof Error) || !failure.redacted) return build(failure.detail);
    const m = mask ?? ((text: string) => text);
    this.logger.debug(m(build(m(failure.detail)).message));
    return markRedactedCause(build(`${m(failure.summary)}${relayedNameCollision(failure.detail)}`));
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::KMS::Key',
      new Set([
        'Description',
        'KeyPolicy',
        'KeySpec',
        'KeyUsage',
        'EnableKeyRotation',
        'Tags',
        'Enabled',
        'MultiRegion',
        'PendingWindowInDays',
        'RotationPeriodInDays',
        'Origin',
        'BypassPolicyLockoutSafetyCheck',
      ]),
    ],
    ['AWS::KMS::Alias', new Set(['AliasName', 'TargetKeyId'])],
  ]);

  /**
   * Issue #1160: CloudFormation resets a removed `RotationPeriodInDays` to
   * 365 while rotation stays on (A/B, us-east-1, 2026-10-20: 90 -> 365, alone
   * and beside another change). `EnableKeyRotation` keeps an absent period,
   * so `updateKey` re-sends the declared 365. A removed `KeyPolicy` resets
   * too, but to a policy naming the key's account, so `updateKey` builds it.
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>([
    ['AWS::KMS::Key', new Map<string, unknown>([['RotationPeriodInDays', 365]])],
  ]);

  getClient(): KMSClient {
    if (!this.client) {
      this.client = new KMSClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.client;
  }

  /**
   * The client `CreateKey` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #2080). Separate so every other call
   * keeps the full SDK retry.
   */
  getCreateClient(): KMSClient {
    if (!this.createClient) {
      this.createClient = withoutServerErrorRetries(
        new KMSClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.createClient;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::KMS::Key':
        return this.createKey(logicalId, resourceType, properties, context?.maskSecrets);
      case 'AWS::KMS::Alias':
        return this.createAlias(logicalId, resourceType, properties, context?.maskSecrets);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    // go-to-k/cdkd#2613: an alias's physical id is a NAME and a multi-region
    // key shares its id across regions, so a client in another region than
    // the state record would act on a resource cdkd does not manage. Refuse
    // before any call; the client's region is resolved only when there is one
    // to compare with.
    assertRegionMatch(
      context?.expectedRegion ? await this.getClient().config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );
    switch (resourceType) {
      case 'AWS::KMS::Key':
        return this.updateKey(
          logicalId,
          physicalId,
          resourceType,
          properties,
          _previousProperties,
          context
        );
      case 'AWS::KMS::Alias':
        return this.updateAlias(
          logicalId,
          physicalId,
          resourceType,
          properties,
          context?.maskSecrets
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

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::KMS::Key':
        return this.deleteKey(logicalId, physicalId, resourceType, _properties, context);
      case 'AWS::KMS::Alias':
        return this.deleteAlias(logicalId, physicalId, resourceType, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── AWS::KMS::Key ─────────────────────────────────────────────────

  createKey(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined
  ): Promise<ResourceCreateResult> {
    return createKey.call(this, logicalId, resourceType, properties, mask);
  }

  regionArg(
    aws: ReturnType<typeof pasteableAwsCommand>
  ): Promise<ReturnType<ReturnType<typeof pasteableAwsCommand>>> {
    return regionArg.call(this, aws);
  }

  resumeKeyFromFailedAttempt(
    logicalId: string,
    attemptKey: string,
    inputDigest: string
  ): Promise<{ keyId: string; keyArn: string } | 'superseded' | undefined> {
    return resumeKeyFromFailedAttempt.call(this, logicalId, attemptKey, inputDigest);
  }

  reportPossibleOrphanKeys(
    logicalId: string,
    input: CreateKeyCommandInput,
    window: AmbiguousCreateWindow
  ): Promise<void> {
    return reportPossibleOrphanKeys.call(this, logicalId, input, window);
  }

  updateKey(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): Promise<ResourceUpdateResult> {
    return updateKey.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  liveKeyMatches(
    physicalId: string,
    properties: Record<string, unknown>,
    changed: readonly string[],
    logicalId: string
  ): Promise<boolean> {
    return liveKeyMatches.call(this, physicalId, properties, changed, logicalId);
  }

  sendRotation(
    send: () => Promise<unknown>,
    justEnabled: boolean,
    resourceType: string,
    logicalId: string,
    physicalId: string
  ): Promise<void> {
    return sendRotation.call(this, send, justEnabled, resourceType, logicalId, physicalId);
  }

  defaultKeyPolicy(keyId: string): Promise<string> {
    return defaultKeyPolicy.call(this, keyId);
  }

  deleteKey(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteKey.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  applyTagDiff(
    keyId: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown
  ): Promise<void> {
    return applyTagDiff.call(this, keyId, resourceType, logicalId, oldTagsRaw, newTagsRaw);
  }

  // ─── AWS::KMS::Alias ───────────────────────────────────────────────

  createAlias(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined
  ): Promise<ResourceCreateResult> {
    return createAlias.call(this, logicalId, resourceType, properties, mask);
  }

  updateAlias(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined
  ): Promise<ResourceUpdateResult> {
    return updateAlias.call(this, logicalId, physicalId, resourceType, properties, mask);
  }

  deleteAlias(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteAlias.call(this, logicalId, physicalId, resourceType, context);
  }

  /**
   * Read the AWS-current KMS resource configuration in CFn-property shape.
   *
   * Dispatches by resource type:
   *   - `AWS::KMS::Key` → `DescribeKey`. Surfaces `Description`, `KeySpec`,
   *     `KeyUsage`, `Enabled`, `MultiRegion`, `Origin`. `KeyPolicy` is
   *     additionally retrieved via `GetKeyPolicy` (URL-decoded JSON-parsed)
   *     and `EnableKeyRotation` / `RotationPeriodInDays` via
   *     `GetKeyRotationStatus` (Class 1 discriminator-gated on `KeySpec`
   *     since asymmetric keys reject the call).
   *   - `AWS::KMS::Alias` → `ListAliases` filtered to the alias name.
   *     Surfaces `AliasName`, `TargetKeyId`. `ListAliases` is paginated
   *     since there's no direct "describe one alias" API.
   *
   * `Tags` is surfaced for `AWS::KMS::Key` via a follow-up
   * `ListResourceTags(KeyId)` call (KMS uses `[{TagKey, TagValue}]` shape).
   * CDK's `aws:*` auto-tags are filtered out; the result key is omitted
   * entirely when AWS reports no user tags. `AWS::KMS::Alias` does not
   * support tags. `BypassPolicyLockoutSafetyCheck` and `PendingWindowInDays`
   * are not part of the persisted AWS state visible via `DescribeKey`.
   *
   * Returns `RESOURCE_NOT_FOUND` when the resource is gone (`NotFoundException`,
   * or an alias absent from every `ListAliases` page).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    switch (resourceType) {
      case 'AWS::KMS::Key':
        return this.readCurrentStateKey(physicalId);
      case 'AWS::KMS::Alias':
        return this.readCurrentStateAlias(physicalId);
      default:
        return undefined;
    }
  }

  readCurrentStateKey(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentStateKey.call(this, physicalId);
  }

  /**
   * Declare state property paths cdkd cannot round-trip from AWS, so the
   * drift comparator skips them instead of firing guaranteed false-
   * positive drift on every clean run.
   *
   *  - `BypassPolicyLockoutSafetyCheck` / `PendingWindowInDays`: not part
   *    of the persisted AWS state visible via `DescribeKey` — both are
   *    create / delete-time-only inputs.
   *
   * `KeyPolicy`, `EnableKeyRotation`, and `RotationPeriodInDays` are now
   * read by `readCurrentState` (`GetKeyPolicy` and `GetKeyRotationStatus`
   * respectively), so they no longer need to be declared here.
   */
  getDriftUnknownPaths(resourceType: string): string[] {
    if (resourceType === 'AWS::KMS::Key') {
      return ['BypassPolicyLockoutSafetyCheck', 'PendingWindowInDays'];
    }
    return [];
  }

  readCurrentStateAlias(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentStateAlias.call(this, physicalId);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
