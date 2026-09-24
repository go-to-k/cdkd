import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';

/**
 * Issue #3595 — a #2852 fail-closed mask in `observedProperties` is an
 * UNKNOWN position, not drift.
 *
 * The readback walk writes `***` wherever it cannot pair a reference-bearing
 * position (the `secrets-array-nested` integ's anchor-arm negative control is
 * the live shape: an unkeyed `['-p', <ref>, '-p', <ref>]`). No live value
 * equals the mask, so `cdkd drift` reported the resource drifted on every run.
 * It now reports it `notCompared` / `uncertifiedBaseline` (exit 2) — but only
 * when the mask is the ONLY difference at that position, and only for the
 * fail-closed class: a `NoEcho` mask keeps the #2274 disposition.
 *
 * The resolver is the real one (AWS sends mocked), as in
 * `drift-secret-redaction.test.ts`: the comparison runs on RESOLVED values, so
 * a stubbed resolver would make the equality agree with a stub.
 */

const warnSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
const errorSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

const ALPHA_EXPR = '{{resolve:secretsmanager:cdkd-test-secret:SecretString:alpha::}}';
const BRAVO_EXPR = '{{resolve:secretsmanager:cdkd-test-secret:SecretString:bravo::}}';
const ALPHA_PLAINTEXT = 'cdkd-uncertified-alpha-901';
const BRAVO_PLAINTEXT = 'cdkd-uncertified-bravo-902';

const mockSecretsManagerSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    get iam() {
      return { send: vi.fn() };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: () => ({
    secretsManager: { send: mockSecretsManagerSend },
    ssm: { send: vi.fn() },
  }),
}));

const mockGetState =
  vi.fn<(stackName: string, region: string) => Promise<{ state: StackState; etag: string } | null>>();
const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockSaveState =
  vi.fn<(stackName: string, region: string, state: StackState, options?: unknown) => Promise<string>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: mockSaveState,
  })),
}));

vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => undefined),
  })),
}));

const mockRegistryGetProvider = vi.fn<(resourceType: string) => unknown>();
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: mockRegistryGetProvider,
    getProviderFor: (input: { resourceType: string }) => ({
      provider: mockRegistryGetProvider(input.resourceType),
      provisionedBy: 'sdk',
    }),
    shouldSkipResource: () => false,
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: vi.fn().mockImplementation(() => ({
    readCurrentState: vi.fn(async () => undefined),
  })),
}));

import { createDriftCommand } from '../../../src/cli/commands/drift.js';

async function runDrift(args: string[]): Promise<{ output: string; error: unknown }> {
  const output: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  let error: unknown;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    process.stdout.write = original;
  }
  return { output: output.join(''), error };
}

const ECS_TYPE = 'AWS::ECS::TaskDefinition';

/** The anchor arm's negative control, as the template spells it. */
function sourceContainers(): Array<Record<string, unknown>> {
  return [{ Name: 'probe', EntryPoint: ['-p', ALPHA_EXPR, '-p', BRAVO_EXPR] }];
}

/** ...as #2852 persisted it: the two positions it could not certify, masked. */
function maskedContainers(): Array<Record<string, unknown>> {
  return [{ Name: 'probe', EntryPoint: ['-p', SECRET_MASK, '-p', SECRET_MASK] }];
}

/** ...and as AWS holds it. */
function liveContainers(entryPoint?: unknown[]): Array<Record<string, unknown>> {
  return [
    { Name: 'probe', EntryPoint: entryPoint ?? ['-p', ALPHA_PLAINTEXT, '-p', BRAVO_PLAINTEXT] },
  ];
}

function taskDef(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'td:1',
    resourceType: ECS_TYPE,
    properties: { Family: 'app', ContainerDefinitions: sourceContainers() },
    observedProperties: { Family: 'app', ContainerDefinitions: maskedContainers() },
    ...overrides,
  };
}

function makeState(resources: Record<string, ResourceState>): { state: StackState; etag: string } {
  return {
    state: {
      version: 10,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources,
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

interface DriftJson {
  drifted: Array<{ logicalId: string; changes: Array<{ path: string; awsValue: unknown }> }>;
  clean: Array<{ logicalId: string }>;
  notCompared: Array<{ logicalId: string; cause: string; referencesUnresolved: boolean }>;
}

function assertNoPlaintext(text: string): void {
  expect(text).not.toContain(ALPHA_PLAINTEXT);
  expect(text).not.toContain(BRAVO_PLAINTEXT);
}

describe('cdkd drift — an uncertified-position baseline mask (issue #3595)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset().mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockSaveState.mockReset().mockResolvedValue('"etag-2"');
    mockRegistryGetProvider.mockReset();
    mockSecretsManagerSend.mockReset().mockImplementation(async () => ({
      SecretString: JSON.stringify({ alpha: ALPHA_PLAINTEXT, bravo: BRAVO_PLAINTEXT }),
    }));
    warnSpy.mockReset();
    infoSpy.mockReset();
    errorSpy.mockReset();
    resetAccountInfoCache();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  function readsBack(live: Record<string, unknown>, update?: unknown): void {
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => live,
      ...(update !== undefined && { update }),
    });
  }

  it('reports a mask-only difference as notCompared/uncertifiedBaseline, exit 2', async () => {
    mockGetState.mockResolvedValueOnce(makeState({ Task: taskDef() }));
    readsBack({ Family: 'app', ContainerDefinitions: liveContainers() });

    const { output } = await runDrift(['TestStack', '--json']);

    assertNoPlaintext(output);
    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.drifted).toEqual([]);
    expect(payload[0]!.clean).toEqual([]);
    expect(payload[0]!.notCompared).toEqual([
      { logicalId: 'Task', type: ECS_TYPE, cause: 'uncertifiedBaseline', referencesUnresolved: true },
    ]);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('names the cause in the human report, without printing the live values', async () => {
    mockGetState.mockResolvedValueOnce(makeState({ Task: taskDef() }));
    readsBack({ Family: 'app', ContainerDefinitions: liveContainers() });

    const { output } = await runDrift(['TestStack']);

    const everything = [output, ...warnSpy.mock.calls.map((c) => String(c[0]))].join('\n');
    assertNoPlaintext(everything);
    expect(everything).toContain('redaction mask');
    // Not reported as a drifted resource.
    expect(output).not.toContain('~ Task');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('keeps real drift BESIDE the mask: drifted with the cause, exit 1', async () => {
    mockGetState.mockResolvedValueOnce(makeState({ Task: taskDef() }));
    readsBack({ Family: 'edited', ContainerDefinitions: liveContainers() });

    const { output } = await runDrift(['TestStack', '--json']);

    assertNoPlaintext(output);
    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.drifted).toHaveLength(1);
    // ONLY the real change — the masked array is not reported as drifted.
    expect(payload[0]!.drifted[0]!.changes.map((c) => c.path)).toEqual(['Family']);
    expect(payload[0]!.notCompared).toEqual([
      expect.objectContaining({ logicalId: 'Task', cause: 'uncertifiedBaseline' }),
    ]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it.each([
    ['an edited literal beside the masked positions', ['-x', ALPHA_PLAINTEXT, '-p', BRAVO_PLAINTEXT]],
    ['a changed length', ['-p', ALPHA_PLAINTEXT, '-p', BRAVO_PLAINTEXT, '-v']],
    ['a reorder AWS reported', [ALPHA_PLAINTEXT, '-p', BRAVO_PLAINTEXT, '-p']],
  ])('keeps %s inside the masked array as drift, masked', async (_label, entryPoint) => {
    mockGetState.mockResolvedValueOnce(makeState({ Task: taskDef() }));
    readsBack({ Family: 'app', ContainerDefinitions: liveContainers(entryPoint) });

    const { output } = await runDrift(['TestStack', '--json']);

    assertNoPlaintext(output);
    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.drifted).toHaveLength(1);
    const change = payload[0]!.drifted[0]!.changes[0]!;
    expect(change.path).toBe('ContainerDefinitions');
    expect(change.awsValue).toBe(SECRET_MASK);
    // No position was split off, so no cause rides the outcome.
    expect(payload[0]!.notCompared).toEqual([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('keeps a NoEcho mask (the mask is in `properties` too) as drifted — #2274 disposition', async () => {
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: taskDef({
          properties: { Family: 'app', ContainerDefinitions: maskedContainers() },
        }),
      })
    );
    readsBack({ Family: 'app', ContainerDefinitions: liveContainers() });

    const { output } = await runDrift(['TestStack', '--json']);

    assertNoPlaintext(output);
    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.drifted.map((d) => d.logicalId)).toEqual(['Task']);
    expect(payload[0]!.notCompared).toEqual([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('keeps a subtree mixing a reference and a NoEcho mask as drifted', async () => {
    // `properties` carries a reference AND a mask under the same array: the
    // mask class there is ambiguous, so the NoEcho disposition wins.
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: taskDef({
          properties: {
            Family: 'app',
            ContainerDefinitions: [
              { Name: 'probe', EntryPoint: ['-p', ALPHA_EXPR, '-p', SECRET_MASK] },
            ],
          },
        }),
      })
    );
    readsBack({ Family: 'app', ContainerDefinitions: liveContainers() });

    const { output } = await runDrift(['TestStack', '--json']);

    assertNoPlaintext(output);
    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.drifted.map((d) => d.logicalId)).toEqual(['Task']);
    expect(payload[0]!.notCompared).toEqual([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('keeps a mask at a position `properties` spells no reference for as drifted', async () => {
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: taskDef({
          properties: {
            Family: 'app',
            ContainerDefinitions: [{ Name: 'probe', EntryPoint: ['-p', 'a', '-p', 'b'] }],
          },
        }),
      })
    );
    readsBack({ Family: 'app', ContainerDefinitions: liveContainers() });

    const { output } = await runDrift(['TestStack', '--json']);

    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.drifted.map((d) => d.logicalId)).toEqual(['Task']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('classifies a reshaped scalar reference (comparator path BELOW the source string)', async () => {
    // `properties.Config` is a whole reference string; the readback came back
    // as an object, so the refusal masked the object's leaf and the
    // comparator reports `Config.Value` — a path `properties` has no node at.
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: {
          physicalId: 'x',
          resourceType: ECS_TYPE,
          properties: { Config: ALPHA_EXPR },
          observedProperties: { Config: { Value: SECRET_MASK } },
        },
      })
    );
    readsBack({ Config: { Value: ALPHA_PLAINTEXT } });

    const { output } = await runDrift(['TestStack', '--json']);

    assertNoPlaintext(output);
    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.drifted).toEqual([]);
    expect(payload[0]!.notCompared.map((n) => n.cause)).toEqual(['uncertifiedBaseline']);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('does NOT classify a mask in a readback-only key beside a templated reference', async () => {
    // The ancestor OBJECT carries a reference in a SIBLING key; that is no
    // evidence about `EXTRA`, which a NoEcho value could equally occupy.
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: {
          physicalId: 'x',
          resourceType: ECS_TYPE,
          properties: { Env: { Variables: { SECRET: ALPHA_EXPR } } },
          observedProperties: { Env: { Variables: { SECRET: ALPHA_EXPR, EXTRA: SECRET_MASK } } },
        },
      })
    );
    readsBack({ Env: { Variables: { SECRET: ALPHA_PLAINTEXT, EXTRA: 'live-extra-value' } } });

    const { output } = await runDrift(['TestStack', '--json']);

    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.drifted[0]!.changes.map((c) => c.path)).toEqual(['Env.Variables.EXTRA']);
    expect(payload[0]!.notCompared).toEqual([]);
    expect(output).not.toContain('live-extra-value');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('leaves a properties-fallback baseline alone (no observed baseline, no fail-closed mask)', async () => {
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: taskDef({
          observedProperties: undefined,
          properties: { Family: 'app', ContainerDefinitions: maskedContainers() },
        }),
      })
    );
    readsBack({ Family: 'app', ContainerDefinitions: liveContainers() });

    const { output } = await runDrift(['TestStack', '--json']);

    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.drifted.map((d) => d.logicalId)).toEqual(['Task']);
    expect(payload[0]!.notCompared).toEqual([]);
  });

  it('--revert leaves the masked array exactly as AWS holds it while reverting the rest', async () => {
    const update = vi.fn(async () => ({}));
    mockGetState.mockResolvedValueOnce(makeState({ Task: taskDef() }));
    readsBack({ Family: 'edited', ContainerDefinitions: liveContainers() }, update);

    const { output } = await runDrift(['TestStack', '--revert', '--yes']);

    assertNoPlaintext(output);
    expect(update).toHaveBeenCalledTimes(1);
    const sent = (update.mock.calls[0] as unknown[])[3] as Record<string, unknown>;
    expect(sent['Family']).toBe('app');
    // The live array, untouched: never the mask, never the source expressions.
    expect(sent['ContainerDefinitions']).toEqual(liveContainers());
  });

  it('--revert sends the live list when real drift shares its TOP-LEVEL key', async () => {
    // `buildRevertNewProperties` overlays whole top-level keys, so `Cfg.Mode`
    // drifting carries the baseline `Cfg` -- masks included -- into the send
    // bag. The anchor-less list cannot be paired by the mask walk, which used
    // to refuse the whole resource; the uncertified position is certified by
    // detection, so the live list goes back as AWS holds it.
    const update = vi.fn(async () => ({}));
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: {
          physicalId: 'x',
          resourceType: ECS_TYPE,
          properties: { Cfg: { Mode: 'a', List: ['-p', ALPHA_EXPR, '-p', BRAVO_EXPR] } },
          observedProperties: {
            Cfg: { Mode: 'a', List: ['-p', SECRET_MASK, '-p', SECRET_MASK] },
          },
        },
      })
    );
    const liveList = ['-p', ALPHA_PLAINTEXT, '-p', BRAVO_PLAINTEXT];
    readsBack({ Cfg: { Mode: 'edited', List: liveList } }, update);

    const { output } = await runDrift(['TestStack', '--revert', '--yes']);

    const everything = [
      output,
      ...warnSpy.mock.calls.map((c) => String(c[0])),
      ...errorSpy.mock.calls.map((c) => String(c[0])),
    ].join('\n');
    assertNoPlaintext(everything);
    expect(update).toHaveBeenCalledTimes(1);
    const sent = (update.mock.calls[0] as unknown[])[3] as Record<string, unknown>;
    expect(sent['Cfg']).toEqual({ Mode: 'a', List: liveList });
    expect(JSON.stringify(sent)).not.toContain(SECRET_MASK);
    // The masker the provider receives knows the live values it was handed.
    const context = (update.mock.calls[0] as unknown[])[5] as
      | { maskSecrets?: (t: string) => string }
      | undefined;
    expect(context?.maskSecrets?.(`bad value ${ALPHA_PLAINTEXT}`)).not.toContain(ALPHA_PLAINTEXT);
  });

  it('--revert registers a live value at a masked position that is NOT today\'s secret', async () => {
    // A rotated-away (or edited) value sits where the baseline holds the mask:
    // equality modulo the mask still holds, so nothing is reverted there, but
    // the value is copied into the send bag -- and today's resolution cannot
    // name it, so only the positional registration keeps it maskable.
    const ROTATED = 'cdkd-rotated-away-alpha-903';
    const update = vi.fn(async () => ({}));
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: {
          physicalId: 'x',
          resourceType: ECS_TYPE,
          properties: { Cfg: { Mode: 'a', List: ['-p', ALPHA_EXPR, '-p', BRAVO_EXPR] } },
          observedProperties: {
            Cfg: { Mode: 'a', List: ['-p', SECRET_MASK, '-p', SECRET_MASK] },
          },
        },
      })
    );
    readsBack({ Cfg: { Mode: 'edited', List: ['-p', ROTATED, '-p', BRAVO_PLAINTEXT] } }, update);

    const { output } = await runDrift(['TestStack', '--revert', '--yes']);

    expect(output).not.toContain(ROTATED);
    expect(update).toHaveBeenCalledTimes(1);
    const context = (update.mock.calls[0] as unknown[])[5] as
      | { maskSecrets?: (t: string) => string }
      | undefined;
    expect(context?.maskSecrets).toBeTypeOf('function');
    expect(context!.maskSecrets!(`bad value ${ROTATED}`)).not.toContain(ROTATED);
    // ...and an ordinary literal of the same list is NOT registered.
    expect(context!.maskSecrets!('flag -p stays')).toBe('flag -p stays');
  });

  it('--accept writes the real change and leaves the masked baseline array as it was', async () => {
    mockGetState.mockResolvedValueOnce(makeState({ Task: taskDef() }));
    readsBack({ Family: 'edited', ContainerDefinitions: liveContainers() });

    const { output } = await runDrift(['TestStack', '--accept', '--yes']);

    assertNoPlaintext(output);
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const saved = mockSaveState.mock.calls[0]![2];
    const observed = saved.resources['Task']!.observedProperties!;
    expect(observed['Family']).toBe('edited');
    expect(observed['ContainerDefinitions']).toEqual(maskedContainers());
    assertNoPlaintext(JSON.stringify(saved));
  });

  it('ranks uncertifiedBaseline ABOVE a permanent unresolvedToken, so the run still exits 2', async () => {
    // `unresolvedToken` alone is excluded from the exit code; were it to win
    // the single-cause slot, the uncompared masked position would exit 0.
    const LOOKALIKE = '{{resolve:notaservice:/cdkd/test/lookalike}}';
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: taskDef({
          properties: {
            Family: 'app',
            Label: LOOKALIKE,
            ContainerDefinitions: sourceContainers(),
          },
          observedProperties: {
            Family: 'app',
            Label: LOOKALIKE,
            ContainerDefinitions: maskedContainers(),
          },
        }),
      })
    );
    readsBack({ Family: 'app', Label: LOOKALIKE, ContainerDefinitions: liveContainers() });

    const { output } = await runDrift(['TestStack', '--json']);

    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.notCompared.map((n) => n.cause)).toEqual(['uncertifiedBaseline']);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('marks a drifted-with-cause resource referencesUnresolved in --json', async () => {
    mockGetState.mockResolvedValueOnce(makeState({ Task: taskDef() }));
    readsBack({ Family: 'edited', ContainerDefinitions: liveContainers() });

    const { output } = await runDrift(['TestStack', '--json']);

    const payload = JSON.parse(output) as Array<{
      drifted: Array<{ referencesUnresolved: boolean }>;
    }>;
    expect(payload[0]!.drifted[0]!.referencesUnresolved).toBe(true);
  });

  it('heads the human report with the uncertified cause, not the reference wording', async () => {
    mockGetState.mockResolvedValueOnce(makeState({ Task: taskDef() }));
    readsBack({ Family: 'app', ContainerDefinitions: liveContainers() });

    const { output } = await runDrift(['TestStack']);

    expect(output).toContain('only PARTIALLY compared — their recorded baseline holds the');
    expect(output).not.toContain('resolve a dynamic reference their state records');
  });

  it('prints the revert plan tag list for an uncertified resource (its map is complete)', async () => {
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: taskDef({
          properties: {
            Family: 'app',
            ContainerDefinitions: sourceContainers(),
            Tags: [{ Key: 'Env', Value: 'a' }],
          },
          observedProperties: {
            Family: 'app',
            ContainerDefinitions: maskedContainers(),
            Tags: [{ Key: 'Env', Value: 'a' }],
          },
        }),
      })
    );
    readsBack({
      Family: 'app',
      ContainerDefinitions: liveContainers(),
      Tags: [
        { Key: 'Env', Value: 'b' },
        { Key: 'AmazonECSManaged', Value: '' },
      ],
    });

    const { output } = await runDrift(['TestStack', '--revert', '--dry-run']);

    assertNoPlaintext(output);
    expect(output).toContain('reverting this tag list KEEPS');
    expect(output).not.toContain("could not resolve this resource's dynamic reference");
  });

  it('withholds the revert plan tag list when a surviving token rides BESIDE the uncertified cause', async () => {
    // The single `notComparedCause` reads `uncertifiedBaseline` here, but the
    // token means the map cannot mask everything the live readback holds.
    const LOOKALIKE = '{{resolve:notaservice:/cdkd/test/lookalike}}';
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: taskDef({
          properties: {
            Family: 'app',
            Label: LOOKALIKE,
            ContainerDefinitions: sourceContainers(),
            Tags: [{ Key: 'Env', Value: 'a' }],
          },
          observedProperties: {
            Family: 'app',
            Label: LOOKALIKE,
            ContainerDefinitions: maskedContainers(),
            Tags: [{ Key: 'Env', Value: 'a' }],
          },
        }),
      })
    );
    readsBack({
      Family: 'app',
      Label: LOOKALIKE,
      ContainerDefinitions: liveContainers(),
      Tags: [
        { Key: 'Env', Value: 'b' },
        { Key: 'AmazonECSManaged', Value: '' },
      ],
    });

    const { output } = await runDrift(['TestStack', '--revert', '--dry-run']);

    // The change line itself shows the tag list; what is under test is the
    // plan's separate preserved-key LIST, withheld rather than printed.
    expect(output).toContain("could not resolve this resource's dynamic reference");
    expect(output).not.toContain('reverting this tag list KEEPS');
  });

  it('uses the mixed heading when uncertified and reference causes share a report', async () => {
    const LOOKALIKE = '{{resolve:notaservice:/cdkd/test/lookalike}}';
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: taskDef(),
        Other: {
          physicalId: 'y',
          resourceType: ECS_TYPE,
          properties: { Label: LOOKALIKE },
          observedProperties: { Label: LOOKALIKE },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async (physicalId: string) =>
        physicalId === 'y'
          ? { Label: LOOKALIKE }
          : { Family: 'app', ContainerDefinitions: liveContainers() },
    });

    const { output } = await runDrift(['TestStack']);

    expect(output).toContain(
      'only PARTIALLY compared — some of their properties were NOT compared; each entry below names why'
    );
  });

  it('uses the short uncertified clause beside a resource not compared AT ALL', async () => {
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: taskDef(),
        Broken: {
          physicalId: 'z',
          resourceType: ECS_TYPE,
          properties: { Family: 'b' },
          observedProperties: { Family: 'b' },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async (physicalId: string) => {
        if (physicalId === 'z') throw new Error('AccessDenied: read refused');
        return { Family: 'app', ContainerDefinitions: liveContainers() };
      },
    });

    const { output } = await runDrift(['TestStack']);

    expect(output).toContain('1 only PARTIALLY compared (a baseline position cdkd could not certify)');
  });

  it('keeps a readback-only DOTTED key beside a reference as drifted', async () => {
    // `properties` has no dotted key, so only the BASELINE shows the path is
    // ambiguous; without that check the walk would reach the string `k` and
    // read a sibling reference as evidence.
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: {
          physicalId: 'x',
          resourceType: ECS_TYPE,
          properties: { X: { k: ALPHA_EXPR } },
          observedProperties: { X: { k: ALPHA_EXPR, 'k.y': SECRET_MASK } },
        },
      })
    );
    readsBack({ X: { k: ALPHA_PLAINTEXT, 'k.y': 'live-dotted-value' } });

    const { output } = await runDrift(['TestStack', '--json']);

    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.drifted.map((d) => d.logicalId)).toEqual(['Task']);
    expect(payload[0]!.notCompared).toEqual([]);
    expect(output).not.toContain('live-dotted-value');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('withholds the revert plan tag list when resolution was REFUSED', async () => {
    mockSecretsManagerSend.mockReset().mockRejectedValue(new Error('AccessDeniedException: no'));
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: taskDef({
          properties: {
            Family: 'app',
            Secret: ALPHA_EXPR,
            Tags: [{ Key: 'Env', Value: 'a' }],
          },
          observedProperties: {
            Family: 'app',
            Secret: ALPHA_EXPR,
            Tags: [{ Key: 'Env', Value: 'a' }],
          },
        }),
      })
    );
    readsBack({
      Family: 'app',
      Secret: ALPHA_PLAINTEXT,
      Tags: [
        { Key: 'Env', Value: 'b' },
        { Key: 'AmazonECSManaged', Value: '' },
      ],
    });

    const { output } = await runDrift(['TestStack', '--revert', '--dry-run']);

    expect(output).toContain("could not resolve this resource's dynamic reference");
    expect(output).not.toContain('reverting this tag list KEEPS');
  });

  it('--revert never persists an unnameable live value from an UNTOUCHED key the provider narrowed', async () => {
    // The uncertified list sits under its own top-level key, which no kept
    // change touches, so the send bag takes it straight from the snapshot. The
    // provider then reports a narrowing of that key, and the #1644 write
    // persists its echo into the baseline -- where the position source holds
    // `***` (no reference, so the fail-closed walk never fires) and today's
    // resolution has no needle for a rotated-away value. Only the positional
    // registration keeps it out of state.json.
    const ROTATED = 'cdkd-rotated-away-alpha-903';
    const live = ['-p', ROTATED, '-p', BRAVO_PLAINTEXT];
    const update = vi.fn(async (...args: unknown[]) => ({
      effectiveProperties: { ...(args[3] as Record<string, unknown>), List: [...live, '-extra'] },
    }));
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: {
          physicalId: 'x',
          resourceType: ECS_TYPE,
          properties: { Mode: 'a', List: ['-p', ALPHA_EXPR, '-p', BRAVO_EXPR] },
          observedProperties: { Mode: 'a', List: ['-p', SECRET_MASK, '-p', SECRET_MASK] },
        },
      })
    );
    readsBack({ Mode: 'edited', List: live }, update);

    const { output } = await runDrift(['TestStack', '--revert', '--yes']);

    expect(output).not.toContain(ROTATED);
    expect(update).toHaveBeenCalledTimes(1);
    // The key reached the provider straight from the snapshot, so only the
    // registration keeps its log lines masked.
    const context = (update.mock.calls[0] as unknown[])[5] as
      | { maskSecrets?: (t: string) => string }
      | undefined;
    expect(context!.maskSecrets!(`x ${ROTATED}`)).not.toContain(ROTATED);
    expect(mockSaveState).toHaveBeenCalled();
    for (const call of mockSaveState.mock.calls) {
      const written = JSON.stringify(call[2]);
      expect(written).not.toContain(ROTATED);
      assertNoPlaintext(written);
    }
  });

  it('--revert keeps a DROP of an uncertified top-level key as a delete', async () => {
    const update = vi.fn(async (...args: unknown[]) => {
      const { List: _dropped, ...rest } = args[3] as Record<string, unknown>;
      void _dropped;
      return { effectiveProperties: rest };
    });
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: {
          physicalId: 'x',
          resourceType: ECS_TYPE,
          properties: { Mode: 'a', List: ['-p', ALPHA_EXPR, '-p', BRAVO_EXPR] },
          observedProperties: { Mode: 'a', List: ['-p', SECRET_MASK, '-p', SECRET_MASK] },
        },
      })
    );
    readsBack({ Mode: 'edited', List: ['-p', ALPHA_PLAINTEXT, '-p', BRAVO_PLAINTEXT] }, update);

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    const observed = mockSaveState.mock.calls.at(-1)![2].resources['Task']!.observedProperties!;
    expect(Object.keys(observed)).not.toContain('List');
  });

  it('--revert keeps the masked baseline when the provider narrows an uncertified position holding a SHORT value', async () => {
    // A 1-3 character value is below the needle floor, so registration cannot
    // cover it; the narrowing write must keep the baseline's own mask there.
    const SHORT = 'q7x';
    const update = vi.fn(async (...args: unknown[]) => ({
      effectiveProperties: {
        ...(args[3] as Record<string, unknown>),
        List: ['-p', SHORT, '-p', BRAVO_PLAINTEXT, '-extra'],
      },
    }));
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: {
          physicalId: 'x',
          resourceType: ECS_TYPE,
          properties: { Mode: 'a', List: ['-p', ALPHA_EXPR, '-p', BRAVO_EXPR] },
          observedProperties: { Mode: 'a', List: ['-p', SECRET_MASK, '-p', SECRET_MASK] },
        },
      })
    );
    readsBack({ Mode: 'edited', List: ['-p', SHORT, '-p', BRAVO_PLAINTEXT] }, update);

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    expect(mockSaveState).toHaveBeenCalled();
    const observed = mockSaveState.mock.calls.at(-1)![2].resources['Task']!.observedProperties!;
    expect(observed['List']).toEqual(['-p', SECRET_MASK, '-p', SECRET_MASK]);
    for (const call of mockSaveState.mock.calls) {
      expect(JSON.stringify(call[2])).not.toContain(SHORT);
    }
  });

  it('--revert registers every live string under an uncertified path whose RAW sides do not align', async () => {
    // Detection compares CANONICALIZED bags (tag lists sorted by Key), so a
    // reordered live tag list is uncertified there; the revert reads the RAW
    // readback, where the positions do not line up, and must still leave no
    // live value it cannot name unmasked for the provider's log lines.
    const ROTATED = 'cdkd-rotated-away-tag-904';
    const update = vi.fn(async () => ({}));
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: {
          physicalId: 'x',
          resourceType: ECS_TYPE,
          properties: {
            Mode: 'a',
            Tags: [
              { Key: 'a', Value: 'plain' },
              { Key: 'b', Value: ALPHA_EXPR },
            ],
          },
          observedProperties: {
            Mode: 'a',
            Tags: [
              { Key: 'a', Value: 'plain' },
              { Key: 'b', Value: SECRET_MASK },
            ],
          },
        },
      })
    );
    readsBack(
      {
        Mode: 'edited',
        Tags: [
          { Key: 'b', Value: ROTATED },
          { Key: 'a', Value: 'plain' },
        ],
      },
      update
    );

    const { output } = await runDrift(['TestStack', '--revert', '--yes']);

    expect(output).not.toContain(ROTATED);
    expect(update).toHaveBeenCalledTimes(1);
    // Premise: Tags was uncertified (sent as AWS holds it, raw order and all),
    // not overlaid as drift, so the NON-aligned arm is what ran.
    const sent = (update.mock.calls[0] as unknown[])[3] as Record<string, unknown>;
    expect(sent['Tags']).toEqual([
      { Key: 'b', Value: ROTATED },
      { Key: 'a', Value: 'plain' },
    ]);
    const context = (update.mock.calls[0] as unknown[])[5] as
      | { maskSecrets?: (t: string) => string }
      | undefined;
    expect(context!.maskSecrets!(`rejected ${ROTATED}`)).not.toContain(ROTATED);
  });

  it('--revert sends AWS values at EVERY uncertified position of one resource', async () => {
    const update = vi.fn(async () => ({}));
    const liveA = ['-p', ALPHA_PLAINTEXT, '-p', BRAVO_PLAINTEXT];
    const liveB = ['-q', BRAVO_PLAINTEXT, '-q', ALPHA_PLAINTEXT];
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: {
          physicalId: 'x',
          resourceType: ECS_TYPE,
          properties: {
            Cfg: {
              Mode: 'a',
              ListA: ['-p', ALPHA_EXPR, '-p', BRAVO_EXPR],
              ListB: ['-q', BRAVO_EXPR, '-q', ALPHA_EXPR],
            },
          },
          observedProperties: {
            Cfg: {
              Mode: 'a',
              ListA: ['-p', SECRET_MASK, '-p', SECRET_MASK],
              ListB: ['-q', SECRET_MASK, '-q', SECRET_MASK],
            },
          },
        },
      })
    );
    readsBack({ Cfg: { Mode: 'edited', ListA: liveA, ListB: liveB } }, update);

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    const sent = (update.mock.calls[0] as unknown[])[3] as Record<string, unknown>;
    expect(sent['Cfg']).toEqual({ Mode: 'a', ListA: liveA, ListB: liveB });
  });

  it('--revert on a mask-only resource sends nothing and says the comparison was incomplete', async () => {
    const update = vi.fn(async () => ({}));
    mockGetState.mockResolvedValueOnce(makeState({ Task: taskDef() }));
    readsBack({ Family: 'app', ContainerDefinitions: liveContainers() }, update);

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(update).not.toHaveBeenCalled();
    const info = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(info).toContain('Comparison INCOMPLETE');
    expect(info).toContain('holds the redaction mask');
  });

  it('--accept on a mask-only resource writes nothing for it', async () => {
    mockGetState.mockResolvedValueOnce(makeState({ Task: taskDef() }));
    readsBack({ Family: 'app', ContainerDefinitions: liveContainers() });

    const { output } = await runDrift(['TestStack', '--accept', '--yes']);

    assertNoPlaintext(output);
    expect(mockSaveState).not.toHaveBeenCalled();
    const info = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(info).toContain('Comparison INCOMPLETE');
    expect(info).toContain('holds the redaction mask');
  });

  it('names what re-captures the baseline when --accept refuses a masked array', async () => {
    mockGetState.mockResolvedValueOnce(makeState({ Task: taskDef() }));
    readsBack({
      Family: 'app',
      ContainerDefinitions: liveContainers(['-x', ALPHA_PLAINTEXT, '-p', BRAVO_PLAINTEXT]),
    });

    await runDrift(['TestStack', '--accept', '--yes']);

    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('not accepting');
    expect(warned).toContain('CHANGES this resource');
    expect(warned).not.toContain('Re-deploy to refresh it');
    assertNoPlaintext(warned);
  });
});

describe('equalModuloMask / isUncertifiedBaselineMaskPosition (issue #3595)', () => {
  it('lets a mask match only a STRING, positionally', async () => {
    const { equalModuloMask } = await import('../../../src/analyzer/drift-calculator.js');
    expect(equalModuloMask(['a', SECRET_MASK], ['a', 'live'], SECRET_MASK)).toBe(true);
    expect(equalModuloMask({ K: SECRET_MASK }, { K: 42 }, SECRET_MASK)).toBe(false);
    expect(equalModuloMask({ K: SECRET_MASK }, { K: { nested: 'x' } }, SECRET_MASK)).toBe(false);
    expect(equalModuloMask({ K: SECRET_MASK }, {}, SECRET_MASK)).toBe(false);
    expect(equalModuloMask([SECRET_MASK, 'a'], ['a', 'live'], SECRET_MASK)).toBe(false);
    expect(equalModuloMask({ A: 1, B: SECRET_MASK }, { A: 1, B: 'x', C: 2 }, SECRET_MASK)).toBe(
      false
    );
  });

  it('reads the class from `properties` at the comparator path', async () => {
    const { isUncertifiedBaselineMaskPosition } = await import(
      '../../../src/deployment/secret-redaction.js'
    );
    const props = {
      Env: { Variables: { SECRET: ALPHA_EXPR, PLAIN: 'x' } },
      Config: ALPHA_EXPR,
      Masked: [SECRET_MASK],
    };
    expect(isUncertifiedBaselineMaskPosition(props, 'Env.Variables.SECRET')).toBe(true);
    expect(isUncertifiedBaselineMaskPosition(props, 'Env')).toBe(true);
    expect(isUncertifiedBaselineMaskPosition(props, 'Config.Value')).toBe(true);
    expect(isUncertifiedBaselineMaskPosition(props, 'Env.Variables.PLAIN')).toBe(false);
    expect(isUncertifiedBaselineMaskPosition(props, 'Env.Variables.EXTRA')).toBe(false);
    expect(isUncertifiedBaselineMaskPosition(props, 'Masked')).toBe(false);
    expect(isUncertifiedBaselineMaskPosition(props, 'Absent')).toBe(false);
    // Own keys only: an inherited name is not a node `properties` holds.
    expect(isUncertifiedBaselineMaskPosition(props, 'constructor')).toBe(false);
    // A key CONTAINING a dot makes the path ambiguous, so it fails closed
    // (the NoEcho disposition) -- whether the dotted key spells the whole rest
    // of the path or only part of it, and whatever it holds.
    const dotted = { X: { k: ALPHA_EXPR, 'k.y': SECRET_MASK } };
    expect(isUncertifiedBaselineMaskPosition(dotted, 'X.k.y')).toBe(false);
    const partway = { a: ALPHA_EXPR, 'a.b': { c: SECRET_MASK } };
    expect(isUncertifiedBaselineMaskPosition(partway, 'a.b.c')).toBe(false);
    expect(isUncertifiedBaselineMaskPosition({ X: { 'k.y': ALPHA_EXPR } }, 'X.k.y')).toBe(false);
    // An unrelated dotted sibling does not make an ordinary path ambiguous.
    expect(
      isUncertifiedBaselineMaskPosition({ X: { k: ALPHA_EXPR, 'z.q': 'v' } }, 'X.k')
    ).toBe(true);
  });
});
