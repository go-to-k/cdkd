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

const mockStateExists = vi.fn<(stackName: string) => Promise<boolean>>();
const mockDeleteState = vi.fn<(stackName: string) => Promise<void>>();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    stateExists: mockStateExists,
    deleteState: mockDeleteState,
    verifyBucketExists: mockVerifyBucketExists,
  })),
}));

const mockIsLocked = vi.fn<(stackName: string) => Promise<boolean>>();
const mockForceReleaseLock = vi.fn<(stackName: string) => Promise<void>>();
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
    mockStateExists.mockResolvedValue(false);

    await runStateRm(['rm', 'Missing', '--yes']);

    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(mockForceReleaseLock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/No state found for stack: Missing/));
  });

  it('removes state.json AND lock.json when --yes skips the prompt', async () => {
    mockStateExists.mockResolvedValue(true);
    mockIsLocked.mockResolvedValue(false);

    await runStateRm(['rm', 'MyStack', '--yes']);

    expect(readlineQuestion).not.toHaveBeenCalled();
    expect(mockDeleteState).toHaveBeenCalledWith('MyStack');
    expect(mockForceReleaseLock).toHaveBeenCalledWith('MyStack');
  });

  it('refuses to remove a locked stack without --force', async () => {
    mockStateExists.mockResolvedValue(true);
    mockIsLocked.mockResolvedValue(true);

    await expect(runStateRm(['rm', 'LockedStack', '--yes'])).rejects.toThrow();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/Stack 'LockedStack' is locked/);
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('removes a locked stack when --force is set (and skips lock check)', async () => {
    mockStateExists.mockResolvedValue(true);

    await runStateRm(['rm', 'LockedStack', '--force']);

    // --force bypasses both the lock check and the prompt.
    expect(mockIsLocked).not.toHaveBeenCalled();
    expect(readlineQuestion).not.toHaveBeenCalled();
    expect(mockDeleteState).toHaveBeenCalledWith('LockedStack');
    expect(mockForceReleaseLock).toHaveBeenCalledWith('LockedStack');
  });

  it('prompts and deletes when the user answers `y`', async () => {
    mockStateExists.mockResolvedValue(true);
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValue('y');

    const out = await runStateRm(['rm', 'MyStack']);

    expect(readlineQuestion).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/AWS resources will NOT be deleted/);
    expect(out).toMatch(/Use 'cdkd destroy MyStack'/);
    expect(mockDeleteState).toHaveBeenCalledWith('MyStack');
  });

  it('prompts and cancels when the user answers `n` (or empty)', async () => {
    mockStateExists.mockResolvedValue(true);
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
    mockStateExists.mockResolvedValue(true);
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValue('YES');

    await runStateRm(['rm', 'MyStack']);

    expect(mockDeleteState).toHaveBeenCalledWith('MyStack');
  });

  it('iterates over multiple stacks, each with its own confirmation', async () => {
    mockStateExists.mockResolvedValue(true);
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValueOnce('y').mockResolvedValueOnce('n');

    await runStateRm(['rm', 'A', 'B']);

    expect(readlineQuestion).toHaveBeenCalledTimes(2);
    expect(mockDeleteState).toHaveBeenCalledWith('A');
    expect(mockDeleteState).not.toHaveBeenCalledWith('B');
    expect(mockForceReleaseLock).toHaveBeenCalledWith('A');
    expect(mockForceReleaseLock).not.toHaveBeenCalledWith('B');
  });
});
