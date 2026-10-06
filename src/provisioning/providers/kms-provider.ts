import {
  KMSClient,
  CreateKeyCommand,
  DescribeKeyCommand,
  GetKeyPolicyCommand,
  GetKeyRotationStatusCommand,
  ListAliasesCommand,
  ListResourceTagsCommand,
  ScheduleKeyDeletionCommand,
  CreateAliasCommand,
  DeleteAliasCommand,
  UpdateAliasCommand,
  EnableKeyRotationCommand,
  DisableKeyRotationCommand,
  UpdateKeyDescriptionCommand,
  PutKeyPolicyCommand,
  EnableKeyCommand,
  DisableKeyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ListKeysCommand,
  NotFoundException,
  type CreateKeyCommandInput,
  type CreateKeyCommandOutput,
  type KeyMetadata,
  type KeyUsageType,
  type KeySpec,
  type OriginType,
} from '@aws-sdk/client-kms';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../tag-list.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { createHash } from 'node:crypto';
import {
  AMBIGUOUS_LATCH_TTL_MS,
  AmbiguousCreateLatch,
  RecentIdSet,
  createAttemptKey,
  isInsideWindow,
  setBounded,
  withoutServerErrorRetries,
  type AmbiguousCreateWindow,
} from './ambiguous-create.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { safeMsg } from '../../utils/display-safe.js';
import { isThrottlingError, isTransientServerError } from '../../deployment/retryable-errors.js';

/**
 * Retry-safety state for `CreateKey`, which has no idempotency token and
 * whose key has no name (issue [#2080](https://github.com/go-to-k/cdkd/issues/2080)).
 * Module-scoped rather than on the provider: a provider instance is per
 * registry, and one process can build several.
 */
const createKeyLatch = new AmbiguousCreateLatch('CreateKey');
/** Keys this process created and recorded, never offered as orphan candidates. */
const keysCreatedByThisProcess = new RecentIdSet();
/**
 * A key whose `CreateKey` SUCCEEDED but whose create then failed in a
 * follow-up call (`EnableKeyRotation`, `DisableKey`), keyed by
 * `createAttemptKey('CreateKey', logicalId)`. The retry resumes it -- its id
 * came back in our own response, so the attribution is exact -- instead of
 * minting a second key and orphaning this one. `inputDigest` binds it to the
 * `CreateKey` input that made it: a later create of the same logical id with
 * different inputs (a rollback replay of an older record) must not inherit it.
 */
const pendingKeys = new Map<
  string,
  { keyId: string; keyArn: string; inputDigest: string; heldAtMs: number }
>();

/** Key states a resumed key may be in. `PendingImport` is an `EXTERNAL`-origin key's normal state before material is imported. */
const RESUMABLE_KEY_STATES: ReadonlySet<string> = new Set(['Enabled', 'Disabled', 'PendingImport']);

/**
 * Most `DescribeKey` calls one orphan lookup makes. `ListKeys` carries no
 * creation date, so each candidate costs a call; the lookup runs only after an
 * AMBIGUOUS `CreateKey` failure, and says so when this cap cut it short.
 */
const MAX_ORPHAN_DESCRIBES = 200;

/** Page ceiling for the `ListKeys` sweep (1000 keys a page). */
const MAX_LIST_KEYS_PAGES = 20;

/** Most key ids one orphan report names. */
const MAX_REPORTED_ORPHANS = 5;

/** Reset the module-scoped retry-safety state. TEST-ONLY. */
export function resetKmsCreateRetryStateForTests(): void {
  createKeyLatch.resetForTests();
  keysCreatedByThisProcess.resetForTests();
  pendingKeys.clear();
}

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
  private client: KMSClient | undefined;
  private createClient: KMSClient | undefined;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('KMSProvider');

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

  private getClient(): KMSClient {
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
  private getCreateClient(): KMSClient {
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
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::KMS::Key':
        return this.createKey(logicalId, resourceType, properties);
      case 'AWS::KMS::Alias':
        return this.createAlias(logicalId, resourceType, properties);
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
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::KMS::Key':
        return this.updateKey(logicalId, physicalId, resourceType, properties, _previousProperties);
      case 'AWS::KMS::Alias':
        return this.updateAlias(logicalId, physicalId, resourceType, properties);
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

  private async createKey(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating KMS Key ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    const description = properties['Description'] as string | undefined;
    const keyPolicy = properties['KeyPolicy'];
    const keySpec = properties['KeySpec'] as string | undefined;
    const keyUsage = properties['KeyUsage'] as string | undefined;
    const enableKeyRotation = properties['EnableKeyRotation'] as boolean | undefined;
    const multiRegion = properties['MultiRegion'] as boolean | undefined;
    const origin = properties['Origin'] as string | undefined;
    const bypassPolicyLockoutSafetyCheck = properties['BypassPolicyLockoutSafetyCheck'] as
      | boolean
      | undefined;

    const input: CreateKeyCommandInput = {
      Description: description,
      KeySpec: keySpec as KeySpec,
      KeyUsage: keyUsage as KeyUsageType,
      Policy: keyPolicy
        ? typeof keyPolicy === 'string'
          ? keyPolicy
          : JSON.stringify(keyPolicy)
        : undefined,
      Tags:
        properties['Tags'] !== undefined && properties['Tags'] !== null
          ? tags.map((t) => ({ TagKey: t.Key, TagValue: t.Value }))
          : undefined,
      MultiRegion: multiRegion,
      Origin: origin as OriginType | undefined,
      BypassPolicyLockoutSafetyCheck: bypassPolicyLockoutSafetyCheck,
    };
    const attemptKey = createAttemptKey('CreateKey', logicalId);
    // A digest, not the input: the input carries the resolved key policy and
    // tags, which may hold secret-derived values, and this memo outlives the
    // create. It covers the follow-up switches too (rotation, `Enabled`): a
    // resumed key keeps whatever an earlier attempt applied, and the resume
    // path only ever turns rotation ON and the key OFF, so a later create
    // asking for less must not inherit it. The rotation PERIOD is left out on
    // purpose: a resume re-sends `EnableKeyRotation` with the current period.
    // Built from literals, so the key order is fixed.
    const inputDigest = createHash('sha256')
      .update(
        JSON.stringify({
          input,
          enableKeyRotation: enableKeyRotation === true,
          enabled: properties['Enabled'] !== false,
        })
      )
      .digest('hex');

    // Set once the key exists: a later failure is an auxiliary call's, not
    // this key's collision (#3826).
    let createdKeyId: string | undefined;
    try {
      const resumed = await this.resumeKeyFromFailedAttempt(logicalId, attemptKey, inputDigest);
      let keyId: string;
      let keyArn: string;
      if (resumed) {
        ({ keyId, keyArn } = resumed);
      } else {
        const orphanWindow = createKeyLatch.take(logicalId);
        if (orphanWindow !== undefined) {
          await this.reportPossibleOrphanKeys(logicalId, input, orphanWindow);
        }
        const attemptStartMs = Date.now();
        let result: CreateKeyCommandOutput;
        try {
          result = await this.getCreateClient().send(new CreateKeyCommand(input));
        } catch (error) {
          createKeyLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
          throw error;
        }
        keyId = result.KeyMetadata!.KeyId!;
        keyArn = result.KeyMetadata!.Arn!;
        // Remembered BEFORE the follow-up calls below, so a failure in any of
        // them hands the retry this key rather than a second CreateKey.
        setBounded(pendingKeys, attemptKey, { keyId, keyArn, inputDigest, heldAtMs: Date.now() });
      }

      createdKeyId = keyId;

      // EnableKeyRotation must be called separately after key creation
      if (enableKeyRotation) {
        const rotationPeriodInDays = properties['RotationPeriodInDays'] as number | undefined;
        this.logger.debug(`Enabling key rotation for KMS Key ${logicalId}`);
        await this.getClient().send(
          new EnableKeyRotationCommand({
            KeyId: keyId,
            ...(rotationPeriodInDays !== undefined && {
              RotationPeriodInDays: rotationPeriodInDays,
            }),
          })
        );
      }

      // Disable key if Enabled is explicitly false
      const enabled = properties['Enabled'] as boolean | undefined;
      if (enabled === false) {
        this.logger.debug(`Disabling KMS Key ${logicalId}`);
        await this.getClient().send(new DisableKeyCommand({ KeyId: keyId }));
      }

      this.logger.debug(`Successfully created KMS Key ${logicalId}: ${keyId}`);
      pendingKeys.delete(attemptKey);
      keysCreatedByThisProcess.add(keyId);

      return {
        physicalId: keyId,
        attributes: {
          Arn: keyArn,
          KeyId: keyId,
        },
      };
    } catch (error) {
      if (createdKeyId !== undefined) {
        markAuxiliaryFailure(error, logicalId);
        // The key stays remembered in `pendingKeys`, so the engine's retry of
        // this create resumes it rather than minting another. Said at warn
        // because if the retries run out, it is a live, billed key that no
        // cdkd state records.
        const aws = pasteableAwsCommand();
        const region = await this.regionArg(aws);
        this.logger.warn(
          safeMsg`KMS key ${createdKeyId} was created for ${logicalId}, but a follow-up call failed. A retry of this create reuses that key instead of creating another, so do not delete it while the deploy is still retrying. If the deploy then FAILS, its rollback journal records the key for \`cdkd rollback --revert-failed\` to schedule its deletion; otherwise schedule it yourself with: ${aws`aws kms schedule-key-deletion --key-id ${createdKeyId}${region} --pending-window-in-days 7`.render()}`
        );
      }
      const cause = error instanceof Error ? error : undefined;
      const thrown = new ProvisioningError(
        `Failed to create KMS Key ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
      // go-to-k/cdkd#4583: the key (this create's own, or one an earlier attempt
      // of it minted and this one resumed) is left behind; name it for the journal.
      if (createdKeyId !== undefined) {
        markCreatedBeforeFailure(thrown, logicalId, resourceType, createdKeyId);
      }
      throw thrown;
    }
  }

  /**
   * The ` --region <r>` fragment for a pasteable command, from the client that
   * made or listed the key (issue #4307): without it the command runs in the
   * user's shell-default region, where a describe answers NotFound and reads as
   * "no orphan". An unreadable region renders no fragment rather than failing
   * the warning. Built with the caller's `aws` tag, since a fragment from
   * another tag withholds the command.
   */
  private async regionArg(
    aws: ReturnType<typeof pasteableAwsCommand>
  ): Promise<ReturnType<ReturnType<typeof pasteableAwsCommand>>> {
    let region: string | undefined;
    try {
      region = await this.getClient().config.region();
    } catch {
      region = undefined;
    }
    return region ? aws` --region ${region}` : aws``;
  }

  /**
   * Hand back the key an earlier attempt at this create already made, when its
   * `CreateKey` succeeded and a follow-up call then failed (issue #2080).
   *
   * Without this the engine's retry re-ran `CreateKey` from the top: a
   * transient 5xx, a throttle or an IAM-propagation denial on
   * `EnableKeyRotation` minted a SECOND key and left the first live, billed and
   * in no state record. That was the likeliest duplicate in this provider,
   * since the follow-up calls fail in the ordinary, unambiguous way.
   *
   * Adoption is sound here where it is not after an ambiguous `CreateKey`
   * (see {@link KMSProvider.reportPossibleOrphanKeys}): the key id came back in
   * this process's own response, so there is nothing to infer. Three things
   * still gate it, each falling through to a fresh `CreateKey` with the old key
   * named at warn: the inputs must be the ones that made it, `DescribeKey` must
   * read it, and it must be in a usable state (a key somebody scheduled for
   * deletion meanwhile is not one to record). A TRANSIENT `DescribeKey` failure
   * instead rethrows with the key still remembered, so the engine's next retry
   * asks again rather than giving up on a key that is very likely fine.
   */
  private async resumeKeyFromFailedAttempt(
    logicalId: string,
    attemptKey: string,
    inputDigest: string
  ): Promise<{ keyId: string; keyArn: string } | undefined> {
    const pending = pendingKeys.get(attemptKey);
    if (!pending) return undefined;
    pendingKeys.delete(attemptKey);
    // Same age limit as the latch: a hold from a deploy that gave up long ago
    // in this process is not this create's retry.
    if (Date.now() - pending.heldAtMs > AMBIGUOUS_LATCH_TTL_MS) return undefined;
    const aws = pasteableAwsCommand();
    const region = await this.regionArg(aws);
    const deletion =
      aws`aws kms schedule-key-deletion --key-id ${pending.keyId}${region} --pending-window-in-days 7`.render();
    const notReused = (reason: string): undefined => {
      this.logger.warn(
        safeMsg`KMS key ${pending.keyId} was created for ${logicalId} by an earlier attempt of this deploy, but ${reason}, so this attempt creates a new key and that one is not recorded in cdkd state. If it is unused, schedule its deletion with: ${deletion}`
      );
      return undefined;
    };
    if (pending.inputDigest !== inputDigest) {
      return notReused('this attempt was asked for a key with different inputs');
    }
    let metadata: KeyMetadata | undefined;
    try {
      metadata = (await this.getClient().send(new DescribeKeyCommand({ KeyId: pending.keyId })))
        .KeyMetadata;
    } catch (error) {
      if (isTransientServerError(error) || isThrottlingError(error)) {
        setBounded(pendingKeys, attemptKey, pending);
        throw error;
      }
      const failure = describeAwsFailure(error);
      this.logger.debug(safeMsg`DescribeKey ${pending.keyId} failed with: ${failure.detail}`);
      return notReused(`reading it back failed (${failure.summary})`);
    }
    if (!metadata?.KeyState || !RESUMABLE_KEY_STATES.has(metadata.KeyState)) {
      return notReused(`it is ${metadata?.KeyState ?? 'in an unreadable state'}`);
    }
    setBounded(pendingKeys, attemptKey, pending);
    this.logger.debug(
      safeMsg`Reusing KMS key ${pending.keyId}, which an earlier attempt at ${logicalId} created before a follow-up call failed`
    );
    return { keyId: pending.keyId, keyArn: metadata.Arn ?? pending.keyArn };
  }

  /**
   * After a `CreateKey` whose outcome was AMBIGUOUS (in practice a 5xx, the
   * only ambiguous failure the engine retries -- AWS may have made the key
   * and lost the answer), name the keys
   * that could be its orphan. Detection only: this never adopts and never
   * deletes (issue #2080).
   *
   * Why not adopt: a KMS key has no name and `CreateKey` has no token, so the
   * only evidence is circumstantial -- a customer-managed key, created inside
   * the window, with the same spec, usage, origin, multi-Region flag and
   * description. Two `AWS::KMS::Key` resources with default settings in one
   * stack (or a concurrent deploy, or a console user) match each other
   * exactly, and binding the wrong one to this logical id means cdkd later
   * UPDATEs its policy and SCHEDULES ITS DELETION. An orphaned key costs a
   * monthly fee; a wrongly adopted one can cost the data it encrypts. The one
   * exact channel, tagging the key with a cdkd token on `CreateKey`, was
   * rejected: it would make `kms:TagResource` a requirement of EVERY key
   * create, collide with tag policies, and leave a cdkd tag on every key that
   * each read path then has to strip.
   *
   * Every failure here WARNS and returns: the lookup is a courtesy, and must
   * never be what fails a deploy.
   */
  private async reportPossibleOrphanKeys(
    logicalId: string,
    input: CreateKeyCommandInput,
    window: AmbiguousCreateWindow
  ): Promise<void> {
    const since = new Date(window.floorMs).toISOString();
    const until = new Date(window.ceilingMs).toISOString();
    const pendingIds = new Set([...pendingKeys.values()].map((entry) => entry.keyId));
    const ids: string[] = [];
    let listTruncated = false;
    try {
      let marker: string | undefined;
      let pages = 0;
      do {
        const page = await this.getClient().send(
          new ListKeysCommand({ Limit: 1000, ...(marker && { Marker: marker }) })
        );
        for (const key of page.Keys ?? []) {
          if (key.KeyId && !keysCreatedByThisProcess.has(key.KeyId) && !pendingIds.has(key.KeyId)) {
            ids.push(key.KeyId);
          }
        }
        marker = page.Truncated ? page.NextMarker : undefined;
        pages++;
      } while (marker && pages < MAX_LIST_KEYS_PAGES);
      listTruncated = marker !== undefined;
    } catch (error) {
      const failure = describeAwsFailure(error);
      this.logger.debug(safeMsg`ListKeys failed with: ${failure.detail}`);
      this.logger.warn(
        safeMsg`An earlier CreateKey attempt for ${logicalId} failed without a definite answer, so KMS may have created a key that no cdkd state records, and cdkd could not list keys to look for it (${failure.summary}). Check the account's customer managed keys created between ${since} and ${until}.`
      );
      return;
    }

    // `ListKeys` documents no order. Newest-LAST is what it has been seen to
    // return, so the tail is described first; nothing depends on that being
    // true, since a key the cap leaves out makes the report say it is
    // incomplete rather than claim there is none.
    const describable = ids.slice(-MAX_ORPHAN_DESCRIBES).reverse();
    let unreadable = 0;
    const candidates: string[] = [];
    const wanted = {
      keySpec: input.KeySpec ?? 'SYMMETRIC_DEFAULT',
      keyUsage: input.KeyUsage ?? 'ENCRYPT_DECRYPT',
      origin: input.Origin ?? 'AWS_KMS',
      multiRegion: input.MultiRegion === true,
      description: input.Description ?? '',
    };
    // Small batches: this runs on a deploy's critical path, and KMS's
    // DescribeKey quota is shared with every other caller in the account.
    for (let i = 0; i < describable.length; i += 10) {
      const batch = describable.slice(i, i + 10);
      const results = await Promise.all(
        batch.map(async (keyId) => {
          try {
            return (await this.getClient().send(new DescribeKeyCommand({ KeyId: keyId })))
              .KeyMetadata;
          } catch {
            unreadable++;
            return undefined;
          }
        })
      );
      for (const md of results) {
        if (
          md?.KeyId &&
          md.KeyManager === 'CUSTOMER' &&
          isInsideWindow(md.CreationDate, window) &&
          md.KeyState !== 'PendingDeletion' &&
          md.KeyState !== 'PendingReplicaDeletion' &&
          (md.KeySpec ?? 'SYMMETRIC_DEFAULT') === wanted.keySpec &&
          (md.KeyUsage ?? 'ENCRYPT_DECRYPT') === wanted.keyUsage &&
          (md.Origin ?? 'AWS_KMS') === wanted.origin &&
          (md.MultiRegion === true) === wanted.multiRegion &&
          (md.Description ?? '') === wanted.description
        ) {
          candidates.push(md.KeyId);
        }
      }
    }

    const gaps = [
      ...(listTruncated ? [`the key list was cut at ${MAX_LIST_KEYS_PAGES} pages`] : []),
      ...(ids.length > describable.length
        ? [
            `${ids.length - describable.length} key(s) were beyond its ${MAX_ORPHAN_DESCRIBES}-key limit`,
          ]
        : []),
      ...(unreadable > 0 ? [`${unreadable} could not be read`] : []),
    ];
    const incomplete = gaps.length > 0 ? ` The search was incomplete: ${gaps.join(', ')}.` : '';
    if (candidates.length === 0) {
      // Said only of what was LISTED: `ListKeys` is eventually consistent, so
      // a key made moments ago can be missing from it.
      const line = safeMsg`An earlier CreateKey attempt for ${logicalId} failed without a definite answer; no listed customer managed key matching it was created between ${since} and ${until}.${incomplete}`;
      if (incomplete) {
        this.logger.warn(line);
      } else {
        this.logger.debug(line);
      }
      return;
    }
    const aws = pasteableAwsCommand();
    const region = await this.regionArg(aws);
    const shown = candidates.slice(0, MAX_REPORTED_ORPHANS);
    // READ commands first. A candidate may be another stack's key with the
    // same settings, so a deletion command leading the line would hand the
    // user exactly the wrong-resource mistake cdkd declines to make itself.
    const inspect = shown
      .map((keyId) => aws`aws kms describe-key --key-id ${keyId}${region}`.render())
      .join(' ; ');
    const deletion = shown
      .map((keyId) =>
        aws`aws kms schedule-key-deletion --key-id ${keyId}${region} --pending-window-in-days 7`.render()
      )
      .join(' ; ');
    this.logger.warn(
      safeMsg`An earlier CreateKey attempt for ${logicalId} failed without a definite answer, and KMS may have created a key then that no cdkd state records. ${candidates.length} customer managed key(s) created between ${since} and ${until} match this key's settings: ${shown.join(', ')}${candidates.length > shown.length ? ', ...' : ''}. cdkd does not adopt or delete them, because a key has no name or token that ties it to ${logicalId} -- another key with the same settings is indistinguishable. Creating a new key now, so the orphan (if any) and the new key will both exist. First inspect each candidate: ${inspect}. Only after confirming a key is this deploy's orphan and no other deploy uses it, schedule its deletion: ${deletion}.${incomplete}`
    );
  }

  private async updateKey(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating KMS Key ${logicalId}: ${physicalId}`);
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

    try {
      // Update Description if changed
      const newDescription = properties['Description'] as string | undefined;
      const oldDescription = previousProperties['Description'] as string | undefined;
      if (newDescription !== oldDescription) {
        this.logger.debug(`Updating description for KMS Key ${logicalId}`);
        await this.getClient().send(
          new UpdateKeyDescriptionCommand({
            KeyId: physicalId,
            Description: newDescription ?? '',
          })
        );
      }

      // Update EnableKeyRotation if changed
      const newEnableKeyRotation = properties['EnableKeyRotation'] as boolean | undefined;
      const oldEnableKeyRotation = previousProperties['EnableKeyRotation'] as boolean | undefined;
      if (newEnableKeyRotation !== oldEnableKeyRotation) {
        if (newEnableKeyRotation) {
          const rotationPeriodInDays = properties['RotationPeriodInDays'] as number | undefined;
          this.logger.debug(`Enabling key rotation for KMS Key ${logicalId}`);
          await this.getClient().send(
            new EnableKeyRotationCommand({
              KeyId: physicalId,
              ...(rotationPeriodInDays !== undefined && {
                RotationPeriodInDays: rotationPeriodInDays,
              }),
            })
          );
        } else {
          this.logger.debug(`Disabling key rotation for KMS Key ${logicalId}`);
          await this.getClient().send(new DisableKeyRotationCommand({ KeyId: physicalId }));
        }
      }

      // Update Enabled if changed
      const newEnabled = properties['Enabled'] as boolean | undefined;
      const oldEnabled = previousProperties['Enabled'] as boolean | undefined;
      if (newEnabled !== oldEnabled) {
        if (newEnabled === false) {
          this.logger.debug(`Disabling KMS Key ${logicalId}`);
          await this.getClient().send(new DisableKeyCommand({ KeyId: physicalId }));
        } else {
          this.logger.debug(`Enabling KMS Key ${logicalId}`);
          await this.getClient().send(new EnableKeyCommand({ KeyId: physicalId }));
        }
      }

      // Apply tag diff. KMS's TagResource takes [{TagKey, TagValue}] (NOT
      // the standard [{Key, Value}] shape) keyed by KeyId; UntagResource
      // takes a TagKeys list. Use a proper diff so we don't churn unchanged
      // tags through Untag→Tag on every update.
      await this.applyTagDiff(
        physicalId,
        resourceType,
        logicalId,
        previousProperties['Tags'],
        properties['Tags']
      );

      // Update KeyPolicy if changed. Truthy gate (`&& newPolicyStr` below)
      // is intentional: KMS rejects `PutKeyPolicy` with an empty / missing
      // Policy ("KMS key policy must include the JSON statement..."), so
      // empty / undefined newKeyPolicy must NOT round-trip to AWS. With
      // `cdkd drift --revert` now flowing through this branch (KeyPolicy
      // is no longer in `getDriftUnknownPaths`), the gate also guards
      // against a transient `readCurrentState` permission blip producing
      // an undefined `newKeyPolicy` on the revert side and clobbering
      // the existing AWS-side policy.
      const newKeyPolicy = properties['KeyPolicy'];
      const oldKeyPolicy = previousProperties['KeyPolicy'];
      const newPolicyStr = newKeyPolicy
        ? typeof newKeyPolicy === 'string'
          ? newKeyPolicy
          : JSON.stringify(newKeyPolicy)
        : undefined;
      const oldPolicyStr = oldKeyPolicy
        ? typeof oldKeyPolicy === 'string'
          ? oldKeyPolicy
          : JSON.stringify(oldKeyPolicy)
        : undefined;
      if (newPolicyStr !== oldPolicyStr && newPolicyStr) {
        this.logger.debug(`Updating key policy for KMS Key ${logicalId}`);
        await this.getClient().send(
          new PutKeyPolicyCommand({
            KeyId: physicalId,
            PolicyName: 'default',
            Policy: newPolicyStr,
          })
        );
      }

      this.logger.debug(`Successfully updated KMS Key ${logicalId}`);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update KMS Key ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteKey(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Scheduling deletion for KMS Key ${logicalId}: ${physicalId}`);

    const pendingWindowInDays = (properties?.['PendingWindowInDays'] as number | undefined) ?? 7;

    try {
      await this.getClient().send(
        new ScheduleKeyDeletionCommand({
          KeyId: physicalId,
          PendingWindowInDays: pendingWindowInDays,
        })
      );
      this.logger.debug(`Successfully scheduled deletion for KMS Key ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`KMS Key ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to schedule deletion for KMS Key ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via KMS's
   * `TagResource` / `UntagResource` APIs. KMS uses `{TagKey, TagValue}`
   * (NOT the standard `{Key, Value}` shape) keyed by `KeyId`. Both sides are
   * read through `planTagDiff` (go-to-k/cdkd#3994): an unreadable record
   * untags nothing.
   */
  private async applyTagDiff(
    keyId: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown
  ): Promise<void> {
    const plan = planTagDiff(oldTagsRaw, newTagsRaw);
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      this.logger.warn(tagWarning);
    }
    const tagsToAdd = [...plan.set].map(([k, v]) => ({ TagKey: k, TagValue: v }));
    const tagsToRemove = plan.remove;

    if (tagsToRemove.length > 0) {
      await this.getClient().send(
        new UntagResourceCommand({ KeyId: keyId, TagKeys: tagsToRemove })
      );
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from KMS Key ${keyId}`);
    }
    if (tagsToAdd.length > 0) {
      await this.getClient().send(new TagResourceCommand({ KeyId: keyId, Tags: tagsToAdd }));
      this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on KMS Key ${keyId}`);
    }
  }

  // ─── AWS::KMS::Alias ───────────────────────────────────────────────

  private async createAlias(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating KMS Alias ${logicalId}`);

    const aliasName = properties['AliasName'] as string | undefined;
    if (!aliasName) {
      throw new ProvisioningError(
        `AliasName is required for KMS Alias ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const targetKeyId = properties['TargetKeyId'] as string | undefined;
    if (!targetKeyId) {
      throw new ProvisioningError(
        `TargetKeyId is required for KMS Alias ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      await this.getClient().send(
        new CreateAliasCommand({
          AliasName: aliasName,
          TargetKeyId: targetKeyId,
        })
      );

      this.logger.debug(`Successfully created KMS Alias ${logicalId}: ${aliasName}`);

      return {
        physicalId: aliasName,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create KMS Alias ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async updateAlias(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating KMS Alias ${logicalId}: ${physicalId}`);

    const targetKeyId = properties['TargetKeyId'] as string | undefined;
    if (!targetKeyId) {
      throw new ProvisioningError(
        `TargetKeyId is required for KMS Alias update ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      await this.getClient().send(
        new UpdateAliasCommand({
          AliasName: physicalId,
          TargetKeyId: targetKeyId,
        })
      );

      this.logger.debug(`Successfully updated KMS Alias ${logicalId}`);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update KMS Alias ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async deleteAlias(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting KMS Alias ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteAliasCommand({
          AliasName: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted KMS Alias ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`KMS Alias ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete KMS Alias ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
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

  private async readCurrentStateKey(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let resp: {
      KeyMetadata?: {
        KeyId?: string;
        Description?: string;
        KeySpec?: string;
        KeyUsage?: string;
        Enabled?: boolean;
        MultiRegion?: boolean;
        Origin?: string;
      };
    };
    try {
      resp = (await this.getClient().send(
        new DescribeKeyCommand({ KeyId: physicalId })
      )) as unknown as typeof resp;
    } catch (err) {
      if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
      throw err;
    }
    const md = resp.KeyMetadata;
    if (!md) return undefined;

    const result: Record<string, unknown> = {};
    result['Description'] = md.Description ?? '';
    if (md.KeySpec !== undefined) result['KeySpec'] = md.KeySpec;
    if (md.KeyUsage !== undefined) result['KeyUsage'] = md.KeyUsage;
    if (md.Enabled !== undefined) result['Enabled'] = md.Enabled;
    if (md.MultiRegion !== undefined) result['MultiRegion'] = md.MultiRegion;
    if (md.Origin !== undefined) result['Origin'] = md.Origin;

    if (md.KeyId) {
      // KeyPolicy via GetKeyPolicy. AWS returns the policy as a JSON
      // string; we re-parse so the comparator can match cdkd state's
      // already-resolved object form. KMS keys always have a policy
      // (minimum is the implicit root statement KMS injects on
      // CreateKey), so the empty-response branch is unreachable in
      // practice — we omit the key on a permission error rather than
      // emit `{}`, which would round-trip through update() as `'{}'`
      // and KMS would reject ("KMS key policy must include the JSON
      // statement..."), turning a transient permission blip into a
      // drift-detection false-positive cycle.
      try {
        const policyResp = await this.getClient().send(
          new GetKeyPolicyCommand({ KeyId: md.KeyId, PolicyName: 'default' })
        );
        if (policyResp.Policy) {
          try {
            result['KeyPolicy'] = JSON.parse(policyResp.Policy) as unknown;
          } catch {
            result['KeyPolicy'] = policyResp.Policy;
          }
        }
      } catch (err) {
        if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
        // Permission errors etc — leave key absent rather than firing
        // false drift on every run.
      }

      // EnableKeyRotation / RotationPeriodInDays via GetKeyRotationStatus.
      // Class 1 discriminator: only valid for SYMMETRIC_DEFAULT keys —
      // asymmetric keys reject GetKeyRotationStatus with
      // UnsupportedOperationException, so we gate the emit on KeySpec.
      // (CFn defaults KeySpec to SYMMETRIC_DEFAULT when omitted, so
      // undefined is treated as symmetric.)
      const isSymmetric = md.KeySpec === undefined || md.KeySpec === 'SYMMETRIC_DEFAULT';
      if (isSymmetric) {
        try {
          const rotationResp = await this.getClient().send(
            new GetKeyRotationStatusCommand({ KeyId: md.KeyId })
          );
          result['EnableKeyRotation'] = rotationResp.KeyRotationEnabled ?? false;
          if (rotationResp.RotationPeriodInDays !== undefined) {
            result['RotationPeriodInDays'] = rotationResp.RotationPeriodInDays;
          }
        } catch (err) {
          if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
          // UnsupportedOperationException (asymmetric edge cases AWS
          // changes over time) / AccessDenied — leave key absent.
        }
      }

      // Tags via ListResourceTags. AWS-managed keys (alias/aws/*) reject
      // ListResourceTags with AccessDenied — omit silently.
      try {
        const tagsResp = await this.getClient().send(
          new ListResourceTagsCommand({ KeyId: md.KeyId })
        );
        const tags = normalizeAwsTagsToCfn(tagsResp.Tags);
        result['Tags'] = tags;
      } catch (err) {
        if (err instanceof NotFoundException) return RESOURCE_NOT_FOUND;
        // Permission errors etc — leave key absent.
      }
    }
    return result;
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

  private async readCurrentStateAlias(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let marker: string | undefined;
    do {
      const list = await this.getClient().send(
        new ListAliasesCommand({ ...(marker && { Marker: marker }) })
      );
      const found = list.Aliases?.find(
        (a: { AliasName?: string | undefined }) => a.AliasName === physicalId
      );
      if (found) {
        const result: Record<string, unknown> = {};
        if (found.AliasName) result['AliasName'] = found.AliasName;
        if (found.TargetKeyId) result['TargetKeyId'] = found.TargetKeyId;
        return result;
      }
      marker = list.NextMarker;
    } while (marker);
    // Absent from every page: the alias is gone (go-to-k/cdkd#4283).
    return RESOURCE_NOT_FOUND;
  }

  /**
   * Adopt an existing KMS key or alias into cdkd state.
   *
   * KMS keys have no `Properties.KeyName` field — physical IDs are
   * AWS-generated UUIDs. So:
   *  - For `AWS::KMS::Key`: `--resource MyKey=<keyId>` is the only explicit
   *    path; there is no auto-lookup (a key reaching here without an explicit
   *    id or a CloudFormation-resolved physical id returns `null`).
   *  - For `AWS::KMS::Alias`: `Properties.AliasName` is explicit and reliable.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.resourceType === 'AWS::KMS::Alias') {
      const aliasName =
        input.knownPhysicalId ??
        (typeof input.properties?.['AliasName'] === 'string'
          ? input.properties['AliasName']
          : undefined);
      if (!aliasName) return null;
      try {
        // ListAliases doesn't support filtering by name; walk to verify.
        let marker: string | undefined;
        do {
          const list = await this.getClient().send(
            new ListAliasesCommand({ ...(marker && { Marker: marker }) })
          );
          const found = list.Aliases?.find(
            (a: { AliasName?: string | undefined }) => a.AliasName === aliasName
          );
          if (found) return { physicalId: aliasName, attributes: {} };
          marker = list.NextMarker;
        } while (marker);
        return null;
      } catch (err) {
        if (err instanceof NotFoundException) return null;
        throw err;
      }
    }

    // AWS::KMS::Key
    if (input.knownPhysicalId) {
      try {
        await this.getClient().send(new DescribeKeyCommand({ KeyId: input.knownPhysicalId }));
        return { physicalId: input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof NotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so that
    // tag never exists on a real resource and the walk could not match (issue
    // #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a key
    // reaching here needs an explicit `--resource` override.
    return null;
  }
}
