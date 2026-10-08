import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/cli/commands/state.ts` slice: a SWALLOWING handler that stringified its
 * caught value with a bare `String()` turned a graceful degradation into a hard
 * failure when the value could not be converted -- `String(Object.create(null))`
 * throws `TypeError: Cannot convert object to primitive value`.
 *
 * Every case rejects with exactly that value and asserts the DEGRADATION still
 * happens (the command resolves, the work after the failure still runs), never
 * merely "it did not throw". The placeholder is asserted too, so a fix that
 * swallowed the failure without reporting it would not pass.
 */

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
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
  reserveStdoutForPayload: vi.fn(),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveStateBucketWithDefaultAndSource: vi.fn(async () => ({ bucket: 'test-bucket' })),
  resolveApp: vi.fn(() => undefined),
}));

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
  getAwsClients: vi.fn(),
}));

const mockGetState = vi.hoisted(() => vi.fn());
const mockSaveState = vi.hoisted(() => vi.fn(async () => '"etag-2"'));
const mockListStacks = vi.hoisted(() => vi.fn());
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: mockGetState,
    saveState: mockSaveState,
    listStacks: mockListStacks,
    deleteState: vi.fn(async () => undefined),
    verifyBucketExists: vi.fn(async () => undefined),
    rotateCreateTokenNonce: vi.fn(async () => undefined),
  })),
}));

const mockAcquireLock = vi.hoisted(() => vi.fn(async () => true));
const mockReleaseLock = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => undefined));
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: mockAcquireLock,
    releaseLock: mockReleaseLock,
    forceReleaseLock: vi.fn(async () => undefined),
    isLocked: vi.fn(async () => false),
    getLockInfo: vi.fn(async () => null),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

const mockGetProvider = vi.hoisted(() => vi.fn<(resourceType: string) => unknown>());
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: mockGetProvider,
    getProviderFor: (input: { resourceType: string }) => ({
      provider: mockGetProvider(input.resourceType),
      provisionedBy: 'sdk',
    }),
    shouldSkipResource: vi.fn(() => false),
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: vi.fn(async () => 'n'), close: vi.fn() })),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A rejection whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

const warnings = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));

async function run(args: string[]): Promise<{ error: unknown }> {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  let error: unknown;
  try {
    const cmd = createStateCommand();
    cmd.exitOverride();
    cmd.commands.forEach((sub) => sub.exitOverride());
    await cmd.parseAsync(args, { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    process.stdout.write = original;
  }
  return { error };
}

function bucket(name: string): ResourceState {
  return {
    physicalId: name,
    resourceType: 'AWS::S3::Bucket',
    properties: { BucketName: name },
  };
}

function stackOf(resources: Record<string, ResourceState>): { state: StackState; etag: string } {
  return {
    state: {
      version: 2,
      stackName: 'App',
      region: 'us-east-1',
      resources,
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

function saved(): StackState {
  expect(mockSaveState).toHaveBeenCalledTimes(1);
  return (mockSaveState.mock.calls[0] as unknown as unknown[])[2] as StackState;
}

let exitSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  mockAcquireLock.mockResolvedValue(true);
  // `mockReset`, not just `clearAllMocks`: it drains a `*Once` primer a case
  // did not consume.
  mockReleaseLock.mockReset();
  mockReleaseLock.mockResolvedValue(undefined);
  mockSaveState.mockResolvedValue('"etag-2"');
  mockListStacks.mockResolvedValue([{ stackName: 'App', region: 'us-east-1' }]);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('__exit__');
  }) as never);
});
afterEach(() => {
  exitSpy.mockRestore();
});

describe('cdkd state orphan --resource (#3361)', () => {
  it('saves the removal and resolves when the lock release rejects with an unconvertible value', async () => {
    mockGetState.mockResolvedValue(stackOf({ Gone: bucket('gone'), Keep: bucket('keep') }));
    mockReleaseLock.mockRejectedValueOnce(unconvertible());

    const { error } = await run(['orphan', 'App', '--resource', 'Gone', '--yes']);

    expect(error).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(Object.keys(saved().resources)).toEqual(['Keep']);
    expect(mockReleaseLock).toHaveBeenCalledWith('App', 'us-east-1');
    expect(warnings()).toContainEqual(expect.stringContaining('Failed to release lock: '));
    expect(warnings().find((w) => w.includes('Failed to release lock'))).toContain(PLACEHOLDER);
  });
});

describe('cdkd state refresh-observed (#3361)', () => {
  it('counts the unconvertible readCurrentState rejection as failed and still refreshes the sibling', async () => {
    mockGetState.mockResolvedValue(stackOf({ Good: bucket('good'), Bad: bucket('bad') }));
    mockGetProvider.mockReturnValue({
      readCurrentState: async (physicalId: string) => {
        if (physicalId === 'bad') throw unconvertible();
        return { BucketName: physicalId };
      },
    });

    const { error } = await run(['refresh-observed', 'App', '--yes']);

    // One per-resource failure is a PartialFailureError -> exit 2, AFTER the save.
    expect((error as Error).message).toBe('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(2);
    const state = saved();
    expect(state.resources['Good']?.observedProperties).toEqual({ BucketName: 'good' });
    expect(state.resources['Bad']?.observedProperties).toBeUndefined();
    expect(infoSpy.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringContaining('1 refreshed, 0 unsupported, 1 failed')
    );
    const line = warnings().find((w) => w.includes('readCurrentState failed — '));
    expect(line).toBeDefined();
    expect(line).toContain('Bad');
    expect(line).toContain(PLACEHOLDER);
    expect(mockReleaseLock).toHaveBeenCalledWith('App', 'us-east-1');
  });

  it('saves and resolves when the lock release rejects with an unconvertible value', async () => {
    mockGetState.mockResolvedValue(stackOf({ Good: bucket('good') }));
    mockGetProvider.mockReturnValue({
      readCurrentState: async (physicalId: string) => ({ BucketName: physicalId }),
    });
    mockReleaseLock.mockRejectedValueOnce(unconvertible());

    const { error } = await run(['refresh-observed', 'App', '--yes']);

    expect(error).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(saved().resources['Good']?.observedProperties).toEqual({ BucketName: 'good' });
    expect(infoSpy.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringContaining('1 refreshed, 0 unsupported, 0 failed')
    );
    const line = warnings().find((w) => w.includes('Failed to release lock for '));
    expect(line).toBeDefined();
    expect(line).toContain(PLACEHOLDER);
  });
});
