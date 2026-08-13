/**
 * `AWS::S3::Bucket` `Fn::GetAtt` endpoint construction, shared across layers.
 *
 * cdkd answers the four host-shaped bucket attributes (`DomainName`,
 * `RegionalDomainName`, `DualStackDomainName`, `WebsiteURL`) WITHOUT an AWS
 * call, from the bucket name plus the region — and it does so in TWO places:
 * `S3BucketProvider.buildAttributes` (what lands in state) and
 * `IntrinsicFunctionResolver.constructAttribute` (what a cross-resource
 * `Fn::GetAtt` resolves to when the attribute is not cached). Those two used to
 * carry independent copies of the templates, which is the phantom-drift shape
 * `.claude/rules/providers.md` warns about: fix one and the resolver's answer
 * disagrees with what `readCurrentState` reports. They now both call THIS
 * module, so the two sides cannot diverge (issue
 * [#1745](https://github.com/go-to-k/cdkd/issues/1745)).
 *
 * Both copies also hardcoded the commercial `amazonaws.com` suffix, so outside
 * the commercial partition every one of the four emitted a hostname that does
 * not resolve — structurally valid, so nothing downstream could catch it. The
 * suffix now derives from the region through
 * {@link derivePartitionAndUrlSuffix}, the same closed table `${AWS::URLSuffix}`
 * resolves through.
 *
 * The shapes are taken from `aws-cdk-lib`'s own `Bucket.fromBucketAttributes`
 * (`aws-s3/lib/bucket.ts`), which constructs the identical four values for an
 * imported bucket, rather than from documentation prose:
 *
 * - `bucketDomainName`            -> `<bucket>.s3.<urlSuffix>`
 * - `bucketRegionalDomainName`    -> `<bucket>.s3.<region>.<urlSuffix>`
 * - `bucketDualStackDomainName`   -> `<bucket>.s3.dualstack.<region>.<urlSuffix>`
 * - `bucketWebsiteUrl`            -> `http://<bucket>.<staticWebsiteEndpoint>`
 */

import { canonicalizeRegion, derivePartitionAndUrlSuffix } from './aws-partition.js';

/**
 * Fold the region ONCE, here, for every helper below (issue
 * [#1850](https://github.com/go-to-k/cdkd/issues/1850)).
 *
 * The fold belongs in THIS module rather than at either call site, and that is
 * the whole reason this module exists: `S3BucketProvider.buildAttributes`
 * (what lands in state) passes `this.s3Client.config.region()` while
 * `IntrinsicFunctionResolver.constructAttribute` passes `accountInfo.region`.
 * Folding at one call site alone re-creates the exact divergence the header
 * above says this module prevents -- the resolver's `Fn::GetAtt` answer would
 * stop matching what `readCurrentState` reports, which is the phantom-drift
 * shape `.claude/rules/providers.md` warns about (#1745).
 *
 * For `WebsiteURL` the fold is not merely a spelling difference: the
 * separator comes from a case-sensitive Set lookup, so an upper-cased region
 * MISSES the legacy-dash set and silently picks the wrong separator. That is
 * the one place in this module where the region flips a BRANCH rather than a
 * substring, and it is why folding here also fixes the provider side that was
 * never reached by the resolver's own fold.
 *
 * `derivePartitionAndUrlSuffix` canonicalizes its own input (#1795), so the
 * suffix was already right; double-folding is a no-op, which is what makes the
 * two safe side by side.
 */
function foldRegion(region: string): string {
  return canonicalizeRegion(region);
}

/**
 * The regions whose S3 static-website endpoint uses the LEGACY hyphen form
 * `s3-website-<region>` rather than the current dot form `s3-website.<region>`.
 *
 * This is NOT a mechanical suffix swap, which is why the issue asked for it to
 * be verified rather than spliced. The set is CLOSED and was read out of
 * `aws-cdk-lib`'s `region-info` fact table (`S3_STATIC_WEBSITE_ENDPOINT`, the
 * same data CDK itself resolves a bucket's website endpoint from), enumerated
 * at aws-cdk-lib 2.244.0: exactly these nine regions report the hyphen form and
 * every other region — commercial and non-commercial alike — reports the dot
 * form. `us-gov-west-1` is in the hyphen set while its `us-gov-east-1` sibling
 * is not, so the split is per REGION and cannot be derived from the partition.
 *
 * An UNKNOWN region resolves to the dot form, matching what CDK falls back to
 * when `region-info` has no fact for the region: the hyphen form is the legacy
 * spelling and no new region has been added to it.
 *
 * NOTE this corrects the answer for every non-legacy COMMERCIAL region too, not
 * only for other partitions — the previous hardcoded template emitted the
 * hyphen form everywhere, so e.g. an `eu-central-1` bucket's `WebsiteURL`
 * resolved to a host AWS does not serve.
 */
export const S3_WEBSITE_ENDPOINT_LEGACY_DASH_REGIONS: ReadonlySet<string> = new Set([
  'ap-northeast-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'eu-west-1',
  'sa-east-1',
  'us-east-1',
  'us-gov-west-1',
  'us-west-1',
  'us-west-2',
]);

/** `arn:<partition>:s3:::<bucket>` — the bucket ARN (no region / account field). */
export function s3BucketArn(bucketName: string, region: string): string {
  return `arn:${derivePartitionAndUrlSuffix(region).partition}:s3:::${bucketName}`;
}

/**
 * `<bucket>.s3.<urlSuffix>` — the partition-global (non-regional) domain name.
 *
 * **This host does not RESOLVE outside the commercial partition, and that is
 * not something this module can fix.** S3's partition-global endpoint exists
 * only in `aws`: `s3.amazonaws.com.cn` is NXDOMAIN (probed 2026-08-13), and in
 * GovCloud the commercial `<bucket>.s3.amazonaws.com` resolves to COMMERCIAL S3,
 * which answers `NoSuchBucket`. Only the regional / dual-stack / website forms
 * have a real non-commercial spelling.
 *
 * The suffix is still derived rather than hardcoded, because the alternative —
 * inventing the REGIONAL form here — would make cdkd's `Fn::GetAtt DomainName`
 * disagree with what CloudFormation returns, which is the compatibility cdkd
 * exists to keep. This spelling matches `aws-cdk-lib`'s own
 * `Bucket.fromBucketAttributes` (`bucketDomainName: <bucket>.s3.<urlSuffix>`),
 * the only AWS-authored answer available without a non-commercial account.
 * Settling it against real CloudFormation is issue
 * [#1809](https://github.com/go-to-k/cdkd/issues/1809).
 */
export function s3BucketDomainName(bucketName: string, region: string): string {
  return `${bucketName}.s3.${derivePartitionAndUrlSuffix(region).urlSuffix}`;
}

/** `<bucket>.s3.<region>.<urlSuffix>` — the regional domain name. */
export function s3BucketRegionalDomainName(bucketName: string, region: string): string {
  const folded = foldRegion(region);
  return `${bucketName}.s3.${folded}.${derivePartitionAndUrlSuffix(folded).urlSuffix}`;
}

/** `<bucket>.s3.dualstack.<region>.<urlSuffix>` — the IPv6 dual-stack domain name. */
export function s3BucketDualStackDomainName(bucketName: string, region: string): string {
  const folded = foldRegion(region);
  return `${bucketName}.s3.dualstack.${folded}.${derivePartitionAndUrlSuffix(folded).urlSuffix}`;
}

/**
 * `http://<bucket>.s3-website[-.]<region>.<urlSuffix>` — the static-website URL.
 *
 * The separator is picked per region from
 * {@link S3_WEBSITE_ENDPOINT_LEGACY_DASH_REGIONS}; see that constant for why it
 * cannot be derived from the partition.
 */
export function s3BucketWebsiteUrl(bucketName: string, region: string): string {
  // Folded BEFORE the Set lookup, not after: the set holds canonical ids, so
  // an upper-cased region would miss it and take the dot form for a region
  // AWS serves on the hyphen one (issue #1850).
  const folded = foldRegion(region);
  const { urlSuffix } = derivePartitionAndUrlSuffix(folded);
  const separator = S3_WEBSITE_ENDPOINT_LEGACY_DASH_REGIONS.has(folded) ? '-' : '.';
  return `http://${bucketName}.s3-website${separator}${folded}.${urlSuffix}`;
}
