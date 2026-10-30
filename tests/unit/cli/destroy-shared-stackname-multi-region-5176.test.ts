import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

/**
 * Issue [#5176](https://github.com/go-to-k/cdkd/issues/5176), the DELETION
 * half: two CDK Stages deployed to different regions under one shared
 * stackName are two stacks with two state records. `cdkd destroy` selected
 * them by NAME and then looked the app stack up by name, so it took the FIRST
 * Stage's region for every selection: `cdkd destroy UsWest/Api` destroyed the
 * us-east-1 stack, and `'**'` destroyed only one region.
 */

const logged = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[], error: [] as string[] }));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn((m: unknown) => logged.info.push(String(m))),
    warn: vi.fn((m: unknown) => logged.warn.push(String(m))),
    error: vi.fn((m: unknown) => logged.error.push(String(m))),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

/** The account the run's credentials resolve to (`GetCallerIdentity`). */
const caller = vi.hoisted(() => ({
  account: '111111111111',
  fail: false,
  send: undefined as undefined | ReturnType<typeof vi.fn>,
}));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    config: { region: async (): Promise<string> => 'eu-west-1' },
    send: vi.fn(),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn(),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveApp: vi.fn(() => 'fake-app-cmd'),
}));

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    get sts() {
      caller.send ??= vi.fn(async () => {
        if (caller.fail) throw new Error('ExpiredToken');
        return { Account: caller.account };
      });
      return { send: caller.send };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

vi.mock('../../../src/state/export-index-store.js', () => ({
  ExportIndexStore: vi.fn().mockImplementation(() => ({
    removeStack: vi.fn(async () => undefined),
    removeStackIfPresent: vi.fn(async () => undefined),
  })),
}));

/** The regions holding a state record for the shared name. */
const held = vi.hoisted(() => ({ regions: [] as string[], names: ['Shared'] }));
const getState = vi.hoisted(() => vi.fn());
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    listStacks: vi.fn(async () =>
      held.names.flatMap((stackName) => held.regions.map((region) => ({ stackName, region })))
    ),
    getState,
    stateExistsOwnedBy: vi.fn(async () => false),
    rawObjectExists: vi.fn(async () => false),
    verifyBucketExists: vi.fn(async () => undefined),
  })),
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

const runDestroyForStack = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/commands/destroy-runner.js', () => ({
  runDestroyForStack,
}));

vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: vi.fn(() => ({ record: vi.fn(), finalize: vi.fn(async () => {}) })),
  recordRunFailed: vi.fn(),
  recordRunOutcome: vi.fn(),
}));

const synthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({ synthesize })),
}));

import { createDestroyCommand } from '../../../src/cli/commands/destroy.js';

function stageStack(
  stage: string,
  region: string | undefined,
  stackName = 'Shared',
  id = 'Api',
  template: Record<string, unknown> = { Resources: {} }
) {
  return {
    stackName,
    displayName: `${stage}/${id}`,
    stagePath: stage,
    artifactId: `${stage}${id}`,
    template,
    dependencyNames: [],
    ...(region !== undefined && { region }),
  };
}

function stateIn(region: string): StackState {
  return {
    version: 13,
    stackName: 'Shared',
    region,
    resources: {
      Queue: { physicalId: `q-${region}`, resourceType: 'AWS::SQS::Queue', properties: {} },
    },
    outputs: {},
    lastModified: 0,
  } as unknown as StackState;
}

async function runDestroy(args: string[]): Promise<void> {
  const cmd = createDestroyCommand();
  cmd.exitOverride();
  await cmd.parseAsync(args, { from: 'user' });
}

/** Each runner call as `<stackName>@<region of the record it was handed>`. */
function destroyed(): string[] {
  return runDestroyForStack.mock.calls.map(
    (c) => `${String(c[0])}@${(c[1] as { region?: string }).region ?? '?'}`
  );
}

const saved = { region: process.env['AWS_REGION'], def: process.env['AWS_DEFAULT_REGION'] };
let exitSpy: ReturnType<typeof vi.spyOn>;
let exitCode: number | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  process.env['AWS_REGION'] = 'eu-west-1';
  process.env['AWS_DEFAULT_REGION'] = 'eu-west-1';
  logged.info.length = 0;
  logged.warn.length = 0;
  logged.error.length = 0;
  held.regions = ['us-east-1', 'us-west-2'];
  held.names = ['Shared'];
  caller.account = '111111111111';
  caller.fail = false;
  caller.send = undefined;
  exitCode = undefined;
  getState.mockImplementation(async (_stack: string, region: string) =>
    held.regions.includes(region) ? { state: stateIn(region), etag: '"e"' } : null
  );
  runDestroyForStack.mockResolvedValue({
    stackName: 'Shared',
    cancelled: false,
    skippedEmpty: false,
    deletedCount: 1,
    retainedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    interrupted: false,
    stateDeleted: true,
  });
  synthesize.mockResolvedValue({
    manifest: {},
    assemblyDir: '/tmp/cdk.out',
    stacks: [stageStack('UsEast', 'us-east-1'), stageStack('UsWest', 'us-west-2')],
  });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('process.exit-mock');
  }) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
  if (saved.region === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = saved.region;
  if (saved.def === undefined) delete process.env['AWS_DEFAULT_REGION'];
  else process.env['AWS_DEFAULT_REGION'] = saved.def;
});

async function destroySwallowingExit(args: string[]): Promise<void> {
  try {
    await runDestroy(args);
  } catch (err) {
    if (!(err instanceof Error) || err.message !== 'process.exit-mock') throw err;
  }
}

describe('cdkd destroy over a stackName two regions share (#5176)', () => {
  it("destroys both regions' stacks for '**'", async () => {
    await destroySwallowingExit(['**', '--force']);
    expect(exitCode).toBeUndefined();
    expect(destroyed()).toEqual(['Shared@us-east-1', 'Shared@us-west-2']);
  });

  it('destroys only the us-west-2 stack for its CDK path, never the first Stage', async () => {
    await destroySwallowingExit(['UsWest/Api', '--force']);
    expect(destroyed()).toEqual(['Shared@us-west-2']);
    expect(getState.mock.calls.map((c) => c[1])).toEqual(['us-west-2']);
  });

  it('destroys only the us-east-1 stack for its CDK path', async () => {
    await destroySwallowingExit(['UsEast/Api', '--force']);
    expect(destroyed()).toEqual(['Shared@us-east-1']);
  });

  it("does not destroy the other region's record when the selected one has none", async () => {
    // Only UsEast was ever deployed; the single record is ITS record.
    held.regions = ['us-east-1'];
    await destroySwallowingExit(['UsWest/Api', '--force']);
    expect(runDestroyForStack).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
    expect(logged.warn.join('\n')).toContain('No state found for stack Shared (UsWest/Api) in us-west-2');
  });

  it("destroys only the deployed region's stack for '**' when one region has no record", async () => {
    held.regions = ['us-east-1'];
    await destroySwallowingExit(['**', '--force']);
    expect(destroyed()).toEqual(['Shared@us-east-1']);
  });

  it('names each target by its CDK path and region', async () => {
    await destroySwallowingExit(['**', '--force']);
    expect(logged.info.join('\n')).toContain(
      'Found 2 stack(s) to destroy: Shared (UsEast/Api) in us-east-1, Shared (UsWest/Api) in us-west-2'
    );
  });

  it('refuses two selected stacks sharing a name AND a region before any read or delete', async () => {
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [stageStack('Beta', 'us-east-1'), stageStack('Prod', 'us-east-1')],
    });
    await destroySwallowingExit(['**', '--force']);
    expect(exitCode).toBe(1);
    expect(runDestroyForStack).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
    const error = logged.error.join('\n');
    expect(error).toContain('Beta/Api');
    expect(error).toContain('Prod/Api');
  });

  it('keeps an unshared name destroying its single record wherever it is', async () => {
    // Regression guard: the strict per-region rule is for SHARED names only.
    held.regions = ['us-east-1'];
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [stageStack('UsWest', 'us-west-2')],
    });
    await destroySwallowingExit(['UsWest/Api', '--force']);
    expect(destroyed()).toEqual(['Shared@us-east-1']);
  });

  it('destroys both stacks the shared physical name itself selects', async () => {
    await destroySwallowingExit(['Shared', '--force']);
    expect(destroyed()).toEqual(['Shared@us-east-1', 'Shared@us-west-2']);
  });

  it("orders two shared names consumer-first and keeps every region's target", async () => {
    held.names = ['Shared', 'SharedDb'];
    const producer = {
      Resources: {},
      Outputs: { Out: { Value: 'x', Export: { Name: 'SharedDb:Out' } } },
    };
    const consumer = { Resources: { P: { Type: 'AWS::SSM::Parameter', Properties: { Value: { 'Fn::ImportValue': 'SharedDb:Out' } } } } };
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [
        stageStack('UsEast', 'us-east-1', 'SharedDb', 'Db', producer),
        stageStack('UsEast', 'us-east-1', 'Shared', 'Api', consumer),
        stageStack('UsWest', 'us-west-2', 'SharedDb', 'Db', producer),
        stageStack('UsWest', 'us-west-2', 'Shared', 'Api', consumer),
      ],
    });
    await destroySwallowingExit(['**', '--force']);
    expect(destroyed()).toEqual([
      'Shared@us-east-1',
      'Shared@us-west-2',
      'SharedDb@us-east-1',
      'SharedDb@us-west-2',
    ]);
  });

  it('destroys an env-agnostic shared-name stack in its resolved region only', async () => {
    // AWS_REGION eu-west-1 is a NAMED region, so the env-agnostic stack takes it.
    held.regions = ['us-east-1', 'eu-west-1'];
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [stageStack('Pinned', 'us-east-1'), stageStack('Agnostic', undefined)],
    });
    await destroySwallowingExit(['Agnostic/Api', '--force']);
    expect(destroyed()).toEqual(['Shared@eu-west-1']);
  });

  it("refuses an env-agnostic stack resolving onto an unselected sibling's region", async () => {
    process.env['AWS_REGION'] = 'us-east-1';
    process.env['AWS_DEFAULT_REGION'] = 'us-east-1';
    held.regions = ['us-east-1', 'us-west-2'];
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [stageStack('Pinned', 'us-east-1'), stageStack('Agnostic', undefined)],
    });
    await destroySwallowingExit(['Agnostic/Api', '--force']);
    expect(exitCode).toBe(1);
    expect(runDestroyForStack).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
    expect(logged.error.join('\n')).toContain('Pinned/Api');
  });

  it('destroys one Stage of a pipeline whose Stages pin different accounts in one region', async () => {
    held.regions = ['us-east-1'];
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [
        { ...stageStack('Dev', 'us-east-1'), account: '111111111111' },
        { ...stageStack('Prod', 'us-east-1'), account: '222222222222' },
      ],
    });
    await destroySwallowingExit(['Dev/Api', '--force']);
    expect(exitCode).toBeUndefined();
    expect(destroyed()).toEqual(['Shared@us-east-1']);
  });

  it('still refuses Stages pinning one account and one region', async () => {
    held.regions = ['us-east-1'];
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [
        { ...stageStack('Dev', 'us-east-1'), account: '111111111111' },
        { ...stageStack('Prod', 'us-east-1'), account: '111111111111' },
      ],
    });
    await destroySwallowingExit(['Dev/Api', '--force']);
    expect(exitCode).toBe(1);
    expect(runDestroyForStack).not.toHaveBeenCalled();
  });

  it("skips a shared-name stack pinned to another account than the run's credentials", async () => {
    // Prod's credentials: the us-east-1 record found is Prod's, not Dev's.
    caller.account = '222222222222';
    held.regions = ['us-east-1'];
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [
        { ...stageStack('Dev', 'us-east-1'), account: '111111111111' },
        { ...stageStack('Prod', 'us-east-1'), account: '222222222222' },
      ],
    });
    await destroySwallowingExit(['Dev/Api', '--force']);
    expect(runDestroyForStack).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
    expect(logged.error.join('\n')).toContain('is pinned to account 111111111111');
    // Not destroyed though named: exit 2, like a termination-protection refusal.
    expect(exitCode).toBe(2);
    exitCode = undefined;

    await destroySwallowingExit(['Prod/Api', '--force']);
    expect(destroyed()).toEqual(['Shared@us-east-1']);
  });

  it('refuses two SELECTED stacks of one name and region even across accounts', async () => {
    held.regions = ['us-east-1'];
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [
        { ...stageStack('Dev', 'us-east-1'), account: '111111111111' },
        { ...stageStack('Prod', 'us-east-1'), account: '222222222222' },
      ],
    });
    await destroySwallowingExit(['**', '--force']);
    expect(exitCode).toBe(1);
    expect(runDestroyForStack).not.toHaveBeenCalled();
    expect(logged.error.join('\n')).toContain('111111111111, 222222222222 differ');
  });

  it('does not destroy an account-pinned shared-name stack when the caller account cannot be read', async () => {
    caller.fail = true;
    held.regions = ['us-east-1'];
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [
        { ...stageStack('Dev', 'us-east-1'), account: '111111111111' },
        { ...stageStack('Prod', 'us-east-1'), account: '222222222222' },
      ],
    });
    await destroySwallowingExit(['Dev/Api', '--force']);
    expect(runDestroyForStack).not.toHaveBeenCalled();
    expect(logged.error.join('\n')).toContain('could not be read (STS GetCallerIdentity failed)');
  });

  it('makes no caller-account read for an unshared account-pinned stack, and destroys it', async () => {
    caller.account = '222222222222';
    held.regions = ['us-east-1'];
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [{ ...stageStack('Dev', 'us-east-1'), account: '111111111111' }],
    });
    await destroySwallowingExit(['Dev/Api', '--force']);
    expect(destroyed()).toEqual(['Shared@us-east-1']);
    expect(caller.send).toBeUndefined();
  });
});
