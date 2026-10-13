import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#2100: a bare `cdkd deploy` (no `--region`, no `AWS_REGION`)
 * under a profile whose region is not us-east-1.
 *
 * Before the fix the region VALUE fell back to a `us-east-1` literal while the
 * command's region-less clients followed the profile. Now the value follows
 * the profile too — and an env-agnostic stack whose state the OLD default
 * wrote is HELD on us-east-1, so the upgrade never looks under a key nothing
 * wrote and re-creates the stack. These cases pin, on the real command path,
 * that the state-key region (the engine's), the state-bucket legacy name and
 * the exports-index region agree, in both polarities of the reconciliation.
 * Harness copied from `deploy-cross-prefix-wiring-4705.test.ts`.
 */

const logged = vi.hoisted(() => ({ info: [] as string[] }));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn((m: string) => logged.info.push(String(m))),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

/** The region the AWS SDK's own chain answers (the profile's `region =`). */
const profile = vi.hoisted(() => ({ region: 'ap-northeast-1' as string | undefined }));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    config: {
      region: async (): Promise<string> => {
        if (!profile.region) throw new Error('Region is missing');
        return profile.region;
      },
    },
    send: vi.fn(async () => ({ Account: '111122223333' })),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn(),
}));

const bucketCalls = vi.hoisted(() => ({ args: [] as unknown[][] }));
vi.mock('../../../src/cli/config-loader.js', () => ({
  loadCdkJson: vi.fn(() => null),
  resolveApp: vi.fn(() => 'fake-app-cmd'),
  resolveCaptureObservedState: vi.fn(() => false),
  resolveAutoAssetStorage: vi.fn(() => false),
  resolveSkipPrefix: vi.fn(() => false),
  resolveStateBucketWithDefaultAndSource: vi.fn(async (...args: unknown[]) => {
    bucketCalls.args.push(args);
    return { bucket: 'test-bucket', source: 'default' };
  }),
  stateBucketExistenceConfirmed: vi.fn(() => true),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
  warnDeprecatedNoPrefixCliFlag: vi.fn(),
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

/** Which (stack, region) pairs have state, and which regions have an index. */
const world = vi.hoisted(() => ({
  state: new Set<string>(),
  indexRegions: new Set<string>(),
  stateProbes: [] as string[][],
}));
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    prefix: 'cdkd',
    verifyBucketExists: vi.fn(async () => undefined),
    listStacks: vi.fn(async () => []),
    getState: vi.fn(async () => null),
    destroyClient: vi.fn(),
    stateExistsOwnedBy: vi.fn(async (stack: string, region: string) => {
      world.stateProbes.push([stack, region]);
      return world.state.has(`${stack}/${region}`);
    }),
    rawObjectExists: vi.fn(async (key: string) => {
      const m = /^cdkd\/_index\/([^/]+)\/exports\.json$/.exec(key);
      return m !== null && world.indexRegions.has(m[1]!);
    }),
    getRegistryMarker: vi.fn(async () => null),
    claimRegistryMarker: vi.fn(async () => 'claimed'),
    lockUnderPrefix: vi.fn(async () => false),
    listTopLevelPrefixes: vi.fn(async () => ['cdkd']),
    recordUnderPrefix: vi.fn(async () => 'absent'),
  })),
}));

const indexRegions = vi.hoisted(() => ({ value: [] as string[] }));
/** Every `removeStack` / `removeStackIfPresent`, as [file, stack, region]. */
const indexRemovals = vi.hoisted(() => [] as string[][]);
type NestedCtx = { exportIndexStore: { removeStack(s: string, r: string): Promise<void> } };
/** The nested-stack context each stack's deploy ran under. */
const nestedContexts = vi.hoisted(() => [] as NestedCtx[]);
vi.mock('../../../src/state/export-index-store.js', () => ({
  ExportIndexStore: vi.fn().mockImplementation((...args: unknown[]) => {
    indexRegions.value.push(args[3] as string);
    return {
      indexRegion: args[3],
      removeStack: async (stack: string, region: string) => {
        indexRemovals.push([args[3] as string, stack, region]);
      },
      removeStackIfPresent: async (stack: string, region: string) => {
        indexRemovals.push([`${args[3] as string} (if present)`, stack, region]);
      },
    };
  }),
}));

vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn(),
    settleDeferredPurges: vi.fn().mockResolvedValue(undefined),
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
  withNestedStackContext: vi.fn(async (ctx: unknown, fn: () => Promise<unknown>) => {
    nestedContexts.push(ctx as NestedCtx);
    return fn();
  }),
}));

vi.mock('../../../src/analyzer/dag-builder.js', () => ({
  DagBuilder: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/analyzer/diff-calculator.js', () => ({
  DiffCalculator: vi.fn().mockImplementation(() => ({})),
}));

/** Every asset region the run used: the marker read, and the publish nodes. */
const assets = vi.hoisted(() => ({ modeRegions: [] as string[], publishRegions: [] as string[] }));
vi.mock('../../../src/assets/asset-publisher.js', () => ({
  AssetPublisher: vi.fn().mockImplementation(() => ({
    addAssetsToGraph: vi.fn((_graph: unknown, _path: string, opts: { region: string }) => {
      assets.publishRegions.push(opts.region);
      return [] as string[];
    }),
    executeNode: vi.fn(async () => undefined),
  })),
}));

vi.mock('../../../src/assets/asset-storage.js', () => ({
  AssetModeResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(async (region: string) => {
      assets.modeRegions.push(region);
      return { mode: 'legacy' };
    }),
  })),
}));

vi.mock('../../../src/assets/asset-redirect.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // A stack with an `assetManifestPath` has something to publish.
  return { ...actual, loadPublishableAssetManifest: vi.fn(() => ({ files: {}, dockerImages: {} })) };
});

vi.mock('../../../src/cli/commands/prefix-migration-check.js', () => ({
  createPrefixMigrationGate: vi.fn(() => undefined),
}));

vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: vi.fn(() => undefined),
  recordRunOutcome: vi.fn(),
  recordRunFailed: vi.fn(),
}));

/** The region each stack's engine was given — the state-key region. */
const engineRegions = vi.hoisted(() => new Map<string, string>());
/** The exports-index file each stack's engine reads and writes. */
const engineIndexRegions = vi.hoisted(() => new Map<string, string>());
vi.mock('../../../src/deployment/deploy-engine.js', () => ({
  DeployEngine: vi.fn().mockImplementation((...args: unknown[]) => {
    const engineRegion = args[6] as string;
    const indexRegion = (args[7] as { indexRegion?: string } | undefined)?.indexRegion;
    return {
      deploy: vi.fn(async (stackName: string) => {
        engineRegions.set(stackName, engineRegion);
        if (indexRegion !== undefined) engineIndexRegions.set(stackName, indexRegion);
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

function makeStack(stackName: string, region?: string, opts: { assets?: boolean } = {}) {
  return {
    stackName,
    displayName: stackName,
    artifactId: stackName,
    template: { Resources: {} },
    dependencyNames: [],
    ...(region !== undefined && { region }),
    ...(opts.assets && { assetManifestPath: `/fake/${stackName}.assets.json` }),
  };
}

async function runDeploy(argv: string[]): Promise<void> {
  const { createDeployCommand } = await import('../../../src/cli/commands/deploy.js');
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('__process_exit__');
  }) as never);
  try {
    await createDeployCommand().parseAsync(['node', 'cdkd', ...argv]);
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__process_exit__') throw err;
  } finally {
    exitSpy.mockRestore();
  }
}

const savedEnv: Record<string, string | undefined> = {};

describe('a bare cdkd deploy under a non-us-east-1 profile (go-to-k/cdkd#2100)', () => {
  beforeEach(() => {
    for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION', 'CDKD_NO_LIVE']) {
      savedEnv[key] = process.env[key];
    }
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
    process.env['CDKD_NO_LIVE'] = '1';
    profile.region = 'ap-northeast-1';
    world.state.clear();
    world.indexRegions.clear();
    world.stateProbes.length = 0;
    engineRegions.clear();
    engineIndexRegions.clear();
    indexRegions.value.length = 0;
    indexRemovals.length = 0;
    nestedContexts.length = 0;
    bucketCalls.args.length = 0;
    logged.info.length = 0;
    assets.modeRegions.length = 0;
    assets.publishRegions.length = 0;
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

  it('a FIRST deploy goes to the profile region: state key, assets, bucket name and index agree', async () => {
    // Old key absent. Pre-fix the engine got 'us-east-1' here.
    synthStacks.value = [makeStack('NewStack', undefined, { assets: true })];
    await runDeploy(['NewStack', '--yes']);

    expect(engineRegions.get('NewStack')).toBe('ap-northeast-1');
    expect(assets.modeRegions).toEqual(['ap-northeast-1']);
    expect(assets.publishRegions).toEqual(['ap-northeast-1']);
    // The run's own region: no per-stack region annotation.
    expect(logged.info.some((m) => m.includes('(region: '))).toBe(false);
    // The legacy bucket name is built from the profile region, with the old
    // default's name as the second candidate.
    expect(bucketCalls.args).toEqual([[undefined, 'ap-northeast-1', 'us-east-1']]);
    expect(indexRegions.value).toEqual(['ap-northeast-1']);
    expect(logged.info.some((m) => m.includes('Continuing to use us-east-1'))).toBe(false);
  });

  it('an EXISTING stack the old default wrote is HELD on us-east-1 — engine, assets, report — and says so', async () => {
    // Old key present: the upgrade path. Moving it would re-create every
    // resource and orphan the us-east-1 stack from its own state.
    world.state.add('OldStack/us-east-1');
    world.indexRegions.add('us-east-1');
    synthStacks.value = [makeStack('OldStack', undefined, { assets: true })];
    await runDeploy(['OldStack', '--yes']);

    expect(engineRegions.get('OldStack')).toBe('us-east-1');
    // The asset loop reads the SAME answer: a held stack's assets must not be
    // published to the profile's region while its resources stay in us-east-1.
    expect(assets.modeRegions).toEqual(['us-east-1']);
    expect(assets.publishRegions).toEqual(['us-east-1']);
    // ...and the run REPORTS the region it deploys in.
    expect(logged.info.some((m) => m.includes('OldStack') && m.includes('(region: us-east-1)'))).toBe(
      true
    );
    expect(indexRegions.value).toEqual(['us-east-1']);
    expect(logged.info.filter((m) => m.includes('Continuing to use us-east-1'))).toHaveLength(1);
    // Probed once per stack although two loops read the answer.
    expect(world.stateProbes).toEqual([
      ['OldStack', 'ap-northeast-1'],
      ['OldStack', 'us-east-1'],
    ]);
  });

  it('a stack already in the profile region (only) stays there, silently', async () => {
    world.state.add('Moved/ap-northeast-1');
    synthStacks.value = [makeStack('Moved')];
    await runDeploy(['Moved', '--yes']);
    expect(engineRegions.get('Moved')).toBe('ap-northeast-1');
    expect(logged.info.some((m) => m.includes('Continuing to use us-east-1'))).toBe(false);
  });

  it('a stack with state in BOTH regions keeps the us-east-1 one and names both', async () => {
    // Two deployments; the one a bare deploy meant before #2100 is us-east-1.
    world.state.add('Twin/ap-northeast-1');
    world.state.add('Twin/us-east-1');
    synthStacks.value = [makeStack('Twin')];
    await runDeploy(['Twin', '--yes']);
    expect(engineRegions.get('Twin')).toBe('us-east-1');
    expect(logged.info.some((m) => m.includes('has state in both us-east-1 and ap-northeast-1'))).toBe(
      true
    );
  });

  it('a NEW stack added to an app held on us-east-1 joins it there; a pinned stack is never probed', async () => {
    // Splitting the app would hand the new stack's Fn::ImportValue the held
    // stack's us-east-1 ids from the profile's region.
    world.state.add('Old/us-east-1');
    synthStacks.value = [makeStack('Old'), makeStack('Fresh'), makeStack('Pinned', 'eu-west-1')];
    await runDeploy(['--all', '--yes']);

    expect(Object.fromEntries(engineRegions)).toEqual({
      Old: 'us-east-1',
      Fresh: 'us-east-1',
      Pinned: 'eu-west-1',
    });
    expect(world.stateProbes.some(([stack]) => stack === 'Pinned')).toBe(false);
    expect(logged.info.some((m) => m.includes('so the app stays in one region'))).toBe(true);
  });

  describe('ONE exports-index file per command (review round 3)', () => {
    it("F1: with both index files present, EVERY stack uses the us-east-1 one", async () => {
      // The held stack's pre-upgrade entries are in us-east-1; a stack that
      // already moved shares the same file, so no stack writes where a
      // destroy will not look.
      world.state.add('Old/us-east-1');
      world.state.add('Moved/ap-northeast-1');
      world.indexRegions.add('ap-northeast-1');
      world.indexRegions.add('us-east-1');
      synthStacks.value = [makeStack('Old'), makeStack('Moved')];
      await runDeploy(['--all', '--yes']);
      expect(Object.fromEntries(engineIndexRegions)).toEqual({
        Old: 'us-east-1',
        Moved: 'us-east-1',
      });
      expect(indexRegions.value).toEqual(['us-east-1']);
    });

    it('F2: a PINNED producer and a held consumer read and write the SAME file', async () => {
      // A split (pinned to one file, held to another) let the consumer read a
      // pre-upgrade copy the producer's later deploys never updated.
      world.state.add('Consumer/us-east-1');
      world.indexRegions.add('us-east-1');
      world.indexRegions.add('ap-northeast-1');
      synthStacks.value = [makeStack('Producer', 'eu-west-1'), makeStack('Consumer')];
      await runDeploy(['--all', '--yes']);
      expect(engineIndexRegions.get('Producer')).toBe(engineIndexRegions.get('Consumer'));
      expect(engineIndexRegions.get('Consumer')).toBe('us-east-1');
      expect(engineRegions.get('Producer')).toBe('eu-west-1');
      expect(engineRegions.get('Consumer')).toBe('us-east-1');
    });

    it('R2-1: a mixed app shares one file, so a producer destroyed later leaves no copy elsewhere', async () => {
      world.state.add('Old/us-east-1');
      world.state.add('Moved/ap-northeast-1');
      world.indexRegions.add('us-east-1');
      synthStacks.value = [makeStack('Old'), makeStack('Moved'), makeStack('Fresh')];
      await runDeploy(['--all', '--yes']);
      expect(new Set(engineIndexRegions.values())).toEqual(new Set(['us-east-1']));
    });

    it('a nested child the deploy removes leaves BOTH candidate files under an inferred region (review R4-1)', async () => {
      // `NestedStackProvider` destroys a removed / replaced child through the
      // nested context's store; that store must clear the other file too.
      world.state.add('Parent/ap-northeast-1');
      world.indexRegions.add('us-east-1');
      world.indexRegions.add('ap-northeast-1');
      synthStacks.value = [makeStack('Parent')];
      await runDeploy(['Parent', '--yes']);
      expect(nestedContexts).toHaveLength(1);
      await nestedContexts[0]!.exportIndexStore.removeStack('Parent~Child', 'ap-northeast-1');
      expect(indexRemovals).toEqual([
        ['us-east-1', 'Parent~Child', 'ap-northeast-1'],
        ['ap-northeast-1 (if present)', 'Parent~Child', 'ap-northeast-1'],
      ]);
    });

    it("THE OTHER POLARITY: under a NAMED region the nested child leaves only the run's file", async () => {
      process.env['AWS_REGION'] = 'ap-northeast-1';
      world.indexRegions.add('us-east-1');
      world.indexRegions.add('ap-northeast-1');
      synthStacks.value = [makeStack('Parent')];
      await runDeploy(['Parent', '--yes']);
      await nestedContexts[0]!.exportIndexStore.removeStack('Parent~Child', 'ap-northeast-1');
      expect(indexRemovals).toEqual([['ap-northeast-1', 'Parent~Child', 'ap-northeast-1']]);
    });

    it('with no us-east-1 index, the profile region file is the one', async () => {
      world.indexRegions.add('ap-northeast-1');
      synthStacks.value = [makeStack('S')];
      await runDeploy(['S', '--yes']);
      expect(engineIndexRegions.get('S')).toBe('ap-northeast-1');
    });
  });

  it('deploying ONLY the new stack still sees its held sibling in the app', async () => {
    world.state.add('Old/us-east-1');
    synthStacks.value = [makeStack('Old'), makeStack('Fresh')];
    await runDeploy(['Fresh', '--yes']);
    expect(engineRegions.get('Fresh')).toBe('us-east-1');
    expect(engineRegions.has('Old')).toBe(false);
  });

  it('decides per stack in a MIXED app: held stays, moved stays, new follows the moved one', async () => {
    world.state.add('Old/us-east-1');
    world.state.add('Moved/ap-northeast-1');
    synthStacks.value = [makeStack('Old'), makeStack('Moved'), makeStack('Fresh')];
    await runDeploy(['--all', '--yes']);
    expect(Object.fromEntries(engineRegions)).toEqual({
      Old: 'us-east-1',
      Moved: 'ap-northeast-1',
      Fresh: 'ap-northeast-1',
    });
  });

  it('AWS_REGION is obeyed as named: no probe, no hold', async () => {
    process.env['AWS_REGION'] = 'ap-northeast-1';
    world.state.add('OldStack/us-east-1');
    synthStacks.value = [makeStack('OldStack')];
    await runDeploy(['OldStack', '--yes']);

    expect(engineRegions.get('OldStack')).toBe('ap-northeast-1');
    expect(world.stateProbes).toEqual([]);
    expect(bucketCalls.args).toEqual([[undefined, 'ap-northeast-1', undefined]]);
  });

  it('the account lookup and the state-bucket client use the resolved region (review G5)', async () => {
    const { STSClient } = await import('@aws-sdk/client-sts');
    synthStacks.value = [makeStack('S')];
    await runDeploy(['S', '--yes']);
    const regions = vi
      .mocked(STSClient)
      .mock.calls.map((c) => (c[0] as { region?: string } | undefined)?.region)
      .filter((r) => r !== undefined);
    expect(regions).toContain('ap-northeast-1');
    expect(regions).not.toContain('us-east-1');
  });

  it('AWS_DEFAULT_REGION (which the SDK ignores) drives the engine AND the SDK env (review B1)', async () => {
    process.env['AWS_DEFAULT_REGION'] = 'eu-west-1';
    synthStacks.value = [makeStack('S')];
    await runDeploy(['S', '--yes']);
    expect(engineRegions.get('S')).toBe('eu-west-1');
    expect(process.env['AWS_REGION']).toBe('eu-west-1');
  });

  it('with no profile region at all, the us-east-1 default is unchanged', async () => {
    profile.region = undefined;
    synthStacks.value = [makeStack('S')];
    await runDeploy(['S', '--yes']);
    expect(engineRegions.get('S')).toBe('us-east-1');
    expect(world.stateProbes).toEqual([]);
  });
});
