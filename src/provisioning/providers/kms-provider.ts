import { isDeepStrictEqual } from 'node:util';
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
  DisabledException,
  type CreateKeyCommandInput,
  type CreateKeyCommandOutput,
  type KeyMetadata,
  type KeyUsageType,
  type KeySpec,
  type OriginType,
} from '@aws-sdk/client-kms';
import { getLogger } from '../../utils/logger.js';
import {
  CdkdError,
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../tag-list.js';
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
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { withRemovalDefaults } from '../update-removal.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import {
  markAuxiliaryFailure,
  markCreatedBeforeFailure,
  markSupersedesEarlierCreate,
} from '../auxiliary-failure.js';
import { createHash } from 'node:crypto';
import {
  AMBIGUOUS_LATCH_TTL_MS,
  AmbiguousCreateLatch,
  RecentIdSet,
  ambiguousAttemptLead,
  createAttemptKey,
  isInsideWindow,
  replayedSendWindow,
  setBounded,
  withoutServerErrorRetries,
  type AmbiguousCreateWindow,
} from './ambiguous-create.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { safeMsg } from '../../utils/display-safe.js';
import {
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
  markRedactedCause,
  relayedNameCollision,
} from '../../deployment/retryable-errors.js';

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

/**
 * go-to-k/cdkd#4945: attempt keys whose held key a retry DECLINED (and named
 * in a warning). The next key `CreateKey` makes for that attempt key replaces
 * it, so its error is stamped `markSupersedesEarlierCreate` even when the
 * declining attempt's own `CreateKey` failed first. Consumed by that key, and
 * aged out like `pendingKeys` (`AMBIGUOUS_LATCH_TTL_MS`).
 */
const supersededAttempts = new Map<string, number>();

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
  supersededAttempts.clear();
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
  private wrapCaughtError(
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

  private async createKey(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating KMS Key ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    const description = properties['Description'] as string | undefined;
    const keyPolicy = properties['KeyPolicy'];
    const keySpec = properties['KeySpec'] as string | undefined;
    const keyUsage = properties['KeyUsage'] as string | undefined;
    const enableKeyRotation = templateBool(properties['EnableKeyRotation']);
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
          enabled: templateBool(properties['Enabled']) !== false,
        })
      )
      .digest('hex');

    // Set once the key exists: a later failure is an auxiliary call's, not
    // this key's collision (#3826).
    let createdKeyId: string | undefined;
    let supersededPending = false;
    try {
      const resumed = await this.resumeKeyFromFailedAttempt(logicalId, attemptKey, inputDigest);
      let keyId: string;
      let keyArn: string;
      if (resumed && resumed !== 'superseded') {
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
        // Before the lookup below, so a throw in it still marks the key created.
        createdKeyId = keyId;
        // go-to-k/cdkd#4945: this key replaces a held one a retry declined.
        // Same age limit as the held key it replaced.
        const declinedAtMs = supersededAttempts.get(attemptKey);
        supersededAttempts.delete(attemptKey);
        supersededPending =
          declinedAtMs !== undefined && Date.now() - declinedAtMs <= AMBIGUOUS_LATCH_TTL_MS;
        // Issue #4687: the SDK replayed this CreateKey, so an earlier attempt
        // may have made a key too. Report only; the held key above is excluded.
        const replayWindow = replayedSendWindow(result, attemptStartMs);
        if (replayWindow !== undefined) {
          await this.reportPossibleOrphanKeys(logicalId, input, replayWindow);
        }
      }

      createdKeyId = keyId;

      // EnableKeyRotation must be called separately after key creation
      if (enableKeyRotation === true) {
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
      const enabled = templateBool(properties['Enabled']);
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
          safeMsg`KMS key ${createdKeyId} was created for ${logicalId}, but a follow-up call failed. A retry of this create reuses that key instead of creating another, so do not delete it while the deploy is still retrying. If the deploy then FAILS (outside a rollback's re-create), its rollback journal records the key for \`cdkd rollback --revert-failed\` to schedule its deletion; otherwise schedule it yourself with: ${aws`aws kms schedule-key-deletion --key-id ${createdKeyId}${region} --pending-window-in-days 7`.render()}`
        );
      }
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create KMS Key ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            undefined,
            cause
          )
      );
      // go-to-k/cdkd#4583: the key (this create's own, or one an earlier attempt
      // of it minted and this one resumed) is left behind; name it for the journal.
      if (createdKeyId !== undefined) {
        markCreatedBeforeFailure(thrown, logicalId, resourceType, createdKeyId);
        // The retry resumes THIS key, so `withRetry` must not read it as a
        // second key minted over the one an earlier attempt marked.
        if (supersededPending) markSupersedesEarlierCreate(thrown);
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
  ): Promise<{ keyId: string; keyArn: string } | 'superseded' | undefined> {
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
    const notReused = (reason: string): 'superseded' => {
      this.logger.warn(
        safeMsg`KMS key ${pending.keyId} was created for ${logicalId} by an earlier attempt of this deploy, but ${reason}, so this attempt creates a new key and that one is not recorded in cdkd state. If it is unused, schedule its deletion with: ${deletion}`
      );
      setBounded(supersededAttempts, attemptKey, Date.now());
      return 'superseded';
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
   * and lost the answer) -- or one that succeeded only after the SDK replayed
   * it inside the same `send` (issue #4687) -- name the keys that could be
   * its orphan. Detection only: this never adopts and never deletes (issue
   * #2080).
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
    const lead = ambiguousAttemptLead('CreateKey', logicalId, window);
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
        safeMsg`${lead}, so KMS may have created a key that no cdkd state records, and cdkd could not list keys to look for it (${failure.summary}). Check the account's customer managed keys created between ${since} and ${until}.`
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
      const line = safeMsg`${lead}; no listed customer managed key matching it was created between ${since} and ${until}.${incomplete}`;
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
      safeMsg`${lead}, and KMS may have created a key then that no cdkd state records. ${candidates.length} customer managed key(s) created between ${since} and ${until} match this key's settings: ${shown.join(', ')}${candidates.length > shown.length ? ', ...' : ''}. cdkd does not adopt or delete them, because a key has no name or token that ties it to ${logicalId} -- another key with the same settings is indistinguishable. ${window.replayedInSend === true ? 'cdkd recorded the key the create returned, so the orphan (if any) and that key both exist.' : 'Creating a new key now, so the orphan (if any) and the new key will both exist.'} First inspect each candidate: ${inspect}. Only after confirming a key is this deploy's orphan and no other deploy uses it, schedule its deletion: ${deletion}.${incomplete}`
    );
  }

  private async updateKey(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context: UpdateContext | undefined
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating KMS Key ${logicalId}: ${physicalId}`);
    const mask = context?.maskSecrets;
    properties = withRemovalDefaults(
      this.removalDefaults,
      resourceType,
      properties,
      previousProperties,
      context
    );
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
    // go-to-k/cdkd#5299: a key's spec, usage, region scope and origin are
    // fixed at creation, and KMS has no call that changes them.
    const immutableChanged = changedImmutableKeyProperties(properties, previousProperties);
    if (
      immutableChanged.length > 0 &&
      !(await this.liveKeyMatches(physicalId, properties, immutableChanged, logicalId))
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        immutableKeySuggestion(immutableChanged)
      );
    }

    // Issue #1160, CloudFormation A/B (us-east-1, 2026-10-20), each removal
    // alone and beside another change: a removed Description is cleared, a
    // removed `Enabled: false` enables the key, and a removed
    // `EnableKeyRotation: true` turns rotation off -- the comparisons below
    // already do each. A removed RotationPeriodInDays arrives as the declared
    // 365 (`removalDefaults`); a removed KeyPolicy is handled at its call.
    // A string-typed boolean (a String parameter's Ref) reads as CloudFormation
    // reads it: 'false' is false.
    const newEnabled = templateBool(properties['Enabled']);
    const oldEnabled = templateBool(previousProperties['Enabled']);
    const enabledChange =
      newEnabled === oldEnabled ? undefined : newEnabled === false ? 'disable' : 'enable';

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

      // CloudFormation's order (issue #1160 A/Bs, issuecomment-6286212485 and
      // issuecomment-6287991009): EnableKey, rotation, DisableKey, then tags
      // and the key policy. KMS refuses a rotation call on a disabled key
      // (`DisabledException`), so the key is enabled first and disabled after
      // it; and a policy that denies `kms:DisableKey` is put only after the
      // disable, which CloudFormation accepts. A rotation change on a key that
      // stays disabled fails, as it does in CloudFormation.
      if (enabledChange === 'enable') {
        this.logger.debug(`Enabling KMS Key ${logicalId}`);
        await this.getClient().send(new EnableKeyCommand({ KeyId: physicalId }));
      }

      // Update rotation if EnableKeyRotation or, with rotation on, the period
      // changed. `EnableKeyRotation` on a key already rotating sets the new
      // period; without the period check a changed or removed
      // RotationPeriodInDays was never sent (issue #1160).
      const newEnableKeyRotation = templateBool(properties['EnableKeyRotation']);
      const oldEnableKeyRotation = templateBool(previousProperties['EnableKeyRotation']);
      const rotationPeriodInDays = properties['RotationPeriodInDays'] as number | undefined;
      if (newEnableKeyRotation === true) {
        if (
          newEnableKeyRotation !== oldEnableKeyRotation ||
          // An absent desired period is never a change: a removal arrives as
          // the injected 365, and `drift --revert` (whose previous side is a
          // readback holding the live period) has nothing to send.
          (rotationPeriodInDays !== undefined &&
            rotationPeriodInDays !== previousProperties['RotationPeriodInDays'])
        ) {
          this.logger.debug(`Enabling key rotation for KMS Key ${logicalId}`);
          await this.sendRotation(
            () =>
              this.getClient().send(
                new EnableKeyRotationCommand({
                  KeyId: physicalId,
                  ...(rotationPeriodInDays !== undefined && {
                    RotationPeriodInDays: rotationPeriodInDays,
                  }),
                })
              ),
            enabledChange === 'enable',
            resourceType,
            logicalId,
            physicalId
          );
        }
      } else if (newEnableKeyRotation !== oldEnableKeyRotation) {
        this.logger.debug(`Disabling key rotation for KMS Key ${logicalId}`);
        await this.sendRotation(
          () => this.getClient().send(new DisableKeyRotationCommand({ KeyId: physicalId })),
          enabledChange === 'enable',
          resourceType,
          logicalId,
          physicalId
        );
      }

      if (enabledChange === 'disable') {
        this.logger.debug(`Disabling KMS Key ${logicalId}`);
        await this.getClient().send(new DisableKeyCommand({ KeyId: physicalId }));
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
      // Issue #1160: a KeyPolicy REMOVED from the template is a reset, not an
      // empty policy -- CloudFormation puts the KMS default key policy back
      // (A/B, us-east-1, 2026-10-20, alone and beside another change), the
      // same policy `CreateKey` attaches when none is given. Removal is judged
      // template-vs-template (`removedProperties`), so `drift --revert`, whose
      // set is empty, never reaches it and the gate above still holds there.
      const policyRemoved =
        context?.removedProperties !== undefined
          ? context.removedProperties.has('KeyPolicy')
          : oldKeyPolicy !== undefined && newKeyPolicy === undefined;
      if (newPolicyStr !== oldPolicyStr && newPolicyStr) {
        this.logger.debug(`Updating key policy for KMS Key ${logicalId}`);
        await this.getClient().send(
          new PutKeyPolicyCommand({
            KeyId: physicalId,
            PolicyName: 'default',
            Policy: newPolicyStr,
            // go-to-k/cdkd#5299: `createKey` sends the declared bypass, so
            // the update does too; without it KMS refuses a policy the
            // template already told it to accept.
            ...(templateBool(properties['BypassPolicyLockoutSafetyCheck']) === true && {
              BypassPolicyLockoutSafetyCheck: true,
            }),
          })
        );
      } else if (policyRemoved && newKeyPolicy === undefined) {
        this.logger.debug(safeMsg`Resetting key policy for KMS Key ${logicalId} to the default`);
        await this.getClient().send(
          new PutKeyPolicyCommand({
            KeyId: physicalId,
            PolicyName: 'default',
            Policy: await this.defaultKeyPolicy(physicalId),
          })
        );
      }

      this.logger.debug(`Successfully updated KMS Key ${logicalId}`);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      // A cdkd-typed throw (the disabled-key refusal in `sendRotation`) is
      // already worded for the user.
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update KMS Key ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  /**
   * go-to-k/cdkd#5299: whether the live key already holds the desired value of
   * every property in `changed`. A cdkd before the fix recorded such a change
   * as deployed while the key kept the old value, so a template put back to
   * the live value differs from the record but not from the key: nothing to
   * send, and the update records the template. A failed read is "no", so the
   * refusal stands.
   */
  private async liveKeyMatches(
    physicalId: string,
    properties: Record<string, unknown>,
    changed: readonly string[],
    logicalId: string
  ): Promise<boolean> {
    let md: KeyMetadata | undefined;
    try {
      md = (await this.getClient().send(new DescribeKeyCommand({ KeyId: physicalId }))).KeyMetadata;
    } catch {
      return false;
    }
    if (!md) return false;
    const live = immutableKeyShape(md as unknown as Record<string, unknown>);
    const desired = immutableKeyShape(properties);
    const matches = changed.every((name) => isDeepStrictEqual(desired[name], live[name]));
    if (matches) {
      this.logger.debug(
        safeMsg`KMS Key ${logicalId}: the live key already holds the desired ${changed.join(', ')}; the record differed`
      );
    }
    return matches;
  }

  /**
   * A rotation call (`EnableKeyRotation` / `DisableKeyRotation`). KMS refuses
   * it on a disabled key, as CloudFormation's update does (issue #1160 A/B), so
   * that refusal is restated as what the template must change; it is final,
   * since a retry meets the same disabled key. Not when this update has just
   * enabled the key (`justEnabled`): there a DisabledException is KMS still
   * catching up with the EnableKey, so it goes to the caller's ordinary wrap
   * and the retry that heals it stays possible.
   */
  private async sendRotation(
    send: () => Promise<unknown>,
    justEnabled: boolean,
    resourceType: string,
    logicalId: string,
    physicalId: string
  ): Promise<void> {
    try {
      await send();
    } catch (error) {
      if (!(error instanceof DisabledException) || justEnabled) throw error;
      throw markNonRetryable(
        new ProvisioningError(
          safeMsg`Failed to update KMS Key ${logicalId}: the key is currently disabled in AWS, and KMS refuses a key rotation change on a disabled key (CloudFormation fails this update too). Enable the key first (declare Enabled: true, or enable it in AWS), or drop the rotation change from this update.`,
          resourceType,
          logicalId,
          physicalId,
          error
        )
      );
    }
  }

  /**
   * The KMS default key policy for `keyId`, as `CreateKey` attaches it when no
   * policy is given and as CloudFormation puts it back when KeyPolicy is
   * removed (issue #1160 A/B): `Id: key-default-1`, one statement allowing
   * `kms:*` to the key's account root. The partition and account come from
   * the key's own ARN, so a key in another partition or account gets its own.
   */
  private async defaultKeyPolicy(keyId: string): Promise<string> {
    const resp = await this.getClient().send(new DescribeKeyCommand({ KeyId: keyId }));
    const match = /^arn:([^:]+):kms:[^:]*:(\d{12}):key\//.exec(resp.KeyMetadata?.Arn ?? '');
    if (match === null) {
      throw new Error(
        'DescribeKey returned no key ARN, so the default key policy cannot name the account'
      );
    }
    return JSON.stringify({
      Version: '2012-10-17',
      Id: 'key-default-1',
      Statement: [
        {
          Sid: 'Enable IAM User Permissions',
          Effect: 'Allow',
          Principal: { AWS: `arn:${match[1]}:iam::${match[2]}:root` },
          Action: 'kms:*',
          Resource: '*',
        },
      ],
    });
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
      throw this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to schedule deletion for KMS Key ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
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
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined
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
      throw this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create KMS Alias ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            undefined,
            cause
          )
      );
    }
  }

  private async updateAlias(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    mask: ((text: string) => string) | undefined
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
      throw this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update KMS Alias ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
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
      throw this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete KMS Alias ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
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

/**
 * The properties KMS fixes when a key is created, each with the value an
 * absent one means. No KMS update call has a member for any of them.
 */
function immutableKeyShape(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    KeySpec: properties['KeySpec'] ?? 'SYMMETRIC_DEFAULT',
    KeyUsage: properties['KeyUsage'] ?? 'ENCRYPT_DECRYPT',
    MultiRegion: templateBool(properties['MultiRegion']) === true,
    Origin: properties['Origin'] ?? 'AWS_KMS',
  };
}

/**
 * go-to-k/cdkd#5299: the names among `KeySpec`, `KeyUsage`, `MultiRegion` and
 * `Origin` whose desired value differs from the previous one. Each side is
 * compared with its default filled in, so declaring or dropping a default
 * value is no change (CFn A/B, us-east-1, 2026-10-26: both complete).
 */
function changedImmutableKeyProperties(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): string[] {
  const desired = immutableKeyShape(properties);
  const previous = immutableKeyShape(previousProperties);
  return Object.keys(desired).filter((name) => !isDeepStrictEqual(desired[name], previous[name]));
}

/**
 * go-to-k/cdkd#5299: the refusal's suggestion for a change to a property KMS
 * fixes at creation. The schema lists no createOnly property, so the diff
 * routes such a change to `update()`, which used to send nothing and report
 * success while the live key kept the old value. CloudFormation fails the update instead of
 * replacing the key, whatever `UpdateReplacePolicy` says (CFn A/B, us-east-1,
 * 2026-10-26), so cdkd refuses too; `--replace` is the opt-in replacement, and
 * `AWS::KMS::Key` being stateful, it also takes `--force-stateful-recreation`
 * unless the old key is retained. Only property names are printed.
 */
function immutableKeySuggestion(changed: readonly string[]): string {
  const one = changed.length === 1;
  return `${changed.join(', ')} changed, and KMS fixes ${one ? 'it' : 'them'} when the key is created (CloudFormation fails this update too). To keep the key, restore the previous ${one ? 'value' : 'values'}. To replace it, re-deploy with --replace, plus --force-stateful-recreation unless the key's UpdateReplacePolicy is Retain; without Retain the old key is scheduled for deletion, and data encrypted under it cannot be decrypted once that deletion completes`;
}

/**
 * A template boolean as CloudFormation reads it: `true` / `'true'` is true,
 * `false` / `'false'` is false (a String parameter's Ref arrives as a
 * string), absent stays absent. Anything else is truthiness, as before.
 */
function templateBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return Boolean(value);
}
