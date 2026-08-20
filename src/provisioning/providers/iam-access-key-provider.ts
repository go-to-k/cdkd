import {
  IAMClient,
  CreateAccessKeyCommand,
  UpdateAccessKeyCommand,
  DeleteAccessKeyCommand,
  ListAccessKeysCommand,
  GetAccessKeyLastUsedCommand,
  NoSuchEntityException,
  type StatusType,
} from '@aws-sdk/client-iam';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { replayWarn, requireConfigString } from '../config-shape.js';
import type { CreateContext } from '../../types/resource.js';

import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * How far before an attempt's start a key's `CreateDate` may fall and still be
 * treated as minted by that attempt (issue #2039).
 *
 * IAM stamps `CreateDate` from its own clock while the floor comes from ours,
 * so some tolerance is needed or ordinary skew disarms the check entirely. It
 * is deliberately small: every millisecond of it is a millisecond in which a
 * key created by something else becomes deletable.
 */
const CREATE_DATE_SKEW_MARGIN_MS = 5_000;

/**
 * AWS IAM AccessKey Provider (issue #1323)
 *
 * Implements resource provisioning for AWS::IAM::AccessKey using the IAM SDK.
 * The type is NON_PROVISIONABLE in the CloudFormation registry (no Cloud
 * Control handlers), so without this provider cdkd's pre-flight rejects any
 * template that declares it — including the documented CDK pattern for CI
 * credentials (`iam.AccessKey` + piping `secretAccessKey` into a Secrets
 * Manager secret).
 *
 * `SecretAccessKey` is a CREATE-TIME-ONLY attribute: `CreateAccessKey` is the
 * only API call that ever returns the secret, and there is no read-back. The
 * provider therefore captures it from the create response into the returned
 * `attributes`, exactly like CloudFormation does — `Fn::GetAtt` resolution
 * reads the cached value from cdkd state. This means the secret is persisted
 * in the S3 state file; that is the same trust boundary as the rest of cdkd
 * state (and CloudFormation likewise embeds the resolved value into whatever
 * resource consumed the `Fn::GetAtt`). `update()` deliberately omits
 * `attributes` so the create-time secret is preserved in state (a partial
 * attribute set would REPLACE the stored attributes, not merge).
 *
 * `Serial` is a replacement trigger with no API counterpart: the registry
 * schema marks it createOnly, so the diff layer classifies any change as a
 * REPLACEMENT (a new key is minted); the integer itself is never sent to IAM
 * (see the `handledProperties` note for why it is still declared handled).
 */
export class IAMAccessKeyProvider implements ResourceProvider {
  private iamClient: IAMClient;
  private logger = getLogger().child('IAMAccessKeyProvider');

  /**
   * NON_PROVISIONABLE type: Cloud Control has no handlers for it, so the
   * #614 unhandled-property auto-route must never send an AccessKey
   * template to the CC path (it would fail at deploy time with no handler).
   */
  readonly disableCcApiFallback = true;

  /**
   * `Serial` is listed as HANDLED even though it is never sent to IAM: its
   * entire CloudFormation semantic is "changing it forces a new key", which
   * the diff layer implements via the registry-schema createOnly
   * classification. Declaring it `unhandledByDesign` instead would put it in
   * the silent-drop set, and on a NON_PROVISIONABLE type with
   * `disableCcApiFallback` the #614 auto-route viability guard turns every
   * silent drop into a pre-flight HARD REJECT — wrongly refusing any
   * template that uses `serial`.
   */
  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::IAM::AccessKey', new Set(['UserName', 'Serial', 'Status'])],
  ]);

  /**
   * Serializes create attempts per IAM user, in this process (issue
   * [#2039](https://github.com/go-to-k/cdkd/issues/2039)).
   *
   * The orphan reconcile below identifies "a key that appeared since my
   * baseline". With two `AWS::IAM::AccessKey` resources on ONE user — the
   * ordinary two-key rotation shape — the deploy engine dispatches both
   * concurrently at the default `--concurrency 10`, and a key the SIBLING
   * legitimately created lands inside that window and matches the same
   * description. Deleting it destroys a live credential that is already in
   * cdkd state and may already be piped into a downstream Secrets Manager
   * secret via `Fn::GetAtt`, and `readCurrentState` returns `undefined` for a
   * deleted key, so `cdkd drift` reports UNKNOWN rather than drift and the
   * loss is invisible. That is strictly worse than the untracked-but-alive
   * credential this whole mechanism exists to prevent.
   *
   * This lock removes that race rather than narrowing it: the baseline read,
   * the create attempt, and the reconcile all happen under it, so no sibling
   * create on the same user can interleave with them.
   */
  private readonly userCreateLocks = new Map<string, Promise<void>>();

  /**
   * Access key ids THIS process created successfully.
   *
   * The complement of the baseline: a baseline can only say "this key is
   * newer than my snapshot", which is true both of the orphan left by my own
   * failed attempt AND of a key someone else minted in the same window. This
   * set names the keys cdkd itself owns and has already recorded, so they are
   * never deletable however the timing falls — including the case the lock
   * cannot cover, a second `cdkd` process sharing the user.
   */
  private readonly accessKeyIdsCreatedByThisProcess = new Set<string>();

  constructor() {
    const awsClients = getAwsClients();
    this.iamClient = awsClients.iam;
  }

  /**
   * Create an IAM access key via `CreateAccessKey`.
   *
   * `Status: Inactive` is applied with a follow-up `UpdateAccessKey` (the
   * create API always mints Active keys). If that follow-up fails, the
   * just-created key is deleted before rethrowing — otherwise the key would
   * exist on AWS without a cdkd state record, and the next deploy's re-CREATE
   * would burn the user's 2-keys-per-user quota.
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating IAM access key ${logicalId}`);

    const userName = properties['UserName'] as string | undefined;
    if (!userName) {
      throw new ProvisioningError(
        `AccessKey ${logicalId} requires UserName`,
        resourceType,
        logicalId
      );
    }
    const status = requireConfigString(
      properties['Status'],
      'Active',
      'AWS::IAM::AccessKey Status',
      replayWarn(this.logger, context)
    );

    return this.withUserCreateLock(userName, () =>
      this.createAccessKeyUnderUserLock(logicalId, resourceType, userName, status)
    );
  }

  /**
   * The body of {@link IAMAccessKeyProvider.create}, running with this user's
   * create lock held so the baseline, the create, and the reconcile are atomic
   * against any sibling create on the same user.
   */
  private async createAccessKeyUnderUserLock(
    logicalId: string,
    resourceType: string,
    userName: string,
    status: string
  ): Promise<ResourceCreateResult> {
    // The baseline is taken per ATTEMPT, immediately before the create, and is
    // consumed by the reconcile in this same attempt's catch. It deliberately
    // does NOT survive into the next attempt: a snapshot that spans the whole
    // retry schedule describes a window many seconds wide, and everything that
    // appears in it looks equally like my orphan.
    const attemptStartMs = Date.now() - CREATE_DATE_SKEW_MARGIN_MS;
    const baseline = await this.tryListAccessKeyIds(userName, logicalId);

    try {
      const response = await this.iamClient.send(
        new CreateAccessKeyCommand({ UserName: userName })
      );

      const accessKeyId = response.AccessKey?.AccessKeyId;
      const secretAccessKey = response.AccessKey?.SecretAccessKey;
      if (!accessKeyId || !secretAccessKey) {
        // A partial response with an AccessKeyId means a real key WAS minted —
        // clean it up best-effort before failing, or the retry / next deploy
        // hits the 2-keys-per-user quota with a key cdkd never recorded.
        if (accessKeyId) {
          try {
            await this.iamClient.send(
              new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: accessKeyId })
            );
          } catch (cleanupError) {
            this.logger.warn(
              `Failed to clean up IAM access key ${logicalId} (${accessKeyId}) minted by a partial CreateAccessKey response: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required: aws iam delete-access-key --user-name ${userName} --access-key-id ${accessKeyId}`
            );
          }
        }
        throw new Error('CreateAccessKey returned no AccessKeyId/SecretAccessKey');
      }

      if (status === 'Inactive') {
        try {
          await this.iamClient.send(
            new UpdateAccessKeyCommand({
              UserName: userName,
              AccessKeyId: accessKeyId,
              Status: 'Inactive' as StatusType,
            })
          );
        } catch (innerError) {
          try {
            await this.iamClient.send(
              new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: accessKeyId })
            );
            this.logger.debug(
              `Cleaned up partially-created IAM access key ${logicalId} (${accessKeyId}) after status wiring failure`
            );
          } catch (cleanupError) {
            this.logger.warn(
              `Failed to clean up partially-created IAM access key ${logicalId} (${accessKeyId}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required before the next deploy: aws iam delete-access-key --user-name ${userName} --access-key-id ${accessKeyId}`
            );
          }
          throw innerError;
        }
      }

      this.logger.debug(`Successfully created IAM access key ${logicalId}: ${accessKeyId}`);

      // Recorded before returning: from here on this key is cdkd's, and no
      // reconcile — this resource's or a sibling's — may delete it.
      this.accessKeyIdsCreatedByThisProcess.add(accessKeyId);

      return {
        physicalId: accessKeyId,
        attributes: {
          // Create-time-only: CreateAccessKey is the ONLY source of the
          // secret. Cached here so `Fn::GetAtt [<key>, SecretAccessKey]`
          // resolves from state, like CloudFormation.
          SecretAccessKey: secretAccessKey,
          // Registry-schema read-only primaryIdentifier.
          Id: accessKeyId,
        },
      };
    } catch (error) {
      // Still under the user lock: whatever appeared since `baseline` did so
      // during THIS attempt, and no sibling create could have run inside it.
      await this.deleteOrphanFromFailedAttempt(userName, logicalId, baseline, attemptStartMs);
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create IAM access key ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Run `fn` with this IAM user's create lock held.
   *
   * Queue rather than mutual exclusion: each caller waits on its predecessor
   * and publishes its own completion for the next one, so N concurrent creates
   * on one user run strictly in arrival order. The stored promise only ever
   * RESOLVES (the release is in a `finally`), so one create failing cannot
   * wedge the queue behind it.
   *
   * Process-scoped, like every other guard here. A second `cdkd` process on the
   * same user is out of its reach, which is why
   * {@link IAMAccessKeyProvider.accessKeyIdsCreatedByThisProcess} and the
   * `CreateDate` floor exist as well.
   */
  private async withUserCreateLock<T>(userName: string, fn: () => Promise<T>): Promise<T> {
    const predecessor = this.userCreateLocks.get(userName) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.userCreateLocks.set(
      userName,
      predecessor.then(() => held)
    );
    await predecessor;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Delete the access key THIS attempt minted before losing its response
   * (issue [#2039](https://github.com/go-to-k/cdkd/issues/2039)).
   *
   * ## Why a reconcile rather than a token or an opt-out
   *
   * `CreateAccessKey` has no `ClientToken` / `ClientRequestToken` member, so
   * there is nothing to make the call itself idempotent. The other candidate
   * was `disableOuterRetry`, and it costs too much here: it would make the
   * provider single-shot for EVERY transient error, including the IAM
   * propagation window between a sibling `AWS::IAM::User` being created and
   * being visible to `CreateAccessKey`.
   *
   * The orphan cannot be ADOPTED — its secret was returned once, in the
   * response that was lost — so deleting it is the only remedy available.
   *
   * ## Three independent conditions, because deleting the wrong key is worse
   * than leaving an orphan
   *
   * A key is deleted only when ALL of these hold:
   *
   *  1. It is absent from the baseline taken moments earlier, under the lock.
   *  2. Its `CreateDate` is at or after this attempt started. IAM stamps that
   *     date from ITS clock and the floor comes from ours, so a margin absorbs
   *     ordinary skew; the residual risk is bounded by the length of ONE
   *     `CreateAccessKey` call rather than by the retry schedule.
   *  3. cdkd did not create it successfully in this process. This is the one
   *     the baseline structurally cannot express — "newer than my snapshot" is
   *     equally true of my orphan and of somebody else's key.
   *
   * Anything that fails 2 or 3 is reported and LEFT ALONE. That is the safe
   * direction: an untracked key costs a quota slot and a manual cleanup, while
   * a wrongly deleted one destroys a live credential that cdkd state still
   * advertises — and because `readCurrentState` returns `undefined` for a
   * deleted key, `cdkd drift` would report UNKNOWN rather than drift, so the
   * loss would not even be visible.
   *
   * @param baseline `undefined` when the pre-create read failed, which disarms
   * the reconcile entirely — see {@link IAMAccessKeyProvider.tryListAccessKeyIds}.
   */
  private async deleteOrphanFromFailedAttempt(
    userName: string,
    logicalId: string,
    baseline: ReadonlySet<string> | undefined,
    attemptStartMs: number
  ): Promise<void> {
    if (baseline === undefined) {
      return;
    }
    const current = await this.tryListAccessKeyMetadata(userName, logicalId);
    if (!current) {
      return;
    }
    for (const key of current) {
      const accessKeyId = key.accessKeyId;
      if (baseline.has(accessKeyId) || this.accessKeyIdsCreatedByThisProcess.has(accessKeyId)) {
        continue;
      }
      if (key.createDateMs === undefined || key.createDateMs < attemptStartMs) {
        // Newer than the baseline but not attributable to this attempt. Say
        // exactly that -- claiming it as "created by an earlier attempt at
        // <logicalId>" would assert an attribution nothing here established.
        this.logger.warn(
          `IAM access key ${accessKeyId} appeared on user ${userName} while creating ${logicalId}, but cdkd cannot attribute it to this attempt (created ${key.createDateMs === undefined ? 'at an unknown time' : new Date(key.createDateMs).toISOString()}, attempt started ${new Date(attemptStartMs).toISOString()}). Leaving it in place. If it is an orphan of a failed cdkd deploy, delete it with: aws iam delete-access-key --user-name ${userName} --access-key-id ${accessKeyId}`
        );
        continue;
      }
      this.logger.warn(
        `IAM access key ${accessKeyId} was minted on user ${userName} by this failed attempt at ${logicalId} and its secret was lost with the response, so it is unusable and unrecorded; deleting it before the retry`
      );
      try {
        await this.iamClient.send(
          new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: accessKeyId })
        );
      } catch (error) {
        this.logger.warn(
          `Failed to delete the orphaned IAM access key ${accessKeyId} for user ${userName}: ${error instanceof Error ? error.message : String(error)}. Manual deletion may be required: aws iam delete-access-key --user-name ${userName} --access-key-id ${accessKeyId}`
        );
      }
    }
  }

  /**
   * The user's current access key ids, or `undefined` when the read failed.
   *
   * `undefined` disarms the reconcile rather than failing the create: a missing
   * `iam:ListAccessKeys` permission must not turn a working deploy into a
   * broken one over a safety net.
   */
  private async tryListAccessKeyIds(
    userName: string,
    logicalId: string
  ): Promise<ReadonlySet<string> | undefined> {
    const metadata = await this.tryListAccessKeyMetadata(userName, logicalId);
    return metadata && new Set(metadata.map((key) => key.accessKeyId));
  }

  /** `ListAccessKeys` with its `CreateDate`s, or `undefined` when the read failed. */
  private async tryListAccessKeyMetadata(
    userName: string,
    logicalId: string
  ): Promise<{ accessKeyId: string; createDateMs: number | undefined }[] | undefined> {
    const keys: { accessKeyId: string; createDateMs: number | undefined }[] = [];
    let marker: string | undefined;
    try {
      do {
        const page = await this.iamClient.send(
          new ListAccessKeysCommand({ UserName: userName, ...(marker && { Marker: marker }) })
        );
        for (const key of page.AccessKeyMetadata ?? []) {
          if (key.AccessKeyId) {
            keys.push({
              accessKeyId: key.AccessKeyId,
              createDateMs: key.CreateDate ? key.CreateDate.getTime() : undefined,
            });
          }
        }
        marker = page.IsTruncated ? page.Marker : undefined;
      } while (marker);
    } catch (error) {
      // WARN, not debug (issue #2018's rule: a guard that gives up must say so
      // at default verbosity). Disarming this reconcile means a retried create
      // can leave an ACTIVE, untracked credential behind, which is exactly the
      // outcome a silent line would hide.
      this.logger.warn(
        `Could not list existing access keys for user ${userName} while creating ${logicalId}: ${error instanceof Error ? error.message : String(error)}. Orphan detection is DISABLED for this create, so a retried attempt may leave an unusable but ACTIVE access key on the user. Grant iam:ListAccessKeys, or check the user's keys after the deploy: aws iam list-access-keys --user-name ${userName}`
      );
      return undefined;
    }
    return keys;
  }

  /**
   * Update an IAM access key.
   *
   * `UserName` / `Serial` are createOnly (replacement — this method never
   * sees them change), so the only in-place change is `Status`. A template
   * that REMOVES `Status` resets to the CFn default `Active` (absent-field
   * removal semantics), so the desired status is always sent explicitly.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating IAM access key ${logicalId}: ${physicalId}`);

    const userName = properties['UserName'] as string | undefined;
    // WARN, not throw: a rollback replays through `update()` with a historical
    // cdkd STATE record as the desired bag, so refusing here could leave a
    // resource un-rollbackable with no template-side remedy (issue #1513).
    //
    // The warn fallback is the PREVIOUS status, not the CFn default `Active`.
    // Defaulting to `Active` on an unusable value would ENABLE a credential the
    // template did not ask to enable — the opposite-of-declared-intent
    // substitution this whole guard exists to prevent, and a security-relevant
    // one. Leaving the key as it is, loudly, is the conservative answer; the
    // create path still refuses outright, where nothing exists to preserve.
    // (`previousProperties` is only a FALLBACK here — the desired side is still
    // the sole guarded value, per the desired-side-only rule.)
    // An ABSENT Status keeps resetting to the CFn default `Active` — that is
    // absent-field removal semantics, documented above and asserted by an
    // existing test. The previous-status fallback applies ONLY to a
    // present-but-unusable value, so the two cases are split rather than folded
    // into one `fallback` argument (the helper cannot tell them apart).
    // Gated to the ENUM, not merely to a non-blank string: the previous side is
    // a STATE record, so it can itself carry `'inactive'` / `'Deleted'` / a
    // stray-whitespace value. Passing that through would send AWS a
    // ValidationException on the very replay path this fallback exists to keep
    // alive — the old code always sent a valid `Active`.
    const previousStatus = previousProperties['Status'] === 'Inactive' ? 'Inactive' : 'Active';
    const status = (
      properties['Status'] === undefined
        ? 'Active'
        : requireConfigString(properties['Status'], previousStatus, 'AWS::IAM::AccessKey Status', {
            onUnusable: (message) => this.logger.warn(message),
          })
    ) as StatusType;

    try {
      await this.iamClient.send(
        new UpdateAccessKeyCommand({
          UserName: userName,
          AccessKeyId: physicalId,
          Status: status,
        })
      );

      this.logger.debug(`Successfully updated IAM access key ${logicalId}`);

      // No `attributes`: the create-time SecretAccessKey cached in state must
      // survive (a partial attribute set would replace, not merge).
      return {
        physicalId,
        wasReplaced: false,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update IAM access key ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an IAM access key via `DeleteAccessKey`.
   *
   * `UserName` comes from the state-recorded properties; when absent (e.g. a
   * hand-edited state record), it is recovered via `GetAccessKeyLastUsed`,
   * which resolves the owning user from the key id alone.
   * `NoSuchEntityException` is treated as idempotent success (after the
   * shared region check).
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting IAM access key ${logicalId}: ${physicalId}`);

    try {
      let userName = properties?.['UserName'] as string | undefined;
      if (!userName) {
        const lastUsed = await this.iamClient.send(
          new GetAccessKeyLastUsedCommand({ AccessKeyId: physicalId })
        );
        userName = lastUsed.UserName;
      }
      if (!userName) {
        // Never send DeleteAccessKey without UserName — IAM would resolve it
        // against the CALLING identity's own keys, not this resource.
        throw new Error(`cannot resolve the owning user for access key ${physicalId}`);
      }

      await this.iamClient.send(
        new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: physicalId })
      );

      this.logger.debug(`Successfully deleted IAM access key ${logicalId}`);
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        const clientRegion = await this.iamClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Access key ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete IAM access key ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Resolve a `Fn::GetAtt` attribute.
   *
   * `Id` is the physical id. `SecretAccessKey` can NEVER be re-fetched from
   * AWS (create-time-only) — deploy-time resolution reads it from the cached
   * state attributes and never reaches this method; a live fetch (e.g.
   * `cdkd orphan` reference rewriting on a state record missing the cached
   * value) fails with an explicit error instead of a silent wrong answer.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- Id is local; SecretAccessKey is unreadable by design
  async getAttribute(
    physicalId: string,
    resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id') return physicalId;
    if (attributeName === 'SecretAccessKey') {
      throw new ProvisioningError(
        `SecretAccessKey for ${physicalId} cannot be read back from AWS — IAM returns it only from CreateAccessKey. ` +
          `cdkd resolves it from the attributes cached in state at create time; this record has no cached value.`,
        resourceType,
        physicalId
      );
    }
    throw new ProvisioningError(
      `Unknown attribute ${attributeName} for ${resourceType} (only 'Id' and 'SecretAccessKey' are defined)`,
      resourceType,
      physicalId
    );
  }

  /**
   * Read the AWS-current access key configuration in CFn-property shape.
   *
   * Resolves the owning user via `GetAccessKeyLastUsed(AccessKeyId)`, then
   * finds the key's `Status` in `ListAccessKeys(UserName)`. Returns
   * `undefined` when the key is gone.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let userName: string | undefined;
    try {
      const lastUsed = await this.iamClient.send(
        new GetAccessKeyLastUsedCommand({ AccessKeyId: physicalId })
      );
      userName = lastUsed.UserName;
    } catch (err) {
      if (err instanceof NoSuchEntityException) return undefined;
      throw err;
    }
    if (!userName) return undefined;

    let marker: string | undefined;
    do {
      let page;
      try {
        page = await this.iamClient.send(
          new ListAccessKeysCommand({ UserName: userName, ...(marker && { Marker: marker }) })
        );
      } catch (err) {
        if (err instanceof NoSuchEntityException) return undefined;
        throw err;
      }
      for (const key of page.AccessKeyMetadata ?? []) {
        if (key.AccessKeyId === physicalId) {
          const result: Record<string, unknown> = { UserName: userName };
          if (key.Status !== undefined) result['Status'] = key.Status;
          return result;
        }
      }
      marker = page.IsTruncated ? page.Marker : undefined;
    } while (marker);
    return undefined;
  }

  /**
   * `Serial` has no read API (it is a template-side replacement trigger, never
   * stored by IAM), so it can never be verified against AWS.
   */
  getDriftUnknownPaths(resourceType: string): string[] {
    if (resourceType === 'AWS::IAM::AccessKey') return ['Serial'];
    return [];
  }

  /**
   * Adopt an existing IAM access key into cdkd state.
   *
   * **Explicit override only** (`--resource <logicalId>=<AccessKeyId>`): the
   * template carries no property equal to the key id, and IAM access keys
   * support no tags. The override is verified via `GetAccessKeyLastUsed`.
   *
   * The imported record has NO cached `SecretAccessKey` (IAM never returns it
   * again), so `Fn::GetAtt [<key>, SecretAccessKey]` cannot resolve for an
   * imported key — mint a new key via replacement if the secret is needed.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (!input.knownPhysicalId) return null;
    try {
      await this.iamClient.send(
        new GetAccessKeyLastUsedCommand({ AccessKeyId: input.knownPhysicalId })
      );
      return {
        physicalId: input.knownPhysicalId,
        attributes: { Id: input.knownPhysicalId },
      };
    } catch (err) {
      if (err instanceof NoSuchEntityException) return null;
      throw err;
    }
  }
}
