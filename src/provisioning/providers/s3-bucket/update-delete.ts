/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { ABAC_DISABLED, ABAC_ENABLED, abacStatusOf, metadataBag } from './metadata.js';
import {
  BUCKET_LIST_IDENTITY_ATTEMPTS,
  BUCKET_LIST_IDENTITY_BUDGET_MS,
  BUCKET_LIST_IDENTITY_DELAY_MS,
  BucketNotEmptyRefusal,
  FAILED_CREATE_ORPHAN_NOT_EMPTY_SKIP_REASON,
  isCreateTagResourceDenial,
  isPlainBucketName,
  noRecordedRegionCause,
  untaggedExplicitDeny,
} from './create-identity.js';
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  NoSuchBucket,
} from '@aws-sdk/client-s3';
import { type DeleteContext, assertRegionMatch } from '../../region-check.js';
import { LISTING_ENCODING_TYPE, decodeListingKey } from '../../../utils/s3-listing-keys.js';
import {
  type MaskerFn,
  createMaskedLogSinks,
  maskerOrIdentity,
  withDerivedNameMasks,
} from '../../masked-retry-logger.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import {
  RESOURCE_NOT_FOUND,
  type ResourceDeleteResult,
  type ResourceIdentityVerdict,
  type ResourceImportInput,
  type ResourceImportResult,
  type ResourceNotFound,
  type ResourceUpdateResult,
  type UpdateContext,
} from '../../../types/resource.js';
import { S3BucketProvider } from '../s3-bucket-provider.js';
import { S3_AUTO_DELETE_OBJECTS_TAG, hasCdkAutoDeleteTag } from '../../data-delete-intent.js';
import {
  canonicalizeBlock,
  canonicalizeItemList,
  effectiveLifecycleConfiguration,
} from './lifecycle-fold.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import { declaresBucketObjectLock, declaresNestedObjectLock } from './shared.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { displaySafe, safeMsg } from '../../../utils/display-safe.js';
import {
  effectiveAnalyticsItem,
  effectiveIntelligentTieringItem,
  effectiveInventoryItem,
  effectiveNotificationConfiguration,
} from './effective-items.js';
import {
  explicitDenyPolicyKind,
  isExplicitDenyError,
  markRedactedCause,
  relayedNameCollision,
} from '../../../deployment/retryable-errors.js';
import { generatedNameFor } from '../../resource-name.js';
import { isAuxiliaryFailure } from '../../auxiliary-failure.js';
import { markNotGone } from '../../not-gone.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { resolveExplicitPhysicalId } from '../../import-helpers.js';

/**
 * Update an S3 bucket
 */
export async function update(
  this: S3BucketProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // Issue #2177 -- see `create()`. The recorded name is ALSO a needle when the
  // PREVIOUS `BucketName` it came from is secret-derived: after a rotated or
  // re-pointed secret, that previous value is the `{{resolve:` reference
  // state holds, and the OLD plaintext is in no masker bag of this deploy.
  if (this.opMask === undefined) {
    const sinks = withDerivedNameMasks(
      this.logger,
      createMaskedLogSinks(this.logger, context?.maskSecrets),
      [
        [previousProperties['BucketName'], physicalId],
        [previousProperties['BucketNamePrefix'], physicalId],
      ]
    );
    return this.maskedView(sinks).update(
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }
  this.logger.debug(`Updating S3 bucket ${displaySafe(logicalId)}: ${this.shown(physicalId)}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  const newBucketName = properties['BucketName'] as string | undefined;

  // Bucket name is immutable - if changed, requires replacement
  if (newBucketName && newBucketName !== physicalId) {
    this.logger.debug(
      `Bucket name changed (from ${this.shown(physicalId)} to ${this.shown(newBucketName)}), replacement required`
    );
    return {
      physicalId,
      wasReplaced: true,
    };
  }

  // The template-path half of the versioning / logging shape guards (issue
  // #3728), before ANY call. `applySubConfigDiffs` warn-SKIPS a malformed
  // `VersioningConfiguration.Status` or `LoggingConfiguration` member on
  // every caller; that skip stays for the two state-borne callers (the
  // rollback executor's revert arms set `replayingState`, `cdkd drift
  // --revert` sets `desiredFromAwsReadback`), whose bag the user cannot edit
  // from the template. On a template-path update the value IS template-borne,
  // so it is refused the way a template-path create refuses it — and HERE
  // rather than at the arm, because the arms run mid-update: throwing from
  // the logging arm would leave versioning, ownership, encryption, lifecycle,
  // CORS and website already applied.
  //
  // The eight per-config appliers (lifecycle, notification, replication,
  // object lock, metrics, analytics, intelligent tiering, inventory) are the
  // same case, one step removed (issue #3740): each warn-and-skips a
  // malformed value on every caller and runs mid-update. Their refusal is
  // not restated here: `applySubConfigDiffs` itself runs on a probe whose S3
  // client writes nothing, with no warn callback, so each applier throws its
  // own create-path refusal for exactly the configurations the real run
  // would Put — the diff's own gating decides which, so an unchanged
  // malformed configuration is not refused either.
  if (context?.replayingState !== true && context?.desiredFromAwsReadback !== true) {
    const refusal = S3BucketProvider.versioningOrLoggingRefusal(properties, previousProperties);
    if (refusal !== undefined) {
      throw new ProvisioningError(
        `${refusal}. Nothing was applied to bucket ${this.shown(physicalId)}; fix the template value`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    try {
      await this.noWriteProbe().applySubConfigDiffs(
        physicalId,
        properties,
        previousProperties,
        context,
        true
      );
    } catch (error) {
      // Only a REFUSAL is re-worded. Every refusal an applier (or the
      // `config-shape.ts` guard it calls) raises is a plain `Error`; anything
      // else — a `TypeError` from an applier bug, a typed cdkd error — is not
      // a template fault, so it propagates as it is rather than telling the
      // user to fix a template value.
      if (!(error instanceof Error) || Object.getPrototypeOf(error) !== Error.prototype) {
        throw error;
      }
      throw new ProvisioningError(
        `${this.maskRaw(error.message)}. Nothing was applied to bucket ${this.shown(physicalId)}; fix the ` +
          `template value`,
        resourceType,
        logicalId,
        physicalId,
        error
      );
    }
  }

  // Confirm the recorded physical id denotes a bucket in THIS region before
  // writing anything to it (issue #2245). The expectation is the CLIENT's
  // region (`getRegion()`), which is NOT the same thing as the region the
  // state record belongs to — `UpdateContext` grew an `expectedRegion` in
  // issue #2301 carrying the latter, and `drift --revert` demonstrates the
  // two coming apart: it pins its clients once and then loops over stacks in
  // whatever regions state holds. Consuming that field here is the remaining
  // half of #2245 and deliberately not changed in this PR.
  //
  // Placed BEFORE the try, like the delete-path twin, rather than inside it.
  // The `catch` below re-labels everything it captures as
  // `Failed to update S3 bucket <id>: …`, and a deliberate cdkd refusal is
  // not an AWS failure to re-label: `vp run gen:update-wrap-coverage --check`
  // flags exactly that shape (a wrap that can capture a typed throw with no
  // `instanceof` pass-through), and the alternative — adding a pass-through
  // to the catch — would stop wrapping every OTHER `ProvisioningError` this
  // method's appliers raise, which is a much wider change than this guard.
  await this.assertStateBucketRegion(
    'update',
    logicalId,
    resourceType,
    physicalId,
    await this.getRegion()
  );

  try {
    // Apply configuration changes. Tags are skipped because
    // `applyConfiguration` only adds and never removes (handled by
    // `applyTagDiff` below), and the three diff-managed sub-configs
    // (Versioning / OwnershipControls / BucketEncryption) are skipped
    // because `applySubConfigDiffs` owns them on the UPDATE path so that
    // REMOVING one resets it like CloudFormation does (issue #1466).
    // What is left on the always-PUT path here is
    // `PublicAccessBlockConfiguration`, which is at CFn parity.
    // Empty in practice — `skipDiffManaged` withholds the only applier here
    // that can skip — but merged rather than discarded so a future skip or
    // substitution on the always-PUT path cannot go unrecorded (#1612 /
    // #1670).
    const effectiveOverrides = await this.applyConfiguration(physicalId, properties, {
      skipTags: true,
      skipDiffManaged: true,
    });

    // Apply diff-aware Put/Delete for the sub-configs that have proper
    // Put/Delete API pairs.
    for (const [key, value] of await this.applySubConfigDiffs(
      physicalId,
      properties,
      previousProperties,
      context
    )) {
      effectiveOverrides.set(key, value);
    }

    // go-to-k/cdkd#2762: with ABAC on S3 refuses the two tag calls below, so
    // a turn-off goes first, a turn-on last, and a bucket staying on tags
    // through S3 Control.
    const previousAbac = abacStatusOf(previousProperties);
    const desiredAbac = abacStatusOf(properties);
    if (previousAbac !== desiredAbac && desiredAbac === ABAC_DISABLED) {
      await this.applyAbacStatus(physicalId, desiredAbac);
    }

    // Apply tag diff. S3 uses PutBucketTagging (full-replace) and
    // DeleteBucketTagging when the new tag set is empty.
    await this.applyTagDiff(
      physicalId,
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags'],
      previousAbac === ABAC_ENABLED && desiredAbac === ABAC_ENABLED
    );

    if (previousAbac !== desiredAbac && desiredAbac !== ABAC_DISABLED) {
      await this.applyAbacStatus(physicalId, desiredAbac);
    }

    // go-to-k/cdkd#5395: named once every write above has succeeded.
    await this.warnUnappliedBucketObjectLock(
      logicalId,
      physicalId,
      properties,
      previousProperties,
      context
    );

    const attributes = await this.buildAttributes(physicalId);
    if (metadataBag(properties['MetadataConfiguration'])) {
      Object.assign(attributes, await this.readMetadataAttributesAfterWrites(physicalId, context));
    }

    this.logger.debug(`Successfully updated S3 bucket ${displaySafe(logicalId)}`);

    // Any Put a warn-and-skip arm declined leaves the PREVIOUSLY applied
    // configuration live, so state records that rather than the desired
    // value AWS never received (issue #1612); a Put a warn-and-substitute
    // read altered records the value AWS DID receive (issue #1670).
    //
    // "Absent when neither happened, which is every ordinary update" was true
    // until issues #1707 / #1717 / #1718 and is not any more: an ordinary
    // re-Put now yields a folded item with no skip and no substitution
    // anywhere, whenever the template omits a defaulted-but-SENT member or
    // spells the destination in a tolerated shape.
    const effectiveProperties = S3BucketProvider.applyEffectiveOverrides(
      properties,
      effectiveOverrides
    );

    return {
      physicalId,
      wasReplaced: false,
      attributes,
      ...(effectiveProperties ? { effectiveProperties } : {}),
    };
  } catch (error) {
    throw this.wrapOperationError('update', logicalId, resourceType, physicalId, error);
  }
}

/**
 * Warn when the top-level `ObjectLockEnabled` changed on an existing bucket
 * and S3 still holds the opposite (go-to-k/cdkd#5395). Nothing is written:
 * the flag reaches S3 only through `CreateBucket`, and a CloudFormation A/B
 * in us-east-1 on 2026-10-27 showed CloudFormation sends nothing either.
 * Turning it on for an existing bucket (versioned or not) ends
 * `UPDATE_COMPLETE` with the same bucket and no Object Lock; removing it from
 * a locked bucket ends `UPDATE_COMPLETE` with Object Lock still on. Only the
 * nested `ObjectLockConfiguration.ObjectLockEnabled: Enabled` enables it in
 * place, which `applySubConfigDiffs` already sends. State records the
 * declared value, as CloudFormation's stored template does.
 *
 * One `GetObjectLockConfiguration` confirms the live bucket before warning:
 * a template-to-state difference alone also appears on a rollback revert, on
 * `cdkd drift --revert`, or when the nested block enabled Object Lock in this
 * same update. A failed read on a template-path update still warns, because
 * the template changed the flag, but says the state could not be confirmed
 * rather than asserting either one. On the state-borne callers
 * (`replayingState`, `desiredFromAwsReadback`) the template did not change
 * anything, so an unconfirmed difference is not reported.
 */
export async function warnUnappliedBucketObjectLock(
  this: S3BucketProvider,
  logicalId: string,
  bucketName: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): Promise<void> {
  // A nested `Enabled` in the desired bag was SENT by `applySubConfigDiffs`
  // (or the update threw before here), so it is not a flag left unapplied.
  const enabling =
    declaresBucketObjectLock(properties) &&
    !declaresBucketObjectLock(previousProperties) &&
    !declaresNestedObjectLock(properties);
  const disabling =
    !declaresBucketObjectLock(properties) &&
    !declaresNestedObjectLock(properties) &&
    declaresBucketObjectLock(previousProperties);
  if (!enabling && !disabling) return;

  const liveEnabled = await this.isLiveObjectLocked(bucketName, '');
  if (
    liveEnabled === undefined &&
    (context?.replayingState === true || context?.desiredFromAwsReadback === true)
  ) {
    return;
  }

  const bucket = this.shown(bucketName);
  if (enabling && liveEnabled !== true) {
    this.logger.warn(
      safeMsg`${logicalId} (AWS::S3::Bucket): ObjectLockEnabled is now true, but the top-level ObjectLockEnabled is applied only when a bucket is created, so ` +
        (liveEnabled === false
          ? safeMsg`Object Lock was NOT enabled on the existing bucket ${bucket}, as in CloudFormation. `
          : safeMsg`nothing was sent to enable Object Lock on the existing bucket ${bucket}, as in CloudFormation. ` +
            'Its Object Lock configuration could not be read back, so this is not confirmed. ') +
        'To enable it on this bucket, declare ObjectLockConfiguration.ObjectLockEnabled: ' +
        'Enabled (the bucket must have versioning enabled). Object Lock cannot be disabled ' +
        'once it is enabled.'
    );
  } else if (disabling && liveEnabled !== false) {
    this.logger.warn(
      liveEnabled === true
        ? safeMsg`${logicalId} (AWS::S3::Bucket): ObjectLockEnabled is no longer true, but S3 cannot disable Object Lock on a bucket, so it stays enabled on bucket ${bucket}, as in CloudFormation. ` +
            'Versioning cannot be suspended on it, and object versions stay protected by any ' +
            'retention or legal hold already set.'
        : safeMsg`${logicalId} (AWS::S3::Bucket): ObjectLockEnabled is no longer true. S3 cannot disable Object Lock on a bucket, so if bucket ${bucket} has it, it stays enabled, as in CloudFormation. ` +
            'Its Object Lock configuration could not be read back, so this is not confirmed.'
    );
  }
}

/**
 * Delete an S3 bucket
 *
 * Note: The bucket must be empty before deletion.
 */
export async function deleteImpl(
  this: S3BucketProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  this.logger.debug(`Deleting S3 bucket ${displaySafe(logicalId)}: ${displaySafe(physicalId)}`);

  // go-to-k/cdkd#4606: a bucket a failed CREATE left behind (a journaled
  // proven orphan, deleted by the automatic rollback, `cdkd rollback`,
  // `cdkd destroy` or a later deploy's settle) is NEVER emptied, whatever
  // the attempted template declared. It is empty unless something wrote to
  // it after that CREATE, and then it is no longer provably cdkd's alone:
  // another deployment of the stack (another state prefix) may have adopted
  // it under its generated name, which its identity token cannot tell.
  const failedCreateOrphan = context?.failedCreateOrphan === true;

  // CloudFormation-parity data guard (issue #1340): a non-empty bucket is
  // only auto-emptied when the user opted in — CDK's `autoDeleteObjects`
  // tag on the bucket, or the deploy engine's `--force-stateful-recreation`
  // consent on a replacement delete. Otherwise the not-empty error
  // surfaces exactly like CloudFormation's DELETE_FAILED.
  const allowAutoEmpty =
    !failedCreateOrphan &&
    (context?.forceDataDelete === true ||
      hasCdkAutoDeleteTag(properties, S3_AUTO_DELETE_OBJECTS_TAG));

  // Confirm the recorded physical id denotes a bucket in the region this
  // state record is for, BEFORE anything destructive happens — ahead of the
  // auto-empty above all, since emptying a foreign-region bucket destroys
  // data even when the `DeleteBucket` that follows would fail (issue #2245).
  //
  // Gated on `expectedRegion` being present for the same back-compat reason
  // `assertRegionMatch` states: with no recorded region there is no
  // expectation to check against, so a pre-v2 record keeps its previous
  // behavior instead of being refused. `destroy-runner` supplies it from
  // `StackState.region` whenever the record has one.
  if (context?.expectedRegion) {
    await this.assertStateBucketRegion(
      'delete',
      logicalId,
      resourceType,
      physicalId,
      context.expectedRegion,
      context
    );
  } else {
    // The FIFTH way this guard can fail to run, and the quietest: no probe is
    // issued at all, because there is no recorded region to compare against.
    // See `noRecordedRegionCause` for why that cohort is the highest-risk one
    // and why this warns rather than refuses.
    this.announceUnverifiedBucketIdentity('delete', logicalId, physicalId, noRecordedRegionCause());
  }

  try {
    await this.deleteBucketWithEmptyRetry(logicalId, physicalId, allowAutoEmpty);
  } catch (error) {
    if (failedCreateOrphan && error instanceof BucketNotEmptyRefusal) {
      // Kept, not failed: the journal keeps the entry and the run warns,
      // naming the bucket, and exits 2.
      return { outcome: 'skipped', reason: FAILED_CREATE_ORPHAN_NOT_EMPTY_SKIP_REASON };
    }
    if (error instanceof NoSuchBucket) {
      const clientRegion = await this.s3Client.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Bucket ${displaySafe(physicalId)} does not exist, skipping deletion`);
      return;
    }
    const thrown = this.wrapOperationError(
      'delete',
      logicalId,
      resourceType,
      physicalId,
      error,
      context?.maskSecrets
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFound` in a message as "already deleted": only the typed
    // `NoSuchBucket` above means this bucket is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}

/**
 * Wrap whatever `create` / `update` / `delete` caught into the
 * `ProvisioningError` they throw, with the identity split done BEFORE the
 * throw (issue [#2302](https://github.com/go-to-k/cdkd/issues/2302)).
 *
 * All three sites used to interpolate `error.message` straight into the
 * thrown text. A thrown message is NOT the terminal-only surface the
 * identity warnings elsewhere in this file are: `extractDeploymentEventError`
 * captures it into `deployments/{runId}.jsonl`, which outlives the run and is
 * explicitly restricted to error plus metadata. So an `AccessDenied` on
 * `CreateBucket` / `PutBucket*` / `DeleteBucket` -- S3 words it `User:
 * arn:aws:sts::<account>:assumed-role/<role>/<session> is not authorized to
 * perform: ...` -- wrote the caller's account id, role name and session name
 * into that durable store. Splitting at a log call cannot help here; the
 * split has to happen before the `throw`.
 *
 * Both halves are emitted, for the reason PR
 * [#2290](https://github.com/go-to-k/cdkd/pull/2290) learned the expensive
 * way: AWS's text is what separates a missing IAM grant from a bucket-policy
 * `Deny`, and that distinction is the operator's next action. The class goes
 * in the thrown message and AWS's own wording goes to `logger.debug`.
 *
 * The redaction is NARROW on purpose, and these three sites are why. They are
 * BROAD catch blocks that capture cdkd's OWN refusals as readily as an SDK
 * failure: this file raises six cdkd-authored plain `Error`s inside them --
 * the `BucketEncryption` / `OwnershipControls` array refusals, the
 * EventBridge and inventory `Enabled` refusals, the destination-shape
 * refusal, and `deleteBucketWithEmptyRetry`'s non-empty-bucket refusal, whose
 * message IS the CloudFormation-parity remediation. `describeAwsFailure`
 * keys on the smithy marker fields rather than on "cdkd did not author it",
 * so every one of those passes through verbatim; the `redacted` gate then
 * suppresses a debug line that would only repeat the throw.
 *
 * `cause` still carries the raw error, deliberately: the persisted event
 * reads only the TOP-level `message` off it (plus `awsErrorCode` /
 * `requestId` from the chain), so keeping it costs nothing in that store
 * while retaining the retry classifiers' and `formatError`'s access to it.
 *
 * `deleteMask` is the delete's own masker (`DeleteContext.maskSecrets`):
 * `delete()` runs on no masked view, so `maskRaw` alone is identity there,
 * and the class is AWS-authored text a secret can spell (go-to-k/cdkd#2319).
 */
export function wrapOperationError(
  this: S3BucketProvider,
  operation: 'create' | 'update' | 'delete',
  logicalId: string,
  resourceType: string,
  physicalId: string,
  error: unknown,
  deleteMask?: MaskerFn
): ProvisioningError {
  const mask = (text: string): string => maskerOrIdentity(deleteMask)(this.maskRaw(text));
  const failure = describeAwsFailure(error);
  if (failure.redacted) {
    this.logger.debug(
      mask(
        `Failed to ${operation} S3 bucket ${displaySafe(logicalId)} (${this.shown(physicalId)}): ${mask(failure.detail)}`
      )
    );
  }
  // Both halves masked RAW as well (issue #2177): the engine masks the thrown
  // message, but only a raw value reaches the masker's whole-value arm.
  // go-to-k/cdkd#4969: an explicit deny fails fast now (no retry), so name
  // what refused it -- a fixed policy-type constant, never AWS's text, which
  // carries the caller's identity and possibly a policy ARN.
  const denyKind = failure.redacted ? explicitDenyPolicyKind(failure.detail) : undefined;
  const denyNote =
    failure.redacted && isExplicitDenyError(failure.detail)
      ? ` Refused by an explicit deny${denyKind !== undefined ? ` (${denyKind})` : ''}, which retrying cannot clear.`
      : '';
  // go-to-k/cdkd#4969: a tagged CreateBucket needs `s3:TagResource`, and the
  // redacted summary alone does not say which action was refused.
  const tagResourceNote =
    failure.redacted && isCreateTagResourceDenial(error)
      ? ' Creating a bucket with tags needs s3:TagResource.'
      : '';
  // go-to-k/cdkd#4969: that denial's untagged re-send met an explicit deny.
  const untaggedDenyKind = error instanceof Error ? untaggedExplicitDeny.get(error) : undefined;
  const untaggedDenyNote =
    untaggedDenyKind !== undefined
      ? ` The untagged retry was refused by an explicit deny${untaggedDenyKind !== null ? ` (${untaggedDenyKind})` : ''}, which retrying cannot clear.`
      : '';
  // go-to-k/cdkd#2319: an "already exists" the class does not carry is
  // restated, so a create-first replacement still recognises the collision,
  // except from a post-create wiring step's failure (`markAuxiliaryFailure`),
  // where "it" would read as this bucket.
  const relay =
    failure.redacted && !isAuxiliaryFailure(error) ? relayedNameCollision(failure.detail) : '';
  const wrapped = new ProvisioningError(
    `Failed to ${operation} S3 bucket ${displaySafe(logicalId)}: ${mask(failure.summary)}${relay}${denyNote}${tagResourceNote}${untaggedDenyNote}`,
    resourceType,
    logicalId,
    physicalId,
    error instanceof Error ? error : undefined
  );
  // Tell the retry classifiers this message is INCOMPLETE, so they read the
  // `cause` chain instead of the redacted text (issue #2302). Only when
  // something was actually withheld: an unredacted wrap carries its cause's
  // message verbatim, and stamping it would widen classification for a
  // wrapper that needs nothing.
  return failure.redacted ? markRedactedCause(wrapped) : wrapped;
}

/**
 * The `effectiveProperties` TWIN required by `.claude/rules/providers.md`
 * ("`effectiveProperties` alone BREAKS the next deploy") for the per-item
 * folds the inventory and analytics appliers record — issue #1717 for the
 * inventory `Schedule` -> `ScheduleFrequency` half (#1686), issue #1707 for
 * the destination-shape half, issue #1718 for the defaulted-but-SENT members.
 *
 * Applied by `DiffCalculator` to BOTH comparison sides through
 * `makeCanonicalizePropertiesFn`, so the record's folded spelling and the
 * template's declared one compare EQUAL and an unchanged template stops
 * redeploying as `1 to update` forever. Folding both sides is also what heals
 * the already-deployed population: an item whose value never changes is never
 * re-Put, so the recording side alone can never reach a record written before
 * the fold.
 *
 * The rule's OTHER requirement — share ONE helper with the provisioning path
 * rather than re-deriving the rule — is met by
 * {@link effectiveInventoryItem} / {@link effectiveAnalyticsItem}, which the
 * appliers call with the values they actually sent and this calls with none.
 *
 * Note the twin question is re-asked per site rather than inherited: the #1670
 * sites next door answered NO because canonicalizing there would CONCEAL a
 * malformed value whose warning tells the user what to fix. These folds have
 * no fault to conceal — an item declaring only the SDK spelling is perfectly
 * valid input that emits no warning at all — so the twin's absence bought
 * nothing and cost a permanent `cdkd diff` line plus a redundant per-`Id` Put
 * on every deploy.
 *
 * Identity-returns an untouched bag, so every other `AWS::S3::Bucket` template
 * and every other resource type is byte-for-byte unaffected.
 *
 * THE #1717 OBSTACLE DID NOT REPRODUCE, and that is worth stating rather than
 * quietly omitting: the issue measured a `canonicalizeDesiredProperties`
 * folding this key making `gen-nested-key-coverage` report the still-correct
 * plural->singular `segmentRenames` entry for `InventoryConfigurations` STALE,
 * and warned that each piece is inert alone so only the combination trips it.
 * With the fold implemented as a MODULE-level pure function over an item
 * parameter, the shipped critic is green end to end — `vp run
 * audit:nested-key-coverage:check` reported 0 divergences (then across all
 * three passes; the shape pass is the only one left), the committed matrix does not drift by a byte, and
 * `InventoryConfigurations` is still listed in the target's
 * `usedSegmentRenames`, i.e. the entry is doing work and the fence is not
 * masking anything. So no `segmentRenames` entry was removed and no staleness
 * check was widened; the issue's "resolve the interaction WITHOUT deleting the
 * entry" requirement is met by there being no interaction to resolve. What is
 * NOT claimed is a mechanism for why the issue's attempt tripped it — that
 * attempt is not in the tree to bisect against.
 */
export function canonicalizeDesiredProperties(
  this: S3BucketProvider,
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  if (resourceType !== 'AWS::S3::Bucket') return properties;
  let out = canonicalizeItemList(properties, 'InventoryConfigurations', (item) =>
    effectiveInventoryItem(item)
  );
  out = canonicalizeItemList(out, 'AnalyticsConfigurations', (item) =>
    effectiveAnalyticsItem(item)
  );
  out = canonicalizeItemList(
    out,
    'IntelligentTieringConfigurations',
    effectiveIntelligentTieringItem
  );
  // The #1748 folds. Same shared-helper rule as the three above — the recording
  // side calls the very same function — and the twin is what keeps the fold
  // from BREAKING the next deploy: without it state holds the emitted spelling
  // while the template still declares the tolerated one, so an unchanged
  // template redeploys as `1 to update` forever (issue #1717 measured exactly
  // that on the sibling fold). Folding both sides is also what HEALS the
  // already-deployed population: a bucket whose notification / lifecycle
  // configuration never changes is never re-Put, so the recording side alone
  // could never reach a record written before the fold.
  out = canonicalizeBlock(out, 'NotificationConfiguration', effectiveNotificationConfiguration);
  out = canonicalizeBlock(out, 'LifecycleConfiguration', effectiveLifecycleConfiguration);
  return out;
}

/**
 * `AbacStatus` and `MetadataConfiguration` are read back only while away from
 * their defaults, and `update()` resets each on removal
 * (docs/provider-rules.md, "getDriftAbsentMeansDefaultKeys()").
 */
export function getDriftAbsentMeansDefaultKeys(
  this: S3BucketProvider,
  _resourceType: string,
  properties: Record<string, unknown>
): readonly string[] {
  return [
    ...(abacStatusOf(properties) === ABAC_DISABLED ? ['AbacStatus'] : []),
    ...(properties['MetadataConfiguration'] === undefined ? ['MetadataConfiguration'] : []),
  ];
}

/**
 * The write-only members of the CFn schema: S3 returns none of them, so with
 * no observed baseline a declared value has nothing to compare with.
 */
export function getDriftUnknownPaths(this: S3BucketProvider): string[] {
  return [
    'BucketNamePrefix',
    'BucketNamespace',
    'MetadataConfiguration.JournalTableConfiguration.EncryptionConfiguration',
    'MetadataConfiguration.InventoryTableConfiguration.EncryptionConfiguration',
    'MetadataConfiguration.AnnotationTableConfiguration.EncryptionConfiguration',
  ];
}

/**
 * go-to-k/cdkd#4606: whether the bucket a failed CREATE journaled is the one
 * the record under the same logical id holds (a fix-forward that created a
 * new one there under another name).
 *
 * Bucket names are globally unique and a bucket cannot be renamed, so two
 * different names are two different buckets. Both must be plain
 * DNS-compatible names (anything else is `'unknown'`); an equal pair is
 * `'same'` without a read. A different pair is `'different'` only once the
 * record's bucket reads back in `expectedRegion` from a client in that
 * region: a record naming a bucket that is gone, elsewhere, or unreadable
 * is `'unknown'`, which keeps the journaled one.
 */
export async function isSameResource(
  this: S3BucketProvider,
  journaledPhysicalId: string,
  record: { physicalId: string },
  resourceType: string,
  context: { expectedRegion: string }
): Promise<ResourceIdentityVerdict> {
  if (resourceType !== 'AWS::S3::Bucket') return 'unknown';
  if (!isPlainBucketName(journaledPhysicalId) || !isPlainBucketName(record.physicalId)) {
    return 'unknown';
  }
  if (journaledPhysicalId === record.physicalId) return 'same';
  const want = canonicalizeRegion(context.expectedRegion);
  if (canonicalizeRegion(await this.getRegion()) !== want) return 'unknown';
  const probe = await this.probeBucketRegion(record.physicalId);
  return probe.kind === 'region' && probe.region === want ? 'different' : 'unknown';
}

/**
 * go-to-k/cdkd#4655 / #4606: a token naming THIS bucket generation and no
 * later one under the same name: `<name>|<region>|<CreationDate>`, the
 * creation date read from this account's own `ListBuckets` entry. S3 gives a
 * bucket no immutable id, so the creation date is what tells a bucket from
 * one re-created under its name after it was deleted.
 *
 * Measured for #4606 (2026-10-08, us-east-1 and us-west-2): a bucket
 * deleted and re-created under its name, at once or minutes later, reports
 * the NEW create's second, which is what makes the token sound. The date
 * has one-second precision, so a delete and re-create inside the same
 * second as the identity read is the accepted window. It also moves:
 * outside us-east-1 it becomes the second of each versioning, tagging,
 * encryption or policy write (not in us-east-1), as S3 documents for a
 * policy edit. So the token must be read after the failed CREATE's last
 * write -- the deploy engine reads it once the create has thrown -- and a
 * moved date reads as ANOTHER bucket, which keeps the journaled one and
 * warns: the safe direction.
 *
 * `RESOURCE_NOT_FOUND` only when `GetBucketLocation` answers `NoSuchBucket`.
 * `undefined` for another type, a name that is not plain, a client or bucket
 * in another region than `expectedRegion`, a location that cannot be read,
 * and a bucket this account's list does not show (another account's, or one
 * the list has not caught up with yet, re-read briefly): never a token cdkd
 * cannot vouch for.
 */
export async function resourceIdentity(
  this: S3BucketProvider,
  physicalId: string,
  resourceType: string,
  context: { expectedRegion: string }
): Promise<string | ResourceNotFound | undefined> {
  if (resourceType !== 'AWS::S3::Bucket' || !isPlainBucketName(physicalId)) return undefined;
  const want = canonicalizeRegion(context.expectedRegion);
  if (canonicalizeRegion(await this.getRegion()) !== want) return undefined;
  const probe = await this.probeBucketRegion(physicalId);
  if (probe.kind === 'absent') return RESOURCE_NOT_FOUND;
  if (probe.kind !== 'region' || probe.region !== want) return undefined;
  const started = Date.now();
  for (let attempt = 0; attempt < BUCKET_LIST_IDENTITY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Never past the caller's 10s bound, which stops waiting but cannot
      // stop this loop.
      if (Date.now() - started > BUCKET_LIST_IDENTITY_BUDGET_MS) return undefined;
      await new Promise((r) => setTimeout(r, BUCKET_LIST_IDENTITY_DELAY_MS));
    }
    const listed = await this.listOwnedBucket(physicalId);
    if ('unknown' in listed) return undefined;
    const created = listed.bucket?.CreationDate;
    if (created instanceof Date && !Number.isNaN(created.getTime())) {
      return `${physicalId}|${want}|${created.toISOString()}`;
    }
  }
  return undefined;
}

/**
 * Adopt an existing S3 bucket into cdkd state.
 *
 * Lookup order:
 *  1. `--resource <id>=<name>` override or `Properties.BucketName` → use directly,
 *     verify with `HeadBucket`.
 *
 * Returns `null` when nothing matches — caller treats this as
 * "not deployed yet" rather than a failure.
 */
/**
 * go-to-k/cdkd#4705: the name `create()` sends when the template names
 * none. S3 has no batch lookup, so the plan-time check looks each such
 * bucket up through `import()` (`HeadBucket`), bounded.
 */
export function generatedCreateName(
  this: S3BucketProvider,
  _resourceType: string,
  logicalId: string,
  properties: Record<string, unknown>
): string | undefined {
  if (properties['BucketNamePrefix'] || properties['BucketName']) return undefined;
  return generatedNameFor('AWS::S3::Bucket', logicalId);
}
export async function importImpl(
  this: S3BucketProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'BucketName');
  if (explicit) {
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: explicit }));
      return { physicalId: explicit, attributes: {} };
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NotFound' || e.name === 'NoSuchBucket') {
        return null;
      }
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a bucket
  // reaching here needs an explicit `--resource` override.
  return null;
}

/**
 * Delete a bucket, emptying it first if not empty — but ONLY when
 * `allowAutoEmpty` is set (issue #1340).
 *
 * With `allowAutoEmpty` (CDK `autoDeleteObjects` tag present, or
 * `--force-stateful-recreation` consent via
 * {@link DeleteContext.forceDataDelete}), the retry loop handles the race
 * condition where objects (e.g., ALB logs) are written after
 * CustomResource cleanup but before bucket deletion.
 *
 * Without it, a not-empty bucket refuses deletion with an actionable
 * error — matching CloudFormation's DELETE_FAILED, which is the safety
 * net users rely on to keep `cdkd destroy` from silently destroying data
 * they never opted into losing.
 */
export async function deleteBucketWithEmptyRetry(
  this: S3BucketProvider,
  logicalId: string,
  bucketName: string,
  allowAutoEmpty: boolean
): Promise<void> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await this.s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
      this.logger.debug(`Successfully deleted S3 bucket ${displaySafe(logicalId)}`);
      return;
    } catch (error) {
      // `.detail`, never `.summary`: the substring test below is what keeps this
      // degradation alive, and it matches AWS's OWN wording. Byte-identical to
      // the ternary it replaced, minus that ternary's throw.
      const msg = describeAwsFailure(error).detail;
      if (msg.includes('not empty') || msg.includes('BucketNotEmpty')) {
        if (!allowAutoEmpty) {
          throw new BucketNotEmptyRefusal(
            `bucket ${displaySafe(bucketName)} is not empty. Matching CloudFormation, cdkd does not ` +
              `delete a non-empty bucket unless it opted into automatic emptying ` +
              `(CDK's autoDeleteObjects: true, i.e. the '${S3_AUTO_DELETE_OBJECTS_TAG}' tag). ` +
              `Either empty the bucket first (delete all objects — and for versioned ` +
              `buckets all object versions and delete markers), or redeploy with ` +
              `autoDeleteObjects: true and destroy again.`
          );
        }
        this.logger.info(
          `Bucket ${displaySafe(bucketName)} not empty (attempt ${attempt}/${maxAttempts}), emptying (auto-delete opt-in present)...`
        );
        await this.emptyBucket(bucketName);
        continue;
      }
      throw error;
    }
  }
  // Final attempt after emptying
  await this.s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
  this.logger.debug(`Successfully deleted S3 bucket ${displaySafe(logicalId)}`);
}

/**
 * Empty a bucket by deleting all object versions and delete markers.
 */
export async function emptyBucket(this: S3BucketProvider, bucketName: string): Promise<void> {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const listResp = await this.s3Client.send(
      new ListObjectVersionsCommand({
        // go-to-k/cdkd#3313: a CR in a key becomes an LF without this.
        EncodingType: LISTING_ENCODING_TYPE,
        Bucket: bucketName,
        MaxKeys: 1000,
        ...(keyMarker && { KeyMarker: keyMarker }),
        ...(versionIdMarker && { VersionIdMarker: versionIdMarker }),
      })
    );

    const objects: Array<{ Key: string; VersionId: string }> = [];
    for (const v of listResp.Versions || []) {
      // go-to-k/cdkd#3313: these Keys are deleted, so they must be the real ones.
      const vKey = decodeListingKey(v.Key);
      if (vKey && v.VersionId) objects.push({ Key: vKey, VersionId: v.VersionId });
    }
    for (const d of listResp.DeleteMarkers || []) {
      // Decoded like its `Versions` sibling above — the listing asks for URL
      // encoding, so a raw marker key here deletes the wrong object.
      const dKey = decodeListingKey(d.Key); // go-to-k/cdkd#3313
      if (dKey && d.VersionId) objects.push({ Key: dKey, VersionId: d.VersionId });
    }

    if (objects.length > 0) {
      await this.s3Client.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: { Objects: objects, Quiet: true },
        })
      );
      this.logger.debug(`Emptied ${objects.length} objects from ${displaySafe(bucketName)}`);
    }

    if (!listResp.IsTruncated) break;
    // DECODED: the next request sends the RAW marker (go-to-k/cdkd#3313).
    keyMarker = decodeListingKey(listResp.NextKeyMarker);
    versionIdMarker = listResp.NextVersionIdMarker;
  }
}
