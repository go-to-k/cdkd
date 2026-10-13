import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#2100: `cdkd scrub` over an ENV-AGNOSTIC stack takes the run's
 * region, which now comes from the AWS profile. The region is reconciled per
 * stack, so a record the old `us-east-1` default wrote is the one scrubbed —
 * not a lookup in the profile's region that finds nothing and reports clean.
 */

const infoSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const logger = { debug: vi.fn(), info: infoSpy, warn: vi.fn(), error: vi.fn(), setLevel: vi.fn() };
  return { getLogger: () => ({ ...logger, child: () => logger }) };
});

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

/** Env-agnostic synthesized stacks: no `region`. */
const synthStacks = vi.hoisted(() => ({ names: ['MyStack'] }));
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn(async () => ({
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
      stacks: synthStacks.names.map((n) => ({
        stackName: n,
        displayName: n,
        template: { Resources: {} },
      })),
    })),
    expandMacrosForStacks: vi.fn(async () => undefined),
  })),
  synthesisStatusMessage: () => 'synthesizing',
}));

const bucketArgs = vi.hoisted(() => ({ value: [] as unknown[][] }));
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveApp: () => 'node app.js',
  resolveStateBucketWithDefault: (...args: unknown[]) => {
    bucketArgs.value.push(args);
    return Promise.resolve('cdkd-state-bucket');
  },
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ s3: {}, destroy: vi.fn() })),
  setAwsClients: vi.fn(),
}));
vi.mock('../../../src/utils/role-arn.js', () => ({ applyRoleArnIfSet: vi.fn() }));

/** Regions in which a state record for `MyStack` exists. */
const held = vi.hoisted(() => ({ regions: new Set<string>() }));
const backend = vi.hoisted(() => ({ getState: vi.fn(), stateExistsOwnedBy: vi.fn() }));
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    getState: backend.getState,
    stateExistsOwnedBy: backend.stateExistsOwnedBy,
    rawObjectExists: vi.fn(async () => false),
    listStacks: vi.fn(async () => []),
  })),
}));
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLockWithRetry: vi.fn(async () => undefined),
    releaseLock: vi.fn(async () => undefined),
  })),
}));

/** The region of each exports index the run opened (`ExportIndexStore`'s 4th argument). */
const indexRegions = vi.hoisted(() => ({ value: [] as string[] }));
vi.mock('../../../src/state/export-index-store.js', () => ({
  ExportIndexStore: vi.fn().mockImplementation((...args: unknown[]) => {
    indexRegions.value.push(args[3] as string);
    return {
      readPersistedEntries: vi.fn(async () => undefined),
      patchEntry: vi.fn(async () => undefined),
    };
  }),
}));

import { scrubCommand, type ScrubOptions } from '../../../src/cli/commands/scrub.js';

function options(overrides: Partial<ScrubOptions> = {}): ScrubOptions {
  return {
    output: 'cdk.out',
    statePrefix: 'cdkd',
    verbose: false,
    all: false,
    dryRun: true,
    ...overrides,
  };
}

/** The regions `MyStack`'s record was read in. */
const readRegions = (): unknown[] =>
  backend.getState.mock.calls.filter((c) => c[0] === 'MyStack').map((c) => c[1]);

const saved = { region: process.env['AWS_REGION'], def: process.env['AWS_DEFAULT_REGION'] };
beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['AWS_REGION'];
  delete process.env['AWS_DEFAULT_REGION'];
  profile.region = 'ap-northeast-1';
  held.regions.clear();
  synthStacks.names = ['MyStack'];
  bucketArgs.value.length = 0;
  indexRegions.value.length = 0;
  backend.stateExistsOwnedBy.mockImplementation(async (_stack: string, region: string) =>
    held.regions.has(region)
  );
  // No record comes back, so the dry run skips cleanly; the assertions are on
  // WHICH region it looked in.
  backend.getState.mockResolvedValue(null);
});

afterEach(() => {
  if (saved.region === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = saved.region;
  if (saved.def === undefined) delete process.env['AWS_DEFAULT_REGION'];
  else process.env['AWS_DEFAULT_REGION'] = saved.def;
});

describe('cdkd scrub of an env-agnostic stack, under a profile region (go-to-k/cdkd#2100)', () => {
  it('scrubs the record in us-east-1 when the old default holds it', async () => {
    held.regions.add('us-east-1');
    await scrubCommand(['MyStack'], options());

    expect(readRegions()).toEqual(['us-east-1']);
    expect(indexRegions.value).toEqual(['us-east-1']);
    expect(backend.stateExistsOwnedBy).toHaveBeenCalledWith('MyStack', 'us-east-1', 'us-east-1');
    expect(infoSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'Continuing to use us-east-1 so the existing stack is not duplicated'
    );
    expect(bucketArgs.value).toEqual([[undefined, 'ap-northeast-1', 'us-east-1']]);
  });

  it('THE OTHER POLARITY: a stack with no state anywhere is scrubbed in the profile region', async () => {
    await scrubCommand(['MyStack'], options());

    expect(readRegions()).toEqual(['ap-northeast-1']);
    expect(indexRegions.value).toEqual(['ap-northeast-1']);
    expect(backend.stateExistsOwnedBy).toHaveBeenCalledWith('MyStack', 'ap-northeast-1', 'us-east-1');
    expect(infoSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
      'Continuing to use us-east-1'
    );
  });

  it('a stack with no state joins its held app sibling in us-east-1', async () => {
    synthStacks.names = ['MyStack', 'Vpc'];
    backend.stateExistsOwnedBy.mockImplementation(
      async (stack: string, region: string) => stack === 'Vpc' && region === 'us-east-1'
    );
    await scrubCommand(['MyStack'], options());
    expect(readRegions()).toEqual(['us-east-1']);
  });

  it('copies an AWS_DEFAULT_REGION answer into AWS_REGION for the SDK (review L1)', async () => {
    process.env['AWS_DEFAULT_REGION'] = 'eu-west-1';
    held.regions.add('eu-west-1');
    await scrubCommand(['MyStack'], options());
    expect(process.env['AWS_REGION']).toBe('eu-west-1');
    expect(bucketArgs.value).toEqual([[undefined, 'eu-west-1', 'us-east-1']]);
    expect(readRegions()).toEqual(['eu-west-1']);
  });

  it('obeys AWS_REGION as named: no probe, and the record is read in that region', async () => {
    process.env['AWS_REGION'] = 'ap-northeast-1';
    held.regions.add('us-east-1');
    await scrubCommand(['MyStack'], options());

    expect(backend.stateExistsOwnedBy).not.toHaveBeenCalled();
    expect(readRegions()).toEqual(['ap-northeast-1']);
  });
});
