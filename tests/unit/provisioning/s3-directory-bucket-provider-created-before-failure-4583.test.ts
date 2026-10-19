import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockS3Send, mockStsSend, mockEc2Send, childLogger } = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
  mockStsSend: vi.fn(),
  mockEc2Send: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockS3Send, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: mockStsSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// The create goes through its own S3Client (issue #4639); answer it with the
// same send double as the shared one.
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({
      send: mockS3Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-ec2', async () => {
  const actual = await vi.importActual('@aws-sdk/client-ec2');
  return {
    ...actual,
    EC2Client: vi.fn().mockImplementation(() => ({
      send: mockEc2Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
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

import { S3DirectoryBucketProvider } from '../../../src/provisioning/providers/s3-directory-bucket-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { withStackScope } from '../../../src/provisioning/resource-name.js';

const TYPE = 'AWS::S3Express::DirectoryBucket';
const BUCKET_NAME = 'my-bucket--use1-az1--x-s3';
const PROPS = { BucketName: BUCKET_NAME, LocationName: 'us-east-1a--x-s3' };

async function createError(props: Record<string, unknown> = PROPS): Promise<unknown> {
  return new S3DirectoryBucketProvider().create('Bucket', TYPE, props).then(
    () => {
      throw new Error('expected create to fail');
    },
    (e: unknown) => e
  );
}

describe('S3DirectoryBucketProvider create leaves no bucket behind a failure (#4583)', () => {
  beforeEach(() => {
    mockS3Send.mockReset();
    mockStsSend.mockReset();
    mockEc2Send.mockReset();
    mockEc2Send.mockResolvedValue({ AvailabilityZones: [{ ZoneId: 'use1-az1' }] });
  });

  it('fails the STS account lookup BEFORE CreateBucket is sent, so no bucket is left behind', async () => {
    mockStsSend.mockRejectedValueOnce(new Error('ExpiredToken: the security token has expired'));
    const error = await createError();
    expect((error as Error).message).toContain('ExpiredToken');
    expect(mockStsSend).toHaveBeenCalledTimes(1);
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'Bucket', TYPE)).toBeUndefined();
  });

  it('resolves the account before CreateBucket and returns the ARN on success', async () => {
    mockStsSend.mockResolvedValueOnce({ Account: '123456789012' });
    mockS3Send.mockResolvedValueOnce({}); // CreateBucket
    const result = await new S3DirectoryBucketProvider().create('Bucket', TYPE, PROPS);
    expect(mockStsSend.mock.invocationCallOrder[0]).toBeLessThan(
      mockS3Send.mock.invocationCallOrder[0]!
    );
    expect(result).toEqual({
      physicalId: BUCKET_NAME,
      attributes: { Arn: `arn:aws:s3express:us-east-1:123456789012:bucket/${BUCKET_NAME}` },
    });
  });

  it('leaves no mark when CreateBucket itself fails', async () => {
    mockStsSend.mockResolvedValueOnce({ Account: '123456789012' });
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error('The requested bucket name is not available'), {
        name: 'BucketAlreadyExists',
      })
    );
    const error = await createError();
    expect((error as Error).message).toContain('not available');
    expect(createdBeforeFailure(error, 'Bucket', TYPE)).toBeUndefined();
  });

  it('leaves no mark on the pre-flight malformed-DataRedundancy refusal', async () => {
    const error = await createError({ ...PROPS, DataRedundancy: 42 });
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'Bucket', TYPE)).toBeUndefined();
  });
});

// go-to-k/cdkd#5064: a generated directory-bucket name, its `--<az-id>--x-s3`
// suffix included, fits S3's 63-character limit for any stack name.
describe('S3DirectoryBucketProvider.create: generated name length (#5064)', () => {
  beforeEach(() => {
    mockS3Send.mockReset();
    mockStsSend.mockReset();
    mockEc2Send.mockReset();
    mockEc2Send.mockResolvedValue({ AvailabilityZones: [{ ZoneId: 'use1-az4' }] });
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    mockS3Send.mockResolvedValue({});
  });

  it.each([
    ['a v13 stack', '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'],
    ['a legacy stack', undefined],
  ])('%s: the whole name is at most 63 characters', async (_label, stackInstanceId) => {
    const stackName = `S${'a'.repeat(60)}`;
    const result = await withStackScope({ stackName, stackInstanceId, nameGenerations: new Map() }, () =>
      new S3DirectoryBucketProvider().create('DirectoryBucket', TYPE, {
        LocationName: 'us-east-1a--x-s3',
      })
    );
    expect(result.physicalId).toMatch(/--use1-az4--x-s3$/);
    expect(result.physicalId.length).toBeLessThanOrEqual(63);
  });
});
