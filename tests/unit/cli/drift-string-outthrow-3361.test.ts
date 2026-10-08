import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState, ResourceState } from '../../../src/types/state.js';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/cli/commands/drift.ts` slice: a handler that logs a failure and carries
 * on built its message with `x instanceof Error ? x.message : String(x)`, and
 * `String(Object.create(null))` throws `TypeError: Cannot convert object to
 * primitive value`. The handler itself then threw, turning a per-resource or
 * best-effort degradation into a failure of the whole command or of a revert
 * that had already landed.
 *
 * Every case rejects with exactly that value and asserts the DEGRADATION still
 * happens (the run reaches its summary, the next resource is still read, the
 * resource lands in the outcome its arm reports), never merely "it did not
 * throw". The placeholder is asserted too, so a fix that swallowed the failure
 * without reporting it would not pass.
 */

const logs = vi.hoisted(() => ({
  debug: [] as string[],
  info: [] as string[],
  warn: [] as string[],
  error: [] as string[],
}));

vi.mock('../../../src/utils/logger.js', () => {
  const make = (): Record<string, unknown> => ({
    setLevel: vi.fn(),
    debug: (m: unknown) => logs.debug.push(String(m)),
    info: (m: unknown) => logs.info.push(String(m)),
    warn: (m: unknown) => logs.warn.push(String(m)),
    error: (m: unknown) => logs.error.push(String(m)),
    child: () => make(),
  });
  return { reserveStdoutForPayload: vi.fn(), getLogger: () => make() };
});

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

/** Flipped by `acquireLock`, so a double can answer detection and fail the write path. */
const phase = vi.hoisted(() => ({ locked: false }));

const mockIamSend = vi.hoisted(() => vi.fn());
const mockSecretsManagerSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    get iam() {
      return { send: mockIamSend };
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

const mockGetState = vi.hoisted(() => vi.fn());
const mockListStacks = vi.hoisted(() => vi.fn());
const mockSaveState = vi.hoisted(() => vi.fn());
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: mockSaveState,
  })),
}));

const mockReleaseLock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn(async () => {
      phase.locked = true;
      return true;
    }),
    getLockInfo: vi.fn(async () => null),
    releaseLock: mockReleaseLock,
  })),
}));

const mockReadCurrentState = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
vi.mock('../../../src/provisioning/provider-registry.js', () => {
  const provider = { readCurrentState: mockReadCurrentState, update: mockUpdate };
  return {
    ProviderRegistry: vi.fn().mockImplementation(() => ({
      getProvider: () => provider,
      getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
      shouldSkipResource: () => false,
      setCustomResourceResponseBucket: vi.fn(),
    })),
  };
});

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: vi.fn().mockImplementation(() => ({
    readCurrentState: vi.fn(async () => undefined),
  })),
}));

import { createDriftCommand, driftProducerRegionEvidence } from '../../../src/cli/commands/drift.js';

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A rejection whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

/** A getter that throws an unconvertible value once the run holds the stack lock. */
function throwingWhenLocked<T>(value: T): PropertyDescriptor {
  return {
    enumerable: true,
    get(): T {
      if (phase.locked) throw unconvertible();
      return value;
    },
  };
}

const TYPE = 'AWS::SQS::Queue';
const SECRET_EXPR = '{{resolve:secretsmanager:cdkd-3361-secret:SecretString:password::}}';

function resource(properties: Record<string, unknown>, physicalId = 'q'): ResourceState {
  return { physicalId, resourceType: TYPE, properties };
}

function stackState(resources: Record<string, ResourceState>): { state: StackState; etag: string } {
  return {
    state: {
      version: 3,
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
  drifted: Array<{ logicalId: string }>;
  clean: Array<{ logicalId: string }>;
  notSupported: Array<{ logicalId: string }>;
  notCompared?: Array<{ logicalId: string }>;
}

async function run(extra: string[]): Promise<{ stdout: string; error: unknown }> {
  const out: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  let error: unknown;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['TestStack', '--state-bucket', 'b', '--region', 'us-east-1', ...extra], {
      from: 'user',
    });
  } catch (err) {
    error = err;
  } finally {
    process.stdout.write = original;
  }
  return { stdout: out.join(''), error };
}

async function detect(): Promise<{ report: DriftJson; error: unknown }> {
  const { stdout, error } = await run(['--json']);
  const [report] = JSON.parse(stdout) as DriftJson[];
  return { report: report!, error };
}

const ids = (rows: Array<{ logicalId: string }> | undefined): string[] =>
  (rows ?? []).map((r) => r.logicalId);

const notTypeError = (error: unknown): void => {
  expect(error).not.toBeInstanceOf(TypeError);
};

const linesWith = (lines: string[], needle: string): string[] =>
  lines.filter((l) => l.includes(needle));

const revertSummary = (): string[] => linesWith(logs.info, 'Revert summary:');

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  phase.locked = false;
  logs.debug.length = 0;
  logs.info.length = 0;
  logs.warn.length = 0;
  logs.error.length = 0;
  mockIamSend.mockReset();
  mockSecretsManagerSend.mockReset();
  mockGetState.mockReset();
  mockListStacks.mockReset().mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
  mockSaveState.mockReset().mockResolvedValue('"etag-2"');
  mockReleaseLock.mockReset().mockResolvedValue(undefined);
  mockReadCurrentState.mockReset();
  mockUpdate.mockReset().mockResolvedValue(undefined);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('__exit__');
  }) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
});

describe('cdkd drift detection (#3361)', () => {
  it('a read rejecting with an unconvertible value is not compared, and the next resource is still read', async () => {
    mockGetState.mockResolvedValue(
      stackState({ Bad: resource({ A: 'x' }, 'q-bad'), Good: resource({ A: 'x' }, 'q-good') })
    );
    mockReadCurrentState.mockImplementation(async (physicalId: string) =>
      physicalId === 'q-bad' ? Promise.reject(unconvertible()) : { A: 'x' }
    );

    const { report, error } = await detect();

    notTypeError(error);
    expect(ids(report.notCompared)).toEqual(['Bad']);
    expect(ids(report.clean)).toEqual(['Good']);
    const warn = linesWith(logs.warn, 'could not be compared');
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain(PLACEHOLDER);
  });

  it('a no-READ-handler rejection that cannot be converted is reported unsupported, not fatal', async () => {
    mockGetState.mockResolvedValue(
      stackState({ Bad: resource({ A: 'x' }, 'q-bad'), Good: resource({ A: 'x' }, 'q-good') })
    );
    mockReadCurrentState.mockImplementation(async (physicalId: string) =>
      physicalId === 'q-bad'
        ? Promise.reject(Object.assign(Object.create(null), { name: 'UnsupportedActionException' }))
        : { A: 'x' }
    );

    const { report, error } = await detect();

    notTypeError(error);
    expect(ids(report.notSupported)).toEqual(['Bad']);
    expect(ids(report.clean)).toEqual(['Good']);
    const debug = linesWith(logs.debug, 'no-READ-handler signature');
    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain(PLACEHOLDER);
  });

  it('a dynamic-reference lookup rejecting with an unconvertible value still compares the resource', async () => {
    mockGetState.mockResolvedValue(stackState({ R: resource({ Secret: SECRET_EXPR, A: 'x' }) }));
    mockReadCurrentState.mockResolvedValue({ Secret: 'live-pw', A: 'y' });
    mockSecretsManagerSend.mockImplementation(() => Promise.reject(unconvertible()));

    const { report, error } = await detect();

    notTypeError(error);
    // The secret leaf is not compared; the plain one still is, so `A` drifts.
    expect(ids(report.drifted)).toEqual(['R']);
    const warn = linesWith(logs.warn, 'secret-bearing properties are NOT compared');
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain(PLACEHOLDER);
  });

  it('an IAM principal lookup rejecting with an unconvertible value leaves the comparison untouched', async () => {
    const arn = 'arn:aws:iam::123456789012:role/R';
    const policy = (principal: string): Record<string, unknown> => ({
      PolicyDocument: {
        Statement: [{ Effect: 'Allow', Principal: { AWS: principal }, Action: 'sqs:*' }],
      },
    });
    mockGetState.mockResolvedValue(stackState({ P: resource(policy(arn)) }));
    mockReadCurrentState.mockResolvedValue(policy('AROAABCDEFGHIJKLMNOP'));
    mockIamSend.mockImplementation(() => Promise.reject(unconvertible()));

    const { report, error } = await detect();

    notTypeError(error);
    // Unresolved principal = the spelling difference stays reported as drift,
    // rather than the comparison failing as a whole.
    expect(ids(report.drifted)).toEqual(['P']);
    expect(ids(report.notCompared)).toEqual([]);
    const debug = linesWith(logs.debug, 'Could not resolve the unique id of principal');
    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain(PLACEHOLDER);
  });
});

describe('driftProducerRegionEvidence (#3361)', () => {
  it('an ancestor read rejecting with an unconvertible value makes the evidence incomplete', async () => {
    const child = {
      ...stackState({}).state,
      stackName: 'Top~C',
      parentStack: 'Top',
      parentRegion: 'us-east-1',
    } as StackState;
    const backend = { getState: vi.fn(() => Promise.reject(unconvertible())) };

    await expect(
      driftProducerRegionEvidence(child, 'Top~C', 'us-east-1', backend as never)
    ).resolves.toEqual({ regions: [], complete: false });

    const debug = linesWith(logs.debug, 'Producer regions above a nested stack are incomplete');
    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain(PLACEHOLDER);
  });
});

describe('cdkd drift --accept (#3361)', () => {
  it('a lock release rejecting with an unconvertible value still finishes the accept, and warns', async () => {
    mockGetState.mockResolvedValue(stackState({ R: resource({ A: 'x' }) }));
    mockReadCurrentState.mockResolvedValue({ A: 'y' });
    mockReleaseLock.mockImplementation(() => Promise.reject(unconvertible()));

    const { error } = await run(['--accept', '--yes']);

    notTypeError(error);
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const warn = linesWith(logs.warn, 'Failed to release lock');
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain(PLACEHOLDER);
  });
});

describe('cdkd drift --revert (#3361)', () => {
  const drifted = (): void => {
    mockGetState.mockResolvedValue(stackState({ R: resource({ A: 'x' }) }));
    mockReadCurrentState.mockResolvedValue({ A: 'y' });
  };
  const revert = (): Promise<{ stdout: string; error: unknown }> => run(['--revert', '--yes']);

  it('an update rejecting with an unconvertible value is counted failed, and the revert reaches its summary', async () => {
    drifted();
    mockUpdate.mockImplementation(() => Promise.reject(unconvertible()));

    const { error } = await revert();

    notTypeError(error);
    expect(revertSummary()).toEqual(['\nRevert summary: 0 reverted, 1 failed.']);
    const line = linesWith(logs.error, 'AWS update failed');
    expect(line).toHaveLength(1);
    expect(line[0]).toContain(PLACEHOLDER);
  });

  it('a re-resolution rejecting with an unconvertible value is counted unresolvable, and the revert reaches its summary', async () => {
    mockGetState.mockResolvedValue(stackState({ R: resource({ Secret: SECRET_EXPR, A: 'x' }) }));
    mockReadCurrentState.mockResolvedValue({ Secret: 'live-pw', A: 'y' });
    mockSecretsManagerSend.mockImplementation(async () => {
      if (phase.locked) throw unconvertible();
      return { SecretString: JSON.stringify({ password: 'live-pw' }) };
    });

    const { error } = await revert();

    notTypeError(error);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(revertSummary()).toEqual(['\nRevert summary: 0 reverted, 1 reference-unresolvable.']);
    const line = linesWith(logs.error, 'could not re-resolve the dynamic reference');
    expect(line).toHaveLength(1);
    expect(line[0]).toContain(PLACEHOLDER);
  });

  it('a payload build rejecting with an unconvertible value is counted failed, and the revert reaches its summary', async () => {
    mockGetState.mockResolvedValue(stackState({ R: resource({ A: 'x' }) }));
    // The live snapshot answers detection, and throws once the revert holds
    // the lock and walks it to build the payload.
    mockReadCurrentState.mockImplementation(async () =>
      Object.defineProperty({ A: 'y' }, 'B', throwingWhenLocked('live'))
    );

    const { error } = await revert();

    notTypeError(error);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(revertSummary()).toEqual(['\nRevert summary: 0 reverted, 1 failed.']);
    const line = linesWith(logs.error, 'could not build the revert payload');
    expect(line).toHaveLength(1);
    expect(line[0]).toContain(PLACEHOLDER);
  });

  it('effective properties that cannot be read after a landed update keep the revert counted as succeeded', async () => {
    drifted();
    mockUpdate.mockResolvedValue(
      Object.defineProperty({}, 'effectiveProperties', throwingWhenLocked(undefined))
    );

    const { error } = await revert();

    notTypeError(error);
    // The update LANDED: before the fix the capture's own catch threw, and the
    // outer one re-reported the resource as `AWS update failed`.
    expect(revertSummary()).toEqual(['\nRevert summary: 1 reverted.']);
    expect(linesWith(logs.error, 'AWS update failed')).toEqual([]);
    const warn = linesWith(logs.warn, "the provider's reported effective properties could not be read");
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain(PLACEHOLDER);
  });

  it('a returned identity that cannot be recorded after a landed update keeps the revert counted as succeeded', async () => {
    drifted();
    mockUpdate.mockResolvedValue(
      Object.defineProperty({}, 'attributes', throwingWhenLocked({ Arn: 'arn' }))
    );

    const { error } = await revert();

    notTypeError(error);
    expect(revertSummary()).toEqual(['\nRevert summary: 1 reverted.']);
    expect(linesWith(logs.error, 'AWS update failed')).toEqual([]);
    const warn = linesWith(logs.warn, 'the attributes the provider returned could not be recorded');
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain(PLACEHOLDER);
  });

  it('a state write rejecting with an unconvertible value after a landed revert warns, and the revert reaches its summary', async () => {
    drifted();
    // A new identity, so the revert has something to record and saves state.
    mockUpdate.mockResolvedValue({ physicalId: 'q-new', wasReplaced: true });
    mockSaveState.mockImplementation(() => Promise.reject(unconvertible()));

    const { error } = await revert();

    notTypeError(error);
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    expect(revertSummary()).toEqual(['\nRevert summary: 1 reverted.']);
    const warn = linesWith(logs.warn, 'Reverted TestStack (us-east-1), but could not record');
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain(PLACEHOLDER);
  });

  it('a lock release rejecting with an unconvertible value still reaches the summary, and warns', async () => {
    drifted();
    mockReleaseLock.mockImplementation(() => Promise.reject(unconvertible()));

    const { error } = await revert();

    notTypeError(error);
    expect(revertSummary()).toEqual(['\nRevert summary: 1 reverted.']);
    const warn = linesWith(logs.warn, 'Failed to release lock');
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain(PLACEHOLDER);
  });
});
