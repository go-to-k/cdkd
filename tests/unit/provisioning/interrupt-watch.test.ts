import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';

import {
  InterruptedWaitError,
  beginCommandInterruptScope,
  disarmInterruptWatchForTests,
  endCommandInterruptScope,
  interruptWatchListenerCount,
  interruptWatchTestSeam,
  isInterruptedWaitError,
  resetInterruptWatchLatch,
  startInterruptWatch,
} from '../../../src/provisioning/interrupt-watch.js';

/**
 * The shared interrupt watch (issues #2053 / #1952 / #2104).
 *
 * Four module-local copies were consolidated here, and the consolidation is
 * what let two blockers be fixed at all: ONE latch (four could not agree,
 * because a single `delete()` traverses more than one module) and ONE error
 * type (`deploy-engine.ts` decides whether to ROLL BACK by asking what the
 * failure was, and a bare `Error` from a provider read as a genuine resource
 * failure).
 *
 * The four behaviour suites exercise this module through providers. THIS file
 * pins the three properties none of them can see directly: the arming rule,
 * the sticky latch across SEQUENTIAL waits, and one process listener across
 * OVERLAPPING ones.
 */

/** A stand-in for the graceful SIGINT handler `destroy-runner.ts` installs. */
function installCommandHandler(): () => void {
  const handler = (): void => {};
  process.on('SIGINT', handler);
  return () => process.removeListener('SIGINT', handler);
}

/** Force-quits observed instead of taken, so a probe cannot kill the runner. */
let forcedQuits: number[] = [];

/** Fire every SIGINT listener except the stand-in command handlers. */
function fireSigint(exclude: readonly unknown[]): void {
  for (const listener of process.listeners('SIGINT')) {
    if (exclude.includes(listener)) continue;
    (listener as unknown as () => void)();
  }
}

describe('interrupt watch — arming (issue #2053 review item 4)', () => {
  let removeCommandHandler: (() => void) | undefined;

  beforeEach(() => {
    // Arming is a one-way door WITHIN a command, so every test here starts from
    // a cold module rather than inheriting whatever the previous one armed.
    disarmInterruptWatchForTests();
    forcedQuits = [];
    interruptWatchTestSeam.forceQuit = (code) => forcedQuits.push(code);
    delete interruptWatchTestSeam.commandOwnsInterrupts;
  });

  afterEach(() => {
    removeCommandHandler?.();
    removeCommandHandler = undefined;
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.commandOwnsInterrupts;
    delete interruptWatchTestSeam.forceQuit;
  });

  it('does NOT arm outside a command scope — default terminate must survive', () => {
    // Registering ANY listener disables Node's default terminate. `cdkd drift
    // --revert` reaches `provider.update` and opens no scope, so an armed watch
    // there would leave Ctrl-C setting flags nobody reads while the command
    // kept writing to AWS.
    const before = process.listeners('SIGINT');

    const watch = startInterruptWatch('unarmed wait');
    try {
      expect(interruptWatchListenerCount()).toBe(0);
      expect(process.listeners('SIGINT')).toEqual(before);
      expect(watch.isInterrupted()).toBe(false);
    } finally {
      watch.dispose();
    }
  });

  it('is NOT armed by a concurrent provider`s TRANSIENT listener', () => {
    // THE gap the listener-count gate had. `cdkd drift` runs `provider.update`
    // at concurrency 4, and a concurrent CloudFront / ACM / Route53 wait
    // installs its own SIGINT listener around its poll — so an ELBv2 update
    // starting inside that window saw a non-zero count, armed, and kept the
    // listener for the rest of a command that has no shutdown path.
    const transient = installCommandHandler();
    try {
      const watch = startInterruptWatch('an ELBv2 update during a CloudFront wait');
      try {
        expect(interruptWatchListenerCount()).toBe(0);
      } finally {
        watch.dispose();
      }
    } finally {
      transient();
    }
    // ...and once the transient listener is gone, nothing of ours remains to
    // suppress the default terminate for the rest of the command.
    expect(interruptWatchListenerCount()).toBe(0);
  });

  it('DOES arm inside a command scope', () => {
    beginCommandInterruptScope();
    removeCommandHandler = installCommandHandler();
    const commandListeners = process.listeners('SIGINT');

    const watch = startInterruptWatch('armed wait');
    try {
      expect(interruptWatchListenerCount()).toBe(1);
      fireSigint(commandListeners);
      expect(watch.isInterrupted()).toBe(true);
    } finally {
      watch.dispose();
      endCommandInterruptScope();
    }
  });

  it('re-attempts arming on every watch, so an early wait cannot poison later ones', () => {
    const early = startInterruptWatch('before the command opened its scope');
    early.dispose();
    expect(interruptWatchListenerCount()).toBe(0);

    beginCommandInterruptScope();
    removeCommandHandler = installCommandHandler();
    const commandListeners = process.listeners('SIGINT');
    const later = startInterruptWatch('after the command opened its scope');
    try {
      expect(interruptWatchListenerCount()).toBe(1);
      fireSigint(commandListeners);
      expect(later.isInterrupted()).toBe(true);
    } finally {
      later.dispose();
      endCommandInterruptScope();
    }
  });

  it('closing the scope removes the listener, restoring default terminate', () => {
    beginCommandInterruptScope();
    const watch = startInterruptWatch('a wait');
    expect(interruptWatchListenerCount()).toBe(1);
    watch.dispose();
    endCommandInterruptScope();
    expect(interruptWatchListenerCount()).toBe(0);
  });
});

describe('interrupt watch — the sticky latch (issue #1952 blocker)', () => {
  let removeCommandHandler: (() => void) | undefined;
  let commandListeners: readonly unknown[] = [];

  beforeEach(() => {
    disarmInterruptWatchForTests();
    forcedQuits = [];
    interruptWatchTestSeam.forceQuit = (code) => forcedQuits.push(code);
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    removeCommandHandler = installCommandHandler();
    commandListeners = [...process.listeners('SIGINT')];
  });

  afterEach(() => {
    removeCommandHandler?.();
    removeCommandHandler = undefined;
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.commandOwnsInterrupts;
    delete interruptWatchTestSeam.forceQuit;
  });

  it('a wait STARTED after the signal is already interrupted', () => {
    // THE blocker. `GlobalTable.delete()` runs the #1521 gate, then the
    // index-busy retry loop (~18 min), then the gone-wait (~12 min), each
    // disposing before the next begins. Clearing the latch on dispose — the
    // first cut — left both multi-minute waits DEAF to a signal that landed in
    // the gate, which is issue #1952's own scenario surviving its own fix.
    const first = startInterruptWatch('the #1521 gate');
    fireSigint(commandListeners);
    expect(first.isInterrupted()).toBe(true);
    first.dispose();

    const second = startInterruptWatch('the index-busy retry loop');
    try {
      expect(second.isInterrupted()).toBe(true);
    } finally {
      second.dispose();
    }

    const third = startInterruptWatch('the gone-wait');
    try {
      expect(third.isInterrupted()).toBe(true);
    } finally {
      third.dispose();
    }
  });

  it('survives the live set emptying — dispose must not clear it', () => {
    // Stated separately from the case above because it is the MECHANISM rather
    // than the scenario: disposing every watch is what used to reset the flag,
    // and sequential waits always empty the set between them.
    const only = startInterruptWatch('a wait');
    fireSigint(commandListeners);
    only.dispose();

    const next = startInterruptWatch('the next wait');
    try {
      expect(next.isInterrupted()).toBe(true);
    } finally {
      next.dispose();
    }
  });

  it('is cleared by the per-command reset, and ONLY by it', () => {
    const first = startInterruptWatch('command one');
    fireSigint(commandListeners);
    first.dispose();

    // `forwardSigtermToSigint()` calls this at command start.
    resetInterruptWatchLatch();

    const second = startInterruptWatch('command two');
    try {
      expect(second.isInterrupted()).toBe(false);
    } finally {
      second.dispose();
    }
  });

  it('the reset also clears watches that are still LIVE', () => {
    const live = startInterruptWatch('a wait spanning the reset');
    try {
      fireSigint(commandListeners);
      expect(live.isInterrupted()).toBe(true);
      resetInterruptWatchLatch();
      expect(live.isInterrupted()).toBe(false);
    } finally {
      live.dispose();
    }
  });
});

describe('interrupt watch — OVERLAPPING waits share one listener', () => {
  let removeCommandHandler: (() => void) | undefined;
  let commandListeners: readonly unknown[] = [];

  beforeEach(() => {
    disarmInterruptWatchForTests();
    forcedQuits = [];
    interruptWatchTestSeam.forceQuit = (code) => forcedQuits.push(code);
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    removeCommandHandler = installCommandHandler();
    commandListeners = [...process.listeners('SIGINT')];
  });

  afterEach(() => {
    removeCommandHandler?.();
    removeCommandHandler = undefined;
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.commandOwnsInterrupts;
    delete interruptWatchTestSeam.forceQuit;
  });

  it('ten concurrent waits add ONE listener, and all ten see the signal', () => {
    // This is the claim the per-site suites CANNOT make: only one watch is ever
    // live at fire time there, so a per-watch-listener implementation would
    // score 1 too. `--concurrency 10` is the default, Node warns above ten
    // listeners, and only `destroy-runner.ts` raises that ceiling — so a
    // listener per in-flight resource is a user-visible warning on the DEPLOY
    // path, which raises nothing.
    const watches = Array.from({ length: 10 }, (_, i) => startInterruptWatch(`resource ${i}`));
    try {
      expect(interruptWatchListenerCount()).toBe(1);
      expect(process.listeners('SIGINT').length - commandListeners.length).toBe(1);

      fireSigint(commandListeners);
      expect(watches.every((w) => w.isInterrupted())).toBe(true);
    } finally {
      for (const w of watches) w.dispose();
    }
  });

  it('a watch that starts mid-flight joins the same listener and inherits the latch', () => {
    const early = startInterruptWatch('resource A');
    try {
      fireSigint(commandListeners);
      const late = startInterruptWatch('resource B');
      try {
        expect(interruptWatchListenerCount()).toBe(1);
        expect(late.isInterrupted()).toBe(true);
        expect(early.isInterrupted()).toBe(true);
      } finally {
        late.dispose();
      }
    } finally {
      early.dispose();
    }
  });

  it('double dispose is a no-op', () => {
    const watch = startInterruptWatch('a wait');
    watch.dispose();
    expect(() => watch.dispose()).not.toThrow();
  });
});

describe('interrupt watch — the LAST-listener force-quit (multi-stack destroy gap)', () => {
  let forced: number[] = [];

  beforeEach(() => {
    disarmInterruptWatchForTests();
    forced = [];
    interruptWatchTestSeam.forceQuit = (code) => forced.push(code);
    beginCommandInterruptScope();
  });

  afterEach(() => {
    endCommandInterruptScope();
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.forceQuit;
    delete interruptWatchTestSeam.commandOwnsInterrupts;
  });

  it('does NOT force-quit while a command`s graceful handler is live', () => {
    const removeCommandHandler = installCommandHandler();
    const commandListeners = process.listeners('SIGINT');
    const watch = startInterruptWatch('a wait');
    try {
      fireSigint(commandListeners);
      expect(watch.isInterrupted()).toBe(true);
      expect(forced).toEqual([]);
    } finally {
      watch.dispose();
      removeCommandHandler();
    }
  });

  it('DOES force-quit in the gap between two stacks of a multi-stack destroy', () => {
    // `destroy.ts` registers no SIGINT handler of its own; `destroy-runner.ts`
    // registers the only one a destroy has and removes it in its `finally`. So
    // between two `runDestroyForStack` calls the shared watch is the ONLY
    // listener — and merely latching there SWALLOWS the Ctrl-C: the process
    // does not exit, `draining` is never set, `result.interrupted` stays false,
    // and the loop proceeds to delete the NEXT stack after the user asked to
    // stop. That is this whole change's headline failure, one layer out.
    const removeCommandHandler = installCommandHandler();
    const stackOne = startInterruptWatch('stack 1 wait');
    stackOne.dispose();
    // ...the runner's `finally` removes its handler; ours remains.
    removeCommandHandler();

    const ours = process.listeners('SIGINT');
    expect(ours).toHaveLength(1);
    fireSigint([]);

    expect(forced).toEqual([130]);
  });

  it('prints the lock-recovery command, not just \'Interrupted.\'', () => {
    // `destroy-runner.ts`'s own force-quit arm prints `cdkd force-unlock
    // <stack>` because a hard exit can strand the lock. This handler cannot
    // know whether one is held — it has no command context — so it prints the
    // hint hedged and unconditionally. One line on the common lock-free path is
    // the price of not leaving a user staring at a 30-minute TTL.
    //
    // `process.stderr.write` is REPLACED rather than spied: a spy leaves the
    // real write in place and vitest swallows it for a passing test, so the
    // assertion would read an empty buffer.
    const realWrite = process.stderr.write.bind(process.stderr);
    const written: string[] = [];
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const removeCommandHandler = installCommandHandler();
      const watch = startInterruptWatch('a wait');
      watch.dispose();
      removeCommandHandler();
      fireSigint([]);
    } finally {
      process.stderr.write = realWrite;
    }

    const all = written.join('');
    expect(all).toContain('Interrupted.');
    expect(all).toContain('cdkd force-unlock');
    expect(forced).toEqual([130]);
  });

  it('does NOT force-quit while a command handler is present but ABOUT to be removed', () => {
    // The third window, and the one three review rounds missed: a command that
    // holds a lock, removes its handler, and only THEN releases. While the
    // handler is still there the watch must stay quiet — the fix for that
    // window is the ordering in `destroy-runner.ts`
    // (`destroy-runner-lock-release-ordering.test.ts`), and this is the half of
    // the contract that lives here.
    const removeCommandHandler = installCommandHandler();
    const commandListeners = process.listeners('SIGINT');
    const watch = startInterruptWatch('a wait while the lock is held');
    try {
      fireSigint(commandListeners);
      expect(forced).toEqual([]);
      expect(watch.isInterrupted()).toBe(true);
    } finally {
      watch.dispose();
      removeCommandHandler();
    }
  });

  it('force-quits on the FIRST Ctrl-C in that gap, not the second', () => {
    // The watch's handler is not a force-quit path of its own, so a user who
    // pressed Ctrl-C twice in the gap used to get nothing either time.
    const removeCommandHandler = installCommandHandler();
    const watch = startInterruptWatch('a wait');
    watch.dispose();
    removeCommandHandler();

    fireSigint([]);
    expect(forced).toEqual([130]);
  });
});

describe('interrupt watch — command scopes NEST', () => {
  beforeEach(() => {
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.forceQuit = () => {};
  });

  afterEach(() => {
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.forceQuit;
    delete interruptWatchTestSeam.commandOwnsInterrupts;
  });

  it('an INNER scope closing does not disarm the outer command', () => {
    // A boolean flag was the first cut, and under it the inner `end` removed
    // the shared listener and cleared the OUTER command's sticky latch mid-run
    // — a signal landing in the re-arm gap then goes unrecorded, which is
    // exactly what property 2 forbids, reached from a door property 2 does not
    // watch. Unreachable on today's CLI, but the module offers itself to a host
    // that runs more than one command.
    beginCommandInterruptScope();
    const removeCommandHandler = installCommandHandler();
    const commandListeners = process.listeners('SIGINT');
    const outer = startInterruptWatch('outer command wait');
    expect(interruptWatchListenerCount()).toBe(1);

    beginCommandInterruptScope();
    endCommandInterruptScope();

    try {
      // Still armed, and the outer watch still live.
      expect(interruptWatchListenerCount()).toBe(1);
      fireSigint(commandListeners);
      expect(outer.isInterrupted()).toBe(true);
    } finally {
      outer.dispose();
      removeCommandHandler();
      endCommandInterruptScope();
    }
    expect(interruptWatchListenerCount()).toBe(0);
  });

  it('an INNER scope opening does not clear a latch the outer command already has', () => {
    beginCommandInterruptScope();
    const removeCommandHandler = installCommandHandler();
    const commandListeners = process.listeners('SIGINT');
    const outer = startInterruptWatch('outer command wait');
    fireSigint(commandListeners);
    expect(outer.isInterrupted()).toBe(true);

    beginCommandInterruptScope();
    try {
      // The inner scope must not erase an interrupt the outer command saw.
      expect(outer.isInterrupted()).toBe(true);
      const inner = startInterruptWatch('inner command wait');
      expect(inner.isInterrupted()).toBe(true);
      inner.dispose();
    } finally {
      endCommandInterruptScope();
      outer.dispose();
      removeCommandHandler();
      endCommandInterruptScope();
    }
  });
});

describe('isInterruptedWaitError — the cause-chain classifier', () => {
  it('recognises the error itself', () => {
    expect(isInterruptedWaitError(new InterruptedWaitError('a wait'))).toBe(true);
  });

  it('survives the subclass losing `instanceof`', () => {
    // Without the explicit `setPrototypeOf`, an `Error` subclass loses
    // `instanceof` under this repo's target and the classifier would silently
    // answer `false` for every real interrupt.
    expect(new InterruptedWaitError('a wait')).toBeInstanceOf(InterruptedWaitError);
    expect(new InterruptedWaitError('a wait')).toBeInstanceOf(Error);
  });

  it('recognises it ONE hop down — the normal case, not the edge case', () => {
    // Every provider catch re-throws AWS failures as a `ProvisioningError`
    // threading the original as `cause` (issue #2040), so a plain `instanceof`
    // at the engine would have been a placebo.
    const wrapped = new Error('Failed to delete table X', {
      cause: new InterruptedWaitError('a wait'),
    });
    expect(isInterruptedWaitError(wrapped)).toBe(true);
  });

  it('recognises it under DEEP nesting — there is no ceiling', () => {
    // The depth cap this replaces was sized against a chain that GROWS.
    // `DagExecutor` adds no wrap (`dag-executor.ts:178` collects rather than
    // wraps) but `deploy-engine.ts:2932` adds one `ProvisioningError` PER
    // NESTED-STACK LEVEL, so the flat case is 2 and every level adds one. A
    // cap of 5 therefore missed at four levels of nesting — and missing here
    // is not a degraded answer, it is a full automatic rollback on Ctrl-C.
    for (const levels of [2, 5, 6, 20]) {
      const chain = Array.from({ length: levels }).reduce<Error>(
        (inner) => new Error('nested stack wrap', { cause: inner }),
        new InterruptedWaitError('a wait')
      );
      expect(isInterruptedWaitError(chain), `${levels} levels`).toBe(true);
    }
  });

  it('terminates on a CYCLIC cause chain instead of hanging the failure path', () => {
    // The termination the depth cap was really there for, kept without a
    // ceiling: a `visited` set. An unbounded walk with no set would spin here,
    // and it would spin on the ERROR path, where nothing else is watching.
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(isInterruptedWaitError(a)).toBe(false);
  });

  it('finds an interrupt sitting BEYOND a cycle`s entry point', () => {
    // The set must bound revisits, not the walk itself: a chain that loops back
    // once and then continues has to keep being followed.
    const interrupt = new InterruptedWaitError('a wait');
    const deep = new Error('deep', { cause: interrupt });
    const outer = new Error('outer', { cause: deep });
    (deep as { cause?: unknown }).cause = interrupt;
    expect(isInterruptedWaitError(outer)).toBe(true);
  });

  it('refuses an unrelated error, a non-Error cause, and a non-error value', () => {
    expect(isInterruptedWaitError(new Error('AccessDenied'))).toBe(false);
    expect(isInterruptedWaitError(new Error('wrap', { cause: 'interrupted by user' }))).toBe(false);
    expect(isInterruptedWaitError('interrupted by user (SIGINT)')).toBe(false);
    expect(isInterruptedWaitError(undefined)).toBe(false);
    expect(isInterruptedWaitError(null)).toBe(false);
  });

  it('refuses a LOOK-ALIKE — the message is not the signal', () => {
    // A wording test would have been satisfied by any AWS error quoting the
    // word "interrupted", and by cdkd's own log lines.
    const lookAlike = new Error('a wait interrupted by user (SIGINT)');
    lookAlike.name = 'InterruptedWaitError';
    expect(isInterruptedWaitError(lookAlike)).toBe(false);
  });
});
