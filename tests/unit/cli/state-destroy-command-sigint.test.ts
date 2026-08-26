import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { StackStateRef } from '../../../src/state/s3-state-backend.js';

/**
 * Issue #2117, `cdkd state destroy --all` half.
 *
 * The twin of `destroy-command-sigint.test.ts`, and it mirrors that file's
 * FAILURE predicate rather than only its happy path: a signal the runner never
 * reported (`interrupted: false`) must still stop the loop, and the negative
 * control proves a clean run still walks every stack.
 *
 * `state destroy` is a separate command with its own copy of the loop, so a
 * fix applied to `destroy.ts` alone leaves this one broken — which is why it
 * gets its own suite rather than a parameter on the other.
 */

const loggerMocks = vi.hoisted(() => ({
  setLevel: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    ...loggerMocks,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

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
  getAwsClients: vi.fn(),
}));

const mockListStacks = vi.fn<() => Promise<StackStateRef[]>>();
const mockGetState =
  vi.fn<(stackName: string) => Promise<{ state: StackState; etag: string } | null>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    listStacks: mockListStacks,
    getState: mockGetState,
    verifyBucketExists: vi.fn(async () => undefined),
  })),
}));

vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn(),
  })),
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    setCustomResourceResponseBucket: vi.fn(),
    getProvider: vi.fn(),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

const mockRunDestroyForStack = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/commands/destroy-runner.js', () => ({
  runDestroyForStack: mockRunDestroyForStack,
}));

const readlineQuestion = vi.hoisted(() => vi.fn<(prompt: string) => Promise<string>>());
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: readlineQuestion, close: vi.fn() })),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';

const STACKS = ['StackA', 'StackB'];
const REGION = 'us-east-1';

function makeStackState(stackName: string): StackState {
  return {
    version: 8,
    stackName,
    region: REGION,
    resources: {
      Bucket: {
        physicalId: `${stackName.toLowerCase()}-bucket`,
        resourceType: 'AWS::S3::Bucket',
        properties: {},
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

function cleanRunResult(): Record<string, unknown> {
  return {
    stackName: '',
    cancelled: false,
    skippedEmpty: false,
    deletedCount: 1,
    retainedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    // The runner never saw the signal — the whole premise of issue #2117.
    interrupted: false,
  };
}

function silenceStd(): () => void {
  const outw = process.stdout.write.bind(process.stdout);
  const errw = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  return () => {
    process.stdout.write = outw;
    process.stderr.write = errw;
  };
}

async function runStateDestroy(args: string[]): Promise<void> {
  const restore = silenceStd();
  try {
    const stateCmd = createStateCommand();
    stateCmd.exitOverride();
    stateCmd.commands.forEach((sub) => sub.exitOverride());
    await stateCmd.parseAsync(args, { from: 'user' });
  } finally {
    restore();
  }
}

/**
 * Emit a signal from inside the runner the way the REAL runner's tail does.
 *
 * The listener registration is load-bearing, not scenery. `runDestroyForStack`
 * has its own SIGINT handler armed by the time it reaches this point, and the
 * command watch defers to it precisely because it is there; a mock that
 * registers nothing puts the watch in its pre-registration window instead,
 * where it force-quits (correctly) and the case measures the wrong branch.
 */
function runnerTailEmitsSignal(): void {
  mockRunDestroyForStack.mockImplementationOnce(async () => {
    const runnerHandler = (): void => {};
    process.on('SIGINT', runnerHandler);
    try {
      // The signal arrives after the runner read its own `draining` flag, so it
      // reports `false` — and before this fix nothing else carried it onward.
      process.emit('SIGINT', 'SIGINT');
    } finally {
      process.removeListener('SIGINT', runnerHandler);
    }
    return cleanRunResult();
  });
}

describe('cdkd state destroy --all: a Ctrl-C the runner never reported stops the run (issue #2117)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockListStacks.mockResolvedValue(STACKS.map((s) => ({ stackName: s, region: REGION })));
    mockGetState.mockImplementation(async (stackName: string) => ({
      state: makeStackState(stackName),
      etag: 'etag',
    }));
    mockRunDestroyForStack.mockResolvedValue(cleanRunResult());
    readlineQuestion.mockResolvedValue('y');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('does not dispatch the next stack when the signal lands in the runner tail', async () => {
    runnerTailEmitsSignal();

    await expect(runStateDestroy(['destroy', '--all', '--yes'])).rejects.toThrow();

    const dispatched = mockRunDestroyForStack.mock.calls.map((c) => c[0] as string);
    expect(dispatched).toEqual(['StackA']);
    expect(dispatched).not.toContain('StackB');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('walks every stack when NO signal arrives', async () => {
    await runStateDestroy(['destroy', '--all', '--yes']);

    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0] as string)).toEqual([
      'StackA',
      'StackB',
    ]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('still honours a runner-reported interrupt', async () => {
    mockRunDestroyForStack.mockResolvedValueOnce({ ...cleanRunResult(), interrupted: true });

    await expect(runStateDestroy(['destroy', '--all', '--yes'])).rejects.toThrow();

    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0] as string)).toEqual(['StackA']);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('stops before the FIRST stack when the signal precedes dispatch', async () => {
    // Pins `state.ts`'s pre-dispatch guard. Blanking that line leaves every
    // other case in this file green, because they all deliver the signal from
    // INSIDE the runner.
    mockGetState.mockImplementationOnce(async (stackName: string) => {
      process.emit('SIGINT', 'SIGINT');
      return { state: makeStackState(stackName), etag: 'etag' };
    });

    await expect(runStateDestroy(['destroy', '--all', '--yes'])).rejects.toThrow();

    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  /**
   * The only shape that puts more than one ref in the per-region inner loop.
   *
   * Two REGIONAL refs is not it: with no `--stack-region` that is an explicit
   * ambiguity error, and with one the filter keeps a single match. `targets`
   * exceeds one only when a LEGACY ref (no region, pre-schema-v2 layout)
   * survives alongside a regional one, because the filter admits
   * `r.region === options.stackRegion || !r.region`.
   */
  function twoTargetRefs(): void {
    mockListStacks.mockResolvedValue([
      { stackName: 'StackA', region: REGION },
      { stackName: 'StackA' } as StackStateRef,
    ]);
  }

  it('stops the per-REGION inner loop, not just the outer stack loop', async () => {
    // That inner guard is masked by the outer one whenever a stack has exactly
    // one target — which is what every other case here uses, so blanking the
    // line left the whole file green.
    twoTargetRefs();
    runnerTailEmitsSignal();

    await expect(
      runStateDestroy(['destroy', '--all', '--yes', '--stack-region', REGION])
    ).rejects.toThrow();

    // The SECOND target of the SAME stack must not be dispatched.
    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('walks BOTH targets of a stack when no signal arrives', async () => {
    // The negative control — without it, an inner loop that always broke after
    // the first target would pass the case above.
    twoTargetRefs();

    await runStateDestroy(['destroy', '--all', '--yes', '--stack-region', REGION]);

    expect(mockRunDestroyForStack).toHaveBeenCalledTimes(2);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('reads no further state after the interrupt, and announces no stack it will not touch', async () => {
    // Pins the two POST-dispatch guards, which the pre-dispatch one at the top
    // of the region loop otherwise masks: with them blanked nothing is
    // dispatched either (that guard catches it), so dispatch count cannot tell
    // the difference. What DOES differ is the work done on the way — every
    // remaining stack costs a `getState` round trip and prints a
    // "Preparing to destroy stack ..." line for a stack the run will not touch,
    // which reads as a teardown that is still going.
    runnerTailEmitsSignal();

    await expect(runStateDestroy(['destroy', '--all', '--yes'])).rejects.toThrow();

    const read = mockGetState.mock.calls.map((c) => c[0] as string);
    expect(read).toEqual(['StackA']);
    const announced = loggerMocks.info.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('Preparing to destroy stack'));
    expect(announced).toHaveLength(1);
    expect(announced[0]).toContain('StackA');
  });

  it('reads no further TARGET of the same stack after the interrupt', async () => {
    // The inner-loop twin of the case above.
    twoTargetRefs();
    runnerTailEmitsSignal();

    await expect(
      runStateDestroy(['destroy', '--all', '--yes', '--stack-region', REGION])
    ).rejects.toThrow();

    expect(mockGetState).toHaveBeenCalledTimes(1);
  });

  it('leaves no SIGINT listener behind after the command finishes', async () => {
    const before = process.listenerCount('SIGINT');
    await runStateDestroy(['destroy', '--all', '--yes']);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
