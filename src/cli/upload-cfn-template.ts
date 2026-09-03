import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { derivePartitionAndUrlSuffix } from '../utils/aws-partition.js';
import { resolveBucketRegion } from '../utils/aws-region-resolver.js';
import type { TemplateFormat } from './yaml-cfn.js';
import { expectedOwnerParam } from '../utils/expected-bucket-owner.js';
import { purgeNoncurrentKeyVersions } from '../state/s3-noncurrent-version-purge.js';
import { getLogger } from '../utils/logger.js';
import { awsClientDefaults } from '../utils/aws-client-defaults.js';

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
  /**
   * Source template format. Drives the S3 key extension and `Content-Type`
   * so a YAML-authored template stays YAML in the transient upload and
   * CloudFormation reads it as such. Defaults to `'json'` for back-compat
   * with the original JSON-only upload path.
   */
  format?: TemplateFormat;
  s3ClientOpts?: CfnUploadS3ClientOpts;
}

/**
 * Upload a CFn template body to the cdkd state bucket and return both a
 * virtual-hosted-style HTTPS URL CloudFormation can fetch via
 * `TemplateURL` and a `cleanup` callback that deletes the object, PURGES its
 * noncurrent versions (the state bucket is versioned — see the callback), and
 * destroys the S3 client.
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
  const { bucket, body, stackName, format, s3ClientOpts } = args;
  const region = await resolveBucketRegion(bucket, {
    ...(s3ClientOpts?.profile && { profile: s3ClientOpts.profile }),
    ...(s3ClientOpts?.credentials && { credentials: s3ClientOpts.credentials }),
  });
  const s3 = new S3Client({
    ...awsClientDefaults({ profile: s3ClientOpts?.profile }),
    region,
    ...(s3ClientOpts?.profile && { profile: s3ClientOpts.profile }),
    ...(s3ClientOpts?.credentials && { credentials: s3ClientOpts.credentials }),
  });
  // High-resolution timestamp avoids accidental key collisions when a user
  // re-runs the command twice in quick succession against the same stack.
  // The key shape is intentionally human-grep-able — leftovers (if cleanup
  // fails) point straight at the offending stack name.
  // The extension + Content-Type mirror the source template format so a
  // YAML-authored template stays YAML on the wire.
  const ext = format === 'yaml' ? 'yaml' : 'json';
  const contentType = format === 'yaml' ? 'application/x-yaml' : 'application/json';
  const key = `${MIGRATE_TMP_PREFIX}/${stackName}/${Date.now()}.${ext}`;
  try {
    await s3.send(
      new PutObjectCommand({
        ...(await expectedOwnerParam(s3)),
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
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
  //
  // The host suffix is DERIVED from the bucket's region (issue #1758) —
  // hardcoding `amazonaws.com` handed CloudFormation a `TemplateURL` that does
  // not resolve outside the commercial partition (`aws-cn` buckets live under
  // `amazonaws.com.cn`, `us-iso*` under `c2s.ic.gov` / `sc2s.sgov.gov`).
  // Commercial output is byte-identical.
  const { urlSuffix } = derivePartitionAndUrlSuffix(region);
  const url = `https://${bucket}.s3.${region}.${urlSuffix}/${key}`;
  // TWO steps, and the second is not housekeeping (issue
  // [#2346](https://github.com/go-to-k/cdkd/issues/2346) site 7). The bucket
  // this writes into is cdkd's STATE bucket, which `cdkd bootstrap` turns
  // VERSIONING ON for, so the `DeleteObject` below only writes a DELETE MARKER
  // and the uploaded template body stays readable through `GetObject` with a
  // `VersionId`. Whether that body carries a secret depends on the template —
  // an inline `Code.ZipFile` or a hand-written literal does — so the exposure
  // is conditional, and unlike the rollback journal nobody has measured a real
  // one. What is NOT conditional is that this object is transient by
  // construction (uploaded purely to get past the 51,200-byte inline
  // `TemplateBody` ceiling, deleted the moment the CFn call returns), so its
  // previous versions have no recovery value and the purge costs nothing on
  // the other side. That is what makes it the closest analogue to the
  // custom-resource response sidecar rather than to `state.json`.
  //
  // The purge is in a `finally` so a FAILED delete still takes the history:
  // `purgeNoncurrentKeyVersions` filters on `IsLatest`, so a key whose delete
  // failed keeps its current version and loses only its older bodies.
  //
  // Its own errors are caught rather than allowed to propagate, because a
  // rejection from a `finally` would REPLACE the delete's error in flight and
  // every caller of `cleanup()` catches that error to name the leftover key.
  //
  // DEFENCE IN DEPTH, and the honest statement is that no mechanism here is
  // known to reject today. An earlier revision of this comment claimed
  // `expectedOwnerParam` could, being outside the helper's never-throw
  // guarantee and reaching STS; that is FALSE — `resolveExpectedBucketOwner`
  // (`src/utils/expected-bucket-owner.ts`) wraps every await and degrades to
  // `undefined`. What CAN fire is a caller-supplied `logger` whose `warn`
  // throws, and a future edit that adds an awaited call between here and the
  // helper. Naming an unproved mechanism is worse than naming none, so this
  // says which it is.
  //
  // `s3.destroy()` sits in its OWN `finally` under that catch, not after it.
  // Measured while writing this: with `destroy()` merely following the catch,
  // a throw raised INSIDE the catch arm skipped it and leaked the connection
  // pool — and the catch arm is the one place here that is reached only when
  // something has already gone wrong.
  const cleanup = async (): Promise<void> => {
    try {
      await s3.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key, ...(await expectedOwnerParam(s3)) })
      );
    } finally {
      try {
        await purgeNoncurrentKeyVersions(s3, bucket, [key], {
          requestFields: await expectedOwnerParam(s3),
          // The base logger, NOT a `.child(...)` of it. The purge arm runs on
          // a path whose whole contract is "must not change what the caller
          // sees", so it must not depend on a logger shape richer than the
          // `{ warn }` the helper asks for.
          logger: getLogger(),
          objectDescription: 'the transient CloudFormation template body uploaded for this command',
        });
      } catch (purgeError) {
        // Logged rather than swallowed: what survives is the body of an object
        // cdkd has just reported as removed.
        getLogger().warn(
          `Could not purge noncurrent versions of the transient template ` +
            `s3://${bucket}/${key}; its previous versions survive and remain readable ` +
            `via GetObject with a VersionId. Grant s3:ListBucketVersions and ` +
            `s3:DeleteObjectVersion on the state bucket, or purge the key by hand. ` +
            `Underlying error: ` +
            `${purgeError instanceof Error ? purgeError.message : String(purgeError)}`
        );
      } finally {
        s3.destroy();
      }
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
  for (const [logicalId, resource] of Object.entries(resources as Record<string, unknown>)) {
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
