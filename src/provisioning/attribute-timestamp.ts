/**
 * go-to-k/cdkd#6242: a timestamp AWS returned, as the ISO-8601 text a
 * `Fn::GetAtt` serves — `2026-11-14T07:49:04Z`, with the millisecond fraction
 * only when AWS sent one (`2026-11-14T07:53:01.825Z`).
 *
 * `Date#toISOString()` always prints `.000`; CloudFormation's text for an
 * API that answers whole seconds (S3 Vectors `creationTime`, IAM's
 * `CreateDate` / `UpdateDate`) has no fraction, so a zero fraction is dropped.
 * `undefined` for a value that is not a valid `Date`, so `definedAttributes`
 * leaves the key absent.
 *
 * A LEAF module (imports nothing), like `attribute-map.ts`.
 */
export function isoTimestampAttribute(value: Date | undefined | null): string | undefined {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return undefined;
  return value.toISOString().replace(/\.000Z$/, 'Z');
}
