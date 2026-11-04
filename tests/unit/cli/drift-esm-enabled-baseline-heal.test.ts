import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#5749: a mapping deployed by a cdkd older than #5737 holds
 * `observedProperties.Enabled: false` (the post-create read saw `Creating`)
 * while the live mapping is `Enabled` and the template leaves `Enabled` at its
 * default. `cdkd drift` reported `Enabled: false -> true` and `--revert` sent
 * `Enabled: false`, stopping the consumer. Driven through the REAL
 * `LambdaEventSourceMappingProvider`, so the readback, the comparison and the revert's
 * `UpdateEventSourceMapping` input are all asserted at the wire.
 */

vi.mock('../../../src/utils/logger.js', () => {
  const make = (): Record<string, unknown> => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => make(),
  });
  return { reserveStdoutForPayload: vi.fn(), getLogger: () => make() };
});

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

const mockLambdaSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    get lambda() {
      return { send: mockLambdaSend };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

const mockSaveState = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => '"etag-2"'));
const mockGetState = vi.fn<() => Promise<{ state: StackState; etag: string } | null>>();
const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: mockListStacks,
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

import {
  createDriftCommand,
  preFixBaselineUncomparedDriftKeys,
} from '../../../src/cli/commands/drift.js';
import { LambdaEventSourceMappingProvider } from '../../../src/provisioning/providers/lambda-eventsource-provider.js';

const ESM = 'AWS::Lambda::EventSourceMapping';
const UUID = '11111111-2222-3333-4444-555555555555';
const FN_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:consumer';
const QUEUE_ARN = 'arn:aws:sqs:us-east-1:123456789012:jobs.fifo';
const ESM_ARN = `arn:aws:lambda:us-east-1:123456789012:event-source-mapping:${UUID}`;

/** The live mapping: `State` plus a `BatchSize` a case can drift. */
function stubLambda(state: string, batchSize = 10): void {
  mockLambdaSend.mockImplementation(async (command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case 'GetEventSourceMappingCommand':
        return {
          UUID,
          FunctionArn: FN_ARN,
          EventSourceArn: QUEUE_ARN,
          EventSourceMappingArn: ESM_ARN,
          BatchSize: batchSize,
          State: state,
        };
      case 'ListTagsCommand':
        return { Tags: {} };
      case 'UpdateEventSourceMappingCommand':
        return { UUID, EventSourceMappingArn: ESM_ARN, State: 'Updating' };
      default:
        return {};
    }
  });
}

/** What the readback of a settled mapping with `BatchSize: 10` looks like. */
async function settledReadback(state: string): Promise<Record<string, unknown>> {
  stubLambda(state);
  const bag = await new LambdaEventSourceMappingProvider().readCurrentState(UUID, 'Esm', ESM, {});
  mockLambdaSend.mockReset();
  return bag as Record<string, unknown>;
}

function stackState(
  properties: Record<string, unknown>,
  observedProperties: Record<string, unknown>
): { state: StackState; etag: string } {
  return {
    state: {
      version: 2,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: {
        Esm: {
          physicalId: UUID,
          resourceType: ESM,
          properties,
          observedProperties,
          attributes: { Id: UUID },
        },
      },
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

const TEMPLATE = { FunctionName: FN_ARN, EventSourceArn: QUEUE_ARN, BatchSize: 10 };

async function run(args: string[]): Promise<{ out: string; thrown: unknown }> {
  const out: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  let thrown: unknown;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['TestStack', '--state-bucket', 'b', '--region', 'us-east-1', ...args], {
      from: 'user',
    });
  } catch (err) {
    thrown = err;
  } finally {
    process.stdout.write = original;
  }
  return { out: out.join(''), thrown };
}

/** `cdkd drift --json`: the ESM's verdict and, when drifted, its paths. */
async function detect(): Promise<{ verdict: string; paths: string[] }> {
  const { out } = await run(['--json']);
  const [report] = JSON.parse(out) as Array<
    Record<string, Array<{ logicalId: string; changes?: Array<{ path: string }> }>>
  >;
  for (const verdict of ['clean', 'drifted', 'notSupported', 'notCompared']) {
    const row = (report![verdict] ?? []).find((r) => r.logicalId === 'Esm');
    if (row) return { verdict, paths: (row.changes ?? []).map((c) => c.path) };
  }
  return { verdict: 'missing', paths: [] };
}

function updateInputs(): Array<Record<string, unknown>> {
  return mockLambdaSend.mock.calls
    .map((call) => call[0] as { constructor: { name: string }; input: Record<string, unknown> })
    .filter((command) => command.constructor.name === 'UpdateEventSourceMappingCommand')
    .map((command) => command.input);
}

describe('preFixBaselineUncomparedDriftKeys (go-to-k/cdkd#5749)', () => {
  // The four corners the issue names (baseline false/true x template
  // absent/false x live Enabled/Disabled). Only one of them is the artifact.
  it.each([
    // baseline, template Enabled ('absent' = not declared), live, expected
    [false, 'absent', true, ['Enabled']],
    [false, 'absent', false, []],
    [false, false, true, []],
    [false, false, false, []],
    [true, 'absent', true, []],
    [true, 'absent', false, []],
    [true, false, true, []],
    [true, false, false, []],
  ] as const)(
    'baseline Enabled %s, template %s, live %s -> %j',
    (recorded, declared, live, expected) => {
      const properties: Record<string, unknown> =
        declared === 'absent' ? { ...TEMPLATE } : { ...TEMPLATE, Enabled: declared };
      expect(
        preFixBaselineUncomparedDriftKeys(
          ESM,
          { ...TEMPLATE, Enabled: recorded },
          properties,
          { ...TEMPLATE, Enabled: live }
        )
      ).toEqual(expected);
    }
  );

  it('reads the template the way the provider does: true and "true" are not a declared false', () => {
    for (const declared of [true, 'true', 'True']) {
      expect(
        preFixBaselineUncomparedDriftKeys(
          ESM,
          { Enabled: false },
          { Enabled: declared },
          { Enabled: true }
        )
      ).toEqual(['Enabled']);
    }
    for (const declared of [false, 'false', 'FALSE']) {
      expect(
        preFixBaselineUncomparedDriftKeys(
          ESM,
          { Enabled: false },
          { Enabled: declared },
          { Enabled: true }
        )
      ).toEqual([]);
    }
  });

  it('reads a string "false" baseline as the artifact too', () => {
    expect(
      preFixBaselineUncomparedDriftKeys(ESM, { Enabled: 'false' }, {}, { Enabled: true })
    ).toEqual(['Enabled']);
  });

  it('applies to no other type, no properties-fallback baseline, and no malformed record', () => {
    expect(
      preFixBaselineUncomparedDriftKeys(
        'AWS::Events::Rule',
        { Enabled: false },
        {},
        { Enabled: true }
      )
    ).toEqual([]);
    expect(preFixBaselineUncomparedDriftKeys(ESM, undefined, {}, { Enabled: true })).toEqual([]);
    expect(
      preFixBaselineUncomparedDriftKeys(ESM, { Enabled: false }, undefined, { Enabled: true })
    ).toEqual([]);
    expect(
      preFixBaselineUncomparedDriftKeys(ESM, { Enabled: false }, [], { Enabled: true })
    ).toEqual([]);
    // A live value that is not the boolean `true` is no evidence of enabled.
    expect(
      preFixBaselineUncomparedDriftKeys(ESM, { Enabled: false }, {}, { Enabled: 'true' })
    ).toEqual([]);
    expect(preFixBaselineUncomparedDriftKeys(ESM, { Enabled: false }, {}, {})).toEqual([]);
  });
});

describe('cdkd drift on a pre-#5737 Enabled: false baseline (go-to-k/cdkd#5749)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockGetState.mockReset();
    mockSaveState.mockClear();
    mockListStacks.mockReset().mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
    mockGetProvider.mockReset().mockImplementation(() => new LambdaEventSourceMappingProvider());
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('reports the settled Enabled mapping clean', async () => {
    const observed = { ...(await settledReadback('Enabled')), Enabled: false };
    mockGetState.mockResolvedValue(stackState(TEMPLATE, observed));
    stubLambda('Enabled');

    expect(await detect()).toEqual({ verdict: 'clean', paths: [] });
  });

  it('reports another drifted key on that mapping, and only that key', async () => {
    const observed = { ...(await settledReadback('Enabled')), Enabled: false };
    mockGetState.mockResolvedValue(stackState(TEMPLATE, observed));
    stubLambda('Enabled', 25);

    expect(await detect()).toEqual({ verdict: 'drifted', paths: ['BatchSize'] });
  });

  it('--revert of another drifted key never sends Enabled: false', async () => {
    const observed = { ...(await settledReadback('Enabled')), Enabled: false };
    mockGetState.mockResolvedValue(stackState(TEMPLATE, observed));
    stubLambda('Enabled', 25);

    await run(['--revert', '--yes']);

    const inputs = updateInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!['BatchSize']).toBe(10);
    expect(inputs[0]!['Enabled']).not.toBe(false);
  });

  it('--accept of another drifted key leaves Enabled out of what it writes', async () => {
    const observed = { ...(await settledReadback('Enabled')), Enabled: false };
    mockGetState.mockResolvedValue(stackState(TEMPLATE, observed));
    stubLambda('Enabled', 25);

    await run(['--accept', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const saved = mockSaveState.mock.calls[0]![2] as StackState;
    expect(saved.resources['Esm']!.observedProperties!['BatchSize']).toBe(25);
    // Unchanged: --accept writes the detected changes only.
    expect(saved.resources['Esm']!.observedProperties!['Enabled']).toBe(false);
  });

  it('still reports, and reverts, Enabled when the template declares Enabled: false', async () => {
    const observed = { ...(await settledReadback('Enabled')), Enabled: false };
    mockGetState.mockResolvedValue(stackState({ ...TEMPLATE, Enabled: false }, observed));
    stubLambda('Enabled');

    expect(await detect()).toEqual({ verdict: 'drifted', paths: ['Enabled'] });

    mockLambdaSend.mockClear();
    await run(['--revert', '--yes']);
    const inputs = updateInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!['Enabled']).toBe(false);
  });

  it('still reports an out-of-band disable against a true baseline', async () => {
    const observed = await settledReadback('Enabled');
    expect(observed['Enabled']).toBe(true);
    mockGetState.mockResolvedValue(stackState(TEMPLATE, observed));
    stubLambda('Disabled');

    expect(await detect()).toEqual({ verdict: 'drifted', paths: ['Enabled'] });
  });
});
