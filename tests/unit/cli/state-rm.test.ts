import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: vi.fn(),
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
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    isLocked: mockIsLocked,
    forceReleaseLock: mockForceReleaseLock,
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

async function runStateRm(args: string[]): Promise<string> {
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

describe('cdkd state rm', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockStateExists.mockReset();
    mockDeleteState.mockReset();
    mockDeleteState.mockResolvedValue();
    mockListStacks.mockReset();
    mockIsLocked.mockReset();
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
    // listStacks does not include the requested stack — `state rm` skips
    // (no error: idempotent).
    mockListStacks.mockResolvedValue([]);

    await runStateRm(['rm', 'Missing', '--yes']);

    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(mockForceReleaseLock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/No state found for stack: Missing/));
  });

  it('removes state.json AND lock.json when --yes skips the prompt', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(false);

    await runStateRm(['rm', 'MyStack', '--yes']);

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

    await runStateRm(['rm', 'MyStack', '--yes']);

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

    await runStateRm(['rm', 'MyStack', '--yes', '--stack-region', 'us-east-1']);

    expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-east-1');
    expect(mockDeleteState).not.toHaveBeenCalledWith('MyStack', 'us-west-2');
  });

  it('refuses to remove a locked stack without --force', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'LockedStack', region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(true);

    await expect(runStateRm(['rm', 'LockedStack', '--yes'])).rejects.toThrow();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/Stack 'LockedStack' \(us-east-1\) is locked/);
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('removes a locked stack when --force is set (and skips lock check)', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'LockedStack', region: 'us-east-1' }]);

    await runStateRm(['rm', 'LockedStack', '--force']);

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

    const out = await runStateRm(['rm', 'MyStack']);

    expect(readlineQuestion).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/AWS resources will NOT be deleted/);
    expect(out).toMatch(/Use 'cdkd destroy MyStack'/);
    expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-east-1');
  });

  it('prompts and cancels when the user answers `n` (or empty)', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValue('');

    await runStateRm(['rm', 'MyStack']);

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

    await runStateRm(['rm', 'MyStack']);

    expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-east-1');
  });

  it('iterates over multiple stacks, each with its own confirmation', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'A', region: 'us-east-1' },
      { stackName: 'B', region: 'us-east-1' },
    ]);
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValueOnce('y').mockResolvedValueOnce('n');

    await runStateRm(['rm', 'A', 'B']);

    expect(readlineQuestion).toHaveBeenCalledTimes(2);
    expect(mockDeleteState).toHaveBeenCalledWith('A', 'us-east-1');
    expect(mockDeleteState).not.toHaveBeenCalledWith('B', 'us-east-1');
    expect(mockForceReleaseLock).toHaveBeenCalledWith('A', 'us-east-1');
    expect(mockForceReleaseLock).not.toHaveBeenCalledWith('B', 'us-east-1');
  });
});
