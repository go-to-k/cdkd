// NOTE: this is `utils/` importing from `provisioning/`, which inverts the
// usual layering. It is deliberate and bounded rather than an oversight:
// `interrupt-watch.ts` is a LEAF (it imports nothing but `process`), so the
// edge closes no cycle, and the alternative — having each of the four commands
// open the scope itself — would put the same call in four places where one of
// them will eventually be forgotten. Revisit if that module ever grows an
// import of its own.
import {
  beginCommandInterruptScope,
  endCommandInterruptScope,
  interruptWatchListenerCount,
} from '../provisioning/interrupt-watch.js';

/**
 * SIGTERM -> SIGINT forwarding for the deploy / destroy / rollback commands
 * (issue #1342).
 *
 * CI runners rarely deliver a clean Ctrl-C: GitHub Actions escalates
 * SIGINT -> SIGTERM (~7.5s later) -> SIGKILL (~2.5s after that) on job
 * cancellation, and GitLab CI / `docker stop` / Kubernetes send SIGTERM
 * directly. cdkd's graceful-interrupt handling (the top-level command
 * handlers, the deploy engine's partial-state save, and the per-provider
 * poll-abort listeners in CustomResource / ACM / CloudFront / Route53) is
 * registered on SIGINT only, so an unhandled SIGTERM killed the process
 * mid-run, skipped every `finally`, and stranded the stack lock for its
 * full TTL.
 *
 * Re-emitting SIGTERM as SIGINT routes it through the exact same graceful
 * path with ONE registration per command, covering every current and future
 * SIGINT listener. The "second signal escalates to force-quit" semantics
 * compose correctly: under GitHub Actions the initial SIGINT starts the
 * graceful drain, and the follow-up SIGTERM (delivered when the runner is
 * ~2.5s from SIGKILL) becomes the force-quit that fires the best-effort
 * lock release before the process dies. In SIGTERM-only environments the
 * first SIGTERM starts the full graceful drain.
 */

/**
 * Forward SIGTERM deliveries to the process's SIGINT listeners.
 *
 * Returns an unregister function. Callers register at command start and
 * unregister in their outermost `finally` so the listener never leaks across
 * commands (or into `cdkd local start-api`, which owns a real SIGTERM
 * handler of its own).
 */
export function forwardSigtermToSigint(): () => void {
  // This is also where the provider-side interrupt watch is told a command with
  // a graceful shutdown path is now running (issues #2053 / #1952). It gates on
  // THIS rather than on `process.listenerCount('SIGINT')`, because a count is
  // satisfied by the transient listeners CloudFront / ACM / Route53 install
  // around their own waits — so `cdkd drift`, which owns no shutdown path and
  // runs `provider.update` at concurrency 4, could arm the watch through a
  // concurrent resource's listener and then keep it after that listener went
  // away, leaving Ctrl-C unable to terminate the command at all.
  //
  // Every command that reaches a provider wait through a lock calls this
  // (`deploy`, `destroy`, `rollback`, `state`); `drift` does not, and keeps
  // Node's default terminate, which is the intended outcome rather than a gap.
  //
  // It doubles as the PER-COMMAND reset of the sticky interrupt latch: the latch
  // must survive between two sequential waits (that is the whole point of it),
  // so nothing on the wait path may clear it and command start is the only
  // correct scope.
  beginCommandInterruptScope();
  // Everything after the scope is opened runs inside a guard: a throw here
  // would leave `commandInterruptScopeDepth` raised for the life of the
  // PROCESS, which arms the provider-side watch permanently — the exact
  // failure its own property 3 exists to prevent. The callers' `finally`
  // never runs, because they never received an unregister function.
  try {
    return installSigtermForwarder();
  } catch (error) {
    endCommandInterruptScope();
    throw error;
  }
}

/** The registration half of {@link forwardSigtermToSigint}, after its scope is open. */
function installSigtermForwarder(): () => void {
  const handler = (): void => {
    if (process.listenerCount('SIGINT') === 0) {
      // No graceful path is active (e.g. during synthesis, before the
      // engine / destroy-runner registered their SIGINT handlers). Emitting
      // SIGINT here would be a silent no-op and the process would IGNORE the
      // termination request — preserve the default SIGTERM behavior instead
      // (128 + 15). Matches what a raw Ctrl-C does in the same window. Since
      // issue #1348 every lock-taking command registers its SIGINT handler
      // BEFORE acquiring the stack lock, so this fallback only fires in
      // lock-free phases and never exits with a lock held.
      process.exit(143);
    }
    process.emit('SIGINT', 'SIGINT');
  };
  process.on('SIGTERM', handler);
  return (): void => {
    process.removeListener('SIGTERM', handler);
    // Closing the interrupt scope also removes the watch's shared SIGINT
    // listener. That is safe here and nowhere else: the listener must never be
    // torn down BETWEEN two waits (a signal landing in the gap would go
    // unrecorded), and at command end there is no next wait — while leaving it
    // installed would suppress default terminate for whatever runs after.
    endCommandInterruptScope();
  };
}

/**
 * A command-scoped record of "the user asked this command to stop".
 *
 * Returned by {@link watchCommandInterrupt}. See that function for why the
 * destroy commands need one.
 */
export interface CommandInterruptWatch {
  /**
   * True once SIGINT (or a SIGTERM forwarded by
   * {@link forwardSigtermToSigint}) has been delivered to this command.
   *
   * Read it at every point the multi-stack loop decides whether to keep
   * going. It is a LIVE read of a flag a handler writes, not a value sampled
   * once, which is the whole difference from `DestroyRunResult.interrupted`.
   */
  interrupted(): boolean;
  /**
   * Bracket one per-stack destroy.
   *
   * While a per-stack destroy is in flight, `runDestroyForStack` has its own
   * SIGINT handler armed and that handler owns the second-Ctrl-C force-quit —
   * it releases the stack lock best-effort and prints the region-qualified
   * `cdkd force-unlock` recovery command. This watch therefore stays silent in
   * that window and lets the runner's handler do both jobs. Outside it (before
   * the first stack, between stacks, after the last) no runner handler exists,
   * so this watch takes the force-quit itself.
   */
  runStack<T>(fn: () => Promise<T>): Promise<T>;
  /** Remove the handler. Call from the command's outermost `finally`. */
  dispose(): void;
}

/**
 * Register a command-scoped SIGINT handler for the destroy commands
 * (issue #2117).
 *
 * `cdkd deploy` has had one of these since issue #1348 (`deploy.ts`'s
 * `topLevelSigintHandler`). The destroy side had none, so the ONLY channel
 * carrying "the user interrupted" from `runDestroyForStack` back to the
 * `--all` loop was `DestroyRunResult.interrupted` — a boolean assigned ONCE,
 * inside the runner's `try`, after its level loop. Every instant where the
 * runner's `draining` flag flips AFTER that assignment is an instant where
 * `cdkd destroy --all` went on to delete the NEXT stack after the user asked
 * it to stop.
 *
 * The runner's outer `finally` re-syncs `result.interrupted ||= draining` to
 * cover the widest such window (renderer teardown, state flush, lock release),
 * and that line is marked TACTICAL in its own comment: it narrows the window
 * rather than removing it. Two gaps survive it, and neither is reachable from
 * inside the runner at all:
 *
 * 1. The runner removes its SIGINT listener in its inner `finally`, BEFORE the
 *    re-sync line and its `return`, so from there on nothing of the runner's is
 *    armed. This watch covers that stretch — by RECORDING once a graceful owner
 *    is gone and the stack is done, and by QUITTING in the mirror-image window
 *    at the START of a stack, where the runner has not armed yet and could not
 *    act on a recorded flag (see `gracefulOwnerArmed` below).
 * 2. Everything the `--all` loop itself does between two stacks — the
 *    `RUN_FINISHED` event, `eventRecorder.finalize`, `purgeEventsAfterDestroy`
 *    — runs with no runner handler armed at all.
 *
 * A handler that lives for the whole command closes both, because it is armed
 * in every window rather than in the ones the runner happens to span. The two
 * flags answer different questions and both are kept: `result.interrupted` is
 * the PER-STACK outcome (it decides that stack's state preservation, its
 * summary line and its `--purge-events` skip), while this one is the
 * COMMAND-level "stop" the loop wants.
 *
 * Note on the counterpart contract: `deploy-engine.ts` removes its own SIGINT
 * handler before releasing its lock, which is safe only because `deploy.ts`'s
 * top-level handler outlives it. The destroy side now has the same property
 * for the same reason — `destroy-runner.ts`'s `process.removeListener('SIGINT',
 * sigintHandler)` is no longer the last handler standing, because this one is
 * disposed only in the command's outermost `finally`.
 *
 * @param opts.command the user-facing command name used in the force-quit
 *   notice (`cdkd destroy` / `cdkd state destroy`).
 */
export function watchCommandInterrupt(opts: { command: string }): CommandInterruptWatch {
  let interrupted = false;
  // Depth rather than a boolean: `runStack` is not nested today, but a counter
  // cannot be desynchronised by a future caller that does nest it, whereas a
  // boolean would be cleared by the inner scope's exit while the outer one is
  // still running — re-opening exactly the unguarded window this closes.
  let stacksInFlight = 0;

  /**
   * Is some OTHER listener going to handle this signal gracefully?
   *
   * Being inside `runStack` is NOT the same question, and assuming it was is a
   * regression this fix already shipped once: `runDestroyForStack` registers
   * its own handler about two hundred lines in, AFTER the strong-reference
   * pre-flight scan (an S3 LIST plus a GET per stack) and the per-stack
   * confirm prompt. Staying silent across that window swallowed the signal
   * outright — no notice, no exit, no escalation on a repeat — and because
   * this watch IS a listener, `interrupt-watch.ts`'s last-listener force-quit
   * could no longer fire there either. The runner then began with `draining`
   * false and destroyed the whole stack the user had just asked to stop, which
   * is issue #2117's own defect one window further in.
   *
   * Counting listeners answers the real question, and the two exclusions are
   * what make the count mean "graceful owner":
   *
   *  - our own handler, which is not an answer to itself;
   *  - `interrupt-watch.ts`'s shared handler, which is a LATCH rather than a
   *    graceful owner — deferring to it is exactly the swallow above.
   *
   * A provider's transient wait listener (CustomResource / ACM / CloudFront /
   * Route53) does count, and that is correct rather than a false positive:
   * those exist only DURING a provider wait, which is strictly inside the
   * runner handler's own lifetime, so one cannot be present while the runner's
   * is absent.
   */
  function gracefulOwnerArmed(): boolean {
    const others = process.listeners('SIGINT').filter((l) => l !== handler).length;
    return others - interruptWatchListenerCount() > 0;
  }

  const handler = (): void => {
    if (stacksInFlight > 0 && gracefulOwnerArmed()) {
      // `runDestroyForStack`'s handler is armed and is a later listener in this
      // same dispatch (Node fires listeners in registration order and this one
      // registers at command start). It prints the drain notice on the first
      // signal and force-quits WITH a best-effort lock release plus the
      // region-qualified `cdkd force-unlock` line on the second — strictly
      // better than anything reachable from here. Record the signal and stay
      // out of the way.
      interrupted = true;
      return;
    }
    if (interrupted) {
      // Second signal with no graceful owner. No stack lock is held in this
      // window: the interrupted stack released its own in
      // `runDestroyForStack`'s `finally` before returning, the loop takes none,
      // and the runner's pre-registration window sits entirely before its
      // `acquireLock`. So there is no recovery command to print, unlike the
      // runner's force-quit path.
      //
      // That first clause rests on there being NO `await` between the runner's
      // `removeListener` and its return — add one and a signal could land here
      // after a completed destroy, where the release may itself have failed
      // (the runner catches and warns). `destroy-runner.ts` records the
      // dependency at that site.
      process.stderr.write('\nForce-quit.\n');
      process.exit(130);
    }
    interrupted = true;
    if (stacksInFlight > 0) {
      // In the runner's pre-registration window. It has not armed its handler,
      // so it will never observe this signal, and returning gracefully would
      // let it delete the whole stack anyway. Exiting is what happened here
      // BEFORE this watch existed (the shared watch's last-listener
      // force-quit), so this preserves that guarantee rather than narrowing
      // it: nothing has been deleted and no lock is held.
      process.stderr.write(
        `\nInterrupted before ${opts.command} armed its per-stack teardown — ` +
          `quitting now. Nothing was deleted and no stack lock is held.\n`
      );
      process.exit(130);
    }
    process.stderr.write(
      `\nInterrupted — ${opts.command} will stop before starting another stack ` +
        `(press Ctrl-C again to force-quit)...\n`
    );
  };

  process.on('SIGINT', handler);

  return {
    interrupted: (): boolean => interrupted,
    async runStack<T>(fn: () => Promise<T>): Promise<T> {
      stacksInFlight += 1;
      try {
        return await fn();
      } finally {
        stacksInFlight -= 1;
      }
    },
    dispose: (): void => {
      process.removeListener('SIGINT', handler);
    },
  };
}
