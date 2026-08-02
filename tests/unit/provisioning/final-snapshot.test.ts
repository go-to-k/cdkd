import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

import {
  ATOMIC_FINAL_SNAPSHOT_TYPES,
  PRE_DELETE_SNAPSHOT_TYPES,
  buildFinalSnapshotIdentifier,
  createEbsFinalSnapshot,
  finalSnapshotDelays,
  supportsFinalSnapshot,
  unsupportedFinalSnapshotError,
  EBS_FINAL_SNAPSHOT_TAG_KEY,
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
    expect(supportsFinalSnapshot('AWS::Redshift::Cluster')).toBe(false);
    expect(supportsFinalSnapshot('AWS::ElastiCache::ReplicationGroup')).toBe(false);
    expect(supportsFinalSnapshot('AWS::S3::Bucket')).toBe(false);
  });
});

describe('buildFinalSnapshotIdentifier', () => {
  it('builds <physicalId>-final-<utc timestamp>', () => {
    const id = buildFinalSnapshotIdentifier('my-db-1', new Date('2026-08-03T04:05:06Z'));
    expect(id).toBe('my-db-1-final-20260803-040506');
  });

  it('sanitizes invalid characters and forces a leading letter', () => {
    const id = buildFinalSnapshotIdentifier('123_Weird__Name-', new Date('2026-08-03T04:05:06Z'));
    expect(id).toMatch(/^[a-z]/);
    expect(id).toMatch(/^r123-weird-name-final-20260803-040506$/);
    expect(id).not.toMatch(/--/);
  });

  it('caps the total length at 255', () => {
    const id = buildFinalSnapshotIdentifier('a'.repeat(300), new Date('2026-08-03T04:05:06Z'));
    expect(id.length).toBeLessThanOrEqual(255);
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
});

describe('unsupportedFinalSnapshotError', () => {
  it('names the follow-up issue for a known-unimplemented type', () => {
    const err = unsupportedFinalSnapshotError(
      'Cluster',
      'AWS::Redshift::Cluster',
      '--skip-final-snapshot'
    );
    expect(err).toBeInstanceOf(CdkdError);
    expect(err.code).toBe('FINAL_SNAPSHOT_UNSUPPORTED');
    expect(err.message).toContain('#1353');
    expect(err.message).toContain('--skip-final-snapshot');
  });

  it('explains the CFn-supported list for a type CFn itself would refuse', () => {
    const err = unsupportedFinalSnapshotError('Bucket', 'AWS::S3::Bucket', '--skip-final-snapshot');
    expect(err.message).toContain('CloudFormation itself only supports Snapshot on');
  });
});
