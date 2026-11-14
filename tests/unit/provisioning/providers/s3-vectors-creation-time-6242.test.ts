import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3vectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3vectors')>();
  return {
    ...actual,
    S3VectorsClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../../src/utils/logger.js', () => {
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

import { GetVectorBucketCommand } from '@aws-sdk/client-s3vectors';
import { S3VectorsProvider } from '../../../../src/provisioning/providers/s3-vectors-provider.js';

/**
 * go-to-k/cdkd#6242: `Fn::GetAtt [VectorBucket, CreationTime]` serves AWS's
 * timestamp as CloudFormation does — `2026-11-14T07:49:04Z`, whole seconds
 * (measured on real CloudFormation 2026-11-14; the API answers epoch seconds).
 */
const TYPE = 'AWS::S3Vectors::VectorBucket';
const ARN = 'arn:aws:s3vectors:us-east-1:123456789012:bucket/my-vb';

describe('S3VectorsProvider CreationTime (#6242)', () => {
  let provider: S3VectorsProvider;
  beforeEach(() => {
    mockSend.mockReset();
    provider = new S3VectorsProvider();
  });

  it('create reads the bucket back once and records CreationTime without a fraction', async () => {
    mockSend.mockResolvedValueOnce({ vectorBucketArn: ARN });
    mockSend.mockResolvedValueOnce({
      vectorBucket: { vectorBucketArn: ARN, creationTime: new Date('2026-11-14T07:49:04Z') },
    });
    const result = await provider.create('Vb', TYPE, { VectorBucketName: 'my-vb' });
    expect(result.attributes).toStrictEqual({
      VectorBucketArn: ARN,
      CreationTime: '2026-11-14T07:49:04Z',
    });
    expect(mockSend.mock.calls[1]![0]).toBeInstanceOf(GetVectorBucketCommand);
    expect((mockSend.mock.calls[1]![0] as GetVectorBucketCommand).input).toStrictEqual({
      vectorBucketName: 'my-vb',
    });
  });

  it('create whose read-back fails still succeeds, with CreationTime absent', async () => {
    mockSend.mockResolvedValueOnce({ vectorBucketArn: ARN });
    mockSend.mockRejectedValueOnce(new Error('throttled'));
    const result = await provider.create('Vb', TYPE, { VectorBucketName: 'my-vb' });
    expect(result.attributes).toStrictEqual({ VectorBucketArn: ARN });
  });

  it('import records CreationTime (the heal path for a record written before this)', async () => {
    mockSend.mockResolvedValueOnce({
      vectorBucket: {
        vectorBucketName: 'my-vb',
        vectorBucketArn: ARN,
        creationTime: new Date('2026-11-14T07:49:04Z'),
      },
    });
    const result = await provider.import({
      logicalId: 'Vb',
      resourceType: TYPE,
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'my-vb',
    });
    expect(result?.attributes).toStrictEqual({
      VectorBucketArn: ARN,
      CreationTime: '2026-11-14T07:49:04Z',
    });
  });

  it('a tag update returns no attributes, so the record keeps its CreationTime', async () => {
    mockSend.mockResolvedValueOnce({ vectorBucket: { vectorBucketArn: ARN } }); // GetVectorBucket (ARN)
    mockSend.mockResolvedValueOnce({}); // TagResource
    const result = await provider.update(
      'Vb',
      'my-vb',
      TYPE,
      { VectorBucketName: 'my-vb', Tags: [{ Key: 'k', Value: 'v' }] },
      { VectorBucketName: 'my-vb' }
    );
    expect(result).toStrictEqual({ physicalId: 'my-vb', wasReplaced: false });
  });
});
