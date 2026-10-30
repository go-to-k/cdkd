import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableBucketCommand,
  CreateTableCommand,
  DeleteTableBucketMetricsConfigurationCommand,
  DeleteTableBucketReplicationCommand,
  GetTableBucketCommand,
  GetTableCommand,
  NotFoundException,
  PutTableBucketEncryptionCommand,
  PutTableBucketMaintenanceConfigurationCommand,
  PutTableBucketMetricsConfigurationCommand,
  PutTableBucketReplicationCommand,
  PutTableBucketStorageClassCommand,
  PutTableMaintenanceConfigurationCommand,
  RenameTableCommand,
} from '@aws-sdk/client-s3tables';

const mockSend = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

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
    warn,
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
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

/** Records each command name and each `mark:<key>` in one sequence. */
function orderRecorder(): { order: string[]; markUnsettled: (key: string) => void } {
  const order: string[] = [];
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    order.push(command.constructor.name);
    return Promise.resolve({});
  });
  return { order, markUnsettled: (key: string) => order.push(`mark:${key}`) };
}

/**
 * The S3 Tables configuration properties wired by go-to-k/cdkd#2762: what each
 * create / update sends, the removal semantics, and the readback. The wire
 * cases (`sdk-wire-cases-7-s3tables.ts`) prove every leaf reaches its member;
 * these pin the requests whole, the order, and the paths the probes skip.
 */

const BUCKET = 'AWS::S3Tables::TableBucket';
const TABLE = 'AWS::S3Tables::Table';
const BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/tb';
const TABLE_ARN = `${BUCKET_ARN}/table/OPAQUE`;
const TABLE_ID = `${BUCKET_ARN}|ns|tbl`;
const KEY_ARN = 'arn:aws:kms:us-east-1:123456789012:key/k';
const ROLE_ARN = 'arn:aws:iam::123456789012:role/r';
const DEST_ARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/dest';

const notFound = (): NotFoundException => new NotFoundException({ message: 'nf', $metadata: {} });

/** Every request sent, as `[command name, input]`. */
const sent = (): [string, unknown][] =>
  mockSend.mock.calls.map((c) => [c[0].constructor.name, c[0].input]);

const REPLICATION = {
  Role: ROLE_ARN,
  Rules: [{ Destinations: [{ DestinationTableBucketARN: DEST_ARN }] }],
};

const FULL_BUCKET = {
  TableBucketName: 'tb',
  EncryptionConfiguration: { SSEAlgorithm: 'aws:kms', KMSKeyArn: KEY_ARN },
  StorageClassConfiguration: { StorageClass: 'INTELLIGENT_TIERING' },
  MetricsConfiguration: { Status: 'Enabled' },
  UnreferencedFileRemoval: { Status: 'Disabled', UnreferencedDays: 5, NoncurrentDays: 7 },
  ReplicationConfiguration: REPLICATION,
};

describe('S3 Tables configuration properties (go-to-k/cdkd#2762)', () => {
  let provider: S3TablesProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warn.mockReset();
    provider = new S3TablesProvider();
  });

  describe('AWS::S3Tables::TableBucket create', () => {
    it('sends encryption and storage class on CreateTableBucket, the rest by their own Put after it', async () => {
      mockSend.mockResolvedValueOnce({ arn: BUCKET_ARN });
      mockSend.mockResolvedValue({});

      await provider.create('B', BUCKET, structuredClone(FULL_BUCKET));

      expect(sent()).toEqual([
        [
          CreateTableBucketCommand.name,
          {
            name: 'tb',
            encryptionConfiguration: { sseAlgorithm: 'aws:kms', kmsKeyArn: KEY_ARN },
            storageClassConfiguration: { storageClass: 'INTELLIGENT_TIERING' },
          },
        ],
        [PutTableBucketMetricsConfigurationCommand.name, { tableBucketARN: BUCKET_ARN }],
        [
          PutTableBucketMaintenanceConfigurationCommand.name,
          {
            tableBucketARN: BUCKET_ARN,
            type: 'icebergUnreferencedFileRemoval',
            value: {
              status: 'disabled',
              settings: { icebergUnreferencedFileRemoval: { unreferencedDays: 5, nonCurrentDays: 7 } },
            },
          },
        ],
        [
          PutTableBucketReplicationCommand.name,
          {
            tableBucketARN: BUCKET_ARN,
            configuration: {
              role: ROLE_ARN,
              rules: [{ destinations: [{ destinationTableBucketARN: DEST_ARN }] }],
            },
          },
        ],
      ]);
    });

    it('sends no metrics call for a Disabled (default) MetricsConfiguration', async () => {
      mockSend.mockResolvedValueOnce({ arn: BUCKET_ARN });

      await provider.create('B', BUCKET, {
        TableBucketName: 'tb',
        MetricsConfiguration: { Status: 'Disabled' },
      });

      expect(sent().map(([name]) => name)).toEqual([CreateTableBucketCommand.name]);
    });

    it('marks the bucket created when a configuration call after CreateTableBucket fails', async () => {
      mockSend.mockResolvedValueOnce({ arn: BUCKET_ARN });
      mockSend.mockRejectedValueOnce(new Error('replication refused'));

      const error = await provider
        .create('B', BUCKET, { TableBucketName: 'tb', ReplicationConfiguration: REPLICATION })
        .catch((e: unknown) => e);

      expect(String(error)).toContain('replication refused');
      expect(createdBeforeFailure(error, 'B', BUCKET)).toBe(BUCKET_ARN);
    });

    it.each([
      ['MetricsConfiguration', { Status: 'Enabled' }],
      ['UnreferencedFileRemoval', { Status: 'Enabled', UnreferencedDays: 3 }],
    ])('marks the bucket created when its %s call after CreateTableBucket fails', async (key, value) => {
      mockSend.mockResolvedValueOnce({ arn: BUCKET_ARN });
      mockSend.mockRejectedValueOnce(new Error('refused'));

      const error = await provider
        .create('B', BUCKET, { TableBucketName: 'tb', [key]: value })
        .catch((e: unknown) => e);

      expect(createdBeforeFailure(error, 'B', BUCKET)).toBe(BUCKET_ARN);
    });

    it('refuses a non-integer day count before any call', async () => {
      await expect(
        provider.create('B', BUCKET, {
          TableBucketName: 'tb',
          UnreferencedFileRemoval: { Status: 'Enabled', UnreferencedDays: 'three' },
        })
      ).rejects.toThrow(
        'UnreferencedFileRemoval.UnreferencedDays for AWS::S3Tables::TableBucket B must be an integer'
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('marks nothing when CreateTableBucket itself fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('denied'));

      const error = await provider
        .create('B', BUCKET, { TableBucketName: 'tb' })
        .catch((e: unknown) => e);

      expect(createdBeforeFailure(error, 'B', BUCKET)).toBeUndefined();
    });

    it.each([
      ['EncryptionConfiguration', 'aws:kms'],
      ['ReplicationConfiguration', [REPLICATION]],
      ['UnreferencedFileRemoval', null],
    ])('refuses a non-object %s before any call', async (key, value) => {
      await expect(
        provider.create('B', BUCKET, { TableBucketName: 'tb', [key]: value })
      ).rejects.toThrow(`${key} for ${BUCKET} B must be an object`);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a MetricsConfiguration.Status the schema does not allow, before any call', async () => {
      await expect(
        provider.create('B', BUCKET, {
          TableBucketName: 'tb',
          MetricsConfiguration: { Status: 'On' },
        })
      ).rejects.toThrow(/MetricsConfiguration\.Status .* must be 'Enabled' or 'Disabled'/);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('AWS::S3Tables::TableBucket update', () => {
    it('sends nothing when no configuration property changed', async () => {
      await provider.update('B', BUCKET_ARN, BUCKET, structuredClone(FULL_BUCKET), FULL_BUCKET);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('sends exactly one Put for a change to one nested member', async () => {
      mockSend.mockResolvedValue({});
      const next = structuredClone(FULL_BUCKET);
      next.UnreferencedFileRemoval.UnreferencedDays = 6;

      await provider.update('B', BUCKET_ARN, BUCKET, next, FULL_BUCKET);

      expect(sent()).toEqual([
        [
          PutTableBucketMaintenanceConfigurationCommand.name,
          {
            tableBucketARN: BUCKET_ARN,
            type: 'icebergUnreferencedFileRemoval',
            value: {
              status: 'disabled',
              settings: { icebergUnreferencedFileRemoval: { unreferencedDays: 6, nonCurrentDays: 7 } },
            },
          },
        ],
      ]);
    });

    it('treats an empty MetricsConfiguration as the absent default', async () => {
      await provider.update(
        'B',
        BUCKET_ARN,
        BUCKET,
        { TableBucketName: 'tb', MetricsConfiguration: {} },
        { TableBucketName: 'tb' }
      );
      await provider.update(
        'B',
        BUCKET_ARN,
        BUCKET,
        { TableBucketName: 'tb' },
        { TableBucketName: 'tb', MetricsConfiguration: { Status: 'Disabled' } }
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('stops at a failed write: the later configuration writes are not sent', async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockRejectedValueOnce(new Error('storage class refused'));

      await expect(
        provider.update('B', BUCKET_ARN, BUCKET, structuredClone(FULL_BUCKET), {
          TableBucketName: 'tb',
        })
      ).rejects.toThrow(/storage class refused/);

      expect(sent().map(([name]) => name)).toEqual([
        PutTableBucketEncryptionCommand.name,
        PutTableBucketStorageClassCommand.name,
      ]);
    });

    it('sends each changed property by its own call', async () => {
      mockSend.mockResolvedValue({});
      const prev = { TableBucketName: 'tb' };

      await provider.update('B', BUCKET_ARN, BUCKET, structuredClone(FULL_BUCKET), prev);

      expect(sent()).toEqual([
        [
          PutTableBucketEncryptionCommand.name,
          {
            tableBucketARN: BUCKET_ARN,
            encryptionConfiguration: { sseAlgorithm: 'aws:kms', kmsKeyArn: KEY_ARN },
          },
        ],
        [
          PutTableBucketStorageClassCommand.name,
          {
            tableBucketARN: BUCKET_ARN,
            storageClassConfiguration: { storageClass: 'INTELLIGENT_TIERING' },
          },
        ],
        [PutTableBucketMetricsConfigurationCommand.name, { tableBucketARN: BUCKET_ARN }],
        [
          PutTableBucketMaintenanceConfigurationCommand.name,
          {
            tableBucketARN: BUCKET_ARN,
            type: 'icebergUnreferencedFileRemoval',
            value: {
              status: 'disabled',
              settings: { icebergUnreferencedFileRemoval: { unreferencedDays: 5, nonCurrentDays: 7 } },
            },
          },
        ],
        [
          PutTableBucketReplicationCommand.name,
          {
            tableBucketARN: BUCKET_ARN,
            configuration: {
              role: ROLE_ARN,
              rules: [{ destinations: [{ destinationTableBucketARN: DEST_ARN }] }],
            },
          },
        ],
      ]);
    });

    it('marks each property unsettled immediately before its write', async () => {
      const order: string[] = [];
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        order.push(command.constructor.name);
        return Promise.resolve({});
      });
      const markUnsettled = vi.fn((key: string) => order.push(`mark:${key}`));

      await provider.update(
        'B',
        BUCKET_ARN,
        BUCKET,
        structuredClone(FULL_BUCKET),
        { TableBucketName: 'tb' },
        { markUnsettled }
      );

      expect(order).toEqual([
        'mark:EncryptionConfiguration',
        PutTableBucketEncryptionCommand.name,
        'mark:StorageClassConfiguration',
        PutTableBucketStorageClassCommand.name,
        'mark:MetricsConfiguration',
        PutTableBucketMetricsConfigurationCommand.name,
        'mark:UnreferencedFileRemoval',
        PutTableBucketMaintenanceConfigurationCommand.name,
        'mark:ReplicationConfiguration',
        PutTableBucketReplicationCommand.name,
      ]);
    });

    it('deletes metrics and replication on removal, tolerating an already-absent metrics configuration', async () => {
      mockSend.mockRejectedValueOnce(notFound());
      mockSend.mockResolvedValueOnce({ arn: BUCKET_ARN });
      mockSend.mockResolvedValueOnce({});

      await provider.update('B', BUCKET_ARN, BUCKET, { TableBucketName: 'tb' }, FULL_BUCKET);

      expect(sent()).toEqual([
        [DeleteTableBucketMetricsConfigurationCommand.name, { tableBucketARN: BUCKET_ARN }],
        // The NotFound is accepted once the bucket is shown to exist.
        [GetTableBucketCommand.name, { tableBucketARN: BUCKET_ARN }],
        [DeleteTableBucketReplicationCommand.name, { tableBucketARN: BUCKET_ARN }],
      ]);
    });

    it('marks metrics and replication unsettled immediately before their deletes', async () => {
      const { order, markUnsettled } = orderRecorder();

      await provider.update(
        'B',
        BUCKET_ARN,
        BUCKET,
        { TableBucketName: 'tb' },
        FULL_BUCKET,
        { markUnsettled }
      );

      expect(order).toEqual([
        'mark:MetricsConfiguration',
        DeleteTableBucketMetricsConfigurationCommand.name,
        'mark:ReplicationConfiguration',
        DeleteTableBucketReplicationCommand.name,
      ]);
    });

    it('tolerates an already-absent replication configuration', async () => {
      mockSend.mockRejectedValueOnce(notFound());
      mockSend.mockResolvedValueOnce({ arn: BUCKET_ARN });

      await provider.update(
        'B',
        BUCKET_ARN,
        BUCKET,
        { TableBucketName: 'tb' },
        { TableBucketName: 'tb', ReplicationConfiguration: REPLICATION }
      );

      expect(sent().map(([name]) => name)).toEqual([
        DeleteTableBucketReplicationCommand.name,
        GetTableBucketCommand.name,
      ]);
    });

    it('surfaces a gone bucket instead of reading its NotFound as an absent configuration', async () => {
      mockSend.mockRejectedValueOnce(notFound());
      mockSend.mockRejectedValueOnce(notFound());

      await expect(
        provider.update(
          'B',
          BUCKET_ARN,
          BUCKET,
          { TableBucketName: 'tb' },
          { TableBucketName: 'tb', ReplicationConfiguration: REPLICATION }
        )
      ).rejects.toThrow(/NotFoundException/);
    });

    it('deletes metrics when Status turns Disabled', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'B',
        BUCKET_ARN,
        BUCKET,
        { TableBucketName: 'tb', MetricsConfiguration: { Status: 'Disabled' } },
        { TableBucketName: 'tb', MetricsConfiguration: { Status: 'Enabled' } }
      );

      expect(sent()).toEqual([
        [DeleteTableBucketMetricsConfigurationCommand.name, { tableBucketARN: BUCKET_ARN }],
      ]);
    });

    it('leaves encryption, storage class and unreferenced file removal in place on removal, warning per property', async () => {
      const prev = {
        TableBucketName: 'tb',
        EncryptionConfiguration: FULL_BUCKET.EncryptionConfiguration,
        StorageClassConfiguration: FULL_BUCKET.StorageClassConfiguration,
        UnreferencedFileRemoval: FULL_BUCKET.UnreferencedFileRemoval,
      };

      await provider.update('B', BUCKET_ARN, BUCKET, { TableBucketName: 'tb' }, prev);

      expect(mockSend).not.toHaveBeenCalled();
      const warned = warn.mock.calls.map((c) => String(c[0]));
      for (const key of [
        'EncryptionConfiguration',
        'StorageClassConfiguration',
        'UnreferencedFileRemoval',
      ]) {
        expect(warned.some((w) => w.includes(`${key} was removed from the template`))).toBe(true);
      }
    });

    it('rethrows a delete failure other than NotFound', async () => {
      mockSend.mockRejectedValueOnce(new Error('denied'));

      await expect(
        provider.update(
          'B',
          BUCKET_ARN,
          BUCKET,
          { TableBucketName: 'tb' },
          { TableBucketName: 'tb', MetricsConfiguration: { Status: 'Enabled' } }
        )
      ).rejects.toThrow(/denied/);
    });

    // Each beside a Tags change and an encryption change, which would be sent
    // first: the refusal must come before every write (no partial update).
    const WRITES_FIRST = {
      TableBucketName: 'tb',
      Tags: [{ Key: 'k', Value: 'v' }],
      EncryptionConfiguration: { SSEAlgorithm: 'AES256' },
    };

    it('refuses a non-object desired property before any call', async () => {
      await expect(
        provider.update(
          'B',
          BUCKET_ARN,
          BUCKET,
          { ...WRITES_FIRST, UnreferencedFileRemoval: 'on' },
          { TableBucketName: 'tb' }
        )
      ).rejects.toThrow('UnreferencedFileRemoval for AWS::S3Tables::TableBucket B must be an object');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a MetricsConfiguration.Status the schema does not allow before any call', async () => {
      const error = await provider
        .update(
          'B',
          BUCKET_ARN,
          BUCKET,
          { ...WRITES_FIRST, MetricsConfiguration: { Status: 'On' } },
          { TableBucketName: 'tb' }
        )
        .catch((e: unknown) => e);
      expect(String(error)).toMatch(/must be 'Enabled' or 'Disabled'/);
      // The record's resource is named on the update path.
      expect((error as { physicalId?: string }).physicalId).toBe(BUCKET_ARN);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([
      ['a non-numeric string', 'three'],
      ['a fraction', 2.5],
      ['a boolean', true],
    ])('refuses %s as an integer member before any call', async (_label, value) => {
      await expect(
        provider.update(
          'B',
          BUCKET_ARN,
          BUCKET,
          { ...WRITES_FIRST, UnreferencedFileRemoval: { NoncurrentDays: value } },
          { TableBucketName: 'tb' }
        )
      ).rejects.toThrow('UnreferencedFileRemoval.NoncurrentDays for AWS::S3Tables::TableBucket B must be an integer');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('names ReplicationConfiguration as absent-means-default only while the template leaves it off', () => {
      expect(provider.getDriftAbsentMeansDefaultKeys(BUCKET, { TableBucketName: 'tb' })).toEqual([
        'ReplicationConfiguration',
      ]);
      expect(
        provider.getDriftAbsentMeansDefaultKeys(BUCKET, { ReplicationConfiguration: REPLICATION })
      ).toEqual([]);
      expect(provider.getDriftAbsentMeansDefaultKeys(TABLE, {})).toEqual([]);
    });
  });

  describe('AWS::S3Tables::Table', () => {
    const BASE = {
      TableBucketARN: BUCKET_ARN,
      Namespace: 'ns',
      TableName: 'tbl',
      OpenTableFormat: 'ICEBERG',
    };

    it('sends IcebergMetadata and storage class on CreateTable, maintenance by Put after it', async () => {
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN });
      mockSend.mockResolvedValue({});

      await provider.create('T', TABLE, {
        ...BASE,
        StorageClassConfiguration: { StorageClass: 'INTELLIGENT_TIERING' },
        IcebergMetadata: {
          IcebergSchema: { SchemaFieldList: [{ Name: 'c1', Type: 'int', Required: true }] },
          IcebergSchemaV2: {
            SchemaV2FieldType: 'struct',
            SchemaV2FieldList: [
              { Id: 1, Name: 'c1', Type: { type: 'list', 'element-id': 2 }, Required: false },
            ],
            IdentifierFieldIds: ['1'],
          },
          IcebergPartitionSpec: { Fields: [{ SourceId: 1, Transform: 'day', Name: 'p' }] },
          IcebergSortOrder: {
            OrderId: 1,
            Fields: [{ SourceId: 1, Transform: 'identity', Direction: 'asc', NullOrder: 'nulls-last' }],
          },
          TableProperties: { k: 'v' },
        },
        Compaction: { Status: 'enabled', TargetFileSizeMB: '256' },
        SnapshotManagement: { Status: 'disabled' },
      });

      expect(sent()).toEqual([
        [
          CreateTableCommand.name,
          {
            tableBucketARN: BUCKET_ARN,
            namespace: 'ns',
            name: 'tbl',
            format: 'ICEBERG',
            storageClassConfiguration: { storageClass: 'INTELLIGENT_TIERING' },
            metadata: {
              iceberg: {
                schema: { fields: [{ name: 'c1', type: 'int', required: true }] },
                schemaV2: {
                  type: 'struct',
                  fields: [
                    { id: 1, name: 'c1', type: { type: 'list', 'element-id': 2 }, required: false },
                  ],
                  // A numeric string, as a template may carry it, is sent as the integer.
                  identifierFieldIds: [1],
                },
                partitionSpec: { fields: [{ sourceId: 1, transform: 'day', name: 'p' }] },
                writeOrder: {
                  orderId: 1,
                  fields: [
                    { sourceId: 1, transform: 'identity', direction: 'asc', nullOrder: 'nulls-last' },
                  ],
                },
                properties: { k: 'v' },
              },
            },
          },
        ],
        [
          PutTableMaintenanceConfigurationCommand.name,
          {
            tableBucketARN: BUCKET_ARN,
            namespace: 'ns',
            name: 'tbl',
            type: 'icebergCompaction',
            value: { status: 'enabled', settings: { icebergCompaction: { targetFileSizeMB: 256 } } },
          },
        ],
        [
          PutTableMaintenanceConfigurationCommand.name,
          {
            tableBucketARN: BUCKET_ARN,
            namespace: 'ns',
            name: 'tbl',
            type: 'icebergSnapshotManagement',
            value: { status: 'disabled' },
          },
        ],
      ]);
    });

    it('sends no metadata for WithoutMetadata', async () => {
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN });

      await provider.create('T', TABLE, { ...BASE, WithoutMetadata: 'Yes' });

      expect(sent()).toEqual([
        [
          CreateTableCommand.name,
          { tableBucketARN: BUCKET_ARN, namespace: 'ns', name: 'tbl', format: 'ICEBERG' },
        ],
      ]);
    });

    it('marks the table created when a maintenance call after CreateTable fails', async () => {
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN });
      mockSend.mockRejectedValueOnce(new Error('maintenance refused'));

      const error = await provider
        .create('T', TABLE, { ...BASE, Compaction: { Status: 'disabled' } })
        .catch((e: unknown) => e);

      expect(createdBeforeFailure(error, 'T', TABLE)).toBe(TABLE_ID);
    });

    it('writes a changed maintenance property to the current table BEFORE renaming it', async () => {
      mockSend.mockResolvedValue({});
      const prev = { ...BASE, Namespace: 'ns', TableName: 'tbl' };

      await provider.update(
        'T',
        TABLE_ID,
        TABLE,
        { ...prev, TableName: 'tbl2', Compaction: { Status: 'disabled' } },
        prev
      );

      expect(sent()).toEqual([
        [
          PutTableMaintenanceConfigurationCommand.name,
          {
            tableBucketARN: BUCKET_ARN,
            namespace: 'ns',
            name: 'tbl',
            type: 'icebergCompaction',
            value: { status: 'disabled' },
          },
        ],
        [RenameTableCommand.name, expect.objectContaining({ name: 'tbl', newName: 'tbl2' })],
      ]);
    });

    it('marks each maintenance property unsettled immediately before its write', async () => {
      const { order, markUnsettled } = orderRecorder();
      const prev = { ...BASE, Namespace: 'ns', TableName: 'tbl' };

      await provider.update(
        'T',
        TABLE_ID,
        TABLE,
        {
          ...prev,
          Compaction: { Status: 'disabled' },
          SnapshotManagement: { Status: 'disabled' },
        },
        prev,
        { markUnsettled }
      );

      expect(order).toEqual([
        'mark:Compaction',
        PutTableMaintenanceConfigurationCommand.name,
        'mark:SnapshotManagement',
        PutTableMaintenanceConfigurationCommand.name,
      ]);
    });

    it('refuses a non-object maintenance property before any call, a rename and a tag change included', async () => {
      const prev = { ...BASE, Namespace: 'ns', TableName: 'tbl' };

      await expect(
        provider.update(
          'T',
          TABLE_ID,
          TABLE,
          { ...prev, TableName: 'tbl2', Tags: [{ Key: 'k', Value: 'v' }], Compaction: 'on' },
          prev
        )
      ).rejects.toThrow('Compaction for AWS::S3Tables::Table T must be an object');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each(['IcebergMetadata', 'StorageClassConfiguration', 'WithoutMetadata'])(
      'replaces the table on a %s change without a DescribeType answer',
      (key) => {
        expect(new ReplacementRulesRegistry().requiresReplacement(TABLE, key, { a: 1 }, { a: 2 })).toBe(
          true
        );
      }
    );

    it('refuses a non-integer IcebergMetadata or maintenance member before any call', async () => {
      await expect(
        provider.create('T', TABLE, {
          ...BASE,
          IcebergMetadata: { IcebergSortOrder: { OrderId: 'x', Fields: [] } },
        })
      ).rejects.toThrow('IcebergMetadata.IcebergSortOrder.OrderId for AWS::S3Tables::Table T must be an integer');
      await expect(
        provider.create('T', TABLE, { ...BASE, Compaction: { TargetFileSizeMB: '1.5' } })
      ).rejects.toThrow('Compaction.TargetFileSizeMB for AWS::S3Tables::Table T must be an integer');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a non-object IcebergMetadata before any call', async () => {
      await expect(provider.create('T', TABLE, { ...BASE, IcebergMetadata: 'x' })).rejects.toThrow(
        'IcebergMetadata for AWS::S3Tables::Table T must be an object'
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('addresses a changed maintenance property by the table a bare-ARN physical id names', async () => {
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN, namespace: ['ns2'], name: 'tbl2' });
      mockSend.mockResolvedValue({});
      // Namespace / TableName left out, so no rename is planned.
      const prev = { TableBucketARN: BUCKET_ARN, OpenTableFormat: 'ICEBERG' };

      await provider.update(
        'T',
        TABLE_ARN,
        TABLE,
        { ...prev, Compaction: { TargetFileSizeMB: 128 } },
        prev
      );

      expect(sent()).toEqual([
        [GetTableCommand.name, { tableArn: TABLE_ARN }],
        [
          PutTableMaintenanceConfigurationCommand.name,
          {
            tableBucketARN: BUCKET_ARN,
            namespace: 'ns2',
            name: 'tbl2',
            type: 'icebergCompaction',
            value: { settings: { icebergCompaction: { targetFileSizeMB: 128 } } },
          },
        ],
      ]);
    });

    it('refuses a maintenance write to a table that is gone', async () => {
      mockSend.mockRejectedValueOnce(notFound());
      const prev = { TableBucketARN: BUCKET_ARN, OpenTableFormat: 'ICEBERG' };

      await expect(
        provider.update('T', TABLE_ARN, TABLE, { ...prev, Compaction: { Status: 'enabled' } }, prev)
      ).rejects.toThrow(/no longer exists/);
    });

    it('leaves a removed maintenance property in place, warning, and sends nothing', async () => {
      const bag = { ...BASE, Namespace: 'ns', TableName: 'tbl' };

      await provider.update(
        'T',
        TABLE_ID,
        TABLE,
        bag,
        { ...bag, SnapshotManagement: { Status: 'disabled' } }
      );

      expect(mockSend).not.toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0])).toContain('SnapshotManagement was removed');
    });

    it('declares the create-only properties it does not read back as drift-unknown', () => {
      expect(provider.getDriftUnknownPaths(TABLE)).toEqual([
        'IcebergMetadata',
        'StorageClassConfiguration',
        'WithoutMetadata',
      ]);
      expect(provider.getDriftUnknownPaths(BUCKET)).toEqual([]);
    });
  });

  describe('readCurrentState', () => {
    it('reads every TableBucket configuration back in CFn shape', async () => {
      mockSend.mockResolvedValueOnce({ name: 'tb', arn: BUCKET_ARN });
      mockSend.mockResolvedValueOnce({ tags: {} });
      mockSend.mockResolvedValueOnce({
        encryptionConfiguration: { sseAlgorithm: 'aws:kms', kmsKeyArn: KEY_ARN },
      });
      mockSend.mockResolvedValueOnce({
        storageClassConfiguration: { storageClass: 'INTELLIGENT_TIERING' },
      });
      mockSend.mockResolvedValueOnce({ tableBucketARN: BUCKET_ARN, id: 'm' });
      mockSend.mockResolvedValueOnce({
        configuration: {
          icebergUnreferencedFileRemoval: {
            status: 'disabled',
            settings: { icebergUnreferencedFileRemoval: { unreferencedDays: 5, nonCurrentDays: 7 } },
          },
        },
      });
      mockSend.mockResolvedValueOnce({
        versionToken: 'v',
        configuration: {
          role: ROLE_ARN,
          rules: [{ destinations: [{ destinationTableBucketARN: DEST_ARN }] }],
        },
      });

      const result = await provider.readCurrentState(BUCKET_ARN, 'B', BUCKET);

      expect(result).toEqual({ ...FULL_BUCKET, Tags: [] });
    });

    it('emits every TableBucket configuration key at its default when unset, but no ReplicationConfiguration', async () => {
      mockSend.mockResolvedValueOnce({ name: 'tb', arn: BUCKET_ARN });
      mockSend.mockResolvedValueOnce({ tags: {} });
      for (let i = 0; i < 5; i++) mockSend.mockRejectedValueOnce(notFound());

      const result = await provider.readCurrentState(BUCKET_ARN, 'B', BUCKET);

      expect(Object.keys(result as object).sort()).toEqual(
        [
          'EncryptionConfiguration',
          'MetricsConfiguration',
          'StorageClassConfiguration',
          'TableBucketName',
          'Tags',
          'UnreferencedFileRemoval',
        ].sort()
      );
      expect(result).toMatchObject({
        EncryptionConfiguration: { SSEAlgorithm: 'AES256' },
        StorageClassConfiguration: { StorageClass: 'STANDARD' },
        MetricsConfiguration: { Status: 'Disabled' },
        UnreferencedFileRemoval: { Status: 'Enabled' },
      });
    });

    it('leaves out a configuration whose read fails for another reason', async () => {
      mockSend.mockResolvedValueOnce({ name: 'tb', arn: BUCKET_ARN });
      mockSend.mockResolvedValueOnce({ tags: {} });
      mockSend.mockRejectedValueOnce(new Error('AccessDenied'));
      for (let i = 0; i < 4; i++) mockSend.mockRejectedValueOnce(notFound());

      const result = await provider.readCurrentState(BUCKET_ARN, 'B', BUCKET);

      expect(result).not.toHaveProperty('EncryptionConfiguration');
      expect(result).toHaveProperty('MetricsConfiguration', { Status: 'Disabled' });
    });

    it('reads the Table maintenance configuration back in CFn shape', async () => {
      mockSend.mockResolvedValueOnce({
        name: 'tbl',
        namespace: ['ns'],
        format: 'ICEBERG',
        tableARN: TABLE_ARN,
      });
      mockSend.mockResolvedValueOnce({ tags: {} });
      mockSend.mockResolvedValueOnce({
        tableARN: TABLE_ARN,
        configuration: {
          icebergCompaction: {
            status: 'disabled',
            settings: { icebergCompaction: { targetFileSizeMB: 256, strategy: 'auto' } },
          },
          icebergSnapshotManagement: {
            status: 'enabled',
            settings: { icebergSnapshotManagement: { minSnapshotsToKeep: 2, maxSnapshotAgeHours: 200 } },
          },
        },
      });

      const result = await provider.readCurrentState(TABLE_ID, 'T', TABLE);

      expect(result).toMatchObject({
        Compaction: { Status: 'disabled', TargetFileSizeMB: 256 },
        SnapshotManagement: { Status: 'enabled', MinSnapshotsToKeep: 2, MaxSnapshotAgeHours: 200 },
      });
      expect(result).not.toHaveProperty('StorageClassConfiguration');
    });

    it('leaves the Table maintenance keys out when their read fails for another reason', async () => {
      mockSend.mockResolvedValueOnce({ name: 'tbl', namespace: ['ns'], tableARN: TABLE_ARN });
      mockSend.mockResolvedValueOnce({ tags: {} });
      mockSend.mockRejectedValueOnce(new Error('AccessDenied'));

      const result = await provider.readCurrentState(TABLE_ID, 'T', TABLE);

      expect(result).not.toHaveProperty('Compaction');
      expect(result).not.toHaveProperty('SnapshotManagement');
    });
  });
  describe('readUnsettled', () => {
    it('reads the named TableBucket keys after confirming the bucket exists', async () => {
      mockSend.mockResolvedValueOnce({ arn: BUCKET_ARN });
      mockSend.mockResolvedValueOnce({ encryptionConfiguration: { sseAlgorithm: 'AES256' } });
      mockSend.mockResolvedValueOnce({ storageClassConfiguration: { storageClass: 'STANDARD' } });
      mockSend.mockResolvedValueOnce({ tableBucketARN: BUCKET_ARN, id: 'm' });
      for (let i = 0; i < 2; i++) mockSend.mockRejectedValueOnce(notFound());

      const live = await provider.readUnsettled(
        BUCKET_ARN,
        'B',
        BUCKET,
        new Set(['MetricsConfiguration', 'ReplicationConfiguration'])
      );

      expect(sent()[0]).toEqual([GetTableBucketCommand.name, { tableBucketARN: BUCKET_ARN }]);
      expect(live).toEqual({ MetricsConfiguration: { Status: 'Enabled' } });
    });

    it('throws a failed TableBucket configuration read instead of leaving the key out', async () => {
      mockSend.mockResolvedValueOnce({ arn: BUCKET_ARN });
      mockSend.mockResolvedValueOnce({ encryptionConfiguration: { sseAlgorithm: 'AES256' } });
      mockSend.mockResolvedValueOnce({ storageClassConfiguration: { storageClass: 'STANDARD' } });
      mockSend.mockRejectedValueOnce(new Error('AccessDenied'));

      await expect(
        provider.readUnsettled(BUCKET_ARN, 'B', BUCKET, new Set(['MetricsConfiguration']))
      ).rejects.toThrow(/AccessDenied/);
    });

    it('answers RESOURCE_NOT_FOUND for a gone bucket', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      expect(
        await provider.readUnsettled(BUCKET_ARN, 'B', BUCKET, new Set(['MetricsConfiguration']))
      ).toBe(RESOURCE_NOT_FOUND);
    });

    it('answers RESOURCE_NOT_FOUND for a gone table, under a composite id and a bare ARN', async () => {
      mockSend.mockRejectedValueOnce(notFound());
      expect(await provider.readUnsettled(TABLE_ID, 'T', TABLE, new Set(['Compaction']))).toBe(
        RESOURCE_NOT_FOUND
      );
      expect(sent()).toEqual([
        [GetTableCommand.name, { tableBucketARN: BUCKET_ARN, namespace: 'ns', name: 'tbl' }],
      ]);

      mockSend.mockRejectedValueOnce(notFound());
      expect(await provider.readUnsettled(TABLE_ARN, 'T', TABLE, new Set(['Compaction']))).toBe(
        RESOURCE_NOT_FOUND
      );
    });

    it('reads the named Table maintenance keys, and throws a failed read', async () => {
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN });
      mockSend.mockResolvedValueOnce({
        tableARN: TABLE_ARN,
        configuration: { icebergCompaction: { status: 'disabled' } },
      });
      expect(await provider.readUnsettled(TABLE_ID, 'T', TABLE, new Set(['Compaction']))).toEqual({
        Compaction: { Status: 'disabled' },
      });

      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN });
      mockSend.mockRejectedValueOnce(new Error('AccessDenied'));
      await expect(
        provider.readUnsettled(TABLE_ID, 'T', TABLE, new Set(['Compaction']))
      ).rejects.toThrow(/AccessDenied/);
    });
  });
});
