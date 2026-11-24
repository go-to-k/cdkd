/**
 * go-to-k/cdkd#6242 tail: the RDS DB cluster records `StorageEncryptionType`
 * through ONE map shared by create, update, `import()` and the Cloud Control
 * route's enrichment (`dbClusterAttributes`); a DocumentDB cluster records
 * `ServerlessV2PlatformVersion` when RDS reports it (a serverless v2 cluster).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockRdsSend, mockDocdbSend } = vi.hoisted(() => ({
  mockRdsSend: vi.fn(),
  mockDocdbSend: vi.fn(),
}));
vi.mock('@aws-sdk/client-rds', async () => ({
  ...(await vi.importActual('@aws-sdk/client-rds')),
  RDSClient: vi.fn(() => ({
    send: mockRdsSend,
    config: { region: () => Promise.resolve('us-east-1') },
  })),
}));
vi.mock('@aws-sdk/client-docdb', async () => ({
  ...(await vi.importActual('@aws-sdk/client-docdb')),
  DocDBClient: vi.fn(() => ({ send: mockDocdbSend })),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { dbClusterAttributes } from '../../../src/provisioning/providers/rds/cluster-attributes.js';
import { clusterAttributes } from '../../../src/provisioning/providers/docdb/shared.js';
import { EXPRESS_WRITER_RESOURCE_ID_KEY } from '../../../src/provisioning/providers/rds/express-writer.js';

const CLUSTER = {
  DBClusterIdentifier: 'db',
  Status: 'available',
  Endpoint: 'db.cluster-x.us-east-1.rds.amazonaws.com',
  ReaderEndpoint: 'db.cluster-ro-x.us-east-1.rds.amazonaws.com',
  Port: 5432,
  DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:db',
  DbClusterResourceId: 'cluster-ABC',
  StorageEncryptionType: 'sse-kms' as const,
};

const EXPECTED = {
  'Endpoint.Address': 'db.cluster-x.us-east-1.rds.amazonaws.com',
  'Endpoint.Port': '5432',
  'ReadEndpoint.Address': 'db.cluster-ro-x.us-east-1.rds.amazonaws.com',
  Arn: 'arn:aws:rds:us-east-1:123456789012:cluster:db',
  DBClusterResourceId: 'cluster-ABC',
  StorageEncryptionType: 'sse-kms',
};

describe('dbClusterAttributes (#6242)', () => {
  it('records StorageEncryptionType as RDS reports it', () => {
    expect(dbClusterAttributes(CLUSTER)).toStrictEqual(EXPECTED);
  });

  it('leaves an unreported StorageEncryptionType ABSENT', () => {
    const { StorageEncryptionType: _omit, ...plain } = CLUSTER;
    expect(Object.hasOwn(dbClusterAttributes(plain), 'StorageEncryptionType')).toBe(false);
    expect(dbClusterAttributes(undefined)).toStrictEqual({});
  });

  it('records the port and the express writer id it is handed, beside the described cluster', () => {
    expect(dbClusterAttributes(CLUSTER, { port: 3306, expressWriterId: 'db-W' })).toStrictEqual({
      ...EXPECTED,
      'Endpoint.Port': '3306',
      [EXPRESS_WRITER_RESOURCE_ID_KEY]: 'db-W',
    });
    // No cluster described: no port either, as before.
    expect(dbClusterAttributes(undefined, { port: 3306 })).toStrictEqual({});
  });
});

describe('RDSProvider DBCluster writers record StorageEncryptionType (#6242)', () => {
  let originalNoWait: string | undefined;
  beforeEach(() => {
    mockRdsSend.mockReset();
    originalNoWait = process.env['CDKD_NO_WAIT'];
    delete process.env['CDKD_NO_WAIT'];
  });
  afterEach(() => {
    if (originalNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = originalNoWait;
  });

  it('create', async () => {
    mockRdsSend.mockResolvedValueOnce({ DBCluster: { DBClusterIdentifier: 'db' } });
    mockRdsSend.mockResolvedValue({ DBClusters: [CLUSTER] });
    const result = await new RDSProvider().create('C', 'AWS::RDS::DBCluster', {
      DBClusterIdentifier: 'db',
      Engine: 'aurora-postgresql',
      MasterUsername: 'admin',
      MasterUserPassword: 'secret123',
    });
    expect(result.attributes).toStrictEqual(EXPECTED);
  });

  it('update returns the full map (it replaces the record)', async () => {
    mockRdsSend.mockResolvedValueOnce({});
    mockRdsSend.mockResolvedValue({ DBClusters: [CLUSTER] });
    const result = await new RDSProvider().update(
      'C',
      'db',
      'AWS::RDS::DBCluster',
      { Engine: 'aurora-postgresql', DeletionProtection: true },
      { Engine: 'aurora-postgresql' }
    );
    expect(result.attributes).toStrictEqual(EXPECTED);
  });

  it('import()', async () => {
    mockRdsSend.mockResolvedValueOnce({ DBClusters: [CLUSTER] });
    const result = await new RDSProvider().import({
      logicalId: 'C',
      resourceType: 'AWS::RDS::DBCluster',
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'db',
    });
    expect(result?.attributes).toStrictEqual(EXPECTED);
  });
});

describe('DocumentDB cluster ServerlessV2PlatformVersion (#6242)', () => {
  beforeEach(() => mockDocdbSend.mockReset());

  it('is recorded when DocumentDB reports it, absent otherwise', () => {
    const base = {
      Endpoint: 'd.cluster-x.docdb.amazonaws.com',
      Port: 27017,
      DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:d',
    };
    expect(clusterAttributes({ ...base, ServerlessV2PlatformVersion: '1' })).toMatchObject({
      ServerlessV2PlatformVersion: '1',
    });
    expect(Object.hasOwn(clusterAttributes(base), 'ServerlessV2PlatformVersion')).toBe(false);
  });

  it('import() records it from the describe', async () => {
    mockDocdbSend.mockResolvedValueOnce({
      DBClusters: [
        {
          DBClusterIdentifier: 'd',
          DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:d',
          ServerlessV2PlatformVersion: '1',
        },
      ],
    });
    const result = await new DocDBProvider().import!({
      logicalId: 'C',
      resourceType: 'AWS::DocDB::DBCluster',
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'd',
    } as Parameters<NonNullable<DocDBProvider['import']>>[0]);
    expect(result?.attributes?.['ServerlessV2PlatformVersion']).toBe('1');
  });
});
