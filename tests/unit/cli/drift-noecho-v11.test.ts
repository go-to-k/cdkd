import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';

/**
 * go-to-k/cdkd#4043 (schema v11): a record's `noEchoLeaves` names the positions
 * a `NoEcho` template parameter served, which state holds only as `***`
 * whatever the value's type. `cdkd drift` reports a mask-only difference at
 * such a position as `notCompared: noEchoParameter` by PATH, never as drift,
 * and never prints either side; the exit code is unaffected.
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
  loadProviderClasses: vi.fn(async () => ({})),
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


const SSM_TYPE = 'AWS::SSM::Parameter';
const LIVE_SECRET = 'cdkd-noecho-v11-live-7741';

function param(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: '/app/token',
    resourceType: SSM_TYPE,
    properties: { Name: '/app/token', Type: 'String', Value: SECRET_MASK },
    observedProperties: { Name: '/app/token', Type: 'String', Value: SECRET_MASK },
    noEchoLeaves: [['Value']],
    ...overrides,
  };
}

function makeState(resources: Record<string, ResourceState>): { state: StackState; etag: string } {
  return {
    state: {
      version: 11,
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

describe('cdkd drift — a NoEcho parameter position (schema v11, go-to-k/cdkd#4043)', () => {
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

  it.each([
    ['a string', LIVE_SECRET],
    ['a number', 7741],
    ['a boolean', true],
  ])('buckets %s live value at a marked coordinate, exit code unchanged', async (_label, live) => {
    mockGetState.mockResolvedValueOnce(makeState({ Token: param() }));
    readsBack({ Name: '/app/token', Type: 'String', Value: live });

    const { output } = await runDrift(['TestStack', '--json']);

    expect(output).not.toContain(LIVE_SECRET);
    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.drifted).toEqual([]);
    expect(payload[0]!.notCompared).toEqual([
      { logicalId: 'Token', type: SSM_TYPE, cause: 'noEchoParameter', referencesUnresolved: true },
    ]);
    // Exit 0: not drift, and not a clearable incomplete comparison.
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(exitSpy).not.toHaveBeenCalledWith(2);
  });

  it('buckets a list live value at a marked coordinate', async () => {
    mockGetState.mockResolvedValueOnce(
      makeState({
        Token: param({
          properties: { Name: '/app/token', Type: 'StringList', Value: [SECRET_MASK, SECRET_MASK] },
          observedProperties: {
            Name: '/app/token',
            Type: 'StringList',
            Value: [SECRET_MASK, SECRET_MASK],
          },
        }),
      })
    );
    readsBack({ Name: '/app/token', Type: 'StringList', Value: [LIVE_SECRET, 42] });

    const { output } = await runDrift(['TestStack', '--json']);

    expect(output).not.toContain(LIVE_SECRET);
    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.drifted).toEqual([]);
    expect(payload[0]!.notCompared).toEqual([
      expect.objectContaining({ logicalId: 'Token', cause: 'noEchoParameter' }),
    ]);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('accepts a wholly masked list that holds a marked coordinate, whatever its unmarked leaves (review LOW-5)', async () => {
    // The save could not pair the readback list by identity, so it masked the
    // whole list; drift compares by index and must not report the unmarked
    // number beside the marked one as drift forever.
    mockGetState.mockResolvedValueOnce(
      makeState({
        Token: param({
          properties: {
            Name: '/app/token',
            Type: 'String',
            Rules: [
              { From: 80, Secret: 'open' },
              { From: 443, Secret: SECRET_MASK },
            ],
          },
          observedProperties: {
            Name: '/app/token',
            Type: 'String',
            Rules: [
              { From: SECRET_MASK, Secret: SECRET_MASK },
              { From: SECRET_MASK, Secret: SECRET_MASK },
            ],
          },
          noEchoLeaves: [['Rules', 1, 'Secret']],
        }),
      })
    );
    readsBack({
      Name: '/app/token',
      Type: 'String',
      Rules: [
        { From: 443, Secret: LIVE_SECRET },
        { From: 80, Secret: 'open' },
      ],
    });
    const { output } = await runDrift(['TestStack', '--json']);
    expect(output).not.toContain(LIVE_SECRET);
    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.drifted).toEqual([]);
    expect(payload[0]!.notCompared).toEqual([
      expect.objectContaining({ logicalId: 'Token', cause: 'noEchoParameter' }),
    ]);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('--revert names the NoEcho parameter as THE cause when the refused position is marked (review LOW-6)', async () => {
    const update = vi.fn();
    mockGetState.mockResolvedValueOnce(
      makeState({ Token: param({ properties: { Name: '/app/token', Type: 'String', Value: SECRET_MASK, Description: 'from-template' }, observedProperties: { Name: '/app/token', Type: 'String', Value: SECRET_MASK, Description: 'from-template' } }) })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ Name: '/app/token', Type: 'String', Description: 'edited' }),
      update,
    });
    await runDrift(['TestStack', '--revert', '--yes']);
    expect(update).not.toHaveBeenCalled();
    const errored = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errored).toContain('refused to revert Value');
    expect(errored).toContain('a NoEcho template parameter feeds it');
    expect(errored).not.toContain('Three causes');
  });

  it('--revert keeps a declared NoEcho attribute masked when the update echoes a number (review LOW-7)', async () => {
    const update = vi.fn(async () => ({
      physicalId: '/app/token',
      attributes: { Value: 5432, Arn: 'arn:aws:ssm:us-east-1:1:parameter/app/token' },
    }));
    mockGetState.mockResolvedValue(
      makeState({
        Token: {
          physicalId: '/app/token',
          resourceType: SSM_TYPE,
          properties: { Name: '/app/token', Type: 'String', Description: 'from-template' },
          observedProperties: { Name: '/app/token', Type: 'String', Description: 'from-template' },
          attributes: { Value: SECRET_MASK, Arn: 'arn:aws:ssm:us-east-1:1:parameter/app/token' },
          noEchoAttributeNames: ['Value'],
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ Name: '/app/token', Type: 'String', Description: 'edited' }),
      update,
    });
    await runDrift(['TestStack', '--revert', '--yes']);
    expect(update).toHaveBeenCalledTimes(1);
    // The re-recorded attributes equal the record (`***` kept), so nothing is
    // re-saved for them; any save that happens holds the mask, never 5432.
    expect(JSON.stringify(mockSaveState.mock.calls)).not.toContain('5432');
    for (const call of mockSaveState.mock.calls) {
      expect((call[2] as StackState).resources['Token']!.attributes?.['Value']).toBe(SECRET_MASK);
    }
  });

  it('names the position, never a value, in the human report', async () => {
    mockGetState.mockResolvedValueOnce(makeState({ Token: param() }));
    readsBack({ Name: '/app/token', Type: 'String', Value: LIVE_SECRET });

    const { output } = await runDrift(['TestStack']);

    const everything = [output, ...warnSpy.mock.calls.map((c) => String(c[0]))].join('\n');
    expect(everything).not.toContain(LIVE_SECRET);
    expect(output).toContain('NoEcho parameter');
    expect(output).toContain('at Value');
    expect(output).not.toContain('~ Token');
  });

  it('keeps real drift beside the marked position, which alone is bucketed', async () => {
    mockGetState.mockResolvedValueOnce(makeState({ Token: param() }));
    readsBack({ Name: '/app/token', Type: 'SecureString', Value: LIVE_SECRET });

    const { output } = await runDrift(['TestStack', '--json']);

    expect(output).not.toContain(LIVE_SECRET);
    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.drifted[0]!.changes.map((c) => c.path)).toEqual(['Type']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('leaves an UNMARKED mask exactly as before: drifted (the #2274 disposition)', async () => {
    mockGetState.mockResolvedValueOnce(makeState({ Token: param({ noEchoLeaves: undefined }) }));
    readsBack({ Name: '/app/token', Type: 'String', Value: LIVE_SECRET });

    const { output } = await runDrift(['TestStack', '--json']);

    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.drifted.map((d) => d.logicalId)).toEqual(['Token']);
    expect(payload[0]!.notCompared).toEqual([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does not bucket a marked position when the live side is ABSENT', async () => {
    mockGetState.mockResolvedValueOnce(makeState({ Token: param() }));
    readsBack({ Name: '/app/token', Type: 'String' });

    const { output } = await runDrift(['TestStack', '--json']);

    const payload = JSON.parse(output) as DriftJson[];
    expect(payload[0]!.notCompared).toEqual([]);
    // A property AWS no longer reports is real drift (a removal), reported with
    // the masked baseline only.
    expect(payload[0]!.drifted).toEqual([
      expect.objectContaining({
        logicalId: 'Token',
        changes: [{ path: 'Value', stateValue: '***' }],
      }),
    ]);
  });
});
