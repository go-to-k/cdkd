import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

import {
  ATOMIC_FINAL_SNAPSHOT_TYPES,
  PRE_DELETE_SNAPSHOT_TYPES,
  buildFinalSnapshotIdentifier,
  ccRoutedFinalSnapshotError,
  createEbsFinalSnapshot,
  createPreDeleteFinalSnapshot,
  createRedshiftFinalSnapshot,
  createReplicationGroupFinalSnapshot,
  finalSnapshotDelays,
  finalSnapshotNamePrefix,
  isFinalSnapshotError,
  supportsFinalSnapshot,
  unsupportedFinalSnapshotError,
  EBS_FINAL_SNAPSHOT_TAG_KEY,
  type PreDeleteSnapshotClients,
} from '../../../src/provisioning/final-snapshot.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import type { EC2Client } from '@aws-sdk/client-ec2';

const logger = { info: vi.fn(), debug: vi.fn() };

function mockEc2(send: ReturnType<typeof vi.fn>): EC2Client {
  return { send } as unknown as EC2Client;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(finalSnapshotDelays, 'sleep').mockResolvedValue(undefined);
});

describe('supportsFinalSnapshot', () => {
  it('covers the atomic + pre-delete sets and nothing else', () => {
    for (const t of ATOMIC_FINAL_SNAPSHOT_TYPES) expect(supportsFinalSnapshot(t)).toBe(true);
    for (const t of PRE_DELETE_SNAPSHOT_TYPES) expect(supportsFinalSnapshot(t)).toBe(true);
    // #1353: the full CFn-documented Snapshot-capable list is covered now.
    expect(supportsFinalSnapshot('AWS::Redshift::Cluster')).toBe(true);
    expect(supportsFinalSnapshot('AWS::ElastiCache::ReplicationGroup')).toBe(true);
    expect(supportsFinalSnapshot('AWS::S3::Bucket')).toBe(false);
  });
});

describe('buildFinalSnapshotIdentifier', () => {
  it('builds <physicalId>-final-<utc timestamp>', () => {
    const id = buildFinalSnapshotIdentifier(
      'my-db-1',
      'AWS::RDS::DBInstance',
      new Date('2026-08-03T04:05:06Z')
    );
    expect(id).toBe('my-db-1-final-20260803-040506');
  });

  it('sanitizes invalid characters and forces a leading letter', () => {
    const id = buildFinalSnapshotIdentifier(
      '123_Weird__Name-',
      'AWS::RDS::DBInstance',
      new Date('2026-08-03T04:05:06Z')
    );
    expect(id).toMatch(/^[a-z]/);
    expect(id).toMatch(/^r123-weird-name-final-20260803-040506$/);
    expect(id).not.toMatch(/--/);
  });

  it('caps the total length at 255', () => {
    const id = buildFinalSnapshotIdentifier(
      'a'.repeat(300),
      'AWS::RDS::DBInstance',
      new Date('2026-08-03T04:05:06Z')
    );
    expect(id.length).toBeLessThanOrEqual(255);
    expect(id.endsWith('-final-20260803-040506')).toBe(true);
  });

  it('caps ElastiCache CacheCluster snapshot names at the ~50-char cluster naming limit', () => {
    const id = buildFinalSnapshotIdentifier(
      'c'.repeat(50),
      'AWS::ElastiCache::CacheCluster',
      new Date('2026-08-03T04:05:06Z')
    );
    expect(id.length).toBeLessThanOrEqual(50);
    expect(id.endsWith('-final-20260803-040506')).toBe(true);
  });
});

describe('createEbsFinalSnapshot', () => {
  it('creates a tagged snapshot and waits until completed', async () => {
    const send = vi
      .fn()
      // reuse probe: nothing existing
      .mockResolvedValueOnce({ Snapshots: [] })
      // CreateSnapshot
      .mockResolvedValueOnce({ SnapshotId: 'snap-123' })
      // DescribeSnapshots polls
      .mockResolvedValueOnce({ Snapshots: [{ SnapshotId: 'snap-123', State: 'pending' }] })
      .mockResolvedValueOnce({ Snapshots: [{ SnapshotId: 'snap-123', State: 'completed' }] });

    const result = await createEbsFinalSnapshot(mockEc2(send), 'vol-1', 'DataVolume', logger);

    expect(result).toBe('snap-123');
    const createCall = send.mock.calls[1][0];
    expect(createCall.constructor.name).toBe('CreateSnapshotCommand');
    expect(createCall.input.VolumeId).toBe('vol-1');
    expect(createCall.input.TagSpecifications[0].Tags).toEqual([
      { Key: EBS_FINAL_SNAPSHOT_TAG_KEY, Value: 'vol-1' },
    ]);
    expect(finalSnapshotDelays.sleep).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing pending/completed snapshot from a prior destroy attempt', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Snapshots: [{ SnapshotId: 'snap-old', State: 'pending' }] })
      .mockResolvedValueOnce({ Snapshots: [{ SnapshotId: 'snap-old', State: 'completed' }] });

    const result = await createEbsFinalSnapshot(mockEc2(send), 'vol-1', 'DataVolume', logger);

    expect(result).toBe('snap-old');
    // No CreateSnapshotCommand issued
    expect(send.mock.calls.map((c) => c[0].constructor.name)).not.toContain('CreateSnapshotCommand');
  });

  it('returns null when the volume no longer exists', async () => {
    const gone = Object.assign(new Error('The volume does not exist'), {
      name: 'InvalidVolume.NotFound',
    });
    const send = vi.fn().mockResolvedValueOnce({ Snapshots: [] }).mockRejectedValueOnce(gone);

    const result = await createEbsFinalSnapshot(mockEc2(send), 'vol-1', 'DataVolume', logger);

    expect(result).toBeNull();
  });

  it("throws FINAL_SNAPSHOT_FAILED when the snapshot enters 'error' state", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Snapshots: [] })
      .mockResolvedValueOnce({ SnapshotId: 'snap-err' })
      .mockResolvedValueOnce({ Snapshots: [{ SnapshotId: 'snap-err', State: 'error' }] });

    await expect(
      createEbsFinalSnapshot(mockEc2(send), 'vol-1', 'DataVolume', logger)
    ).rejects.toMatchObject({ code: 'FINAL_SNAPSHOT_FAILED' });
  });

  it('throws FINAL_SNAPSHOT_FAILED when CreateSnapshot fails for a non-NotFound reason', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Snapshots: [] })
      .mockRejectedValueOnce(new Error('AccessDenied'));

    await expect(
      createEbsFinalSnapshot(mockEc2(send), 'vol-1', 'DataVolume', logger)
    ).rejects.toMatchObject({ code: 'FINAL_SNAPSHOT_FAILED' });
  });

  it('recognizes InvalidVolume.NotFound by message substring too (wrapped SDK errors)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Snapshots: [] })
      .mockRejectedValueOnce(new Error('API error: InvalidVolume.NotFound: vol-1 gone'));

    await expect(createEbsFinalSnapshot(mockEc2(send), 'vol-1', 'DataVolume', logger)).resolves.toBeNull();
  });

  it('falls through to CreateSnapshot when the reuse probe itself fails', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce({ SnapshotId: 'snap-9' })
      .mockResolvedValueOnce({ Snapshots: [{ SnapshotId: 'snap-9', State: 'completed' }] });

    await expect(createEbsFinalSnapshot(mockEc2(send), 'vol-1', 'DataVolume', logger)).resolves.toBe(
      'snap-9'
    );
  });

  it('throws FINAL_SNAPSHOT_FAILED when CreateSnapshot returns no snapshot id', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Snapshots: [] }).mockResolvedValueOnce({});

    await expect(
      createEbsFinalSnapshot(mockEc2(send), 'vol-1', 'DataVolume', logger)
    ).rejects.toMatchObject({ code: 'FINAL_SNAPSHOT_FAILED' });
  });

  it('tolerates a transient InvalidSnapshot.NotFound while the new snapshot propagates', async () => {
    const propagating = Object.assign(new Error('The snapshot does not exist.'), {
      name: 'InvalidSnapshot.NotFound',
    });
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Snapshots: [] })
      .mockResolvedValueOnce({ SnapshotId: 'snap-ec' })
      .mockRejectedValueOnce(propagating)
      .mockResolvedValueOnce({ Snapshots: [{ SnapshotId: 'snap-ec', State: 'completed' }] });

    await expect(createEbsFinalSnapshot(mockEc2(send), 'vol-1', 'DataVolume', logger)).resolves.toBe(
      'snap-ec'
    );
  });

  it('wraps a non-NotFound wait-poll failure as FINAL_SNAPSHOT_FAILED (never raw not-found text)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Snapshots: [] })
      .mockResolvedValueOnce({ SnapshotId: 'snap-w' })
      .mockRejectedValueOnce(new Error('RequestExpired: signature expired'));

    await expect(
      createEbsFinalSnapshot(mockEc2(send), 'vol-1', 'DataVolume', logger)
    ).rejects.toMatchObject({ code: 'FINAL_SNAPSHOT_FAILED' });
  });

  it('throws FINAL_SNAPSHOT_TIMEOUT when the wait deadline elapses', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Snapshots: [] })
      .mockResolvedValueOnce({ SnapshotId: 'snap-t' })
      .mockResolvedValue({ Snapshots: [{ SnapshotId: 'snap-t', State: 'pending' }] });

    const realNow = Date.now.bind(Date);
    const start = realNow();
    let calls = 0;
    // First Date.now() seeds the deadline; later reads jump past it.
    vi.spyOn(Date, 'now').mockImplementation(() =>
      calls++ === 0 ? start : start + 61 * 60 * 1_000
    );
    try {
      await expect(
        createEbsFinalSnapshot(mockEc2(send), 'vol-1', 'DataVolume', logger)
      ).rejects.toMatchObject({ code: 'FINAL_SNAPSHOT_TIMEOUT' });
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });
});

describe('isFinalSnapshotError', () => {
  it('matches only the typed FINAL_SNAPSHOT_* CdkdErrors', () => {
    expect(
      isFinalSnapshotError(new CdkdError('x', 'FINAL_SNAPSHOT_FAILED'))
    ).toBe(true);
    expect(
      isFinalSnapshotError(new CdkdError('x', 'FINAL_SNAPSHOT_TIMEOUT'))
    ).toBe(true);
    expect(
      isFinalSnapshotError(new CdkdError('x', 'FINAL_SNAPSHOT_UNSUPPORTED'))
    ).toBe(true);
    expect(isFinalSnapshotError(new CdkdError('x', 'OTHER'))).toBe(false);
    expect(isFinalSnapshotError(new Error('does not exist'))).toBe(false);
  });
});

describe('ccRoutedFinalSnapshotError', () => {
  it('names the cc-api route and the opt-out flag', () => {
    const err = ccRoutedFinalSnapshotError('Db', 'AWS::RDS::DBInstance', '--skip-final-snapshot');
    expect(err.code).toBe('FINAL_SNAPSHOT_UNSUPPORTED');
    expect(err.message).toContain('cc-api');
    expect(err.message).toContain('--skip-final-snapshot');
  });
});

describe('unsupportedFinalSnapshotError', () => {
  it('explains the CFn-supported list and the opt-out flag', () => {
    const err = unsupportedFinalSnapshotError('Bucket', 'AWS::S3::Bucket', '--skip-final-snapshot');
    expect(err).toBeInstanceOf(CdkdError);
    expect(err.code).toBe('FINAL_SNAPSHOT_UNSUPPORTED');
    expect(err.message).toContain('CloudFormation itself only supports Snapshot on');
    expect(err.message).toContain('--skip-final-snapshot');
  });
});

describe('finalSnapshotNamePrefix', () => {
  it('applies the same per-service cap as the identifier builder', () => {
    const longId = 'g'.repeat(60);
    const prefix = finalSnapshotNamePrefix(longId, 'AWS::ElastiCache::ReplicationGroup');
    const id = buildFinalSnapshotIdentifier(
      longId,
      'AWS::ElastiCache::ReplicationGroup',
      new Date('2026-08-03T04:05:06Z')
    );
    expect(id.startsWith(prefix)).toBe(true);
    expect(id.length).toBeLessThanOrEqual(50);
  });
});

describe('createRedshiftFinalSnapshot', () => {
  function mockRedshift(send: ReturnType<typeof vi.fn>) {
    return { send } as unknown as PreDeleteSnapshotClients['redshift'];
  }

  it('creates a prefixed manual snapshot and waits until available', async () => {
    const send = vi
      .fn()
      // reuse probe: nothing existing
      .mockResolvedValueOnce({ Snapshots: [] })
      // CreateClusterSnapshot
      .mockResolvedValueOnce({})
      // polls
      .mockResolvedValueOnce({ Snapshots: [{ Status: 'creating' }] })
      .mockResolvedValueOnce({ Snapshots: [{ Status: 'available' }] });

    const id = await createRedshiftFinalSnapshot(mockRedshift(send), 'my-cluster', 'Db', logger);
    expect(id).toMatch(/^my-cluster-final-\d{8}-\d{6}$/);
    const createCall = send.mock.calls[1][0];
    expect(createCall.constructor.name).toBe('CreateClusterSnapshotCommand');
    expect(createCall.input.ClusterIdentifier).toBe('my-cluster');
    expect(createCall.input.SnapshotIdentifier).toBe(id);
  });

  it('reuses an existing creating/available prefixed snapshot', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Snapshots: [
          { SnapshotIdentifier: 'my-cluster-final-20260803-000000', Status: 'available' },
        ],
      })
      .mockResolvedValueOnce({ Snapshots: [{ Status: 'available' }] });

    const id = await createRedshiftFinalSnapshot(mockRedshift(send), 'my-cluster', 'Db', logger);
    expect(id).toBe('my-cluster-final-20260803-000000');
    expect(send.mock.calls.map((c) => c[0].constructor.name)).not.toContain(
      'CreateClusterSnapshotCommand'
    );
  });

  it('returns null when the cluster no longer exists', async () => {
    const gone = Object.assign(new Error('Cluster my-cluster not found.'), {
      name: 'ClusterNotFoundFault',
    });
    const send = vi.fn().mockResolvedValueOnce({ Snapshots: [] }).mockRejectedValueOnce(gone);

    await expect(
      createRedshiftFinalSnapshot(mockRedshift(send), 'my-cluster', 'Db', logger)
    ).resolves.toBeNull();
  });

  it("throws FINAL_SNAPSHOT_FAILED when the snapshot enters 'failed' state", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Snapshots: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Snapshots: [{ Status: 'failed' }] });

    await expect(
      createRedshiftFinalSnapshot(mockRedshift(send), 'my-cluster', 'Db', logger)
    ).rejects.toMatchObject({ code: 'FINAL_SNAPSHOT_FAILED' });
  });

  it('tolerates transient ClusterSnapshotNotFoundFault polls, wraps other poll errors', async () => {
    const transient = Object.assign(new Error('Snapshot not found.'), {
      name: 'ClusterSnapshotNotFoundFault',
    });
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Snapshots: [] })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ Snapshots: [{ Status: 'available' }] });

    await expect(
      createRedshiftFinalSnapshot(mockRedshift(send), 'my-cluster', 'Db', logger)
    ).resolves.toMatch(/-final-/);

    const send2 = vi
      .fn()
      .mockResolvedValueOnce({ Snapshots: [] })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('RequestExpired'));
    await expect(
      createRedshiftFinalSnapshot(mockRedshift(send2), 'my-cluster', 'Db', logger)
    ).rejects.toMatchObject({ code: 'FINAL_SNAPSHOT_FAILED' });
  });
});

describe('createReplicationGroupFinalSnapshot', () => {
  function mockElastiCache(send: ReturnType<typeof vi.fn>) {
    return { send } as unknown as PreDeleteSnapshotClients['elastiCache'];
  }

  it('creates a prefixed snapshot against the replication group and waits until available', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Snapshots: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Snapshots: [{ SnapshotStatus: 'creating' }] })
      .mockResolvedValueOnce({ Snapshots: [{ SnapshotStatus: 'available' }] });

    const id = await createReplicationGroupFinalSnapshot(
      mockElastiCache(send),
      'my-group',
      'Cache',
      logger
    );
    expect(id).toMatch(/^my-group-final-\d{8}-\d{6}$/);
    expect(id?.length ?? 999).toBeLessThanOrEqual(50);
    const createCall = send.mock.calls[1][0];
    expect(createCall.constructor.name).toBe('CreateSnapshotCommand');
    expect(createCall.input.ReplicationGroupId).toBe('my-group');
    expect(createCall.input.SnapshotName).toBe(id);
  });

  it('returns null when the replication group no longer exists', async () => {
    const gone = Object.assign(new Error('Replication group not found.'), {
      name: 'ReplicationGroupNotFoundFault',
    });
    const send = vi.fn().mockResolvedValueOnce({ Snapshots: [] }).mockRejectedValueOnce(gone);

    await expect(
      createReplicationGroupFinalSnapshot(mockElastiCache(send), 'my-group', 'Cache', logger)
    ).resolves.toBeNull();
  });

  it('surfaces a Memcached/unsupported-node rejection as FINAL_SNAPSHOT_FAILED', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Snapshots: [] })
      .mockRejectedValueOnce(
        new Error('InvalidReplicationGroupState: snapshots are not supported for this node type')
      );

    await expect(
      createReplicationGroupFinalSnapshot(mockElastiCache(send), 'my-group', 'Cache', logger)
    ).rejects.toMatchObject({ code: 'FINAL_SNAPSHOT_FAILED' });
  });
});

describe('createPreDeleteFinalSnapshot dispatcher', () => {
  it('routes each PRE_DELETE type to its implementation', async () => {
    const ec2Send = vi
      .fn()
      .mockResolvedValueOnce({ Snapshots: [] })
      .mockResolvedValueOnce({ SnapshotId: 'snap-d' })
      .mockResolvedValueOnce({ Snapshots: [{ SnapshotId: 'snap-d', State: 'completed' }] });
    const clients = {
      ec2: { send: ec2Send },
      redshift: { send: vi.fn() },
      elastiCache: { send: vi.fn() },
    } as unknown as PreDeleteSnapshotClients;

    await expect(
      createPreDeleteFinalSnapshot('AWS::EC2::Volume', 'vol-1', 'Vol', clients, logger)
    ).resolves.toBe('snap-d');
    expect(clients.redshift.send).not.toHaveBeenCalled();
    expect(clients.elastiCache.send).not.toHaveBeenCalled();
  });

  it('fails closed on a PRE_DELETE type with no implementation (set/dispatcher drift guard)', async () => {
    const clients = {
      ec2: { send: vi.fn() },
      redshift: { send: vi.fn() },
      elastiCache: { send: vi.fn() },
    } as unknown as PreDeleteSnapshotClients;
    await expect(
      createPreDeleteFinalSnapshot('AWS::Future::Type', 'x', 'X', clients, logger)
    ).rejects.toMatchObject({ code: 'FINAL_SNAPSHOT_FAILED' });
  });
});
