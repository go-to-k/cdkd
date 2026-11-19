/** Pure helpers of the S3 BucketPolicy provider. */
import { getStackRecords } from '../deployment/stack-records-scope.js';

/**
 * Recognize an S3 bucket name. AWS rules
 * (https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html):
 *   - 3-63 characters
 *   - lowercase letters, digits, hyphens, and dots
 *   - must start and end with a letter or digit
 *   - no consecutive dots
 *   - no `xn--` prefix (reserved for IDN bucket names)
 *   - no `-s3alias` suffix (reserved for S3 Access Point aliases)
 *   - no `--ol-s3` suffix (reserved for S3 on Outposts)
 *
 * A practical pattern that excludes the obvious CFn-generated names like
 * `MyStack-MyBucketPolicy-XXXXXXXXXX` (which contain uppercase letters
 * and exceed 63 chars in common cases) while accepting every normal CDK
 * auto-generated and user-declared bucket name.
 */
export function isS3BucketName(value: string): boolean {
  if (value.length < 3 || value.length > 63) return false;
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)) return false;
  if (value.includes('..')) return false;
  if (value.startsWith('xn--')) return false;
  if (value.endsWith('-s3alias') || value.endsWith('--ol-s3')) return false;
  return true;
}

/**
 * Another record of the bound stack holding the policy of `bucketName`
 * (go-to-k/cdkd#6109), or `undefined` outside a deploy.
 */
export function ownPolicyHolder(logicalId: string, bucketName: string): string | undefined {
  for (const [otherId, record] of getStackRecords()?.live() ?? []) {
    if (
      otherId !== logicalId &&
      record.resourceType === 'AWS::S3::BucketPolicy' &&
      record.physicalId === bucketName
    ) {
      return otherId;
    }
  }
  return undefined;
}
