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

import {
  CreateVectorBucketCommand,
  DeleteVectorBucketCommand,
  GetVectorBucketCommand,
  ListIndexesCommand,
  DeleteIndexCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-s3vectors';
import { S3VectorsProvider } from '../../../../src/provisioning/providers/s3-vectors-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../../src/utils/error-handler.js';

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

    it('forwards Tags into CreateVectorBucket as the SDK Record<string,string> shape', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof CreateVectorBucketCommand) {
          return Promise.resolve({
            vectorBucketArn:
              'arn:aws:s3vectors:us-east-1:123456789012:vector-bucket/tagged-vector-bucket',
          });
        }
        return Promise.resolve({});
      });

      await provider.create('MyVectorBucket', 'AWS::S3Vectors::VectorBucket', {
        VectorBucketName: 'tagged-vector-bucket',
        Tags: [
          { Key: 'env', Value: 'prod' },
          { Key: 'team', Value: 'platform' },
        ],
      });

      const createCall = mockSend.mock.calls.find(
        (call: unknown[]) => call[0] instanceof CreateVectorBucketCommand
      );
      expect(createCall![0].input).toEqual({
        vectorBucketName: 'tagged-vector-bucket',
        encryptionConfiguration: undefined,
        tags: { env: 'prod', team: 'platform' },
      });
    });

    it('omits tags from CreateVectorBucket when Tags absent or empty', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof CreateVectorBucketCommand) {
          return Promise.resolve({
            vectorBucketArn: 'arn:aws:s3vectors:us-east-1:0:vector-bucket/no-tags',
          });
        }
        return Promise.resolve({});
      });

      // Absent
      await provider.create('A', 'AWS::S3Vectors::VectorBucket', {
        VectorBucketName: 'no-tags',
      });
      // Empty array
      await provider.create('B', 'AWS::S3Vectors::VectorBucket', {
        VectorBucketName: 'no-tags',
        Tags: [],
      });

      const createCalls = mockSend.mock.calls.filter(
        (call: unknown[]) => call[0] instanceof CreateVectorBucketCommand
      );
      expect(createCalls).toHaveLength(2);
      for (const call of createCalls) {
        const input = call![0].input as { tags?: unknown };
        expect(input.tags).toBeUndefined();
      }
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
    const ARN = 'arn:aws:s3vectors:us-east-1:123456789012:vector-bucket/my-vector-bucket';

    it('is a no-op (no AWS calls) when there is no tag delta', async () => {
      const tags = [{ Key: 'env', Value: 'prod' }];
      const result = await provider.update(
        'MyVectorBucket',
        'my-vector-bucket',
        'AWS::S3Vectors::VectorBucket',
        { Tags: tags },
        { Tags: tags }
      );

      expect(result.physicalId).toBe('my-vector-bucket');
      expect(result.wasReplaced).toBe(false);
      // No tag diff → no ARN lookup, no Tag/Untag calls.
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('applies added / changed tags via TagResource (resolving the ARN first)', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetVectorBucketCommand) {
          return Promise.resolve({ vectorBucket: { vectorBucketArn: ARN } });
        }
        return Promise.resolve({});
      });

      await provider.update(
        'MyVectorBucket',
        'my-vector-bucket',
        'AWS::S3Vectors::VectorBucket',
        { Tags: [{ Key: 'env', Value: 'prod' }, { Key: 'new', Value: 'added' }] },
        { Tags: [{ Key: 'env', Value: 'dev' }] }
      );

      const tagCall = mockSend.mock.calls.find(
        (call: unknown[]) => call[0] instanceof TagResourceCommand
      );
      expect(tagCall).toBeDefined();
      // env changed dev->prod AND new added; both go in one TagResource.
      expect(tagCall![0].input).toEqual({ resourceArn: ARN, tags: { env: 'prod', new: 'added' } });
      // No removed keys → no UntagResource.
      expect(
        mockSend.mock.calls.find((call: unknown[]) => call[0] instanceof UntagResourceCommand)
      ).toBeUndefined();
    });

    it('removes dropped tags via UntagResource', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetVectorBucketCommand) {
          return Promise.resolve({ vectorBucket: { vectorBucketArn: ARN } });
        }
        return Promise.resolve({});
      });

      await provider.update(
        'MyVectorBucket',
        'my-vector-bucket',
        'AWS::S3Vectors::VectorBucket',
        { Tags: [{ Key: 'env', Value: 'prod' }] },
        { Tags: [{ Key: 'env', Value: 'prod' }, { Key: 'stale', Value: 'x' }] }
      );

      const untagCall = mockSend.mock.calls.find(
        (call: unknown[]) => call[0] instanceof UntagResourceCommand
      );
      expect(untagCall).toBeDefined();
      expect(untagCall![0].input).toEqual({ resourceArn: ARN, tagKeys: ['stale'] });
    });

    it('THROWS (does not swallow) when the tag API fails — state must not be written', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetVectorBucketCommand) {
          return Promise.resolve({ vectorBucket: { vectorBucketArn: ARN } });
        }
        if (cmd instanceof TagResourceCommand) {
          return Promise.reject(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
        }
        return Promise.resolve({});
      });

      await expect(
        provider.update(
          'MyVectorBucket',
          'my-vector-bucket',
          'AWS::S3Vectors::VectorBucket',
          { Tags: [{ Key: 'new', Value: 'v' }] },
          {}
        )
      ).rejects.toThrow(/Failed to update tags/);
    });

    it('rejects an immutable (create-only) property change with ResourceUpdateNotSupportedError', async () => {
      await expect(
        provider.update(
          'MyVectorBucket',
          'my-vector-bucket',
          'AWS::S3Vectors::VectorBucket',
          { EncryptionConfiguration: { SSEType: 'aws:kms' } },
          { EncryptionConfiguration: { SSEType: 'AES256' } }
        )
      ).rejects.toThrow(ResourceUpdateNotSupportedError);
      // Must fail BEFORE any AWS call.
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects a VectorBucketName (create-only) change before any AWS call', async () => {
      await expect(
        provider.update(
          'MyVectorBucket',
          'my-vector-bucket',
          'AWS::S3Vectors::VectorBucket',
          { VectorBucketName: 'renamed-bucket' },
          { VectorBucketName: 'my-vector-bucket' }
        )
      ).rejects.toThrow(ResourceUpdateNotSupportedError);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('THROWS when GetVectorBucket (ARN resolution) fails', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetVectorBucketCommand) {
          return Promise.reject(
            Object.assign(new Error('throttled'), { name: 'ThrottlingException' })
          );
        }
        return Promise.resolve({});
      });

      await expect(
        provider.update(
          'MyVectorBucket',
          'my-vector-bucket',
          'AWS::S3Vectors::VectorBucket',
          { Tags: [{ Key: 'new', Value: 'v' }] },
          {}
        )
      ).rejects.toThrow(/Failed to resolve ARN/);
      // The tag write must NOT be attempted when the ARN is unknown.
      expect(
        mockSend.mock.calls.find((call: unknown[]) => call[0] instanceof TagResourceCommand)
      ).toBeUndefined();
    });

    it('THROWS when GetVectorBucket returns no ARN', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof GetVectorBucketCommand) {
          return Promise.resolve({ vectorBucket: {} }); // ARN-less response
        }
        return Promise.resolve({});
      });

      await expect(
        provider.update(
          'MyVectorBucket',
          'my-vector-bucket',
          'AWS::S3Vectors::VectorBucket',
          { Tags: [{ Key: 'new', Value: 'v' }] },
          {}
        )
      ).rejects.toThrow(/Could not resolve ARN/);
    });
  });

  describe('import', () => {
    function makeInput(overrides: Record<string, unknown> = {}) {
      return {
        logicalId: 'MyVectorBucket',
        resourceType: 'AWS::S3Vectors::VectorBucket',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {} as Record<string, unknown>,
        ...overrides,
      };
    }

    it('verifies explicit VectorBucketName via GetVectorBucket', async () => {
      mockSend.mockResolvedValueOnce({ vectorBucket: { vectorBucketName: 'my-bucket' } });
      const result = await provider.import!(makeInput({ knownPhysicalId: 'my-bucket' }));
      expect(result).toEqual({ physicalId: 'my-bucket', attributes: {} });
    });

    it('uses Properties.VectorBucketName when no knownPhysicalId is given', async () => {
      mockSend.mockResolvedValueOnce({ vectorBucket: { vectorBucketName: 'my-bucket' } });
      const result = await provider.import!(
        makeInput({ properties: { VectorBucketName: 'my-bucket' } })
      );
      expect(result?.physicalId).toBe('my-bucket');
    });

    it('returns null without override and without an explicit id', async () => {
      const result = await provider.import!(makeInput());
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
