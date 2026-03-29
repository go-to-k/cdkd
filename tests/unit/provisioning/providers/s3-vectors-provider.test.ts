import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3vectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3vectors')>();
  return {
    ...actual,
    S3VectorsClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
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

import {
  CreateVectorBucketCommand,
  DeleteVectorBucketCommand,
  ListIndexesCommand,
  DeleteIndexCommand,
} from '@aws-sdk/client-s3vectors';
import { S3VectorsProvider } from '../../../../src/provisioning/providers/s3-vectors-provider.js';

describe('S3VectorsProvider', () => {
  let provider: S3VectorsProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3VectorsProvider();
  });

  describe('create', () => {
    it('should create a vector bucket', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof CreateVectorBucketCommand) {
          return Promise.resolve({
            vectorBucketArn: 'arn:aws:s3vectors:us-east-1:123456789012:vector-bucket/my-vector-bucket',
          });
        }
        return Promise.resolve({});
      });

      const result = await provider.create('MyVectorBucket', 'AWS::S3Vectors::VectorBucket', {
        VectorBucketName: 'my-vector-bucket',
      });

      expect(result.physicalId).toBe('my-vector-bucket');
      expect(result.attributes).toEqual({
        VectorBucketArn: 'arn:aws:s3vectors:us-east-1:123456789012:vector-bucket/my-vector-bucket',
      });

      const createCall = mockSend.mock.calls.find(
        (call: unknown[]) => call[0] instanceof CreateVectorBucketCommand
      );
      expect(createCall).toBeDefined();
      expect(createCall![0].input).toEqual({
        vectorBucketName: 'my-vector-bucket',
        encryptionConfiguration: undefined,
      });
    });
  });

  describe('delete', () => {
    it('should delete a vector bucket with no indexes', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof ListIndexesCommand) {
          return Promise.resolve({ indexes: [], nextToken: undefined });
        }
        if (cmd instanceof DeleteVectorBucketCommand) {
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      await provider.delete('MyVectorBucket', 'my-vector-bucket', 'AWS::S3Vectors::VectorBucket');

      const listCall = mockSend.mock.calls.find(
        (call: unknown[]) => call[0] instanceof ListIndexesCommand
      );
      expect(listCall).toBeDefined();

      const deleteCall = mockSend.mock.calls.find(
        (call: unknown[]) => call[0] instanceof DeleteVectorBucketCommand
      );
      expect(deleteCall).toBeDefined();
      expect(deleteCall![0].input).toEqual({
        vectorBucketName: 'my-vector-bucket',
      });

      // No DeleteIndexCommand should have been called
      const deleteIndexCalls = mockSend.mock.calls.filter(
        (call: unknown[]) => call[0] instanceof DeleteIndexCommand
      );
      expect(deleteIndexCalls).toHaveLength(0);
    });

    it('should delete all indexes before deleting the vector bucket', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof ListIndexesCommand) {
          return Promise.resolve({
            indexes: [
              { indexName: 'index-1' },
              { indexName: 'index-2' },
            ],
            nextToken: undefined,
          });
        }
        if (cmd instanceof DeleteIndexCommand) {
          return Promise.resolve({});
        }
        if (cmd instanceof DeleteVectorBucketCommand) {
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      await provider.delete('MyVectorBucket', 'my-vector-bucket', 'AWS::S3Vectors::VectorBucket');

      // Verify ListIndexes was called
      const listCall = mockSend.mock.calls.find(
        (call: unknown[]) => call[0] instanceof ListIndexesCommand
      );
      expect(listCall).toBeDefined();
      expect(listCall![0].input).toEqual({
        vectorBucketName: 'my-vector-bucket',
        nextToken: undefined,
      });

      // Verify DeleteIndex was called for each index
      const deleteIndexCalls = mockSend.mock.calls.filter(
        (call: unknown[]) => call[0] instanceof DeleteIndexCommand
      );
      expect(deleteIndexCalls).toHaveLength(2);
      expect(deleteIndexCalls[0][0].input).toEqual({
        vectorBucketName: 'my-vector-bucket',
        indexName: 'index-1',
      });
      expect(deleteIndexCalls[1][0].input).toEqual({
        vectorBucketName: 'my-vector-bucket',
        indexName: 'index-2',
      });

      // Verify DeleteVectorBucket was called
      const deleteBucketCall = mockSend.mock.calls.find(
        (call: unknown[]) => call[0] instanceof DeleteVectorBucketCommand
      );
      expect(deleteBucketCall).toBeDefined();
    });

    it('should treat not-found as success (idempotent)', async () => {
      const notFoundError = new Error('Vector bucket not found');
      notFoundError.name = 'NotFoundException';
      mockSend.mockRejectedValueOnce(notFoundError);

      await expect(
        provider.delete('MyVectorBucket', 'my-vector-bucket', 'AWS::S3Vectors::VectorBucket')
      ).resolves.not.toThrow();

      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    it('should be a no-op and return the existing physicalId', async () => {
      const result = await provider.update(
        'MyVectorBucket',
        'my-vector-bucket',
        'AWS::S3Vectors::VectorBucket',
        {},
        {}
      );

      expect(result.physicalId).toBe('my-vector-bucket');
      expect(result.wasReplaced).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
