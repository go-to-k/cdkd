import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateFileSystemCommand } from '@aws-sdk/client-efs';

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

/**
 * Issue #1160 (efs batch): removal semantics for ThroughputMode /
 * ProvisionedThroughputInMibps on AWS::EFS::FileSystem update.
 *
 * Live CFn A/B (2026-08-11) split the umbrella's SUSPECT row in two:
 *  - Removing ThroughputMode alone from a NON-provisioned file system is
 *    RETAINED by CloudFormation (elastic stayed elastic), so the provider's
 *    pass-through skip is CFn parity — pinned by the negative tests below.
 *  - Removing ThroughputMode + ProvisionedThroughputInMibps from a
 *    'provisioned' file system IS reset by CloudFormation to the create
 *    default 'bursting', so the provider must send it explicitly
 *    (UpdateFileSystem merges — an absent field keeps the live value).
 */
function mockUpdateFileSystemAvailable() {
  mockSend
    .mockResolvedValueOnce({}) // UpdateFileSystem
    .mockResolvedValueOnce({
      FileSystems: [{ FileSystemId: 'fs-1', LifeCycleState: 'available' }],
    });
}

function updateFileSystemCall() {
  return mockSend.mock.calls.find((c) => c[0] instanceof UpdateFileSystemCommand);
}

describe('EFSProvider FileSystem throughput removal semantics (#1160)', () => {
  let provider: EFSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EFSProvider();
  });

  it('removal of ThroughputMode + ProvisionedThroughputInMibps from provisioned resets to bursting', async () => {
    mockUpdateFileSystemAvailable();

    const previous = {
      ThroughputMode: 'provisioned',
      ProvisionedThroughputInMibps: 1,
    };
    const next = {};

    const result = await provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', next, previous);
    expect(result).toEqual({ physicalId: 'fs-1', wasReplaced: false });

    const call = updateFileSystemCall();
    expect(call).toBeDefined();
    const input = call![0].input as {
      FileSystemId: string;
      ThroughputMode?: string;
      ProvisionedThroughputInMibps?: number;
    };
    expect(input.ThroughputMode).toBe('bursting');
    // The reset must NOT carry a ProvisionedThroughputInMibps — bursting
    // mode rejects it, and switching the mode is what clears the value.
    expect(input.ProvisionedThroughputInMibps).toBeUndefined();
  });

  it('removal of ThroughputMode alone from elastic is retained (CFn parity — no UpdateFileSystem)', async () => {
    // CFn A/B 2026-08-11: CloudFormation RETAINS the customized mode when
    // the property is removed from a non-provisioned file system. A future
    // "fix" that emits UpdateFileSystem({ ThroughputMode: 'bursting' }) here
    // would DIVERGE from CloudFormation — this test pins the parity.
    const previous = { ThroughputMode: 'elastic' };
    const next = {};

    const result = await provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', next, previous);
    expect(result).toEqual({ physicalId: 'fs-1', wasReplaced: false });
    expect(updateFileSystemCall()).toBeUndefined();
  });

  it('removal of ThroughputMode alone from bursting is a no-op', async () => {
    const previous = { ThroughputMode: 'bursting' };
    const next = {};

    await provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', next, previous);
    expect(updateFileSystemCall()).toBeUndefined();
  });

  it('never-present ThroughputMode stays absent (no reset, no call)', async () => {
    const previous = { Encrypted: true };
    const next = { Encrypted: true };

    await provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', next, previous);
    expect(updateFileSystemCall()).toBeUndefined();
  });

  it('kept ThroughputMode change still passes through (true-path polarity)', async () => {
    mockUpdateFileSystemAvailable();

    const previous = { ThroughputMode: 'provisioned', ProvisionedThroughputInMibps: 1 };
    const next = { ThroughputMode: 'elastic' };

    await provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', next, previous);

    const call = updateFileSystemCall();
    expect(call).toBeDefined();
    const input = call![0].input as { ThroughputMode?: string };
    // An explicit template value always wins over the removal-reset arm.
    expect(input.ThroughputMode).toBe('elastic');
  });

  it('removal of ProvisionedThroughputInMibps alone (mode kept provisioned) is deferred — no call', async () => {
    // No wire shape can reset the provisioned value while the mode stays
    // 'provisioned' (the API requires a value in that mode and documents no
    // default), so the provider deliberately defers. Pinned so the deferral
    // is a decision, not an accident.
    const previous = { ThroughputMode: 'provisioned', ProvisionedThroughputInMibps: 1 };
    const next = { ThroughputMode: 'provisioned' };

    await provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', next, previous);
    expect(updateFileSystemCall()).toBeUndefined();
  });

  it('removal of ThroughputMode while ProvisionedThroughputInMibps is kept does not reset', async () => {
    // The reset arm requires BOTH fields removed; a template still carrying
    // the provisioned value keeps the mode (unchanged value -> no call).
    const previous = { ThroughputMode: 'provisioned', ProvisionedThroughputInMibps: 1 };
    const next = { ProvisionedThroughputInMibps: 1 };

    await provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', next, previous);
    expect(updateFileSystemCall()).toBeUndefined();
  });

  it('removal of ThroughputMode with a CHANGED kept ProvisionedThroughputInMibps sends only the value', async () => {
    // The last matrix cell: mode removed but the provisioned value changed.
    // The reset arm must not fire (a value is still present), and the update
    // passes only the changed value through — mode stays provisioned on AWS.
    mockUpdateFileSystemAvailable();

    const previous = { ThroughputMode: 'provisioned', ProvisionedThroughputInMibps: 1 };
    const next = { ProvisionedThroughputInMibps: 2 };

    await provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', next, previous);

    const call = updateFileSystemCall();
    expect(call).toBeDefined();
    const input = call![0].input as {
      ThroughputMode?: string;
      ProvisionedThroughputInMibps?: number;
    };
    expect(input.ThroughputMode).toBeUndefined();
    expect(input.ProvisionedThroughputInMibps).toBe(2);
  });
});
