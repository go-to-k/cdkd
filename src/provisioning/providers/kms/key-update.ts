import type { KMSProvider } from '../kms-provider.js';
import { templateBool } from './shared.js';
import { isDeepStrictEqual } from 'node:util';
import {
  DescribeKeyCommand,
  EnableKeyRotationCommand,
  DisableKeyRotationCommand,
  UpdateKeyDescriptionCommand,
  PutKeyPolicyCommand,
  EnableKeyCommand,
  DisableKeyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  DisabledException,
  type KeyMetadata,
} from '@aws-sdk/client-kms';
import {
  CdkdError,
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { withRemovalDefaults } from '../../update-removal.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';

export async function updateKey(
  this: KMSProvider,
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
export async function liveKeyMatches(
  this: KMSProvider,
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
export async function sendRotation(
  this: KMSProvider,
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
export async function defaultKeyPolicy(this: KMSProvider, keyId: string): Promise<string> {
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

/**
 * Apply a diff between old and new CFn-shape Tags arrays via KMS's
 * `TagResource` / `UntagResource` APIs. KMS uses `{TagKey, TagValue}`
 * (NOT the standard `{Key, Value}` shape) keyed by `KeyId`. Both sides are
 * read through `planTagDiff` (go-to-k/cdkd#3994): an unreadable record
 * untags nothing.
 */
export async function applyTagDiff(
  this: KMSProvider,
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
    await this.getClient().send(new UntagResourceCommand({ KeyId: keyId, TagKeys: tagsToRemove }));
    this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from KMS Key ${keyId}`);
  }
  if (tagsToAdd.length > 0) {
    await this.getClient().send(new TagResourceCommand({ KeyId: keyId, Tags: tagsToAdd }));
    this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on KMS Key ${keyId}`);
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
