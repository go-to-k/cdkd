import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

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
  resolveApp: vi.fn(() => 'fake-app-cmd'),
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

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

const mockListStacks = vi.fn<() => Promise<{ stackName: string; region?: string }[]>>();
const mockGetState =
  vi.fn<(stackName: string, region?: string) => Promise<{ state: StackState; etag: string } | null>>();
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

// Spy on the per-stack runner so we can verify which stacks are dispatched.
const mockRunDestroyForStack = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/commands/destroy-runner.js', () => ({
  runDestroyForStack: mockRunDestroyForStack,
}));

// Mock the synthesizer so we can return arbitrary StackInfo[] (including
// with terminationProtection set on individual stacks).
const mockSynthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: mockSynthesize,
  })),
}));

import { createDestroyCommand } from '../../../src/cli/commands/destroy.js';

function makeStackState(stackName: string, region = 'us-east-1'): StackState {
  return {
    version: 1,
    stackName,
    region,
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

function makeStackInfo(
  stackName: string,
  region = 'us-east-1',
  terminationProtection?: boolean
): StackInfo {
  return {
    stackName,
    displayName: stackName,
    artifactId: stackName,
    template: { Resources: {} },
    dependencyNames: [],
    region,
    ...(terminationProtection !== undefined && { terminationProtection }),
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

async function runDestroy(args: string[]): Promise<string> {
  const cap = captureStdout();
  try {
    const cmd = createDestroyCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  } finally {
    cap.restore();
  }
  return cap.output.join('');
}

describe('cdkd destroy: terminationProtection guard', () => {
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
    mockSynthesize.mockReset();
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

  it('refuses to destroy a single protected stack and exits with code 2', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Protected', 'us-east-1', true)],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Protected', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({ state: makeStackState('Protected'), etag: '"x"' });

    await expect(runDestroy(['destroy', 'Protected', '--yes'])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);

    // Per-stack guard fires BEFORE the runner is invoked.
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();

    // The error message names the stack and the bypass workflow.
    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toMatch(/Protected/);
    expect(messages).toMatch(/terminationProtection: false/);
    expect(messages).toMatch(/redeploy/);
  });

  it('proceeds to destroy when terminationProtection is absent or false', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      // First case: undefined (typical CDK default).
      // Second case: explicitly false.
      stacks: [
        makeStackInfo('Plain', 'us-east-1'),
        makeStackInfo('Unguarded', 'us-east-1', false),
      ],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Plain', region: 'us-east-1' },
      { stackName: 'Unguarded', region: 'us-east-1' },
    ]);
    mockGetState.mockImplementation(async (name: string) => ({
      state: makeStackState(name),
      etag: '"x"',
    }));

    await runDestroy(['destroy', '--all', '--yes']);

    // Both stacks flow through the runner — guard does not fire.
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(2);
    const dispatched = new Set(
      mockRunDestroyForStack.mock.calls.map((c) => c[0] as string)
    );
    expect(dispatched).toEqual(new Set(['Plain', 'Unguarded']));
    // No partial-failure exit on the happy path.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('--remove-protection bypasses terminationProtection guard with a WARN log and dispatches the runner', async () => {
    const warnSpy = vi.fn();
    // The destroy command logs the bypass at WARN level via the shared
    // logger. Spy on logger.warn for this test.
    const loggerModule = await import('../../../src/utils/logger.js');
    vi.spyOn(loggerModule, 'getLogger').mockReturnValue({
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
    } as unknown as ReturnType<typeof loggerModule.getLogger>);

    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [makeStackInfo('Protected', 'us-east-1', true)],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'Protected', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({ state: makeStackState('Protected'), etag: '"x"' });

    await runDestroy(['destroy', 'Protected', '--yes', '--remove-protection']);

    // The runner runs (bypass) and the runner gets removeProtection=true.
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[2].removeProtection).toBe(true);

    // No exit-2 on the bypass path.
    expect(exitSpy).not.toHaveBeenCalled();

    // The bypass is announced via WARN so it shows in CI logs.
    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(warnMessages).toMatch(/Protected/);
    expect(warnMessages).toMatch(/--remove-protection/);
  });

  it('--all with one protected + one unprotected: unprotected destroys, protected counts as failure (exit 2)', async () => {
    mockSynthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [
        makeStackInfo('Protected', 'us-east-1', true),
        makeStackInfo('Plain', 'us-east-1'),
      ],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'Protected', region: 'us-east-1' },
      { stackName: 'Plain', region: 'us-east-1' },
    ]);
    mockGetState.mockImplementation(async (name: string) => ({
      state: makeStackState(name),
      etag: '"x"',
    }));

    await expect(runDestroy(['destroy', '--all', '--yes'])).rejects.toThrow();

    // Unprotected stack went through the runner; protected one did not.
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('Plain');

    // PartialFailureError aggregates the protected stack into the failure count.
    expect(exitSpy).toHaveBeenCalledWith(2);
    const messages = errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(messages).toMatch(/Protected/);
    expect(messages).toMatch(/1 resource error/);
  });
});
