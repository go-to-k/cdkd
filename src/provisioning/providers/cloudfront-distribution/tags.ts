import type { CloudFrontDistributionProvider } from '../cloudfront-distribution-provider.js';
import { TagResourceCommand, UntagResourceCommand, type Tag } from '@aws-sdk/client-cloudfront';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { SecretMasker } from '../../../types/resource.js';
import { planTagDiff, tagPlanWarning, type CfnTagEntry } from '../../tag-list.js';

/**
 * Convert the well-formed CFn tag list `refuseMalformedDesiredTags`
 * returned to the CloudFront SDK's `Tag[]` shape (the same `{ Key, Value }`
 * per-entry shape; a repeated Key keeps its last Value, as the update diff
 * does). Returns `undefined` when the list is empty so the caller can route
 * to `CreateDistributionCommand` instead of
 * `CreateDistributionWithTagsCommand` — passing an empty `Tags.Items: []`
 * to the latter is a silent no-op but uses the tags-enabled control-plane
 * path for nothing.
 */
export function toSdkTags(
  this: CloudFrontDistributionProvider,
  tags: CfnTagEntry[]
): Tag[] | undefined {
  const map = new Map(tags.map((t) => [t.Key, t.Value] as const));
  if (map.size === 0) return undefined;
  return [...map.entries()].map(([Key, Value]) => ({ Key, Value }));
}

/**
 * Compute the (removed-keys, upserted-tags) diff between two CFn `Tags`
 * snapshots through `planTagDiff` (go-to-k/cdkd#3994): an unreadable
 * record removes nothing and upserts every desired tag, with a warning.
 * Does NOT touch AWS, so the caller can decide on the basis of the result
 * whether the ARN is actually needed (no diff = no ARN required).
 */
export function computeTagDiff(
  this: CloudFrontDistributionProvider,
  previousTags: unknown,
  newTags: unknown,
  resourceType: string,
  logicalId: string
): { removed: string[]; upserts: Tag[] } {
  const plan = planTagDiff(previousTags, newTags);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  const upserts: Tag[] = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
  return { removed: plan.remove, upserts };
}

/**
 * Apply a tag diff to a distribution.
 *
 * CloudFront has no atomic overlay API for tags — `TagResource` adds /
 * overwrites and `UntagResource` removes. Run the removal first, then
 * the upsert, so a same-key value rewrite (which lands in `upserts`)
 * is not accidentally cleared by a stale Untag.
 *
 * Errors are RETHROWN as `ProvisioningError` (issue #740 fix) so the
 * deploy engine sees a failed update() and (a) does NOT write the new
 * properties.Tags into state — the next deploy retries the tag-diff
 * against the still-old state, (b) surfaces the failure to the user
 * via the standard error path. The deploy engine's `withRetry` MAY
 * pick up some transient AWS errors via the cause-message-pattern
 * match (`retryable-errors.ts`'s `RETRYABLE_ERROR_MESSAGE_PATTERNS`),
 * but bare HTTP 429 throttles wrapped by update()'s outer catch reach
 * the classifier two levels deep and slip past its single-level
 * `.cause` walk — so the **load-bearing retry guarantee is the
 * next-deploy retry**, not in-deploy retry. This is acceptable: the
 * user sees the failure, can react, and the next `cdkd deploy`
 * re-fires the tag-diff against the still-old state cleanly.
 *
 * Trade-off: a tag-side failure flips an otherwise-successful
 * `UpdateDistribution` into a deploy failure, and the retry will
 * re-issue UpdateDistribution against the (now-current) config —
 * AWS accepts the no-op idempotently. The cost of that secondary
 * noise is much lower than the cost of silent tag drift the pre-#740
 * swallow caused.
 *
 * The ARN is unexpectedly absent only on a hypothetical SDK regression
 * (`GetDistribution` returns ARN as a required string in every SDK
 * shape verified so far). When that happens AND a tag delta exists,
 * THROW so the silent-drop does not silently resurface; when no delta
 * exists, return without needing ARN.
 */
export async function applyTagDiff(
  this: CloudFrontDistributionProvider,
  arn: string | undefined,
  previousTags: unknown,
  newTags: unknown,
  physicalId: string,
  logicalId: string,
  resourceType: string,
  mask?: SecretMasker
): Promise<void> {
  const { removed, upserts } = this.computeTagDiff(previousTags, newTags, resourceType, logicalId);
  if (removed.length === 0 && upserts.length === 0) return;

  if (!arn) {
    throw new ProvisioningError(
      `CloudFront Distribution ${physicalId}: GetDistribution returned no ARN; ` +
        `cannot apply tag diff (removed=${removed.length}, upserts=${upserts.length}). ` +
        `Refusing to silently drop the tag update — retry on next deploy or check SDK version.`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  try {
    if (removed.length > 0) {
      this.logger.debug(`Untagging CloudFront Distribution ${arn}: ${removed.join(', ')}`);
      await this.cloudFrontClient.send(
        new UntagResourceCommand({
          Resource: arn,
          TagKeys: { Items: removed },
        })
      );
    }
    if (upserts.length > 0) {
      this.logger.debug(
        `Tagging CloudFront Distribution ${arn}: ${upserts.map((t) => t.Key).join(', ')}`
      );
      await this.cloudFrontClient.send(
        new TagResourceCommand({
          Resource: arn,
          Tags: { Items: upserts },
        })
      );
    }
  } catch (err) {
    const cause = err instanceof Error ? err : undefined;
    // A redacted summary already ends its sentence (the `--verbose` pointer).
    throw this.wrapCaughtError(
      mask,
      err,
      (text) =>
        new ProvisioningError(
          `CloudFront Distribution ${physicalId}: tag diff failed (removed=${removed.length}, ` +
            `upserts=${upserts.length}): ${text}${text.endsWith('.') ? '' : '.'} ` +
            `UpdateDistribution succeeded but TagResource/UntagResource did not — state has NOT been updated so the next deploy will retry the tag-diff.`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
