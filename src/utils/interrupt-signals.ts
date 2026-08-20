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
