import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeFileSystemsCommand,
  ModifyMountTargetSecurityGroupsCommand,
  UpdateFileSystemCommand,
} from '@aws-sdk/client-efs';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-efs', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-efs')>(
    '@aws-sdk/client-efs'
  );
  return {
    ...actual,
    EFSClient: vi.fn().mockImplementation(() => ({
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

import { EFSProvider } from '../../../src/provisioning/providers/efs-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

/**
 * After UpdateFileSystem, the provider polls DescribeFileSystems until
 * the FS state returns to `available`. Set up the mock chain so the
 * Update returns immediately and the very next DescribeFileSystems
 * surfaces an `available` state.
 */
function mockUpdateFileSystemAvailable() {
  mockSend
    .mockResolvedValueOnce({}) // UpdateFileSystem
    .mockResolvedValueOnce({
      FileSystems: [{ FileSystemId: 'fs-1', LifeCycleState: 'available' }],
    });
}

describe('EFSProvider read-update round-trip', () => {
  let provider: EFSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EFSProvider();
  });

  // ─── AWS::EFS::FileSystem ────────────────────────────────────────────

  it('FileSystem — ThroughputMode change sends UpdateFileSystem and waits for available state', async () => {
    mockUpdateFileSystemAvailable();

    const previous = {
      PerformanceMode: 'generalPurpose',
      ThroughputMode: 'bursting',
      Encrypted: false,
    };
    const next = {
      PerformanceMode: 'generalPurpose',
      ThroughputMode: 'elastic',
      Encrypted: false,
    };

    const result = await provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', next, previous);
    expect(result).toEqual({ physicalId: 'fs-1', wasReplaced: false });

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateFileSystemCommand);
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as {
      FileSystemId: string;
      ThroughputMode?: string;
      ProvisionedThroughputInMibps?: number;
    };
    expect(input.FileSystemId).toBe('fs-1');
    expect(input.ThroughputMode).toBe('elastic');
    // ProvisionedThroughputInMibps was not in the diff — must NOT be
    // sent (would force a mode-incompatible update).
    expect(input.ProvisionedThroughputInMibps).toBeUndefined();

    // Post-update wait fired DescribeFileSystems.
    expect(mockSend.mock.calls.some((c) => c[0] instanceof DescribeFileSystemsCommand)).toBe(true);
  });

  it('FileSystem — ProvisionedThroughputInMibps-only change sends only that field', async () => {
    mockUpdateFileSystemAvailable();

    const previous = {
      PerformanceMode: 'generalPurpose',
      ThroughputMode: 'provisioned',
      ProvisionedThroughputInMibps: 100,
    };
    const next = {
      PerformanceMode: 'generalPurpose',
      ThroughputMode: 'provisioned',
      ProvisionedThroughputInMibps: 200,
    };

    await provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', next, previous);

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateFileSystemCommand);
    const input = updateCall![0].input as {
      ThroughputMode?: string;
      ProvisionedThroughputInMibps?: number;
    };
    expect(input.ThroughputMode).toBeUndefined();
    expect(input.ProvisionedThroughputInMibps).toBe(200);
  });

  it('FileSystem — no mutable diff is a silent no-op (matches wider provider convention)', async () => {
    const observed = {
      PerformanceMode: 'generalPurpose',
      ThroughputMode: 'bursting',
      Encrypted: false,
    };

    const result = await provider.update(
      'L',
      'fs-1',
      'AWS::EFS::FileSystem',
      observed,
      observed
    );
    expect(result).toEqual({ physicalId: 'fs-1', wasReplaced: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('FileSystem — Encrypted diff (immutable) defensively rejects with ResourceUpdateNotSupportedError', async () => {
    // The replacement-detection layer normally routes immutable diffs
    // through DELETE+CREATE before update() is called. If a diff
    // including an immutable field DOES reach update(), refuse rather
    // than apply only the mutable subset and leave AWS in a partial
    // state that doesn't match the user's intent.
    const previous = { ThroughputMode: 'bursting', Encrypted: false };
    const next = { ThroughputMode: 'elastic', Encrypted: true };

    await expect(
      provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', next, previous)
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ─── AWS::EFS::AccessPoint ───────────────────────────────────────────

  it('AccessPoint — update() rejects with ResourceUpdateNotSupportedError (no mutable surface)', async () => {
    const observed = {
      FileSystemId: 'fs-1',
      PosixUser: { Uid: 1000, Gid: 1000 },
      RootDirectory: {
        Path: '/data',
        CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '755' },
      },
    };

    await expect(
      provider.update('L', 'fsap-1', 'AWS::EFS::AccessPoint', observed, observed)
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ─── AWS::EFS::MountTarget ───────────────────────────────────────────

  it('MountTarget — SecurityGroups change sends ModifyMountTargetSecurityGroups', async () => {
    mockSend.mockResolvedValueOnce({});

    const previous = {
      FileSystemId: 'fs-1',
      SubnetId: 'subnet-1',
      SecurityGroups: ['sg-old'],
    };
    const next = {
      FileSystemId: 'fs-1',
      SubnetId: 'subnet-1',
      SecurityGroups: ['sg-new1', 'sg-new2'],
    };

    const result = await provider.update(
      'L',
      'fsmt-1',
      'AWS::EFS::MountTarget',
      next,
      previous
    );
    expect(result).toEqual({ physicalId: 'fsmt-1', wasReplaced: false });

    const call = mockSend.mock.calls.find(
      (c) => c[0] instanceof ModifyMountTargetSecurityGroupsCommand
    );
    expect(call).toBeDefined();
    const input = call![0].input as { MountTargetId: string; SecurityGroups: string[] };
    expect(input.MountTargetId).toBe('fsmt-1');
    expect(input.SecurityGroups).toEqual(['sg-new1', 'sg-new2']);
  });

  it('MountTarget — empty SecurityGroups [] reaches AWS (truthy-gate guard)', async () => {
    // `cdkd drift --revert` must clear console-side ADDs; an empty
    // array must reach AWS rather than be dropped by a truthy gate.
    mockSend.mockResolvedValueOnce({});

    const observed = {
      FileSystemId: 'fs-1',
      SubnetId: 'subnet-1',
      SecurityGroups: [],
    };

    await provider.update('L', 'fsmt-1', 'AWS::EFS::MountTarget', observed, observed);

    const call = mockSend.mock.calls.find(
      (c) => c[0] instanceof ModifyMountTargetSecurityGroupsCommand
    );
    expect(call).toBeDefined();
    const input = call![0].input as { SecurityGroups: string[] };
    expect(input.SecurityGroups).toEqual([]);
  });

  it('MountTarget — no SecurityGroups in properties is a silent no-op', async () => {
    const observed = {
      FileSystemId: 'fs-1',
      SubnetId: 'subnet-1',
    };

    const result = await provider.update(
      'L',
      'fsmt-1',
      'AWS::EFS::MountTarget',
      observed,
      observed
    );
    expect(result).toEqual({ physicalId: 'fsmt-1', wasReplaced: false });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
