/**
 * The signals a `cdkd local` command that owns containers tears them down on
 * (go-to-k/cdkd#6285).
 *
 * `run-task`, `invoke` and `invoke-agentcore` used to register their teardown
 * on SIGINT alone, so a SIGTERM — what `kill`, `timeout`, an IDE stop button,
 * a CI cancellation or a process supervisor sends — took Node's default
 * terminate: no `finally`, no `docker rm -f`, and for `run-task` a per-task
 * docker network left behind whose subnet then refused the next run.
 *
 * Each command hands ONE handler to {@link onShutdownSignals}, so SIGTERM
 * runs exactly the path SIGINT does and both share the command's own
 * repeated-signal escalation (a second signal of EITHER kind counts as the
 * second one). The handler is told which signal arrived so the exit code can
 * follow the shell convention, 128 + the signal number.
 *
 * This is NOT `forwardSigtermToSigint` (`interrupt-signals.ts`): that one opens
 * the provider-side interrupt scope for the commands that reach a provider
 * wait through a stack lock, and a forwarded SIGTERM exits as a SIGINT would.
 * A local command reaches no provider wait, and its exit code is the signal's
 * own. `cdkd local start-api` keeps its own handlers, which predate this
 * module and exit 0 on SIGTERM; the cdk-local engine commands (`start-service`,
 * `start-alb`, `start-cloudfront`, `start-agentcore`, `start-web-function`,
 * `start-microvm`) register SIGTERM inside cdk-local.
 */

/** A signal a local command shuts down on. */
export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

/** The exit code for a shutdown on `signal`: 128 + its number (SIGINT 2, SIGTERM 15). */
export function shutdownSignalExitCode(signal: ShutdownSignal): 130 | 143 {
  return signal === 'SIGINT' ? 130 : 143;
}

/**
 * Register `handler` on SIGINT and SIGTERM. Returns the function that removes
 * both registrations; call it where the command used to remove its SIGINT
 * listener.
 */
export function onShutdownSignals(handler: (signal: ShutdownSignal) => void): () => void {
  const onSigint = (): void => handler('SIGINT');
  const onSigterm = (): void => handler('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return (): void => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };
}
