import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6497 / #6498: Secrets Manager reads a rotation schedule set as
 * `ScheduleExpression: rate(N days)` back with `AutomaticallyAfterDays: N`
 * too, and refuses a write carrying both. End to end through `cdkd drift` /
 * `--revert` over a provider that behaves like Cloud Control's handler: the
 * update's model is the bag it is sent. #6498: the revert also carries the
 * template's write-only `RotateImmediatelyOnUpdate`, which no read returns.
 */

vi.mock('../../../src/utils/logger.js', () => ({
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
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

const mockGetState =
  vi.fn<(stackName: string, region: string) => Promise<{ state: StackState; etag: string } | null>>();
const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: vi.fn(async () => '"etag-2"'),
  })),
}));

vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => undefined),
  })),
}));

const mockRegistryGetProvider = vi.fn<(resourceType: string) => unknown>();
let routedBy: 'sdk' | 'cc-api' = 'cc-api';
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: mockRegistryGetProvider,
    getProviderFor: (input: { resourceType: string }) => ({
      provider: mockRegistryGetProvider(input.resourceType),
      provisionedBy: routedBy,
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

vi.mock('../../../src/provisioning/read-only-properties.js', () => ({
  getReadOnlyPropertyPaths: vi.fn(async () => ['Id']),
}));

const mockWriteOnly = vi.hoisted(() =>
  vi.fn<(type: string) => Promise<ReadonlySet<string> | undefined>>()
);
const mockUnreadableCreateOnly = vi.hoisted(() =>
  vi.fn<(type: string, properties: Record<string, unknown>) => ReadonlySet<string>>()
);
vi.mock('../../../src/provisioning/write-only-properties.js', () => ({
  tryGetTopLevelWriteOnlyProperties: mockWriteOnly,
  getTopLevelKeysHoldingUnreadableCreateOnly: mockUnreadableCreateOnly,
}));

import { createDriftCommand } from '../../../src/cli/commands/drift.js';
import { stripDerivedEchoMembers } from '../../../src/cli/commands/drift/baseline-keys.js';
import {
  withDeclaredWriteOnlyProperties,
  revertWriteOnlyResendNames,
} from '../../../src/cli/commands/drift/revert-payload.js';

const TYPE = 'AWS::SecretsManager::RotationSchedule';
const SECRET = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:Sec-abc';
const FN = 'arn:aws:lambda:us-east-1:123456789012:function:Rot';

/** What Secrets Manager stores and reads back for a set of rules. */
function stored(rules: Record<string, unknown>): Record<string, unknown> {
  const m = /^rate\((\d+) days\)$/.exec(String(rules['ScheduleExpression']));
  return m ? { ...rules, AutomaticallyAfterDays: Number(m[1]) } : { ...rules };
}

let liveRules: Record<string, unknown> = {};
const sent: Record<string, unknown>[] = [];
/** Each update's whole bag. */
const sentBags: Record<string, unknown>[] = [];

const provider = {
  readCurrentState: async () => ({
    SecretId: SECRET,
    Id: SECRET,
    RotationLambdaARN: FN,
    RotationRules: { ...liveRules },
  }),
  update: async (
    _lid: string,
    physicalId: string,
    _type: string,
    properties: Record<string, unknown>
  ) => {
    const rules = (properties['RotationRules'] ?? {}) as Record<string, unknown>;
    sent.push(rules);
    sentBags.push(properties);
    if ('ScheduleExpression' in rules && 'AutomaticallyAfterDays' in rules) {
      throw new Error('You cannot specify both rotation frequency and schedule expression together.');
    }
    liveRules = stored(rules);
    return { physicalId, wasReplaced: false };
  },
};

function stack(): { state: StackState; etag: string } {
  const schedule: ResourceState = {
    physicalId: SECRET,
    resourceType: TYPE,
    properties: {
      SecretId: SECRET,
      RotationLambdaARN: FN,
      RotateImmediatelyOnUpdate: false,
      RotationRules: { ScheduleExpression: 'rate(60 days)' },
    },
    observedProperties: {
      SecretId: SECRET,
      Id: SECRET,
      RotationLambdaARN: FN,
      RotationRules: { ScheduleExpression: 'rate(60 days)', AutomaticallyAfterDays: 60 },
    },
  };
  return {
    state: {
      version: 3,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: { Sched: schedule },
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let stdout = '';

async function runDrift(flags: string[]): Promise<number | undefined> {
  const original = process.stdout.write.bind(process.stdout);
  stdout = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  exitSpy.mockClear();
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['TestStack', ...flags], { from: 'user' });
  } catch {
    // The command exits through the stubbed `process.exit`.
  } finally {
    process.stdout.write = original;
  }
  const calls = exitSpy.mock.calls;
  return calls.length === 0 ? 0 : (calls[calls.length - 1]![0] as number | undefined);
}

describe('cdkd drift on a rotation schedule read with its AutomaticallyAfterDays echo (go-to-k/cdkd#6497)', () => {
  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockRegistryGetProvider.mockReset();
    mockRegistryGetProvider.mockImplementation(() => provider);
    mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockImplementation(async () => stack());
    sent.length = 0;
    sentBags.length = 0;
    routedBy = 'cc-api';
    mockWriteOnly.mockReset();
    mockWriteOnly.mockResolvedValue(new Set(['RotateImmediatelyOnUpdate', 'HostedRotationLambda']));
    mockUnreadableCreateOnly.mockReset();
    mockUnreadableCreateOnly.mockReturnValue(new Set());
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('an unchanged schedule is clean', async () => {
    liveRules = stored({ ScheduleExpression: 'rate(60 days)' });
    expect(await runDrift([])).toBe(0);
  });

  it('--revert of an out-of-band AutomaticallyAfterDays sends the expression alone', async () => {
    liveRules = { AutomaticallyAfterDays: 10 };
    expect(await runDrift([])).toBe(1);

    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(sent).toEqual([{ ScheduleExpression: 'rate(60 days)' }]);
    expect(liveRules).toEqual({ ScheduleExpression: 'rate(60 days)', AutomaticallyAfterDays: 60 });
  });

  it('--revert of an out-of-band expression change sends the expression alone', async () => {
    liveRules = stored({ ScheduleExpression: 'rate(10 days)' });
    expect(await runDrift([])).toBe(1);

    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(sent).toEqual([{ ScheduleExpression: 'rate(60 days)' }]);
  });
});

describe('cdkd drift --revert carries a Cloud Control record\'s declared write-only properties (go-to-k/cdkd#6498)', () => {
  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockRegistryGetProvider.mockReset();
    mockRegistryGetProvider.mockImplementation(() => provider);
    mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockImplementation(async () => stack());
    sentBags.length = 0;
    mockWriteOnly.mockReset();
    mockWriteOnly.mockResolvedValue(new Set(['RotateImmediatelyOnUpdate', 'HostedRotationLambda']));
    mockUnreadableCreateOnly.mockReset();
    mockUnreadableCreateOnly.mockReturnValue(new Set());
    liveRules = { AutomaticallyAfterDays: 10 };
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('sends the declared RotateImmediatelyOnUpdate: false beside the reverted rules', async () => {
    routedBy = 'cc-api';
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(sentBags).toHaveLength(1);
    expect(sentBags[0]!['RotateImmediatelyOnUpdate']).toBe(false);
    expect(mockWriteOnly).toHaveBeenCalledWith(TYPE);
  });

  it('adds nothing for an SDK-routed record', async () => {
    routedBy = 'sdk';
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(sentBags).toHaveLength(1);
    expect(sentBags[0]).not.toHaveProperty('RotateImmediatelyOnUpdate');
    expect(mockWriteOnly).not.toHaveBeenCalled();
  });

  it('adds nothing when the write-only lookup failed', async () => {
    routedBy = 'cc-api';
    mockWriteOnly.mockResolvedValue(undefined);
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(sentBags[0]).not.toHaveProperty('RotateImmediatelyOnUpdate');
  });

  it('names the re-sent write-only property in the plan, under --dry-run too', async () => {
    routedBy = 'cc-api';
    await runDrift(['--revert', '--dry-run']);
    expect(sentBags).toHaveLength(0);
    expect(stdout).toContain(
      "    + also sends the template's write-only RotateImmediatelyOnUpdate (AWS never returns them on a read)"
    );
  });

  it('neither sends nor names a write-only key holding an unreadable create-only path', async () => {
    routedBy = 'cc-api';
    mockUnreadableCreateOnly.mockReturnValue(new Set(['RotateImmediatelyOnUpdate']));
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(sentBags[0]).not.toHaveProperty('RotateImmediatelyOnUpdate');
    expect(stdout).not.toContain('also sends');
  });
});

describe('revertWriteOnlyResendNames', () => {
  beforeEach(() => {
    mockWriteOnly.mockReset();
    mockWriteOnly.mockResolvedValue(new Set(['W', 'X']));
    mockUnreadableCreateOnly.mockReset();
    mockUnreadableCreateOnly.mockReturnValue(new Set());
  });

  it('names a declared plain write-only value', async () => {
    expect(await revertWriteOnlyResendNames('cc-api', TYPE, { A: 1, W: false })).toEqual(['W']);
  });

  it.each([
    ['a dynamic reference', { W: '{{resolve:secretsmanager:s:SecretString:p}}' }],
    ['a nested dynamic reference', { W: { Pw: '{{resolve:ssm-secure:p}}' } }],
    ['a redaction mask', { W: '***' }],
    ['a nested redaction mask', { W: ['***'] }],
    ['an intrinsic object', { W: { Inner: { 'Fn::GetAtt': ['R', 'Arn'] } } }],
    ['a null value', { W: null }],
    ['an undeclared name', { Y: 1 }],
  ])('names nothing for %s', async (_l, properties) => {
    expect(await revertWriteOnlyResendNames('cc-api', TYPE, properties)).toEqual([]);
  });

  it('names nothing off the Cloud Control route, without a lookup', async () => {
    expect(await revertWriteOnlyResendNames('sdk', TYPE, { W: 1 })).toEqual([]);
    expect(await revertWriteOnlyResendNames(undefined, TYPE, { W: 1 })).toEqual([]);
    expect(mockWriteOnly).not.toHaveBeenCalled();
  });

  it('names nothing when the lookup failed', async () => {
    mockWriteOnly.mockResolvedValue(undefined);
    expect(await revertWriteOnlyResendNames('cc-api', TYPE, { W: 1 })).toEqual([]);
  });

  it('leaves out a key holding an unreadable create-only path', async () => {
    mockUnreadableCreateOnly.mockReturnValue(new Set(['W']));
    expect(await revertWriteOnlyResendNames('cc-api', TYPE, { W: 1, X: 2 })).toEqual(['X']);
    expect(mockUnreadableCreateOnly).toHaveBeenCalledWith(TYPE, { W: 1, X: 2 });
  });
});

describe('withDeclaredWriteOnlyProperties', () => {
  it('adds each named value the send bag lacks, without mutating it', () => {
    const send = { A: 1 };
    expect(withDeclaredWriteOnlyProperties(send, { A: 1, W: false }, ['W'])).toEqual({
      A: 1,
      W: false,
    });
    expect(send).toEqual({ A: 1 });
  });

  it('keeps a value the send bag already holds', () => {
    expect(withDeclaredWriteOnlyProperties({ W: 'live' }, { W: 'declared' }, ['W'])).toEqual({
      W: 'live',
    });
  });

  it('returns the send bag by identity when nothing is named', () => {
    const send = {};
    expect(withDeclaredWriteOnlyProperties(send, { W: 1 }, [])).toBe(send);
  });
});

describe('stripDerivedEchoMembers', () => {
  it('drops the echo beside its source, without mutating the bag', () => {
    const bag = { RotationRules: { ScheduleExpression: 'rate(7 days)', AutomaticallyAfterDays: 7 } };
    expect(stripDerivedEchoMembers(TYPE, bag)).toEqual({
      RotationRules: { ScheduleExpression: 'rate(7 days)' },
    });
    expect(bag.RotationRules.AutomaticallyAfterDays).toBe(7);
  });

  it.each([
    ['the echo without its source', { RotationRules: { AutomaticallyAfterDays: 7 } }],
    ['the source without an echo', { RotationRules: { ScheduleExpression: 'cron(0 1 * * ? *)' } }],
    ['no rules', {}],
  ])('returns the bag by identity for %s', (_l, bag) => {
    expect(stripDerivedEchoMembers(TYPE, bag)).toBe(bag);
  });

  it('leaves another type alone', () => {
    const bag = { RotationRules: { ScheduleExpression: 'rate(7 days)', AutomaticallyAfterDays: 7 } };
    expect(stripDerivedEchoMembers('AWS::Other::Thing', bag)).toBe(bag);
  });
});
