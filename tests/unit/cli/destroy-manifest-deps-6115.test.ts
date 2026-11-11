import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

/**
 * Issue [#6115](https://github.com/go-to-k/cdkd/issues/6115): `cdkd destroy`
 * read only the `Fn::ImportValue` / `Fn::GetStackOutput` edges of the
 * templates, never the cloud assembly's stack dependencies. A
 * `crossRegionReferences` strong reference and an explicit `addDependency()`
 * leave only a manifest dependency, so `cdkd destroy Producer` left the
 * dependent deployed, and `cdkd destroy Producer Consumer` destroyed the
 * producer first. The fix follows `cdk destroy`: the selection widens to the
 * dependents (`-e` / `--exclusively` opts out) and dependents go first.
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
const held = vi.hoisted(() => ({ records: [] as { stackName: string; region: string }[] }));
const getState = vi.hoisted(() => vi.fn());
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    listStacks: vi.fn(async () => held.records),
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

type Synth = {
  account?: string;
  stackName: string;
  displayName: string;
  stagePath?: string;
  artifactId: string;
  template: Record<string, unknown>;
  dependencyNames: string[];
  region?: string;
};

function stack(
  name: string,
  deps: string[] = [],
  extra: { stage?: string; region?: string; physical?: string; account?: string } = {}
): Synth {
  return {
    stackName: extra.physical ?? name,
    displayName: extra.stage !== undefined ? `${extra.stage}/${name}` : name,
    ...(extra.stage !== undefined && { stagePath: extra.stage }),
    artifactId: `${extra.stage ?? ''}${name}`,
    template: { Resources: {} },
    dependencyNames: deps,
    ...(extra.region !== undefined && { region: extra.region }),
    ...(extra.account !== undefined && { account: extra.account }),
  };
}

function stateOf(stackName: string, region: string): StackState {
  return {
    version: 13,
    stackName,
    region,
    resources: {
      Queue: { physicalId: `q-${stackName}`, resourceType: 'AWS::SQS::Queue', properties: {} },
    },
    outputs: {},
    lastModified: 0,
  } as unknown as StackState;
}

/** Each runner call as `<stackName>@<region>`. */
function destroyed(): string[] {
  return runDestroyForStack.mock.calls.map(
    (c) => `${String(c[0])}@${(c[1] as { region?: string }).region ?? '?'}`
  );
}

const clean = (stackName: string) => ({
  stackName,
  cancelled: false,
  skippedEmpty: false,
  deletedCount: 1,
  retainedCount: 0,
  skippedCount: 0,
  errorCount: 0,
  interrupted: false,
  stateDeleted: true,
});

const saved = { region: process.env['AWS_REGION'], def: process.env['AWS_DEFAULT_REGION'] };
let exitSpy: ReturnType<typeof vi.spyOn>;
let exitCode: number | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  process.env['AWS_REGION'] = 'us-east-1';
  process.env['AWS_DEFAULT_REGION'] = 'us-east-1';
  logged.info.length = 0;
  logged.warn.length = 0;
  logged.error.length = 0;
  caller.account = '111111111111';
  caller.fail = false;
  caller.send = undefined;
  exitCode = undefined;
  // The issue's repro: Cons (us-east-1) reads Prod (us-west-2) through
  // crossRegionReferences, which leaves only a manifest dependency.
  held.records = [
    { stackName: 'Prod', region: 'us-west-2' },
    { stackName: 'Cons', region: 'us-east-1' },
  ];
  getState.mockImplementation(async (name: string, region: string) =>
    held.records.some((r) => r.stackName === name && r.region === region)
      ? { state: stateOf(name, region), etag: '"e"' }
      : null
  );
  runDestroyForStack.mockImplementation(async (name: string) => clean(name));
  synthesize.mockResolvedValue({
    manifest: {},
    assemblyDir: '/tmp/cdk.out',
    stacks: [
      stack('Prod', [], { region: 'us-west-2' }),
      stack('Cons', ['Prod'], { region: 'us-east-1' }),
    ],
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

async function destroy(args: string[]): Promise<void> {
  const cmd = createDestroyCommand();
  cmd.exitOverride();
  try {
    await cmd.parseAsync(args, { from: 'user' });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== 'process.exit-mock') throw err;
  }
}

describe('cdkd destroy widens the selection to dependents (#6115)', () => {
  it('destroys the dependent of a named producer, dependent first', async () => {
    await destroy(['Prod', '--force']);
    expect(exitCode).toBeUndefined();
    expect(destroyed()).toEqual(['Cons@us-east-1', 'Prod@us-west-2']);
    const info = logged.info.join('\n');
    expect(info).toContain('Found 2 stack(s) to destroy: Cons (depends on Prod), Prod');
    expect(info).toContain('Also destroying 1 stack(s) that depend on the selected stack(s)');
  });

  it('destroys only the named stack under -e / --exclusively', async () => {
    await destroy(['Prod', '--force', '-e']);
    expect(destroyed()).toEqual(['Prod@us-west-2']);
    await destroy(['Prod', '--force', '--exclusively']);
    expect(destroyed()).toEqual(['Prod@us-west-2', 'Prod@us-west-2']);
    expect(logged.info.join('\n')).not.toContain('Also destroying');
  });

  it('follows a dependency chain, and walks through an undeployed stack', async () => {
    // Mid is not deployed; Leaf (deployed) depends on it, Mid on Prod.
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [stack('Prod'), stack('Mid', ['Prod']), stack('Leaf', ['Mid'])],
    });
    held.records = [
      { stackName: 'Prod', region: 'us-east-1' },
      { stackName: 'Leaf', region: 'us-east-1' },
    ];
    await destroy(['Prod', '--force']);
    expect(destroyed()).toEqual(['Leaf@us-east-1', 'Prod@us-east-1']);
  });

  it('adds no undeployed dependent', async () => {
    held.records = [{ stackName: 'Prod', region: 'us-west-2' }];
    await destroy(['Prod', '--force']);
    expect(destroyed()).toEqual(['Prod@us-west-2']);
    expect(logged.info.join('\n')).not.toContain('Also destroying');
  });

  it('does not add the stacks a named dependent depends on', async () => {
    await destroy(['Cons', '--force']);
    expect(destroyed()).toEqual(['Cons@us-east-1']);
  });

  it('says so, and destroys only the named stack, when the app does not synthesize', async () => {
    synthesize.mockRejectedValue(new Error('synth failed'));
    await destroy(['Prod', '--force']);
    expect(destroyed()).toEqual(['Prod@us-west-2']);
    expect(logged.warn.join('\n')).toContain(
      'No synthesized app stack to read stack dependencies from'
    );
  });

  it('stays quiet about the missing graph under -e when the app does not synthesize', async () => {
    synthesize.mockRejectedValue(new Error('synth failed'));
    await destroy(['Prod', '--force', '-e']);
    expect(logged.warn.join('\n')).not.toContain('stack dependencies');
  });

  it('marks an added stack at its prompt, and only that one', async () => {
    await destroy(['Prod']);
    const notes = runDestroyForStack.mock.calls.map(
      (c) => (c[2] as { confirmationNote?: string }).confirmationNote
    );
    expect(notes).toEqual(['it depends on Prod', undefined]);
  });

  it('widens --all to a Stage stack that depends on a top-level one', async () => {
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [
        stack('Prod'),
        stack('Cons', ['Prod'], { stage: 'Beta', physical: 'Beta-Cons' }),
        stack('Other', [], { stage: 'Beta', physical: 'Beta-Other' }),
      ],
    });
    held.records = [
      { stackName: 'Prod', region: 'us-east-1' },
      { stackName: 'Beta-Cons', region: 'us-east-1' },
      { stackName: 'Beta-Other', region: 'us-east-1' },
    ];
    await destroy(['--all', '--force']);
    expect(destroyed()).toEqual(['Beta-Cons@us-east-1', 'Prod@us-east-1']);
    const warn = logged.warn.join('\n');
    expect(warn).toContain('Beta/Other');
    expect(warn).not.toContain('Beta/Cons');
  });

  it("adds only the named Stage's dependent when two Stages share the names (#5176)", async () => {
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [
        stack('Prod', [], { stage: 'UsEast', region: 'us-east-1', physical: 'Prod' }),
        stack('Cons', ['Prod'], { stage: 'UsEast', region: 'us-east-1', physical: 'Cons' }),
        stack('Prod', [], { stage: 'UsWest', region: 'us-west-2', physical: 'Prod' }),
        stack('Cons', ['Prod'], { stage: 'UsWest', region: 'us-west-2', physical: 'Cons' }),
      ],
    });
    held.records = [
      { stackName: 'Prod', region: 'us-east-1' },
      { stackName: 'Cons', region: 'us-east-1' },
      { stackName: 'Prod', region: 'us-west-2' },
      { stackName: 'Cons', region: 'us-west-2' },
    ];
    await destroy(['UsWest/Prod', '--force']);
    expect(destroyed()).toEqual(['Cons@us-west-2', 'Prod@us-west-2']);
  });
});

describe('cdkd destroy orders by the manifest dependencies (#6115)', () => {
  it('destroys a dependent before its producer whatever order they are named in', async () => {
    await destroy(['Prod', 'Cons', '--force', '-e']);
    expect(destroyed()).toEqual(['Cons@us-east-1', 'Prod@us-west-2']);
  });

  it('keeps the producer when its dependent was declined at the prompt', async () => {
    runDestroyForStack.mockImplementation(async (name: string) =>
      name === 'Cons' ? { ...clean(name), cancelled: true, deletedCount: 0 } : clean(name)
    );
    await destroy(['Prod']);
    expect(destroyed()).toEqual(['Cons@us-east-1']);
    expect(logged.warn.join('\n')).toContain(
      'Not destroying stack Prod: Cons depends on it and was not destroyed in this run.'
    );
    expect(exitCode).toBeUndefined();
  });

  it('keeps the producer when a dependent reached through an undeployed stack was declined', async () => {
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [stack('Prod'), stack('Mid', ['Prod']), stack('Leaf', ['Mid'])],
    });
    held.records = [
      { stackName: 'Prod', region: 'us-east-1' },
      { stackName: 'Leaf', region: 'us-east-1' },
    ];
    runDestroyForStack.mockImplementation(async (name: string) =>
      name === 'Leaf' ? { ...clean(name), cancelled: true, deletedCount: 0 } : clean(name)
    );
    await destroy(['Prod']);
    expect(destroyed()).toEqual(['Leaf@us-east-1']);
  });

  it('keeps the producer when its dependent failed', async () => {
    runDestroyForStack.mockImplementation(async (name: string) =>
      name === 'Cons' ? { ...clean(name), errorCount: 1, deletedCount: 0 } : clean(name)
    );
    await destroy(['Prod', '--force']);
    expect(destroyed()).toEqual(['Cons@us-east-1']);
    expect(exitCode).toBe(2);
  });

  it('keeps the producer when its dependent is termination-protected', async () => {
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [
        stack('Prod', [], { region: 'us-west-2' }),
        { ...stack('Cons', ['Prod'], { region: 'us-east-1' }), terminationProtection: true },
      ],
    });
    await destroy(['Prod', '--force']);
    expect(destroyed()).toEqual([]);
    expect(exitCode).toBe(2);
  });
});

describe('cdkd destroy dependents: review round (#6115)', () => {
  it('expands from a named stack that is not deployed, as cdk destroy does', async () => {
    held.records = [{ stackName: 'Cons', region: 'us-east-1' }];
    await destroy(['Prod', '--force']);
    expect(destroyed()).toEqual(['Cons@us-east-1']);
  });

  it('expands --all from an undeployed top-level stack to a deployed Stage dependent', async () => {
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [
        stack('Prod'),
        stack('Top'),
        stack('Cons', ['Prod'], { stage: 'Beta', physical: 'Beta-Cons' }),
      ],
    });
    held.records = [
      { stackName: 'Top', region: 'us-east-1' },
      { stackName: 'Beta-Cons', region: 'us-east-1' },
    ];
    await destroy(['--all', '--force']);
    expect(destroyed().sort()).toEqual(['Beta-Cons@us-east-1', 'Top@us-east-1']);
  });

  it("does not add a dependent whose only record of its name is in another region", async () => {
    // Cons is pinned to us-east-1 and not deployed there; a record of the
    // same name in eu-west-1 is another app's (same state bucket).
    held.records = [
      { stackName: 'Prod', region: 'us-west-2' },
      { stackName: 'Cons', region: 'eu-west-1' },
    ];
    await destroy(['Prod', '--force']);
    expect(destroyed()).toEqual(['Prod@us-west-2']);
    expect(logged.info.join('\n')).not.toContain('Also destroying');
  });

  it('names the selected stack a dependent was reached from, not an undeployed middle one', async () => {
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [stack('Prod'), stack('Mid', ['Prod']), stack('Leaf', ['Mid'])],
    });
    held.records = [
      { stackName: 'Prod', region: 'us-east-1' },
      { stackName: 'Leaf', region: 'us-east-1' },
    ];
    await destroy(['Prod', '--force']);
    expect(logged.info.join('\n')).toContain(
      'Found 2 stack(s) to destroy: Leaf (depends on Prod), Prod'
    );
  });

  it('keeps --remove-protection to the named stacks: a protected added dependent is refused', async () => {
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [
        stack('Prod', [], { region: 'us-west-2' }),
        { ...stack('Cons', ['Prod'], { region: 'us-east-1' }), terminationProtection: true },
      ],
    });
    await destroy(['Prod', '--force', '--remove-protection']);
    expect(destroyed()).toEqual([]);
    expect(exitCode).toBe(2);
    expect(logged.error.join('\n')).toContain(
      '--remove-protection applies only to the stacks you name; this stack was added because it depends on Prod.'
    );
  });

  it('does not pass --remove-protection to an added dependent, and does to a named stack', async () => {
    await destroy(['Prod', '--force', '--remove-protection']);
    const flags = runDestroyForStack.mock.calls.map((c) => [
      String(c[0]),
      (c[2] as { removeProtection?: boolean }).removeProtection,
    ]);
    expect(flags).toEqual([
      ['Cons', false],
      ['Prod', true],
    ]);
  });

  it('keeps the producer when its dependent skipped a resource', async () => {
    runDestroyForStack.mockImplementation(async (name: string) =>
      name === 'Cons' ? { ...clean(name), skippedCount: 1, stateDeleted: false } : clean(name)
    );
    await destroy(['Prod', '--force']);
    expect(destroyed()).toEqual(['Cons@us-east-1']);
  });

  it("keeps the producer when its dependent is pinned to another account than the run's", async () => {
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [
        stack('Prod', [], { stage: 'UsEast', region: 'us-east-1', physical: 'Prod' }),
        stack('Cons', ['Prod'], { stage: 'UsEast', region: 'us-east-1', physical: 'Cons' }),
        stack('Prod', [], { stage: 'UsWest', region: 'us-west-2', physical: 'Prod' }),
        stack('Cons', ['Prod'], {
          stage: 'UsWest',
          region: 'us-west-2',
          physical: 'Cons',
          account: '999999999999',
        }),
      ],
    });
    held.records = [
      { stackName: 'Prod', region: 'us-west-2' },
      { stackName: 'Cons', region: 'us-west-2' },
    ];
    await destroy(['UsWest/Prod', '--force']);
    expect(destroyed()).toEqual([]);
    expect(exitCode).toBe(2);
  });

  it('still refuses a protected producer, as an error, when its dependent was declined', async () => {
    synthesize.mockResolvedValue({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: [
        { ...stack('Prod', [], { region: 'us-west-2' }), terminationProtection: true },
        stack('Cons', ['Prod'], { region: 'us-east-1' }),
      ],
    });
    runDestroyForStack.mockImplementation(async (name: string) =>
      name === 'Cons' ? { ...clean(name), cancelled: true, deletedCount: 0 } : clean(name)
    );
    await destroy(['Prod']);
    expect(exitCode).toBe(2);
    expect(logged.warn.join('\n')).not.toContain('Not destroying stack Prod');
  });

  it('words the no-app warning as conditional', async () => {
    synthesize.mockRejectedValue(new Error('synth failed'));
    await destroy(['Prod', '--force']);
    expect(logged.warn.join('\n')).toContain('a deployed stack that depends on one, if any, stays deployed');
  });
});
