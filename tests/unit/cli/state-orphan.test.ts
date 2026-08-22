import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const errorSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

vi.mock('../../../src/utils/aws-clients.ts', () => {
  return {
    AwsClients: vi.fn().mockImplementation(() => ({
      get s3() {
        return {};
      },
      destroy: vi.fn(),
    })),
    setAwsClients: vi.fn(),
    getAwsClients: vi.fn(),
  };
});

const mockStateExists = vi.fn<(stackName: string, region: string) => Promise<boolean>>();
const mockDeleteState = vi.fn<(stackName: string, region: string) => Promise<void>>();
const mockListStacks =
  vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    stateExists: mockStateExists,
    deleteState: mockDeleteState,
    listStacks: mockListStacks,
    verifyBucketExists: mockVerifyBucketExists,
  })),
}));

const mockIsLocked = vi.fn<(stackName: string, region?: string) => Promise<boolean>>();
const mockForceReleaseLock = vi.fn<(stackName: string, region?: string) => Promise<void>>();
// Issue #2171: the force-release below is unconditional by design, so the only
// useful signal is naming the owner at the moment it destroys a LIVE lock.
const mockGetLockInfo = vi.fn<(stackName: string, region?: string) => Promise<unknown>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    isLocked: mockIsLocked,
    forceReleaseLock: mockForceReleaseLock,
    getLockInfo: mockGetLockInfo,
  })),
}));

// Mock readline so the confirmation prompt is fully scriptable in tests.
const readlineQuestion = vi.hoisted(() => vi.fn<(prompt: string) => Promise<string>>());
const readlineClose = vi.hoisted(() => vi.fn());
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: readlineQuestion,
    close: readlineClose,
  })),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';

function captureStdout(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  return {
    output,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

async function runStateOrphan(args: string[]): Promise<string> {
  const cap = captureStdout();
  try {
    const stateCmd = createStateCommand();
    stateCmd.exitOverride();
    stateCmd.commands.forEach((sub) => sub.exitOverride());
    await stateCmd.parseAsync(args, { from: 'user' });
  } finally {
    cap.restore();
  }
  return cap.output.join('');
}

describe('cdkd state orphan', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockStateExists.mockReset();
    mockDeleteState.mockReset();
    mockDeleteState.mockResolvedValue();
    mockListStacks.mockReset();
    mockIsLocked.mockReset();
    warnSpy.mockReset();
    mockGetLockInfo.mockReset();
    mockGetLockInfo.mockResolvedValue(null);
    mockForceReleaseLock.mockReset();
    mockForceReleaseLock.mockResolvedValue();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockResolvedValue();
    readlineQuestion.mockReset();
    readlineClose.mockReset();
    errorSpy.mockReset();
    infoSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('skips a stack whose state does not exist (idempotent)', async () => {
    // listStacks does not include the requested stack — `state orphan` skips
    // (no error: idempotent).
    mockListStacks.mockResolvedValue([]);

    await runStateOrphan(['orphan', 'Missing', '--yes']);

    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(mockForceReleaseLock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/No state found for stack: Missing/));
  });

  it('removes state.json AND lock.json when --yes skips the prompt', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(false);

    await runStateOrphan(['orphan', 'MyStack', '--yes']);

    expect(readlineQuestion).not.toHaveBeenCalled();
    expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-east-1');
    expect(mockForceReleaseLock).toHaveBeenCalledWith('MyStack', 'us-east-1');
  });

  it('removes both regions when a stack has state in multiple regions (no --stack-region)', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'MyStack', region: 'us-east-1' },
      { stackName: 'MyStack', region: 'us-west-2' },
    ]);
    mockIsLocked.mockResolvedValue(false);

    await runStateOrphan(['orphan', 'MyStack', '--yes']);

    expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-east-1');
    expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-west-2');
    expect(mockForceReleaseLock).toHaveBeenCalledWith('MyStack', 'us-east-1');
    expect(mockForceReleaseLock).toHaveBeenCalledWith('MyStack', 'us-west-2');
  });

  it('scopes removal with --stack-region <region>', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'MyStack', region: 'us-east-1' },
      { stackName: 'MyStack', region: 'us-west-2' },
    ]);
    mockIsLocked.mockResolvedValue(false);

    await runStateOrphan(['orphan', 'MyStack', '--yes', '--stack-region', 'us-east-1']);

    expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-east-1');
    expect(mockDeleteState).not.toHaveBeenCalledWith('MyStack', 'us-west-2');
  });

  it('refuses to remove a locked stack without --force', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'LockedStack', region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(true);

    await expect(runStateOrphan(['orphan', 'LockedStack', '--yes'])).rejects.toThrow();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/Stack 'LockedStack' \(us-east-1\) is locked/);
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('removes a locked stack when --force is set (and skips lock check)', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'LockedStack', region: 'us-east-1' }]);

    await runStateOrphan(['orphan', 'LockedStack', '--force']);

    // --force bypasses both the lock check and the prompt.
    expect(mockIsLocked).not.toHaveBeenCalled();
    expect(readlineQuestion).not.toHaveBeenCalled();
    expect(mockDeleteState).toHaveBeenCalledWith('LockedStack', 'us-east-1');
    expect(mockForceReleaseLock).toHaveBeenCalledWith('LockedStack', 'us-east-1');
  });

  it('prompts and deletes when the user answers `y`', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValue('y');

    const out = await runStateOrphan(['orphan', 'MyStack']);

    expect(readlineQuestion).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/AWS resources will NOT be deleted/);
    expect(out).toMatch(/Use 'cdkd destroy MyStack'/);
    expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-east-1');
  });

  it('prompts and cancels when the user answers `n` (or empty)', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValue('');

    await runStateOrphan(['orphan', 'MyStack']);

    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(mockForceReleaseLock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Cancelled removal of state for stack: MyStack/)
    );
  });

  it('accepts `yes` (full word) as confirmation, case-insensitively', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValue('YES');

    await runStateOrphan(['orphan', 'MyStack']);

    expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-east-1');
  });

  it('iterates over multiple stacks, each with its own confirmation', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'A', region: 'us-east-1' },
      { stackName: 'B', region: 'us-east-1' },
    ]);
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValueOnce('y').mockResolvedValueOnce('n');

    await runStateOrphan(['orphan', 'A', 'B']);

    expect(readlineQuestion).toHaveBeenCalledTimes(2);
    expect(mockDeleteState).toHaveBeenCalledWith('A', 'us-east-1');
    expect(mockDeleteState).not.toHaveBeenCalledWith('B', 'us-east-1');
    expect(mockForceReleaseLock).toHaveBeenCalledWith('A', 'us-east-1');
    expect(mockForceReleaseLock).not.toHaveBeenCalledWith('B', 'us-east-1');
  });

  describe('live-lock warning before the force-release (issue #2171)', () => {
    // `forceReleaseLock` takes no lock of its own and deletes whatever is
    // there, including an in-flight deploy's. That is deliberate — a stuck
    // lock must not make a state record unremovable — but it was SILENT, and
    // the write it enables has already happened by the time anyone notices.
    it('names the owner and operation when the lock it destroys is still live', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
      mockIsLocked.mockResolvedValue(false);
      mockGetLockInfo.mockResolvedValue({
        owner: 'alice@host:4242',
        operation: 'deploy',
        expiresAt: Date.now() + 15 * 60_000,
      });

      await runStateOrphan(['orphan', 'MyStack', '--yes']);

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toMatch(/Force-releasing a LIVE lock/);
      expect(warned).toContain('alice@host:4242');
      expect(warned).toContain('operation: deploy');
      // The removal the user asked for still happens — this is a warning, not
      // a refusal.
      expect(mockForceReleaseLock).toHaveBeenCalledWith('MyStack', 'us-east-1');
      expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-east-1');
    });

    it('stays quiet for an EXPIRED lock', async () => {
      // An expired lock is exactly what force-unlock exists for; warning about
      // it would train the user to ignore the line that matters.
      mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
      mockIsLocked.mockResolvedValue(false);
      mockGetLockInfo.mockResolvedValue({ owner: 'bob@host:1', expiresAt: Date.now() - 60_000 });

      await runStateOrphan(['orphan', 'MyStack', '--yes']);

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).not.toMatch(/Force-releasing a LIVE lock/);
      expect(mockForceReleaseLock).toHaveBeenCalledWith('MyStack', 'us-east-1');
    });

    it('stays quiet when there is no lock at all', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
      mockIsLocked.mockResolvedValue(false);
      mockGetLockInfo.mockResolvedValue(null);

      await runStateOrphan(['orphan', 'MyStack', '--yes']);

      expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(
        /Force-releasing a LIVE lock/
      );
    });

    it('never blocks the removal on a failing lock read', async () => {
      // Best-effort in both directions: the user asked for the record to go.
      mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
      mockIsLocked.mockResolvedValue(false);
      mockGetLockInfo.mockRejectedValue(new Error('AccessDenied'));

      await runStateOrphan(['orphan', 'MyStack', '--yes']);

      expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-east-1');
      expect(mockForceReleaseLock).toHaveBeenCalledWith('MyStack', 'us-east-1');
    });
  });
});
