import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { resolveBucketRegion } from '../utils/aws-region-resolver.js';

/**
 * CloudFormation `TemplateBody` hard limit (51,200 bytes). Templates larger
 * than this cannot be submitted inline and must be uploaded to S3 and
 * referenced via `TemplateURL` instead — see {@link uploadCfnTemplate}.
 */
export const CFN_TEMPLATE_BODY_LIMIT = 51_200;

/**
 * CloudFormation `TemplateURL` hard limit (1 MB / 1,048,576 bytes).
 * Templates larger than this are structurally unsubmittable through any
 * CloudFormation API — no S3 indirection helps. The caller surfaces a
 * pre-flight error pointing the user at template-splitting (nested stacks)
 * or shrinking inline asset payloads (`lambda.Code.fromAsset`).
 */
export const CFN_TEMPLATE_URL_LIMIT = 1_048_576;

/**
 * Shared S3 key prefix for transient CFn templates uploaded by `cdkd import
 * --migrate-from-cloudformation` and `cdkd export`. Kept distinct from
 * cdkd's `cdkd/` state prefix so `state list` / `state info` never conflate
 * transient migration artifacts with persisted stack state. The prefix is
 * intentionally human-grep-able — leftovers (if cleanup fails) point
 * straight at the offending stack name.
 *
 * Re-used by both commands so operator-facing audit trails (CloudTrail
 * records of the migrate-tmp uploads) stay consistent across the two
 * flows.
 */
export const MIGRATE_TMP_PREFIX = 'cdkd-migrate-tmp';

/**
 * AWS auth context used to build a region-correct S3 client for the
 * transient template upload + delete. The caller threads through the same
 * `{profile, credentials}` it resolved at command startup so the upload
 * uses the same identity that wrote cdkd state.
 */
export interface CfnUploadS3ClientOpts {
  profile?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

export interface UploadCfnTemplateArgs {
  /**
   * cdkd state bucket — reused as transient template storage when the CFn
   * template exceeds the inline `TemplateBody` limit (51,200 bytes). The
   * object is deleted in a `finally` immediately after the
   * `CreateChangeSet` / `UpdateStack` call completes, success or failure.
   *
   * The state bucket is preferred over a dedicated temporary bucket
   * (delstack-style) because (1) cdkd already manages it, so no
   * `CreateBucket` / `DeleteBucket` round-trips, no per-account
   * bucket-count pressure, and (2) the calling command's IAM principal
   * already has write access to it.
   */
  bucket: string;
  /** The serialized template body to upload. */
  body: string;
  /**
   * Stack name used to scope the S3 key (`cdkd-migrate-tmp/<stackName>/...`).
   * Either the CloudFormation stack name (`cdkd import
   * --migrate-from-cloudformation` path) or the cdkd stack name (`cdkd
   * export` path) — both are operator-visible and pointing at a single
   * stack is the right grouping for triage.
   */
  stackName: string;
  s3ClientOpts?: CfnUploadS3ClientOpts;
}

/**
 * Upload a CFn template body to the cdkd state bucket and return both a
 * virtual-hosted-style HTTPS URL CloudFormation can fetch via
 * `TemplateURL` and a `cleanup` callback that deletes the object (and
 * destroys the S3 client).
 *
 * The state bucket's actual region is resolved via `GetBucketLocation`
 * (cached per-process) so the upload client and the URL match the
 * bucket's region — the calling CLI's profile region is irrelevant here.
 *
 * Cleanup is the caller's responsibility: invoke `cleanup` in a `finally`
 * around the CFn call. CloudFormation copies the template into its own
 * internal storage during the synchronous `CreateChangeSet` /
 * `UpdateStack` API call, so the S3 object is no longer needed after that
 * call returns (success or failure).
 *
 * Shared between `cdkd import --migrate-from-cloudformation` (via
 * `retire-cfn-stack.ts`) and `cdkd export` (via `commands/export.ts`) so
 * the upload + cleanup contract is single-sourced.
 */
export async function uploadCfnTemplate(
  args: UploadCfnTemplateArgs
): Promise<{ url: string; cleanup: () => Promise<void> }> {
  const { bucket, body, stackName, s3ClientOpts } = args;
  const region = await resolveBucketRegion(bucket, {
    ...(s3ClientOpts?.profile && { profile: s3ClientOpts.profile }),
    ...(s3ClientOpts?.credentials && { credentials: s3ClientOpts.credentials }),
  });
  const s3 = new S3Client({
    region,
    ...(s3ClientOpts?.profile && { profile: s3ClientOpts.profile }),
    ...(s3ClientOpts?.credentials && { credentials: s3ClientOpts.credentials }),
  });
  // High-resolution timestamp avoids accidental key collisions when a user
  // re-runs the command twice in quick succession against the same stack.
  // The key shape is intentionally human-grep-able — leftovers (if cleanup
  // fails) point straight at the offending stack name.
  const key = `${MIGRATE_TMP_PREFIX}/${stackName}/${Date.now()}.json`;
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
      })
    );
  } catch (err) {
    s3.destroy();
    throw err;
  }
  // Virtual-hosted-style URL with explicit region works for every region
  // (us-east-1 included). CloudFormation fetches the template using the
  // calling principal's IAM permissions; the same identity that just wrote
  // to the bucket can read it back.
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  const cleanup = async (): Promise<void> => {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } finally {
      s3.destroy();
    }
  };
  return { url, cleanup };
}

/**
 * Threshold (in bytes) above which a single resource's serialized
 * `Properties` block is considered an "inline payload" worth surfacing as
 * a contributor to a template that exceeds the 1 MB CFn `TemplateURL`
 * ceiling. 4 KB matches the typical inline `Code.ZipFile` Lambda payload
 * that pushes a multi-resource CDK app over the wire-format limit.
 */
export const LARGE_INLINE_RESOURCE_THRESHOLD = 4096;

export interface LargeInlineResource {
  logicalId: string;
  resourceType: string;
  /** Serialized byte size of the resource's `Properties` block. */
  approxBytes: number;
}

/**
 * Walk a CFn template and surface every resource whose serialized
 * `Properties` block exceeds {@link LARGE_INLINE_RESOURCE_THRESHOLD}.
 * Used to build the actionable "offending resources" list in the
 * pre-flight error when a template exceeds the 1 MB `TemplateURL`
 * ceiling — typical culprits are inline `Code.ZipFile` Lambdas, inline
 * StepFunctions definitions, or large `AWS::CloudFormation::Stack`
 * bodies.
 *
 * Returns entries sorted by `approxBytes` descending so the user sees
 * the biggest contributor first. A non-CFn-template input (no
 * `Resources` object) returns an empty array.
 */
export function findLargeInlineResources(
  template: Record<string, unknown>,
  threshold: number = LARGE_INLINE_RESOURCE_THRESHOLD
): LargeInlineResource[] {
  const result: LargeInlineResource[] = [];
  const resources = template['Resources'];
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    return result;
  }
  for (const [logicalId, resource] of Object.entries(
    resources as Record<string, unknown>
  )) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) continue;
    const r = resource as Record<string, unknown>;
    const resourceType = typeof r['Type'] === 'string' ? (r['Type'] as string) : '<unknown>';
    const properties = r['Properties'];
    if (properties === undefined || properties === null) continue;
    let approxBytes: number;
    try {
      approxBytes = JSON.stringify(properties).length;
    } catch {
      // Defensive: a circular reference in Properties would break the
      // outer command anyway, but skip silently here rather than fail
      // the pre-flight error formatter.
      continue;
    }
    if (approxBytes >= threshold) {
      result.push({ logicalId, resourceType, approxBytes });
    }
  }
  result.sort((a, b) => b.approxBytes - a.approxBytes);
  return result;
}
