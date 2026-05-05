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
  vi.fn<(stackName: string, region: string) => Promise<{ state: StackState } | null>>();
const mockListStacks =
  vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: mockVerifyBucketExists,
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

function makeState(resources: Record<string, ResourceState>): { state: StackState } {
  return {
    state: {
      version: 2,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources,
      outputs: {},
      lastModified: 0,
    },
  };
}

describe('cdkd drift', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockResolvedValue(undefined);
    mockRegistryGetProvider.mockReset();
    mockRegistryShouldSkip.mockReset().mockReturnValue(false);
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

  it('rejects with a clear error when no stack is named and --all is absent', async () => {
    await runDrift([]);
    const messages = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toMatch(/Stack name is required/);
  });

  it('rejects with a clear error when the named stack has no state', async () => {
    mockListStacks.mockResolvedValueOnce([
      { stackName: 'OtherStack', region: 'us-east-1' },
    ]);

    await runDrift(['TestStack']);
    const messages = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toMatch(/No state found for stack 'TestStack'/);
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
