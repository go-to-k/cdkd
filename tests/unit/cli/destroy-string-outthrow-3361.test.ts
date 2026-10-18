import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/cli/commands/destroy.ts` slice: two handlers converted their caught
 * value with `String(x)`, which throws for a null-prototype object
 * (`TypeError: Cannot convert object to primitive value`):
 *
 *  - the event-history purge after a destroy (warn and carry on), and
 *  - the synthesis failure that falls back to the state's stack list.
 *
 * Each case rejects with exactly that value and asserts the degradation still
 * happens, never merely "it did not throw".
 */

const PLACEHOLDER = 'a value that could not be converted to text';

const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    getLogger: () => ({
      setLevel: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
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

// Let the action's error reach parseAsync instead of process.exit-ing.
vi.mock('../../../src/utils/error-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/error-handler.js')>();
  return {
    ...actual,
    withErrorHandling: <Args extends unknown[]>(fn: (...args: Args) => Promise<void> | void) => fn,
  };
});

import { createDestroyCommand, purgeEventsAfterDestroy } from '../../../src/cli/commands/destroy.js';

function stackState(stackName: string): StackState {
  return {
    version: 1,
    stackName,
    region: 'us-east-1',
    resources: {
      Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
}

describe('purgeEventsAfterDestroy with an unconvertible rejection (#3361)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('warns with the placeholder and answers null instead of throwing', async () => {
    const reader = { pruneRuns: vi.fn().mockRejectedValue(Object.create(null)) };
    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await purgeEventsAfterDestroy(
      reader,
      'MyStack',
      'us-east-1',
      { purgeEvents: true, runResult: 'SUCCEEDED', interrupted: false },
      log
    );

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      `  Failed to purge deployment-event history for MyStack: ${PLACEHOLDER}`
    );
  });
});

describe('cdkd destroy with synthesis rejecting an unconvertible value (#3361)', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRunDestroyForStack.mockResolvedValue({
      stackName: 'MyStack',
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
  });

  it('still falls back to the state stack list and destroys the named stack', async () => {
    mockSynthesize.mockRejectedValue(Object.create(null));
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({ state: stackState('MyStack'), etag: '"x"' });

    const cmd = createDestroyCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['MyStack', '--yes'], { from: 'user' });

    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls[0]?.[0]).toBe('MyStack');
  });

  it('--all is refused with the app-scope error, carrying the placeholder as its cause', async () => {
    mockSynthesize.mockRejectedValue(Object.create(null));
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);

    const cmd = createDestroyCommand();
    cmd.exitOverride();
    const error = await cmd.parseAsync(['--all', '--yes'], { from: 'user' }).then(
      () => undefined,
      (e: unknown) => e as { code?: string; message?: string; cause?: unknown }
    );

    expect(error?.code).toBe('DESTROY_NO_APP_SCOPE');
    expect(error?.message).toContain('the app could not be synthesized');
    expect((error?.cause as Error | undefined)?.message).toBe(PLACEHOLDER);
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
  });
});
