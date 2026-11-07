import type { SecretsManagerSecretProvider } from '../secretsmanager-secret-provider.js';
import {
  UpdateSecretCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ReplicateSecretToRegionsCommand,
  RemoveRegionsFromReplicationCommand,
} from '@aws-sdk/client-secrets-manager';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';

/**
 * Update a Secrets Manager secret
 *
 * `context` is read for the ORIGIN of the desired bag only
 * (`replayingState` / `desiredFromAwsReadback`), which decides whether a
 * changed, malformed `GenerateSecretString` refuses (a template-path update)
 * or warn-skips (a rollback revert) — issue #3740.
 */
export async function update(
  this: SecretsManagerSecretProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // Issue #2177: ONE masked sink per operation. The physical id is an ARN
  // embedding the secret's NAME, so it is masked whenever that name is
  // secret-derived: from the desired `Name`, or, after a rotated secret,
  // from the recorded one, which state persists as its dynamic reference
  // while the old plaintext is in no bag of this deploy.
  const log = this.operationSinks(context?.maskSecrets, [
    [properties['Name'], properties['Name']],
    [properties['Name'], physicalId],
    [previousProperties['Name'], physicalId],
  ]);
  const { value: v } = log;
  log.debug(`Updating secret ${logicalId}: ${v(physicalId)}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call
  // (read as empty, it would untag every recorded key).
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  // Decided BEFORE the `try` below, so a template-path refusal from
  // `changedSecretValue` is not re-labelled as an AWS update failure, and
  // before the only write (`UpdateSecret`).
  const stateBorneDesired =
    context?.replayingState === true || context?.desiredFromAwsReadback === true;
  let changedValue: { value: string | undefined; skippedGenerate: boolean };
  try {
    changedValue = this.changedSecretValue(
      properties,
      previousProperties,
      stateBorneDesired,
      log.warn
    );
  } catch (error) {
    // A state-borne bag can still throw here (the literal `SecretString`
    // shape refusal runs on every caller), and its remedy is not a template
    // edit — so only the template path is told to fix the template.
    const message = v(describeAwsFailure(error).detail);
    throw new ProvisioningError(
      stateBorneDesired
        ? `Failed to update secret ${logicalId}: ${message}`
        : `${message}. Nothing was applied to secret ${logicalId}; fix the template value`,
      resourceType,
      logicalId,
      physicalId,
      error instanceof Error ? error : undefined
    );
  }

  try {
    // The secret VALUE is sent only when its SOURCE changed (issue #2472).
    // `UpdateSecret` with a `SecretString` creates a new version and moves
    // `AWSCURRENT` to it, so re-sending the value on every in-place update
    // — a Tags-only or Description-only deploy, or a rollback replay — used
    // to mint a fresh random password for a `GenerateSecretString` secret
    // (a database seeded from the old value then rejects every consumer
    // that reads the new one), and to stack a redundant version for an
    // unchanged literal (advancing `AWSPREVIOUS` off the real previous
    // value). CloudFormation regenerates only when the `GenerateSecretString`
    // block itself changes and re-sends a literal only when it changes; the
    // comparison against `previousProperties` below is that semantics.
    // `UpdateSecret` has merge semantics, so omitting `SecretString` leaves
    // the current version untouched.
    const { value: secretString, skippedGenerate } = changedValue;

    const updateParams: import('@aws-sdk/client-secrets-manager').UpdateSecretCommandInput = {
      SecretId: physicalId,
    };
    if (secretString !== undefined) updateParams.SecretString = secretString;
    // `Description`: pass-through is `!== undefined` (not truthy) —
    // readCurrentState emits `Description: ''` as a placeholder for "no
    // description set" so the drift comparator can detect a console-side
    // description add. A truthy gate here would silently drop a
    // user-intended `Description: ''` (clear-the-description) on
    // `cdkd drift --revert`. AWS UpdateSecret accepts empty string for
    // Description (treated as "no description").
    // A Description REMOVED from the template is NOT reset: UpdateSecret has
    // merge semantics (absent = unchanged), and real CloudFormation KEEPS the
    // live Description on removal (go-to-k/cdkd#5004 A/B), so cdkd sends nothing.
    const description = properties['Description'] as string | undefined;
    if (description !== undefined) updateParams.Description = description;
    // `KmsKeyId`: readCurrentState emits `KmsKeyId: ''` as a placeholder
    // when the secret uses the AWS-managed key (no customer KMS key set).
    // A KmsKeyId REMOVED from the template (absent, not `''`) is NOT reset:
    // UpdateSecret has merge semantics and real CloudFormation KEEPS the live
    // key on removal (go-to-k/cdkd#5004 A/B), so cdkd sends nothing.
    // An explicit `''` on the desired side (the baseline `cdkd drift
    // --revert` hands over for a secret that had no customer key) while the
    // other side holds a customer key is a deliberate clear: UpdateSecret
    // documents `KmsKeyId: ''` as "use the AWS managed key
    // aws/secretsmanager" (live-probed 2026-07-27: accepted, and DescribeSecret
    // omits KmsKeyId again, which readCurrentState maps back to the `''`
    // placeholder, so it is drift-clean). A placeholder-only previous side
    // sends nothing.
    const newKmsKeyId = properties['KmsKeyId'] as string | undefined;
    const prevKmsKeyId = previousProperties['KmsKeyId'] as string | undefined;
    const kmsKeyId =
      newKmsKeyId === undefined
        ? undefined
        : newKmsKeyId === ''
          ? prevKmsKeyId !== undefined && prevKmsKeyId !== ''
            ? ''
            : undefined
          : newKmsKeyId;
    if (kmsKeyId !== undefined) updateParams.KmsKeyId = kmsKeyId;
    // `Type`: emit-when-present (no placeholder in readCurrentState).
    // Truthy gate matches create() — Type is the partner identifier for
    // Secrets Manager managed external secrets and is rarely user-set;
    // passing an empty string would be a no-op on AWS side.
    // A Type REMOVED from the template is NOT reset: real CloudFormation
    // updates the secret in place and KEEPS the live Type (go-to-k/cdkd#1160
    // A/B with `DatadogApiKey`), so cdkd sends nothing, as for Description.
    if (properties['Type']) updateParams.Type = properties['Type'] as string;

    await this.smClient.send(new UpdateSecretCommand(updateParams));

    // Update Tags: untag the recorded keys the desired side no longer
    // names, then tag the new / changed ones. Both sides are read through
    // `planTagDiff` (go-to-k/cdkd#3994): an unreadable record untags nothing.
    const tagPlan = planTagDiff(previousProperties['Tags'], properties['Tags']);
    const tagWarning = tagPlanWarning(tagPlan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      log.warn(tagWarning);
    }
    if (tagPlan.remove.length > 0) {
      await this.smClient.send(
        new UntagResourceCommand({
          SecretId: physicalId,
          TagKeys: tagPlan.remove,
        })
      );
    }
    if (tagPlan.set.size > 0) {
      await this.smClient.send(
        new TagResourceCommand({
          SecretId: physicalId,
          Tags: [...tagPlan.set].map(([Key, Value]) => ({ Key, Value })),
        })
      );
    }
    if (tagPlan.remove.length > 0 || tagPlan.set.size > 0) {
      log.debug(`Updated tags for secret ${v(physicalId)}`);
    }

    // Update ReplicaRegions if changed
    const newReplicas = properties['ReplicaRegions'] as Array<Record<string, unknown>> | undefined;
    const oldReplicas = previousProperties['ReplicaRegions'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (JSON.stringify(newReplicas) !== JSON.stringify(oldReplicas)) {
      // Remove old replica regions that are no longer present
      if (oldReplicas && oldReplicas.length > 0) {
        const newRegionSet = new Set((newReplicas || []).map((r) => r['Region'] as string));
        const regionsToRemove = oldReplicas
          .map((r) => r['Region'] as string)
          .filter((region) => !newRegionSet.has(region));
        if (regionsToRemove.length > 0) {
          await this.smClient.send(
            new RemoveRegionsFromReplicationCommand({
              SecretId: physicalId,
              RemoveReplicaRegions: regionsToRemove,
            })
          );
        }
      }
      // Add new replica regions, and re-send every kept region whose
      // KmsKeyId changed (added, removed or swapped): ReplicateSecretToRegions
      // on a region the secret already replicates to re-keys that replica in
      // place, which is what CloudFormation does (#5302).
      if (newReplicas && newReplicas.length > 0) {
        // No key, '' and the AWS managed key's alias are one key: readCurrentState
        // (a `drift --revert` base) spells a default-key replica with the alias,
        // a template leaves it out.
        const AWS_MANAGED_SECRETS_KEY = 'alias/aws/secretsmanager';
        const replicaKey = (k: unknown): string =>
          k === undefined || k === '' || k === AWS_MANAGED_SECRETS_KEY
            ? AWS_MANAGED_SECRETS_KEY
            : JSON.stringify(k);
        const oldKeyByRegion = new Map(
          (oldReplicas || []).map((r) => [r['Region'] as string, replicaKey(r['KmsKeyId'])])
        );
        const regionsToAdd = newReplicas.filter((r) => {
          const region = r['Region'] as string;
          return (
            !oldKeyByRegion.has(region) || oldKeyByRegion.get(region) !== replicaKey(r['KmsKeyId'])
          );
        });
        if (regionsToAdd.length > 0) {
          await this.smClient.send(
            new ReplicateSecretToRegionsCommand({
              SecretId: physicalId,
              AddReplicaRegions: regionsToAdd.map((r) => ({
                Region: r['Region'] as string,
                // '' is the readCurrentState placeholder for no key: AWS
                // rejects it as a key id, so send no key (the AWS managed one).
                KmsKeyId: (r['KmsKeyId'] as string | undefined) || undefined,
              })),
            })
          );
        }
      }
      log.debug(`Updated replica regions for secret ${v(physicalId)}`);
    }

    log.debug(`Successfully updated secret ${logicalId}`);

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        Id: physicalId,
      },
      // A SKIPPED generate block must not be RECORDED (issue #3048 review).
      // The engine records the desired bag unless told otherwise, so without
      // this the malformed container would overwrite the usable one in
      // state — and then the next deploy compares desired == previous, takes
      // the `unchanged` early return, and the secret sits un-regenerated
      // with NO warning at all. That is worse than the throw this change
      // replaced: it converts a loud, repeating failure into a silent one,
      // and the poisoned record later reaches the reverse-replacement
      // replay-create, which refuses it.
      //
      // So state keeps describing what AWS still holds — the #1612 UPDATE
      // rule. The previous block is validated with the SAME predicate the
      // wire uses rather than a hand-written twin, and the key is DROPPED
      // when the previous side is absent or itself unusable, since there is
      // then no value cdkd can vouch for (the #1653 review rule).
      // Spelled as an always-present key rather than a conditional SPREAD so
      // it stays visible to the #2212 return-shape fence, which reads the
      // literal's top-level keys. A spread renders as `...` there, and an
      // assignment after the literal would evade the fence entirely -- the
      // failure mode that fence's own header records.
      effectiveProperties: skippedGenerate
        ? this.retainPreviousGenerateBlock(logicalId, properties, previousProperties)
        : undefined,
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update secret ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
