/**
 * Shared helpers for `ResourceProvider.import` implementations.
 *
 * A provider adopts an already-deployed resource into cdkd state by resolving
 * its physical id in this order:
 *
 *   1. If `input.knownPhysicalId` is set (user passed
 *      `--resource <logicalId>=<physicalId>`), trust it as ground truth and
 *      only fetch attributes.
 *   2. If the template's `properties` carries an explicit name field
 *      (`BucketName`, `FunctionName`, `RoleName`, …), use that as the
 *      physical id directly (or match it against a `List*` walk when the
 *      service has no direct `Get<Name>`).
 *
 * Both steps are generic enough to live here. There is deliberately no
 * `aws:cdk:path` tag step: AWS rejects `aws:`-prefixed tag writes, so that
 * tag never exists on a real resource and a walk keyed on it could not match
 * (issue #1134). Auto-mode import resolves any remaining ids from a same-named
 * CloudFormation stack's `DescribeStackResources` (issue #1128 / #1130),
 * handled in `src/cli/commands/import.ts`, not per provider.
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
 * Re-shape an AWS tag list (any of the common shapes — array of `{Key, Value}`,
 * map keyed by tag name, or v2-style array of `{TagKey, TagValue}`) into the
 * canonical CFn shape (`Array<{Key, Value}>`) that cdkd state holds, with
 * `aws:`-prefixed entries filtered out.
 *
 * AWS reserves the `aws:` tag prefix; CDK injects `aws:cdk:path` (and
 * sometimes `aws:cdk:metadata`) on every resource it deploys. Those tags are
 * NOT in cdkd state's `Tags` (they come from CDK template `Metadata`, not
 * `Properties.Tags`), so leaving them in the AWS-current snapshot would fire
 * false-positive drift on every CDK-deployed resource.
 *
 * Returns an empty array `[]` when AWS reports no user tags. Callers decide
 * whether to surface `Tags: []` (most providers — matches the typical
 * CFn behavior of always emitting Tags in templates) or omit the key
 * entirely (when the corresponding `create()` only sets Tags when the user
 * explicitly passes them — see each provider's docstring).
 */
export function normalizeAwsTagsToCfn(
  tags:
    | readonly AwsTag[]
    | readonly { TagKey?: string | undefined; TagValue?: string | undefined }[]
    | readonly { key?: string | undefined; value?: string | undefined }[]
    | Record<string, string | undefined>
    | undefined
    | null
): Array<{ Key: string; Value: string }> {
  if (!tags) return [];
  const out: Array<{ Key: string; Value: string }> = [];
  if (Array.isArray(tags)) {
    for (const t of tags) {
      // Support {Key,Value} (most services), {TagKey,TagValue} (RDS/DocDB),
      // and {key,value} (Step Functions / Glue / etc., lower-case).
      const obj = t as Record<string, unknown>;
      const k =
        (typeof obj['Key'] === 'string' ? obj['Key'] : undefined) ??
        (typeof obj['TagKey'] === 'string' ? obj['TagKey'] : undefined) ??
        (typeof obj['key'] === 'string' ? obj['key'] : undefined);
      const v =
        (typeof obj['Value'] === 'string' ? obj['Value'] : undefined) ??
        (typeof obj['TagValue'] === 'string' ? obj['TagValue'] : undefined) ??
        (typeof obj['value'] === 'string' ? obj['value'] : undefined);
      if (typeof k !== 'string' || k.length === 0) continue;
      if (k.startsWith('aws:')) continue;
      out.push({ Key: k, Value: typeof v === 'string' ? v : '' });
    }
  } else {
    for (const [k, v] of Object.entries(tags)) {
      if (!k || k.startsWith('aws:')) continue;
      out.push({ Key: k, Value: typeof v === 'string' ? v : '' });
    }
  }
  // Sort by Key for stable comparison against state (CDK templates
  // produce sorted Tags; AWS API responses are unordered).
  out.sort((a, b) => (a.Key < b.Key ? -1 : a.Key > b.Key ? 1 : 0));
  return out;
}
