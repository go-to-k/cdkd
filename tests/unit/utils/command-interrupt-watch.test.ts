import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import { watchCommandInterrupt } from '../../../src/utils/interrupt-signals.js';
import {
  beginCommandInterruptScope,
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
    } finally {
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
      // The message must be honest about the two facts that make quitting safe
      // here rather than merely abrupt.
      expect(cap.output.join('')).toContain('Nothing was deleted');
      expect(cap.output.join('')).toContain('no stack lock is held');
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
    try {
      const watch = arm();
      const removeRunner = installRunnerHandler();
      await expect(
        watch.runStack(async () => {
          process.emit('SIGINT', 'SIGINT');
          throw new Error('destroy blew up');
        })
      ).rejects.toThrow('destroy blew up');
      // Deferred while the runner was armed, so nothing has quit yet.
      expect(exitSpy).not.toHaveBeenCalled();
      removeRunner();

      // A leaked depth would suppress the force-quit for the rest of the run.
      process.emit('SIGINT', 'SIGINT');
      expect(exitSpy).toHaveBeenCalledWith(130);
    } finally {
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
