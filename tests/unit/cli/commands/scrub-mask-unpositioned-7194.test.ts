/**
 * go-to-k/cdkd#7194: through `scrubCommand`, an orphan or superseded record
 * scrub cannot position (no `noEchoLeaves`, its logical id gone from the
 * template, no live record to learn from) fails `--fail`, and
 * `--mask-unpositioned` masks every string leaf of it, records the positions,
 * and so clears the finding. Live records and positioned records are left
 * alone, no value reaches the output, and `--dry-run` writes nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const logLines: string[] = [];
vi.mock('../../../../src/utils/logger.js', () => {
  const push =
    (level: string) =>
    (...args: unknown[]): void =>
      void logLines.push(`${level} ${args.map(String).join(' ')}`);
  const fake = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    setLevel: (): void => {},
    child: (): unknown => fake,
  };
  return { getLogger: () => fake };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  STSClient: class {
    readonly config = { region: (): Promise<string> => Promise.resolve('us-east-1') };
    send(): Promise<unknown> {
      return Promise.resolve({ Account: '111122223333', Arn: 'arn:aws:iam::111122223333:root' });
    }
    destroy(): void {}
  },
}));

const synthStacks = vi.hoisted(() => [] as unknown[]);
vi.mock('../../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn(() => ({
    synthesize: vi.fn().mockImplementation(() => Promise.resolve({ stacks: synthStacks })),
    expandMacrosForStacks: vi.fn().mockResolvedValue(undefined),
  })),
  synthesisStatusMessage: () => 'synthesizing',
}));
vi.mock('../../../../src/cli/config-loader.js', () => ({
  resolveApp: () => 'node app.js',
  resolveStateBucketWithDefault: () => Promise.resolve('cdkd-state-bucket'),
}));
vi.mock('../../../../src/utils/role-arn.js', () => ({ applyRoleArnIfSet: vi.fn() }));

const stateStore = vi.hoisted(() => new Map<string, unknown>());
const stateBackend = vi.hoisted(() => ({
  prefix: 'cdkd',
  getState: vi.fn(),
  saveState: vi.fn(),
  purgeNoncurrentVersions: vi.fn(async (_keys: string[]): Promise<void> => undefined),
  getRawObject: vi.fn(async () => null),
  listStacks: vi.fn(),
}));
vi.mock('../../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn(() => stateBackend),
}));
vi.mock('../../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn(() => ({
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('../../../../src/state/export-index-store.js', () => ({
  ExportIndexStore: vi.fn(() => ({
    readPersistedEntries: vi.fn().mockResolvedValue(undefined),
    patchEntry: vi.fn().mockResolvedValue(true),
  })),
}));

import { resetAwsClients } from '../../../../src/utils/aws-clients.js';
import { scrubCommand, ScrubNeededError } from '../../../../src/cli/commands/scrub.js';
import type { ResourceState, StackState } from '../../../../src/types/state.js';

const REGION = 'us-east-1';
const STACK = 'Stk7194Mask';
const TYPE = 'AWS::Test::Db7194';
const KEY = `${STACK}|${REGION}`;
const TOKEN = '{{resolve:ssm:/p7194}}';
// Values the output must never print.
const SECRETS = ['q9-secret-7194', 'obs-secret-7194', 'attr-secret-7194', 'nested-7194', 'kept-7194'];

const live: ResourceState = {
  physicalId: 'db-live',
  resourceType: TYPE,
  properties: { Password: '***', Name: 'live-name' },
  noEchoLeaves: [['Password']],
};

/** The record scrub cannot position: every shape of leaf the option meets. */
const unpositioned = (): ResourceState => ({
  physicalId: 'db-gone-phys',
  resourceType: TYPE,
  properties: {
    Password: 'q9-secret-7194',
    Port: 5432,
    Enabled: true,
    Empty: '',
    Ref: TOKEN,
    Masked: '***',
    Tags: [{ Key: 'k', Value: 'nested-7194' }],
    Map: { inner: 'nested-7194', n: null },
  },
  observedProperties: { Password: 'q9-secret-7194', Extra: 'obs-secret-7194', Count: 3 },
  attributes: { Arn: 'attr-secret-7194', Size: 7 },
});

function seed(rows: { orphans?: StackState['orphans']; superseded?: unknown[] }): void {
  stateStore.set(KEY, {
    version: 18,
    region: REGION,
    stackName: STACK,
    resources: { Db: live },
    outputs: {},
    lastModified: 0,
    ...(rows.orphans !== undefined && { orphans: rows.orphans }),
    ...(rows.superseded !== undefined && { supersededResources: rows.superseded }),
  });
}

async function run(extra: Record<string, unknown> = {}): Promise<unknown> {
  logLines.length = 0;
  try {
    await scrubCommand([STACK], {
      output: 'cdk.out',
      statePrefix: 'cdkd',
      verbose: false,
      ...extra,
    } as never);
    return undefined;
  } catch (err) {
    return err;
  }
}

const stored = (): StackState => stateStore.get(KEY) as StackState;

describe('cdkd scrub --mask-unpositioned (go-to-k/cdkd#7194)', () => {
  beforeEach(() => {
    synthStacks.length = 0;
    synthStacks.push({
      stackName: STACK,
      displayName: STACK,
      artifactId: STACK,
      dependencyNames: [],
      region: REGION,
      template: {
        Parameters: { Pw: { Type: 'String', NoEcho: true, Default: 'q7' } },
        Resources: {
          Db: { Type: TYPE, Properties: { Password: { Ref: 'Pw' }, Name: 'live-name' } },
        },
      },
    });
    stateStore.clear();
    process.env['AWS_REGION'] = REGION;
    resetAwsClients();
    stateBackend.getState.mockReset().mockImplementation((stack: string, region: string) => {
      const state = stateStore.get(`${stack}|${region}`);
      return Promise.resolve(
        state === undefined ? null : { state: structuredClone(state), etag: 'etag-1' }
      );
    });
    stateBackend.saveState
      .mockReset()
      .mockImplementation((stack: string, region: string, state: unknown) => {
        stateStore.set(`${stack}|${region}`, structuredClone(state));
        return Promise.resolve('etag-2');
      });
    stateBackend.listStacks.mockReset().mockResolvedValue([]);
  });

  it('masks every string leaf of an unverifiable orphan and nothing else', async () => {
    seed({ orphans: [{ logicalId: 'Gone', orphanedAt: 1, state: unpositioned() }] });
    expect(await run({ maskUnpositioned: true })).toBeUndefined();
    const row = stored().orphans![0]!;
    expect(row.logicalId).toBe('Gone');
    expect(row.orphanedAt).toBe(1);
    expect(row.state.physicalId).toBe('db-gone-phys');
    expect(row.state.resourceType).toBe(TYPE);
    expect(row.state.properties).toEqual({
      Password: '***',
      Port: 5432,
      Enabled: true,
      Empty: '',
      Ref: TOKEN,
      Masked: '***',
      Tags: [{ Key: '***', Value: '***' }],
      Map: { inner: '***', n: null },
    });
    expect(row.state.observedProperties).toEqual({ Password: '***', Extra: '***', Count: 3 });
    expect(row.state.attributes).toEqual({ Arn: '***', Size: 7 });
    expect(row.state.noEchoLeaves).toEqual([
      ['Map', 'inner'],
      ['Password'],
      ['Tags', 0, 'Key'],
      ['Tags', 0, 'Value'],
    ]);
    expect(row.state.observedMaskedLeaves).toEqual([['Extra']]);
    expect(row.state.noEchoAttributeNames).toEqual(['Arn']);
  });

  it('--fail fails over such a record, and passes once --mask-unpositioned masked it', async () => {
    seed({
      superseded: [{ logicalId: 'GoneToo', supersededAt: 2, state: unpositioned() }],
    });
    const before = await run({ fail: true });
    expect(before).toBeInstanceOf(ScrubNeededError);
    expect(logLines.join('\n')).toContain('--mask-unpositioned');
    expect(await run({ dryRun: true, fail: true })).toBeInstanceOf(ScrubNeededError);
    expect(await run({ maskUnpositioned: true, fail: true })).toBeUndefined();
    expect(await run({ fail: true })).toBeUndefined();
    expect(await run({ dryRun: true, fail: true })).toBeUndefined();
    expect(logLines.join('\n')).toContain('No plaintext secrets found');
  });

  it('leaves the live record and every positioned record alone', async () => {
    const positionedEmpty: ResourceState = {
      physicalId: 'p-empty',
      resourceType: TYPE,
      properties: { Name: 'kept-7194' },
      noEchoLeaves: [],
    };
    const positionedByTemplate: ResourceState = {
      physicalId: 'p-template',
      resourceType: TYPE,
      properties: { Password: '***', Name: 'kept-7194' },
      noEchoLeaves: [['Password']],
    };
    seed({
      orphans: [{ logicalId: 'GoneEmpty', orphanedAt: 1, state: positionedEmpty }],
      superseded: [{ logicalId: 'Db', supersededAt: 2, state: positionedByTemplate }],
    });
    const before = structuredClone(stored());
    expect(await run({ maskUnpositioned: true, fail: true })).toBeUndefined();
    expect(stored().resources).toEqual(before.resources);
    expect(stored().orphans).toEqual(before.orphans);
    expect(stored().supersededResources).toEqual(before.supersededResources);
  });

  it('a live record\'s empty noEchoLeaves is no evidence for an older record of its id', async () => {
    stateStore.set(KEY, {
      version: 18,
      region: REGION,
      stackName: STACK,
      resources: {
        Db: live,
        Old: { physicalId: 'old-live', resourceType: TYPE, properties: {}, noEchoLeaves: [] },
      },
      outputs: {},
      lastModified: 0,
      orphans: [{ logicalId: 'Old', orphanedAt: 1, state: unpositioned() }],
    });
    expect(await run({ fail: true })).toBeInstanceOf(ScrubNeededError);
    expect(logLines.join('\n')).toContain('orphan record Old');
  });

  it('a live record with an empty noEchoLeaves is positioned by today\'s template', async () => {
    stateStore.set(KEY, {
      version: 18,
      region: REGION,
      stackName: STACK,
      resources: {
        Db: { ...live, properties: { Password: 'q9-secret-7194', Name: 'live-name' }, noEchoLeaves: [] },
      },
      outputs: {},
      lastModified: 0,
    });
    expect(await run({})).toBeUndefined();
    expect(stored().resources['Db']!.properties).toEqual({ Password: '***', Name: 'live-name' });
    expect(stored().resources['Db']!.noEchoLeaves).toEqual([['Password']]);
  });

  it('prints no value, with or without the option', async () => {
    seed({ orphans: [{ logicalId: 'Gone', orphanedAt: 1, state: unpositioned() }] });
    await run({ fail: true });
    const without = logLines.join('\n');
    await run({ dryRun: true, maskUnpositioned: true });
    const dry = logLines.join('\n');
    await run({ maskUnpositioned: true });
    const real = logLines.join('\n');
    for (const text of [without, dry, real]) {
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    }
    expect(dry).toContain('would mask');
    expect(real).toContain('masked');
  });

  it('--dry-run --mask-unpositioned writes nothing and still fails --fail', async () => {
    seed({ orphans: [{ logicalId: 'Gone', orphanedAt: 1, state: unpositioned() }] });
    const before = structuredClone(stored());
    const err = await run({ dryRun: true, maskUnpositioned: true, fail: true });
    expect(err).toBeInstanceOf(ScrubNeededError);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    expect(stored()).toEqual(before);
    // Still counted: state still holds the record unmasked.
    expect(logLines.join('\n')).toContain('name no NoEcho positions scrub can verify');
    expect(logLines.join('\n')).toContain(
      'would mask, in the orphan record Gone (AWS::Test::Db7194) in Stk7194Mask, 4 string value(s) in properties, 2 in the readback (observed properties) and 1 in attributes'
    );
  });
});
