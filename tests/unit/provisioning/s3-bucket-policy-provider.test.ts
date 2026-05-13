import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { S3BucketPolicyProvider } from '../../../src/provisioning/providers/s3-bucket-policy-provider.js';

describe('S3BucketPolicyProvider', () => {
  let provider: S3BucketPolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3BucketPolicyProvider();
  });

  describe('import (bucket-name resolution, closes #356)', () => {
    const BUCKET_NAME = 'my-bucket';
    const AUTOGEN_NAME = 'mystack-mybucket-1abcdef0';

    function makeInput(
      overrides: Partial<{
        knownPhysicalId: string;
        properties: Record<string, unknown>;
      }> = {}
    ) {
      const { knownPhysicalId, properties: propOverride, ...rest } = overrides;
      return {
        logicalId: 'MyBucketPolicy',
        resourceType: 'AWS::S3::BucketPolicy',
        cdkPath: 'MyStack/MyBucketPolicy',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: propOverride ?? {
          Bucket: BUCKET_NAME,
          PolicyDocument: { Version: '2012-10-17', Statement: [] },
        },
        ...(knownPhysicalId !== undefined && { knownPhysicalId }),
        ...rest,
      };
    }

    it('returns physicalId when knownPhysicalId is a valid S3 bucket name', async () => {
      const result = await provider.import(makeInput({ knownPhysicalId: BUCKET_NAME }));

      expect(result).toEqual({ physicalId: BUCKET_NAME, attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns physicalId when knownPhysicalId is a typical CDK-auto-generated bucket name', async () => {
      const result = await provider.import(makeInput({ knownPhysicalId: AUTOGEN_NAME }));

      expect(result).toEqual({ physicalId: AUTOGEN_NAME, attributes: {} });
    });

    it('falls back to properties.Bucket when knownPhysicalId is missing and Bucket is a literal name', async () => {
      const result = await provider.import(makeInput());

      expect(result).toEqual({ physicalId: BUCKET_NAME, attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('falls back to properties.Bucket when knownPhysicalId is the CFn-generated policy NAME (canonical #356 bug repro)', async () => {
      // --migrate-from-cloudformation pre-populates knownPhysicalId from
      // CloudFormation's `DescribeStackResources`. For AWS::S3::BucketPolicy,
      // CFn returns the policy resource NAME (e.g. `MyStack-MyBucketPolicy-XXX`),
      // which is not a valid S3 bucket name (uppercase letters, too long).
      // Pre-fix this was returned verbatim and baked into cdkd state.
      // Post-fix we ignore the unusable knownPhysicalId and derive the bucket
      // name from `properties.Bucket`.
      const cfnGeneratedName = 'MyStack-MyBucketPolicy-1ABCDEFGHIJKL';
      const result = await provider.import(makeInput({ knownPhysicalId: cfnGeneratedName }));

      expect(result).toEqual({ physicalId: BUCKET_NAME, attributes: {} });
    });

    it('rejects knownPhysicalId with uppercase letters (invalid S3 bucket name)', async () => {
      // Uppercase characters violate the S3 naming rules. cdkd should
      // ignore knownPhysicalId and fall back to properties.Bucket.
      const upperCase = 'Bucket-With-Caps';
      const result = await provider.import(makeInput({ knownPhysicalId: upperCase }));

      expect(result).toEqual({ physicalId: BUCKET_NAME, attributes: {} });
    });

    it('rejects knownPhysicalId longer than 63 characters', async () => {
      const tooLong = 'a'.repeat(64);
      const result = await provider.import(makeInput({ knownPhysicalId: tooLong }));

      // Falls back to the valid properties.Bucket.
      expect(result).toEqual({ physicalId: BUCKET_NAME, attributes: {} });
    });

    it('rejects knownPhysicalId ending in `-s3alias` (reserved for S3 Access Point aliases)', async () => {
      // AWS forbids bucket names ending in `-s3alias` — that suffix is
      // reserved for the alias names of S3 Access Points and would be
      // rejected by `PutBucketPolicy` at first call. cdkd's validator
      // catches it up-front so the import falls back to properties.Bucket
      // rather than baking the unusable value into state.
      const aliasSuffixed = 'my-bucket-s3alias';
      const result = await provider.import(makeInput({ knownPhysicalId: aliasSuffixed }));

      expect(result).toEqual({ physicalId: BUCKET_NAME, attributes: {} });
    });

    it('rejects knownPhysicalId ending in `--ol-s3` (reserved for S3 on Outposts)', async () => {
      // AWS forbids bucket names ending in `--ol-s3` — that suffix is
      // reserved for S3 on Outposts and would be rejected downstream.
      const outpostsSuffixed = 'my-bucket--ol-s3';
      const result = await provider.import(makeInput({ knownPhysicalId: outpostsSuffixed }));

      expect(result).toEqual({ physicalId: BUCKET_NAME, attributes: {} });
    });

    it('throws actionable error when knownPhysicalId is a non-bucket-name AND properties.Bucket is missing', async () => {
      const cfnGeneratedName = 'MyStack-MyBucketPolicy-1ABCDEFGHIJKL';
      await expect(
        provider.import(
          makeInput({
            knownPhysicalId: cfnGeneratedName,
            properties: { PolicyDocument: { Version: '2012-10-17', Statement: [] } },
          })
        )
      ).rejects.toThrow(
        /Cannot determine bucket name for AWS::S3::BucketPolicy 'MyBucketPolicy'.*MyStack-MyBucketPolicy-1ABCDEFGHIJKL.*--resource MyBucketPolicy=<bucketName>/s
      );
    });

    it('throws actionable error when knownPhysicalId is missing AND properties.Bucket is an unresolved intrinsic ({Ref: ...})', async () => {
      // At import time, intrinsics in `properties` have NOT been resolved yet
      // (resolveImportedProperties runs AFTER provider.import calls). The
      // typical CDK shape `Bucket: {Ref: 'MyBucket'}` therefore arrives here
      // as a raw object. Hard-erroring with a recovery hint is better than
      // silently dropping to null and baking the intrinsic into state.
      await expect(
        provider.import(
          makeInput({
            properties: {
              Bucket: { Ref: 'MyBucket' },
              PolicyDocument: { Version: '2012-10-17', Statement: [] },
            },
          })
        )
      ).rejects.toThrow(
        /Cannot determine bucket name.*Properties\.Bucket=\{"Ref":"MyBucket"\}.*--resource MyBucketPolicy=<bucketName>/s
      );
    });

    it('throws actionable error when both knownPhysicalId and properties.Bucket are absent', async () => {
      await expect(
        provider.import(
          makeInput({ properties: { PolicyDocument: { Version: '2012-10-17', Statement: [] } } })
        )
      ).rejects.toThrow(
        /Cannot determine bucket name.*Properties\.Bucket is missing.*--resource MyBucketPolicy=<bucketName>/s
      );
    });

    it('does not call AWS in any branch (offline-only import)', async () => {
      await provider.import(makeInput()).catch(() => undefined);
      await provider.import(makeInput({ knownPhysicalId: BUCKET_NAME })).catch(() => undefined);
      await provider
        .import(
          makeInput({
            knownPhysicalId: 'MyStack-X-1',
            properties: { PolicyDocument: {} },
          })
        )
        .catch(() => undefined);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
