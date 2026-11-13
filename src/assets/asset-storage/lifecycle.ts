import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  type LifecycleRule,
  type S3Client,
  type TransitionDefaultMinimumObjectSize,
} from '@aws-sdk/client-s3';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { displaySafe } from '../../utils/display-safe.js';

/**
 * The lifecycle rule ID cdkd owns on the asset bucket (issue #6185). The ID is
 * the idempotency key, as for the state bucket's rule: a configuration that
 * already carries it is left exactly as it is, so a user who edited the rule
 * keeps their edit and no PUT is sent.
 */
export const ABORT_INCOMPLETE_MULTIPART_LIFECYCLE_RULE_ID =
  'cdkd-abort-incomplete-multipart-uploads';

/** Days after initiation an incomplete multipart upload is aborted (CDK bootstrap: 1). */
export const ABORT_INCOMPLETE_MULTIPART_DAYS = 1;

/**
 * What {@link applyAbortIncompleteMultipartUpload} did. Never thrown: a missing
 * lifecycle permission must not fail a bootstrap that used to succeed.
 */
export type AbortIncompleteMultipartOutcome =
  | { readonly status: 'present' }
  | { readonly status: 'added' }
  | { readonly status: 'failed'; readonly reason: string; readonly accessDenied: boolean };

/**
 * The rule cdkd adds: the whole bucket, like the CDK bootstrap template's
 * `AbortIncompleteMultipartUploads`. `legacyPrefix` writes the rule-level
 * `Prefix` form, because S3 refuses a configuration that mixes it with `Filter`.
 */
export function buildAbortIncompleteMultipartRule(legacyPrefix: boolean): LifecycleRule {
  return {
    ID: ABORT_INCOMPLETE_MULTIPART_LIFECYCLE_RULE_ID,
    Status: 'Enabled',
    ...(legacyPrefix ? { Prefix: '' } : { Filter: { Prefix: '' } }),
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: ABORT_INCOMPLETE_MULTIPART_DAYS },
  };
}

/**
 * Ensure the asset bucket aborts incomplete multipart uploads after one day.
 *
 * `PutBucketLifecycleConfiguration` REPLACES the whole configuration, so this is
 * a read-merge-write like `applyCustomResourceResponseExpiration`: GET first
 * (`NoSuchLifecycleConfiguration` = no rules; any other GET failure stops
 * WITHOUT writing), return `present` when the rule ID exists, otherwise write
 * every existing rule back unchanged with cdkd's appended and
 * `TransitionDefaultMinimumObjectSize` passed through.
 */
export async function applyAbortIncompleteMultipartUpload(
  s3: S3Client,
  bucket: string,
  opts: { expectedBucketOwner?: string } = {}
): Promise<AbortIncompleteMultipartOutcome> {
  const owner = opts.expectedBucketOwner ? { ExpectedBucketOwner: opts.expectedBucketOwner } : {};
  let rules: LifecycleRule[];
  let minimumObjectSize: TransitionDefaultMinimumObjectSize | undefined;
  try {
    const current = await s3.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket, ...owner })
    );
    rules = current.Rules ?? [];
    minimumObjectSize = current.TransitionDefaultMinimumObjectSize;
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name !== 'NoSuchLifecycleConfiguration') {
      return failedOutcome('GetBucketLifecycleConfiguration', error);
    }
    rules = [];
    minimumObjectSize = undefined;
  }
  if (rules.some((rule) => rule.ID === ABORT_INCOMPLETE_MULTIPART_LIFECYCLE_RULE_ID)) {
    return { status: 'present' };
  }

  const legacyPrefix = rules.some((rule) => rule.Prefix !== undefined);
  try {
    await s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        ...owner,
        LifecycleConfiguration: {
          Rules: [...rules, buildAbortIncompleteMultipartRule(legacyPrefix)],
        },
        ...(minimumObjectSize !== undefined && {
          TransitionDefaultMinimumObjectSize: minimumObjectSize,
        }),
      })
    );
  } catch (error) {
    return failedOutcome('PutBucketLifecycleConfiguration', error);
  }
  return { status: 'added' };
}

function failedOutcome(
  operation: string,
  error: unknown
): { readonly status: 'failed'; readonly reason: string; readonly accessDenied: boolean } {
  const e = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  return {
    status: 'failed',
    reason: `${operation} failed: ${displaySafe(describeAwsFailure(error).detail) || '(unrenderable)'}`,
    accessDenied: e?.name === 'AccessDenied' || e?.$metadata?.httpStatusCode === 403,
  };
}

/** The warning printed for a `failed` outcome. */
export function abortIncompleteMultipartWarning(
  bucket: string,
  outcome: { readonly reason: string; readonly accessDenied: boolean }
): string {
  const remedy = outcome.accessDenied
    ? `To add the rule, grant s3:GetLifecycleConfiguration and s3:PutLifecycleConfiguration ` +
      `on the bucket, and check that this account owns it.`
    : `To add the rule, review the bucket's lifecycle configuration against the reason above.`;
  return (
    `Could not add the ${ABORT_INCOMPLETE_MULTIPART_DAYS}-day abort-incomplete-multipart-upload ` +
    `lifecycle rule to asset bucket ${displaySafe(bucket, { asciiOnly: true }) || '(unrenderable)'} ` +
    `(${outcome.reason}). The bucket's lifecycle configuration was left unchanged. Parts of an ` +
    `interrupted large-asset upload stay (and are billed) until aborted. ${remedy}`
  );
}
