import type { JsonPatchOp } from './json-patch-generator.js';

/**
 * Per type: the top-level keys whose EMPTY read-back value (`{}`, `[]` or `""`)
 * the service's update API refuses (go-to-k/cdkd#6569).
 *
 * Cloud Control applies an update patch on top of the model its read handler
 * returns. For these types that model spells "not set" as an empty
 * value, so a patch that never mentions the key still sends the empty
 * value, and the update fails although the template did not change it:
 *
 * - `AWS::ImageBuilder::InfrastructureConfiguration` `ResourceTags`: a
 *   configuration created without it reads back `"ResourceTags": {}`, and
 *   `UpdateInfrastructureConfiguration` refuses it (`resourceTags length must
 *   satisfy min_items 1`). Its other empty read-backs (`Tags: {}`,
 *   `SecurityGroupIds: []`, `Logging.S3Logs: {}`) were measured to update
 *   fine, so they are not listed.
 * - `AWS::DataSync::Task` `Schedule` and `Name`: a task created without them
 *   (the CDK default) reads back `"Schedule": {}` and `"Name": ""`.
 *   `UpdateTask` refuses the null expression the first becomes (`Value null
 *   at 'schedule.scheduleExpression' failed to satisfy constraint`), and
 *   Cloud Control's own model validation the second (`#/Name: expected
 *   minLength: 1, actual: 0`), go-to-k/cdkd#6676.
 *
 * A type joins by measurement, never by reading its schema: a key is listed
 * only once its empty read-back was seen refused.
 */
export const CC_READ_BACK_EMPTY_KEYS: Readonly<Record<string, readonly string[]>> = {
  'AWS::DataSync::Task': ['Name', 'Schedule'],
  'AWS::ImageBuilder::InfrastructureConfiguration': ['ResourceTags'],
};

/** Whether `resourceType` has keys in {@link CC_READ_BACK_EMPTY_KEYS}. */
export function hasCcReadBackEmptyKeys(resourceType: string): boolean {
  return Object.prototype.hasOwnProperty.call(CC_READ_BACK_EMPTY_KEYS, resourceType);
}

function isEmptyValue(value: unknown): boolean {
  if (value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return value !== null && typeof value === 'object' && Object.keys(value as object).length === 0;
}

/**
 * Extend a Cloud Control update patch with `remove /<key>` for each listed
 * key of the type when ALL hold:
 *
 * - the patch has no op on `/<key>` (the generator emits top-level ops only);
 * - `liveModel` (the Cloud Control read model the patch is applied to) HAS
 *   the key with an empty value: a `remove` on a path the model lacks fails
 *   the whole patch (RFC 6902), and a non-empty value is something AWS holds
 *   and accepts, so it is not touched;
 * - `desired` lacks the key or holds an empty value too. A deploy's desired
 *   bag is the template, which omits it; `cdkd drift --revert`'s is the AWS
 *   snapshot, which may carry the read-back empty value. Either way the
 *   request then omits the key, as a CloudFormation update does.
 *
 * An `add` / `replace` the patch already has on `/<key>` whose value is
 * empty is the same refused request, so it becomes a `remove`
 * while the live model holds the key and is dropped when it does not; any
 * other op there is left as the generator wrote it.
 *
 * Every other type, an empty patch, or nothing to change returns the same
 * array.
 */
export function withCcReadBackEmptyKeyRemovals(
  resourceType: string,
  patch: JsonPatchOp[],
  desired: Record<string, unknown>,
  liveModel: Record<string, unknown> | undefined
): JsonPatchOp[] {
  const keys = hasCcReadBackEmptyKeys(resourceType) ? CC_READ_BACK_EMPTY_KEYS[resourceType]! : [];
  if (keys.length === 0 || patch.length === 0 || liveModel === undefined) return patch;
  let out = patch;
  const extra: JsonPatchOp[] = [];
  for (const key of keys) {
    const path = `/${escapeJsonPointer(key)}`;
    const existing = out.findIndex((op) => op.path === path);
    if (existing !== -1) {
      // An `add` / `replace` OF an empty value is the same refused
      // request (a `drift --revert` restoring a `{}` baseline over tags added
      // out of band): send `remove` instead while the model holds the key,
      // and nothing when it does not (a missing-path remove fails).
      const op = out[existing]!;
      if ((op.op === 'add' || op.op === 'replace') && isEmptyValue(op.value)) {
        out = Object.prototype.hasOwnProperty.call(liveModel, key)
          ? out.map((o, i) => (i === existing ? { op: 'remove', path } : o))
          : out.filter((_, i) => i !== existing);
      }
      continue;
    }
    // An absent key is not an empty value, so it gets no `remove`.
    if (!isEmptyValue(liveModel[key])) continue;
    if (Object.prototype.hasOwnProperty.call(desired, key) && !isEmptyValue(desired[key])) {
      continue;
    }
    extra.push({ op: 'remove', path });
  }
  return extra.length === 0 && out === patch ? patch : [...out, ...extra];
}

/** RFC 6901, as `json-patch-generator.ts` spells the paths it emits. */
function escapeJsonPointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}
