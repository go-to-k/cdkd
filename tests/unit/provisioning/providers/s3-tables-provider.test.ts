import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3tables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3tables')>();
  return {
    ...actual,
    S3TablesClient: vi.fn().mockImplementation(() => ({
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
  CreateTableBucketCommand,
  DeleteTableBucketCommand,
  CreateNamespaceCommand,
  DeleteNamespaceCommand,
  CreateTableCommand,
  DeleteTableCommand,
  ListNamespacesCommand,
  ListTablesCommand,
  NotFoundException,
} from '@aws-sdk/client-s3tables';
import { S3TablesProvider } from '../../../../src/provisioning/providers/s3-tables-provider.js';

describe('S3TablesProvider', () => {
  let provider: S3TablesProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3TablesProvider();
  });

  // ─── createTableBucket ────────────────────────────────────────────

  describe('createTableBucket', () => {
    it('should create a table bucket and return ARN', async () => {
      const arn = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-table-bucket';
      mockSend.mockResolvedValueOnce({ arn });

      const result = await provider.create('MyTableBucket', 'AWS::S3Tables::TableBucket', {
        TableBucketName: 'my-table-bucket',
      });

      expect(result.physicalId).toBe(arn);
      expect(result.attributes).toEqual({ TableBucketARN: arn });
      expect(mockSend).toHaveBeenCalledWith(expect.any(CreateTableBucketCommand));
    });
  });

  // ─── deleteTableBucket ────────────────────────────────────────────

  describe('deleteTableBucket', () => {
    const tableBucketARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-table-bucket';

    it('should delete an empty table bucket (no namespaces)', async () => {
      // ListNamespaces returns empty
      mockSend.mockResolvedValueOnce({ namespaces: [] });
      // DeleteTableBucket
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyTableBucket', tableBucketARN, 'AWS::S3Tables::TableBucket');

      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend).toHaveBeenCalledWith(expect.any(ListNamespacesCommand));
      expect(mockSend).toHaveBeenCalledWith(expect.any(DeleteTableBucketCommand));
    });

    it('should empty table bucket with namespaces and tables before deleting', async () => {
      // ListNamespaces returns one namespace
      mockSend.mockResolvedValueOnce({
        namespaces: [{ namespace: ['ns1'] }],
      });
      // ListTables for ns1 returns one table
      mockSend.mockResolvedValueOnce({
        tables: [{ name: 'table1' }],
      });
      // DeleteTable for table1
      mockSend.mockResolvedValueOnce({});
      // DeleteNamespace for ns1
      mockSend.mockResolvedValueOnce({});
      // DeleteTableBucket
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyTableBucket', tableBucketARN, 'AWS::S3Tables::TableBucket');

      expect(mockSend).toHaveBeenCalledTimes(5);
      expect(mockSend).toHaveBeenCalledWith(expect.any(ListNamespacesCommand));
      expect(mockSend).toHaveBeenCalledWith(expect.any(ListTablesCommand));
      expect(mockSend).toHaveBeenCalledWith(expect.any(DeleteTableCommand));
      expect(mockSend).toHaveBeenCalledWith(expect.any(DeleteNamespaceCommand));
      expect(mockSend).toHaveBeenCalledWith(expect.any(DeleteTableBucketCommand));
    });

    it('should treat NotFoundException as idempotent success', async () => {
      // ListNamespaces throws NotFoundException (bucket already gone)
      mockSend.mockRejectedValueOnce(
        new NotFoundException({ message: 'Not found', $metadata: {} })
      );

      await expect(
        provider.delete('MyTableBucket', tableBucketARN, 'AWS::S3Tables::TableBucket')
      ).resolves.toBeUndefined();
    });
  });

  // ─── createNamespace ──────────────────────────────────────────────

  describe('createNamespace', () => {
    it('should create a namespace and return composite physical ID', async () => {
      const tableBucketARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket';
      mockSend.mockResolvedValueOnce({});

      const result = await provider.create('MyNamespace', 'AWS::S3Tables::Namespace', {
        TableBucketARN: tableBucketARN,
        Namespace: ['my-namespace'],
      });

      expect(result.physicalId).toBe(`${tableBucketARN}|my-namespace`);
      expect(result.attributes).toEqual({});
      expect(mockSend).toHaveBeenCalledWith(expect.any(CreateNamespaceCommand));
    });
  });

  // ─── deleteNamespace ──────────────────────────────────────────────

  describe('deleteNamespace', () => {
    it('should delete a namespace', async () => {
      const physicalId = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket|my-namespace';
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyNamespace', physicalId, 'AWS::S3Tables::Namespace');

      expect(mockSend).toHaveBeenCalledWith(expect.any(DeleteNamespaceCommand));
    });
  });

  // ─── createTable ──────────────────────────────────────────────────

  describe('createTable', () => {
    it('should create a table and return composite physical ID', async () => {
      const tableBucketARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket';
      mockSend.mockResolvedValueOnce({});

      const result = await provider.create('MyTable', 'AWS::S3Tables::Table', {
        TableBucketARN: tableBucketARN,
        Namespace: 'my-namespace',
        Name: 'my-table',
        Format: 'ICEBERG',
      });

      expect(result.physicalId).toBe(`${tableBucketARN}|my-namespace|my-table`);
      expect(result.attributes).toEqual({});
      expect(mockSend).toHaveBeenCalledWith(expect.any(CreateTableCommand));
    });
  });

  // ─── deleteTable ──────────────────────────────────────────────────

  describe('deleteTable', () => {
    it('should delete a table', async () => {
      const physicalId =
        'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket|my-namespace|my-table';
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyTable', physicalId, 'AWS::S3Tables::Table');

      expect(mockSend).toHaveBeenCalledWith(expect.any(DeleteTableCommand));
    });
  });

  // ─── update (no-op) ───────────────────────────────────────────────

  describe('update', () => {
    it('should be no-op for TableBucket', async () => {
      const physicalId = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket';
      const result = await provider.update(
        'MyTableBucket',
        physicalId,
        'AWS::S3Tables::TableBucket',
        {},
        {}
      );

      expect(result).toEqual({ physicalId, wasReplaced: false });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should be no-op for Namespace', async () => {
      const physicalId = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket|ns';
      const result = await provider.update(
        'MyNs',
        physicalId,
        'AWS::S3Tables::Namespace',
        {},
        {}
      );

      expect(result).toEqual({ physicalId, wasReplaced: false });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should be no-op for Table', async () => {
      const physicalId = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket|ns|tbl';
      const result = await provider.update('MyTbl', physicalId, 'AWS::S3Tables::Table', {}, {});

      expect(result).toEqual({ physicalId, wasReplaced: false });
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('import', () => {
    function makeInput(overrides: Record<string, unknown> = {}) {
      return {
        logicalId: 'MyTableBucket',
        resourceType: 'AWS::S3Tables::TableBucket',
        cdkPath: 'MyStack/MyTableBucket',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {} as Record<string, unknown>,
        ...overrides,
      };
    }

    it('verifies explicit TableBucket ARN via GetTableBucket', async () => {
      const arn = 'arn:aws:s3tables:us-east-1:123:bucket/my-bucket';
      mockSend.mockResolvedValueOnce({ arn });
      const result = await provider.import!(makeInput({ knownPhysicalId: arn }));
      expect(result).toEqual({ physicalId: arn, attributes: {} });
    });

    it('finds TableBucket by TableBucketName property', async () => {
      const arn = 'arn:aws:s3tables:us-east-1:123:bucket/my-bucket';
      mockSend.mockResolvedValueOnce({
        tableBuckets: [
          // mine first so the Name match short-circuits before cdk:path
          // tag lookup of 'other' (which would need its own ListTags mock).
          { arn, name: 'my-bucket' },
          { arn: 'arn:aws:s3tables:us-east-1:123:bucket/other', name: 'other' },
        ],
      });
      const result = await provider.import!(
        makeInput({ properties: { TableBucketName: 'my-bucket' } })
      );
      expect(result?.physicalId).toBe(arn);
    });

    it('returns null for unsupported resource types', async () => {
      const result = await provider.import!(
        makeInput({ resourceType: 'AWS::S3Tables::Other' })
      );
      expect(result).toBeNull();
    });
  });
});
