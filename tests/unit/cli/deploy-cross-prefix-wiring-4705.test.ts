import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#4705: the REAL `cdkd deploy` code path wires the cross-prefix
 * checks into each stack's engine: `onCurrentStateLoaded` (first deploy),
 * `onDestructivePlan` and `crossPrefixHolder`, all over the scan deploy.ts
 * started for that stack, in the region the engine is given
 * (`deployStackRegion` at both call sites). Harness copied from
 * `deploy-cross-region-stack-scope.test.ts`; the engine is mocked and calls the
 * options it was handed.
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
  loadCdkJson: vi.fn(() => null),
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

const scanCalls = vi.hoisted(() => ({ own: [] as string[][], probes: [] as string[][], lists: 0 }));
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    prefix: 'cdkd',
    verifyBucketExists: vi.fn(async () => undefined),
    listStacks: vi.fn(async () => []),
    getState: vi.fn(async () => null),
    ownRecordExists: vi.fn(async (stack: string, region: string) => {
      scanCalls.own.push([stack, region]);
      return false;
    }),
    listTopLevelPrefixes: vi.fn(async () => {
      scanCalls.lists++;
      return ['cdkd', 'team-b'];
    }),
    recordUnderPrefix: vi.fn(async (prefix: string, stack: string, region: string) => {
      scanCalls.probes.push([prefix, stack, region]);
      return prefix === 'team-b' ? 'holder' : 'absent';
    }),
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

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
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

interface Seen {
  engineRegion: string;
  firstDeploy: string;
  destructive: string;
  holder: unknown;
  loadedRecordSkipped: boolean;
}
const seen = vi.hoisted(() => new Map<string, Seen>());

vi.mock('../../../src/deployment/deploy-engine.js', () => ({
  DeployEngine: vi.fn().mockImplementation((...args: unknown[]) => {
    const options = args[5] as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const engineRegion = args[6] as string;
    return {
      deploy: vi.fn(async (stackName: string) => {
        const outcome = async (fn: () => Promise<unknown>): Promise<string> =>
          fn().then(
            () => 'passed',
            (e: Error) => e.message
          );
        seen.set(stackName, {
          engineRegion,
          firstDeploy: await outcome(() => options['onCurrentStateLoaded']!(stackName, undefined)),
          destructive: await outcome(() => options['onDestructivePlan']!(stackName, [])),
          holder: await options['crossPrefixHolder']!(stackName),
          loadedRecordSkipped:
            (await outcome(() =>
              options['onCurrentStateLoaded']!(stackName, { resources: {} } as never)
            )) === 'passed',
        });
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
    };
  }),
}));

const synthStacks = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn(async () => ({ stacks: synthStacks.value })),
    expandMacrosForStacks: vi.fn(async () => undefined),
  })),
  synthesisStatusMessage: vi.fn((_app: string, msg: string) => msg),
}));

vi.mock('../../../src/synthesis/stack-messages.js', () => ({
  processStackMessages: vi.fn(),
}));

function makeStack(stackName: string, region?: string) {
  return {
    stackName,
    displayName: stackName,
    artifactId: stackName,
    template: { Resources: {} },
    dependencyNames: [],
    ...(region !== undefined && { region }),
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

describe('cdkd deploy wires the cross-prefix checks into each engine (go-to-k/cdkd#4705)', () => {
  beforeEach(() => {
    for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION', 'CDKD_NO_LIVE']) {
      savedEnv[key] = process.env[key];
    }
    process.env['AWS_REGION'] = BASE_REGION;
    process.env['AWS_DEFAULT_REGION'] = BASE_REGION;
    process.env['CDKD_NO_LIVE'] = '1';
    seen.clear();
    scanCalls.own.length = 0;
    scanCalls.probes.length = 0;
    scanCalls.lists = 0;
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

  it('first-deploy gate, destructive-plan gate and settle holder all act on the stack scan, in the engine region', async () => {
    synthStacks.value = [makeStack('HereStack'), makeStack('ThereStack', 'eu-west-1')];

    await runDeploy(['--all', '--yes']);

    expect([...seen.keys()].sort()).toEqual(['HereStack', 'ThereStack']);
    for (const [stackName, region] of [
      ['HereStack', BASE_REGION],
      ['ThereStack', 'eu-west-1'],
    ] as const) {
      const s = seen.get(stackName)!;
      // deployStackRegion at both call sites: the engine region IS the region scanned.
      expect(s.engineRegion, stackName).toBe(region);
      expect(scanCalls.own, stackName).toContainEqual([stackName, region]);
      expect(scanCalls.probes, stackName).toContainEqual(['team-b', stackName, region]);
      expect(s.firstDeploy, stackName).toMatch(/Refusing to deploy stack .*is already recorded under another state prefix/);
      expect(s.destructive, stackName).toMatch(/this deploy deletes or replaces resources/);
      expect(s.holder, stackName).toMatchObject({ kind: 'unreadable' });
      expect(s.loadedRecordSkipped, stackName).toBe(true);
    }
    // One listing for the whole run, one scan per stack.
    expect(scanCalls.lists).toBe(1);
    expect(scanCalls.probes.filter((p) => p[1] === 'HereStack')).toHaveLength(1);
  });
});
