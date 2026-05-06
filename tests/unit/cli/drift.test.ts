import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const errorSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
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
const mockRegistrySetCustomBucket = vi.fn();
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: mockRegistryGetProvider,
    shouldSkipResource: mockRegistryShouldSkip,
    setCustomResourceResponseBucket: mockRegistrySetCustomBucket,
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

// PR J: drift falls back to Cloud Control API when an SDK provider does
// not implement `readCurrentState`. Mock the CC API readCurrentState so
// tests can simulate "fallback returns undefined" (drift unknown) by
// default; tests that exercise the fallback override per-call.
const mockCcReadCurrentState = vi
  .fn<(physicalId: string, logicalId: string, type: string) => Promise<Record<string, unknown> | undefined>>()
  .mockResolvedValue(undefined);
vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: vi.fn().mockImplementation(() => ({
    readCurrentState: mockCcReadCurrentState,
  })),
}));

import { createDriftCommand } from '../../../src/cli/commands/drift.js';

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
 * `createDriftCommand()` returns the `drift` subcommand directly. Pass the
 * args that would follow `cdkd drift ...` on the CLI — no leading `drift`.
 *
 * Returns `{ output, error }` so callers can inspect both the printed
 * report (`writeHumanReport` runs before any `DriftDetectedError` /
 * `process.exit` sentinel) and any thrown error in the same line.
 */
async function runDrift(
  args: string[]
): Promise<{ output: string; error: unknown }> {
  const cap = captureStdout();
  let error: unknown;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
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
    ...(overrides.attributes && { attributes: overrides.attributes }),
    ...(overrides.dependencies && { dependencies: overrides.dependencies }),
  };
}

function makeState(
  resources: Record<string, ResourceState>
): { state: StackState; etag: string } {
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

describe('cdkd drift', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockResolvedValue(undefined);
    mockSaveState.mockReset();
    mockSaveState.mockResolvedValue('"etag-2"');
    mockAcquireLock.mockReset().mockResolvedValue(true);
    mockReleaseLock.mockReset().mockResolvedValue(undefined);
    mockRegistryGetProvider.mockReset();
    mockRegistryShouldSkip.mockReset().mockReturnValue(false);
    mockCcReadCurrentState.mockReset().mockResolvedValue(undefined);
    errorSpy.mockReset();
    // Stub process.exit so DriftDetectedError -> exit(1) doesn't kill the test.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('prints "no drift detected" when every resource matches AWS', async () => {
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
      readCurrentState: async () => ({ BucketName: 'b' }),
    });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(output).toContain('✓ TestStack (us-east-1): no drift detected');
    expect(output).toContain('1 resource checked');
    expect(output).toContain('0 unsupported');
    // No drift => no process.exit(1) — the command returns normally.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('reports drifted properties with +/- diff lines and exits 1', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Bucket1: makeResource({
          physicalId: 'b',
          resourceType: 'AWS::S3::Bucket',
          properties: { VersioningConfiguration: { Status: 'Enabled' } },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ VersioningConfiguration: { Status: 'Suspended' } }),
    });

    const { output, error } = await runDrift(['TestStack']);

    // Drift detected — error-handler called process.exit(1) which our
    // stub turned into a thrown sentinel.
    expect((error as Error).message).toBe('__exit__');
    expect(output).toContain('⚠ TestStack (us-east-1): drift detected on 1 resource');
    expect(output).toContain('~ Bucket1 (AWS::S3::Bucket)');
    expect(output).toContain('- VersioningConfiguration.Status: Enabled');
    expect(output).toContain('+ VersioningConfiguration.Status: Suspended');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('skips state property paths declared by getDriftUnknownPaths so they never fire false drift', async () => {
    // Mirrors Lambda's `Code` problem: state holds the asset key, but
    // `GetFunction` returns a pre-signed URL — so without ignore-paths the
    // resource would always report drift on `Code`.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Fn1: makeResource({
          physicalId: 'fn',
          resourceType: 'AWS::Lambda::Function',
          properties: {
            Code: { S3Bucket: 'b', S3Key: 'k.zip' },
            MemorySize: 128,
          },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      // AWS-side snapshot omits `Code` (matches the real Lambda provider).
      readCurrentState: async () => ({ MemorySize: 128 }),
      getDriftUnknownPaths: () => ['Code'],
    });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(output).toContain('no drift detected');
    expect(output).not.toContain('Code');
  });

  it('reports providers without readCurrentState as drift unknown', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        SomeRes: makeResource({
          resourceType: 'AWS::Lambda::Function',
          properties: { MemorySize: 128 },
        }),
      })
    );
    // Provider exists but does not implement readCurrentState yet (PR D
    // adds SDK-side support).
    mockRegistryGetProvider.mockReturnValue({});

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(output).toContain('? SomeRes (AWS::Lambda::Function)');
    expect(output).toContain('drift unknown');
    expect(output).toContain('1 unsupported');
    // Drift unknown is not drift -> exit 0.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('--json emits a structured per-stack report', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Bucket1: makeResource({
          physicalId: 'b',
          resourceType: 'AWS::S3::Bucket',
          properties: { VersioningConfiguration: { Status: 'Enabled' } },
        }),
        Other: makeResource({
          resourceType: 'AWS::Lambda::Function',
          properties: { MemorySize: 128 },
        }),
      })
    );
    mockRegistryGetProvider.mockImplementation((resourceType: string) => {
      if (resourceType === 'AWS::S3::Bucket') {
        return {
          readCurrentState: async () => ({ VersioningConfiguration: { Status: 'Suspended' } }),
        };
      }
      return {};
    });

    const { output } = await runDrift(['TestStack', '--json']);

    const payload = JSON.parse(output) as Array<{
      stack: string;
      region: string;
      drifted: Array<{ logicalId: string; type: string; changes: unknown[] }>;
      clean: Array<{ logicalId: string }>;
      notSupported: Array<{ logicalId: string }>;
    }>;
    expect(payload).toHaveLength(1);
    expect(payload[0]?.stack).toBe('TestStack');
    expect(payload[0]?.region).toBe('us-east-1');
    expect(payload[0]?.drifted).toEqual([
      {
        logicalId: 'Bucket1',
        type: 'AWS::S3::Bucket',
        changes: [
          {
            path: 'VersioningConfiguration.Status',
            stateValue: 'Enabled',
            awsValue: 'Suspended',
          },
        ],
      },
    ]);
    expect(payload[0]?.notSupported.map((n) => n.logicalId)).toEqual(['Other']);
  });

  it('auto-selects the only stack in state when no name is given (mirrors deploy/destroy)', async () => {
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
      readCurrentState: async () => ({ BucketName: 'b' }),
    });

    const { output, error } = await runDrift([]);
    expect(error).toBeUndefined();
    expect(output).toContain('TestStack');
    expect(output).toContain('no drift detected');
  });

  it('rejects with a multi-stack listing when no name is given and state has more than one stack', async () => {
    mockListStacks.mockResolvedValueOnce([
      { stackName: 'StackA', region: 'us-east-1' },
      { stackName: 'StackB', region: 'us-east-1' },
    ]);

    await runDrift([]);
    const messages = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toMatch(/Multiple stacks found in state/);
    expect(messages).toMatch(/StackA/);
    expect(messages).toMatch(/StackB/);
  });

  it('rejects with a clear error when state is empty and no name is given', async () => {
    mockListStacks.mockResolvedValueOnce([]);

    await runDrift([]);
    const messages = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toMatch(/No stacks found in state bucket/);
  });

  it('rejects with a clear error when the named stack has no state', async () => {
    mockListStacks.mockResolvedValueOnce([
      { stackName: 'OtherStack', region: 'us-east-1' },
    ]);

    await runDrift(['TestStack']);
    const messages = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toMatch(/No state found for stack 'TestStack'/);
  });

  it('rejects --accept and --revert together at parse time', async () => {
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
      readCurrentState: async () => ({ BucketName: 'b' }),
    });

    await runDrift(['TestStack', '--accept', '--revert', '--yes']);
    const messages = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toMatch(/--accept and --revert are mutually exclusive/);
    // saveState / provider.update never run when the flags collide.
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  describe('--accept (state ← AWS)', () => {
    it('writes the AWS-current values into state', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Bucket1: makeResource({
            physicalId: 'b',
            resourceType: 'AWS::S3::Bucket',
            properties: {
              BucketName: 'b',
              VersioningConfiguration: { Status: 'Enabled' },
            },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({
          BucketName: 'b',
          VersioningConfiguration: { Status: 'Suspended' },
        }),
      });

      const { error } = await runDrift(['TestStack', '--accept', '--yes']);
      expect(error).toBeUndefined();

      expect(mockAcquireLock).toHaveBeenCalledWith(
        'TestStack',
        'us-east-1',
        expect.any(String),
        'drift-accept'
      );
      expect(mockReleaseLock).toHaveBeenCalledWith('TestStack', 'us-east-1');

      expect(mockSaveState).toHaveBeenCalledTimes(1);
      const [stackName, region, savedState, opts] = mockSaveState.mock.calls[0]!;
      expect(stackName).toBe('TestStack');
      expect(region).toBe('us-east-1');
      expect(opts?.expectedEtag).toBe('"etag-1"');
      expect(savedState.resources['Bucket1']!.properties).toEqual({
        BucketName: 'b',
        VersioningConfiguration: { Status: 'Suspended' },
      });
    });

    it('--accept with --dry-run does NOT call saveState or acquire a lock', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Bucket1: makeResource({
            physicalId: 'b',
            resourceType: 'AWS::S3::Bucket',
            properties: { VersioningConfiguration: { Status: 'Enabled' } },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({ VersioningConfiguration: { Status: 'Suspended' } }),
      });

      const { output, error } = await runDrift(['TestStack', '--accept', '--dry-run', '--yes']);

      expect(error).toBeUndefined();
      expect(mockSaveState).not.toHaveBeenCalled();
      expect(mockAcquireLock).not.toHaveBeenCalled();
      expect(output).toContain('Plan (--accept)');
      expect(output).toContain('VersioningConfiguration.Status: Enabled -> Suspended');
    });

    it('--accept on a clean stack is a no-op', async () => {
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
        readCurrentState: async () => ({ BucketName: 'b' }),
      });

      const { error } = await runDrift(['TestStack', '--accept', '--yes']);

      expect(error).toBeUndefined();
      expect(mockAcquireLock).not.toHaveBeenCalled();
      expect(mockSaveState).not.toHaveBeenCalled();
    });

    it('handles nested dotted paths when accepting', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Bucket1: makeResource({
            physicalId: 'b',
            resourceType: 'AWS::S3::Bucket',
            properties: {
              PublicAccessBlockConfiguration: {
                BlockPublicAcls: true,
                BlockPublicPolicy: true,
              },
            },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: false,
          },
        }),
      });

      await runDrift(['TestStack', '--accept', '--yes']);

      const [, , savedState] = mockSaveState.mock.calls[0]!;
      expect(savedState.resources['Bucket1']!.properties).toEqual({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: false,
        },
      });
    });
  });

  describe('--revert (AWS ← state)', () => {
    it('calls provider.update with stateProps as new and AWS-current as previous', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Bucket1: makeResource({
            physicalId: 'phys-b',
            resourceType: 'AWS::S3::Bucket',
            properties: { VersioningConfiguration: { Status: 'Enabled' } },
          }),
        })
      );
      const updateMock = vi.fn(async () => ({ physicalId: 'phys-b', wasReplaced: false }));
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({ VersioningConfiguration: { Status: 'Suspended' } }),
        update: updateMock,
      });

      const { error } = await runDrift(['TestStack', '--revert', '--yes']);

      expect(error).toBeUndefined();
      expect(updateMock).toHaveBeenCalledTimes(1);
      const [logicalId, physicalId, resourceType, newProps, previousProps] =
        updateMock.mock.calls[0]!;
      expect(logicalId).toBe('Bucket1');
      expect(physicalId).toBe('phys-b');
      expect(resourceType).toBe('AWS::S3::Bucket');
      expect(newProps).toEqual({ VersioningConfiguration: { Status: 'Enabled' } });
      expect(previousProps).toEqual({ VersioningConfiguration: { Status: 'Suspended' } });

      // State is NOT updated by --revert.
      expect(mockSaveState).not.toHaveBeenCalled();

      expect(mockAcquireLock).toHaveBeenCalledWith(
        'TestStack',
        'us-east-1',
        expect.any(String),
        'drift-revert'
      );
      expect(mockReleaseLock).toHaveBeenCalledWith('TestStack', 'us-east-1');
    });

    it('--revert with --dry-run does NOT call provider.update or acquire a lock', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Bucket1: makeResource({
            physicalId: 'b',
            resourceType: 'AWS::S3::Bucket',
            properties: { VersioningConfiguration: { Status: 'Enabled' } },
          }),
        })
      );
      const updateMock = vi.fn();
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({ VersioningConfiguration: { Status: 'Suspended' } }),
        update: updateMock,
      });

      const { output, error } = await runDrift([
        'TestStack',
        '--revert',
        '--dry-run',
        '--yes',
      ]);

      expect(error).toBeUndefined();
      expect(updateMock).not.toHaveBeenCalled();
      expect(mockAcquireLock).not.toHaveBeenCalled();
      expect(mockSaveState).not.toHaveBeenCalled();
      expect(output).toContain('Plan (--revert)');
    });

    it('--revert on a clean stack is a no-op', async () => {
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
      const updateMock = vi.fn();
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({ BucketName: 'b' }),
        update: updateMock,
      });

      const { error } = await runDrift(['TestStack', '--revert', '--yes']);
      expect(error).toBeUndefined();
      expect(updateMock).not.toHaveBeenCalled();
      expect(mockAcquireLock).not.toHaveBeenCalled();
    });

    it('--revert exits 2 (PartialFailureError) when one provider.update fails', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Bucket1: makeResource({
            physicalId: 'phys-1',
            resourceType: 'AWS::S3::Bucket',
            properties: { VersioningConfiguration: { Status: 'Enabled' } },
          }),
          Bucket2: makeResource({
            physicalId: 'phys-2',
            resourceType: 'AWS::S3::Bucket',
            properties: { VersioningConfiguration: { Status: 'Enabled' } },
          }),
        })
      );
      const updateMock = vi.fn(async (logicalId: string) => {
        if (logicalId === 'Bucket1') {
          throw new Error('AccessDenied');
        }
        return { physicalId: 'phys-2', wasReplaced: false };
      });
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({ VersioningConfiguration: { Status: 'Suspended' } }),
        update: updateMock,
      });

      const { error } = await runDrift(['TestStack', '--revert', '--yes']);

      // PartialFailureError → handler triggers process.exit(2) which our
      // stub turns into an "__exit__" sentinel.
      expect((error as Error).message).toBe('__exit__');
      expect(exitSpy).toHaveBeenCalledWith(2);

      // Both updates were attempted; the second succeeded.
      expect(updateMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('CC API fallback (PR J)', () => {
    it('falls back to CC API readCurrentState when the SDK provider lacks it', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Topic1: makeResource({
            physicalId: 'arn:aws:sns:us-east-1:123:Topic1',
            resourceType: 'AWS::SNS::Topic',
            // The SNS provider has its own readCurrentState in real
            // life, but for this test the registry returns a stub
            // without one to drive the fallback path.
            properties: { TopicName: 'Topic1' },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({}); // no readCurrentState
      mockCcReadCurrentState.mockResolvedValueOnce({ TopicName: 'Topic1' });

      const { output, error } = await runDrift(['TestStack']);

      expect(error).toBeUndefined();
      expect(mockCcReadCurrentState).toHaveBeenCalledTimes(1);
      // Clean: CC API answer matched state.
      expect(output).toContain('✓ TestStack (us-east-1): no drift detected');
    });

    it('strips AWS-managed fields from CC API response before comparison', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Topic1: makeResource({
            physicalId: 'arn:aws:sns:us-east-1:123:Topic1',
            resourceType: 'AWS::SNS::Topic',
            properties: { TopicName: 'Topic1' },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({});
      // CC API returns timestamps + status that cdkd state never set —
      // these must be stripped, not surfaced as drift.
      mockCcReadCurrentState.mockResolvedValueOnce({
        TopicName: 'Topic1',
        CreationDate: '2024-01-01T00:00:00Z',
        LastModifiedTime: '2024-06-01T00:00:00Z',
        Status: 'Active',
      });

      const { output, error } = await runDrift(['TestStack']);

      expect(error).toBeUndefined();
      expect(output).toContain('✓ TestStack (us-east-1): no drift detected');
    });

    it('reports deny-listed types as drift unknown without calling CC API', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          // AWS::IAM::ManagedPolicy is in the deny list.
          Policy1: makeResource({
            physicalId: 'arn:aws:iam::123:policy/p',
            resourceType: 'AWS::IAM::ManagedPolicy',
            properties: { PolicyDocument: { Statement: [] } },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({});

      const { output, error } = await runDrift(['TestStack']);

      expect(error).toBeUndefined();
      expect(mockCcReadCurrentState).not.toHaveBeenCalled();
      expect(output).toContain('? Policy1 (AWS::IAM::ManagedPolicy)');
      expect(output).toContain('1 unsupported');
    });

    it('treats CC API ResourceNotFound (undefined) as drift unknown', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Foo: makeResource({
            physicalId: 'foo',
            resourceType: 'AWS::SomeService::SomeType',
            properties: { Bar: 1 },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({});
      // Default mock returns undefined — simulates "resource gone from AWS".

      const { output, error } = await runDrift(['TestStack']);

      expect(error).toBeUndefined();
      expect(mockCcReadCurrentState).toHaveBeenCalledTimes(1);
      expect(output).toContain('? Foo (AWS::SomeService::SomeType)');
    });
  });

  it('--all checks every stack in the bucket', async () => {
    mockListStacks.mockResolvedValueOnce([
      { stackName: 'StackA', region: 'us-east-1' },
      { stackName: 'StackB', region: 'us-west-2' },
    ]);
    mockGetState.mockImplementation(async (stackName, region) => ({
      state: {
        version: 2,
        stackName,
        region,
        resources: {
          Bucket1: makeResource({
            physicalId: `${stackName}-b`,
            resourceType: 'AWS::S3::Bucket',
            properties: { BucketName: `${stackName}-b` },
          }),
        },
        outputs: {},
        lastModified: 0,
      },
    }));
    mockRegistryGetProvider.mockImplementation(() => ({
      readCurrentState: async (physicalId: string) => ({ BucketName: physicalId }),
    }));

    const { output, error } = await runDrift(['--all']);

    expect(error).toBeUndefined();
    expect(output).toContain('✓ StackA (us-east-1): no drift detected');
    expect(output).toContain('✓ StackB (us-west-2): no drift detected');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
