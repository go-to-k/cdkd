import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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
  GetTableCommand,
  ListNamespacesCommand,
  ListTablesCommand,
  NotFoundException,
  RenameTableCommand,
  TagResourceCommand,
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
    it('should create a table, return composite physical ID, and capture the AWS-issued TableARN in attributes', async () => {
      const tableBucketARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket';
      // The REAL AWS-issued ARN — its shape is opaque (NOT derivable
      // from the compound parts). createTable captures it so the
      // resolver can return it via `Fn::GetAtt: [<Table>, TableARN]`.
      const realArn =
        'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket/table/OPAQUE-AWS-ID';
      mockSend.mockResolvedValueOnce({ tableARN: realArn });

      const result = await provider.create('MyTable', 'AWS::S3Tables::Table', {
        TableBucketARN: tableBucketARN,
        Namespace: 'my-namespace',
        Name: 'my-table',
        Format: 'ICEBERG',
      });

      expect(result.physicalId).toBe(`${tableBucketARN}|my-namespace|my-table`);
      expect(result.attributes).toEqual({ TableARN: realArn });
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

  // ─── Table rename (go-to-k/cdkd#5313) ─────────────────────────────
  // CloudFormation updates a Table's TableName / Namespace in place
  // (`Replacement: False`, same TableARN; measured 2026-10-26) through
  // RenameTable. Before the fix update() sent nothing and kept the old id.
  describe('Table rename (issue #5313)', () => {
    const BUCKET = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket';
    const OLD_ID = `${BUCKET}|ns_a|tbl_a`;
    const TABLE_ARN = `${BUCKET}/table/0b2c1f6e-0000-4000-8000-000000000000`;
    const base = { TableBucketARN: BUCKET, OpenTableFormat: 'ICEBERG' };

    // clearAllMocks keeps a mockImplementation; reset so none leaks between cases.
    beforeEach(() => mockSend.mockReset());

    const renameInputs = () =>
      mockSend.mock.calls
        .map(([command]) => command)
        .filter((command) => command instanceof RenameTableCommand)
        .map((command) => (command as RenameTableCommand).input);

    it('renames the table and records the new composite id on a TableName change', async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await provider.update(
        'MyTbl',
        OLD_ID,
        'AWS::S3Tables::Table',
        { ...base, Namespace: 'ns_a', TableName: 'tbl_b' },
        { ...base, Namespace: 'ns_a', TableName: 'tbl_a' }
      );

      expect(renameInputs()).toEqual([
        { tableBucketARN: BUCKET, namespace: 'ns_a', name: 'tbl_a', newName: 'tbl_b' },
      ]);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ physicalId: `${BUCKET}|ns_a|tbl_b`, wasReplaced: false });
    });

    it('moves the table on a Namespace change, sending only newNamespaceName', async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await provider.update(
        'MyTbl',
        OLD_ID,
        'AWS::S3Tables::Table',
        { ...base, Namespace: 'ns_b', TableName: 'tbl_a' },
        { ...base, Namespace: 'ns_a', TableName: 'tbl_a' }
      );

      expect(renameInputs()).toEqual([
        { tableBucketARN: BUCKET, namespace: 'ns_a', name: 'tbl_a', newNamespaceName: 'ns_b' },
      ]);
      expect(result).toEqual({ physicalId: `${BUCKET}|ns_b|tbl_a`, wasReplaced: false });
    });

    it('sends both in ONE RenameTable when name and namespace change together', async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await provider.update(
        'MyTbl',
        OLD_ID,
        'AWS::S3Tables::Table',
        { ...base, Namespace: 'ns_b', TableName: 'tbl_b' },
        { ...base, Namespace: 'ns_a', TableName: 'tbl_a' }
      );

      expect(renameInputs()).toEqual([
        {
          tableBucketARN: BUCKET,
          namespace: 'ns_a',
          name: 'tbl_a',
          newNamespaceName: 'ns_b',
          newName: 'tbl_b',
        },
      ]);
      expect(result).toEqual({ physicalId: `${BUCKET}|ns_b|tbl_b`, wasReplaced: false });
    });

    it('reads the legacy `Name` alias when TableName is absent', async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await provider.update(
        'MyTbl',
        OLD_ID,
        'AWS::S3Tables::Table',
        { ...base, Namespace: 'ns_a', Name: 'tbl_b' },
        { ...base, Namespace: 'ns_a', Name: 'tbl_a' }
      );

      expect(renameInputs()).toEqual([
        { tableBucketARN: BUCKET, namespace: 'ns_a', name: 'tbl_a', newName: 'tbl_b' },
      ]);
      expect(result.physicalId).toBe(`${BUCKET}|ns_a|tbl_b`);
    });

    it('sends nothing when the name and namespace match the recorded id', async () => {
      const result = await provider.update(
        'MyTbl',
        OLD_ID,
        'AWS::S3Tables::Table',
        { ...base, Namespace: 'ns_a', TableName: 'tbl_a' },
        { ...base, Namespace: 'ns_a', TableName: 'tbl_a' }
      );

      expect(mockSend).not.toHaveBeenCalled();
      expect(result).toEqual({ physicalId: OLD_ID, wasReplaced: false });
    });

    it('compares with the physical id, not the previous properties', async () => {
      // A record an older cdkd wrote after the silently dropped rename: its
      // properties already say tbl_b, its id (and AWS) still tbl_a.
      mockSend.mockResolvedValueOnce({});
      const result = await provider.update(
        'MyTbl',
        OLD_ID,
        'AWS::S3Tables::Table',
        { ...base, Namespace: 'ns_a', TableName: 'tbl_b' },
        { ...base, Namespace: 'ns_a', TableName: 'tbl_b' }
      );

      expect(renameInputs()).toEqual([
        { tableBucketARN: BUCKET, namespace: 'ns_a', name: 'tbl_a', newName: 'tbl_b' },
      ]);
      expect(result.physicalId).toBe(`${BUCKET}|ns_a|tbl_b`);
    });

    it('applies tags against the OLD name first and renames last', async () => {
      mockSend.mockImplementation(async (command: unknown) => {
        if (command instanceof GetTableCommand) return { tableARN: TABLE_ARN };
        return {};
      });
      const result = await provider.update(
        'MyTbl',
        OLD_ID,
        'AWS::S3Tables::Table',
        { ...base, Namespace: 'ns_a', TableName: 'tbl_b', Tags: [{ Key: 'team', Value: 'x' }] },
        { ...base, Namespace: 'ns_a', TableName: 'tbl_a' }
      );

      const commands = mockSend.mock.calls.map(([command]) => command);
      expect(commands.map((c) => c.constructor)).toEqual([
        GetTableCommand,
        TagResourceCommand,
        RenameTableCommand,
      ]);
      expect((commands[0] as GetTableCommand).input).toEqual({
        tableBucketARN: BUCKET,
        namespace: 'ns_a',
        name: 'tbl_a',
      });
      expect(result.physicalId).toBe(`${BUCKET}|ns_a|tbl_b`);
    });

    it('keeps a bare table ARN id as it is, resolving the current name through GetTable', async () => {
      mockSend.mockImplementation(async (command: unknown) => {
        if (command instanceof GetTableCommand) {
          return { tableARN: TABLE_ARN, namespace: ['ns_a'], name: 'tbl_a' };
        }
        return {};
      });
      const result = await provider.update(
        'MyTbl',
        TABLE_ARN,
        'AWS::S3Tables::Table',
        { ...base, Namespace: 'ns_a', TableName: 'tbl_b' },
        { ...base, Namespace: 'ns_a', TableName: 'tbl_a' }
      );

      expect(renameInputs()).toEqual([
        { tableBucketARN: BUCKET, namespace: 'ns_a', name: 'tbl_a', newName: 'tbl_b' },
      ]);
      expect(result).toEqual({ physicalId: TABLE_ARN, wasReplaced: false });
    });

    it('refuses a bare table ARN whose table is gone, sending no rename', async () => {
      mockSend.mockRejectedValueOnce(
        new NotFoundException({ message: 'gone', $metadata: {} } as never)
      );
      await expect(
        provider.update(
          'MyTbl',
          TABLE_ARN,
          'AWS::S3Tables::Table',
          { ...base, Namespace: 'ns_a', TableName: 'tbl_b' },
          { ...base, Namespace: 'ns_a', TableName: 'tbl_a' }
        )
      ).rejects.toThrow(/no longer exists/);
      expect(renameInputs()).toEqual([]);
    });

    it.each([
      ['TableName', { Namespace: 'ns_a', TableName: ['tbl_b'] }],
      ['TableName', { Namespace: 'ns_a', TableName: '' }],
      ['Namespace', { Namespace: ['ns_b'], TableName: 'tbl_a' }],
    ])('refuses a non-string %s before any call', async (key, props) => {
      await expect(
        provider.update(
          'MyTbl',
          OLD_ID,
          'AWS::S3Tables::Table',
          { ...base, ...props, Tags: [{ Key: 'k', Value: 'v' }] },
          { ...base, Namespace: 'ns_a', TableName: 'tbl_a' }
        )
      ).rejects.toThrow(`${key} for S3 Tables Table MyTbl must be a non-empty string`);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a new name carrying the id separator before any call', async () => {
      await expect(
        provider.update(
          'MyTbl',
          OLD_ID,
          'AWS::S3Tables::Table',
          { ...base, Namespace: 'ns_a', TableName: 'tbl|b' },
          { ...base, Namespace: 'ns_a', TableName: 'tbl_a' }
        )
      ).rejects.toThrow(/\|/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('treats a NotFound rename as applied only when the target holds the recorded TableARN', async () => {
      // A replayed RenameTable whose first answer was lost finds the old name
      // gone; the table now at the target name is this one only if its ARN is
      // the one the record holds.
      const notFound = () => new NotFoundException({ message: 'gone', $metadata: {} } as never);
      const desired = { ...base, Namespace: 'ns_a', TableName: 'tbl_b' };
      const previous = { ...base, Namespace: 'ns_a', TableName: 'tbl_a' };

      mockSend.mockImplementation(async (command: unknown) => {
        if (command instanceof RenameTableCommand) throw notFound();
        if (command instanceof GetTableCommand) return { tableARN: TABLE_ARN };
        return {};
      });
      const ok = await provider.update('MyTbl', OLD_ID, 'AWS::S3Tables::Table', desired, previous, {
        recordedAttributes: { TableARN: TABLE_ARN },
      });
      expect(ok).toEqual({ physicalId: `${BUCKET}|ns_a|tbl_b`, wasReplaced: false });
      const lookup = mockSend.mock.calls
        .map(([command]) => command)
        .find((command) => command instanceof GetTableCommand) as GetTableCommand;
      expect(lookup.input).toEqual({ tableBucketARN: BUCKET, namespace: 'ns_a', name: 'tbl_b' });

      // Another table at the target name: not attributed.
      await expect(
        provider.update('MyTbl', OLD_ID, 'AWS::S3Tables::Table', desired, previous, {
          recordedAttributes: { TableARN: `${BUCKET}/table/another-table-id` },
        })
      ).rejects.toThrow(/Failed to update S3 Tables resource MyTbl/);

      // No recorded TableARN: nothing to attribute with, so no lookup either.
      mockSend.mockClear();
      await expect(
        provider.update('MyTbl', OLD_ID, 'AWS::S3Tables::Table', desired, previous, {})
      ).rejects.toThrow(/Failed to update S3 Tables resource MyTbl/);
      expect(mockSend.mock.calls.map(([command]) => command.constructor)).toEqual([
        RenameTableCommand,
      ]);
    });

    it('rethrows the ORIGINAL NotFound when the attribution lookup itself fails', async () => {
      const original = new NotFoundException({ message: 'old name gone', $metadata: {} } as never);
      mockSend.mockImplementation(async (command: unknown) => {
        if (command instanceof RenameTableCommand) throw original;
        if (command instanceof GetTableCommand) {
          throw Object.assign(new Error('lookup denied'), { name: 'AccessDeniedException' });
        }
        return {};
      });
      const err = await provider
        .update(
          'MyTbl',
          OLD_ID,
          'AWS::S3Tables::Table',
          { ...base, Namespace: 'ns_a', TableName: 'tbl_b' },
          { ...base, Namespace: 'ns_a', TableName: 'tbl_a' },
          { recordedAttributes: { TableARN: TABLE_ARN } }
        )
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).cause).toBe(original);
    });

    it('surfaces a RenameTable failure instead of recording the new id', async () => {
      mockSend.mockRejectedValueOnce(new Error('rename boom'));
      await expect(
        provider.update(
          'MyTbl',
          OLD_ID,
          'AWS::S3Tables::Table',
          { ...base, Namespace: 'ns_a', TableName: 'tbl_b' },
          { ...base, Namespace: 'ns_a', TableName: 'tbl_a' }
        )
      ).rejects.toThrow(/Failed to update S3 Tables resource MyTbl/);
      expect(renameInputs()).toHaveLength(1);
    });
  });

  describe('import', () => {
    function makeInput(overrides: Record<string, unknown> = {}) {
      return {
        logicalId: 'MyTableBucket',
        resourceType: 'AWS::S3Tables::TableBucket',
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
          { arn: 'arn:aws:s3tables:us-east-1:123:bucket/other', name: 'other' },
          { arn, name: 'my-bucket' },
        ],
      });
      const result = await provider.import!(
        makeInput({ properties: { TableBucketName: 'my-bucket' } })
      );
      expect(result?.physicalId).toBe(arn);
    });

    // The `aws:cdk:path` tag match that used to ride the TableBucket walk was
    // removed in issue #1134: AWS rejects `aws:`-prefixed tag writes, so that
    // tag never exists on a real resource and the comparison could not match.
    // The walk now only serves the TableBucketName match, so it must be
    // skipped entirely when the template supplies no name.
    it('returns null for a TableBucket with no override and no TableBucketName', async () => {
      const result = await provider.import!(makeInput());
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns null for a Table with no override and issues no AWS call', async () => {
      const result = await provider.import!(
        makeInput({ resourceType: 'AWS::S3Tables::Table', logicalId: 'MyTable' })
      );
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns null for unsupported resource types', async () => {
      const result = await provider.import!(
        makeInput({ resourceType: 'AWS::S3Tables::Other' })
      );
      expect(result).toBeNull();
    });
  });
});

describe('S3TablesProvider update region guard (issue #2613)', () => {
  let provider: S3TablesProvider;
  const BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket';
  const desired = { TableBucketName: 'my-bucket', Tags: [{ Key: 'team', Value: 'new' }] };
  const previous = { TableBucketName: 'my-bucket', Tags: [{ Key: 'team', Value: 'old' }] };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new S3TablesProvider();
  });

  it('refuses a table bucket update from a wrong-region client before any call', async () => {
    await expect(
      provider.update('MyTableBucket', BUCKET_ARN, 'AWS::S3Tables::TableBucket', desired, previous, {
        expectedRegion: 'us-west-2',
      })
    ).rejects.toThrow(/Refusing to update MyTableBucket .*does not match stack state region us-west-2/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses a table update from a wrong-region client before the GetTable lookup', async () => {
    await expect(
      provider.update(
        'MyTbl',
        `${BUCKET_ARN}|ns|tbl`,
        'AWS::S3Tables::Table',
        { Tags: [{ Key: 'team', Value: 'new' }] },
        { Tags: [{ Key: 'team', Value: 'old' }] },
        { expectedRegion: 'us-west-2' }
      )
    ).rejects.toThrow(/Refusing to update MyTbl .*does not match stack state region us-west-2/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses a namespace update from a wrong-region client too', async () => {
    await expect(
      provider.update('MyNs', `${BUCKET_ARN}|ns`, 'AWS::S3Tables::Namespace', {}, {}, {
        expectedRegion: 'us-west-2',
      })
    ).rejects.toThrow(/Refusing to update MyNs .*does not match stack state region us-west-2/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('updates when the client region matches the recorded one', async () => {
    await provider.update('MyTableBucket', BUCKET_ARN, 'AWS::S3Tables::TableBucket', desired, previous, {
      expectedRegion: 'us-east-1',
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0]![0].constructor.name).toBe('TagResourceCommand');
  });

  it('without a recorded region proceeds and never resolves the client region', async () => {
    const region = vi.fn(() => Promise.resolve('us-west-2'));
    (provider as unknown as { getClient(): { config: { region: unknown } } }).getClient().config.region =
      region;
    await provider.update('MyTableBucket', BUCKET_ARN, 'AWS::S3Tables::TableBucket', desired, previous);
    expect(region).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0]![0].constructor.name).toBe('TagResourceCommand');
  });
});
