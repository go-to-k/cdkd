import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import { createInterface } from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import {
  forwardSigtermToSigint,
  isPromptAbortError,
  watchCommandInterrupt,
} from '../../../src/utils/interrupt-signals.js';
import {
  beginCommandInterruptScope,
  disarmInterruptWatchForTests,
  endCommandInterruptScope,
  interruptWatchListenerCount,
  startInterruptWatch,
} from '../../../src/provisioning/interrupt-watch.js';

/**
 * Issue #2117 — the command-scoped SIGINT record the destroy commands lacked.
 *
 * These pin the helper in isolation. The wiring into the `--all` loops is
 * pinned at the command level in `tests/unit/cli/destroy-command-sigint.test.ts`
 * and `tests/unit/cli/state-destroy-command-sigint.test.ts`, because the defect
 * this issue names is a loop reading a stale value — which no test of this file
 * alone can see.
 */

/**
 * Capture stderr by REPLACING `process.stderr.write`.
 *
 * `vi.spyOn` is not equivalent here: the helper writes through the binding it
 * captured, and a passing vitest test hides console output anyway, so the
 * replacement is the only form whose result the assertions can read.
 */
function captureStderr(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  return {
    output,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

const disposers: Array<() => void> = [];
function arm(command = 'cdkd destroy'): ReturnType<typeof watchCommandInterrupt> {
  const w = watchCommandInterrupt({ command });
  disposers.push(w.dispose);
  return w;
}

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  vi.restoreAllMocks();
});

describe('watchCommandInterrupt (issue #2117)', () => {
  it('starts clean and records the first signal', () => {
    const cap = captureStderr();
    try {
      const watch = arm();
      expect(watch.interrupted()).toBe(false);

      process.emit('SIGINT', 'SIGINT');

      expect(watch.interrupted()).toBe(true);
      expect(cap.output.join('')).toContain('cdkd destroy will stop before starting another stack');
    } finally {
      cap.restore();
    }
  });

  it('names the invoking command in the notice, so the state twin is not mislabelled', () => {
    const cap = captureStderr();
    try {
      arm('cdkd state destroy');
      process.emit('SIGINT', 'SIGINT');
      expect(cap.output.join('')).toContain('cdkd state destroy will stop');
      expect(cap.output.join('')).not.toContain('cdkd destroy will stop');
    } finally {
      cap.restore();
    }
  });

  it('force-quits on a SECOND signal delivered between stacks', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const cap = captureStderr();
    try {
      arm();
      process.emit('SIGINT', 'SIGINT');
      expect(exitSpy).not.toHaveBeenCalled();

      process.emit('SIGINT', 'SIGINT');

      expect(exitSpy).toHaveBeenCalledWith(130);
      expect(cap.output.join('')).toContain('Force-quit.');
      // The HEDGED recovery line, which the shared `interrupt-watch.ts`
      // force-quit printed in this exact window before this watch took the
      // window over. Dropping it was a real loss rather than tidying: the
      // "no lock is held here" reasoning holds only while
      // `destroy-runner.ts`'s `releaseLock` succeeded, and that call is caught
      // and merely WARNED — so the one path where a lock really is stranded is
      // also the path where the user would be left with no recovery command at
      // all. It stays a placeholder because this handler has no per-stack
      // context to qualify it with (issue #2170).
      expect(cap.output.join('')).toContain('cdkd force-unlock <stack-name>');
    } finally {
      cap.restore();
    }
  });

  it('does NOT print the recovery line on the first signal', () => {
    // The negative control for the case above: a hedged lock hint on the
    // graceful notice would train users to run `force-unlock` after every
    // ordinary Ctrl-C, where the lock IS released on the way out.
    const cap = captureStderr();
    try {
      arm();
      process.emit('SIGINT', 'SIGINT');
      // A POSITIVE marker first, so the negative below is not satisfied by the
      // handler printing nothing at all (a silent first signal, an arm() that
      // no longer registers, a capture that missed the write) — every one of
      // which would leave a bare `not.toContain` green while saying nothing.
      expect(cap.output.join('')).toContain('will stop before starting another stack');
      expect(cap.output.join('')).not.toContain('cdkd force-unlock');
    } finally {
      cap.restore();
    }
  });

  it('aborts the prompt signal as soon as the first signal is recorded', () => {
    // Recording a flag serves everything that POLLS and nothing that BLOCKS.
    // `state.ts`'s batch confirm prompt is the blocked one: `rl.question`
    // waits on the USER, and registering any SIGINT listener disables Node's
    // default terminate, so without this abort a Ctrl-C at that prompt parked
    // `cdkd state destroy --all` forever where it used to exit 130.
    const cap = captureStderr();
    try {
      const watch = arm();
      expect(watch.signal.aborted).toBe(false);

      process.emit('SIGINT', 'SIGINT');

      expect(watch.signal.aborted).toBe(true);
      expect(watch.interrupted()).toBe(true);
    } finally {
      cap.restore();
    }
  });

  it('aborts the prompt signal from INSIDE a stack bracket too', async () => {
    // The deferral branch records the signal without printing or exiting, and
    // it must still release anything blocked: `runDestroyForStack`'s own
    // per-stack prompt sits inside this bracket.
    const cap = captureStderr();
    const removeRunner = installRunnerHandler();
    try {
      const watch = arm();
      await watch.runStack(async () => {
        process.emit('SIGINT', 'SIGINT');
      });
      expect(watch.signal.aborted).toBe(true);
      // Confirms it was the DEFERRAL branch, not one of the quitting ones.
      expect(cap.output.join('')).toBe('');
    } finally {
      removeRunner();
      cap.restore();
    }
  });

  /**
   * Stand in for `runDestroyForStack`'s own SIGINT handler.
   *
   * Load-bearing, and its ABSENCE is what let a blocker ship: the original
   * version of the in-flight case below installed nothing, so the branch it
   * meant to pin ("defer, because the runner is armed") passed for the wrong
   * reason — nobody was listening at all, which is the very state the deferral
   * must NOT be taken in.
   */
  function installRunnerHandler(): () => void {
    const runnerHandler = (): void => {};
    process.on('SIGINT', runnerHandler);
    return () => process.removeListener('SIGINT', runnerHandler);
  }

  it('leaves the force-quit to the runner while its handler is ARMED', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const cap = captureStderr();
    const removeRunner = installRunnerHandler();
    try {
      const watch = arm();
      await watch.runStack(async () => {
        // Two signals inside the bracket, with a runner handler really
        // registered. That one owns the escalation because it alone can
        // release the stack lock and print the `force-unlock` recovery line.
        process.emit('SIGINT', 'SIGINT');
        process.emit('SIGINT', 'SIGINT');
      });
      expect(exitSpy).not.toHaveBeenCalled();
      // Silent too: the runner prints its own drain notice, and a second one
      // from here would collide with the live renderer's display.
      expect(cap.output.join('')).toBe('');
      // ...but the signal is still RECORDED, which is the point of the watch.
      expect(watch.interrupted()).toBe(true);
    } finally {
      removeRunner();
      cap.restore();
    }
  });

  it('QUITS instead of deferring when the runner has not armed yet', async () => {
    // The blocker two independent reviewers found. `runDestroyForStack`
    // registers its handler ~200 lines in, after the strong-reference
    // pre-flight scan and the per-stack prompt. Deferring across that window
    // swallowed the signal entirely: no notice, no exit, no escalation — and
    // the runner then started with `draining` false and deleted the whole
    // stack the user had just asked to stop.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const cap = captureStderr();
    try {
      const watch = arm();
      await watch.runStack(async () => {
        // NO runner handler: this is the pre-registration window.
        process.emit('SIGINT', 'SIGINT');
      });
      expect(exitSpy).toHaveBeenCalledWith(130);
      expect(cap.output.join('')).toContain('armed its per-stack teardown');
      // The message must be honest about what quitting here does and does not
      // guarantee. It used to claim flatly "Nothing was deleted and no stack
      // lock is held", and on an `--all` run whose earlier stacks already
      // completed BOTH halves are false — including the lock, for exactly the
      // reason the second-signal branch above is already hedged:
      // `destroy-runner.ts` catches a failing `releaseLock` and only warns.
      expect(cap.output.join('')).toContain('No delete was issued for this stack');
      expect(cap.output.join('')).not.toContain('no stack lock is held');
      // Hedged the same way the branch above is, so the user losing the
      // process is still told how to recover.
      expect(cap.output.join('')).toContain('cdkd force-unlock <stack-name>');
    } finally {
      cap.restore();
    }
  });

  it('does NOT count the interrupt-watch latch as a graceful owner', async () => {
    // `interrupt-watch.ts`'s shared handler is a LATCH, not a shutdown path.
    // Treating its presence as "someone else will handle this" reintroduces the
    // swallow one window inward, which is why the count subtracts it.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const cap = captureStderr();
    beginCommandInterruptScope();
    const probe = startInterruptWatch('a provider wait');
    try {
      expect(interruptWatchListenerCount()).toBe(1);
      const watch = arm();
      await watch.runStack(async () => {
        process.emit('SIGINT', 'SIGINT');
      });
      // Still a force-quit: the latch does not make this window graceful.
      expect(exitSpy).toHaveBeenCalledWith(130);
      // ...and it is the PRE-REGISTRATION force-quit, not the between-stacks
      // one. Asserting only the exit code cannot tell the two apart, and the
      // capture was previously created and never read — so the case did not
      // actually pin which branch the latch failed to divert.
      expect(cap.output.join('')).toContain('armed its per-stack teardown');
    } finally {
      probe.dispose();
      endCommandInterruptScope();
      cap.restore();
    }
  });

  it('re-arms the force-quit once the stack bracket has exited', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const cap = captureStderr();
    const removeRunner = installRunnerHandler();
    try {
      const watch = arm();
      await watch.runStack(async () => {
        process.emit('SIGINT', 'SIGINT');
      });
      expect(exitSpy).not.toHaveBeenCalled();
      removeRunner();

      // Same second signal, now delivered in the between-stacks gap.
      process.emit('SIGINT', 'SIGINT');

      expect(exitSpy).toHaveBeenCalledWith(130);
      expect(watch.interrupted()).toBe(true);
    } finally {
      cap.restore();
    }
  });

  it('decrements the in-flight depth even when the stack THROWS', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const cap = captureStderr();
    // Removed in the OUTER `finally`, not in the body: a failing assertion
    // between the two skips the removal, and the leaked SIGINT listener then
    // outlives the case — `afterEach` only disposes the WATCH. Measured by
    // forcing the assertion above to fail with a listener-count probe appended
    // to the file: the body-only shape leaves 1 listener standing for every
    // later case, this shape leaves 0. Today's two remaining cases happen not
    // to be sensitive to it, which is precisely the problem — the next case
    // added below would take a different branch after an unrelated failure,
    // and the deferral branch is chosen on exactly that listener count.
    const removeRunner = installRunnerHandler();
    let runnerRemoved = false;
    const removeRunnerOnce = (): void => {
      if (runnerRemoved) return;
      runnerRemoved = true;
      removeRunner();
    };
    try {
      const watch = arm();
      await expect(
        watch.runStack(async () => {
          process.emit('SIGINT', 'SIGINT');
          throw new Error('destroy blew up');
        })
      ).rejects.toThrow('destroy blew up');
      // Deferred while the runner was armed, so nothing has quit yet.
      expect(exitSpy).not.toHaveBeenCalled();
      removeRunnerOnce();

      // A leaked depth would suppress the force-quit for the rest of the run.
      process.emit('SIGINT', 'SIGINT');
      expect(exitSpy).toHaveBeenCalledWith(130);
    } finally {
      removeRunnerOnce();
      cap.restore();
    }
  });

  it('propagates the stack result unchanged', async () => {
    const watch = arm();
    await expect(watch.runStack(async () => ({ errorCount: 3 }))).resolves.toEqual({
      errorCount: 3,
    });
  });

  it('stops recording after dispose, so the listener does not leak into the next command', () => {
    const before = process.listenerCount('SIGINT');
    const watch = watchCommandInterrupt({ command: 'cdkd destroy' });
    expect(process.listenerCount('SIGINT')).toBe(before + 1);

    watch.dispose();

    expect(process.listenerCount('SIGINT')).toBe(before);
    expect(watch.interrupted()).toBe(false);
  });
});

describe('forwardSigtermToSigint unwinds its own interrupt scope on a throw', () => {
  afterEach(() => {
    disarmInterruptWatchForTests();
  });

  it('leaves the provider-side watch UNARMED when the SIGTERM registration throws', () => {
    // The guard had zero coverage: deleting `endCommandInterruptScope()` from
    // that catch reddened nothing. The failure it prevents is permanent and
    // silent — the scope depth stays raised for the life of the PROCESS, which
    // arms the provider-side watch for every command that follows, including
    // the ones property 3 exists to keep on Node's default terminate. The
    // caller cannot unwind it either: it never received an unregister function.
    const originalOn = process.on.bind(process);
    const onSpy = vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      listener: (...args: unknown[]) => void
    ) => {
      if (event === 'SIGTERM') throw new Error('SIGTERM registration blew up');
      return originalOn(event as never, listener as never);
    }) as never);
    try {
      expect(() => forwardSigtermToSigint()).toThrow('SIGTERM registration blew up');
    } finally {
      onSpy.mockRestore();
    }

    // The observable consequence of the scope, rather than the private counter:
    // a wait started now must NOT arm the shared handler.
    const probe = startInterruptWatch('a provider wait');
    try {
      expect(interruptWatchListenerCount()).toBe(0);
    } finally {
      probe.dispose();
    }
  });

  it('DOES arm inside a scope that opened cleanly, so the case above is not vacuous', () => {
    const unforward = forwardSigtermToSigint();
    const probe = startInterruptWatch('a provider wait');
    try {
      expect(interruptWatchListenerCount()).toBe(1);
    } finally {
      probe.dispose();
      unforward();
    }
  });
});

describe('isPromptAbortError pins the shape readline actually rejects with', () => {
  it('accepts the REAL rejection from an aborted readline/promises question', async () => {
    // The command suites mock `node:readline/promises` wholesale and hand-build
    // an `AbortError`, so nothing anywhere pinned the predicate against what
    // Node genuinely throws. This drives the real module: an interface over a
    // stream that never produces a line, a question carrying the watch's own
    // signal shape, and the abort that the SIGINT handler performs.
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const rl = createInterface({ input, output });
    const controller = new AbortController();
    try {
      const pending = rl.question('answer? ', { signal: controller.signal });
      controller.abort();
      const error = await pending.then(
        () => undefined,
        (rejection: unknown) => rejection
      );

      expect(isPromptAbortError(error)).toBe(true);
      // Both fields, spelled out: this is the observation the two arm-isolating
      // cases below are derived from, so if a future Node changes either one
      // this case names which.
      expect((error as { name?: unknown }).name).toBe('AbortError');
      expect((error as { code?: unknown }).code).toBe('ABORT_ERR');
    } finally {
      rl.close();
      input.destroy();
      output.destroy();
    }
  });

  it('accepts the NAME arm on its own', () => {
    // The `DOMException` spelling some Node versions reject with. Isolated from
    // the code arm so each is individually load-bearing.
    expect(isPromptAbortError({ name: 'AbortError' })).toBe(true);
  });

  it('accepts the CODE arm on its own', () => {
    // Removing `code === 'ABORT_ERR'` from the predicate reddened NOTHING
    // before this case, because every fixture also carried the name.
    expect(isPromptAbortError({ name: 'Error', code: 'ABORT_ERR' })).toBe(true);
  });

  it('rejects an ordinary failure and the non-object shapes', () => {
    // The negative control: without it a predicate hardcoded to `true` would
    // satisfy all three cases above.
    expect(isPromptAbortError(new Error('readline blew up'))).toBe(false);
    expect(isPromptAbortError({ name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' })).toBe(false);
    expect(isPromptAbortError(null)).toBe(false);
    expect(isPromptAbortError('AbortError')).toBe(false);
    expect(isPromptAbortError(undefined)).toBe(false);
  });
});
