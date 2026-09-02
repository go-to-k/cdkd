import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { setStdinIsTty } from '../../stdin-tty.js';
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

/**
 * `state.ts` guards its single `forwardSigtermToSigint()` call with a catch that
 * disposes the watch before re-throwing, and that catch had no coverage:
 * deleting the `interruptWatch.dispose()` reddened nothing while leaking a
 * permanent SIGINT listener into every later command in the process.
 *
 * The override delegates to the REAL forwarder unless a case installs one, so
 * nothing else in this file is quietly turned into a test of a stub.
 */
const forwardOverride = vi.hoisted(() => ({ fn: undefined as (() => () => void) | undefined }));
vi.mock('../../../src/utils/interrupt-signals.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/interrupt-signals.js')>();
  return {
    ...actual,
    forwardSigtermToSigint: (): (() => void) =>
      forwardOverride.fn ? forwardOverride.fn() : actual.forwardSigtermToSigint(),
  };
});

const readlineQuestion = vi.hoisted(() =>
  vi.fn<(prompt: string, opts?: { signal?: AbortSignal }) => Promise<string>>()
);
const readlineClose = vi.hoisted(() => vi.fn());
/**
 * `close` / `exit:<code>` in the order they happened.
 *
 * "was `rl.close()` called at all" cannot fence the abort path: `process.exit`
 * is mocked to THROW, so the throw unwinds through the `finally` and closes the
 * interface even when the explicit close before the exit is deleted. In
 * production `process.exit` never returns, so the `finally` never runs there —
 * only the ORDER tells the two apart.
 */
const callOrder = vi.hoisted(() => [] as string[]);
/**
 * `question` / `close` is the whole surface `state.ts` uses.
 *
 * An earlier cut also kept a `once('close', ...)` listener registry, because
 * the source raced the question against readline's `close` event to turn EOF
 * into a decline. Round 3 withdrew that race for a non-TTY refusal taken
 * BEFORE the interface is created, so nothing registers a close listener any
 * more and the registry went with it.
 */
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: readlineQuestion,
    close: () => {
      readlineClose();
      callOrder.push('close');
    },
  })),
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

/** Everything the command wrote to stderr during the last `runStateDestroy`. */
const stderrChunks: string[] = [];

function silenceStd(): () => void {
  const outw = process.stdout.write.bind(process.stdout);
  const errw = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
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

/**
 * `process.stdin.isTTY` is a plain own property, so it is set and restored
 * directly rather than through `vi.spyOn` (which needs an accessor).
 */
const originalIsTty = process.stdin.isTTY;

/** Everything `handleError` routed to `logger.error`, as plain strings. */
function errorLines(): string[] {
  return loggerMocks.error.mock.calls.map((c) => String(c[0]));
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
    stderrChunks.length = 0;
    callOrder.length = 0;
    forwardOverride.fn = undefined;
    // Every prompting case is an INTERACTIVE run. `state.ts` refuses before
    // creating the interface when stdin is not a TTY (the non-interactive
    // convention shared with `gc.ts` / `bootstrap-destroy.ts` / three more),
    // and under vitest `process.stdin.isTTY` is undefined — so without this
    // stub every prompt case would exercise the refusal instead of the prompt.
    setStdinIsTty(true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      callOrder.push(`exit:${code}`);
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
    setStdinIsTty(originalIsTty);
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

  it("brackets the per-stack destroy, so a second Ctrl-C is the RUNNER's to escalate", async () => {
    // The twin of `destroy-command-sigint.test.ts`'s bracket case, which this
    // file was missing: replacing `interruptWatch.runStack(...)` here with a
    // plain `Promise.resolve().then(...)` reddened NOTHING. With the bracket
    // dead, `stacksInFlight` stays 0 during a stack, so a second Ctrl-C takes
    // the command handler's `process.exit(130)` instead of deferring — no lock
    // release and no `cdkd force-unlock` line, which is the stranded-lock
    // regression issues #1348 / #2053 exist to prevent.
    //
    // The mocked runner must REGISTER a listener the way the real one does:
    // the deferral is conditional on a graceful owner actually being armed, so
    // a mock that registers nothing exercises the force-quit path and pins the
    // opposite of the intent.
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

    await expect(runStateDestroy(['destroy', '--all', '--yes'])).rejects.toThrow();

    // The runner's handler saw BOTH signals — with the bracket inert the watch
    // exits on the second, so the runner never sees it.
    expect(runnerHandler).toHaveBeenCalledTimes(2);
    expect(exitSpy).not.toHaveBeenCalledWith(130);
    // ...and the run still stopped before StackB, with the interrupted-destroy
    // exit code rather than a force-quit.
    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0] as string)).toEqual(['StackA']);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('exits 0 when the signal lands in the TAIL of a run that destroyed everything', async () => {
    // The twin of `destroy.ts`'s tail case. The terminal throw used to read
    // `runInterrupted()`, so a signal after the LAST stack finished cleanly
    // reported "State preserved — re-run 'cdkd state destroy' to finish" and
    // exited 2 over a destroy with nothing left to finish.
    mockRunDestroyForStack.mockImplementation(async (name: string) => {
      if (name === 'StackB') {
        const runnerHandler = (): void => {};
        process.on('SIGINT', runnerHandler);
        try {
          process.emit('SIGINT', 'SIGINT');
        } finally {
          process.removeListener('SIGINT', runnerHandler);
        }
      }
      return cleanRunResult();
    });

    // Must NOT throw.
    await runStateDestroy(['destroy', '--all', '--yes']);

    // The positive marker that the run really completed: every stack dispatched.
    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0] as string)).toEqual([
      'StackA',
      'StackB',
    ]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it(
    'cancels the --all batch prompt on a signal instead of hanging forever',
    async () => {
      // `await rl.question(...)` blocks on the USER, and this command now owns a
      // SIGINT listener — which disables Node's default terminate. Without the
      // abort signal the recorded interrupt reaches nobody and the prompt waits
      // for an answer that is never coming: a single SIGTERM from CI or `kill`
      // parked the process where it previously exited 130. At a TTY readline
      // intercepts ^C itself, so the piped / non-TTY shape is the one that hangs
      // — exactly the population issue #1342 exists for.
      //
      // With the fix reverted this case does not merely fail: it TIMES OUT,
      // which is the production symptom reproduced faithfully.
      readlineQuestion.mockImplementation(
        async (_prompt: string, opts?: { signal?: AbortSignal }) =>
          await new Promise<string>((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () => {
              const abortError = new Error('The operation was aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            });
            // The Ctrl-C arrives while the prompt is blocked.
            process.emit('SIGINT', 'SIGINT');
          })
      );

      // No `--yes`: the batch prompt only runs when the user has not pre-agreed.
      await expect(runStateDestroy(['destroy', '--all'])).rejects.toThrow();

      // 130 is what Node's default terminate produced here before this command
      // owned a handler, and nothing was read, locked or deleted on the way.
      expect(exitSpy).toHaveBeenCalledWith(130);
      expect(mockRunDestroyForStack).not.toHaveBeenCalled();
      expect(mockGetState).not.toHaveBeenCalled();
    },
    5000
  );

  it('still destroys when the batch prompt is answered normally', async () => {
    // The negative control: a prompt wired to the abort signal must still
    // resolve on an ordinary answer.
    readlineQuestion.mockResolvedValue('y');

    await runStateDestroy(['destroy', '--all']);

    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0] as string)).toEqual([
      'StackA',
      'StackB',
    ]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 2 when the signal precedes the ONLY stack, which no later guard covers', async () => {
    // The pre-dispatch guard sets `stoppedEarly` UNCONDITIONALLY, and nothing
    // pinned it: blanking that line left 2907 of 2910 `tests/unit/cli` cases
    // green. Two things mask it together — the `break` there only exits the
    // INNER `targets` loop, so control falls into the outer guard, which
    // re-sets the flag whenever another stack index remains; and every existing
    // case in this file runs TWO stacks, so that outer guard always covered.
    //
    // With a single stack neither cover, and the regression is
    // `cdkd state destroy` exiting 0 having destroyed NOTHING after a Ctrl-C
    // during the last stack's `getState` S3 round-trip.
    mockListStacks.mockResolvedValue([{ stackName: 'StackA', region: REGION }]);
    mockGetState.mockImplementationOnce(async (stackName: string) => {
      process.emit('SIGINT', 'SIGINT');
      return { state: makeStackState(stackName), etag: 'etag' };
    });

    await expect(runStateDestroy(['destroy', '--all', '--yes'])).rejects.toThrow();

    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('exits 0 when every REMAINING stack would have been region-skipped anyway', async () => {
    // `stackIndex < stackNames.length - 1` answers "does an INDEX remain",
    // which over-claims. Under `--stack-region us-east-1`, StackB's only
    // record is in eu-west-1, so the loop's own filter warn-and-skips it: it
    // was never going to be destroyed. A signal after StackA therefore leaves
    // nothing undone, and reporting exit 2 tells CI to re-run a completed
    // destroy. Measured on the index form: exit=[[2]], dispatched=["StackA"].
    mockListStacks.mockResolvedValue([
      { stackName: 'StackA', region: REGION },
      { stackName: 'StackB', region: 'eu-west-1' },
    ]);
    runnerTailEmitsSignal();

    // Must NOT throw.
    await runStateDestroy(['destroy', '--all', '--yes', '--stack-region', REGION]);

    // The positive marker that this is the every-target-done shape: StackA was
    // dispatched, and StackB never was because it had no matching record.
    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0] as string)).toEqual(['StackA']);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('still exits 2 when a remaining stack DOES match --stack-region', async () => {
    // The discriminator for the case above: identical shape except StackB has
    // a matching record, so it really is left undestroyed. Without this, a
    // predicate that always returned false would satisfy that case.
    runnerTailEmitsSignal();

    await expect(
      runStateDestroy(['destroy', '--all', '--yes', '--stack-region', REGION])
    ).rejects.toThrow();

    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0] as string)).toEqual(['StackA']);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it(
    'REFUSES the batch prompt on a non-TTY stdin instead of hanging with no signal at all',
    async () => {
      // The OTHER way this await never returns, and it carries no signal for
      // the abort path to catch: `rl.question` does not settle when stdin is
      // already at EOF (measured still pending after 1500 ms under both
      // `< /dev/null` and `echo -n "" |`), so `cdkd state destroy --all`
      // without `--yes` hung in CI on nothing more than an absent stdin.
      //
      // Round 3 replaced a `Promise.race` against readline's `close` event
      // with the repo's existing non-interactive REFUSAL — see the source
      // comment for the three measured ways the race lost (a real answer with
      // no trailing newline discarded, a delayed answer losing the race, and
      // an interactive Ctrl-C landing on the EOF arm as exit 0). A refusal
      // cannot discard an answer and never reaches readline at all.
      setStdinIsTty(undefined);
      // A question that never settles: if the guard did NOT fire, this case
      // would hang exactly the way CI did, and the 5 s timeout is the fence.
      readlineQuestion.mockImplementation(async () => await new Promise<string>(() => {}));

      // `withErrorHandling` turns the CdkdError into `logger.error` + an exit,
      // and the exit mock throws — so the message is asserted where the user
      // actually reads it rather than off the rethrown mock error.
      await expect(runStateDestroy(['destroy', '--all'])).rejects.toThrow();

      expect(errorLines().filter((l) => /cannot run in a non-interactive environment/.test(l)))
        .toHaveLength(1);
      // The prompt was never even created, which is the whole point: there is
      // no window for a race to be lost in.
      expect(readlineQuestion).not.toHaveBeenCalled();
      expect(mockRunDestroyForStack).not.toHaveBeenCalled();
      // A REFUSAL, not a success-shaped exit 0 over a destroy that did nothing.
      expect(exitSpy).toHaveBeenCalledWith(1);
    },
    5000
  );

  it('names --yes in the refusal, since that is the non-interactive way through', async () => {
    // The refusal is the only thing a CI user sees, so it has to carry the
    // remedy. Asserting the message and not merely the exit is what stops it
    // from degrading into a bare "not a TTY".
    setStdinIsTty(undefined);

    await expect(runStateDestroy(['destroy', '--all'])).rejects.toThrow();

    expect(errorLines().filter((l) => l.includes('--yes'))).toHaveLength(1);
  });

  it('still prompts, and destroys, when stdin IS a TTY', async () => {
    // The negative control. Without it a guard that refused unconditionally —
    // or one whose predicate was inverted — would satisfy both cases above
    // while making the interactive batch prompt unusable.
    setStdinIsTty(true);
    readlineQuestion.mockResolvedValue('y');

    await runStateDestroy(['destroy', '--all']);

    expect(readlineQuestion).toHaveBeenCalledTimes(1);
    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0] as string)).toEqual(STACKS);
  });

  it('does not consult stdin at all under --yes', async () => {
    // `--yes` short-circuits above the guard, so a non-interactive run with it
    // must neither refuse nor prompt — that is the documented CI path.
    setStdinIsTty(undefined);

    await runStateDestroy(['destroy', '--all', '--yes']);

    expect(readlineQuestion).not.toHaveBeenCalled();
    expect(mockRunDestroyForStack.mock.calls.map((c) => c[0] as string)).toEqual(STACKS);
  });

  it('prints the cancellation notice and closes the interface before exiting 130', async () => {
    // Three properties that were each individually unfenced:
    //  - the user-facing `Destroy cancelled — nothing was destroyed.` line
    //    (deleting it reddened nothing);
    //  - `rl.close()` on the abort path. `process.exit` never unwinds, so the
    //    `finally` does NOT run here and the PR body's "rl.close() moves into
    //    a finally" was untrue for exactly the path the fix adds. The close is
    //    now explicit before the exit.
    readlineQuestion.mockImplementation(
      async (_prompt: string, opts?: { signal?: AbortSignal }) =>
        await new Promise<string>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
          process.emit('SIGINT', 'SIGINT');
        })
    );

    await expect(runStateDestroy(['destroy', '--all'])).rejects.toThrow();

    expect(exitSpy).toHaveBeenCalledWith(130);
    expect(stderrChunks.join('')).toContain('Destroy cancelled — nothing was destroyed.');
    // ORDER, not mere presence — see `callOrder`'s note for why presence is
    // satisfied by the mocked exit's own throw unwinding through the `finally`.
    expect(callOrder.slice(0, 2)).toEqual(['close', 'exit:130']);
  });

  it('propagates an ORDINARY prompt failure even when a signal WAS delivered', async () => {
    // `isPromptAbortError` forced to `true` reddened nothing, and the obvious
    // case does not fix that: with no signal delivered, the
    // `interruptWatch.interrupted() &&` conjunct short-circuits and the
    // predicate is never consulted. The signal has to be delivered so that the
    // predicate is the ONLY thing deciding — and then a genuine readline /
    // stdin failure must still propagate rather than be reported as
    // "Destroy cancelled" + exit 130, i.e. a crash disguised as the user's own
    // Ctrl-C over a command that has not verified anything about its state.
    readlineQuestion.mockImplementation(async () => {
      process.emit('SIGINT', 'SIGINT');
      throw new Error('readline blew up');
    });

    await expect(runStateDestroy(['destroy', '--all'])).rejects.toThrow();

    // Exit 1, the generic-failure code, NOT the cancel contract...
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(exitSpy).not.toHaveBeenCalledWith(130);
    expect(stderrChunks.join('')).not.toContain('Destroy cancelled — nothing was destroyed.');
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
    // ...and the interface is still closed, which is what the `finally` is for.
    expect(readlineClose).toHaveBeenCalled();
  });

  it('propagates an AbortError when no signal was delivered to this command', async () => {
    // Pins the `interruptWatch.interrupted() &&` conjunct, which is the exact
    // guarantee `isPromptAbortError`'s own JSDoc claims: "a same-named error
    // from an unrelated abort cannot be mistaken for the user's Ctrl-C".
    // Dropping the conjunct reddened nothing, because every other abort case
    // in this file delivers a real SIGINT first.
    readlineQuestion.mockImplementation(async () => {
      const abortError = new Error('aborted by something else entirely');
      abortError.name = 'AbortError';
      throw abortError;
    });

    await expect(runStateDestroy(['destroy', '--all'])).rejects.toThrow();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(exitSpy).not.toHaveBeenCalledWith(130);
    expect(stderrChunks.join('')).not.toContain('Destroy cancelled — nothing was destroyed.');
  });

  it('disposes the watch when the SIGTERM forwarder throws, so no listener leaks', async () => {
    const before = process.listenerCount('SIGINT');
    forwardOverride.fn = () => {
      throw new Error('SIGTERM forwarder blew up');
    };

    await expect(runStateDestroy(['destroy', '--all', '--yes'])).rejects.toThrow();

    // Exit 1, the generic-failure code: the throw propagated rather than being
    // swallowed or mapped to the interrupted contract...
    expect(exitSpy).toHaveBeenCalledWith(1);
    // ...and the listener set is back where it started, which is the guard.
    expect(process.listenerCount('SIGINT')).toBe(before);
    expect(mockRunDestroyForStack).not.toHaveBeenCalled();
  });
});
