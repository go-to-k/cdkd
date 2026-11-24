import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6651: an undeclared key whose observed baseline is an empty
 * container is skipped by drift (#1498), unless the type lists it as a key no
 * other resource fills. An AgentCore runtime's `ResourceConfigurations` set
 * outside cdkd is then reported, and `--revert` sends the empty baseline back;
 * `CapacityProviderConfiguration` (not listed) stays skipped.
 */

vi.mock('../../../src/utils/logger.js', () => ({
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({
    get s3() {
      return {};
    },
    get iam() {
      return { send: vi.fn() };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
  getAwsClients: () => ({}),
}));

const mockGetState =
  vi.fn<(stackName: string, region: string) => Promise<{ state: StackState; etag: string } | null>>();
const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: vi.fn(async () => '"etag-2"'),
  })),
}));

vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn(() => ({
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => undefined),
  })),
}));

const mockRegistryGetProvider = vi.fn<(resourceType: string) => unknown>();
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({
    getProvider: mockRegistryGetProvider,
    getProviderFor: (input: { resourceType: string }) => ({
      provider: mockRegistryGetProvider(input.resourceType),
      provisionedBy: 'sdk',
    }),
    shouldSkipResource: () => false,
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: vi.fn(() => ({
    readCurrentState: vi.fn(async () => undefined),
  })),
}));

import {
  createDriftCommand,
  undeclaredEmptyComparedDriftKeys,
} from '../../../src/cli/commands/drift.js';

const RUNTIME = 'AWS::BedrockAgentCore::Runtime';

const BASELINE = {
  AgentRuntimeName: 'rt',
  RoleArn: 'arn:aws:iam::123456789012:role/r',
  PlatformVersion: 'V2',
  HooksConfiguration: {},
  ResourceConfigurations: [],
  FilesystemConfigurations: [],
  RequestHeaderConfiguration: {},
  CapacityProviderConfiguration: {},
};

function stateWith(properties: Record<string, unknown>): { state: StackState; etag: string } {
  const record: ResourceState = {
    physicalId: 'rt-1',
    resourceType: RUNTIME,
    properties,
    observedProperties: structuredClone(BASELINE),
  };
  return {
    state: {
      version: 3,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: { Runtime: record },
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

async function runDrift(args: string[]): Promise<void> {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['TestStack', ...args], { from: 'user' });
  } catch {
    // The command exits through the stubbed `process.exit`.
  } finally {
    process.stdout.write = original;
  }
}

describe('undeclaredEmptyComparedDriftKeys (go-to-k/cdkd#6651)', () => {
  it('lists the four AgentCore runtime keys, not CapacityProviderConfiguration', () => {
    expect([...undeclaredEmptyComparedDriftKeys(RUNTIME)].sort()).toEqual([
      'FilesystemConfigurations',
      'HooksConfiguration',
      'RequestHeaderConfiguration',
      'ResourceConfigurations',
    ]);
  });

  it.each([['AWS::ECS::Cluster'], ['constructor'], ['__proto__']])(
    'lists nothing for %s',
    (resourceType) => {
      expect(undeclaredEmptyComparedDriftKeys(resourceType)).toEqual([]);
    }
  );
});

describe('cdkd drift on an AgentCore runtime key set outside cdkd (go-to-k/cdkd#6651)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockRegistryGetProvider.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('plain drift reports the listed key and not an unlisted captured-empty key', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      stateWith({ AgentRuntimeName: 'rt', RoleArn: BASELINE.RoleArn, PlatformVersion: 'V2' })
    );
    const update = vi.fn();
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        ...BASELINE,
        ResourceConfigurations: [{ MinimumMemoryInMiB: 4096 }],
        CapacityProviderConfiguration: { CapacityProviderArn: 'arn:cp' },
      }),
      update,
    });

    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const cmd = createDriftCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['TestStack', '--json'], { from: 'user' });
    } catch {
      // The command exits through the stubbed `process.exit`.
    } finally {
      process.stdout.write = original;
    }

    const report = written.join('');
    expect(report).toContain('ResourceConfigurations');
    expect(report).toContain('MinimumMemoryInMiB');
    expect(report).not.toContain('CapacityProviderConfiguration');
    expect(update).not.toHaveBeenCalled();
  });

  it('--revert sends the empty baseline for each listed key the template does not declare', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'rt-1' });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      stateWith({ AgentRuntimeName: 'rt', RoleArn: BASELINE.RoleArn, PlatformVersion: 'V2' })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        ...BASELINE,
        HooksConfiguration: { Build: { Warmup: { Action: { HttpPost: { Path: '/ping' } } } } },
        ResourceConfigurations: [{ MinimumMemoryInMiB: 4096 }],
        FilesystemConfigurations: [{ SessionStorage: { MountPath: '/mnt/data' } }],
        RequestHeaderConfiguration: { RequestHeaderAllowlist: ['X-Amzn-Probe'] },
      }),
      update,
    });

    await runDrift(['--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    const desired = update.mock.calls[0]![3] as Record<string, unknown>;
    expect(desired['HooksConfiguration']).toEqual({});
    expect(desired['ResourceConfigurations']).toEqual([]);
    expect(desired['FilesystemConfigurations']).toEqual([]);
    expect(desired['RequestHeaderConfiguration']).toEqual({});
  });

  it('a value AWS shows in an unlisted captured-empty key (CapacityProviderConfiguration) is still skipped', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'rt-1' });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      stateWith({ AgentRuntimeName: 'rt', RoleArn: BASELINE.RoleArn, PlatformVersion: 'V2' })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        ...BASELINE,
        CapacityProviderConfiguration: { CapacityProviderArn: 'arn:cp' },
      }),
      update,
    });

    await runDrift(['--revert', '--yes']);

    expect(update).not.toHaveBeenCalled();
  });
});
