import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const ccClientRegion = vi.hoisted(() => ({ value: 'us-east-1' }));
const getAccountInfoCalls = vi.hoisted(() => ({ count: 0 }));

const ccClientRegionError = vi.hoisted(() => ({ value: undefined as Error | undefined }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    // `config.region` is a PROVIDER function on a real SDK client, not a string.
    cloudControl: {
      send: vi.fn(),
      config: {
        region: () =>
          ccClientRegionError.value
            ? Promise.reject(ccClientRegionError.value)
            : Promise.resolve(ccClientRegion.value),
      },
    },
    cloudFormation: { send: vi.fn() },
  }),
}));

// Counted so the case below can show the bucket ARN is built without an STS
// round trip: a bucket ARN carries no account id.
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () => {
    getAccountInfoCalls.count += 1;
    return Promise.resolve({ accountId: '123456789012', region: 'us-east-1', partition: 'aws' });
  },
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => child),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { s3BucketArn } from '../../../src/utils/s3-endpoints.js';

/**
 * Issue [#1794](https://github.com/go-to-k/cdkd/issues/1794): the Cloud Control
 * `AWS::S3::Bucket` `Arn` enrichment hardcoded `arn:aws:s3:::`, so a CC-routed
 * bucket in `aws-cn` / `aws-us-gov` recorded a commercial ARN while the
 * SDK-routed one (`S3BucketProvider`, issue #1745) recorded the real partition
 * — the recorded value depended on the ROUTE.
 *
 * The commercial rows are asserted byte-identical to the pre-fix literal: that
 * is what makes the change safe without a non-commercial account.
 */
describe('CloudControlProvider S3 bucket Arn follows the partition (issue #1794)', () => {
  let provider: CloudControlProvider;

  const enrich = (physicalId: string, attributes: Record<string, unknown> = {}) =>
    (
      provider as unknown as {
        enrichResourceAttributes: (
          resourceType: string,
          physicalId: string,
          attributes: Record<string, unknown>
        ) => Promise<Record<string, unknown>>;
      }
    ).enrichResourceAttributes('AWS::S3::Bucket', physicalId, attributes);

  beforeEach(() => {
    ccClientRegion.value = 'us-east-1';
    ccClientRegionError.value = undefined;
    getAccountInfoCalls.count = 0;
    provider = new CloudControlProvider();
  });

  it.each([
    // Commercial: byte-identical to the pre-fix `arn:aws:s3:::${physicalId}`.
    ['us-east-1', 'arn:aws:s3:::my-bucket'],
    ['eu-central-1', 'arn:aws:s3:::my-bucket'],
    // Non-commercial partitions — each was `arn:aws:s3:::my-bucket` before.
    ['cn-north-1', 'arn:aws-cn:s3:::my-bucket'],
    ['cn-northwest-1', 'arn:aws-cn:s3:::my-bucket'],
    ['us-gov-west-1', 'arn:aws-us-gov:s3:::my-bucket'],
    // An upper-cased client region still lands in its partition.
    ['CN-NORTH-1', 'arn:aws-cn:s3:::my-bucket'],
  ])('client region %s records Arn %s', async (region, expected) => {
    ccClientRegion.value = region;

    const enriched = await enrich('my-bucket');

    expect(enriched['Arn']).toBe(expected);
    expect(getAccountInfoCalls.count).toBe(0);
  });

  // Route parity: the CC fallback and the SDK provider must record the SAME
  // string for one bucket in one region.
  it.each(['us-east-1', 'cn-north-1', 'us-gov-east-1'])(
    'region %s: CC enrichment matches the SDK provider builder',
    async (region) => {
      ccClientRegion.value = region;

      const enriched = await enrich('my-bucket');

      expect(enriched['Arn']).toBe(s3BucketArn('my-bucket', region));
    }
  );

  // The bucket already exists when enrichment runs, so an unreadable region must
  // leave `Arn` absent (never a guessed partition) and must not throw — a throw
  // here fails a create that succeeded.
  it('leaves Arn absent, without throwing, when the client region cannot be read', async () => {
    ccClientRegionError.value = new Error('Region is missing');

    const enriched = await enrich('my-bucket', { BucketName: 'my-bucket' });

    expect(enriched).toEqual({ BucketName: 'my-bucket' });
  });

  it('keeps an Arn Cloud Control already reported', async () => {
    ccClientRegion.value = 'cn-north-1';

    const enriched = await enrich('my-bucket', { Arn: 'arn:aws-cn:s3:::reported-by-cc' });

    expect(enriched['Arn']).toBe('arn:aws-cn:s3:::reported-by-cc');
  });
});
