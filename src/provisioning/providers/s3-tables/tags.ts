import type { S3TablesProvider } from '../s3-tables-provider.js';
import {
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-s3tables';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { compositeIdFormatMessage } from '../../composite-id.js';
import { planTagDiff, tagPlanWarning, type CfnTagEntry } from '../../tag-list.js';
import { pasteableCommand } from '../../../utils/pasteable-command.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { S3_TABLES_TABLE_ID_FORMAT, sentence } from './shared.js';

// ─── Tag helpers (#609 backfill for AWS::S3Tables::Table) ─────────

/**
 * Convert a well-formed CFn tag list (already read through `tag-list.ts`)
 * to the S3Tables SDK's `Record<string, string>` shape. Returns `undefined`
 * for an empty list so the caller can omit the field from the create call
 * — the SDK rejects an empty `tags: {}` map with InvalidRequestException.
 */
export function tagListToSdkMap(
  this: S3TablesProvider,
  tags: CfnTagEntry[]
): Record<string, string> | undefined {
  if (tags.length === 0) return undefined;
  const map: Record<string, string> = {};
  for (const t of tags) map[t.Key] = t.Value;
  return map;
}

/**
 * Best-effort tag readback. ListTagsForResource against a freshly-
 * created table can briefly 404 due to eventual consistency; emit
 * `[]` on any failure rather than propagate (matches the S3Vectors /
 * CloudFront patterns and keeps the drift comparator happy).
 */
export async function readTagsBestEffort(
  this: S3TablesProvider,
  resourceArn: string
): Promise<Array<{ Key: string; Value: string }>> {
  try {
    const resp = await this.getClient().send(new ListTagsForResourceCommand({ resourceArn }));
    // S3Tables' ListTagsForResource returns `tags: Record<string, string>`
    // (a flat map), not an array of {Key, Value} objects. Reshape to CFn's
    // canonical array form for drift-comparison parity.
    const tags = resp.tags ?? {};
    const out: Array<{ Key: string; Value: string }> = [];
    for (const [Key, Value] of Object.entries(tags)) {
      out.push({ Key, Value });
    }
    return out;
  } catch (err) {
    this.logger.debug(
      `readTagsBestEffort: ListTagsForResource failed for ${resourceArn}: ${describeAwsFailure(err).detail} — emitting Tags: []`
    );
    return [];
  }
}

/**
 * Apply a tag-diff against a Table resource ARN: keys present in
 * `previousTags` but absent / value-changed in `newTags` go through
 * `UntagResource`, then the full upsert set (additions + value
 * rewrites) goes through `TagResource`. Removal runs FIRST so a
 * value-only rewrite on key K isn't accidentally cleared by a stale
 * UntagResource pass (matches the CloudFront / S3Vectors pattern).
 *
 * Tag-side failures THROW `ProvisioningError` (issue #740 fix): a
 * silent swallow would let the deploy engine write the new properties.Tags
 * to state as if applied, and the next deploy's diff (template Tags
 * vs new state Tags) sees no change → tag-diff never re-fires → AWS
 * tags stay stale forever. Throwing means: (a) state is NOT written,
 * (b) the next deploy retries the tag-diff against the still-old
 * state. The deploy engine's `withRetry` MAY pick up transient AWS
 * errors via the cause-message-pattern match in `retryable-errors.ts`,
 * but bare HTTP 429 throttles can slip past the classifier's
 * single-level `.cause` walk depending on wrapping — so the
 * **load-bearing retry guarantee is the next-deploy retry**, not
 * in-deploy retry. For the S3Tables Table case `update()` is
 * otherwise a no-op (the Table itself is immutable), so a tag-side
 * throw cleanly turns the whole update into a retry without
 * side-effects.
 *
 * The malformed-physicalId / GetTable-NotFound branches throw too
 * — both indicate a state-vs-AWS divergence the user needs to see,
 * not silently skip past.
 */
export async function applyTableTagsDiff(
  this: S3TablesProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  previousTags: unknown,
  newTags: unknown,
  mask: ((text: string) => string) | undefined
): Promise<void> {
  // Both sides are read through `planTagDiff` (go-to-k/cdkd#3994): an
  // unreadable record untags nothing.
  const plan = planTagDiff(previousTags, newTags);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  const removedKeys = plan.remove;
  const upserts: Record<string, string> = Object.fromEntries(plan.set);

  // No tag delta → no work, no error.
  if (removedKeys.length === 0 && Object.keys(upserts).length === 0) return;

  // Accepts cdkd's composite AND CloudFormation's bare TableARN, like the
  // delete / read paths — an imported row can carry either.
  const resolvedParts = await this.resolveTableParts(physicalId);
  if (resolvedParts === 'not-found') {
    throw new ProvisioningError(
      `applyTableTagsDiff: table '${physicalId}' no longer exists (state is out of sync) — ` +
        `refusing to silently drop the tag update`,
      resourceType,
      logicalId,
      physicalId
    );
  }
  if (resolvedParts === 'unparseable') {
    throw new ProvisioningError(
      `applyTableTagsDiff: ` +
        `${compositeIdFormatMessage(S3_TABLES_TABLE_ID_FORMAT, logicalId, physicalId)}. ` +
        `Cannot derive the table ARN for the tag update, and refusing to silently drop it.`,
      resourceType,
      logicalId,
      physicalId
    );
  }
  const { tableBucketARN, namespace, name } = resolvedParts;

  // Tag APIs need the REAL table ARN (not cdkd's compound physical id
  // and not a guessed derivation from the parts — AWS rejects every
  // form except its own). Look it up via GetTable.
  const resourceArn = await this.lookupTableArn(tableBucketARN, namespace, name);
  if (!resourceArn) {
    throw new ProvisioningError(
      // The command is NOT inside the prose `'...'` span: an operator
      // selects that span WITH its quotes, and an interpolated value carrying
      // `'` then closes the wrapper so the rest runs as shell
      // (go-to-k/cdkd#3363 measured it; go-to-k/cdkd#3436 owns the class).
      //
      // It names `cdkd orphan`, and the COMMAND was wrong before review
      // caught it (M1 of the go-to-k/cdkd#3613 review): the line passed this
      // TABLE's logical id to `cdkd state orphan`, which declares
      // `<stacks...>` and drops a WHOLE stack's record -- in every region
      // when no `--stack-region` is given. Moving a command out of the
      // injection class says nothing about whether it MEANS anything, and a
      // shape fence cannot see the difference; only reading it can. It is the
      // same defect as the `cdkd import` positional this PR fixes one file
      // over.
      //
      // The per-resource command is `cdkd orphan <paths...>`, which takes
      // CONSTRUCT PATHS. This provider has a logical id and a physical id and
      // no construct path, so the target is a quoted HOLE rather than a value
      // it would have to invent -- inert when pasted, and the sentence says
      // where to read it. It names the template's `aws:cdk:path` Metadata and
      // NOT `cdkd list`: that command lists STACKS, so its paths cannot
      // supply a resource target (review caught the first wording).
      safeMsg`applyTableTagsDiff: GetTable returned no tableARN for ${physicalId} — table is gone ` +
        `or state is out-of-sync. Refusing to silently drop the tag update. If the table was ` +
        `deleted out-of-band, drop just this resource's record with the command below, ` +
        `filling in the construct path the CDK app gave this resource — its aws:cdk:path ` +
        `Metadata entry in the synthesized template.` +
        `\nClean up with: ${pasteableCommand('cdkd orphan', [{ hole: 'constructPath' }]).command}`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  if (removedKeys.length > 0) {
    try {
      await this.getClient().send(new UntagResourceCommand({ resourceArn, tagKeys: removedKeys }));
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw this.wrapCaughtError(
        mask,
        err,
        (text) =>
          new ProvisioningError(
            `applyTableTagsDiff: UntagResource failed for ${resourceArn} (keys: ${removedKeys.join(', ')}): ${sentence(text)} State has NOT been updated so the next deploy will retry the tag-diff.`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  if (Object.keys(upserts).length > 0) {
    try {
      await this.getClient().send(new TagResourceCommand({ resourceArn, tags: upserts }));
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw this.wrapCaughtError(
        mask,
        err,
        (text) =>
          new ProvisioningError(
            `applyTableTagsDiff: TagResource failed for ${resourceArn} (keys: ${Object.keys(upserts).join(', ')}): ${sentence(text)} State has NOT been updated so the next deploy will retry the tag-diff.`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }
}

/**
 * Apply a tag-diff against a TableBucket resource ARN. Mirrors
 * `applyTableTagsDiff` for the Table case, but simpler: TableBucket's
 * `physicalId` IS the bucket ARN, so no `GetTableBucket` lookup hop
 * is needed (the Table version needs `GetTable` to recover the real
 * ARN from the cdkd-compound `<bucketArn>|<namespace>|<name>` physical id).
 *
 * Same throw semantics as `applyTableTagsDiff` (per issue #740 / PR
 * #741): tag-side failures THROW `ProvisioningError` so state is NOT
 * written, and the next deploy retries against the still-old state.
 * `update()` for AWS::S3Tables::TableBucket is otherwise a no-op (the
 * bucket itself is immutable), so a tag-side throw cleanly turns the
 * whole update into a clean retry with no side-effects.
 */
export async function applyTableBucketTagsDiff(
  this: S3TablesProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  previousTags: unknown,
  newTags: unknown,
  mask: ((text: string) => string) | undefined
): Promise<void> {
  // Both sides are read through `planTagDiff` (go-to-k/cdkd#3994): an
  // unreadable record untags nothing.
  const plan = planTagDiff(previousTags, newTags);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  const removedKeys = plan.remove;
  const upserts: Record<string, string> = Object.fromEntries(plan.set);

  // No tag delta → no work, no error.
  if (removedKeys.length === 0 && Object.keys(upserts).length === 0) return;

  // physicalId IS the bucket ARN — use it directly for tag ops.
  const resourceArn = physicalId;

  if (removedKeys.length > 0) {
    try {
      await this.getClient().send(new UntagResourceCommand({ resourceArn, tagKeys: removedKeys }));
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw this.wrapCaughtError(
        mask,
        err,
        (text) =>
          new ProvisioningError(
            `applyTableBucketTagsDiff: UntagResource failed for ${resourceArn} (keys: ${removedKeys.join(', ')}): ${sentence(text)} State has NOT been updated so the next deploy will retry the tag-diff.`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  if (Object.keys(upserts).length > 0) {
    try {
      await this.getClient().send(new TagResourceCommand({ resourceArn, tags: upserts }));
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      throw this.wrapCaughtError(
        mask,
        err,
        (text) =>
          new ProvisioningError(
            `applyTableBucketTagsDiff: TagResource failed for ${resourceArn} (keys: ${Object.keys(upserts).join(', ')}): ${sentence(text)} State has NOT been updated so the next deploy will retry the tag-diff.`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }
}
