/**
 * Shared helpers for `ResourceProvider.import` implementations.
 *
 * Most providers follow the same lookup pattern when adopting an
 * already-deployed resource into cdkd state:
 *
 *   1. If `input.knownPhysicalId` is set (user passed
 *      `--resource <logicalId>=<physicalId>`), trust it as ground truth and
 *      only fetch attributes.
 *   2. If the template's `properties` carries an explicit name field
 *      (`BucketName`, `FunctionName`, `RoleName`, …), use that as the
 *      physical id directly.
 *   3. Walk the service's `List*` API and match against the `aws:cdk:path`
 *      tag — every CDK-deployed resource carries one.
 *
 * Step 1 + 2 are generic enough to live here. Step 3 needs per-service
 * `List*` + `ListTags*` calls and lives in each provider.
 */

import type { ResourceImportInput } from '../types/resource.js';

/**
 * Read an explicit name field from template properties. Returns `undefined`
 * when the property is missing or not a string — callers fall back to
 * tag-based lookup in that case.
 */
export function readNameProperty(
  input: ResourceImportInput,
  propertyName: string
): string | undefined {
  const value = input.properties?.[propertyName];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Resolve the physical id when the template provides an explicit name OR the
 * caller passed `--resource`/`--resource-mapping`. Returns `undefined` when
 * neither shortcut applies — caller must then fall back to tag-based lookup.
 *
 * Does NOT verify the resource exists: callers should follow up with a
 * service-specific `Head*`/`Get*`/`Describe*` to fail fast if the named
 * resource is missing.
 */
export function resolveExplicitPhysicalId(
  input: ResourceImportInput,
  nameProperty: string | null
): string | undefined {
  if (input.knownPhysicalId) return input.knownPhysicalId;
  if (nameProperty) {
    const name = readNameProperty(input, nameProperty);
    if (name) return name;
  }
  return undefined;
}

/**
 * The standard tag CDK puts on every deployed resource — its construct path
 * within the app, e.g. `MyStack/MyConstruct/MyBucket`. Used as the lookup key
 * when no explicit name is in the template.
 */
export const CDK_PATH_TAG = 'aws:cdk:path';

/**
 * Loose tag shape used by every AWS service (`{Key, Value}`).
 *
 * Both Key and Value are typed as `string | undefined` rather than `string?`
 * so this interface accepts AWS SDK v3 `Tag` types verbatim under
 * `exactOptionalPropertyTypes: true` (the SDK types declare them as
 * `Key?: string | undefined`, not `Key?: string`).
 */
export interface AwsTag {
  Key?: string | undefined;
  Value?: string | undefined;
}

/**
 * Match an AWS resource's tag set against the CDK path the template carries.
 * Returns true if the resource was deployed by the same CDK construct.
 */
export function matchesCdkPath(tags: readonly AwsTag[] | undefined, cdkPath: string): boolean {
  if (!tags || !cdkPath) return false;
  for (const t of tags) {
    if (t.Key === CDK_PATH_TAG && t.Value === cdkPath) return true;
  }
  return false;
}
