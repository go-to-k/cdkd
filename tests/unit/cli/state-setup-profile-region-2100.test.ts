import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#2100: `setupStateBackend`, the shared bootstrap of every
 * `cdkd state` subcommand and of `cdkd rollback`. With no named region its
 * region is the AWS profile's, its exports index stays on the one the old
 * `us-east-1` default wrote while the profile region has none, and its
 * `regionFor` — the fallback for a record listing no region of its own —
 * yields to state that old default wrote.
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
vi.mock('../../../src/cli/config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveStateBucketWithDefault: vi.fn(async (...args: unknown[]) => {
      bucketArgs.value.push(args);
      return 'test-bucket';
    }),
  };
});

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

const world = vi.hoisted(() => ({ state: new Set<string>(), index: new Set<string>() }));
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    verifyBucketExists: vi.fn(async () => undefined),
    destroyClient: vi.fn(),
    stateExistsOwnedBy: vi.fn(async (stack: string, region: string) =>
      world.state.has(`${stack}/${region}`)
    ),
    rawObjectExists: vi.fn(async (key: string) => world.index.has(key)),
  })),
}));

vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({})),
}));

const indexRegion = vi.hoisted(() => ({ value: [] as string[] }));
const removals = vi.hoisted(() => [] as string[][]);
vi.mock('../../../src/state/export-index-store.js', () => ({
  ExportIndexStore: vi.fn().mockImplementation((...args: unknown[]) => {
    indexRegion.value.push(args[3] as string);
    return {
      removeStack: async (stack: string, region: string) => {
        removals.push([args[3] as string, stack, region]);
      },
      removeStackIfPresent: async (stack: string, region: string) => {
        removals.push([`${args[3] as string} (if present)`, stack, region]);
      },
    };
  }),
}));

const { setupStateBackend } = await import('../../../src/cli/commands/state.js');

const saved = { region: process.env['AWS_REGION'], def: process.env['AWS_DEFAULT_REGION'] };
beforeEach(() => {
  delete process.env['AWS_REGION'];
  delete process.env['AWS_DEFAULT_REGION'];
  profile.region = 'ap-northeast-1';
  world.state.clear();
  world.index.clear();
  indexRegion.value.length = 0;
  removals.length = 0;
  bucketArgs.value.length = 0;
  return () => {
    if (saved.region === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = saved.region;
    if (saved.def === undefined) delete process.env['AWS_DEFAULT_REGION'];
    else process.env['AWS_DEFAULT_REGION'] = saved.def;
  };
});

describe('setupStateBackend under a non-us-east-1 profile (go-to-k/cdkd#2100)', () => {
  it('takes the profile region, and holds a stack and the index the old default wrote', async () => {
    world.state.add('Old/us-east-1');
    world.index.add('cdkd/_index/us-east-1/exports.json');
    const setup = await setupStateBackend({ statePrefix: 'cdkd' });
    try {
      expect(setup.region).toBe('ap-northeast-1');
      expect(bucketArgs.value).toEqual([[undefined, 'ap-northeast-1', 'us-east-1']]);
      expect(indexRegion.value).toEqual(['us-east-1']);
      await expect(setup.regionFor('Old')).resolves.toBe('us-east-1');
      await expect(setup.regionFor('New')).resolves.toBe('ap-northeast-1');
    } finally {
      setup.dispose();
    }
  });

  it('uses the profile region for the index when neither region has one', async () => {
    const setup = await setupStateBackend({ statePrefix: 'cdkd' });
    try {
      expect(indexRegion.value).toEqual(['ap-northeast-1']);
    } finally {
      setup.dispose();
    }
  });

  it('obeys AWS_REGION: no hold, no second bucket candidate', async () => {
    process.env['AWS_REGION'] = 'ap-northeast-1';
    world.state.add('Old/us-east-1');
    world.index.add('cdkd/_index/us-east-1/exports.json');
    const setup = await setupStateBackend({ statePrefix: 'cdkd' });
    try {
      expect(bucketArgs.value).toEqual([[undefined, 'ap-northeast-1', undefined]]);
      expect(indexRegion.value).toEqual(['ap-northeast-1']);
      await expect(setup.regionFor('Old')).resolves.toBe('ap-northeast-1');
    } finally {
      setup.dispose();
    }
  });
});

describe("setupStateBackend's index store also clears the OTHER candidate file (review R4-1)", () => {
  it('rollback / state destroy removing a nested child through it clean both files', async () => {
    // `cdkd rollback` hands `setup.exportIndexStore` to the nested-stack
    // context, whose child destroy removes entries through it.
    world.index.add('cdkd/_index/us-east-1/exports.json');
    world.index.add('cdkd/_index/ap-northeast-1/exports.json');
    const setup = await setupStateBackend({ statePrefix: 'cdkd' });
    try {
      await setup.exportIndexStore.removeStack('Parent~Child', 'ap-northeast-1');
      expect(removals).toEqual([
        ['us-east-1', 'Parent~Child', 'ap-northeast-1'],
        ['ap-northeast-1 (if present)', 'Parent~Child', 'ap-northeast-1'],
      ]);
    } finally {
      setup.dispose();
    }
  });

  it('a NAMED region gets the plain store', async () => {
    process.env['AWS_REGION'] = 'ap-northeast-1';
    world.index.add('cdkd/_index/us-east-1/exports.json');
    const setup = await setupStateBackend({ statePrefix: 'cdkd' });
    try {
      await setup.exportIndexStore.removeStack('S', 'ap-northeast-1');
      expect(removals).toEqual([['ap-northeast-1', 'S', 'ap-northeast-1']]);
    } finally {
      setup.dispose();
    }
  });
});
