/**
 * If `value` is a `{ Ref: <string> }` intrinsic, return the referenced
 * logical ID. Otherwise return `null`.
 *
 * Shared across the `src/local/*` resolvers (route discovery, authorizer
 * resolution, stage attachment) so future intrinsic-shape extensions
 * (e.g. accepting `Fn::Sub`-bound Refs in REST v1 ResourceId / ParentId)
 * land in one place instead of three.
 */
export function pickRefLogicalId(value: unknown): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const ref = (value as Record<string, unknown>)['Ref'];
    if (typeof ref === 'string') return ref;
  }
  return null;
}
