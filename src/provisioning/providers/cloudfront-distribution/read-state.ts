import type { CloudFrontDistributionProvider } from '../cloudfront-distribution-provider.js';
import {
  GetDistributionCommand,
  GetDistributionConfigCommand,
  ListTagsForResourceCommand,
  NoSuchDistribution,
  type DistributionConfig,
} from '@aws-sdk/client-cloudfront';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  type ResourceImportInput,
  type ResourceImportResult,
  type ResourceNotFound,
  RESOURCE_NOT_FOUND,
} from '../../../types/resource.js';

/**
 * Read the AWS-current `DistributionConfig` for drift detection.
 *
 * Calls the read-only `GetDistributionConfigCommand` and inverts the
 * provider's own `convertToSdkFormat` (the CFn-shape → SDK-shape
 * `{ Quantity, Items }` mapping the create / update path applies) back
 * into the CloudFormation `DistributionConfig` shape that cdkd state
 * stores — so the drift comparator sees the same structure on both
 * the deploy-time observed snapshot and a later drift read.
 *
 * The comparator only descends into keys present in cdkd state (or the
 * union of state + AWS when an observed baseline exists), so this does
 * not need to surface every AWS-injected field; it returns the same
 * `DistributionConfig` / `Tags` keys the provider manages.
 *
 * `CallerReference` (a create-time idempotency token AWS echoes back
 * but CDK never templates) is dropped so it cannot fire phantom drift.
 * The remaining write-only / never-readable sub-fields are declared in
 * `getDriftUnknownPaths`.
 */
export async function readCurrentState(
  this: CloudFrontDistributionProvider,
  physicalId: string,
  _logicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  if (resourceType !== 'AWS::CloudFront::Distribution') return undefined;

  let config: DistributionConfig | undefined;
  try {
    const response = await this.cloudFrontClient.send(
      new GetDistributionConfigCommand({ Id: physicalId })
    );
    config = response.DistributionConfig;
  } catch (error) {
    if (error instanceof NoSuchDistribution) return RESOURCE_NOT_FOUND;
    throw error;
  }
  if (!config) return undefined;

  const result: Record<string, unknown> = {
    DistributionConfig: this.convertToCfnFormat(config as unknown as Record<string, unknown>),
  };

  // Surface AWS-current tags so a console-side tag edit is detectable.
  // CloudFront tags live on the distribution's ARN, fetched separately
  // via ListTagsForResource. A tag read failure is non-fatal — the
  // DistributionConfig drift is still meaningful on its own.
  try {
    const getResponse = await this.cloudFrontClient.send(
      new GetDistributionCommand({ Id: physicalId })
    );
    const arn = getResponse.Distribution?.ARN;
    if (arn) {
      const tagsResponse = await this.cloudFrontClient.send(
        new ListTagsForResourceCommand({ Resource: arn })
      );
      const items = tagsResponse.Tags?.Items ?? [];
      const cfnTags = items
        .filter((t) => typeof t.Key === 'string' && !t.Key.startsWith('aws:cdk:'))
        .map((t) => ({ Key: t.Key as string, Value: t.Value ?? '' }));
      if (cfnTags.length > 0) {
        result['Tags'] = cfnTags;
      }
    }
  } catch (error) {
    this.logger.debug(
      `Tag read for CloudFront Distribution ${physicalId} failed during drift read: ${describeAwsFailure(error).detail}`
    );
  }

  return result;
}

/**
 * State property paths cdkd cannot read back faithfully from AWS, so
 * the drift comparator skips them rather than firing a guaranteed
 * false positive every run (mirrors the Lambda `Code.S3*` precedent).
 *
 * - `DistributionConfig.CallerReference`: a create-time idempotency
 *   token. cdkd generates it internally (`acquireIdempotencyToken`, issue
 *   #2079 — a per-process digest, `cdkd-<sha256 prefix>`); AWS echoes it
 *   back, but it is never templated by CDK, so comparing it would diff
 *   cdkd's generated value on every run. It is not even stable across
 *   cdkd RUNS by design (a process nonce is mixed in), so suppression is
 *   required rather than merely convenient. `convertToCfnFormat` already
 *   drops it from the AWS side; declaring it here also excludes it from
 *   the observed-baseline side.
 * - `DistributionConfig.Logging.Bucket`: CloudFront normalizes the S3
 *   logging bucket to its `<bucket>.s3.amazonaws.com` regional domain on
 *   read, which never matches the bare bucket domain a template may
 *   carry; treat it as drift-unknown to avoid a guaranteed mismatch.
 *
 * NOTE: `DistributionConfig.OriginGroups` is NO LONGER suppressed (issue
 * #873). The earlier suppression worked around `convertToCfnFormat`
 * incorrectly unwrapping the top-level OriginGroups `{ Quantity, Items }`
 * wrapper; the real fix (dropping OriginGroups from `QUANTITY_ITEM_FIELDS` so
 * it passes through untouched in both directions) makes OriginGroups compare
 * equal, so it is now drift-checked normally and a real OriginGroups change
 * IS reported.
 */
export function getDriftUnknownPaths(
  this: CloudFrontDistributionProvider,
  resourceType: string
): string[] {
  if (resourceType !== 'AWS::CloudFront::Distribution') return [];
  return ['DistributionConfig.CallerReference', 'DistributionConfig.Logging.Bucket'];
}

/**
 * Plain-string arrays that are semantically UNORDERED sets, per
 * {@link ResourceProvider.getDriftUnorderedPaths}.
 *
 * `GeoRestriction.Locations` is a set of ISO country codes — the
 * CloudFront API reference documents no ordering semantics and the
 * service does not echo the submitted order back (observed live in the
 * `s3-cloudfront` integ, 2026-08-09: a template `[JP, US]` allowlist
 * read back as `[US, JP]`), so a positional compare fires guaranteed
 * phantom drift on any multi-country restriction.
 */
export function getDriftUnorderedPaths(
  this: CloudFrontDistributionProvider,
  resourceType: string
): string[] {
  if (resourceType !== 'AWS::CloudFront::Distribution') return [];
  return ['DistributionConfig.Restrictions.GeoRestriction.Locations'];
}

/**
 * Get resource attribute (for Fn::GetAtt resolution)
 */
export async function getAttribute(
  this: CloudFrontDistributionProvider,
  physicalId: string,
  _resourceType: string,
  attributeName: string
): Promise<unknown> {
  if (attributeName === 'Id' || attributeName === 'DistributionId') {
    return physicalId;
  }

  if (attributeName === 'DomainName') {
    const response = await this.cloudFrontClient.send(
      new GetDistributionCommand({ Id: physicalId })
    );
    return response.Distribution?.DomainName;
  }

  throw new Error(`Unsupported attribute: ${attributeName} for AWS::CloudFront::Distribution`);
}

/**
 * Adopt an existing CloudFront distribution into cdkd state.
 *
 * CloudFront distributions don't carry a template-supplied name
 * (physical id is the AWS-generated `E...` distribution id), so the
 * lookup is explicit-override only.
 */
export async function importImpl(
  this: CloudFrontDistributionProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    try {
      await this.cloudFrontClient.send(new GetDistributionCommand({ Id: input.knownPhysicalId }));
      return { physicalId: input.knownPhysicalId, attributes: {} };
    } catch (err) {
      if (err instanceof NoSuchDistribution) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a
  // distribution reaching here needs an explicit `--resource` override.
  return null;
}
