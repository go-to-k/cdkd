import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-s3tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-s3tables')>()),
  S3TablesClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

import { S3TablesProvider } from '../../../src/provisioning/providers/s3-tables-provider.js';

/**
 * go-to-k/cdkd#6242: an S3 Tables table recorded only `TableARN`, so
 * `WarehouseLocation` / `VersionToken` resolved to the composite physical id.
 * Create records the `versionToken` CreateTable returns; `import()` (the
 * resolver's re-read) records both from GetTable.
 */
const BUCKET = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket';
const TABLE_ARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket/table/OPAQUE';

describe('S3 Tables table attributes (#6242)', () => {
  beforeEach(() => mockSend.mockReset());

  it('create records WarehouseLocation and VersionToken from a GetTable after the create', async () => {
    mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN, versionToken: 'from-create' });
    mockSend.mockResolvedValueOnce({ warehouseLocation: 's3://warehouse--table-s3', versionToken: 'from-get' });
    const result = await new S3TablesProvider().create('T', 'AWS::S3Tables::Table', {
      TableBucketARN: BUCKET,
      Namespace: 'ns1',
      Name: 't1',
      Format: 'ICEBERG',
    });
    expect(result.attributes).toStrictEqual({
      TableARN: TABLE_ARN,
      WarehouseLocation: 's3://warehouse--table-s3',
      VersionToken: 'from-get',
    });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('create still succeeds when that GetTable fails, recording the CreateTable token', async () => {
    mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN, versionToken: 'from-create' });
    mockSend.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const result = await new S3TablesProvider().create('T', 'AWS::S3Tables::Table', {
      TableBucketARN: BUCKET,
      Namespace: 'ns1',
      Name: 't1',
      Format: 'ICEBERG',
    });
    expect(result.attributes).toStrictEqual({ TableARN: TABLE_ARN, VersionToken: 'from-create' });
  });

  it('import records WarehouseLocation and VersionToken from GetTable', async () => {
    mockSend.mockResolvedValueOnce({
      tableARN: TABLE_ARN,
      namespace: ['ns1'],
      name: 't1',
      warehouseLocation: 's3://7e3f8dd0-1895-4f22-36cd8ypp3pbqoba474r7t3g1pd3iruse1b--table-s3',
      versionToken: 'e41689513cb24ee0312b',
    });
    const result = await new S3TablesProvider().import({
      logicalId: 'T',
      resourceType: 'AWS::S3Tables::Table',
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: `${BUCKET}|ns1|t1`,
    });
    expect(result?.attributes).toStrictEqual({
      TableARN: TABLE_ARN,
      WarehouseLocation: 's3://7e3f8dd0-1895-4f22-36cd8ypp3pbqoba474r7t3g1pd3iruse1b--table-s3',
      VersionToken: 'e41689513cb24ee0312b',
    });
  });
});
