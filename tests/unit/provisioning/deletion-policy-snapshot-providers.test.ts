import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * `DeletionPolicy: Snapshot` provider-side behavior (issue #1352): when the
 * destroy call sites pass `DeleteContext.finalSnapshotIdentifier`, each
 * atomic-final-snapshot provider must flip its delete call to the API's
 * final-snapshot form — and WITHOUT the context field the pre-existing
 * `SkipFinalSnapshot: true` / bare-delete behavior must be preserved (both
 * polarities pinned).
 */

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});
vi.mock('@aws-sdk/client-neptune', async () => {
  const actual = await vi.importActual('@aws-sdk/client-neptune');
  return {
    ...actual,
    NeptuneClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});
vi.mock('@aws-sdk/client-docdb', async () => {
  const actual = await vi.importActual('@aws-sdk/client-docdb');
  return {
    ...actual,
    DocDBClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});
vi.mock('@aws-sdk/client-elasticache', async () => {
  const actual = await vi.importActual('@aws-sdk/client-elasticache');
  return {
    ...actual,
    ElastiCacheClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
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

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';
import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { ElastiCacheProvider } from '../../../src/provisioning/providers/elasticache-provider.js';

const SNAP = 'my-res-final-20260803-000000';

function callsOf(name: string) {
  return mockSend.mock.calls.filter((c) => c[0].constructor.name === name);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Delete paths poll a waitFor*Deleted describe; resolve "gone" immediately.
  mockSend.mockImplementation((cmd) => {
    const n = cmd.constructor.name;
    if (n.startsWith('Describe')) {
      return Promise.reject(
        Object.assign(new Error('not found'), { name: 'DBClusterNotFoundFault' })
      );
    }
    return Promise.resolve({});
  });
});

describe('RDS DBInstance delete', () => {
  it('with finalSnapshotIdentifier: SkipFinalSnapshot=false + FinalDBSnapshotIdentifier', async () => {
    const provider = new RDSProvider();
    mockSend.mockImplementation((cmd) => {
      if (cmd.constructor.name === 'DescribeDBInstancesCommand') {
        return Promise.reject(
          Object.assign(new Error('gone'), { name: 'DBInstanceNotFoundFault' })
        );
      }
      return Promise.resolve({});
    });
    await provider.delete('MyDb', 'my-db', 'AWS::RDS::DBInstance', {}, {
      finalSnapshotIdentifier: SNAP,
    });
    const del = callsOf('DeleteDBInstanceCommand')[0][0];
    expect(del.input).toEqual(
      expect.objectContaining({ SkipFinalSnapshot: false, FinalDBSnapshotIdentifier: SNAP })
    );
  });

  it('without the context field: SkipFinalSnapshot=true and no identifier (pre-existing default)', async () => {
    const provider = new RDSProvider();
    mockSend.mockImplementation((cmd) => {
      if (cmd.constructor.name === 'DescribeDBInstancesCommand') {
        return Promise.reject(
          Object.assign(new Error('gone'), { name: 'DBInstanceNotFoundFault' })
        );
      }
      return Promise.resolve({});
    });
    await provider.delete('MyDb', 'my-db', 'AWS::RDS::DBInstance', {}, {});
    const del = callsOf('DeleteDBInstanceCommand')[0][0];
    expect(del.input.SkipFinalSnapshot).toBe(true);
    expect(del.input.FinalDBSnapshotIdentifier).toBeUndefined();
  });

  it('cluster-member instance (DBClusterIdentifier present) skips the final snapshot even under Snapshot (CFn nuance)', async () => {
    const provider = new RDSProvider();
    mockSend.mockImplementation((cmd) => {
      if (cmd.constructor.name === 'DescribeDBInstancesCommand') {
        return Promise.reject(
          Object.assign(new Error('gone'), { name: 'DBInstanceNotFoundFault' })
        );
      }
      return Promise.resolve({});
    });
    await provider.delete(
      'MyDb',
      'my-db',
      'AWS::RDS::DBInstance',
      { DBClusterIdentifier: 'my-cluster' },
      { finalSnapshotIdentifier: SNAP }
    );
    const del = callsOf('DeleteDBInstanceCommand')[0][0];
    expect(del.input.SkipFinalSnapshot).toBe(true);
    expect(del.input.FinalDBSnapshotIdentifier).toBeUndefined();
  });
});

describe('RDS DBCluster delete', () => {
  it('with finalSnapshotIdentifier: SkipFinalSnapshot=false + FinalDBSnapshotIdentifier', async () => {
    const provider = new RDSProvider();
    await provider.delete('MyCluster', 'my-cluster', 'AWS::RDS::DBCluster', {}, {
      finalSnapshotIdentifier: SNAP,
    });
    const del = callsOf('DeleteDBClusterCommand')[0][0];
    expect(del.input).toEqual(
      expect.objectContaining({ SkipFinalSnapshot: false, FinalDBSnapshotIdentifier: SNAP })
    );
  });

  it('without the context field: SkipFinalSnapshot=true (pre-existing default)', async () => {
    const provider = new RDSProvider();
    await provider.delete('MyCluster', 'my-cluster', 'AWS::RDS::DBCluster', {}, {});
    const del = callsOf('DeleteDBClusterCommand')[0][0];
    expect(del.input.SkipFinalSnapshot).toBe(true);
    expect(del.input.FinalDBSnapshotIdentifier).toBeUndefined();
  });
});

describe('Neptune DBCluster delete', () => {
  it('honors finalSnapshotIdentifier and preserves the skip default', async () => {
    const provider = new NeptuneProvider();
    await provider.delete('MyNeptune', 'my-neptune', 'AWS::Neptune::DBCluster', {}, {
      finalSnapshotIdentifier: SNAP,
    });
    let del = callsOf('DeleteDBClusterCommand')[0][0];
    expect(del.input).toEqual(
      expect.objectContaining({ SkipFinalSnapshot: false, FinalDBSnapshotIdentifier: SNAP })
    );

    mockSend.mockClear();
    await provider.delete('MyNeptune', 'my-neptune', 'AWS::Neptune::DBCluster', {}, {});
    del = callsOf('DeleteDBClusterCommand')[0][0];
    expect(del.input.SkipFinalSnapshot).toBe(true);
    expect(del.input.FinalDBSnapshotIdentifier).toBeUndefined();
  });
});

describe('DocDB DBCluster delete', () => {
  it('honors finalSnapshotIdentifier and preserves the skip default', async () => {
    const provider = new DocDBProvider();
    await provider.delete('MyDocDb', 'my-docdb', 'AWS::DocDB::DBCluster', {}, {
      finalSnapshotIdentifier: SNAP,
    });
    let del = callsOf('DeleteDBClusterCommand')[0][0];
    expect(del.input).toEqual(
      expect.objectContaining({ SkipFinalSnapshot: false, FinalDBSnapshotIdentifier: SNAP })
    );

    mockSend.mockClear();
    await provider.delete('MyDocDb', 'my-docdb', 'AWS::DocDB::DBCluster', {}, {});
    del = callsOf('DeleteDBClusterCommand')[0][0];
    expect(del.input.SkipFinalSnapshot).toBe(true);
    expect(del.input.FinalDBSnapshotIdentifier).toBeUndefined();
  });
});

describe('ElastiCache CacheCluster delete', () => {
  it('passes FinalSnapshotIdentifier when set and omits it otherwise', async () => {
    const provider = new ElastiCacheProvider();
    mockSend.mockImplementation((cmd) => {
      if (cmd.constructor.name === 'DescribeCacheClustersCommand') {
        return Promise.reject(
          Object.assign(new Error('gone'), { name: 'CacheClusterNotFoundFault' })
        );
      }
      return Promise.resolve({});
    });
    await provider.delete('MyCache', 'my-cache', 'AWS::ElastiCache::CacheCluster', {}, {
      finalSnapshotIdentifier: SNAP,
    });
    let del = callsOf('DeleteCacheClusterCommand')[0][0];
    expect(del.input).toEqual(expect.objectContaining({ FinalSnapshotIdentifier: SNAP }));

    mockSend.mockClear();
    mockSend.mockImplementation((cmd) => {
      if (cmd.constructor.name === 'DescribeCacheClustersCommand') {
        return Promise.reject(
          Object.assign(new Error('gone'), { name: 'CacheClusterNotFoundFault' })
        );
      }
      return Promise.resolve({});
    });
    await provider.delete('MyCache', 'my-cache', 'AWS::ElastiCache::CacheCluster', {}, {});
    del = callsOf('DeleteCacheClusterCommand')[0][0];
    expect(del.input.FinalSnapshotIdentifier).toBeUndefined();
  });
});
