import type { CloudTrailProvider } from '../cloudtrail-provider.js';
import { AddTagsCommand, RemoveTagsCommand } from '@aws-sdk/client-cloudtrail';
import { planTagDiff, readTagList, tagPlanWarning } from '../../tag-list.js';

/**
 * Apply a diff between old and new CFn-shape Tags arrays via CloudTrail's
 * `AddTags` / `RemoveTags` APIs. Note: CloudTrail's `RemoveTags` takes
 * full `{Key, Value}` objects in `TagsList` (NOT just keys), unlike most
 * other AWS services. Both sides are read through `planTagDiff`
 * (go-to-k/cdkd#3994): an unreadable record untags nothing.
 */
export async function applyTagDiff(
  this: CloudTrailProvider,
  trailArn: string,
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
  const tagsToAdd = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
  // `plan.remove` is non-empty only when the record was readable; its
  // values ride along because RemoveTags takes full {Key, Value} objects.
  const recorded = readTagList(oldTagsRaw, 'recorded');
  const oldMap = new Map(
    recorded.kind === 'tags' ? recorded.tags.map((t) => [t.Key, t.Value] as const) : []
  );
  const tagsToRemove = plan.remove.map((Key) => ({ Key, Value: oldMap.get(Key) ?? '' }));

  if (tagsToRemove.length > 0) {
    await this.getClient().send(
      new RemoveTagsCommand({ ResourceId: trailArn, TagsList: tagsToRemove })
    );
    this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from CloudTrail Trail ${trailArn}`);
  }
  if (tagsToAdd.length > 0) {
    await this.getClient().send(new AddTagsCommand({ ResourceId: trailArn, TagsList: tagsToAdd }));
    this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on CloudTrail Trail ${trailArn}`);
  }
}
