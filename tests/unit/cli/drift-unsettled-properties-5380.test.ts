/**
 * go-to-k/cdkd#5380: `cdkd drift` shows the properties a failed deploy left
 * unsettled (`ResourceState.unsettledProperties`) in both renderings, and a
 * successful `--accept` / `--revert` of the resource clears them, since the
 * record then describes what AWS holds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const logLines = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const push =
    (level: string) =>
    (...args: unknown[]): void => {
      logLines.push(`${level} ${args.map(String).join(' ')}`);
    };
  const make = (): Record<string, unknown> => ({
    setLevel: vi.fn(),
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => make(),
  });
  return { reserveStdoutForPayload: vi.fn(), getLogger: () => make() };
});
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
  getAwsClients: () => ({}),
}));
const mockSaveState = vi.fn(async (..._args: unknown[]) => '"etag-2"');
const mockGetState = vi.fn<() => Promise<{ state: StackState; etag: string } | null>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: vi.fn(async () => [{ stackName: 'TestStack', region: 'us-east-1' }]),
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: mockSaveState,
  })),
}));
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn(async () => true),
    getLockInfo: vi.fn(async () => null),
    releaseLock: vi.fn(async () => undefined),
  })),
}));
const mockGetProvider = vi.hoisted(() => vi.fn());
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: (type: string) => mockGetProvider(type),
    getProviderFor: (input: { resourceType: string }) => ({
      provider: mockGetProvider(input.resourceType),
      provisionedBy: 'sdk',
    }),
    shouldSkipResource: () => false,
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: vi.fn().mockImplementation(() => ({
    readCurrentState: vi.fn(async () => undefined),
  })),
}));

import { createDriftCommand } from '../../../src/cli/commands/drift.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const TYPE = 'AWS::KinesisFirehose::DeliveryStream';
const ENC = 'DeliveryStreamEncryptionConfigurationInput';

/** `Drifted`'s AWS readback differs from its baseline; `Settled`'s matches. */
function stateWith(extra: { drifted?: Partial<ResourceState>; settled?: Partial<ResourceState> }): StackState {
  const record = (name: string, more: Partial<ResourceState> = {}): ResourceState =>
    ({
      physicalId: name,
      resourceType: TYPE,
      properties: { DeliveryStreamName: name, DeliveryStreamType: 'DirectPut' },
      observedProperties: { DeliveryStreamName: name, DeliveryStreamType: 'DirectPut' },
      attributes: {},
      dependencies: [],
      ...more,
    }) as ResourceState;
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: 'TestStack',
    region: 'us-east-1',
    resources: {
      Drifted: record('drifted', extra.drifted),
      Settled: record('settled', extra.settled),
    },
    outputs: {},
    lastModified: 0,
  };
}

async function runDrift(
  state: StackState,
  flags: string[],
  update: () => Promise<unknown> = async () => ({ physicalId: 'drifted', attributes: {} }),
  inTransition?: (
    names: ReadonlySet<string>,
    recordedProperties?: Record<string, unknown>
  ) => Promise<ReadonlySet<string>>
): Promise<{ stdout: string; saved: StackState | undefined; updates: number }> {
  let updates = 0;
  mockGetState.mockResolvedValue({ state, etag: '"etag-1"' });
  mockGetProvider.mockImplementation(() => ({
    readCurrentState: async (physicalId: string) =>
      physicalId === 'drifted'
        ? { DeliveryStreamName: 'drifted', DeliveryStreamType: 'KinesisStreamAsSource' }
        : { DeliveryStreamName: physicalId, DeliveryStreamType: 'DirectPut' },
    update: vi.fn(async () => {
      updates++;
      return update();
    }),
    ...(inTransition !== undefined && {
      unsettledInTransition: async (
        _p: string,
        _l: string,
        _t: string,
        names: ReadonlySet<string>,
        recordedProperties?: Record<string, unknown>
      ) => inTransition(names, recordedProperties),
    }),
  }));
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['TestStack', '--state-bucket', 'b', '--region', 'us-east-1', ...flags], {
      from: 'user',
    });
  } catch {
    // exit / process.exit stub
  } finally {
    process.stdout.write = original;
  }
  const saved = mockSaveState.mock.calls.at(-1)?.[2] as StackState | undefined;
  return { stdout: chunks.join(''), saved, updates };
}

describe('cdkd drift and unsettled properties (go-to-k/cdkd#5380)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    mockGetState.mockReset();
    mockGetProvider.mockReset();
    mockSaveState.mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });
  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('the human report lists each unsettled resource with its property names', async () => {
    const { stdout } = await runDrift(stateWith({ settled: { unsettledProperties: [ENC] } }), []);
    expect(stdout).toContain('a failed deploy left properties unsettled on 1 resource');
    expect(stdout).toMatch(new RegExp(`! Settled \\(${TYPE.replace(/[.:]/g, '\\$&')}\\): ${ENC}`));
  });

  it('the human report has no unsettled block when no record carries one', async () => {
    const { stdout } = await runDrift(stateWith({}), []);
    expect(stdout).not.toContain('unsettled');
  });

  it('--json carries an unsettled array, omitted when empty', async () => {
    const withField = await runDrift(stateWith({ settled: { unsettledProperties: [ENC] } }), ['--json']);
    const payload = JSON.parse(withField.stdout) as Array<Record<string, unknown>>;
    expect(payload[0]?.['unsettled']).toEqual([{ logicalId: 'Settled', type: TYPE, properties: [ENC] }]);
    const without = await runDrift(stateWith({}), ['--json']);
    expect((JSON.parse(without.stdout) as Array<Record<string, unknown>>)[0]).not.toHaveProperty('unsettled');
  });

  it('--accept clears the accepted resource and leaves an unaccepted one', async () => {
    const { saved } = await runDrift(
      stateWith({ drifted: { unsettledProperties: [ENC] }, settled: { unsettledProperties: ['Tags'] } }),
      ['--accept', '--yes']
    );
    expect(saved).toBeDefined();
    expect(saved?.resources['Drifted']).not.toHaveProperty('unsettledProperties');
    expect(saved?.resources['Drifted']?.observedProperties?.['DeliveryStreamType']).toBe(
      'KinesisStreamAsSource'
    );
    expect(saved?.resources['Settled']?.unsettledProperties).toEqual(['Tags']);
  });

  it('a successful --revert clears the reverted resource', async () => {
    const { saved } = await runDrift(stateWith({ drifted: { unsettledProperties: [ENC] } }), [
      '--revert',
      '--yes',
    ]);
    expect(saved).toBeDefined();
    expect(saved?.resources['Drifted']).not.toHaveProperty('unsettledProperties');
  });

  it('--revert clears only the reverted resource; one it did not revert keeps the field', async () => {
    const { saved } = await runDrift(
      stateWith({ drifted: { unsettledProperties: [ENC] }, settled: { unsettledProperties: ['Tags'] } }),
      ['--revert', '--yes']
    );
    expect(saved?.resources['Drifted']).not.toHaveProperty('unsettledProperties');
    expect(saved?.resources['Settled']?.unsettledProperties).toEqual(['Tags']);
  });

  it('a --revert whose state write fails says the settling was not recorded', async () => {
    logLines.length = 0;
    mockSaveState.mockRejectedValueOnce(new Error('AccessDenied on PutObject'));
    await runDrift(stateWith({ drifted: { unsettledProperties: [ENC] } }), ['--revert', '--yes']);
    const warned = logLines.filter((l) => l.startsWith('warn ') && l.includes('could not record'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("that a failed deploy's unsettled properties are settled");
  });

  it.each([['--accept', ['--accept', '--yes']]])('%s keeps a key the provider reports still in transition, and clears one it does not', async (_l, flags) => {
    const kept = await runDrift(
      stateWith({ drifted: { unsettledProperties: [ENC, 'Tags'] } }),
      flags,
      undefined,
      async (names) => new Set([...names].filter((n) => n === ENC))
    );
    expect(kept.saved?.resources['Drifted']?.unsettledProperties).toEqual([ENC]);
    mockSaveState.mockClear();
    const cleared = await runDrift(
      stateWith({ drifted: { unsettledProperties: [ENC] } }),
      flags,
      undefined,
      async () => new Set()
    );
    expect(cleared.saved?.resources['Drifted']).not.toHaveProperty('unsettledProperties');
  });

  it('the transition hook is handed the record\'s properties (go-to-k/cdkd#5487: a parent id it needs)', async () => {
    let seen: Record<string, unknown> | undefined;
    await runDrift(
      stateWith({ drifted: { unsettledProperties: [ENC] } }),
      ['--accept', '--yes'],
      undefined,
      async (_names, recorded) => {
        seen = recorded;
        return new Set();
      }
    );
    expect(seen?.['DeliveryStreamName']).toBe('drifted');
  });

  it('a transition hook that throws keeps every name', async () => {
    const { saved } = await runDrift(
      stateWith({ drifted: { unsettledProperties: [ENC] } }),
      ['--accept', '--yes'],
      undefined,
      async () => {
        throw new Error('throttled');
      }
    );
    expect(saved?.resources['Drifted']?.unsettledProperties).toEqual([ENC]);
  });

  it('--revert refuses a resource with a name AWS is still changing (go-to-k/cdkd#5487), and writes nothing', async () => {
    const { saved, updates } = await runDrift(
      stateWith({ drifted: { unsettledProperties: [ENC] } }),
      ['--revert', '--yes'],
      undefined,
      async (names) => names
    );
    expect(updates).toBe(0);
    expect(saved).toBeUndefined();
  });

  it('--revert of a resource with no name in transition reverts and clears it', async () => {
    const { saved, updates } = await runDrift(
      stateWith({ drifted: { unsettledProperties: [ENC] } }),
      ['--revert', '--yes'],
      undefined,
      async () => new Set()
    );
    expect(updates).toBe(1);
    expect(saved?.resources['Drifted']).not.toHaveProperty('unsettledProperties');
  });

  it('a failed --revert writes nothing, so the record keeps the field', async () => {
    const { saved, updates } = await runDrift(
      stateWith({ drifted: { unsettledProperties: [ENC] } }),
      ['--revert', '--yes'],
      async () => {
        throw new Error('AccessDenied');
      }
    );
    expect(updates).toBeGreaterThan(0);
    expect(saved).toBeUndefined();
  });

  it('a successful --revert of a resource with nothing unsettled writes no state', async () => {
    const { saved, updates } = await runDrift(stateWith({}), ['--revert', '--yes']);
    expect(updates).toBe(1);
    expect(saved).toBeUndefined();
  });
});
