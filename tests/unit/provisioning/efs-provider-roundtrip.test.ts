import { describe, it, expect, vi, beforeEach } from 'vitest';

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

describe('EFSProvider read-update round-trip', () => {
  let provider: EFSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EFSProvider();
  });

  // ─── AWS::EFS::FileSystem ────────────────────────────────────────────

  it('FileSystem: update() rejects with ResourceUpdateNotSupportedError on round-trip and sends NO AWS calls', async () => {
    // EFS update() is unsupported for every type (PR I — see CLAUDE.md).
    // Class 1 (KmsKeyId / ProvisionedThroughputInMibps) and Class 2
    // (BackupPolicy / LifecyclePolicies) placeholder regressions cannot
    // surface here as AWS-rejection-shaped wire calls because update()
    // never reaches the SDK. The structural guard for cdkd drift
    // --revert is therefore: update() rejects the round-trip and emits
    // zero AWS API calls so the operator gets a clear "use --replace"
    // message instead of a partial AWS mutation.

    // Build the AWS-current-style snapshot that readCurrentState would
    // produce for a bursting, encrypted FileSystem with no lifecycle /
    // backup configured. KmsKeyId omitted (Class 1: only valid on
    // Encrypted=true — the read side gates on AWS returning it, so
    // observed never carries KmsKeyId on Encrypted=false). Same for
    // ProvisionedThroughputInMibps (only valid on
    // ThroughputMode=provisioned).
    const observed = {
      PerformanceMode: 'generalPurpose',
      ThroughputMode: 'bursting',
      Encrypted: false,
      FileSystemTags: [] as Array<{ Key: string; Value: string }>,
    };

    await expect(
      provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', observed, observed)
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);

    // Critical: no AWS API call ever fired — observed placeholders
    // cannot reach the wire, so Class 1 / Class 2 false-positives
    // cannot manifest on EFS until update() is implemented.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('FileSystem: KmsKeyId placeholder (Class 1) round-trip rejects without sending any wire call', async () => {
    // Defensive variant — even if a future caller hand-builds an
    // observed snapshot that DOES carry KmsKeyId on a non-encrypted
    // FileSystem, the round-trip must still reject and emit zero AWS
    // calls. update() being a hard reject is what protects against
    // KmsKeyId-on-Encrypted=false / ProvisionedThroughputInMibps-on-
    // bursting-throughput Class 1 regressions reaching the wire.
    const observed = {
      PerformanceMode: 'generalPurpose',
      ThroughputMode: 'provisioned',
      ProvisionedThroughputInMibps: 100,
      Encrypted: true,
      KmsKeyId: 'arn:aws:kms:us-east-1:1:key/abc',
      LifecyclePolicies: [],
      BackupPolicy: { Status: 'ENABLED' },
      FileSystemTags: [{ Key: 'k', Value: 'v' }],
    };

    await expect(
      provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', observed, observed)
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ─── AWS::EFS::AccessPoint ───────────────────────────────────────────

  it('AccessPoint: update() rejects with ResourceUpdateNotSupportedError on round-trip and sends NO AWS calls', async () => {
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

  it('MountTarget: update() rejects with ResourceUpdateNotSupportedError on round-trip and sends NO AWS calls', async () => {
    const observed = {
      FileSystemId: 'fs-1',
      SubnetId: 'subnet-1',
    };

    await expect(
      provider.update('L', 'fsmt-1', 'AWS::EFS::MountTarget', observed, observed)
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ─── Error message guidance (operator-facing) ────────────────────────

  it('rejection message points at the --replace / re-deploy escape hatch', async () => {
    // The reject message is what cdkd drift --revert surfaces as the
    // ⊘ "could not revert" line for the operator. Verify the canonical
    // EFS guidance string is present so a future refactor of the error
    // text doesn't silently lose the actionable hint.
    const observed = {
      PerformanceMode: 'generalPurpose',
      ThroughputMode: 'bursting',
      Encrypted: false,
      FileSystemTags: [] as Array<{ Key: string; Value: string }>,
    };

    await expect(
      provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', observed, observed)
    ).rejects.toThrow(/recreated on property changes/);
  });
});
