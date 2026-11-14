import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6246: `cdkd destroy` under `--aws-emulator` that read no app
 * (the synthesis failed, so it falls back to the state's stack list) checks
 * every target before the first one is touched, as `cdkd state destroy` does
 * (`state-destroy.test.ts`).
 */

vi.mock('../../../src/utils/logger.js', () => {
  const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    getLogger: () => ({
      setLevel: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => quiet,
    }),
  };
});
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveApp: vi.fn(() => 'fake-app-cmd'),
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
vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));
const mockListStacks = vi.hoisted(() => vi.fn());
const mockGetState = vi.hoisted(() => vi.fn());
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    listStacks: mockListStacks,
    getState: mockGetState,
    verifyBucketExists: vi.fn(async () => undefined),
  })),
}));
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn().mockResolvedValue(true),
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
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
const mockRunDestroyForStack = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/commands/destroy-runner.js', () => ({
  runDestroyForStack: mockRunDestroyForStack,
}));
vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: vi.fn(() => ({ record: vi.fn(), finalize: vi.fn(async () => {}) })),
  recordRunFailed: vi.fn(),
  recordRunOutcome: vi.fn(),
}));
const mockSynthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({ synthesize: mockSynthesize })),
}));
vi.mock('../../../src/utils/error-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/error-handler.js')>();
  return {
    ...actual,
    withErrorHandling: <Args extends unknown[]>(fn: (...args: Args) => Promise<void> | void) => fn,
  };
});
const wiring = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('cdk-local/internal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveWorkloadAwsWiring: () => wiring.value,
}));

import { createDestroyCommand } from '../../../src/cli/commands/destroy.js';
import { setLocalCustomResourceRuntimeEnabled } from '../../../src/local/custom-resource-runtime-gate.js';

function stackState(stackName: string, withCustomResource: boolean): StackState {
  return {
    version: 1,
    stackName,
    region: 'us-east-1',
    resources: {
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
      ...(withCustomResource && {
        Cr: {
          physicalId: 'cr',
          resourceType: 'Custom::AWS',
          properties: { ServiceToken: 'arn:aws:lambda:us-east-1:000000000000:function:H' },
        },
      }),
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
}

describe('cdkd destroy without the app under --aws-emulator (#6246)', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    wiring.value = { mode: 'emulator' };
    setLocalCustomResourceRuntimeEnabled(true, 'destroy');
    mockSynthesize.mockRejectedValue(new Error('no app'));
    mockListStacks.mockResolvedValue([
      { stackName: 'A', region: 'us-east-1' },
      { stackName: 'B', region: 'us-east-1' },
    ]);
    mockGetState.mockImplementation(async (name: string) => ({
      state: stackState(name, name === 'B'),
      etag: '"x"',
    }));
    mockRunDestroyForStack.mockResolvedValue({
      stackName: 'A',
      cancelled: false,
      skippedEmpty: false,
      deletedCount: 1,
      retainedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      interrupted: false,
    });
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    wiring.value = undefined;
    setLocalCustomResourceRuntimeEnabled(true);
  });

  async function destroy(): Promise<Error | undefined> {
    const cmd = createDestroyCommand();
    cmd.exitOverride();
    return cmd.parseAsync(['A', 'B', '--yes'], { from: 'user' }).then(
      () => undefined,
      (e: unknown) => e as Error
    );
  }

  it('a later target holding custom resources refuses the run before any stack is destroyed', async () => {
    const err = await destroy();
    expect(err?.message).toContain('stack B (Cr)');
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
  });

  it('off the emulator, both stacks are destroyed', async () => {
    wiring.value = undefined;
    expect(await destroy()).toBeUndefined();
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(2);
  });
});
