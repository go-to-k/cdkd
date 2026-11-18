import type { JsonPatchOp } from './json-patch-generator.js';

/**
 * Per type: the top-level keys whose EMPTY read-back value (`{}` or `[]`)
 * the service's update API refuses (go-to-k/cdkd#6569).
 *
 * Cloud Control applies an update patch on top of the model its read handler
 * returns. For these types that model spells "not set" as an empty
 * collection, so a patch that never mentions the key still sends the empty
 * value, and the update fails although the template did not change it:
 *
 * - `AWS::ImageBuilder::InfrastructureConfiguration` `ResourceTags`: a
 *   configuration created without it reads back `"ResourceTags": {}`, and
 *   `UpdateInfrastructureConfiguration` refuses it (`resourceTags length must
 *   satisfy min_items 1`). Its other empty read-backs (`Tags: {}`,
 *   `SecurityGroupIds: []`, `Logging.S3Logs: {}`) were measured to update
 *   fine, so they are not listed.
 *
 * A type joins by measurement, never by reading its schema: a key is listed
 * only once its empty read-back was seen refused.
 */
export const CC_READ_BACK_EMPTY_KEYS: Readonly<Record<string, readonly string[]>> = {
  'AWS::ImageBuilder::InfrastructureConfiguration': ['ResourceTags'],
};

/** Whether `resourceType` has keys in {@link CC_READ_BACK_EMPTY_KEYS}. */
export function hasCcReadBackEmptyKeys(resourceType: string): boolean {
  return Object.prototype.hasOwnProperty.call(CC_READ_BACK_EMPTY_KEYS, resourceType);
}

function isEmptyCollection(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return value !== null && typeof value === 'object' && Object.keys(value as object).length === 0;
}

/**
 * Extend a Cloud Control update patch with `remove /<key>` for each listed
 * key of the type when ALL hold:
 *
 * - the patch has no op on `/<key>` (the generator emits top-level ops only,
 *   so a change the template makes there is left as the generator wrote it);
 * - `liveModel` (the Cloud Control read model the patch is applied to) HAS
 *   the key with an empty value: a `remove` on a path the model lacks fails
 *   the whole patch (RFC 6902), and a non-empty value is something AWS holds
 *   and accepts, so it is not touched;
 * - `desired` lacks the key or holds an empty value too. A deploy's desired
 *   bag is the template, which omits it; `cdkd drift --revert`'s is the AWS
 *   snapshot, which may carry the read-back empty value. Either way the
 *   request then omits the key, as a CloudFormation update does.
 *
 * Every other type, an empty patch, or nothing to add returns the same array.
 */
export function withCcReadBackEmptyKeyRemovals(
  resourceType: string,
  patch: JsonPatchOp[],
  desired: Record<string, unknown>,
  liveModel: Record<string, unknown> | undefined
): JsonPatchOp[] {
  const keys = hasCcReadBackEmptyKeys(resourceType) ? CC_READ_BACK_EMPTY_KEYS[resourceType] : [];
  if (keys === undefined || keys.length === 0 || patch.length === 0 || liveModel === undefined) {
    return patch;
  }
  const extra: JsonPatchOp[] = [];
  for (const key of keys) {
    const path = `/${key}`;
    if (patch.some((op) => op.path === path)) continue;
    // An absent key is not an empty collection, so it gets no `remove`.
    if (!isEmptyCollection(liveModel[key])) continue;
    if (Object.prototype.hasOwnProperty.call(desired, key) && !isEmptyCollection(desired[key])) {
      continue;
    }
    extra.push({ op: 'remove', path });
  }
  return extra.length === 0 ? patch : [...patch, ...extra];
}
