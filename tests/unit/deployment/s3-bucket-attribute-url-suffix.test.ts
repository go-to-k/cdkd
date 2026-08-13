import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
const mockS3Region = vi.hoisted(() => ({ value: 'us-east-1' }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve(mockS3Region.value) } },
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        // Only `Account` is read; the ARN is partition-correct anyway so a
        // future consumer deriving the partition from it is not misled.
        Arn: `arn:${mockS3Region.value.startsWith('cn-') ? 'aws-cn' : 'aws'}:iam::123456789012:user/test`,
      }),
    },
    ec2: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
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

import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/**
 * Issue #1745: the S3 host attributes are constructed on BOTH sides — the
 * provider records them into state, the resolver answers a cross-resource
 * `Fn::GetAtt` that state has no cached value for — and both hardcoded the
 * commercial `amazonaws.com` suffix.
 *
 * Fixing one side alone is the phantom-drift shape `.claude/rules/providers.md`
 * warns about, so the point of this suite is not the individual strings (those
 * are pinned in `tests/unit/utils/s3-endpoints.test.ts`) but that the two sides
 * AGREE — for a non-commercial region and, unchanged, for a commercial one.
 */
describe('AWS::S3::Bucket host attributes: resolver and provider agree (issue #1745)', () => {
  const ATTRIBUTES = [
    'Arn',
    'DomainName',
    'RegionalDomainName',
    'DualStackDomainName',
    'WebsiteURL',
  ] as const;

  beforeEach(() => {
    vi.clearAllMocks();
    resetAccountInfoCache();
  });

  const mkContext = (): ResolverContext => {
    const template: CloudFormationTemplate = {
      Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
    };
    return {
      template,
      resources: {
        Bucket: {
          physicalId: 'my-bucket',
          resourceType: 'AWS::S3::Bucket',
          properties: {},
          // Deliberately EMPTY: a cached attribute short-circuits
          // `constructAttribute`, which is the code path under test.
          attributes: {},
          dependencies: [],
        },
      },
    };
  };

  for (const region of ['cn-north-1', 'us-east-1']) {
    it(`resolves the same value the provider records, in ${region}`, async () => {
      mockS3Region.value = region;
      const resolver = new IntrinsicFunctionResolver(region);
      const provider = new S3BucketProvider();
      const context = mkContext();

      for (const attribute of ATTRIBUTES) {
        const resolved = await resolver.resolve({ 'Fn::GetAtt': ['Bucket', attribute] }, context);
        const recorded = await provider.getAttribute('my-bucket', 'AWS::S3::Bucket', attribute);
        expect(resolved, `${region} ${attribute}`).toBe(recorded);
      }

      // Every one of these is templated from the bucket name + region, so
      // neither side may reach S3 to answer (the property the pre-existing
      // `getAttribute` suite pins for the provider half).
      expect(mockSend).not.toHaveBeenCalled();
    });
  }

  it('emits China-partition hosts for a cn-north-1 bucket', async () => {
    mockS3Region.value = 'cn-north-1';
    const resolver = new IntrinsicFunctionResolver('cn-north-1');
    const context = mkContext();

    expect(await resolver.resolve({ 'Fn::GetAtt': ['Bucket', 'DomainName'] }, context)).toBe(
      'my-bucket.s3.amazonaws.com.cn'
    );
    expect(await resolver.resolve({ 'Fn::GetAtt': ['Bucket', 'WebsiteURL'] }, context)).toBe(
      'http://my-bucket.s3-website.cn-north-1.amazonaws.com.cn'
    );
    expect(await new S3BucketProvider().getAttribute('b', 'AWS::S3::Bucket', 'Arn')).toBe(
      'arn:aws-cn:s3:::b'
    );
  });

  it('leaves the commercial answers byte-identical to the pre-fix output', async () => {
    mockS3Region.value = 'us-east-1';
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = mkContext();

    expect(await resolver.resolve({ 'Fn::GetAtt': ['Bucket', 'DomainName'] }, context)).toBe(
      'my-bucket.s3.amazonaws.com'
    );
    expect(
      await resolver.resolve({ 'Fn::GetAtt': ['Bucket', 'RegionalDomainName'] }, context)
    ).toBe('my-bucket.s3.us-east-1.amazonaws.com');
    expect(await resolver.resolve({ 'Fn::GetAtt': ['Bucket', 'WebsiteURL'] }, context)).toBe(
      'http://my-bucket.s3-website-us-east-1.amazonaws.com'
    );
    expect(await new S3BucketProvider().getAttribute('b', 'AWS::S3::Bucket', 'Arn')).toBe(
      'arn:aws:s3:::b'
    );
  });

  it('answers DualStackDomainName instead of falling back to the bucket name', async () => {
    // The resolver had no case for it, so the unknown-attribute fallback served
    // the physicalId — a bucket NAME where a hostname was requested, and a value
    // the provider's own record disagreed with.
    mockS3Region.value = 'us-east-1';
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    expect(
      await resolver.resolve({ 'Fn::GetAtt': ['Bucket', 'DualStackDomainName'] }, mkContext())
    ).toBe('my-bucket.s3.dualstack.us-east-1.amazonaws.com');
  });
});
