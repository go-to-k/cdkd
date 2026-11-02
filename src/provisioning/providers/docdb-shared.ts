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
import type { ProvisioningError } from '../../utils/error-handler.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import { maskerOrIdentity } from '../masked-retry-logger.js';
import { safeMsg } from '../../utils/display-safe.js';
import { planTagDiff, tagPlanWarning } from '../tag-list.js';

/**
 * The failure wrap both DocumentDB providers' create, update and delete
 * catches throw, through a `wrapCaughtError` method of each class (so
 * `gen-update-wrap-coverage` sees the catch as a wrap).
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
 * assumed-role ARN. AWS's own text goes to `debug` through the operation's
 * masker, and the wrap is stamped `markRedactedCause`, so the retry
 * classifiers read the withheld text on the `cause` chain. An "already
 * exists" is restated ({@link relayedNameCollision}), so a create-first
 * replacement still recognises the collision. A cdkd-authored or transport
 * error keeps its text, masked, stamped only when the mask changed it
 * (`wrapMaskedAwsError`, issue #4244); a non-`Error` throw is withheld like an
 * AWS one, unstamped (it has no chain).
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
export function wrapDocDBFailure(
  logger: Logger,
  mask: ((text: string) => string) | undefined,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const m = maskerOrIdentity(mask);
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return wrapMaskedAwsError(m, error, build);
  logger.debug(m(build(m(failure.detail)).message));
  const wrapped = build(`${m(failure.summary)}${relayedNameCollision(failure.detail)}`);
  return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
}

/** A list of strings, or `undefined` when unusable; absent or `null` is empty. */
export function docdbStringList(value: unknown): string[] | undefined {
  if (value == null) return [];
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === 'string') ? (value as string[]) : undefined;
}

/**
 * The ModifyDBCluster `CloudwatchLogsExportConfiguration` taking the cluster
 * from `previous` to `desired`, or `undefined` when they name the same types.
 * ModifyDBCluster takes a delta where CreateDBCluster takes the list.
 */
export function docdbLogExportChange(
  desired: readonly string[],
  previous: readonly string[]
): { EnableLogTypes?: string[]; DisableLogTypes?: string[] } | undefined {
  const enable = [...new Set(desired)].filter((type) => !previous.includes(type));
  const disable = [...new Set(previous)].filter((type) => !desired.includes(type));
  if (enable.length === 0 && disable.length === 0) return undefined;
  return {
    ...(enable.length > 0 && { EnableLogTypes: enable }),
    ...(disable.length > 0 && { DisableLogTypes: disable }),
  };
}

function cfnCapacity(value: unknown): number | undefined {
  const usable = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
  const capacity = usable ? Number(value) : Number.NaN;
  return Number.isFinite(capacity) ? capacity : undefined;
}

/**
 * The SDK's `ServerlessV2ScalingConfiguration`: `undefined` when absent, `null`
 * when the block is unusable. A CFn number may arrive as a numeric string;
 * anything else is no capacity (`Number` would read `''` as 0 and `true` as 1,
 * and send a value nobody declared).
 */
export function docdbServerlessScaling(
  value: unknown
): { MinCapacity: number; MaxCapacity: number } | null | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const { MinCapacity, MaxCapacity } = value as Record<string, unknown>;
  const min = cfnCapacity(MinCapacity);
  const max = cfnCapacity(MaxCapacity);
  if (min === undefined || max === undefined) return null;
  return { MinCapacity: min, MaxCapacity: max };
}

/** Whether a `PendingModifiedValues` holds anything: AWS answers an idle instance with `{}`. */
export function holdsDocDBPendingValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'object') return Object.values(value).some(holdsDocDBPendingValue);
  return true;
}

export function isDocDBNotFoundError(error: unknown, faultName: string): boolean {
  if (!(error instanceof Error)) return false;
  const name = (error as { name?: string }).name ?? '';
  const message = error.message.toLowerCase();
  return name === faultName || message.includes('not found') || message.includes('does not exist');
}

/**
 * Apply a diff between old and new CFn-shape Tags arrays via DocDB's
 * `AddTagsToResource` / `RemoveTagsFromResource` APIs (keyed by
 * `ResourceName=arn`). Both sides are read through `planTagDiff`
 * (go-to-k/cdkd#3994): an unreadable record untags nothing.
 */
export async function applyDocDBTagDiff(
  client: DocDBClient,
  logger: Logger,
  arn: string,
  resourceType: string,
  logicalId: string,
  oldTagsRaw: unknown,
  newTagsRaw: unknown
): Promise<void> {
  const plan = planTagDiff(oldTagsRaw, newTagsRaw);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    logger.warn(tagWarning);
  }
  const tagsToAdd = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
  const tagsToRemove = plan.remove;

  if (tagsToRemove.length > 0) {
    await client.send(
      new RemoveTagsFromResourceCommand({ ResourceName: arn, TagKeys: tagsToRemove })
    );
    logger.debug(safeMsg`Removed ${tagsToRemove.length} tag(s) from DocDB resource ${arn}`);
  }
  if (tagsToAdd.length > 0) {
    await client.send(new AddTagsToResourceCommand({ ResourceName: arn, Tags: tagsToAdd }));
    logger.debug(safeMsg`Added/updated ${tagsToAdd.length} tag(s) on DocDB resource ${arn}`);
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
    logger.debug(
      safeMsg`DocDB ListTagsForResource(${arn}) failed: ${describeAwsFailure(err).detail}`
    );
  }
}
