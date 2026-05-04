import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StackState } from '../../../src/types/state.js';

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

const mockListStacks = vi.fn<() => Promise<string[]>>();
const mockGetState = vi.fn<(stackName: string) => Promise<{ state: StackState; etag: string } | null>>();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    listStacks: mockListStacks,
    getState: mockGetState,
    verifyBucketExists: mockVerifyBucketExists,
  })),
}));

vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
  })),
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    setCustomResourceResponseBucket: vi.fn(),
    getProvider: vi.fn(),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

// Replace the destroy-runner with a spy — we want to verify wiring (which
// stacks are dispatched, with which `skipConfirmation`), not re-test the
// runner itself (covered separately).
const mockRunDestroyForStack = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/commands/destroy-runner.js', () => ({
  runDestroyForStack: mockRunDestroyForStack,
}));

// Mock readline so the --all confirmation prompt is fully scriptable.
const readlineQuestion = vi.hoisted(() => vi.fn<(prompt: string) => Promise<string>>());
const readlineClose = vi.hoisted(() => vi.fn());
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: readlineQuestion,
    close: readlineClose,
  })),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';

function makeStackState(stackName: string, region?: string): StackState {
  return {
    version: 1,
    stackName,
    ...(region && { region }),
    resources: {
      Bucket: {
        physicalId: `${stackName.toLowerCase()}-bucket`,
        resourceType: 'AWS::S3::Bucket',
        properties: {},
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

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

async function runStateDestroy(args: string[]): Promise<string> {
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

describe('cdkd state destroy', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockListStacks.mockReset();
    mockGetState.mockReset();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockResolvedValue();
    mockRunDestroyForStack.mockReset();
    mockRunDestroyForStack.mockResolvedValue({
      stackName: '',
      cancelled: false,
      skippedEmpty: false,
      deletedCount: 1,
      errorCount: 0,
    });
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

  it('rejects when neither stack name nor --all is given', async () => {
    mockListStacks.mockResolvedValue([]);

    await expect(runStateDestroy(['destroy', '--yes'])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/Stack name is required/);
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
  });

  it('errors when a named stack has no state record', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Other', region: 'us-east-1' }]);

    await expect(runStateDestroy(['destroy', 'Missing', '--yes'])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/No state found for stack\(s\): Missing/);
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
  });

  it('passes --yes through to the runner so per-stack prompt is skipped', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: makeStackState('MyStack', 'us-east-1'),
      etag: '"abc"',
    });

    await runStateDestroy(['destroy', 'MyStack', '--yes']);

    expect(readlineQuestion).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    const callArgs = mockRunDestroyForStack.mock.calls[0];
    expect(callArgs?.[0]).toBe('MyStack');
    expect(callArgs?.[2].skipConfirmation).toBe(true);
  });

  it('--all prompts once for the batch and dispatches every stack', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'B', region: 'us-east-1' },
      { stackName: 'A', region: 'us-east-1' },
    ]);
    mockGetState.mockImplementation(async (name: string) => ({
      state: makeStackState(name, 'us-east-1'),
      etag: '"x"',
    }));
    readlineQuestion.mockResolvedValue('y');

    await runStateDestroy(['destroy', '--all']);

    // Single batch prompt regardless of stack count.
    expect(readlineQuestion).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(2);
    // Listed in sorted order.
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('A');
    expect(mockRunDestroyForStack.mock.calls[1]?.[0]).toBe('B');
    // --all implies skipConfirmation downstream (the user already accepted
    // the batch prompt).
    expect(mockRunDestroyForStack.mock.calls[0]?.[2].skipConfirmation).toBe(true);
  });

  it('--all + user declines the batch prompt: nothing dispatched', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'A', region: 'us-east-1' }]);
    readlineQuestion.mockResolvedValue('n');

    await runStateDestroy(['destroy', '--all']);

    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith('Destroy cancelled');
  });

  it('--all -y skips the batch prompt entirely', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'A', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({ state: makeStackState('A', 'us-east-1'), etag: '"x"' });

    await runStateDestroy(['destroy', '--all', '-y']);

    expect(readlineQuestion).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
  });

  it('--stack-region filter skips a stack whose state.region disagrees', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'EuStack', region: 'eu-west-1' },
      { stackName: 'UsStack', region: 'us-east-1' },
    ]);
    mockGetState.mockImplementation(async (name: string) => {
      if (name === 'EuStack') return { state: makeStackState('EuStack', 'eu-west-1'), etag: '"x"' };
      return { state: makeStackState('UsStack', 'us-east-1'), etag: '"x"' };
    });

    await runStateDestroy([
      'destroy',
      'EuStack',
      'UsStack',
      '--stack-region',
      'us-east-1',
      '--yes',
    ]);

    // EuStack should be filtered out by --stack-region; UsStack should run.
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('UsStack');
  });

  it('--stack-region tolerates state without a region tag (legacy layout)', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Legacy', region: undefined }]);
    mockGetState.mockResolvedValue({ state: makeStackState('Legacy'), etag: '"x"' });

    await runStateDestroy(['destroy', 'Legacy', '--stack-region', 'us-east-1', '--yes']);

    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
  });

  it('exits with code 2 (PartialFailureError) when the runner reports per-resource errors', async () => {
    // Partial failure: state.json was preserved, the user can re-run.
    // Distinct exit code so CI / bench scripts can tell this apart from
    // a true command crash (which exits 1). See PartialFailureError in
    // src/utils/error-handler.ts.
    mockListStacks.mockResolvedValue([{ stackName: 'Bad', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({ state: makeStackState('Bad', 'us-east-1'), etag: '"x"' });
    mockRunDestroyForStack.mockResolvedValueOnce({
      stackName: 'Bad',
      cancelled: false,
      skippedEmpty: false,
      deletedCount: 0,
      errorCount: 2,
    });

    await expect(runStateDestroy(['destroy', 'Bad', '--yes'])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/2 resource error\(s\).*State preserved/);
  });

  it('iterates over multiple positional stack names in order', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'A', region: 'us-east-1' },
      { stackName: 'B', region: 'us-east-1' },
      { stackName: 'C', region: 'us-east-1' },
    ]);
    mockGetState.mockImplementation(async (name: string) => ({
      state: makeStackState(name, 'us-east-1'),
      etag: '"x"',
    }));

    await runStateDestroy(['destroy', 'A', 'B', '--yes']);

    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(2);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('A');
    expect(mockRunDestroyForStack.mock.calls[1]?.[0]).toBe('B');
  });
});
