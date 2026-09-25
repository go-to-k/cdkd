/**
 * The ONE parse of a registry schema's `createOnlyProperties` JSON pointers
 * into property paths (issue #3718).
 *
 * Shared by the live resolver (`create-only-properties.ts`, parsing a
 * `DescribeType` schema) and the fixture producer
 * (`scripts/refresh-cfn-schemas.mjs`, whose output is shipped as the offline
 * fallback). A second spelling would let the fallback disagree with the live
 * answer for the same schema. An import-free LEAF, so the `.mjs` producer can
 * load it under Node's type stripping.
 */

/**
 * Parse `createOnlyProperties` into segment arrays after `/properties/` (e.g.
 * `['Name']`, `['SourceParameters', 'KinesisStreamParameters',
 * 'StartingPosition']`), in schema order.
 *
 * Full paths, not top-level reductions: the diff compares at the schema's own
 * granularity (issue #960). A non-array input or a non-string / non-
 * `/properties/` entry is skipped. Empty segments are dropped: a trailing slash
 * degrades to the (more conservative) whole-property path, and no real
 * registry schema names a property literally "" via an RFC 6901 empty segment.
 */
export function parseCreateOnlyPropertyPointers(createOnly: unknown): string[][] {
  const result: string[][] = [];
  if (!Array.isArray(createOnly)) return result;
  for (const path of createOnly) {
    if (typeof path !== 'string') continue;
    if (!path.startsWith('/properties/')) continue;
    const segments = path
      .slice('/properties/'.length)
      .split('/')
      .map(unescapeJsonPointerSegment)
      .filter((segment) => segment.length > 0);
    if (segments.length > 0) {
      result.push(segments);
    }
  }
  return result;
}

/**
 * Unescape an RFC 6901 JSON Pointer segment (`~1` -> `/`, `~0` -> `~`).
 */
function unescapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}
