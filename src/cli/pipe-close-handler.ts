/**
 * Exit cleanly when a downstream consumer closes our stdout/stderr early.
 *
 * Piping a cdkd command into a reader that stops reading — `cdkd state list |
 * grep -q foo`, `... | head`, `... | less` then `q` — closes the pipe while
 * cdkd is still writing. Node then emits an unhandled `'error'` (EPIPE) on the
 * stream and the process dies with a stack trace + non-zero exit. That is
 * normal Unix behavior for the *consumer* to stop reading, so the CLI must
 * treat it as success, not a crash. (Surfaced by the `remove-protection` integ,
 * whose `cdkd state list | grep -q` assertion crashed cdkd on EPIPE and the
 * test misread the non-zero exit as a stripped-state failure.)
 *
 * Installed once before any command runs so it covers every subcommand's
 * output, including long / streamed listings. Non-EPIPE stream errors are
 * re-thrown unchanged (they are real faults, not a closed pipe).
 */
export function installPipeCloseHandler(
  streams: NodeJS.WriteStream[] = [process.stdout, process.stderr],
  exit: (code: number) => never = process.exit
): void {
  for (const stream of streams) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      // Non-EPIPE stream errors are real faults — re-throw unchanged. Only a
      // closed-pipe EPIPE is treated as a clean exit. (Ordered this way so the
      // EPIPE branch is the final statement: in production `exit` terminates
      // the process, but an injected test double returns, and we must not fall
      // through to a throw afterwards.)
      if (err.code !== 'EPIPE') {
        throw err;
      }
      exit(0);
    });
  }
}
