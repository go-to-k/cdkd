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
  finalSnapshotMechanism,
  refusesFinalSnapshot,
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

describe('the Snapshot-capable type sets', () => {
  // Re-homed from the deleted `supportsFinalSnapshot` predicate (issue
  // #1368), asserted on the SETS themselves so the fence survives the
  // predicate. Both claims below are load-bearing elsewhere.
  it('their union is exactly the CloudFormation-documented Snapshot-capable list (#1353)', () => {
    // CloudFormation supports DeletionPolicy: Snapshot on exactly these
    // types. Pinned as a literal so ADDING a type to a set without updating
    // the docs (or dropping one) fails here rather than silently changing
    // what cdkd claims to cover.
    const CFN_SNAPSHOT_CAPABLE = [
      'AWS::EC2::Volume',
      'AWS::ElastiCache::CacheCluster',
      'AWS::ElastiCache::ReplicationGroup',
      'AWS::Neptune::DBCluster',
      'AWS::RDS::DBCluster',
      'AWS::RDS::DBInstance',
      'AWS::Redshift::Cluster',
      'AWS::DocDB::DBCluster',
    ].sort();
    const union = [...ATOMIC_FINAL_SNAPSHOT_TYPES, ...PRE_DELETE_SNAPSHOT_TYPES].sort();
    expect(union).toEqual(CFN_SNAPSHOT_CAPABLE);
  });

  it('the two sets are DISJOINT (finalSnapshotMechanism tests atomic first)', () => {
    // A type in both would silently take the atomic arm and never reach the
    // pre-delete snapshot — an unobservable mis-route, so pin it here.
    const overlap = [...ATOMIC_FINAL_SNAPSHOT_TYPES].filter((t) =>
      PRE_DELETE_SNAPSHOT_TYPES.has(t)
    );
    expect(overlap).toEqual([]);
  });

  it('a type CloudFormation itself refuses Snapshot for is in neither set', () => {
    expect(ATOMIC_FINAL_SNAPSHOT_TYPES.has('AWS::S3::Bucket')).toBe(false);
    expect(PRE_DELETE_SNAPSHOT_TYPES.has('AWS::S3::Bucket')).toBe(false);
  });
});

describe('finalSnapshotMechanism / refusesFinalSnapshot (#1366)', () => {
  it('atomic types resolve by ROUTE: SDK gets the delete parameter, cc-api is refused', () => {
    for (const t of ATOMIC_FINAL_SNAPSHOT_TYPES) {
      expect(finalSnapshotMechanism(t, 'sdk')).toBe('atomic-delete-parameter');
      // An unknown route is the legacy-SDK default, not a refusal.
      expect(finalSnapshotMechanism(t, undefined)).toBe('atomic-delete-parameter');
      expect(finalSnapshotMechanism(t, 'cc-api')).toBe('refuse-cc-routed');
    }
  });

  it('pre-delete types are route-agnostic (cdkd snapshots them itself)', () => {
    for (const t of PRE_DELETE_SNAPSHOT_TYPES) {
      for (const route of ['sdk', 'cc-api', undefined] as const) {
        expect(finalSnapshotMechanism(t, route)).toBe('pre-delete-snapshot');
      }
    }
  });

  it('anything else is refused as an unsupported type', () => {
    expect(finalSnapshotMechanism('AWS::S3::Bucket', 'sdk')).toBe('refuse-unsupported-type');
    expect(finalSnapshotMechanism('AWS::S3::Bucket', 'cc-api')).toBe('refuse-unsupported-type');
  });

  it('refusesFinalSnapshot is exactly the two refuse arms', () => {
    // The predicate the plan preview asks. Both polarities pinned per type
    // class so a matrix collapse cannot pass by agreeing everywhere.
    expect(refusesFinalSnapshot('AWS::RDS::DBInstance', 'sdk')).toBe(false);
    expect(refusesFinalSnapshot('AWS::RDS::DBInstance', 'cc-api')).toBe(true);
    expect(refusesFinalSnapshot('AWS::EC2::Volume', 'cc-api')).toBe(false);
    expect(refusesFinalSnapshot('AWS::S3::Bucket', 'sdk')).toBe(true);
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

  it('resumes an IN-FLIGHT (creating) generated snapshot', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Snapshots: [
          { SnapshotIdentifier: 'my-cluster-final-20260803-000000', Status: 'creating' },
        ],
      })
      .mockResolvedValueOnce({ Snapshots: [{ Status: 'available' }] });

    const id = await createRedshiftFinalSnapshot(mockRedshift(send), 'my-cluster', 'Db', logger);
    expect(id).toBe('my-cluster-final-20260803-000000');
    expect(send.mock.calls.map((c) => c[0].constructor.name)).not.toContain(
      'CreateClusterSnapshotCommand'
    );
  });

  it('does NOT reuse an already-available snapshot — it may be a PREVIOUS generation', async () => {
    // Redshift cluster ids are user-chosen and reusable, and a manual
    // snapshot outlives its cluster: reusing an `available` one would delete
    // generation 2 while handing back generation 1's data (reviewer blocker).
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Snapshots: [
          { SnapshotIdentifier: 'my-cluster-final-20260101-000000', Status: 'available' },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Snapshots: [{ Status: 'available' }] });

    const id = await createRedshiftFinalSnapshot(mockRedshift(send), 'my-cluster', 'Db', logger);
    expect(id).not.toBe('my-cluster-final-20260101-000000');
    expect(send.mock.calls.map((c) => c[0].constructor.name)).toContain(
      'CreateClusterSnapshotCommand'
    );
  });

  it("does NOT adopt a user's own snapshot that merely shares the prefix", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Snapshots: [{ SnapshotIdentifier: 'my-cluster-final-backup', Status: 'creating' }],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Snapshots: [{ Status: 'available' }] });

    const id = await createRedshiftFinalSnapshot(mockRedshift(send), 'my-cluster', 'Db', logger);
    expect(id).toMatch(/^my-cluster-final-\d{8}-\d{6}$/);
    expect(send.mock.calls.map((c) => c[0].constructor.name)).toContain(
      'CreateClusterSnapshotCommand'
    );
  });

  it('follows the reuse probe Marker across pages', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Snapshots: [], Marker: 'page2' })
      .mockResolvedValueOnce({
        Snapshots: [
          { SnapshotIdentifier: 'my-cluster-final-20260803-000000', Status: 'creating' },
        ],
      })
      .mockResolvedValueOnce({ Snapshots: [{ Status: 'available' }] });

    const id = await createRedshiftFinalSnapshot(mockRedshift(send), 'my-cluster', 'Db', logger);
    expect(id).toBe('my-cluster-final-20260803-000000');
    expect(send.mock.calls[1][0].input.Marker).toBe('page2');
  });

  it('treats an already-deleting cluster as gone rather than failing permanently', async () => {
    const deleting = Object.assign(new Error('Cluster is not in a valid state'), {
      name: 'InvalidClusterStateFault',
    });
    const send = vi.fn().mockResolvedValueOnce({ Snapshots: [] }).mockRejectedValueOnce(deleting);

    await expect(
      createRedshiftFinalSnapshot(mockRedshift(send), 'my-cluster', 'Db', logger)
    ).resolves.toBeNull();
  });

  it('waits for the CLUSTER to settle after the snapshot, before the caller deletes', async () => {
    // The snapshot reaching `available` leaves the cluster briefly busy; the
    // delete that follows then 400s with "There is an operation running on
    // the Cluster" (seen live 2026-08-03).
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Snapshots: [] }) // reuse probe
      .mockResolvedValueOnce({}) // CreateClusterSnapshot
      .mockResolvedValueOnce({ Snapshots: [{ Status: 'available' }] }) // snapshot ready
      .mockResolvedValueOnce({ Clusters: [{ ClusterStatus: 'modifying' }] })
      .mockResolvedValueOnce({ Clusters: [{ ClusterStatus: 'available' }] });

    await createRedshiftFinalSnapshot(mockRedshift(send), 'my-cluster', 'Db', logger);

    const settlePolls = send.mock.calls.filter(
      (c) => c[0].constructor.name === 'DescribeClustersCommand'
    );
    expect(settlePolls.length).toBe(2);
    // One grace sleep after `available` (see the comment at the return).
    expect(finalSnapshotDelays.sleep).toHaveBeenCalled();
  });

  it('settle wait tolerates a gone cluster and never fails the delete', async () => {
    const gone = Object.assign(new Error('Cluster not found'), { name: 'ClusterNotFoundFault' });
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Snapshots: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Snapshots: [{ Status: 'available' }] })
      .mockRejectedValueOnce(gone);

    await expect(
      createRedshiftFinalSnapshot(mockRedshift(send), 'my-cluster', 'Db', logger)
    ).resolves.toMatch(/-final-/);
  });

  it("fails fast on a terminal 'cancelled' status instead of polling for an hour", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Snapshots: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Snapshots: [{ Status: 'cancelled' }] });

    await expect(
      createRedshiftFinalSnapshot(mockRedshift(send), 'my-cluster', 'Db', logger)
    ).rejects.toMatchObject({ code: 'FINAL_SNAPSHOT_FAILED' });
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
  /** DescribeReplicationGroups response for a cluster-mode-DISABLED group. */
  const modeDisabled = {
    ReplicationGroups: [
      {
        ClusterEnabled: false,
        MemberClusters: ['my-group-001'],
        NodeGroups: [
          { NodeGroupMembers: [{ CacheClusterId: 'my-group-001', CurrentRole: 'primary' }] },
        ],
      },
    ],
  };
  /** DescribeReplicationGroups response for a cluster-mode-ENABLED group. */
  const modeEnabled = { ReplicationGroups: [{ ClusterEnabled: true }] };

  it('cluster-mode DISABLED: snapshots the PRIMARY member cache cluster, not the group', async () => {
    // AWS rejects CreateSnapshot(ReplicationGroupId) for a cluster-mode-disabled
    // group ("Please specify a cache cluster instead") — found live 2026-08-03.
    const send = vi
      .fn()
      .mockResolvedValueOnce(modeDisabled)
      .mockResolvedValueOnce({ Snapshots: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Snapshots: [{ SnapshotStatus: 'available' }] });

    const id = await createReplicationGroupFinalSnapshot(
      mockElastiCache(send),
      'my-group',
      'Cache',
      logger
    );
    expect(id).toMatch(/^my-group-final-\d{8}-\d{6}$/);
    const probeCall = send.mock.calls[1][0];
    expect(probeCall.input.CacheClusterId).toBe('my-group-001');
    expect(probeCall.input.ReplicationGroupId).toBeUndefined();
    const createCall = send.mock.calls[2][0];
    expect(createCall.constructor.name).toBe('CreateSnapshotCommand');
    expect(createCall.input.CacheClusterId).toBe('my-group-001');
    expect(createCall.input.ReplicationGroupId).toBeUndefined();
    expect(createCall.input.SnapshotName).toBe(id);
  });

  it('cluster-mode ENABLED: snapshots the replication group itself', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(modeEnabled)
      .mockResolvedValueOnce({ Snapshots: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Snapshots: [{ SnapshotStatus: 'available' }] });

    const id = await createReplicationGroupFinalSnapshot(
      mockElastiCache(send),
      'my-group',
      'Cache',
      logger
    );
    const createCall = send.mock.calls[2][0];
    expect(createCall.input.ReplicationGroupId).toBe('my-group');
    expect(createCall.input.CacheClusterId).toBeUndefined();
    expect(id).toMatch(/^my-group-final-/);
  });

  it('caps the generated name at the ~50-char ElastiCache limit', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(modeEnabled)
      .mockResolvedValueOnce({ Snapshots: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Snapshots: [{ SnapshotStatus: 'available' }] });

    const id = await createReplicationGroupFinalSnapshot(
      mockElastiCache(send),
      'g'.repeat(40),
      'Cache',
      logger
    );
    expect(id?.length ?? 999).toBeLessThanOrEqual(50);
  });

  it('resumes an in-flight snapshot via SnapshotName / SnapshotStatus (field-name pin)', async () => {
    // Redshift's twin uses SnapshotIdentifier / Status — swapping those in
    // here would silently duplicate the snapshot on every delete re-run.
    const send = vi
      .fn()
      .mockResolvedValueOnce(modeDisabled)
      .mockResolvedValueOnce({
        Snapshots: [{ SnapshotName: 'my-group-final-20260803-000000', SnapshotStatus: 'creating' }],
      })
      .mockResolvedValueOnce({ Snapshots: [{ SnapshotStatus: 'available' }] });

    const id = await createReplicationGroupFinalSnapshot(
      mockElastiCache(send),
      'my-group',
      'Cache',
      logger
    );
    expect(id).toBe('my-group-final-20260803-000000');
    expect(send.mock.calls.map((c) => c[0].constructor.name)).not.toContain('CreateSnapshotCommand');
  });

  it('does NOT reuse an already-available snapshot (cross-generation guard)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(modeDisabled)
      .mockResolvedValueOnce({
        Snapshots: [
          { SnapshotName: 'my-group-final-20260101-000000', SnapshotStatus: 'available' },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Snapshots: [{ SnapshotStatus: 'available' }] });

    const id = await createReplicationGroupFinalSnapshot(
      mockElastiCache(send),
      'my-group',
      'Cache',
      logger
    );
    expect(id).not.toBe('my-group-final-20260101-000000');
    expect(send.mock.calls.map((c) => c[0].constructor.name)).toContain('CreateSnapshotCommand');
  });

  it('treats an already-deleting replication group as gone', async () => {
    const deleting = Object.assign(new Error('not in a valid state'), {
      name: 'InvalidReplicationGroupStateFault',
    });
    const send = vi
      .fn()
      .mockResolvedValueOnce(modeDisabled)
      .mockResolvedValueOnce({ Snapshots: [] })
      .mockRejectedValueOnce(deleting);

    await expect(
      createReplicationGroupFinalSnapshot(mockElastiCache(send), 'my-group', 'Cache', logger)
    ).resolves.toBeNull();
  });

  it('returns null when the replication group no longer exists', async () => {
    const gone = Object.assign(new Error('Replication group not found.'), {
      name: 'ReplicationGroupNotFoundFault',
    });
    const send = vi.fn().mockRejectedValueOnce(gone);

    await expect(
      createReplicationGroupFinalSnapshot(mockElastiCache(send), 'my-group', 'Cache', logger)
    ).resolves.toBeNull();
  });

  it('returns null when the describe comes back with no group', async () => {
    const send = vi.fn().mockResolvedValueOnce({ ReplicationGroups: [] });

    await expect(
      createReplicationGroupFinalSnapshot(mockElastiCache(send), 'my-group', 'Cache', logger)
    ).resolves.toBeNull();
  });

  it('surfaces a Memcached/unsupported-node rejection as FINAL_SNAPSHOT_FAILED', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(modeDisabled)
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
  it('has an implementation for EVERY PRE_DELETE type (set/dispatcher drift guard)', async () => {
    // The `default:` arm throws FINAL_SNAPSHOT_FAILED; if a type were added
    // to the set without an implementation this would surface it.
    for (const type of PRE_DELETE_SNAPSHOT_TYPES) {
      const clients = {
        ec2: { send: vi.fn().mockRejectedValue(new Error('probe')) },
        redshift: { send: vi.fn().mockRejectedValue(new Error('probe')) },
        elastiCache: { send: vi.fn().mockRejectedValue(new Error('probe')) },
      } as unknown as PreDeleteSnapshotClients;
      await expect(
        createPreDeleteFinalSnapshot(type, 'src', 'Src', clients, logger)
      ).rejects.toMatchObject({
        code: 'FINAL_SNAPSHOT_FAILED',
        // The dispatcher reached a real implementation (which then failed on
        // the mocked create), NOT the no-implementation default arm.
        message: expect.not.stringContaining('No pre-delete final-snapshot implementation'),
      });
    }
  });

  it('routes AWS::EC2::Volume to the EBS implementation', async () => {
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
