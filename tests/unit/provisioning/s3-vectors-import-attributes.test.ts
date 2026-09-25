import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-s3vectors', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3vectors')>(
    '@aws-sdk/client-s3vectors'
  );
  class MockS3VectorsClient {
    config = { region: () => Promise.resolve('us-east-1') };
    send = mockSend;
  }
  return { ...actual, S3VectorsClient: MockS3VectorsClient };
});

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

import { S3VectorsProvider } from '../../../src/provisioning/providers/s3-vectors-provider.js';

/**
 * Issue #3627: `import()` recorded no `VectorBucketArn` (the physical id is the
 * NAME, so the resolver's shape guard refused it), and CloudFormation's
 * physical id is the bucket ARN, which it passed to `GetVectorBucket` as a name.
 */
const ARN = 'arn:aws:s3vectors:us-east-1:123456789012:bucket/my-vectors';
const importAs = (knownPhysicalId: string) =>
  new S3VectorsProvider().import({
    logicalId: 'B',
    resourceType: 'AWS::S3Vectors::VectorBucket',
    stackName: 'S',
    region: 'us-east-1',
    properties: {},
    knownPhysicalId,
  });

describe('S3VectorsProvider import() (issue #3627)', () => {
  beforeEach(() => mockSend.mockReset());

  it.each([
    ['cdkd name', 'my-vectors', { vectorBucketName: 'my-vectors' }],
    // An ARN is looked up BY ARN, so its region / account are honoured.
    ['CloudFormation ARN', ARN, { vectorBucketArn: ARN }],
  ])('records VectorBucketArn under the NAME from a %s', async (_label, id, input) => {
    mockSend.mockResolvedValueOnce({ vectorBucket: { vectorBucketName: 'my-vectors', vectorBucketArn: ARN } });
    await expect(importAs(id)).resolves.toStrictEqual({
      physicalId: 'my-vectors',
      attributes: { VectorBucketArn: ARN },
    });
    expect(mockSend.mock.calls[0]![0].input).toEqual(input);
  });

  it.each([
    ['an S3 bucket ARN', 'arn:aws:s3:::not-a-vector-bucket'],
    // Same `:bucket/<name>` tail, different service: must not adopt a
    // same-named vector bucket.
    ['an S3 Tables bucket ARN', 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-vectors'],
  ])('declines %s without an AWS call', async (_label, id) => {
    await expect(importAs(id)).resolves.toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
