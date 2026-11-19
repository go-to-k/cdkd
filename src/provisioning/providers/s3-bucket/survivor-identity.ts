import {
  BUCKET_LIST_IDENTITY_ATTEMPTS,
  BUCKET_LIST_IDENTITY_BUDGET_MS,
  BUCKET_LIST_IDENTITY_DELAY_MS,
  isPlainBucketName,
} from './create-identity.js';
import type { SurvivorIdentityRead } from '../../../types/resource.js';
import type { S3BucketProvider } from '../s3-bucket-provider.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';

const UNKNOWN: SurvivorIdentityRead = { kind: 'unknown' };

/**
 * go-to-k/cdkd#6621: who holds a replaced bucket's old name. S3 names are
 * global and a bucket carries no AWS-minted id, so this reads two things:
 *
 * - The ACCOUNT: a bucket S3 reports existing that this account's own
 *   `ListBuckets` (Prefix = the name, exact match) does not hold is someone
 *   else's, `foreign` for certain. "Existing" is a location answer, or the
 *   `AccessDenied` S3 answers on another account's bucket; any other failed
 *   location read is `unknown`, since the name may be on its way out.
 * - The GENERATION, for this account's bucket in the stack's region:
 *   `<region>|<CreationDate ISO>` from the same list entry (the
 *   {@link S3BucketProvider.resourceIdentity} token without the name).
 *   Measured for #6621 (2026-11-19, a throwaway bucket per region): a tagging
 *   and a versioning write left the date alone in us-east-1 and moved it to
 *   each write's second in us-west-2. The caller owns what a differing date
 *   means.
 *
 * Owned but in another region than the stack's is `foreign` too: a bucket
 * never moves region, so it was re-created. One `GetBucketLocation` and one
 * `ListBuckets` page (re-read briefly while the list has not caught up).
 */
export async function replacedSurvivorIdentity(
  this: S3BucketProvider,
  physicalId: string,
  resourceType: string,
  context: { expectedRegion: string }
): Promise<SurvivorIdentityRead> {
  try {
    if (resourceType !== 'AWS::S3::Bucket' || !isPlainBucketName(physicalId)) return UNKNOWN;
    const want = canonicalizeRegion(context.expectedRegion);
    if (canonicalizeRegion(await this.getRegion()) !== want) return UNKNOWN;
    const probe = await this.probeBucketRegion(physicalId);
    if (probe.kind === 'absent') return { kind: 'gone' };
    const started = Date.now();
    for (let attempt = 0; attempt < BUCKET_LIST_IDENTITY_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        if (Date.now() - started > BUCKET_LIST_IDENTITY_BUDGET_MS) break;
        await new Promise((r) => setTimeout(r, BUCKET_LIST_IDENTITY_DELAY_MS));
      }
      const listed = await this.listOwnedBucket(physicalId);
      if ('unknown' in listed) return UNKNOWN;
      if (listed.bucket === undefined) continue;
      if (probe.kind !== 'region') return { kind: 'owned', identity: undefined };
      if (probe.region !== want) return { kind: 'foreign', seen: 'other-region' };
      const created = listed.bucket.CreationDate;
      return {
        kind: 'owned',
        identity:
          created instanceof Date && !Number.isNaN(created.getTime())
            ? `${want}|${created.toISOString()}`
            : undefined,
      };
    }
    const exists =
      probe.kind === 'region' ||
      (probe.kind === 'indeterminate' && probe.errorName === 'AccessDenied');
    return exists ? { kind: 'foreign', seen: 'other-account' } : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}
