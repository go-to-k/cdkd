import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DeleteFileSystemPolicyCommand,
  PutBackupPolicyCommand,
  PutFileSystemPolicyCommand,
  UpdateFileSystemCommand,
  UpdateFileSystemProtectionCommand,
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
import { prepareRemovalForUpdate } from '../../../src/provisioning/update-removal.js';

/**
 * go-to-k/cdkd#1160 (efs-provider.ts row): removing `BackupPolicy`,
 * `FileSystemPolicy` or `FileSystemProtection` from an `AWS::EFS::FileSystem`
 * template used to send nothing, so automatic backups, the access policy and
 * a disabled replication-overwrite protection outlived the template.
 *
 * Live CFn A/B (us-east-1, 2026-10-28), each property removed ALONE: CFn sent
 * `PutBackupPolicy {Status: DISABLED}`, `DeleteFileSystemPolicy`, and
 * `UpdateFileSystemProtection {ReplicationOverwriteProtection: ENABLED}`.
 * Nothing is kept, so every removal below must send exactly that one call.
 */
const POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Deny',
      Principal: { AWS: '*' },
      Action: '*',
      Condition: { Bool: { 'aws:SecureTransport': 'false' } },
    },
  ],
};

const TAGS = [{ Key: 'Name', Value: 'fs' }];

function commands() {
  return mockSend.mock.calls.map((c) => c[0] as { constructor: { name: string }; input: unknown });
}

function update(previous: Record<string, unknown>, next: Record<string, unknown>) {
  return new EFSProvider().update(
    'Fs',
    'fs-1',
    'AWS::EFS::FileSystem',
    { ...next, FileSystemTags: TAGS },
    { ...previous, FileSystemTags: TAGS }
  );
}

describe('EFSProvider FileSystem control-plane removal resets (#1160)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
  });

  it('a removed BackupPolicy sends PutBackupPolicy DISABLED', async () => {
    await update({ BackupPolicy: { Status: 'ENABLED' } }, {});

    expect(commands()).toHaveLength(1);
    const cmd = commands()[0]!;
    expect(cmd).toBeInstanceOf(PutBackupPolicyCommand);
    expect(cmd.input).toEqual({ FileSystemId: 'fs-1', BackupPolicy: { Status: 'DISABLED' } });
  });

  it('a removed FileSystemPolicy sends DeleteFileSystemPolicy, never a Put', async () => {
    await update({ FileSystemPolicy: POLICY }, {});

    expect(commands()).toHaveLength(1);
    const cmd = commands()[0]!;
    expect(cmd).toBeInstanceOf(DeleteFileSystemPolicyCommand);
    expect(cmd.input).toEqual({ FileSystemId: 'fs-1' });
  });

  it('a removed FileSystemPolicy together with BypassPolicyLockoutSafetyCheck still deletes the policy', async () => {
    await update({ FileSystemPolicy: POLICY, BypassPolicyLockoutSafetyCheck: true }, {});

    expect(commands()).toHaveLength(1);
    expect(commands()[0]).toBeInstanceOf(DeleteFileSystemPolicyCommand);
  });

  it('a removed FileSystemProtection sends UpdateFileSystemProtection ENABLED', async () => {
    await update({ FileSystemProtection: { ReplicationOverwriteProtection: 'DISABLED' } }, {});

    expect(commands()).toHaveLength(1);
    const cmd = commands()[0]!;
    expect(cmd).toBeInstanceOf(UpdateFileSystemProtectionCommand);
    expect(cmd.input).toEqual({ FileSystemId: 'fs-1', ReplicationOverwriteProtection: 'ENABLED' });
  });

  it('all three removed at once send all three resets and nothing else', async () => {
    await update(
      {
        BackupPolicy: { Status: 'ENABLED' },
        FileSystemPolicy: POLICY,
        FileSystemProtection: { ReplicationOverwriteProtection: 'DISABLED' },
      },
      {}
    );

    const names = commands().map((c) => c.constructor.name);
    expect(names.sort()).toEqual(
      [
        'DeleteFileSystemPolicyCommand',
        'PutBackupPolicyCommand',
        'UpdateFileSystemProtectionCommand',
      ].sort()
    );
  });

  it('the deploy caller injects the BackupPolicy / FileSystemProtection resets (removalDefaults) and the provider sends them once', async () => {
    const provider = new EFSProvider();
    const previous = {
      BackupPolicy: { Status: 'ENABLED' },
      FileSystemProtection: { ReplicationOverwriteProtection: 'DISABLED' },
      FileSystemTags: TAGS,
    };
    const prep = prepareRemovalForUpdate(provider, 'AWS::EFS::FileSystem', { FileSystemTags: TAGS }, previous);
    expect([...prep.injected].sort()).toEqual(['BackupPolicy', 'FileSystemProtection']);

    await provider.update('Fs', 'fs-1', 'AWS::EFS::FileSystem', prep.properties, previous, prep.context);

    const backup = commands().filter((c) => c instanceof PutBackupPolicyCommand);
    const protection = commands().filter((c) => c instanceof UpdateFileSystemProtectionCommand);
    expect(backup.map((c) => c.input)).toEqual([
      { FileSystemId: 'fs-1', BackupPolicy: { Status: 'DISABLED' } },
    ]);
    expect(protection.map((c) => c.input)).toEqual([
      { FileSystemId: 'fs-1', ReplicationOverwriteProtection: 'ENABLED' },
    ]);
  });

  describe('negative controls: no removal, no reset', () => {
    it('never-declared properties stay absent (no call)', async () => {
      await update({}, {});
      expect(commands()).toHaveLength(0);
    });

    it('unchanged declared values send nothing', async () => {
      const declared = {
        BackupPolicy: { Status: 'ENABLED' },
        FileSystemPolicy: POLICY,
        FileSystemProtection: { ReplicationOverwriteProtection: 'DISABLED' },
      };
      await update(declared, declared);
      expect(commands()).toHaveLength(0);
    });

    it('a changed FileSystemPolicy is still a Put, not a Delete', async () => {
      const next = { ...POLICY, Statement: [{ ...POLICY.Statement[0], Sid: 'TlsOnly' }] };
      await update({ FileSystemPolicy: POLICY }, { FileSystemPolicy: next });

      expect(commands()).toHaveLength(1);
      const cmd = commands()[0] as unknown as PutFileSystemPolicyCommand;
      expect(cmd).toBeInstanceOf(PutFileSystemPolicyCommand);
      expect(JSON.parse(cmd.input.Policy!)).toEqual(next);
    });

    it('BypassPolicyLockoutSafetyCheck alone, with no policy ever declared, sends nothing', async () => {
      await update({}, { BypassPolicyLockoutSafetyCheck: true });
      expect(commands()).toHaveLength(0);
      await update({ BypassPolicyLockoutSafetyCheck: true }, {});
      expect(commands()).toHaveLength(0);
    });

    it('a policy ADDED to a file system without one is a Put', async () => {
      await update({}, { FileSystemPolicy: POLICY });

      expect(commands()).toHaveLength(1);
      expect(commands()[0]).toBeInstanceOf(PutFileSystemPolicyCommand);
    });

    it('a declared value is forwarded, not replaced by the reset', async () => {
      await update(
        {
          BackupPolicy: { Status: 'DISABLED' },
          FileSystemProtection: { ReplicationOverwriteProtection: 'ENABLED' },
        },
        {
          BackupPolicy: { Status: 'ENABLED' },
          FileSystemProtection: { ReplicationOverwriteProtection: 'DISABLED' },
        }
      );

      const backup = commands().find((c) => c instanceof PutBackupPolicyCommand)!;
      const protection = commands().find((c) => c instanceof UpdateFileSystemProtectionCommand)!;
      expect(backup.input).toEqual({ FileSystemId: 'fs-1', BackupPolicy: { Status: 'ENABLED' } });
      expect(protection.input).toEqual({
        FileSystemId: 'fs-1',
        ReplicationOverwriteProtection: 'DISABLED',
      });
      expect(commands().some((c) => c instanceof UpdateFileSystemCommand)).toBe(false);
    });
  });
});
