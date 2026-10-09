import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#4705: the REAL `cdkd deploy` code path wires the stack-registry
 * checks into each stack's engine: `onCurrentStateLoaded` (a first deploy
 * claims its marker), `onDestructivePlan` and `crossPrefixHolder`, all over
 * the run's ONE guard, in the region the engine is given (`deployStackRegion`
 * at both call sites). Harness copied from
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

const scanCalls = vi.hoisted(() => ({
  /** Every registry marker read, as [stack, region]. */
  reads: [] as string[][],
  /** Every marker claim, as [stack, region]. */
  claims: [] as string[][],
  probes: [] as string[][],
  lists: 0,
  /** The prefix every marker names, or null for none. */
  markerPrefix: null as string | null,
  /** Marker reads never settle until the client is destroyed. */
  readNever: false,
  /** Every backend deploy.ts built, in order: the first is the preflight one. */
  backends: [] as Array<{ destroyClient: ReturnType<typeof vi.fn>; reads: number }>,
}));
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => {
    // Like a real S3Client: destroying it rejects the requests still in flight.
    const aborts: Array<(e: Error) => void> = [];
    const backend = {
      prefix: 'cdkd',
      verifyBucketExists: vi.fn(async () => undefined),
      listStacks: vi.fn(async () => []),
      getState: vi.fn(async () => null),
      destroyClient: vi.fn(() => {
        for (const abort of aborts.splice(0)) abort(new Error('client destroyed'));
      }),
      reads: 0,
      getRegistryMarker: vi.fn(async (stack: string, region: string) => {
        scanCalls.reads.push([stack, region]);
        backend.reads++;
        if (scanCalls.readNever) {
          return new Promise<never>((_resolve, reject) => aborts.push(reject));
        }
        return scanCalls.markerPrefix === null
          ? null
          : { prefix: scanCalls.markerPrefix, etag: '"e"' };
      }),
      claimRegistryMarker: vi.fn(async (stack: string, region: string) => {
        scanCalls.claims.push([stack, region]);
        return 'claimed';
      }),
      lockUnderPrefix: vi.fn(async () => false),
      listTopLevelPrefixes: vi.fn(async () => {
        scanCalls.lists++;
        return ['cdkd', 'team-b'];
      }),
      recordUnderPrefix: vi.fn(async (prefix: string, stack: string, region: string) => {
        scanCalls.probes.push([prefix, stack, region]);
        return prefix === 'team-b' ? 'holder' : 'absent';
      }),
    };
    scanCalls.backends.push(backend);
    return backend;
  }),
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
  outcomes: Record<string, unknown>;
}
const seen = vi.hoisted(() => new Map<string, Seen>());
/** What the mock engine does with the options it was handed, per test. */
const scenario = vi.hoisted(() => ({
  value: 'first-deploy' as 'first-deploy' | 'redeploy' | 'fire-and-return',
}));

vi.mock('../../../src/deployment/deploy-engine.js', () => ({
  DeployEngine: vi.fn().mockImplementation((...args: unknown[]) => {
    const options = args[5] as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const engineRegion = args[6] as string;
    return {
      deploy: vi.fn(async (stackName: string) => {
        const outcome = async (fn: () => Promise<unknown>): Promise<unknown> =>
          fn().then(
            (v) => v ?? 'passed',
            (e: Error) => e.message
          );
        const outcomes: Record<string, unknown> = {};
        if (scenario.value === 'first-deploy') {
          // No record loaded, then a destructive plan, then a settle.
          outcomes['firstDeploy'] = await outcome(() =>
            options['onCurrentStateLoaded']!(stackName, undefined)
          );
          outcomes['destructive'] = await outcome(() => options['onDestructivePlan']!(stackName, []));
          outcomes['holder'] = await outcome(() => options['crossPrefixHolder']!(stackName));
        } else if (scenario.value === 'fire-and-return') {
          // The gate starts its marker read and the engine returns at once,
          // so the read is still pending when the command ends.
          void options['onCurrentStateLoaded']!(stackName, undefined).catch(() => undefined);
        } else if (scenario.value === 'redeploy') {
          // A record loaded and a plan with nothing destructive: the engine calls
          // only the state-loaded gate.
          outcomes['loaded'] = await outcome(() =>
            options['onCurrentStateLoaded']!(stackName, { resources: {} } as never)
          );
        }
        seen.set(stackName, { engineRegion, outcomes });
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
    scanCalls.reads.length = 0;
    scanCalls.claims.length = 0;
    scanCalls.probes.length = 0;
    scanCalls.lists = 0;
    scanCalls.markerPrefix = null;
    scanCalls.readNever = false;
    scanCalls.backends.length = 0;
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

  it('a first deploy under a marker naming another holding prefix: every gate refuses on ONE read per stack, in the engine region', async () => {
    scenario.value = 'first-deploy';
    scanCalls.markerPrefix = 'team-b';
    synthStacks.value = [makeStack('HereStack'), makeStack('ThereStack', 'eu-west-1')];

    await runDeploy(['--all', '--yes']);

    expect([...seen.keys()].sort()).toEqual(['HereStack', 'ThereStack']);
    for (const [stackName, region] of [
      ['HereStack', BASE_REGION],
      ['ThereStack', 'eu-west-1'],
    ] as const) {
      const s = seen.get(stackName)!;
      // deployStackRegion at both call sites: the engine region IS the region read.
      expect(s.engineRegion, stackName).toBe(region);
      expect(scanCalls.reads.filter((r) => r[0] === stackName), stackName).toEqual([[stackName, region]]);
      expect(scanCalls.probes.filter((p) => p[1] === stackName), stackName).toEqual([
        ['team-b', stackName, region],
      ]);
      expect(String(s.outcomes['firstDeploy']), stackName).toMatch(
        /Refusing to deploy stack .*is already recorded under another state prefix/
      );
      expect(String(s.outcomes['destructive']), stackName).toMatch(/this deploy deletes or replaces resources/);
      expect(s.outcomes['holder'], stackName).toMatchObject({ kind: 'unreadable' });
    }
    // No prefix scan, and nothing claimed over another prefix's holder.
    expect(scanCalls.lists).toBe(0);
    expect(scanCalls.claims).toEqual([]);
  });

  it('a first deploy with no marker claims one per stack, in the engine region, and scans nothing', async () => {
    scenario.value = 'first-deploy';
    synthStacks.value = [makeStack('HereStack'), makeStack('ThereStack', 'eu-west-1')];

    await runDeploy(['--all', '--yes']);

    expect(scanCalls.claims.sort()).toEqual([
      ['HereStack', BASE_REGION],
      ['ThereStack', 'eu-west-1'],
    ]);
    expect(seen.get('HereStack')!.outcomes['firstDeploy']).toBe('passed');
    expect(scanCalls.lists).toBe(0);
    expect(scanCalls.probes).toEqual([]);
  });

  it('a dry-run first deploy reads but claims nothing', async () => {
    scenario.value = 'first-deploy';
    synthStacks.value = [makeStack('HereStack')];

    await runDeploy(['--all', '--yes', '--dry-run']);

    expect(scanCalls.claims).toEqual([]);
  });

  it('a redeploy with a non-destructive plan makes no registry request at all', async () => {
    scenario.value = 'redeploy';
    synthStacks.value = [makeStack('HereStack')];

    await runDeploy(['--all', '--yes']);

    expect(seen.get('HereStack')!.outcomes['loaded']).toBe('passed');
    expect(scanCalls.reads).toEqual([]);
    expect(scanCalls.claims).toEqual([]);
    expect(scanCalls.lists).toBe(0);
    expect(scanCalls.probes).toEqual([]);
  });

  it("destroys the preflight backend's client at command end, while a marker read is still pending", async () => {
    scenario.value = 'fire-and-return';
    scanCalls.readNever = true;
    synthStacks.value = [makeStack('HereStack')];
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await runDeploy(['--all', '--yes']);
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.removeListener('unhandledRejection', unhandled);
    }
    // A first deploy's marker read was started on the PREFLIGHT backend (the
    // first one built) and was still pending when the command ended.
    const preflight = scanCalls.backends[0]!;
    expect(preflight.reads).toBeGreaterThan(0);
    expect(scanCalls.backends.slice(1).every((b) => b.reads === 0)).toBe(true);
    // That backend's client is destroyed at command end, which rejects the
    // pending probe; the scan absorbs it, so nothing is unhandled.
    expect(preflight.destroyClient).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
