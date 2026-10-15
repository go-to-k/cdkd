import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import { AwsClients } from '../../../src/utils/aws-clients.js';
import { ExportIndexStore as ExportIndexStoreMock } from '../../../src/state/export-index-store.js';

/**
 * go-to-k/cdkd#2100: the `cdkd state destroy <stack>` twin of
 * `destroy-profile-region-2100.test.ts`. A REGION-LESS (legacy) record falls
 * back to `setupStateBackend`'s `regionFor`, and the runner must be handed the
 * record carrying that region (`stateWithRegion`), or its lock, save and
 * clients fall back to the profile's region while the resources live in
 * us-east-1.
 */

const infoSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

const profile = vi.hoisted(() => ({ region: 'ap-northeast-1' as string | undefined }));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    config: {
      region: async (): Promise<string> => {
        if (!profile.region) throw new Error('Region is missing');
        return profile.region;
      },
    },
    send: vi.fn(),
    destroy: vi.fn(),
  })),
}));

const bucketArgs = vi.hoisted(() => ({ value: [] as unknown[][] }));
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async (...args: unknown[]) => {
    bucketArgs.value.push(args);
    return 'test-bucket';
  }),
}));

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

/** Every `removeStack` on an exports-index store, as [indexRegion, stack, region]. */
const indexRemovals = vi.hoisted(() => [] as string[][]);
vi.mock('../../../src/state/export-index-store.js', () => ({
  ExportIndexStore: vi.fn().mockImplementation((...args: unknown[]) => ({
    region: args[3],
    removeStack: vi.fn(async (stack: string, region: string) => {
      indexRemovals.push([args[3] as string, stack, region]);
    }),
    removeStackIfPresent: vi.fn(async (stack: string, region: string) => {
      indexRemovals.push([`${args[3] as string} (if present)`, stack, region]);
    }),
  })),
}));
/** Exports-index objects that exist in the bucket. */
const indexFiles = vi.hoisted(() => new Set<string>());
/** Regions in which a state record for `MyStack` exists. */
const held = vi.hoisted(() => ({ regions: new Set<string>() }));
const backend = vi.hoisted(() => ({
  getState: vi.fn(),
  stateExistsOwnedBy: vi.fn(),
}));
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    // ONE ref, with NO region: the legacy (version 1) record shape.
    listStacks: vi.fn(async () => [{ stackName: 'MyStack' }]),
    getState: backend.getState,
    stateExistsOwnedBy: backend.stateExistsOwnedBy,
    rawObjectExists: vi.fn(async (key: string) => indexFiles.has(key)),
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

/** `AWS_REGION` when each registry was populated: what its providers capture. */
const registeredUnder = vi.hoisted(() => [] as (string | undefined)[]);
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(() => {
    registeredUnder.push(process.env['AWS_REGION']);
  }),
}));

const runDestroyForStack = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/commands/destroy-runner.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, runDestroyForStack };
});

vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: vi.fn(() => ({ record: vi.fn(), finalize: vi.fn(async () => {}) })),
  recordRunFailed: vi.fn(),
  recordRunOutcome: vi.fn(),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';

function legacyState(): StackState {
  // A version-1 record carries no region of its own.
  return {
    version: 1,
    stackName: 'MyStack',
    resources: {
      Bucket: { physicalId: 'mystack-bucket', resourceType: 'AWS::S3::Bucket', properties: {} },
    },
    outputs: {},
    lastModified: 0,
  } as unknown as StackState;
}

async function runStateDestroy(args: string[]): Promise<void> {
  const cmd = createStateCommand();
  cmd.exitOverride();
  cmd.commands.forEach((sub) => sub.exitOverride());
  await cmd.parseAsync(['destroy', ...args], { from: 'user' });
}

/** The region the destroy runner was handed the record in (its 2nd argument). */
function runnerRegions(): unknown[] {
  return runDestroyForStack.mock.calls.map((c) => (c[1] as { region?: string }).region);
}

const saved = { region: process.env['AWS_REGION'], def: process.env['AWS_DEFAULT_REGION'] };
let exitSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['AWS_REGION'];
  delete process.env['AWS_DEFAULT_REGION'];
  profile.region = 'ap-northeast-1';
  held.regions.clear();
  indexFiles.clear();
  indexRemovals.length = 0;
  bucketArgs.value.length = 0;
  registeredUnder.length = 0;
  backend.stateExistsOwnedBy.mockImplementation(async (_stack: string, region: string) =>
    held.regions.has(region)
  );
  backend.getState.mockImplementation(async () => ({ state: legacyState(), etag: '"e"' }));
  runDestroyForStack.mockResolvedValue({
    stackName: 'MyStack',
    cancelled: false,
    skippedEmpty: false,
    deletedCount: 1,
    retainedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    interrupted: false,
    stateDeleted: true,
  });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
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

describe('cdkd state destroy over a region-less record, under a profile region (go-to-k/cdkd#2100)', () => {
  it('reads the record in us-east-1 and hands the runner that region when the old default holds it', async () => {
    held.regions.add('us-east-1');
    await runStateDestroy(['MyStack', '--yes']);

    expect(backend.getState.mock.calls.map((c) => c[1])).toEqual(['us-east-1']);
    expect(runnerRegions()).toEqual(['us-east-1']);
    const info = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(info).toContain('Continuing to use us-east-1 so the existing stack is not duplicated');
  });

  it('THE OTHER POLARITY: uses the profile region when the record is there', async () => {
    held.regions.add('ap-northeast-1');
    await runStateDestroy(['MyStack', '--yes']);

    expect(backend.getState.mock.calls.map((c) => c[1])).toEqual(['ap-northeast-1']);
    expect(runnerRegions()).toEqual(['ap-northeast-1']);
  });

  it('obeys AWS_REGION as named: no probe', async () => {
    process.env['AWS_REGION'] = 'ap-northeast-1';
    held.regions.add('us-east-1');
    await runStateDestroy(['MyStack', '--yes']);

    expect(backend.stateExistsOwnedBy).not.toHaveBeenCalled();
    expect(runnerRegions()).toEqual(['ap-northeast-1']);
  });
});

/**
 * Orchestrator review B1 (go-to-k/cdkd#2100): `AWS_DEFAULT_REGION` is a
 * region SOURCE for cdkd but the JS SDK never reads it, so a region-less base
 * client would follow the profile while the record says otherwise — deletes
 * in one region, the record in another, NotFound read as "gone".
 */
describe('under AWS_DEFAULT_REGION differing from the profile (review B1)', () => {
  const baseClientRegions = (): unknown[] =>
    vi.mocked(AwsClients).mock.calls.map((c) => (c[0] as { region?: string } | undefined)?.region);

  it('builds the base clients, and the SDK env, for AWS_DEFAULT_REGION: they agree with the record', async () => {
    process.env['AWS_DEFAULT_REGION'] = 'eu-west-1';
    held.regions.add('eu-west-1');
    await runStateDestroy(['MyStack', '--yes']);

    expect(backend.getState.mock.calls.map((c) => c[1])).toEqual(['eu-west-1']);
    expect(runnerRegions()).toEqual(['eu-west-1']);
    expect(baseClientRegions()[0]).toBe('eu-west-1');
    expect(process.env['AWS_REGION']).toBe('eu-west-1');
  });

  it('THE OTHER POLARITY: a record held on us-east-1 is handed over as us-east-1, unlike the base', async () => {
    process.env['AWS_DEFAULT_REGION'] = 'eu-west-1';
    held.regions.add('us-east-1');
    await runStateDestroy(['MyStack', '--yes']);

    expect(runnerRegions()).toEqual(['us-east-1']);
    // The runner switches clients because the record's region differs from
    // the base one, which is the base region the clients were built for.
    expect(baseClientRegions()[0]).toBe('eu-west-1');
  });
});

describe('ONE exports-index file per command (review round 3)', () => {
  const runnerIndexRegions = (): unknown[] =>
    runDestroyForStack.mock.calls.map(
      (c) => (c[2] as { exportIndexStore?: { region?: string } }).exportIndexStore?.region
    );

  it('with BOTH index files present, the us-east-1 one is used — the file every pre-#2100 bare run wrote', async () => {
    // F1: the held stack's pre-upgrade entry is in this file, so the destroy
    // removes it from the file every stack of the command shares.
    indexFiles.add('cdkd/_index/us-east-1/exports.json');
    indexFiles.add('cdkd/_index/ap-northeast-1/exports.json');
    held.regions.add('us-east-1');
    await runStateDestroy(['MyStack', '--yes']);
    expect(runnerIndexRegions()).toEqual(['us-east-1']);
  });

  it('a record in the profile region uses the same us-east-1 file while it exists', async () => {
    indexFiles.add('cdkd/_index/us-east-1/exports.json');
    held.regions.add('ap-northeast-1');
    await runStateDestroy(['MyStack', '--yes']);
    expect(runnerIndexRegions()).toEqual(['us-east-1']);
  });

  it('with no us-east-1 index, the profile region\'s file is used', async () => {
    indexFiles.add('cdkd/_index/ap-northeast-1/exports.json');
    held.regions.add('us-east-1');
    await runStateDestroy(['MyStack', '--yes']);
    expect(runnerIndexRegions()).toEqual(['ap-northeast-1']);
  });
});

/**
 * Review R3-1 / R4-1 (go-to-k/cdkd#2100): the store every destroy path is
 * handed removes a stack's entries from the run's file AND the other
 * candidate file. The runner and the nested-stack provider both remove
 * through it, so the mocked runner removes through it here exactly as the
 * real one does on a clean destroy — for the stack and for a nested child.
 */
describe('the store a destroy hands down also clears the OTHER candidate file (review R3-1 / R4-1)', () => {
  beforeEach(() => {
    runDestroyForStack.mockImplementation(
      async (stack: string, state: { region?: string }, ctx: { exportIndexStore: { removeStack: (s: string, r: string) => Promise<void> } }) => {
        // The parent, then a nested child the provider destroys through the
        // same store (`nested-stack-provider.ts` hands `ctx.exportIndexStore` down).
        await ctx.exportIndexStore.removeStack(stack, state.region!);
        await ctx.exportIndexStore.removeStack(`${stack}~Child`, state.region!);
        return {
          stackName: stack,
          cancelled: false,
          skippedEmpty: false,
          deletedCount: 1,
          retainedCount: 0,
          skippedCount: 0,
          errorCount: 0,
          interrupted: false,
          stateDeleted: true,
        };
      }
    );
  });

  it("removes the stack's AND its nested child's entries from the profile file when the command picked us-east-1", async () => {
    indexFiles.add('cdkd/_index/us-east-1/exports.json');
    indexFiles.add('cdkd/_index/ap-northeast-1/exports.json');
    held.regions.add('ap-northeast-1');
    await runStateDestroy(['MyStack', '--yes']);
    expect(indexRemovals).toEqual([
      ['us-east-1', 'MyStack', 'ap-northeast-1'],
      ['ap-northeast-1 (if present)', 'MyStack', 'ap-northeast-1'],
      ['us-east-1', 'MyStack~Child', 'ap-northeast-1'],
      ['ap-northeast-1 (if present)', 'MyStack~Child', 'ap-northeast-1'],
    ]);
  });

  it('never touches (or creates) the other file when it does not exist', async () => {
    indexFiles.add('cdkd/_index/us-east-1/exports.json');
    held.regions.add('us-east-1');
    await runStateDestroy(['MyStack', '--yes']);
    expect(indexRemovals).toHaveLength(2);
    expect(indexRemovals.every(([file]) => file === 'us-east-1')).toBe(true);
    expect(vi.mocked(ExportIndexStoreMock).mock.calls).toHaveLength(1);
  });

  it('a NAMED region gets the plain store: only its own file', async () => {
    process.env['AWS_REGION'] = 'ap-northeast-1';
    indexFiles.add('cdkd/_index/us-east-1/exports.json');
    indexFiles.add('cdkd/_index/ap-northeast-1/exports.json');
    held.regions.add('ap-northeast-1');
    await runStateDestroy(['MyStack', '--yes']);
    expect(indexRemovals).toHaveLength(2);
    expect(indexRemovals.every(([file]) => file === 'ap-northeast-1')).toBe(true);
  });
});

/**
 * go-to-k/cdkd#4941 (security review): `--region` names the run's region over
 * `AWS_REGION`, and the runner keeps the command's registry for a stack in
 * that region. A provider captures `ambientRegion()` when it is constructed,
 * so the registry must be populated under the flag's region, or the destroy
 * deletes by name in the shell's region.
 */
describe('under --region differing from AWS_REGION (go-to-k/cdkd#4941)', () => {
  it("populates the provider registry in the flag's region", async () => {
    process.env['AWS_REGION'] = 'us-east-1';
    await runStateDestroy(['MyStack', '--region', 'us-west-2', '--yes']);

    expect(runnerRegions()).toEqual(['us-west-2']);
    expect(registeredUnder).toEqual(['us-west-2']);
  });

  it('THE OTHER POLARITY: leaves AWS_REGION alone without --region', async () => {
    process.env['AWS_REGION'] = 'us-east-1';
    await runStateDestroy(['MyStack', '--yes']);

    expect(registeredUnder).toEqual(['us-east-1']);
  });
});
