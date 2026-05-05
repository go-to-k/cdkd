import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetTableBucketCommand,
  GetTableCommand,
  NotFoundException,
} from '@aws-sdk/client-s3tables';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-s3tables', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3tables')>(
    '@aws-sdk/client-s3tables'
  );
  class MockS3TablesClient {
    config = { region: () => Promise.resolve('us-east-1') };
    send = mockSend;
  }
  return { ...actual, S3TablesClient: MockS3TablesClient };
});

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

import { S3TablesProvider } from '../../../src/provisioning/providers/s3-tables-provider.js';

describe('S3TablesProvider.readCurrentState', () => {
  let provider: S3TablesProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3TablesProvider();
  });

  describe('AWS::S3Tables::TableBucket', () => {
    it('returns TableBucketName from GetTableBucket (happy path)', async () => {
      mockSend.mockResolvedValueOnce({
        name: 'my-bucket',
        arn: 'arn:aws:s3tables:us-east-1:123:bucket/my-bucket',
      });

      const result = await provider.readCurrentState(
        'arn:aws:s3tables:us-east-1:123:bucket/my-bucket',
        'Logical',
        'AWS::S3Tables::TableBucket'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetTableBucketCommand);
      expect(result).toEqual({ TableBucketName: 'my-bucket' });
    });

    it('returns undefined when bucket gone', async () => {
      mockSend.mockRejectedValueOnce(
        new NotFoundException({ message: 'gone', $metadata: {} })
      );
      const result = await provider.readCurrentState(
        'arn:aws:s3tables:us-east-1:123:bucket/my-bucket',
        'Logical',
        'AWS::S3Tables::TableBucket'
      );
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::S3Tables::Namespace', () => {
    it('parses physical id and surfaces TableBucketARN + Namespace (no SDK call)', async () => {
      const physicalId = 'arn:aws:s3tables:us-east-1:123:bucket/my-bucket|my-namespace';
      const result = await provider.readCurrentState(
        physicalId,
        'Logical',
        'AWS::S3Tables::Namespace'
      );

      expect(result).toEqual({
        TableBucketARN: 'arn:aws:s3tables:us-east-1:123:bucket/my-bucket',
        Namespace: ['my-namespace'],
      });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns undefined for malformed physical id', async () => {
      const result = await provider.readCurrentState(
        'malformed',
        'Logical',
        'AWS::S3Tables::Namespace'
      );
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::S3Tables::Table', () => {
    it('returns TableBucketARN + Namespace + Name + Format (happy path)', async () => {
      mockSend.mockResolvedValueOnce({
        name: 'my-table',
        format: 'ICEBERG',
        namespace: ['my-namespace'],
      });

      const physicalId = 'arn:aws:s3tables:us-east-1:123:bucket/my-bucket|my-namespace|my-table';
      const result = await provider.readCurrentState(
        physicalId,
        'Logical',
        'AWS::S3Tables::Table'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetTableCommand);
      expect(result).toEqual({
        TableBucketARN: 'arn:aws:s3tables:us-east-1:123:bucket/my-bucket',
        Namespace: 'my-namespace',
        Name: 'my-table',
        Format: 'ICEBERG',
      });
    });

    it('returns undefined when table gone', async () => {
      mockSend.mockRejectedValueOnce(
        new NotFoundException({ message: 'gone', $metadata: {} })
      );
      const result = await provider.readCurrentState(
        'arn:aws:s3tables:us-east-1:123:bucket/my-bucket|ns|tbl',
        'Logical',
        'AWS::S3Tables::Table'
      );
      expect(result).toBeUndefined();
    });
  });
});
