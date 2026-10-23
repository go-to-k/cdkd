import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  matchStacks,
  refuseStackNameRegionCollisions,
  stackNameRegionCollisions,
  stacksForDependency,
} from '../../../src/cli/stack-matcher.js';

/**
 * Issue [#5176](https://github.com/go-to-k/cdkd/issues/5176): a multi-region
 * app that deploys one CDK Stage per region under a SHARED explicit stackName
 * is two stacks, and the AWS CDK CLI deploys both. `cdkd deploy '**'` kept one
 * per physical name and deployed only the first region. Two selected stacks
 * sharing a name AND a region address one CloudFormation stack and are
 * refused before any engine runs.
 */

const errorSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: errorSpy,
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

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
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
  withNestedStackContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../../src/analyzer/dag-builder.js', () => ({
  DagBuilder: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/analyzer/diff-calculator.js', () => ({
  DiffCalculator: vi.fn().mockImplementation(() => ({})),
}));

/** Every `addAssetsToGraph` call's options, to read the node prefix and region. */
const assetGraphCalls = vi.hoisted(() => [] as { nodePrefix?: string; region: string }[]);
vi.mock('../../../src/assets/asset-publisher.js', () => ({
  AssetPublisher: vi.fn().mockImplementation(() => ({
    addAssetsToGraph: vi.fn(
      (_graph: unknown, _path: string, opts: { nodePrefix?: string; region: string }) => {
        assetGraphCalls.push(opts);
        return [] as string[];
      }
    ),
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
  // A manifest with something to publish, so every stack reaches the asset
  // node prefix.
  return { ...actual, loadPublishableAssetManifest: vi.fn(() => ({ files: {} })) };
});

vi.mock('../../../src/cli/commands/prefix-migration-check.js', () => ({
  createPrefixMigrationGate: vi.fn(() => undefined),
}));

vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: vi.fn(() => undefined),
  recordRunOutcome: vi.fn(),
  recordRunFailed: vi.fn(),
}));

/** Each engine deploy, in order, as `<stackName>@<region of its clients>`. */
const deployed = vi.hoisted(() => [] as string[]);
const engineConstructed = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../src/deployment/deploy-engine.js', () => ({
  DeployEngine: vi.fn().mockImplementation(() => {
    engineConstructed.count++;
    return {
      deploy: vi.fn(async (stackName: string) => {
        const { getAwsClients } = await import('../../../src/utils/aws-clients.js');
        deployed.push(`${stackName}@${getAwsClients().configuredRegion}`);
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

interface FakeStack {
  stackName: string;
  displayName: string;
  stagePath?: string;
  artifactId: string;
  template: { Resources: Record<string, unknown> };
  dependencyNames: string[];
  region?: string;
  assetManifestPath?: string;
}

function stageStack(
  stage: string,
  id: string,
  stackName: string,
  region: string | undefined,
  dependencyNames: string[] = []
): FakeStack {
  return {
    stackName,
    displayName: `${stage}/${id}`,
    stagePath: stage,
    artifactId: `${stage}${id}`,
    template: { Resources: {} },
    dependencyNames,
    ...(region !== undefined && { region }),
    assetManifestPath: `/tmp/${stage}${id}.assets.json`,
  };
}

async function runDeploy(argv: string[]): Promise<{ code: number | undefined; error?: Error }> {
  const { createDeployCommand } = await import('../../../src/cli/commands/deploy.js');
  let exitCode: number | undefined;
  errorSpy.mockClear();
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
  const printed = errorSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
  return { code: exitCode, ...(printed && { error: new Error(printed) }) };
}

const savedEnv: Record<string, string | undefined> = {};

describe('cdkd deploy over a stackName two regions share (#5176)', () => {
  beforeEach(() => {
    for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION', 'CDKD_NO_LIVE']) {
      savedEnv[key] = process.env[key];
    }
    process.env['AWS_REGION'] = 'eu-west-1';
    process.env['AWS_DEFAULT_REGION'] = 'eu-west-1';
    process.env['CDKD_NO_LIVE'] = '1';
    deployed.length = 0;
    assetGraphCalls.length = 0;
    engineConstructed.count = 0;
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

  it("deploys both regions' stacks for '**', each in its own region", async () => {
    synthStacks.value = [
      stageStack('UsEast', 'Api', 'Shared', 'us-east-1'),
      stageStack('UsWest', 'Api', 'Shared', 'us-west-2'),
    ];
    const { code } = await runDeploy(['**', '--yes']);
    expect(code).toBeUndefined();
    expect([...deployed].sort()).toEqual(['Shared@us-east-1', 'Shared@us-west-2']);
  });

  it('deploys both for the shared physical name itself', async () => {
    synthStacks.value = [
      stageStack('UsEast', 'Api', 'Shared', 'us-east-1'),
      stageStack('UsWest', 'Api', 'Shared', 'us-west-2'),
    ];
    await runDeploy(['Shared', '--yes']);
    expect([...deployed].sort()).toEqual(['Shared@us-east-1', 'Shared@us-west-2']);
  });

  it('deploys only the stack a CDK path names', async () => {
    synthStacks.value = [
      stageStack('UsEast', 'Api', 'Shared', 'us-east-1'),
      stageStack('UsWest', 'Api', 'Shared', 'us-west-2'),
    ];
    await runDeploy(['UsWest/Api', '--yes']);
    expect(deployed).toEqual(['Shared@us-west-2']);
  });

  it('gives each region its own asset nodes and asset region', async () => {
    synthStacks.value = [
      stageStack('UsEast', 'Api', 'Shared', 'us-east-1'),
      stageStack('UsWest', 'Api', 'Shared', 'us-west-2'),
    ];
    await runDeploy(['**', '--yes']);
    expect(
      assetGraphCalls.map((c) => `${c.nodePrefix ?? ''}|${c.region}`).sort()
    ).toEqual(['Shared@us-east-1:|us-east-1', 'Shared@us-west-2:|us-west-2']);
  });

  it('keeps the plain node prefix for a stack whose name nothing else shares', async () => {
    synthStacks.value = [stageStack('UsEast', 'Api', 'Solo', 'us-east-1')];
    await runDeploy(['**', '--yes']);
    expect(assetGraphCalls.map((c) => c.nodePrefix)).toEqual(['Solo:']);
  });

  it("auto-includes the dependency in the dependent's own Stage only", async () => {
    synthStacks.value = [
      stageStack('UsEast', 'Db', 'SharedDb', 'us-east-1'),
      stageStack('UsEast', 'Api', 'SharedApi', 'us-east-1', ['SharedDb']),
      stageStack('UsWest', 'Db', 'SharedDb', 'us-west-2'),
      stageStack('UsWest', 'Api', 'SharedApi', 'us-west-2', ['SharedDb']),
    ];
    await runDeploy(['UsWest/Api', '--yes']);
    // The producer deploys first (the edge resolved to the right node), and the
    // other region's producer is not pulled in.
    expect(deployed).toEqual(['SharedDb@us-west-2', 'SharedApi@us-west-2']);
  });

  it("auto-includes the stack that EXPORTS a raw import, not the consumer Stage's same-named stack", async () => {
    const withTemplate = (st: FakeStack, template: Record<string, unknown>): FakeStack => ({
      ...st,
      template: { Resources: {}, ...template } as FakeStack['template'],
    });
    synthStacks.value = [
      withTemplate(stageStack('UsEast', 'Producer', 'Producer', 'us-east-1'), {
        Outputs: { O: { Value: 'v', Export: { Name: 'OnlyEast' } } },
      }),
      stageStack('UsWest', 'Producer', 'Producer', 'us-west-2'),
      withTemplate(stageStack('UsWest', 'Consumer', 'Consumer', 'us-west-2'), {
        Resources: {
          P: { Type: 'AWS::SSM::Parameter', Properties: { Value: { 'Fn::ImportValue': 'OnlyEast' } } },
        },
      }),
    ];
    await runDeploy(['UsWest/Consumer', '--yes']);
    expect(deployed).toEqual(['Producer@us-east-1', 'Consumer@us-west-2']);
  });

  it('orders a Fn::GetStackOutput producer before its consumer when both deploy', async () => {
    synthStacks.value = [
      {
        ...stageStack('UsEast', 'Consumer', 'Consumer', 'us-east-1'),
        template: {
          Resources: {
            P: {
              Type: 'AWS::SSM::Parameter',
              Properties: { Value: { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'O' } } },
            },
          },
        },
      },
      stageStack('UsEast', 'Producer', 'Producer', 'us-east-1'),
    ];
    await runDeploy(['**', '--yes']);
    expect(deployed).toEqual(['Producer@us-east-1', 'Consumer@us-east-1']);
  });

  it('refuses two stacks sharing a name AND a region before any engine runs', async () => {
    synthStacks.value = [
      stageStack('Beta', 'Api', 'Shared', 'us-east-1'),
      stageStack('Prod', 'Api', 'Shared', 'us-east-1'),
    ];
    const { code, error } = await runDeploy(['**', '--yes']);
    expect(code).toBe(1);
    expect(engineConstructed.count).toBe(0);
    expect(deployed).toEqual([]);
    expect(error?.message).toContain('Beta/Api');
    expect(error?.message).toContain('Prod/Api');
    expect(error?.message).toContain('us-east-1');
    expect(error?.message).not.toContain('AWS_REGION');
    // Refused from the synthesized regions, before the run goes on to the
    // annotations and the per-stack region probes.
    const { processStackMessages } = await import('../../../src/synthesis/stack-messages.js');
    expect(processStackMessages).not.toHaveBeenCalled();
  });

  it('refuses two env-agnostic stacks sharing a name, which land in one region', async () => {
    synthStacks.value = [
      stageStack('Beta', 'Api', 'Shared', undefined),
      stageStack('Prod', 'Api', 'Shared', undefined),
    ];
    const { code, error } = await runDeploy(['**', '--yes']);
    expect(code).toBe(1);
    expect(engineConstructed.count).toBe(0);
    expect(error?.message).toContain('neither sets env.region');
  });

  it('refuses an env-agnostic stack resolving into the region a same-named stack pins', async () => {
    // The CLI region is eu-west-1, which the pinned one names too.
    synthStacks.value = [
      stageStack('Pinned', 'Api', 'Shared', 'eu-west-1'),
      stageStack('Agnostic', 'Api', 'Shared', undefined),
    ];
    const { code, error } = await runDeploy(['**', '--yes']);
    expect(code).toBe(1);
    expect(engineConstructed.count).toBe(0);
    expect(error?.message).toContain('Pinned/Api');
    expect(error?.message).toContain('Agnostic/Api');
    expect(error?.message).toContain("pin that Stage's region, or set AWS_REGION");
  });

  it('refuses a selected stack landing on an UNSELECTED same-named stack of its region', async () => {
    synthStacks.value = [
      stageStack('Beta', 'Api', 'Shared', 'us-east-1'),
      stageStack('Prod', 'Api', 'Shared', 'us-east-1'),
    ];
    const { code, error } = await runDeploy(['Beta/Api', '--yes']);
    expect(code).toBe(1);
    expect(engineConstructed.count).toBe(0);
    expect(error?.message).toContain('Prod/Api');
    // From the synthesized regions, before the run continues.
    const { processStackMessages } = await import('../../../src/synthesis/stack-messages.js');
    expect(processStackMessages).not.toHaveBeenCalled();
  });

  it('refuses a selected env-agnostic stack resolving onto an unselected pinned sibling', async () => {
    // The sibling pins us-east-1, the CLI region the env-agnostic one takes.
    process.env['AWS_REGION'] = 'us-east-1';
    process.env['AWS_DEFAULT_REGION'] = 'us-east-1';
    synthStacks.value = [
      stageStack('Pinned', 'Api', 'Shared', 'us-east-1'),
      stageStack('Agnostic', 'Api', 'Shared', undefined),
    ];
    const { code, error } = await runDeploy(['Agnostic/Api', '--yes']);
    expect(code).toBe(1);
    expect(engineConstructed.count).toBe(0);
    expect(error?.message).toContain('Pinned/Api');
  });

  it('deploys a selected stack whose unselected same-named sibling is in another region', async () => {
    synthStacks.value = [
      stageStack('UsEast', 'Api', 'Shared', 'us-east-1'),
      stageStack('UsWest', 'Api', 'Shared', 'us-west-2'),
    ];
    const { code } = await runDeploy(['UsEast/Api', '--yes']);
    expect(code).toBeUndefined();
    expect(deployed).toEqual(['Shared@us-east-1']);
  });

  it('deploys one Stage of a pipeline whose Stages pin different accounts in one region', async () => {
    synthStacks.value = [
      { ...stageStack('Dev', 'Api', 'Shared', 'us-east-1'), account: '111111111111' },
      { ...stageStack('Prod', 'Api', 'Shared', 'us-east-1'), account: '222222222222' },
    ];
    const { code } = await runDeploy(['Dev/Api', '--yes']);
    expect(code).toBeUndefined();
    expect(deployed).toEqual(['Shared@us-east-1']);
  });

  it('refuses two SELECTED stacks of one name and region even across accounts', async () => {
    synthStacks.value = [
      { ...stageStack('Dev', 'Api', 'Shared', 'us-east-1'), account: '111111111111' },
      { ...stageStack('Prod', 'Api', 'Shared', 'us-east-1'), account: '222222222222' },
    ];
    const { code, error } = await runDeploy(['**', '--yes']);
    expect(code).toBe(1);
    expect(engineConstructed.count).toBe(0);
    expect(error?.message).toContain('111111111111, 222222222222 differ');
  });

  it('deploys one of two env-agnostic stacks sharing a name when only it is selected', async () => {
    // Each is deployed by its own run (its own profile); the unselected one's
    // record cannot be told from the selected one's, so it is not compared.
    synthStacks.value = [
      stageStack('Dev', 'Api', 'Shared', undefined),
      stageStack('Prod', 'Api', 'Shared', undefined),
    ];
    const { code } = await runDeploy(['Dev/Api', '--yes']);
    expect(code).toBeUndefined();
    expect(deployed).toEqual(['Shared@eu-west-1']);
  });

  it('leaves two UNSELECTED colliding stacks alone when the selected one is elsewhere', async () => {
    synthStacks.value = [
      stageStack('Beta', 'Api', 'Shared', 'us-east-1'),
      stageStack('Prod', 'Api', 'Shared', 'us-east-1'),
      stageStack('UsWest', 'Api', 'Shared', 'us-west-2'),
    ];
    const { code } = await runDeploy(['UsWest/Api', '--yes']);
    expect(code).toBeUndefined();
    expect(deployed).toEqual(['Shared@us-west-2']);
  });

  it('auto-includes only the same-region producer for top-level stacks sharing a name', async () => {
    const top = (id: string, stackName: string, region: string, deps: string[] = []) => ({
      ...stageStack('X', id, stackName, region, deps),
      displayName: id,
      stagePath: undefined,
    });
    synthStacks.value = [
      top('ApiEast', 'Api', 'us-east-1'),
      top('ApiWest', 'Api', 'us-west-2'),
      top('ConsumerEast', 'Consumer', 'us-east-1', ['Api']),
    ];
    await runDeploy(['ConsumerEast', '--yes']);
    expect(deployed).toEqual(['Api@us-east-1', 'Consumer@us-east-1']);
  });
});

describe('stack-matcher helpers for a shared stackName (#5176)', () => {
  const east = { stackName: 'Db', displayName: 'UsEast/Db', stagePath: 'UsEast', region: 'us-east-1' };
  const west = { stackName: 'Db', displayName: 'UsWest/Db', stagePath: 'UsWest', region: 'us-west-2' };
  const westApi = {
    stackName: 'Api',
    displayName: 'UsWest/Api',
    stagePath: 'UsWest',
    region: 'us-west-2',
  };

  it('identity selection keeps both stacks of a shared name', () => {
    expect(matchStacks([east, west], ['Db'], { dedupe: 'identity' })).toEqual([east, west]);
    expect(matchStacks([east, west], ['**'], { dedupe: 'identity' })).toEqual([east, west]);
  });

  it('groups only stacks sharing the name AND the region', () => {
    expect(stackNameRegionCollisions([east, west], (s) => s.region)).toEqual([]);
    const eastToo = { ...west, displayName: 'Other/Db', region: 'us-east-1' };
    expect(stackNameRegionCollisions([east, west, eastToo], (s) => s.region)).toEqual([
      [east, eastToo],
    ]);
  });

  it('separates accounts between a selected and an unselected stack only', () => {
    const dev = { ...east, displayName: 'Dev/Db', account: '111111111111' };
    const prod = { ...east, displayName: 'Prod/Db', account: '222222222222' };
    const anyAccount = { ...east, displayName: 'Any/Db' };
    const region = (s: { region?: string }) => s.region;
    // Dev selected: Prod pins another account, an unpinned stack may share Dev's.
    expect(stackNameRegionCollisions([dev, prod], region, new Set([dev]))).toEqual([]);
    expect(stackNameRegionCollisions([dev, prod, anyAccount], region, new Set([dev]))).toEqual([
      [dev, anyAccount],
    ]);
    // Both selected: one run, one account, one record.
    expect(stackNameRegionCollisions([dev, prod], region)).toEqual([[dev, prod]]);
  });

  it('refuses only a group holding a selected stack', () => {
    const beta = { ...east, displayName: 'Beta/Db' };
    const prod = { ...east, displayName: 'Prod/Db' };
    expect(() =>
      refuseStackNameRegionCollisions([beta, prod, west], (s) => s.region, new Set([west]))
    ).not.toThrow();
    expect(() =>
      refuseStackNameRegionCollisions([beta, prod, west], (s) => s.region, new Set([beta]))
    ).toThrow(/Beta\/Db/);
  });

  it('names both CDK paths and the region in the refusal', () => {
    const eastToo = { ...west, displayName: 'Other/Db', region: 'us-east-1' };
    expect(() => refuseStackNameRegionCollisions([east, eastToo], (s) => s.region)).toThrow(
      /Db \(UsEast\/Db\), Db \(Other\/Db\) share the physical stack name Db in region us-east-1/
    );
    expect(() => refuseStackNameRegionCollisions([east, west], (s) => s.region)).not.toThrow();
  });

  it("resolves a dependency name to the dependent's own Stage, then region", () => {
    expect(stacksForDependency('Db', westApi, [east, west])).toEqual([west]);
    const topApi = { stackName: 'Api', displayName: 'Api', region: 'us-east-1' };
    expect(stacksForDependency('Db', topApi, [east, west])).toEqual([east]);
    const elsewhere = { stackName: 'Api', displayName: 'Api', region: 'eu-west-1' };
    // No Stage or region decides it: every candidate, an extra edge being safe.
    expect(stacksForDependency('Db', elsewhere, [east, west])).toEqual([east, west]);
    // An unshared name is the one stack of that name.
    expect(stacksForDependency('Api', east, [east, westApi])).toEqual([westApi]);
    // Never a stack of the dependent's own name.
    expect(stacksForDependency('Db', east, [east, west])).toEqual([]);
  });

  it("prefers the dependent's own Stage over a region match in another Stage", () => {
    // UsWest's own producer lives in us-east-1 (a cross-region reference);
    // UsEast's producer of that name sits in the dependent's region.
    const westsOwn = { ...west, region: 'us-east-1' };
    const eastsInWestRegion = { ...east, region: 'us-west-2' };
    expect(stacksForDependency('Db', westApi, [eastsInWestRegion, westsOwn])).toEqual([westsOwn]);
  });

  it('tells two top-level stacks of one name apart by region', () => {
    const topEast = { stackName: 'Db', displayName: 'DbEast', region: 'us-east-1' };
    const topWest = { stackName: 'Db', displayName: 'DbWest', region: 'us-west-2' };
    const consumer = { stackName: 'Api', displayName: 'Api', region: 'us-west-2' };
    expect(stacksForDependency('Db', consumer, [topEast, topWest])).toEqual([topWest]);
  });
});
