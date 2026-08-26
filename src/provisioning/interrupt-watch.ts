/**
 * The ONE interrupt watch every bounded wait under `src/provisioning/**` uses
 * (issues #2053 / #1952, consolidating the per-invocation shape PR #2033
 * introduced in `providers/custom-resource-provider.ts`).
 *
 * WHY A WAIT NEEDS ONE AT ALL
 * ---------------------------
 * `withRetry` (`src/deployment/retry.ts`) is the only wait in cdkd that
 * consults an interrupt DURING a backoff — it probes once a second while
 * sleeping. The deploy engine, `destroy-runner.ts` and `rollback-executor.ts`
 * all poll only BETWEEN operations. So a retry that threads nothing is dead to
 * Ctrl-C for its whole schedule, and on the destroy path `withResourceTimeout`
 * has by then abandoned the promise WITHOUT cancelling it, so the loop keeps
 * issuing writes behind a run the user was told had ended.
 * `docs/provider-development.md` states the requirement; `vp run
 * audit:withretry-interrupt:check` enforces it.
 *
 * WHY IT IS SHARED RATHER THAN PER MODULE
 * ---------------------------------------
 * Four modules carried a copy before issue #2104, and the copies could not
 * agree about the one thing that matters: a single `delete()` traverses more
 * than one of them, so a SIGINT marked only whichever module happened to hold a
 * live watch. One module means one latch, one error type, and ONE process
 * listener rather than four.
 *
 * FOUR PROPERTIES, EACH LOAD-BEARING
 * ----------------------------------
 *
 * 1. **The flag is per WAIT, never on a provider.** Providers are registered as
 *    SINGLETONS serving concurrent resources, so provider-level state is some
 *    other resource's.
 *
 * 2. **The latch is STICKY.** A watch STARTED after the signal begins is
 *    already interrupted. Clearing it when the last watch is disposed — the
 *    first cut — is wrong for exactly the case issue #1952 is about: a
 *    `GlobalTable` delete runs the #1521 gate, then the index-busy retry loop,
 *    then the gone-wait, each disposing before the next begins, so a SIGINT
 *    during the gate left the two multi-minute waits after it DEAF. Only a
 *    COMMAND clears it. The listener is likewise never torn down BETWEEN two
 *    waits: one removed in that gap cannot record a signal landing in it, which
 *    is the same bug one layer down. {@link endCommandInterruptScope} removes it
 *    at command END, where there is no next wait to miss.
 *
 * 3. **It arms only inside a command that OWNS interrupt handling.** Registering
 *    any SIGINT listener disables Node's default terminate, so a command with no
 *    graceful shutdown of its own must not gain one here: `cdkd drift --revert`
 *    reaches `provider.update` and installs nothing, and an armed watch there
 *    would leave Ctrl-C setting flags nobody reads while the command carried on
 *    writing to AWS — needing a SIGKILL.
 *
 *    The gate is an explicit flag raised by
 *    {@link beginCommandInterruptScope}, which `forwardSigtermToSigint()` calls
 *    at command start. It is deliberately NOT
 *    `process.listenerCount('SIGINT') > 0`, which was the first cut and is
 *    defeated by the very case it was meant to catch: `cdkd drift` runs
 *    `provider.update` at concurrency 4, and a concurrent CustomResource /
 *    CloudFront / ACM wait (`grep -rn "process.on('SIGINT'"
 *    src/provisioning/providers/` for the closed set — Route53's provider
 *    registers none) installs a TRANSIENT SIGINT listener of its own — so an ELBv2
 *    update starting inside that window saw a non-zero count, armed, and then
 *    kept the listener for the rest of the command after the transient one was
 *    removed. A count answers "is anyone listening right now"; the question is
 *    "does this COMMAND have a shutdown path", and only the command can say.
 *    (`forwardSigtermToSigint` itself registers on SIGTERM only, so it never
 *    satisfied the count either — a detail an earlier version of this comment
 *    got wrong, which is how the gap survived a review.)
 *
 *    Arming is re-attempted on every watch, so a wait that runs before the
 *    command opens its scope does not poison later ones.
 *
 * 4. **The handler force-quits when it is the LAST listener.** Property 3 gets
 *    the watch armed only under a command with a shutdown path, but that path
 *    is not live for the command's whole duration. The case that motivated it:
 *    `destroy.ts` registered no SIGINT handler of its own, and
 *    `destroy-runner.ts` removes its one in a `finally` — so between two stacks
 *    of a multi-stack destroy the shared handler was the ONLY listener. Merely
 *    latching there SWALLOWS the Ctrl-C: the process does not exit, `draining`
 *    is never set, `result.interrupted` stays false, and the loop proceeds to
 *    delete the NEXT stack after the user asked to stop — this file's own
 *    headline failure, one layer out.
 *
 *    Issue #2117 closed THAT instance from the command side: `destroy.ts` and
 *    `state.ts` now hold a command-scoped handler for their whole run
 *    (`watchCommandInterrupt`, `src/utils/interrupt-signals.ts`), so this
 *    handler is no longer last during a destroy and no longer fires there.
 *    That is the improvement rather than a loss — the force-quit exited 130
 *    with the lock stranded and without stopping the loop gracefully. Note the
 *    dependency runs BOTH ways: because this handler is a latch rather than a
 *    graceful owner, that watch must NOT treat its presence as "someone else
 *    will handle this" (it subtracts `interruptWatchListenerCount()` for
 *    exactly that reason), or the swallow above returns one window inward.
 *
 *    **That leaves this force-quit with NO population among today's commands,
 *    and it is worth being exact about why**, because the obvious guess — the
 *    commands that register no handler at all, `import` / `export` / `scrub` /
 *    `orphan` / `drift` / `state refresh-observed` — is wrong in a way an
 *    earlier version of this note shipped. Property 3 gates ARMING on the
 *    command scope, and those commands never open one (only
 *    `forwardSigtermToSigint()` does, and only `deploy` / `destroy` /
 *    `rollback` / `state destroy` call it), so this handler is never installed
 *    during them and cannot force-quit there. See the scope note below, which
 *    says the same thing from the lock's side and is what this contradicted.
 *    Among the four commands that DO open a scope, each holds a graceful
 *    SIGINT handler across the whole of it — `deploy.ts`'s top-level handler,
 *    `rollback.ts`'s (removed adjacent to, and synchronously with, its
 *    `unforwardSigterm()`), and now `watchCommandInterrupt` in both destroy
 *    commands — so `others.length` is never 0 while armed.
 *
 *    The branch is therefore a STRUCTURAL guarantee rather than a live code
 *    path: it becomes reachable again the moment a command opens the interrupt
 *    scope without holding a SIGINT handler across it, or an existing one tears
 *    its handler down before closing the scope. That is a one-line mistake in a
 *    command file, and the failure it produces — a swallowed Ctrl-C during a
 *    provider wait — is silent, which is exactly why the branch stays.
 *
 *    So when no other listener remains, the handler restores exactly what Node
 *    would have done with no listener at all. That is deliberately not a second
 *    graceful path: inventing one would duplicate `destroy-runner.ts`'s drain
 *    and have to be kept in sync with it, whereas "there is no graceful owner
 *    right now, so terminate" is true by construction and needs no upkeep.
 */

/**
 * Thrown by {@link InterruptWatch.onInterrupted}, and the ONE type the whole
 * codebase uses to mean "a wait stopped because the user asked us to stop".
 *
 * It has to be a distinct class rather than a bare `Error` because
 * `deploy-engine.ts` decides whether to ROLL BACK by asking what the failure
 * was. Its own `InterruptedError` is module-private, so a provider cannot
 * produce one; a bare `Error` from a provider therefore read as a genuine
 * resource failure and triggered an automatic rollback of the whole stack on
 * Ctrl-C — strictly worse than the unresponsiveness the threading removes.
 *
 * The explicit `setPrototypeOf` is not decoration: without it a subclass of
 * `Error` loses `instanceof` under this repo's compile target, which would make
 * {@link isInterruptedWaitError} silently answer `false`.
 */
export class InterruptedWaitError extends Error {
  constructor(what: string) {
    super(`${what} interrupted by user (SIGINT)`);
    this.name = 'InterruptedWaitError';
    Object.setPrototypeOf(this, InterruptedWaitError.prototype);
  }
}

/**
 * Whether `error` IS an interrupt, or WRAPS one.
 *
 * The wrap is the normal case, not the edge case: every provider catch under
 * `src/provisioning/providers/**` re-throws AWS failures as a
 * `ProvisioningError` threading the original as `cause` (issue #2040, enforced
 * by `vp run audit:provider-error-cause:check`), so by the time the engine sees
 * an interrupt it is one or more `cause` hops down. A plain `instanceof` check
 * at the engine would therefore have been a placebo.
 *
 * **The walk is bounded by a VISITED SET, not by a depth ceiling**, and the
 * difference decides correctness rather than style. A ceiling has to be sized
 * against the deepest real chain, and that chain GROWS: the flat case is 2 (the
 * provider's own wrap, then the command's), `DagExecutor` adds none — it
 * collects rather than wraps (`dag-executor.ts:178`) — but `deploy-engine.ts`
 * adds one `ProvisioningError` PER NESTED-STACK LEVEL (`deploy-engine.ts:2932`;
 * `NestedStackProvider.create` adds none of its own). A depth-5 cap therefore
 * missed at four levels of nesting, and missing here is not a degraded answer:
 * it is a full automatic rollback on Ctrl-C. The visited set gives the
 * termination the cap was really there for — a cyclic `cause` chain, which
 * would otherwise spin on the ERROR path where nothing else is watching —
 * without a ceiling any legitimate nest can cross.
 */
export function isInterruptedWaitError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (current instanceof InterruptedWaitError) return true;
    if (!(current instanceof Error)) return false;
    if (seen.has(current)) return false;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

export interface InterruptWatch {
  /** True once a SIGINT has been seen — including one seen BEFORE this watch started. */
  isInterrupted: () => boolean;
  /** The error to throw when {@link isInterrupted} is true. */
  onInterrupted: () => InterruptedWaitError;
  /** MUST be called from a `finally`; enforced by `scripts/check-withretry-interrupt.ts`. */
  dispose: () => void;
}

const liveWatches = new Set<{ interrupted: boolean }>();
let sharedSigintHandler: (() => void) | undefined;
let sigintLatched = false;

/**
 * Test seam for the "this command owns interrupt handling" gate and for the
 * force-quit in property 4.
 *
 * Production never assigns either, and neither condition may be weakened to
 * accommodate tests: a command without a shutdown path really must keep Node's
 * default terminate, and a swallowed Ctrl-C in a multi-stack destroy really is
 * a blocker. `cdkd drift --revert` is the live instance of the first. The second
 * was `cdkd destroy`, until issue #2117 gave both destroy commands a
 * command-scoped handler of their own — which leaves the force-quit with no
 * live population among today's commands at all. Property 4 works through why,
 * including why the commands that register no handler are NOT it: they never
 * open the interrupt scope, so this handler never arms for them. The seam is
 * what keeps the branch testable now that only a future command shape reaches
 * it.
 *
 * `commandOwnsInterrupts` exists because a provider suite never runs a COMMAND,
 * so every interrupt test would otherwise exercise the UNARMED path while
 * appearing to test the armed one — the worst of both, since it fails for a
 * reason unrelated to what the test claims. `forceQuit` exists because the real
 * one calls `process.exit`, which would take the test runner with it.
 */
export const interruptWatchTestSeam: {
  commandOwnsInterrupts?: () => boolean;
  forceQuit?: (code: number) => void;
} = {};

/**
 * How many command scopes are currently open.
 *
 * A COUNTER rather than a boolean, because a boolean is only correct while
 * scopes never overlap. The CLI runs one command per process so they do not
 * today — but this module's own contract offers itself to "a host that runs
 * more than one command", and under a boolean the inner scope's `end` would
 * remove the shared listener and clear the OUTER command's sticky latch
 * mid-run, so a signal landing in the re-arm gap goes unrecorded. That is
 * exactly what property 2 forbids, arrived at from the other direction.
 */
let commandInterruptScopeDepth = 0;

function commandOwnsInterrupts(): boolean {
  const override = interruptWatchTestSeam.commandOwnsInterrupts;
  if (override !== undefined) return override();
  return commandInterruptScopeDepth > 0;
}

/**
 * Install the ONE process listener, if and only if the running command has
 * declared that it owns interrupt handling. See property 3 for why the "if" is
 * load-bearing rather than defensive.
 *
 * Called on every `startInterruptWatch` rather than once, so a wait that runs
 * before the command opens its interrupt scope leaves the door open instead of
 * latching a permanent "unarmed".
 */
function armSharedSigintHandler(): void {
  if (sharedSigintHandler !== undefined) return;
  if (!commandOwnsInterrupts()) return;
  const handler = (): void => {
    sigintLatched = true;
    for (const live of liveWatches) live.interrupted = true;
    // Property 4. `handler` is compared by identity rather than counted from
    // outside, so this cannot mistake a second listener of its own for a
    // foreign one, and cannot fire while a command's graceful handler is live.
    const others = process.listeners('SIGINT').filter((l) => l !== handler);
    if (others.length === 0) {
      // The recovery line is unconditional, and deliberately hedged rather than
      // omitted. This handler cannot know whether a stack lock is held — it has
      // no command context — so the hint is a guess it cannot verify and cannot
      // afford to skip: it is the only thing between a user and a 30-minute TTL.
      // `destroy-runner.ts`'s own force-quit arms print a FULLY QUALIFIED
      // command (region / profile / bucket / prefix) since issue #2170; this
      // one deliberately stays a placeholder, because it has no command
      // context to qualify with. Do not "align" the two: a placeholder is
      // honest here, and inventing defaults would point the user at a
      // different lock object -- which is the harm #2170 closed.
      //
      // The window THIS handler could fire in with a lock held was
      // `destroy-runner.ts`'s `finally`, and reordering that block closed it.
      // `rollback.ts` had the same unregister-before-release window — reached
      // without this handler being involved at all, since its own SIGINT
      // handler was gone by then and Node's default terminate took the process
      // with the lock held — and issue #2118 closed that one the same way.
      //
      // Scope the resulting claim precisely, because two looser versions of it
      // were written here first and both were false. What holds is: no
      // lock-holding command THAT REGISTERS A SIGINT HANDLER unregisters it
      // before releasing, with `deploy-engine.ts` as the one deliberate
      // exception (`deploy.ts` holds a top-level handler outliving it, so the
      // set is never empty under its lock). It is NOT true that no stranding
      // window remains anywhere: `import` / `export` / `scrub` / `orphan` /
      // `drift` and `state refresh-observed` register no handler at all, so
      // each holds its lock with zero listeners for its ENTIRE duration — a
      // wider window than the one #2118 closed, and a different defect.
      process.stderr.write(
        '\nInterrupted.\n' +
          'If the next run reports a stack lock, release it with: cdkd force-unlock <stack-name>\n'
      );
      (interruptWatchTestSeam.forceQuit ?? ((code: number) => process.exit(code)))(130);
    }
  };
  sharedSigintHandler = handler;
  process.on('SIGINT', handler);
}

/**
 * Start a watch for ONE wait. `what` names the wait in the thrown message.
 *
 * The caller MUST `dispose()` in a `finally`. A leaked watch is not merely
 * untidy: it stays in {@link liveWatches} forever, and the sticky latch means
 * every wait after a Ctrl-C would keep aborting instantly even if the run
 * somehow continued.
 */
export function startInterruptWatch(what: string): InterruptWatch {
  armSharedSigintHandler();
  const state = { interrupted: sigintLatched };
  liveWatches.add(state);
  let disposed = false;
  return {
    isInterrupted: () => state.interrupted,
    onInterrupted: () => new InterruptedWaitError(what),
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      liveWatches.delete(state);
    },
  };
}

/**
 * Clear the sticky latch.
 *
 * Called by {@link beginCommandInterruptScope} and
 * {@link endCommandInterruptScope}, which bracket one command. On the CLI one
 * process runs one command, so the latch starts false regardless and those
 * calls are belt-and-braces; they earn their keep for a host that runs more
 * than one command, and for unit suites, where every test shares one process
 * and a simulated Ctrl-C would otherwise leak into every test after it.
 *
 * Deliberately NOT wired into `dispose()` — see property 2. That was the first
 * cut and it is precisely the bug: sequential waits always empty the live set
 * between them, so the latch cleared in every gap that mattered.
 */
export function resetInterruptWatchLatch(): void {
  sigintLatched = false;
  for (const live of liveWatches) live.interrupted = false;
}

/**
 * Declare that this command owns interrupt handling, and clear the latch.
 *
 * Called by `forwardSigtermToSigint()` (`src/utils/interrupt-signals.ts`),
 * which every command that reaches a provider wait through a lock invokes at
 * start — `deploy`, `destroy`, `rollback`, `state`. A command that does NOT
 * call it (`cdkd drift`) keeps Node's default terminate, which is the point.
 */
export function beginCommandInterruptScope(): void {
  commandInterruptScopeDepth += 1;
  // Only the OUTERMOST scope clears the latch. An inner one doing so would
  // erase an interrupt the outer command had already seen.
  if (commandInterruptScopeDepth === 1) resetInterruptWatchLatch();
}

/**
 * Close the scope — the command is done.
 *
 * Removing the shared listener HERE does not weaken property 2: what must never
 * happen is a teardown between two sequential WAITS, because a signal landing
 * in that gap would go unrecorded. At command end there is no next wait, and
 * leaving the listener installed would suppress default terminate for whatever
 * runs after.
 */
export function endCommandInterruptScope(): void {
  commandInterruptScopeDepth = Math.max(0, commandInterruptScopeDepth - 1);
  // Only the OUTERMOST close tears down. A nested command finishing must not
  // disarm the watch its caller is still relying on — that would reintroduce
  // property 2's bug (a signal in the re-arm gap goes unrecorded) through a
  // door property 2 does not watch.
  if (commandInterruptScopeDepth > 0) return;
  if (sharedSigintHandler !== undefined) {
    process.removeListener('SIGINT', sharedSigintHandler);
    sharedSigintHandler = undefined;
  }
  resetInterruptWatchLatch();
}

/**
 * How many process SIGINT listeners this module owns: 0 before arming, 1 after.
 *
 * Exported so a test can pin both polarities of property 3 without reaching
 * into module state or counting listeners it does not own.
 */
export function interruptWatchListenerCount(): number {
  return sharedSigintHandler === undefined ? 0 : 1;
}

/**
 * Remove the shared listener and forget every live watch — TEST ONLY.
 *
 * Production removes it only at command end ({@link endCommandInterruptScope}),
 * which makes arming effectively a one-way door inside a command — correct
 * there, and impossible for a unit suite, where the arming rule itself is what
 * several tests need to observe from a cold start.
 */
export function disarmInterruptWatchForTests(): void {
  commandInterruptScopeDepth = 0;
  endCommandInterruptScope();
  liveWatches.clear();
}
