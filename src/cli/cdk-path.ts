import type { CloudFormationTemplate, TemplateResource } from '../types/resource.js';

/**
 * Read the `aws:cdk:path` value that CDK encodes into every resource's
 * `Metadata`. Returns the empty string when not present so callers don't
 * have to special-case `undefined`.
 *
 * Hoisted out of `src/cli/commands/import.ts` so `cdkd orphan` can reuse the
 * same lookup without duplicating the metadata-walking code.
 */
export function readCdkPath(resource: TemplateResource): string {
  const meta = resource.Metadata;
  if (!meta) return '';
  const v = (meta as { 'aws:cdk:path'?: unknown })['aws:cdk:path'];
  return typeof v === 'string' ? v : '';
}

/**
 * Build a `Map<cdkPath, logicalId>` from a synthesized template.
 *
 * Used by `cdkd orphan <constructPath>` to translate user-supplied
 * construct paths (which mirror the upstream `cdk orphan` UX) back to the
 * logical IDs that the rest of the pipeline (state, dependency analysis,
 * provider lookup) is keyed on.
 *
 * `AWS::CDK::Metadata` resources are excluded — the synthesized
 * `<Stack>/CDKMetadata/Default` sentinel exists in every stack but is
 * never user-managed, so listing it as an "available path" in the
 * not-found error is just noise and orphaning it is meaningless.
 *
 * Resources without a `aws:cdk:path` metadata entry are silently skipped
 * for the same reason — they cannot be addressed by construct path.
 *
 * In practice each path maps to a single logical ID. If the same path
 * happens to appear twice (which would itself be a bug in the synthesized
 * template), the last entry wins — `cdkd orphan` will still surface a
 * clean "path not found" diff against the indexed map rather than
 * silently grabbing both.
 */
export function buildCdkPathIndex(template: CloudFormationTemplate): Map<string, string> {
  const index = new Map<string, string>();
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Type === 'AWS::CDK::Metadata') continue;
    const path = readCdkPath(resource);
    if (path) index.set(path, logicalId);
  }
  return index;
}

/**
 * Resolve a user-supplied construct path to every logical ID it covers.
 *
 * Mirrors `cdk orphan --unstable=orphan` (`packages/@aws-cdk/toolkit-lib/
 * lib/api/orphan/orphaner.ts` line 90 in aws-cdk-cli): users typically
 * pass an L2 path like `MyStack/MyConstruct/MyBucket` rather than the
 * synthesized L1 path `MyStack/MyConstruct/MyBucket/Resource`, and an L2
 * with multiple children (e.g. a CDK pattern that wraps several CFn
 * resources) should orphan all of them in one go.
 *
 * Match rule: a resource matches `input` when its `aws:cdk:path` is
 * exactly `input` OR starts with `${input}/`. The trailing slash matters
 * — without it `MyStack/MyBucket` would also match
 * `MyStack/MyBucketBackup/Resource`.
 */
export function resolveCdkPathToLogicalIds(
  input: string,
  index: Map<string, string>
): { logicalId: string; cdkPath: string }[] {
  const seen = new Map<string, string>();
  const prefix = `${input}/`;
  for (const [path, logicalId] of index) {
    if (path === input || path.startsWith(prefix)) {
      if (!seen.has(logicalId)) seen.set(logicalId, path);
    }
  }
  return [...seen.entries()].map(([logicalId, cdkPath]) => ({ logicalId, cdkPath }));
}
