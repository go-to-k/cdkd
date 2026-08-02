/**
 * Shared helpers for detecting a template-borne "destroy my data" opt-in on
 * resources whose delete API fails by default while they still hold data
 * (issue #1340).
 *
 * CloudFormation fails the delete of a non-empty S3 bucket / image-carrying
 * ECR repository and the user opts into force-cleanup explicitly (CDK's
 * `autoDeleteObjects` custom resource + tag, `emptyOnDelete` /
 * `EmptyOnDelete: true`). cdkd honors exactly those signals — plus the
 * deploy engine's `--force-stateful-recreation` consent, threaded via
 * `DeleteContext.forceDataDelete` — instead of force-cleaning every
 * resource unconditionally.
 */

/**
 * Tag key CDK's `aws-s3.Bucket` sets when `autoDeleteObjects: true`.
 * The tag is what the AutoDeleteObjects custom-resource handler itself
 * checks before emptying, so it is the canonical opt-in marker.
 */
export const S3_AUTO_DELETE_OBJECTS_TAG = 'aws-cdk:auto-delete-objects';

/**
 * Tag key CDK's `aws-ecr.Repository` sets when `autoDeleteImages: true`
 * (the pre-`emptyOnDelete` opt-in; both signals are honored).
 */
export const ECR_AUTO_DELETE_IMAGES_TAG = 'aws-cdk:auto-delete-images';

/**
 * True when the resource's CFn `Tags` list carries `tagKey` with a truthy
 * value. Tolerates the CFn boolean-as-string shape (`"true"`).
 */
export function hasCdkAutoDeleteTag(
  properties: Record<string, unknown> | undefined,
  tagKey: string
): boolean {
  const tags = properties?.['Tags'];
  if (!Array.isArray(tags)) return false;
  return tags.some((tag) => {
    if (typeof tag !== 'object' || tag === null) return false;
    const entry = tag as { Key?: unknown; Value?: unknown };
    return entry.Key === tagKey && isTruthyCfnBoolean(entry.Value);
  });
}

/**
 * CFn booleans arrive as `true` or the string `"true"` depending on how the
 * template was authored / resolved; treat both as true.
 */
export function isTruthyCfnBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}
