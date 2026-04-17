import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @aws-sdk/client-s3
const mockS3Send = vi.fn();
const mockS3Destroy = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: mockS3Send,
    destroy: mockS3Destroy,
  })),
  HeadObjectCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: 'HeadObject' })),
  PutObjectCommand: vi.fn().mockImplementation((input) => ({ ...input, _type: 'PutObject' })),
}));

// Mock node:fs
vi.mock('node:fs', () => ({
  createReadStream: vi.fn().mockReturnValue('mock-stream'),
  statSync: vi.fn().mockReturnValue({ size: 1024, isDirectory: () => false }),
}));

// Mock archiver
vi.mock('archiver', () => ({
  default: vi.fn().mockImplementation(() => {
    const archive = {
      pipe: vi.fn(),
      directory: vi.fn(),
      file: vi.fn(),
      finalize: vi.fn().mockResolvedValue(undefined),
    };
    return archive;
  }),
}));

// Mock node:stream
vi.mock('node:stream', () => ({
  PassThrough: vi.fn().mockImplementation(() => {
    const handlers: Record<string, Function[]> = {};
    return {
      on: vi.fn().mockImplementation((event: string, handler: Function) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
        // Auto-trigger 'end' event for zip tests
        if (event === 'end') {
          setTimeout(() => handler(), 0);
        }
        return { on: vi.fn() };
      }),
    };
  }),
}));

// Mock logger
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

import { createReadStream, statSync } from 'node:fs';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { FileAssetPublisher } from '../../../src/assets/file-asset-publisher.js';
import type { FileAsset } from '../../../src/types/assets.js';

describe('FileAssetPublisher', () => {
  let publisher: FileAssetPublisher;

  const makeFileAsset = (overrides: Partial<FileAsset> = {}): FileAsset => ({
    displayName: 'TestAsset',
    source: {
      path: 'asset.abc123/index.js',
      packaging: 'file' as const,
    },
    destinations: {
      'current-account': {
        bucketName: 'cdk-assets-${AWS::AccountId}-${AWS::Region}',
        objectKey: 'assets/abc123.js',
      },
    },
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    publisher = new FileAssetPublisher();
  });

  it('should upload file to S3', async () => {
    // HeadObject throws NotFound -> file does not exist yet
    mockS3Send.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'HeadObject') {
        const err = new Error('Not Found') as Error & { name: string; $metadata: { httpStatusCode: number } };
        err.name = 'NotFound';
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {};
    });

    await publisher.publish(
      'abc123',
      makeFileAsset(),
      '/tmp/cdk.out',
      '123456789012',
      'us-east-1'
    );

    expect(HeadObjectCommand).toHaveBeenCalledWith({
      Bucket: 'cdk-assets-123456789012-us-east-1',
      Key: 'assets/abc123.js',
    });
    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'cdk-assets-123456789012-us-east-1',
        Key: 'assets/abc123.js',
        Body: 'mock-stream',
        ContentLength: 1024,
      })
    );
    expect(createReadStream).toHaveBeenCalledWith('/tmp/cdk.out/asset.abc123/index.js');
    expect(mockS3Destroy).toHaveBeenCalled();
  });

  it('should skip upload if object already exists', async () => {
    // HeadObject succeeds -> file exists
    mockS3Send.mockResolvedValue({});

    await publisher.publish(
      'abc123',
      makeFileAsset(),
      '/tmp/cdk.out',
      '123456789012',
      'us-east-1'
    );

    expect(HeadObjectCommand).toHaveBeenCalled();
    expect(PutObjectCommand).not.toHaveBeenCalled();
    expect(createReadStream).not.toHaveBeenCalled();
  });

  it('should handle ZIP packaging', async () => {
    mockS3Send.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'HeadObject') {
        const err = new Error('Not Found') as Error & { name: string; $metadata: { httpStatusCode: number } };
        err.name = 'NotFound';
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {};
    });

    vi.mocked(statSync).mockReturnValue({
      size: 2048,
      isDirectory: () => true,
    } as ReturnType<typeof statSync>);

    const zipAsset = makeFileAsset({
      source: { path: 'asset.zip123', packaging: 'zip' },
    });

    await publisher.publish(
      'zip123',
      zipAsset,
      '/tmp/cdk.out',
      '123456789012',
      'us-east-1'
    );

    // Should use archiver for zip packaging (PutObjectCommand called with Buffer body)
    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'cdk-assets-123456789012-us-east-1',
        Key: 'assets/abc123.js',
      })
    );
  });

  it('should resolve placeholders', async () => {
    mockS3Send.mockResolvedValue({}); // HeadObject succeeds (skip upload)

    const asset = makeFileAsset({
      destinations: {
        dest1: {
          bucketName: 'bucket-${AWS::AccountId}-${AWS::Region}',
          objectKey: '${AWS::Partition}/assets/key.js',
          region: '${AWS::Region}',
        },
      },
    });

    await publisher.publish(
      'hash1',
      asset,
      '/tmp/cdk.out',
      '111122223333',
      'ap-northeast-1'
    );

    expect(HeadObjectCommand).toHaveBeenCalledWith({
      Bucket: 'bucket-111122223333-ap-northeast-1',
      Key: 'aws/assets/key.js',
    });
  });

  it('should handle S3 upload errors', async () => {
    mockS3Send.mockImplementation((cmd: { _type?: string }) => {
      if (cmd._type === 'HeadObject') {
        const err = new Error('Not Found') as Error & { name: string; $metadata: { httpStatusCode: number } };
        err.name = 'NotFound';
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      if (cmd._type === 'PutObject') {
        throw new Error('Access Denied');
      }
      return {};
    });

    await expect(
      publisher.publish(
        'abc123',
        makeFileAsset(),
        '/tmp/cdk.out',
        '123456789012',
        'us-east-1'
      )
    ).rejects.toThrow('Access Denied');

    expect(mockS3Destroy).toHaveBeenCalled();
  });
});
