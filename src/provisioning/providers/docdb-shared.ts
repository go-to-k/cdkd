/**
 * Helpers shared by the two DocumentDB providers, `DocDBProvider` (DB cluster
 * and instance) and `DocDBSubnetGroupProvider`. They are two classes because
 * `disableCcApiFallback` is provider-level and only the cluster and instance
 * types lack Cloud Control handlers (issue #3866).
 */
import {
  AddTagsToResourceCommand,
  ListTagsForResourceCommand,
  RemoveTagsFromResourceCommand,
  type DocDBClient,
} from '@aws-sdk/client-docdb';
import type { Logger } from '../../types/config.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';

type CfnTag = { Key?: string; Value?: string };

export function isDocDBNotFoundError(error: unknown, faultName: string): boolean {
  if (!(error instanceof Error)) return false;
  const name = (error as { name?: string }).name ?? '';
  const message = error.message.toLowerCase();
  return name === faultName || message.includes('not found') || message.includes('does not exist');
}

/**
 * Apply a diff between old and new CFn-shape Tags arrays via DocDB's
 * `AddTagsToResource` / `RemoveTagsFromResource` APIs (keyed by
 * `ResourceName=arn`).
 */
export async function applyDocDBTagDiff(
  client: DocDBClient,
  logger: Logger,
  arn: string,
  oldTagsRaw: CfnTag[] | undefined,
  newTagsRaw: CfnTag[] | undefined
): Promise<void> {
  const toMap = (tags: CfnTag[] | undefined): Map<string, string> => {
    const m = new Map<string, string>();
    for (const t of tags ?? []) {
      if (t.Key !== undefined && t.Value !== undefined) m.set(t.Key, t.Value);
    }
    return m;
  };

  const oldMap = toMap(oldTagsRaw);
  const newMap = toMap(newTagsRaw);

  const tagsToAdd: Array<{ Key: string; Value: string }> = [];
  for (const [k, v] of newMap) {
    if (oldMap.get(k) !== v) tagsToAdd.push({ Key: k, Value: v });
  }
  const tagsToRemove: string[] = [];
  for (const k of oldMap.keys()) {
    if (!newMap.has(k)) tagsToRemove.push(k);
  }

  if (tagsToRemove.length > 0) {
    await client.send(
      new RemoveTagsFromResourceCommand({ ResourceName: arn, TagKeys: tagsToRemove })
    );
    logger.debug(`Removed ${tagsToRemove.length} tag(s) from DocDB resource ${arn}`);
  }
  if (tagsToAdd.length > 0) {
    await client.send(new AddTagsToResourceCommand({ ResourceName: arn, Tags: tagsToAdd }));
    logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on DocDB resource ${arn}`);
  }
}

/**
 * Fetch tags via `ListTagsForResource(ResourceName=arn)` and merge them
 * into the result under `Tags` (CFn shape, `aws:*` filtered out, omitted
 * when empty). Best-effort: tag-fetch failures are logged at debug and
 * the key is simply left out — drift detection on configuration is more
 * important than fail-closing on a missing tag permission.
 */
export async function attachDocDBTags(
  client: DocDBClient,
  logger: Logger,
  result: Record<string, unknown>,
  arn: string
): Promise<void> {
  try {
    const tagsResp = await client.send(new ListTagsForResourceCommand({ ResourceName: arn }));
    result['Tags'] = normalizeAwsTagsToCfn(tagsResp.TagList);
  } catch (err) {
    logger.debug(`DocDB ListTagsForResource(${arn}) failed: ${describeAwsFailure(err).detail}`);
  }
}
