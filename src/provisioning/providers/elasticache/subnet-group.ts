import type { ElastiCacheProvider } from '../elasticache-provider.js';
import {
  CreateCacheSubnetGroupCommand,
  DeleteCacheSubnetGroupCommand,
  ModifyCacheSubnetGroupCommand,
  ListTagsForResourceCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
} from '@aws-sdk/client-elasticache';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { clearOnUpdateRemoval } from '../../update-removal.js';
import { generatedNameFor } from '../../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import {
  planTagDiff,
  readTagList,
  tagPlanWarning,
  refuseMalformedDesiredTags,
} from '../../tag-list.js';
import type { ResourceCreateResult, ResourceUpdateResult } from '../../../types/resource.js';

export async function createSubnetGroup(
  this: ElastiCacheProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  mask?: MaskerFn
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating CacheSubnetGroup ${logicalId}`);
  // go-to-k/cdkd#3994: `Tags` was declared handled and never sent; a
  // malformed one is refused before any call.
  const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const cacheSubnetGroupName =
    (properties['CacheSubnetGroupName'] as string | undefined) ||
    generatedNameFor('AWS::ElastiCache::SubnetGroup', logicalId);

  try {
    await this.getCreateClient().send(
      new CreateCacheSubnetGroupCommand({
        CacheSubnetGroupName: cacheSubnetGroupName,
        // CFn schema spells the description field `Description`; AWS API
        // expects `CacheSubnetGroupDescription`. Accept both keys from the
        // template and prefer the CFn-canonical name.
        CacheSubnetGroupDescription:
          (properties['Description'] as string | undefined) ??
          (properties['CacheSubnetGroupDescription'] as string | undefined) ??
          `Subnet group for ${logicalId}`,
        SubnetIds: properties['SubnetIds'] as string[],
        ...(tags.length > 0 && { Tags: tags }),
      })
    );

    this.logger.debug(
      `Successfully created CacheSubnetGroup ${logicalId}: ${cacheSubnetGroupName}`
    );

    return {
      physicalId: cacheSubnetGroupName,
      attributes: {
        CacheSubnetGroupName: cacheSubnetGroupName,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create CacheSubnetGroup ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          cacheSubnetGroupName,
          cause
        )
    );
  }
}

export async function updateSubnetGroup(
  this: ElastiCacheProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  mask?: MaskerFn
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating CacheSubnetGroup ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  try {
    // #1160 reset-on-removal — ModifyCacheSubnetGroup has merge semantics
    // (an absent CacheSubnetGroupDescription means "no change"), so a
    // description REMOVED from the template must be sent explicitly.
    // Reset value: the same `Subnet group for ${logicalId}` default that
    // `createSubnetGroup` synthesizes when the template omits the
    // description, keeping create/update parity. (CFn marks `Description`
    // required on AWS::ElastiCache::SubnetGroup, so a removal is
    // CFn-invalid anyway and could not be A/B-measured in #5004 — but
    // cdkd's create path tolerates the absence with this default, and
    // update must not silently keep the old value.)
    const modified = await this.getClient().send(
      new ModifyCacheSubnetGroupCommand({
        CacheSubnetGroupName: physicalId,
        CacheSubnetGroupDescription: clearOnUpdateRemoval(
          (properties['Description'] as string | undefined) ??
            (properties['CacheSubnetGroupDescription'] as string | undefined),
          (previousProperties['Description'] as string | undefined) ??
            (previousProperties['CacheSubnetGroupDescription'] as string | undefined),
          `Subnet group for ${logicalId}`
        ),
        SubnetIds: properties['SubnetIds'] as string[],
      })
    );

    // Apply the tag diff (go-to-k/cdkd#3994: `Tags` used to be ignored on
    // update). A group created before that fix never received its recorded
    // tags, so the diff is checked against the group's LIVE tag set: see
    // `applySubnetGroupTagDiff`. ModifyCacheSubnetGroup returns the ARN.
    if (properties['Tags'] != null || previousProperties['Tags'] != null) {
      const subnetGroupArn = modified.CacheSubnetGroup?.ARN;
      if (!subnetGroupArn) {
        throw new ProvisioningError(
          safeMsg`Could not resolve the ARN of CacheSubnetGroup ${logicalId}; its Tags were not updated`,
          resourceType,
          logicalId,
          physicalId
        );
      }
      const live = await this.getClient().send(
        new ListTagsForResourceCommand({ ResourceName: subnetGroupArn })
      );
      await this.applySubnetGroupTagDiff(
        subnetGroupArn,
        resourceType,
        logicalId,
        previousProperties['Tags'],
        properties['Tags'],
        normalizeAwsTagsToCfn(live.TagList)
      );
    }

    this.logger.debug(`Successfully updated CacheSubnetGroup ${logicalId}`);

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        CacheSubnetGroupName: physicalId,
      },
    };
  } catch (error) {
    // cdkd's own refusal (the missing-ARN one above) passes through as it is.
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update CacheSubnetGroup ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function deleteSubnetGroup(
  this: ElastiCacheProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting CacheSubnetGroup ${logicalId}: ${physicalId}`);

  try {
    await this.getClient().send(
      new DeleteCacheSubnetGroupCommand({
        CacheSubnetGroupName: physicalId,
      })
    );
    this.logger.debug(`Successfully deleted CacheSubnetGroup ${logicalId}`);
  } catch (error) {
    if (this.isNotFoundError(error, 'CacheSubnetGroupNotFoundFault')) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`CacheSubnetGroup ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapDeleteError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete CacheSubnetGroup ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * The subnet group's tag diff (go-to-k/cdkd#3994). REMOVALS come from the
 * record, as everywhere else, so a tag cdkd never recorded (an operator's,
 * a tag policy's) is never untagged; the LIVE set only narrows them to keys
 * AWS actually holds (no `TagNotFoundFault` for a group created before the
 * fix, which never received its recorded tags). ADDS are every desired tag
 * whose live value differs, so such a group gets its tags now.
 */
export async function applySubnetGroupTagDiff(
  this: ElastiCacheProvider,
  arn: string,
  resourceType: string,
  logicalId: string,
  oldTagsRaw: unknown,
  newTagsRaw: unknown,
  liveTags: Array<{ Key: string; Value: string }>
): Promise<void> {
  const plan = planTagDiff(oldTagsRaw, newTagsRaw);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  const live = new Map(liveTags.map((t) => [t.Key, t.Value]));
  const desired = readTagList(newTagsRaw, 'desired');
  const tagsToAdd =
    desired.kind === 'tags' ? desired.tags.filter((t) => live.get(t.Key) !== t.Value) : [];
  const tagsToRemove = plan.remove.filter((k) => live.has(k));
  if (tagsToRemove.length > 0) {
    await this.getClient().send(
      new RemoveTagsFromResourceCommand({ ResourceName: arn, TagKeys: tagsToRemove })
    );
  }
  if (tagsToAdd.length > 0) {
    await this.getClient().send(
      new AddTagsToResourceCommand({ ResourceName: arn, Tags: tagsToAdd })
    );
  }
}
