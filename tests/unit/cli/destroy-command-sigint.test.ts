import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * Issue #2117 — `cdkd destroy --all` must stop on a Ctrl-C that lands in a
 * window `runDestroyForStack` does not span.
 *
 * Before this fix, `destroy.ts` registered no SIGINT handler of its own, so the
 * ONLY channel from the runner to the `--all` loop was
 * `DestroyRunResult.interrupted` — assigned ONCE, inside the runner's `try`,
 * after its level loop. The runner's outer `finally` re-syncs it
 * (`result.interrupted ||= draining`) and that line is marked TACTICAL in the
 * source: it narrows the window, it does not close it. Two gaps survive, and
 * these cases drive both:
 *
 *  - the runner removes its SIGINT listener BEFORE the re-sync and its
 *    `return`, so a signal there is seen by nobody;
 *  - the loop's own between-stacks work (`RUN_FINISHED`, `finalize`,
 *    `purgeEventsAfterDestroy`) runs with no runner handler armed at all.
 *
 * Both are simulated by delivering the signal AFTER the mocked runner has
 * resolved with `interrupted: false` — which is exactly what the real runner
 * returns for a signal it never saw.
 *
 * DISCRIMINATION: with the fix reverted, the loop reads only the runner's
 * `false` and dispatches stack B. Every case here asserts B is never
 * dispatched, which the pre-fix code cannot satisfy.
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

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveApp: vi.fn(() => 'fake-app-cmd'),
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

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

const mockListStacks = vi.fn<() => Promise<{ stackName: string; region?: string }[]>>();
const mockGetState =
  vi.fn<
    (stackName: string, region?: string) => Promise<{ state: StackState; etag: string } | null>
  >();
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

/**
 * `finalize` is the between-stacks hook these cases hang the signal on.
 *
 * It runs in the loop's own `finally`, AFTER the runner returned and after the
 * runner dropped its listener — i.e. squarely inside the unguarded window. A
 * per-stack override lets a case interrupt on stack A only.
 */
const finalizeHooks = vi.hoisted(() => new Map<string, () => void>());
const recordedRunEvents = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const startedRecorders = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: vi.fn(({ stackName }: { stackName: string }) => {
    startedRecorders.push(stackName);
    return {
      record: (event: Record<string, unknown>) => {
        recordedRunEvents.push(event);
      },
      finalize: vi.fn(async () => {
        finalizeHooks.get(stackName)?.();
      }),
    };
  }),
  recordRunFailed: vi.fn(),
  recordRunOutcome: vi.fn(),
}));

/**
 * Issue #2117 pins what `destroy.ts` PASSES to `purgeEventsAfterDestroy`, not
 * just what that helper does with it. `destroy-purge-events.test.ts` covers the
 * helper against a flag handed in; nothing covered the caller, so reverting the
 * call site to the stale per-stack `interrupted` local passed every suite while
 * purging an interrupted destroy's post-mortem events.
 */
const mockPruneRuns = vi.hoisted(() => vi.fn());
vi.mock('../../../src/state/deployment-events-store.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../src/state/deployment-events-store.js')
  >();
  return {
    ...actual,
    DeploymentEventsReader: vi.fn().mockImplementation(() => ({ pruneRuns: mockPruneRuns })),
  };
});

const mockSynthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({ synthesize: mockSynthesize })),
}));

import { createDestroyCommand } from '../../../src/cli/commands/destroy.js';

function makeStackState(stackName: string, region = 'us-east-1'): StackState {
  return {
    version: 8,
    stackName,
    region,
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

function makeStackInfo(stackName: string, region = 'us-east-1'): StackInfo {
  return {
    stackName,
    displayName: stackName,
    artifactId: stackName,
    template: { Resources: {} },
    dependencyNames: [],
    region,
  };
}

function cleanRunResult(): Record<string, unknown> {
  return {
    errorCount: 0,
    skippedCount: 0,
    deletedCount: 1,
    // The whole point: the runner reports NO interrupt, because the signal
    // arrived after it had already read (and re-synced) its own flag.
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

async function runDestroy(args: string[]): Promise<void> {
  const restore = silenceStd();
  try {
    const cmd = createDestroyCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  } finally {
    restore();
  }
}

const STACKS = ['StackA', 'StackB'];

describe('cdkd destroy --all: a Ctrl-C between stacks stops the run (issue #2117)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    finalizeHooks.clear();
    recordedRunEvents.length = 0;
    startedRecorders.length = 0;
    mockSynthesize.mockResolvedValue({ stacks: STACKS.map((s) => makeStackInfo(s)) });
    mockListStacks.mockResolvedValue(STACKS.map((s) => ({ stackName: s, region: 'us-east-1' })));
    mockGetState.mockImplementation(async (stackName: string) => ({
      state: makeStackState(stackName),
      etag: 'etag',
    }));
    mockRunDestroyForStack.mockResolvedValue(cleanRunResult());
    mockPruneRuns.mockResolvedValue({ deletedRunIds: [], indexDeleted: false });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('does not dispatch the next stack when the signal lands after the first stack returned', async () => {
    finalizeHooks.set('StackA', () => {
      process.emit('SIGINT', 'SIGINT');
    });

    await expect(runDestroy(['destroy', '--all', '--yes'])).rejects.toThrow();

    const dispatched = mockRunDestroyForStack.mock.calls.map((c) => c[0] as string);
    expect(dispatched).toEqual(['StackA']);
    // Exit 2, the "state preserved, stack not destroyed" contract — NOT 0.
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('still reports a clean multi-stack run when NO signal arrives', async () => {
    await runDestroy(['destroy', '--all', '--yes']);

    // The negative control for the case above: without it, a fix that simply
    // always broke after the first stack would pass that one.
    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0] as string)).toEqual([
      'StackA',
      'StackB',
    ]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('still honours the runner-reported interrupt, which was the only channel before', async () => {
    mockRunDestroyForStack.mockResolvedValueOnce({ ...cleanRunResult(), interrupted: true });

    await expect(runDestroy(['destroy', '--all', '--yes'])).rejects.toThrow();

    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0] as string)).toEqual(['StackA']);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('stops before the FIRST stack when the signal precedes it', async () => {
    // The window the runner cannot cover at all: everything from command start
    // to the first `runDestroyForStack` call.
    mockGetState.mockImplementationOnce(async (stackName: string) => {
      process.emit('SIGINT', 'SIGINT');
      return { state: makeStackState(stackName), etag: 'etag' };
    });

    await expect(runDestroy(['destroy', '--all', '--yes'])).rejects.toThrow();

    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(2);

    // The guard's POSITION, not merely its presence. It sits ABOVE
    // `startRunRecorder`, so a stack skipped this way emits no RUN_STARTED for
    // the `finally` to finalize SUCCEEDED — `cdkd events` would otherwise show
    // a clean destroy run for a stack nothing touched.
    //
    // This is the ONLY case that reaches the guard at all: when the signal
    // lands after a stack has finished, the end-of-body break fires first and
    // the next iteration never starts. A round-2 reviewer moved the guard back
    // below the recorder and every suite stayed green; asserting it on the
    // between-stacks case (the first shape tried) does not fix that, because
    // that case never executes the line.
    expect(startedRecorders).toEqual([]);
  });

  it('brackets the per-stack destroy, so a second Ctrl-C is the RUNNER\'s to escalate', async () => {
    // Pins the `interruptWatch.runStack(...)` bracket at the COMMAND level.
    // Without it `stacksInFlight` stays 0, so a second signal during a stack
    // takes the command handler's `process.exit(130)` instead of deferring —
    // no lock release, no `cdkd force-unlock` line. That is the stranded-lock
    // regression issues #1348 / #2053 exist to prevent, and every suite passed
    // with the bracket made inert until this case existed.
    //
    // The mocked runner must REGISTER a listener the way the real one does:
    // deferral is conditional on a graceful owner actually being armed, so a
    // mock that registers nothing would exercise the force-quit path and pin
    // the opposite of the intent.
    const runnerHandler = vi.fn();
    mockRunDestroyForStack.mockImplementationOnce(async () => {
      process.on('SIGINT', runnerHandler);
      try {
        process.emit('SIGINT', 'SIGINT');
        process.emit('SIGINT', 'SIGINT');
      } finally {
        process.removeListener('SIGINT', runnerHandler);
      }
      return cleanRunResult();
    });

    await expect(runDestroy(['destroy', '--all', '--yes'])).rejects.toThrow();

    // The runner's handler saw both signals and the command NEVER force-quit.
    expect(runnerHandler).toHaveBeenCalledTimes(2);
    expect(exitSpy).not.toHaveBeenCalledWith(130);
    // ...and the run still stopped before StackB.
    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0] as string)).toEqual(['StackA']);
  });

  it('does NOT purge the event history for a signal that landed in the gap', async () => {
    // The events are the post-mortem for the retry, so an interrupted destroy
    // must keep them. Pins the CALLER: reverting `interrupted: runInterrupted()`
    // to the stale per-stack local passes every other case in this file.
    finalizeHooks.set('StackA', () => {
      process.emit('SIGINT', 'SIGINT');
    });

    await expect(runDestroy(['destroy', '--all', '--yes', '--purge-events'])).rejects.toThrow();

    expect(mockPruneRuns).not.toHaveBeenCalled();
  });

  it('DOES purge when the run is clean, so the case above is not vacuous', async () => {
    // The negative control. Without it, a fix that never purges at all would
    // satisfy the assertion above.
    await runDestroy(['destroy', '--all', '--yes', '--purge-events']);

    expect(mockPruneRuns).toHaveBeenCalledTimes(2);
  });

  it('stops on a SIGTERM, the CI-cancellation path (issue #1342)', async () => {
    // `forwardSigtermToSigint` re-emits SIGTERM as SIGINT, and the watch is
    // registered BEFORE the forwarder precisely so a forwarded signal can never
    // arrive while the command owns no handler. Nothing exercised SIGTERM.
    finalizeHooks.set('StackA', () => {
      process.emit('SIGTERM', 'SIGTERM');
    });

    await expect(runDestroy(['destroy', '--all', '--yes'])).rejects.toThrow();

    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0] as string)).toEqual(['StackA']);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('leaves no SIGINT listener behind after the command finishes', async () => {
    const before = process.listenerCount('SIGINT');
    await runDestroy(['destroy', '--all', '--yes']);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
