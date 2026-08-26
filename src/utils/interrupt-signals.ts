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
 * poll-abort listeners in CustomResource / CloudFront / ACM — `grep -rn
 * "process.on('SIGINT'" src/provisioning/providers/` regenerates that closed
 * set, and Route53 is NOT in it) is
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
  // satisfied by the transient listeners CustomResource / CloudFront / ACM
  // install around their own waits (`grep -rn "process.on('SIGINT'"
  // src/provisioning/providers/` — Route53 registers none)
  // — so `cdkd drift`, which owns no shutdown path and
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
   * once, which is the whole difference from `DestroyRunnerResult.interrupted`.
   */
  interrupted(): boolean;
  /**
   * Aborted the instant the first signal is RECORDED.
   *
   * Recording a flag is enough for anything that polls it — the `--all` loop
   * checks between stacks — and useless for anything BLOCKED. The command's
   * own `readline` prompt is the live instance: `await rl.question(...)` is
   * waiting on the USER, not on AWS, and installing any SIGINT listener
   * disables Node's default terminate, so a Ctrl-C at the prompt used to end
   * the process and now would leave it parked there forever. Pass this to
   * `rl.question(prompt, { signal })` and treat the resulting `AbortError` as
   * "the user cancelled".
   *
   * Only the piped / non-TTY shape reaches that hang at a real terminal —
   * readline intercepts ^C itself when stdin is a TTY — which is the CI
   * population issue #1342 exists for, and exactly where nobody is watching.
   */
  readonly signal: AbortSignal;
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
 * `--all` loop was `DestroyRunnerResult.interrupted` — a boolean assigned ONCE,
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
 * flags answer different questions and both are kept, one owner each:
 *
 *  - PER-STACK, "did THIS stack finish, or is there work left in it?" —
 *    `DestroyRunnerResult.interrupted`, owned by `destroy-runner.ts`. It has FOUR
 *    consumers: that stack's state preservation, its summary line,
 *    `destroy.ts`'s `--purge-events` skip, and — the one earlier revisions of
 *    this list omitted — `NestedStackProvider.delete`, which reads the CHILD's
 *    result to decide whether the child row is `{ outcome: 'skipped' }` on the
 *    parent and whether its failure is `markNonRetryable`.
 *
 *    That fourth consumer is why the `&& statePreserved` gate below is a
 *    behavior change beyond the exit code: a fully-destroyed child that takes
 *    a tail signal no longer reports `interrupted`, so the parent no longer
 *    marks its row skipped. That is the CORRECT reading — `skipped` means
 *    "cdkd could not address this, the resources may still exist in AWS",
 *    which is false of a child whose every resource was deleted and whose
 *    state record is gone; it would preserve the parent's row for a child that
 *    no longer exists and exit 2 over a completed teardown. Stopping the
 *    surrounding `--all` run is a DIFFERENT question, still answered by this
 *    watch, which the parent command holds for its whole run.
 *  - PER-RUN, "has the user asked this COMMAND to stop?" — this watch. Its
 *    consumers are the loops' `break`s and the terminal exit-code verdict
 *    (which pairs it with `stoppedEarly`, so a signal in a completed run's
 *    tail does not report unfinished work there is none of).
 *
 * `--purge-events` moved onto the per-stack answer when the runner's outer
 * re-sync was gated on `statePreserved`. Before that the per-stack flag could
 * be true over a stack whose state was already DELETED, so the purge had to
 * read the command-level one to stay conservative — at the cost of the
 * opposite error: a tail signal on the LAST stack skipped the purge while the
 * command exited 0, reporting full success with the events left behind. With
 * the per-stack flag accurate, one read serves both directions.
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
  // The push half of the record. `interrupted` serves everything that POLLS;
  // this serves everything that is BLOCKED and would otherwise never look
  // again — today, the batch confirm prompt in `state.ts`. Aborting is
  // idempotent, so every path that records the signal may call it.
  const promptAbort = new AbortController();
  function markInterrupted(): void {
    interrupted = true;
    promptAbort.abort();
  }
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
   * A provider's transient wait listener does count, and that is correct
   * rather than a false positive: three providers install one — grep
   * `process.on('SIGINT'` under `src/provisioning/providers/**` for the
   * closed set, today `acm-certificate-provider.ts`,
   * `cloudfront-distribution-provider.ts` and `custom-resource-provider.ts`,
   * NOT Route53, whose provider registers none — and each exists only
   * DURING a provider wait, which is strictly inside the runner handler's own
   * lifetime, so one cannot be present while the runner's is absent.
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
      markInterrupted();
      return;
    }
    if (interrupted) {
      // Second signal with no graceful owner. A stack lock is ALMOST never
      // held in this window: the interrupted stack released its own in
      // `runDestroyForStack`'s `finally` before returning, the loop takes none,
      // and the runner's pre-registration window sits entirely before its
      // `acquireLock`.
      //
      // "Almost" is why the hedged recovery line is printed anyway, matching
      // what `interrupt-watch.ts`'s force-quit used to print in this exact
      // window before this watch took it over. That release is best-effort:
      // `destroy-runner.ts` catches a failing `releaseLock` and only WARNS, so
      // a stack that finished with a 409 / throttle on the release leaves the
      // lock live for its full TTL — and this is the one place a user is about
      // to lose the process without being told how to recover. The line cannot
      // be qualified with region / profile / bucket the way the runner's own
      // force-quit is (issue #2170), because this handler holds no such
      // context; a placeholder that is honest about being a guess beats
      // inventing defaults that point at a different lock object.
      //
      // The window is narrow for a second reason worth keeping: there is NO
      // `await` between the runner's `removeListener` and its return, so a
      // signal cannot land here mid-teardown. `destroy-runner.ts` records that
      // dependency at the site.
      process.stderr.write(
        '\nForce-quit.\n' +
          'If the next run reports a stack lock, release it with: cdkd force-unlock <stack-name>\n'
      );
      process.exit(130);
    }
    markInterrupted();
    if (stacksInFlight > 0) {
      // In the runner's pre-registration window. It has not armed its handler,
      // so it will never observe this signal, and returning gracefully would
      // let it delete the whole stack anyway. Exiting is what happened here
      // BEFORE this watch existed (the shared watch's last-listener
      // force-quit), so this preserves that guarantee rather than narrowing it.
      //
      // The claim is scoped to THIS stack, and both halves of the flat
      // "nothing was deleted and no stack lock is held" this used to print are
      // false on an `--all` run whose earlier stacks already completed. The
      // lock half is hedged for the same reason as the branch above:
      // `destroy-runner.ts` catches a failing `releaseLock` and only WARNS, so
      // a completed stack can leave its lock live for the full TTL, and this
      // is one of the two places a user loses the process without being told
      // how to recover.
      process.stderr.write(
        `\nInterrupted before ${opts.command} armed its per-stack teardown — ` +
          `quitting now. No delete was issued for this stack; on an --all run, ` +
          `stacks processed earlier are already destroyed.\n` +
          `If the next run reports a stack lock, release it with: cdkd force-unlock <stack-name>\n`
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
    signal: promptAbort.signal,
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

/**
 * Did this rejection come from a prompt aborted through
 * {@link CommandInterruptWatch.signal}?
 *
 * Deliberately duck-typed rather than `instanceof`: what `readline/promises`
 * rejects with is an internal Node error class in some versions and a
 * `DOMException` in others, and neither is importable. Both spellings carry
 * `name === 'AbortError'` / `code === 'ABORT_ERR'`, and the caller pairs this
 * with its own `watch.interrupted()` check, so a same-named error from an
 * unrelated abort cannot be mistaken for the user's Ctrl-C.
 */
export function isPromptAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === 'AbortError' || code === 'ABORT_ERR';
}
