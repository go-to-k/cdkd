import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { TagResourceCommand, UpdateFileSystemCommand } from '@aws-sdk/client-efs';

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
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { getLogger } from '../../../src/utils/logger.js';

const providerWarn = getLogger().child('efs').warn as ReturnType<typeof vi.fn>;

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
 *  - Removing only ProvisionedThroughputInMibps while the mode stays
 *    'provisioned' is REJECTED by CloudFormation (go-to-k/cdkd#5547), so the
 *    provider refuses it before any call.
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

  describe('ThroughputMode: provisioned without ProvisionedThroughputInMibps (#5547)', () => {
    // Live CFn A/B (go-to-k/cdkd#5547, us-east-1): removing only the value
    // while the mode stays provisioned FAILS the CloudFormation update with
    // "Throughput value must be specified for provisioned throughput mode."
    // before any EFS mutation, alone and beside a tag + lifecycle change, and
    // the file system keeps its old value. cdkd refuses up front to match.
    const refusal = /Throughput value must be specified for provisioned throughput mode/;

    it('removal of the value alone is refused before any call', async () => {
      const previous = { ThroughputMode: 'provisioned', ProvisionedThroughputInMibps: 2 };
      const next = { ThroughputMode: 'provisioned' };

      const error = await provider
        .update('L', 'fs-1', 'AWS::EFS::FileSystem', next, previous)
        .then(
          () => undefined,
          (e: unknown) => e
        );
      // The raw PREFIX and an absent cause: a refusal moved inside the try
      // would be re-wrapped by the provider's error wrapper.
      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as ProvisioningError).message).toMatch(
        /^Failed to update EFS FileSystem L: Throughput value must be specified for provisioned throughput mode\. /
      );
      expect((error as ProvisioningError).cause).toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a state replay warns, sends no throughput and applies the rest', async () => {
      mockSend.mockResolvedValue({});
      const previous = {
        ThroughputMode: 'provisioned',
        ProvisionedThroughputInMibps: 2,
        FileSystemTags: [{ Key: 'ab', Value: 'v1' }],
      };
      const next = {
        ThroughputMode: 'provisioned',
        FileSystemTags: [{ Key: 'ab', Value: 'v2' }],
      };

      await provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', next, previous, {
        replayingState: true,
      });
      expect(updateFileSystemCall()).toBeUndefined();
      expect(mockSend.mock.calls.some((c) => c[0] instanceof TagResourceCommand)).toBe(true);
      expect(providerWarn).toHaveBeenCalledWith(expect.stringMatching(/leaving the file system's throughput as it is on AWS/));
    });

    it('a state replay switching to provisioned with no value sends no mode change', async () => {
      // The API would refuse ThroughputMode: provisioned with no value, so the
      // warn path suppresses the mode switch rather than sending it.
      const previous = { ThroughputMode: 'bursting' };
      const next = { ThroughputMode: 'provisioned' };

      await provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', next, previous, {
        replayingState: true,
      });
      expect(updateFileSystemCall()).toBeUndefined();
      expect(providerWarn).toHaveBeenCalled();
    });

    it('a value-less provisioned record on BOTH sides does not block an unrelated change', async () => {
      // Nothing is sent for the throughput when it does not change, so the
      // refusal is gated on the change (docs/provider-rules.md).
      mockSend.mockResolvedValue({});
      const previous = { ThroughputMode: 'provisioned', FileSystemTags: [{ Key: 'ab', Value: 'v1' }] };
      const next = { ThroughputMode: 'provisioned', FileSystemTags: [{ Key: 'ab', Value: 'v2' }] };

      await provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', next, previous);
      expect(updateFileSystemCall()).toBeUndefined();
      expect(mockSend.mock.calls.some((c) => c[0] instanceof TagResourceCommand)).toBe(true);
    });

    it('removal beside another change is refused before the other change is applied', async () => {
      const previous = {
        ThroughputMode: 'provisioned',
        ProvisionedThroughputInMibps: 2,
        FileSystemTags: [{ Key: 'ab', Value: 'v1' }],
      };
      const next = {
        ThroughputMode: 'provisioned',
        FileSystemTags: [{ Key: 'ab', Value: 'v2' }],
        LifecyclePolicies: [{ TransitionToIA: 'AFTER_30_DAYS' }],
      };

      await expect(
        provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', next, previous)
      ).rejects.toThrow(refusal);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('switching to provisioned without a value is refused too', async () => {
      // Same A/B: a bursting -> provisioned update with no value also fails
      // in CloudFormation (the EFS API answers "Provisioned throughput must
      // be set ...") and rolls back to bursting.
      const previous = { ThroughputMode: 'bursting' };
      const next = { ThroughputMode: 'provisioned' };

      await expect(
        provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', next, previous)
      ).rejects.toThrow(refusal);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a provisioned template that keeps its value is not refused', async () => {
      const previous = { ThroughputMode: 'provisioned', ProvisionedThroughputInMibps: 2 };
      const next = { ThroughputMode: 'provisioned', ProvisionedThroughputInMibps: 2 };

      const result = await provider.update('L', 'fs-1', 'AWS::EFS::FileSystem', next, previous);
      expect(result).toEqual({ physicalId: 'fs-1', wasReplaced: false });
      expect(updateFileSystemCall()).toBeUndefined();
    });
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
