import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Issue [#1981](https://github.com/go-to-k/cdkd/issues/1981) — two stacks in
 * DIFFERENT regions deployed concurrently (the default `--stack-concurrency`
 * is 4) must each see their OWN region's clients for the whole of their
 * deploy, including after an `await` during which the other stack started.
 *
 * `deploy.ts` used to re-point the process-global `setAwsClients` singleton
 * and `process.env.AWS_REGION` per stack, so whichever stack started LAST won
 * for both. This drives the REAL command with REAL `aws-clients.ts` /
 * `aws-client-defaults.ts` / `stack-aws-scope.ts` modules, and a mocked engine
 * whose `deploy()` parks until BOTH stacks are inside it, then records the
 * three doors a provider reads its region through:
 *
 * - `getAwsClients()` — the call-time singleton read most providers make;
 * - `ambientRegion()` — what replaced `process.env['AWS_REGION']` in them;
 * - an SDK client built from `awsClientDefaults()` with no region of its own —
 *   the lazily constructed client a provider builds for itself.
 *
 * The barrier is what makes the interleaving deterministic: without it the
 * first stack could finish before the second started and the race would never
 * be exercised.
 */

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn(async () => ({ Account: '111122223333' })),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn(),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveApp: vi.fn(() => 'fake-app-cmd'),
  resolveCaptureObservedState: vi.fn(() => false),
  resolveAutoAssetStorage: vi.fn(() => false),
  resolveSkipPrefix: vi.fn(() => false),
  resolveStateBucketWithDefaultAndSource: vi.fn(async () => ({
    bucket: 'test-bucket',
    source: 'default',
  })),
  stateBucketExistenceConfirmed: vi.fn(() => true),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
  warnDeprecatedNoPrefixCliFlag: vi.fn(),
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    verifyBucketExists: vi.fn(async () => undefined),
    listStacks: vi.fn(async () => []),
    getState: vi.fn(async () => null),
  })),
}));

vi.mock('../../../src/state/export-index-store.js', () => ({
  ExportIndexStore: vi.fn().mockImplementation(() => ({})),
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

/**
 * Records the region a provider CONSTRUCTED in `registerAllProviders` would
 * capture — the `providerRegion = ambientRegion()` field initializers run
 * exactly here, synchronously, inside the stack's scope.
 */
const registeredRegions = vi.hoisted(() => [] as (string | undefined)[]);
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(() => {
    // A mock factory cannot `await import(...)` synchronously, so the real
    // module is handed in through `scopeModule`, primed in `beforeEach`.
    registeredRegions.push(scopeModule.value?.ambientRegion());
  }),
}));

const scopeModule = vi.hoisted(() => ({
  value: undefined as undefined | { ambientRegion: () => string | undefined },
}));

vi.mock('../../../src/provisioning/resource-timeout-registry.js', () => ({
  setResolvedResourceTimeouts: vi.fn(),
}));

vi.mock('../../../src/provisioning/nested-stack-context.js', () => ({
  withNestedStackContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../../src/analyzer/dag-builder.js', () => ({
  DagBuilder: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/analyzer/diff-calculator.js', () => ({
  DiffCalculator: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/assets/asset-publisher.js', () => ({
  AssetPublisher: vi.fn().mockImplementation(() => ({
    addAssetsToGraph: vi.fn(() => [] as string[]),
    executeNode: vi.fn(async () => undefined),
  })),
}));

vi.mock('../../../src/assets/asset-storage.js', () => ({
  AssetModeResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(async () => ({ mode: 'legacy' })),
  })),
}));

vi.mock('../../../src/assets/asset-redirect.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, loadPublishableAssetManifest: vi.fn(() => null) };
});

vi.mock('../../../src/cli/commands/prefix-migration-check.js', () => ({
  createPrefixMigrationGate: vi.fn(() => undefined),
}));

vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: vi.fn(() => undefined),
  recordRunOutcome: vi.fn(),
  recordRunFailed: vi.fn(),
}));

interface Observation {
  clientsRegion: string | undefined;
  ambientRegion: string | undefined;
  sdkClientRegion: string;
  envRegion: string | undefined;
}

const observations = vi.hoisted(() => new Map<string, Observation>());
const barrier = vi.hoisted(() => ({
  expected: 0,
  arrived: 0,
  release: undefined as undefined | (() => void),
  gate: undefined as undefined | Promise<void>,
}));

vi.mock('../../../src/deployment/deploy-engine.js', () => ({
  DeployEngine: vi.fn().mockImplementation(() => ({
    deploy: vi.fn(async (stackName: string) => {
      barrier.arrived++;
      if (barrier.arrived === barrier.expected) barrier.release?.();
      // Park until EVERY stack has entered its deploy: from here on, each
      // stack's setup (and, before #1981, its global switch) has run.
      await barrier.gate;
      const { getAwsClients } = await import('../../../src/utils/aws-clients.js');
      const { awsClientDefaults } = await import('../../../src/utils/aws-client-defaults.js');
      const { ambientRegion } = await import('../../../src/utils/stack-aws-scope.js');
      const { SQSClient } = await import('@aws-sdk/client-sqs');
      // Built with NO region of its own, the way a provider builds a client
      // lazily inside `create()`. Never sent: region resolution is local.
      const client = new SQSClient({ ...awsClientDefaults() });
      observations.set(stackName, {
        clientsRegion: getAwsClients().configuredRegion,
        ambientRegion: ambientRegion(),
        sdkClientRegion: await client.config.region(),
        envRegion: process.env['AWS_REGION'],
      });
      client.destroy();
      return {
        stackName,
        created: 0,
        updated: 0,
        deleted: 0,
        deleteSkipped: 0,
        updatePartial: 0,
        unchanged: 0,
        durationMs: 1,
        outputs: {},
        attributeFallbackCount: 0,
      };
    }),
  })),
}));

const synthStacks = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn(async () => ({ stacks: synthStacks.value, failedStages: [] })),
    expandMacrosForStacks: vi.fn(async () => undefined),
  })),
  synthesisStatusMessage: vi.fn((_app: string, msg: string) => msg),
}));

vi.mock('../../../src/synthesis/stack-messages.js', () => ({
  processStackMessages: vi.fn(),
}));

function makeStack(stackName: string, region: string) {
  return {
    stackName,
    displayName: stackName,
    artifactId: stackName,
    template: { Resources: {} },
    dependencyNames: [],
    region,
  };
}

async function runDeploy(argv: string[]): Promise<number | undefined> {
  const { createDeployCommand } = await import('../../../src/cli/commands/deploy.js');
  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('__process_exit__');
  }) as never);
  try {
    await createDeployCommand().parseAsync(['node', 'cdkd', ...argv]);
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__process_exit__') throw err;
  } finally {
    exitSpy.mockRestore();
  }
  return exitCode;
}

const BASE_REGION = 'ap-northeast-1';
const savedEnv: Record<string, string | undefined> = {};

describe('cross-region stacks deployed concurrently keep their own region (#1981)', () => {
  beforeEach(async () => {
    for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION', 'CDKD_NO_LIVE']) {
      savedEnv[key] = process.env[key];
    }
    process.env['AWS_REGION'] = BASE_REGION;
    process.env['AWS_DEFAULT_REGION'] = BASE_REGION;
    process.env['CDKD_NO_LIVE'] = '1';
    observations.clear();
    registeredRegions.length = 0;
    scopeModule.value = await import('../../../src/utils/stack-aws-scope.js');
    barrier.arrived = 0;
    barrier.gate = new Promise<void>((resolve) => {
      barrier.release = resolve;
    });
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const { resetAwsClients } = await import('../../../src/utils/aws-clients.js');
    resetAwsClients();
    vi.clearAllMocks();
  });

  it('gives each concurrent stack its own clients, ambient region and SDK default region', async () => {
    synthStacks.value = [makeStack('EastStack', 'us-east-1'), makeStack('WestStack', 'eu-west-1')];
    barrier.expected = 2;

    const code = await runDeploy(['--all', '--yes']);
    expect(code).toBeUndefined();

    // Floor: both stacks reached the observation point, so the comparisons
    // below are not vacuous over a missing entry.
    expect([...observations.keys()].sort()).toEqual(['EastStack', 'WestStack']);

    for (const [stackName, region] of [
      ['EastStack', 'us-east-1'],
      ['WestStack', 'eu-west-1'],
    ] as const) {
      const seen = observations.get(stackName)!;
      expect(seen.clientsRegion, `${stackName}: getAwsClients()`).toBe(region);
      expect(seen.ambientRegion, `${stackName}: ambientRegion()`).toBe(region);
      expect(seen.sdkClientRegion, `${stackName}: region-less SDK client`).toBe(region);
    }
  });

  it('captures each stack region in providers constructed at registration', async () => {
    synthStacks.value = [makeStack('EastStack', 'us-east-1'), makeStack('WestStack', 'eu-west-1')];
    barrier.expected = 2;

    await runDeploy(['--all', '--yes']);

    expect([...registeredRegions].sort()).toEqual(['eu-west-1', 'us-east-1']);
  });

  it('leaves the process-wide AWS_REGION and the global clients alone', async () => {
    // The env var is shared by every stack in flight, so the fix must not
    // write it at all: a stack reading it (outside the scope's doors) would
    // otherwise still see a sibling's region.
    synthStacks.value = [makeStack('EastStack', 'us-east-1'), makeStack('WestStack', 'eu-west-1')];
    barrier.expected = 2;

    await runDeploy(['--all', '--yes']);

    for (const stackName of ['EastStack', 'WestStack']) {
      expect(observations.get(stackName)!.envRegion, stackName).toBe(BASE_REGION);
    }
    expect(process.env['AWS_REGION']).toBe(BASE_REGION);
  });
});
