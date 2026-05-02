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
 * Resources without a `aws:cdk:path` metadata entry are silently skipped:
 * the AWS::CDK::Metadata sentinel never has one, and any other resource
 * without a path can't be addressed by construct path anyway.
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
    const path = readCdkPath(resource);
    if (path) index.set(path, logicalId);
  }
  return index;
}
