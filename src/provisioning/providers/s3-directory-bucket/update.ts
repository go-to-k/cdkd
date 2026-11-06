import type { Tag } from '@aws-sdk/client-s3';
import { TagResourceCommand, UntagResourceCommand } from '@aws-sdk/client-s3-control';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch } from '../../region-check.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import type { S3DirectoryBucketProvider } from '../s3-directory-bucket-provider.js';
import { desiredConfigurations, configurationRefuser } from './configurations.js';

/**
 * Update an S3 Express Directory Bucket
 *
 * `BucketName` / `DataRedundancy` / `LocationName` are create-only (the
 * registry-schema fallback classifies changes to them as replacement). The
 * four bucket configurations converge through {@link applyConfigurations}
 * (go-to-k/cdkd#2762). `Tags` are applied via S3 Control's
 * `TagResource` / `UntagResource` (the directory-bucket tag CRUD; the
 * bucket-level `PutBucketTagging` is not supported for directory buckets).
 * `TagResource` is additive-only, so a tag dropped from the template
 * (partial removal) — or the entire `Tags` property removed (full removal,
 * `newTags === undefined`) — would survive on AWS unless the removed keys
 * are explicitly `UntagResource`d.
 */
export async function update(
  this: S3DirectoryBucketProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // go-to-k/cdkd#2613: the tag writes name the bucket by an ARN whose region
  // is the shared S3 client's and go out through the S3 Control client, so
  // both are compared with the recorded region: either one in another region
  // than the state record would aim the writes at a region this record was
  // not written through. Ahead of the STS lookup and every write, outside the
  // try so a refusal is not re-labelled as an AWS failure. The clients'
  // regions are resolved only when there is one to compare with.
  if (context?.expectedRegion) {
    for (const clientRegion of [
      await this.s3Client.config.region(),
      await this.getS3ControlClient().config.region(),
    ]) {
      assertRegionMatch(
        clientRegion,
        context.expectedRegion,
        resourceType,
        logicalId,
        physicalId,
        'pre-update'
      );
    }
  }
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call
  // (read as empty, it would untag every recorded key).
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  // go-to-k/cdkd#2762: a malformed desired configuration is refused before
  // any call too.
  const configs = desiredConfigurations(
    properties,
    configurationRefuser(resourceType, logicalId, physicalId)
  );
  try {
    const plan = planTagDiff(previousProperties['Tags'], properties['Tags']);
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      this.logger.warn(tagWarning);
    }
    const removedKeys = plan.remove;
    const tagsToApply: Tag[] = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
    if (removedKeys.length > 0 || tagsToApply.length > 0) {
      const accountId = await this.getAccountId();
      const resourceArn = await this.buildBucketArn(physicalId, accountId);

      if (removedKeys.length > 0) {
        context?.markUnsettled?.('Tags');
        await this.getS3ControlClient().send(
          new UntagResourceCommand({
            AccountId: accountId,
            ResourceArn: resourceArn,
            TagKeys: removedKeys,
          })
        );
      }
      // Apply added / changed tags. Skip the call when there are none
      // (a pure removal has nothing left to add).
      if (tagsToApply.length > 0) {
        context?.markUnsettled?.('Tags');
        await this.getS3ControlClient().send(
          new TagResourceCommand({
            AccountId: accountId,
            ResourceArn: resourceArn,
            Tags: tagsToApply,
          })
        );
      }
      this.logger.debug(`Updated tags for S3 Express Directory Bucket ${physicalId}`);
    }
    await this.applyConfigurations(
      physicalId,
      configs,
      properties,
      previousProperties,
      false,
      (key) => context?.markUnsettled?.(key)
    );
    return {
      physicalId,
      wasReplaced: false,
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update S3 Express Directory Bucket ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
