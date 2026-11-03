import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#5707: `cdkd drift --revert` tells a provider which top-level
 * properties the record's TEMPLATE side declares `true`, by NAME only. A
 * DBCluster's readback baseline can hold `EnableHttpEndpoint: true` for a Data
 * API turned on outside the template; only a template declaring it licenses a
 * revert turning it back on.
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
  AwsClients: vi.fn().mockImplementation(() => ({
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
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: vi.fn(async () => '"etag-2"'),
  })),
}));

vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => undefined),
  })),
}));

const mockRegistryGetProvider = vi.fn<(resourceType: string) => unknown>();
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
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
  CloudControlProvider: vi.fn().mockImplementation(() => ({
    readCurrentState: vi.fn(async () => undefined),
  })),
}));

import { createDriftCommand, declaredTrueProperties } from '../../../src/cli/commands/drift.js';

describe('declaredTrueProperties (go-to-k/cdkd#5707)', () => {
  it.each([
    ['true', true],
    ["'true'", 'true'],
  ])('a declared %s is in the set', (_l, value) => {
    expect(declaredTrueProperties({ Engine: 'aurora-mysql', EnableHttpEndpoint: value })).toEqual(
      new Set(['EnableHttpEndpoint'])
    );
  });

  it.each([
    ['false', false],
    ["'false'", 'false'],
    ["'True'", 'True'],
    ["'yes'", 'yes'],
    ['1', 1],
    ['the NoEcho mask', '***'],
    ['a dynamic reference', '{{resolve:ssm:/p}}'],
    ['null', null],
    ['an intrinsic object', { 'Fn::If': ['C', true, false] }],
    ['a nested true', { Enabled: true }],
    ['a list holding true', [true]],
  ])('a declared %s is not in the set', (_l, value) => {
    expect(declaredTrueProperties({ EnableHttpEndpoint: value }).size).toBe(0);
  });

  it.each([undefined, null, 'x', [true]])('a non-object record (%s) declares nothing', (v) => {
    expect(declaredTrueProperties(v).size).toBe(0);
  });
});

const CLUSTER = 'AWS::RDS::DBCluster';

function clusterRecord(templateDeclares: Record<string, unknown>): ResourceState {
  return {
    physicalId: 'c-1',
    resourceType: CLUSTER,
    properties: { Engine: 'aurora-mysql', ...templateDeclares },
    // The readback baseline holds the Data API ON whatever the template says.
    observedProperties: { Engine: 'aurora-mysql', EnableHttpEndpoint: true },
  };
}

function stateWith(record: ResourceState): { state: StackState; etag: string } {
  return {
    state: {
      version: 3,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: { Cluster: record },
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

async function runRevert(): Promise<void> {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['TestStack', '--revert', '--yes'], { from: 'user' });
  } catch {
    // The command exits through the stubbed `process.exit`.
  } finally {
    process.stdout.write = original;
  }
}

describe('cdkd drift --revert threads the template side to update() (go-to-k/cdkd#5707)', () => {
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

  it.each([
    ['declares EnableHttpEndpoint: true', { EnableHttpEndpoint: true }, ['EnableHttpEndpoint']],
    ['declares it false', { EnableHttpEndpoint: false }, []],
    ['does not declare it', {}, []],
  ])('a template that %s', async (_label, templateDeclares, expected) => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'c-1' });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(stateWith(clusterRecord(templateDeclares)));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ Engine: 'aurora-mysql', EnableHttpEndpoint: false }),
      update,
    });

    await runRevert();

    expect(update).toHaveBeenCalledTimes(1);
    // The desired bag is the readback baseline either way; only the template
    // side differs between the cases.
    expect((update.mock.calls[0]![3] as Record<string, unknown>)['EnableHttpEndpoint']).toBe(true);
    const context = update.mock.calls[0]![5] as {
      desiredFromAwsReadback?: boolean;
      declaredTrueProperties?: ReadonlySet<string>;
    };
    expect(context.desiredFromAwsReadback).toBe(true);
    expect(context.declaredTrueProperties).toEqual(new Set(expected));
  });
});
