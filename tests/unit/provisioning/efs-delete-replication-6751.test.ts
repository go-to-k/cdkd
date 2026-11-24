import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DeleteFileSystemCommand,
  DeleteReplicationConfigurationCommand,
  DescribeReplicationConfigurationsCommand,
  FileSystemInUse,
} from '@aws-sdk/client-efs';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-efs', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-efs')>(
    '@aws-sdk/client-efs'
  );
  return {
    ...actual,
    EFSClient: vi.fn(() => ({
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
    child: vi.fn(function (this: unknown) { return this; }),
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

const interrupt = vi.hoisted(() => ({ afterChecks: Infinity, checks: 0 }));
vi.mock('../../../src/provisioning/interrupt-watch.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/provisioning/interrupt-watch.js')>(
    '../../../src/provisioning/interrupt-watch.js'
  );
  return {
    ...actual,
    // A watch that reports a Ctrl-C once it has been asked `afterChecks` times.
    startInterruptWatch: (what: string) => ({
      isInterrupted: () => ++interrupt.checks > interrupt.afterChecks,
      onInterrupted: () => new actual.InterruptedWaitError(what),
      dispose: () => {},
    }),
  };
});

const deadline = vi.hoisted(() => ({ expiredAfterChecks: Infinity, checks: 0 }));
vi.mock('../../../src/deployment/resource-deadline.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/deployment/resource-deadline.js')>(
    '../../../src/deployment/resource-deadline.js'
  );
  return {
    ...actual,
    // A deadline that has expired once it has been asked `expiredAfterChecks` times.
    enclosingDeadlineExpired: () => ++deadline.checks > deadline.expiredAfterChecks,
  };
});

import { EFSProvider } from '../../../src/provisioning/providers/efs-provider.js';
import { REPLICATION_TEARDOWN_WAIT } from '../../../src/provisioning/providers/efs/file-system.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';
import { isInterruptedWaitError } from '../../../src/provisioning/interrupt-watch.js';

/**
 * go-to-k/cdkd#6751: DeleteFileSystem refuses a replication SOURCE with
 * `FileSystemInUse` ("You cannot delete file system '...' because it is in a
 * replication. You must first delete the replication configuration ..."),
 * and keeps refusing until the deleted configuration finishes tearing down.
 * Live probe (us-east-1, 2026-11-21): CloudFormation's handler sent
 * DeleteReplicationConfiguration, polled DescribeReplicationConfigurations
 * until ReplicationNotFound, then DeleteFileSystem.
 */
const FS = 'fs-0123456789abcdef0';
const OTHER = 'fs-0fedcba9876543210';

const inReplication = (): FileSystemInUse =>
  new FileSystemInUse({
    $metadata: {},
    message: `You cannot delete file system '${FS}' because it is in a replication. You must first delete the replication configuration for the file system before attempting to delete it.`,
    ErrorCode: 'FileSystemInUse',
  });

const names = (): string[] => mockSend.mock.calls.map(([cmd]) => cmd.constructor.name);

describe('EFS FileSystem delete with a replication configuration (#6751)', () => {
  const saved = { ...REPLICATION_TEARDOWN_WAIT };
  beforeEach(() => {
    mockSend.mockReset();
    interrupt.afterChecks = Infinity;
    interrupt.checks = 0;
    deadline.expiredAfterChecks = Infinity;
    deadline.checks = 0;
    REPLICATION_TEARDOWN_WAIT.intervalMs = 0;
    REPLICATION_TEARDOWN_WAIT.attempts = 3;
  });
  afterEach(() => {
    Object.assign(REPLICATION_TEARDOWN_WAIT, saved);
  });

  it('deletes its own replication configuration after a FileSystemInUse refusal, waits for the teardown, then deletes', async () => {
    mockSend
      .mockRejectedValueOnce(inReplication()) // first DeleteFileSystem
      .mockResolvedValueOnce({ Replications: [{ SourceFileSystemId: FS, Destinations: [{ FileSystemId: OTHER }] }] })
      .mockResolvedValueOnce({}) // DeleteReplicationConfiguration
      .mockRejectedValueOnce(inReplication()) // teardown still running
      .mockResolvedValueOnce({}); // DeleteFileSystem

    await new EFSProvider().delete('Fs', FS, 'AWS::EFS::FileSystem');

    expect(names()).toEqual([
      'DeleteFileSystemCommand',
      'DescribeReplicationConfigurationsCommand',
      'DeleteReplicationConfigurationCommand',
      'DeleteFileSystemCommand',
      'DeleteFileSystemCommand',
    ]);
    expect(mockSend.mock.calls[1][0].input).toEqual({ FileSystemId: FS });
    expect(mockSend.mock.calls[2][0].input).toEqual({ SourceFileSystemId: FS });
  });

  it('only waits, without a second DeleteReplicationConfiguration, when the configuration is already deleting', async () => {
    mockSend
      .mockRejectedValueOnce(inReplication())
      .mockResolvedValueOnce({
        Replications: [{ SourceFileSystemId: FS, Destinations: [{ FileSystemId: OTHER, Status: 'DELETING' }] }],
      })
      .mockResolvedValueOnce({});

    await new EFSProvider().delete('Fs', FS, 'AWS::EFS::FileSystem');

    expect(names()).toEqual([
      'DeleteFileSystemCommand',
      'DescribeReplicationConfigurationsCommand',
      'DeleteFileSystemCommand',
    ]);
  });

  it('stops the teardown wait on a Ctrl-C, sending no further DeleteFileSystem, and marks the delete started', async () => {
    interrupt.afterChecks = 1; // the second check, before the second retry, sees the Ctrl-C
    mockSend
      .mockRejectedValueOnce(inReplication())
      .mockResolvedValueOnce({ Replications: [{ SourceFileSystemId: FS }] })
      .mockResolvedValueOnce({}) // DeleteReplicationConfiguration
      .mockRejectedValueOnce(inReplication()) // first retry: still tearing down
      .mockResolvedValue({});

    const error = await new EFSProvider().delete('Fs', FS, 'AWS::EFS::FileSystem').catch((e: unknown) => e);

    expect(isInterruptedWaitError(error)).toBe(true);
    expect(isDeleteStarted(error)).toBe(true);
    expect(names().filter((n) => n === 'DeleteFileSystemCommand')).toHaveLength(2);
  });

  it('sends no further DeleteFileSystem once the enclosing resource deadline has expired', async () => {
    // Checks 1-2 are the first retry's (before its sleep and before its send);
    // the third, before the second retry, sees the deadline expired.
    deadline.expiredAfterChecks = 2;
    mockSend
      .mockRejectedValueOnce(inReplication())
      .mockResolvedValueOnce({ Replications: [{ SourceFileSystemId: FS }] })
      .mockResolvedValueOnce({}) // DeleteReplicationConfiguration
      .mockRejectedValueOnce(inReplication()) // first retry: still tearing down
      .mockResolvedValue({});

    const error = await new EFSProvider().delete('Fs', FS, 'AWS::EFS::FileSystem').catch((e: unknown) => e);

    expect(String(error)).toContain('its replication configuration was deleted, and the teardown had not finished');
    expect(isDeleteStarted(error)).toBe(true);
    expect(names().filter((n) => n === 'DeleteFileSystemCommand')).toHaveLength(2);
  });

  it('sends only DeleteFileSystem when it is not refused', async () => {
    mockSend.mockResolvedValueOnce({});
    await new EFSProvider().delete('Fs', FS, 'AWS::EFS::FileSystem');
    expect(names()).toEqual(['DeleteFileSystemCommand']);
  });

  it('leaves the replication of a file system that is only a destination, and keeps the refusal unmarked', async () => {
    mockSend
      .mockRejectedValueOnce(inReplication())
      .mockResolvedValueOnce({ Replications: [{ SourceFileSystemId: OTHER, Destinations: [{ FileSystemId: FS }] }] });

    const error = await new EFSProvider().delete('Fs', FS, 'AWS::EFS::FileSystem').catch((e: unknown) => e);

    expect((error as { cause?: { message?: string } }).cause?.message).toContain('because it is in a replication');
    expect(isDeleteStarted(error)).toBe(false);
    expect(names()).not.toContain('DeleteReplicationConfigurationCommand');
  });

  it('reads no replication for a FileSystemInUse refusal over something else', async () => {
    mockSend.mockRejectedValueOnce(
      new FileSystemInUse({ $metadata: {}, message: 'File system has mount targets.', ErrorCode: 'FileSystemInUse' })
    );
    const error = await new EFSProvider().delete('Fs', FS, 'AWS::EFS::FileSystem').catch((e: unknown) => e);
    expect((error as { cause?: { message?: string } }).cause?.message).toBe('File system has mount targets.');
    expect(names()).toEqual(['DeleteFileSystemCommand']);
  });

  it('marks the delete started and names the unfinished teardown when the wait runs out', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DescribeReplicationConfigurationsCommand) return { Replications: [{ SourceFileSystemId: FS }] };
      if (cmd instanceof DeleteReplicationConfigurationCommand) return {};
      if (cmd instanceof DeleteFileSystemCommand) throw inReplication();
      return {};
    });

    const error = await new EFSProvider().delete('Fs', FS, 'AWS::EFS::FileSystem').catch((e: unknown) => e);

    expect(String(error)).toContain('its replication configuration was deleted, and the teardown had not finished');
    expect(isDeleteStarted(error)).toBe(true);
    // The first refusal plus REPLICATION_TEARDOWN_WAIT.attempts retries.
    expect(names().filter((n) => n === 'DeleteFileSystemCommand')).toHaveLength(4);
  });
});
