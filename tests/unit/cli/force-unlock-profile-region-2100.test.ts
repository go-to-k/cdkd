import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#2100: `cdkd force-unlock <stack>` for a stack with NO state
 * record — a first deploy that crashed holding its lock — falls back to the
 * run's region. That region now comes from the AWS profile, so a lock the old
 * `us-east-1` default wrote must still be found and released there; one in
 * neither region is looked for in the profile's region.
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

const profile = vi.hoisted(() => ({ region: 'ap-northeast-1' as string | undefined }));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    config: {
      region: async (): Promise<string> => {
        if (!profile.region) throw new Error('Region is missing');
        return profile.region;
      },
    },
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

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    listStacks: vi.fn(async () => []),
    stateExistsOwnedBy: vi.fn(async (_stack: string, region: string) =>
      locks.stateRegions.has(region)
    ),
  })),
}));

vi.mock('../../../src/provisioning/providers/create-token-ledger.js', () => ({
  ledgerForStack: () => ({ noteAbandoned: vi.fn(async () => undefined) }),
}));

const locks = vi.hoisted(() => ({
  regions: new Set<string>(),
  stateRegions: new Set<string>(),
  released: [] as unknown[],
}));
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    isLocked: vi.fn(async (_stack: string, region: string) => locks.regions.has(region)),
    getLockInfo: vi.fn(async () => null),
    forceReleaseLock: vi.fn(async (_stack: string, region?: string) => {
      locks.released.push(region);
      return undefined;
    }),
  })),
}));

import { createForceUnlockCommand } from '../../../src/cli/commands/force-unlock.js';

async function runForceUnlock(args: string[]): Promise<void> {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('__process_exit__');
  }) as never);
  try {
    const cmd = createForceUnlockCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== '__process_exit__') throw error;
  } finally {
    exitSpy.mockRestore();
  }
}

const saved = { region: process.env['AWS_REGION'], def: process.env['AWS_DEFAULT_REGION'] };
beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['AWS_REGION'];
  delete process.env['AWS_DEFAULT_REGION'];
  profile.region = 'ap-northeast-1';
  locks.regions.clear();
  locks.stateRegions.clear();
  locks.released.length = 0;
  bucketArgs.value.length = 0;
  return () => {
    if (saved.region === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = saved.region;
    if (saved.def === undefined) delete process.env['AWS_DEFAULT_REGION'];
    else process.env['AWS_DEFAULT_REGION'] = saved.def;
  };
});

describe('cdkd force-unlock with no state record, under a profile region (go-to-k/cdkd#2100)', () => {
  it('releases a lock the old us-east-1 default wrote (old lock present)', async () => {
    locks.regions.add('us-east-1');
    await runForceUnlock(['MyStack', '--state-bucket', 'b']);
    expect(locks.released).toEqual(['us-east-1']);
  });

  it('releases in us-east-1 when only a region-less record there names the stack', async () => {
    // The state half of the composite probe: no lock key anywhere, but the
    // stack's record is owned by the old default.
    locks.stateRegions.add('us-east-1');
    await runForceUnlock(['MyStack', '--state-bucket', 'b']);
    expect(locks.released).toEqual(['us-east-1']);
  });

  it('looks in the profile region when no lock exists in either (old lock absent)', async () => {
    await runForceUnlock(['MyStack', '--state-bucket', 'b']);
    expect(locks.released).toEqual(['ap-northeast-1']);
  });

  it('builds the legacy bucket name from the profile region, with us-east-1 as second candidate', async () => {
    await runForceUnlock(['MyStack']);
    expect(bucketArgs.value).toEqual([[undefined, 'ap-northeast-1', 'us-east-1']]);
  });

  it('obeys AWS_REGION as named, never looking under us-east-1', async () => {
    process.env['AWS_REGION'] = 'ap-northeast-1';
    locks.regions.add('us-east-1');
    await runForceUnlock(['MyStack', '--state-bucket', 'b']);
    expect(locks.released).toEqual(['ap-northeast-1']);
  });
});
