import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// go-to-k/cdkd#7025 step 6: this file's fake AWS keeps answering the drifted
// read after an update, so the post-revert re-read is stubbed out here; it is
// covered by `tests/unit/cli/drift-revert-verify-7025.test.ts`.
vi.mock('../../../src/cli/commands/drift/revert-verify.js', () => ({
  verifyRevertedStack: vi.fn(async () => ({ notApplied: 0, unverified: 0 })),
}));
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';

/**
 * go-to-k/cdkd#7158 / #7152: a record's `observedMaskedLeaves` names the
 * positions, under keys the template does not set, where the readback echoed
 * a secret that state holds only as `***`. `cdkd drift` reports a mask-only
 * difference there as `notCompared: maskedEcho` by PATH, never as drift (the
 * withdrawn mask-more fix of #7151 made it permanent exit-1 drift), never
 * prints either side, and `--accept` / `--revert` never write or send the
 * value there.
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


const mockSecretsManagerSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({
    get s3() {
      return {};
    },
    get iam() {
      return { send: vi.fn() };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
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
  S3StateBackend: vi.fn(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: mockSaveState,
  })),
}));

vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn(() => ({
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => undefined),
  })),
}));

const mockRegistryGetProvider = vi.fn<(resourceType: string) => unknown>();
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({
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
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: vi.fn(() => ({
    readCurrentState: vi.fn(async () => undefined),
  })),
}));

import {
  createDriftCommand,
  maskMarkedNoEchoBaseline,
} from '../../../src/cli/commands/drift.js';

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


const SSM_TYPE = 'AWS::SSM::Parameter';
const LIVE_SECRET = 'cdkd-masked-echo-live-7158';


function param(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: '/app/token',
    resourceType: SSM_TYPE,
    properties: { Name: '/app/token', Type: 'String', Value: 'public-value' },
    observedProperties: { Name: '/app/token', Type: 'String', Value: 'public-value', Extra: SECRET_MASK },
    observedMaskedLeaves: [['Extra']],
    ...overrides,
  };
}

function makeState(resources: Record<string, ResourceState>): { state: StackState; etag: string } {
  return {
    state: {
      version: 18,
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

describe('cdkd drift: a secret echoed under a key the template lacks (go-to-k/cdkd#7158)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset().mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockSaveState.mockReset().mockResolvedValue('"etag-2"');
    mockRegistryGetProvider.mockReset();
    mockSecretsManagerSend.mockReset();
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

  function readsBack(live: Record<string, unknown>): void {
    mockRegistryGetProvider.mockReturnValue({ readCurrentState: async () => live });
  }

  it('buckets the named position as notCompared maskedEcho in --json, exit code unchanged', async () => {
    mockGetState.mockResolvedValueOnce(makeState({ Token: param() }));
    readsBack({ Name: '/app/token', Type: 'String', Value: 'public-value', Extra: LIVE_SECRET });

    const { output } = await runDrift(['TestStack', '--json']);

    expect(output).not.toContain(LIVE_SECRET);
    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.drifted).toEqual([]);
    // The stable name a CI job keys on.
    expect(payload[0]!.notCompared).toEqual([
      { logicalId: 'Token', type: SSM_TYPE, cause: 'maskedEcho', referencesUnresolved: true },
    ]);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(exitSpy).not.toHaveBeenCalledWith(2);
  });

  it('names the cause and the position, never a value, in the human report', async () => {
    mockGetState.mockResolvedValueOnce(makeState({ Token: param() }));
    readsBack({ Name: '/app/token', Type: 'String', Value: 'public-value', Extra: LIVE_SECRET });

    const { output } = await runDrift(['TestStack']);

    const everything = [output, ...warnSpy.mock.calls.map((c) => String(c[0]))].join('\n');
    expect(everything).not.toContain(LIVE_SECRET);
    expect(output).toContain('AWS echoes a secret into a property the template does not set at Extra');
    expect(output).not.toContain('~ Token');
  });

  it('the same mask with no field naming it is drift, as before (the control)', async () => {
    mockGetState.mockResolvedValueOnce(makeState({ Token: param({ observedMaskedLeaves: undefined }) }));
    readsBack({ Name: '/app/token', Type: 'String', Value: 'public-value', Extra: LIVE_SECRET });

    const { output } = await runDrift(['TestStack', '--json']);

    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.drifted.map((d) => d.logicalId)).toEqual(['Token']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('keeps real drift beside the named position, which alone is bucketed', async () => {
    mockGetState.mockResolvedValueOnce(makeState({ Token: param() }));
    readsBack({ Name: '/app/token', Type: 'SecureString', Value: 'public-value', Extra: LIVE_SECRET });

    const { output } = await runDrift(['TestStack', '--json']);

    expect(output).not.toContain(LIVE_SECRET);
    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.drifted[0]!.changes.map((c) => c.path)).toEqual(['Type']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does not bucket the named position when the live side is ABSENT', async () => {
    mockGetState.mockResolvedValueOnce(makeState({ Token: param() }));
    readsBack({ Name: '/app/token', Type: 'String', Value: 'public-value' });

    const { output } = await runDrift(['TestStack', '--json']);

    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.notCompared).toEqual([]);
    expect(payload[0]!.drifted.map((d) => d.changes.map((c) => c.path))).toEqual([['Extra']]);
  });

  it('--revert never sends the mask at the named position: AWS keeps its own value there', async () => {
    const update = vi.fn(async () => ({
      physicalId: '/app/token',
      effectiveProperties: { Name: '/app/token', Type: 'String', Value: 'public-value', Extra: LIVE_SECRET },
    }));
    mockGetState.mockResolvedValue(makeState({ Token: param() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Name: '/app/token',
        Type: 'SecureString',
        Value: 'public-value',
        Extra: LIVE_SECRET,
      }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(update.mock.calls);
    expect(sent).not.toContain(`"${SECRET_MASK}"`);
    // `Type` is what was reverted.
    expect(sent).toContain('"Type":"String"');
    // At the named position the DESIRED bag (the update's 4th argument)
    // carries AWS's own value back, never the recorded mask: leaving the key
    // out would read as a removal (#1160), as for a `noEchoParameter` path.
    const desired = (update.mock.calls[0] as unknown as unknown[])[3] as Record<string, unknown>;
    expect(desired['Extra']).toBe(LIVE_SECRET);
    // The provider's answer moved no baseline key (`Type` is back to the
    // recorded value), so a save, if any, keeps the named position masked.
    for (const call of mockSaveState.mock.calls) {
      const saved = (call[2] as StackState).resources['Token']!;
      expect(JSON.stringify(saved)).not.toContain(LIVE_SECRET);
      expect(saved.observedProperties?.['Extra']).toBe(SECRET_MASK);
      expect(saved.observedMaskedLeaves).toEqual([['Extra']]);
    }
  });

  it('--accept of another path keeps the named position masked and named', async () => {
    mockGetState.mockResolvedValue(makeState({ Token: param() }));
    readsBack({ Name: '/app/token', Type: 'SecureString', Value: 'public-value', Extra: LIVE_SECRET });

    await runDrift(['TestStack', '--accept', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const saved = (mockSaveState.mock.calls[0]![2] as StackState).resources['Token']!;
    expect(JSON.stringify(saved)).not.toContain(LIVE_SECRET);
    expect(saved.observedProperties).toEqual({
      Name: '/app/token',
      Type: 'SecureString',
      Value: 'public-value',
      Extra: SECRET_MASK,
    });
    expect(saved.observedMaskedLeaves).toEqual([['Extra']]);
  });
});

describe('maskMarkedNoEchoBaseline: the observedMaskedLeaves coordinates (go-to-k/cdkd#7158)', () => {
  const record = (observed: Record<string, unknown>, leaves: (string | number)[][]): ResourceState => ({
    physicalId: 'p',
    resourceType: SSM_TYPE,
    properties: { Name: 'n' },
    observedProperties: observed,
    observedMaskedLeaves: leaves,
  });

  it('masks a named coordinate a written live value holds in the clear', () => {
    const out = maskMarkedNoEchoBaseline(
      { Name: 'n', Extra: LIVE_SECRET, Nested: { Echo: LIVE_SECRET } },
      record({ Name: 'n', Extra: SECRET_MASK, Nested: { Echo: SECRET_MASK } }, [['Extra'], ['Nested', 'Echo']]),
      true
    );
    expect(out).toEqual({ Name: 'n', Extra: SECRET_MASK, Nested: { Echo: SECRET_MASK } });
  });

  it('masks a list AWS returned reordered WHOLE, by index only when it is unchanged', () => {
    const named = record({ Name: 'n', Echoes: ['public-a', SECRET_MASK] }, [['Echoes', 1]]);
    expect(maskMarkedNoEchoBaseline({ Name: 'n', Echoes: ['public-a', LIVE_SECRET] }, named, true)).toEqual({
      Name: 'n',
      Echoes: ['public-a', SECRET_MASK],
    });
    // Whole, as a readback capture masks a list nothing pairs: every leaf.
    expect(maskMarkedNoEchoBaseline({ Name: 'n', Echoes: [LIVE_SECRET, 'public-a'] }, named, true)).toEqual({
      Name: 'n',
      Echoes: [SECRET_MASK, SECRET_MASK],
    });
  });
});
