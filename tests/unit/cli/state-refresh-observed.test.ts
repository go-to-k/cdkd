import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ResourceState, StackState } from '../../../src/types/state.js';

// Logger / config-loader / aws-clients mocks: same pattern as the
// other state-* tests so the command boot path runs cleanly without
// real AWS or the AWS SDK side-effects.

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

const mockGetState =
  vi.fn<
    (
      stackName: string,
      region: string
    ) => Promise<{ state: StackState; etag: string; migrationPending?: boolean } | null>
  >();
const mockListStacks =
  vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
const mockSaveState =
  vi.fn<
    (
      stackName: string,
      region: string,
      state: StackState,
      options?: { expectedEtag?: string; migrateLegacy?: boolean }
    ) => Promise<string>
  >();

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: mockVerifyBucketExists,
    saveState: mockSaveState,
  })),
}));

const mockAcquireLock = vi.fn<() => Promise<boolean>>();
const mockReleaseLock = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: mockAcquireLock,
    releaseLock: mockReleaseLock,
  })),
}));

const mockRegistryGetProvider = vi.fn<(resourceType: string) => unknown>();
const mockRegistryShouldSkip = vi.fn<(resourceType: string) => boolean>().mockReturnValue(false);
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: mockRegistryGetProvider,
    shouldSkipResource: mockRegistryShouldSkip,
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
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

/**
 * Drive `createStateCommand()` with the refresh-observed subcommand
 * args. `--yes` is included by default so the confirmation prompt
 * doesn't block on stdin in tests.
 */
async function runRefresh(
  args: string[]
): Promise<{ output: string; error: unknown }> {
  const cap = captureStdout();
  let error: unknown;
  try {
    const cmd = createStateCommand();
    cmd.exitOverride();
    cmd.commands.forEach((sub) => sub.exitOverride());
    await cmd.parseAsync(['refresh-observed', '--yes', ...args], { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    cap.restore();
  }
  return { output: cap.output.join(''), error };
}

function makeResource(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: overrides.physicalId ?? 'phys-id',
    resourceType: overrides.resourceType ?? 'AWS::S3::Bucket',
    properties: overrides.properties ?? {},
    ...(overrides.observedProperties && { observedProperties: overrides.observedProperties }),
    ...(overrides.attributes && { attributes: overrides.attributes }),
    ...(overrides.dependencies && { dependencies: overrides.dependencies }),
  };
}

function makeState(
  resources: Record<string, ResourceState>
): { state: StackState; etag: string; migrationPending?: boolean } {
  return {
    state: {
      version: 2,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources,
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

describe('cdkd state refresh-observed', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockVerifyBucketExists.mockReset().mockResolvedValue(undefined);
    mockSaveState.mockReset().mockResolvedValue('"etag-2"');
    mockAcquireLock.mockReset().mockResolvedValue(true);
    mockReleaseLock.mockReset().mockResolvedValue(undefined);
    mockRegistryGetProvider.mockReset();
    mockRegistryShouldSkip.mockReset().mockReturnValue(false);
    errorSpy.mockReset();
    infoSpy.mockReset();
    // Stub process.exit so PartialFailureError -> exit(2) doesn't kill the test.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('refreshes observedProperties on every resource and saves the updated state', async () => {
    // The headline use case: resource has no observedProperties (older
    // v2 state), refresh-observed populates it from
    // provider.readCurrentState and persists it under a stack lock.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Bucket1: makeResource({
          physicalId: 'b',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'b' },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ BucketName: 'b', Tags: [] }),
    });

    const { error } = await runRefresh(['TestStack']);

    expect(error).toBeUndefined();
    expect(mockAcquireLock).toHaveBeenCalledWith(
      'TestStack',
      'us-east-1',
      expect.any(String),
      'state-refresh-observed'
    );
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const [, , savedState, saveOptions] = mockSaveState.mock.calls[0] as unknown as [
      string,
      string,
      StackState,
      { expectedEtag?: string },
    ];
    expect(saveOptions.expectedEtag).toBe('"etag-1"');
    expect(savedState.resources['Bucket1']?.observedProperties).toEqual({
      BucketName: 'b',
      Tags: [],
    });
    expect(mockReleaseLock).toHaveBeenCalled();
  });

  it('counts providers without readCurrentState as unsupported, leaving observedProperties untouched', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        WithReader: makeResource({
          physicalId: 'a',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'a' },
        }),
        NoReader: makeResource({
          physicalId: 'b',
          resourceType: 'AWS::Foo::Bar',
          properties: {},
        }),
      })
    );
    mockRegistryGetProvider.mockImplementation((t: string) => {
      if (t === 'AWS::S3::Bucket') {
        return { readCurrentState: async () => ({ BucketName: 'a' }) };
      }
      // Provider exists but no readCurrentState (incremental rollout).
      return {};
    });

    const { error } = await runRefresh(['TestStack']);

    expect(error).toBeUndefined();
    const savedState = mockSaveState.mock.calls[0]?.[2] as StackState;
    expect(savedState.resources['WithReader']?.observedProperties).toEqual({ BucketName: 'a' });
    expect(savedState.resources['NoReader']?.observedProperties).toBeUndefined();
  });

  it('does not abort when one resource\'s readCurrentState throws (per-resource error swallowed)', async () => {
    // Same per-resource defensive shape as deploy + import: a single
    // readCurrentState failure leaves that resource without observed
    // properties and is reported as a "failed" count; remaining
    // resources still get refreshed.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Good: makeResource({
          physicalId: 'g',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'g' },
        }),
        Bad: makeResource({
          physicalId: 'b',
          resourceType: 'AWS::Foo::Bar',
          properties: {},
        }),
      })
    );
    mockRegistryGetProvider.mockImplementation((t: string) => {
      if (t === 'AWS::S3::Bucket') {
        return { readCurrentState: async () => ({ BucketName: 'g' }) };
      }
      return {
        readCurrentState: async () => {
          throw new Error('AccessDenied');
        },
      };
    });

    const { error } = await runRefresh(['TestStack']);

    // PartialFailureError caught by withErrorHandling -> process.exit(2).
    expect((error as Error).message).toBe('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(2);
    // Despite the per-resource failure, state was still saved with the
    // successful refresh; the failed resource just kept its
    // (undefined) observedProperties.
    const savedState = mockSaveState.mock.calls[0]?.[2] as StackState;
    expect(savedState.resources['Good']?.observedProperties).toEqual({ BucketName: 'g' });
    expect(savedState.resources['Bad']?.observedProperties).toBeUndefined();
  });

  it('--dry-run prints the planned counts without acquiring a lock or saving state', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Bucket1: makeResource({ resourceType: 'AWS::S3::Bucket' }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ BucketName: 'b' }),
    });

    const { error } = await runRefresh(['TestStack', '--dry-run']);

    expect(error).toBeUndefined();
    const messages = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toContain('1 resource(s) would be refreshed');
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('rejects when no stack name is given and --all is absent', async () => {
    mockListStacks.mockResolvedValueOnce([]);

    await runRefresh([]);
    const messages = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toMatch(/Stack name is required/);
  });

  it('--all refreshes every stack in the bucket', async () => {
    mockListStacks.mockResolvedValueOnce([
      { stackName: 'StackA', region: 'us-east-1' },
      { stackName: 'StackB', region: 'us-east-1' },
    ]);
    mockGetState
      .mockResolvedValueOnce(
        makeState({ A: makeResource({ resourceType: 'AWS::S3::Bucket' }) })
      )
      .mockResolvedValueOnce(
        makeState({ B: makeResource({ resourceType: 'AWS::S3::Bucket' }) })
      );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ BucketName: 'x' }),
    });

    const { error } = await runRefresh(['--all']);

    expect(error).toBeUndefined();
    expect(mockSaveState).toHaveBeenCalledTimes(2);
  });
});
