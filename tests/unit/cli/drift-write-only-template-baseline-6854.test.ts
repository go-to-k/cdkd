import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';

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
const routing = vi.hoisted(() => ({ provisionedBy: 'cc-api' as 'cc-api' | 'sdk' }));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({
    getProvider: mockRegistryGetProvider,
    getProviderFor: (input: { resourceType: string }) => ({
      provider: mockRegistryGetProvider(input.resourceType),
      provisionedBy: routing.provisionedBy,
    }),
    shouldSkipResource: () => false,
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

const fallback = vi.hoisted(() => ({ read: vi.fn<() => Promise<unknown>>(async () => undefined) }));
vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: vi.fn(() => ({
    readCurrentState: fallback.read,
  })),
}));

vi.mock('../../../src/provisioning/read-only-properties.js', () => ({
  getReadOnlyPropertyPaths: vi.fn(async () => []),
}));

const writeOnly = vi.hoisted(() => ({
  top: vi.fn<(type: string) => Promise<ReadonlySet<string> | undefined>>(),
  paths: vi.fn<(type: string) => ReadonlyArray<readonly string[]>>(),
}));
vi.mock('../../../src/provisioning/write-only-properties.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  tryGetTopLevelWriteOnlyProperties: writeOnly.top,
  getSettledWriteOnlyPropertyPaths: writeOnly.paths,
}));

import { createDriftCommand } from '../../../src/cli/commands/drift.js';
import { clearWriteOnlyDriftPathsCache } from '../../../src/cli/commands/drift/baseline-keys.js';

/**
 * go-to-k/cdkd#6854: a Cloud Control read never returns a write-only property,
 * so on a record compared against its template (no `observedProperties`) a
 * declared write-only key read as removed: drift on every run.
 * CloudFormation drift does not compare write-only properties. Those schema
 * paths are now left out on that baseline only; everything else is compared.
 */

const TYPE = 'AWS::Example::Thing';
const TEMPLATE = {
  Name: 'thing',
  Password: 'plain-template-value',
  Config: { Secret: 'nested-write-only', Mode: 'a' },
  Items: [{ Token: 't', Id: '1' }],
};
/** What Cloud Control returns: no write-only member anywhere. */
let live: Record<string, unknown> = {};

function stack(observed?: Record<string, unknown>): { state: StackState; etag: string } {
  const resource: ResourceState = {
    physicalId: 'thing',
    resourceType: TYPE,
    properties: structuredClone(TEMPLATE),
    ...(observed ? { observedProperties: observed } : {}),
  };
  return {
    state: {
      version: 3,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: { Subject: resource },
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let stdout = '';

async function runDrift(): Promise<{ code: number | undefined; paths: string[] }> {
  const original = process.stdout.write.bind(process.stdout);
  stdout = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  exitSpy.mockClear();
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['TestStack', '--json'], { from: 'user' });
  } catch {
    // The command exits through the stubbed `process.exit`.
  } finally {
    process.stdout.write = original;
  }
  const calls = exitSpy.mock.calls;
  const code = calls.length === 0 ? 0 : (calls[calls.length - 1]![0] as number | undefined);
  const [report] = JSON.parse(stdout) as Array<{ drifted: Array<{ changes: Array<{ path: string }> }> }>;
  return { code, paths: report!.drifted.flatMap((d) => d.changes.map((c) => c.path)).sort() };
}

function setUp(observed?: Record<string, unknown>): void {
  mockGetState.mockReset();
  mockListStacks.mockReset();
  mockRegistryGetProvider.mockReset();
  routing.provisionedBy = 'cc-api';
  live = { Name: 'thing', Config: { Mode: 'a' }, Items: [{ Id: '1' }] };
  mockRegistryGetProvider.mockImplementation(() => ({
    readCurrentState: async () => structuredClone(live),
  }));
  mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
  mockGetState.mockImplementation(async () => stack(observed));
  writeOnly.top.mockReset();
  writeOnly.paths.mockReset();
  clearWriteOnlyDriftPathsCache();
  fallback.read.mockReset();
  fallback.read.mockResolvedValue(undefined);
  // What the real lookup answers for these pointers: the CONTAINING
  // top-level name of each, `Config` and `Items` included.
  writeOnly.top.mockResolvedValue(new Set(['Password', 'Config', 'Items']));
  writeOnly.paths.mockReturnValue([['Password'], ['Config', 'Secret'], ['Items', '*', 'Token']]);
}

describe('cdkd drift: declared write-only properties on a template-only Cloud Control baseline (go-to-k/cdkd#6854)', () => {
  beforeEach(() => {
    setUp();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('a declared top-level or nested write-only key Cloud Control does not return is not drift', async () => {
    const { paths } = await runDrift();
    expect(paths).not.toContain('Password');
    expect(paths).not.toContain('Config.Secret');
  });

  it('a write-only path through a list stays compared (a dotted path cannot spell it)', async () => {
    const { paths } = await runDrift();
    expect(paths).toEqual(['Items']);
  });

  it('a changed key that is not write-only is still drift', async () => {
    live = { Name: 'other', Config: { Mode: 'b' }, Items: [{ Id: '1', Token: 't' }] };
    const { code, paths } = await runDrift();
    expect(code).toBe(1);
    expect(paths).toEqual(['Config.Mode', 'Name']);
  });

  it('an unreadable schema compares everything, as before', async () => {
    writeOnly.top.mockResolvedValue(undefined);
    const { paths } = await runDrift();
    expect(paths).toEqual(expect.arrayContaining(['Password', 'Config.Secret']));
  });

  it('an observed baseline is compared as before, without the lookup', async () => {
    setUp({ Name: 'thing', Config: { Mode: 'a' }, Items: [{ Id: '1' }] });
    const { code } = await runDrift();
    expect(code).toBe(0);
    expect(writeOnly.top).not.toHaveBeenCalled();
  });

  it('a Cloud Control fallback read (an SDK provider with no read) leaves them out too', async () => {
    routing.provisionedBy = 'sdk';
    mockRegistryGetProvider.mockImplementation(() => ({}));
    fallback.read.mockImplementation(async () => structuredClone(live));
    live = { Name: 'thing', Config: { Mode: 'b' }, Items: [{ Id: '1' }] };
    const { paths } = await runDrift();
    expect(paths).toEqual(['Config.Mode', 'Items']);
  });

  it('looks the type up once per process (one drift run)', async () => {
    await runDrift();
    await runDrift();
    expect(writeOnly.top).toHaveBeenCalledTimes(1);
  });

  it('an SDK provider read is compared as before, without the lookup', async () => {
    routing.provisionedBy = 'sdk';
    const { paths } = await runDrift();
    expect(paths).toEqual(expect.arrayContaining(['Password', 'Config.Secret']));
    expect(writeOnly.top).not.toHaveBeenCalled();
  });
});
