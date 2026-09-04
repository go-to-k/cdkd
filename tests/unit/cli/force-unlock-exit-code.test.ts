import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * `cdkd force-unlock` used to report a failed lock delete at ERROR level and
 * still exit 0 (issue go-to-k/cdkd#2575). The per-region `catch` logged and
 * continued with nothing recording that a failure had happened, so a scripted
 * `cdkd force-unlock && cdkd deploy` proceeded against a stack whose lock was
 * still there, and a CI cleanup step recorded an unlock that never occurred.
 *
 * Both arms matter and they are NOT symmetric, which is why each has a case
 * here: "No lock found" is a SUCCESS (the command's job is that no lock
 * remains, and an absent one already satisfies that), while any other delete
 * failure must exit non-zero. A test asserting only the failure arm would pass
 * against a version that failed on both.
 */

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: vi.fn(),
    error: errorSpy,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    listStacks: mockListStacks,
  })),
}));

const mockForceReleaseLock = vi.fn<(stackName: string, region?: string) => Promise<void>>();
const mockGetLockInfo = vi.fn<() => Promise<unknown>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    forceReleaseLock: mockForceReleaseLock,
    getLockInfo: mockGetLockInfo,
  })),
}));

import { createForceUnlockCommand } from '../../../src/cli/commands/force-unlock.js';

/**
 * Runs the command and returns the exit code the CLI would have used.
 *
 * `withErrorHandling` swallows the throw and calls `process.exit`, so the exit
 * code is the only observable the command's contract is written in — asserting
 * `rejects.toThrow` would pass against a version that exited 0.
 */
async function runForceUnlock(args: string[]): Promise<number | undefined> {
  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('__process_exit__');
  }) as never);
  try {
    const cmd = createForceUnlockCommand();
    cmd.exitOverride();
    // Commander's `parseAsync` expects argv WITHOUT the leading subcommand
    // name when the command object is parsed directly.
    await cmd.parseAsync(args, { from: 'user' });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== '__process_exit__') throw error;
  } finally {
    exitSpy.mockRestore();
  }
  return exitCode;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLockInfo.mockResolvedValue(null);
  mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
});

describe('cdkd force-unlock exit code', () => {
  it('exits 0 when the lock was deleted', async () => {
    mockForceReleaseLock.mockResolvedValue(undefined);

    const code = await runForceUnlock(['MyStack', '--state-bucket', 'b']);

    expect(code).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('exits 0 when there was no lock to delete', async () => {
    mockForceReleaseLock.mockRejectedValue(new Error('No lock found for stack MyStack'));

    const code = await runForceUnlock(['MyStack', '--state-bucket', 'b']);

    expect(code).toBeUndefined();
    // The absent-lock arm is an INFO, not an error: nothing failed.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('exits 1 when the delete failed', async () => {
    mockForceReleaseLock.mockRejectedValue(new Error('AccessDenied: not authorized'));

    const code = await runForceUnlock(['MyStack', '--state-bucket', 'b']);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to unlock stack'));
  });

  it('attempts every stack before failing, and names each one that failed', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'First', region: 'us-east-1' },
      { stackName: 'Second', region: 'us-east-1' },
      { stackName: 'Third', region: 'us-east-1' },
    ]);
    mockForceReleaseLock.mockImplementation(async (stackName: string) => {
      if (stackName === 'Second') throw new Error('AccessDenied: not authorized');
    });

    const code = await runForceUnlock(['First', 'Second', 'Third', '--state-bucket', 'b']);

    expect(code).toBe(1);
    // The walk must not abort on the first failure: `Third` comes after
    // `Second` and has to have been attempted.
    expect(mockForceReleaseLock).toHaveBeenCalledTimes(3);
    expect(mockForceReleaseLock).toHaveBeenNthCalledWith(3, 'Third', 'us-east-1');
  });

  it('exits 1 once when one stack fails in several regions', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'MyStack', region: 'us-east-1' },
      { stackName: 'MyStack', region: 'eu-west-1' },
    ]);
    mockForceReleaseLock.mockRejectedValue(new Error('AccessDenied: not authorized'));

    const code = await runForceUnlock(['MyStack', '--state-bucket', 'b']);

    expect(code).toBe(1);
    // Both regions attempted — a failure in the first must not skip the second.
    expect(mockForceReleaseLock).toHaveBeenCalledTimes(2);
  });
});
