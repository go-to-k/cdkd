/**
 * Run the CLI's `main()` so that a command can never exit 0 by accident.
 *
 * Node exits when its event loop has nothing left to wait on, even if an
 * awaited promise is still pending — and then with status 0. For a command
 * that means stopping mid-way with no error: `cdkd deploy` did so while
 * awaiting a DescribeType retry that slept on an unref'd timer, leaving the
 * stack lock held and the template unapplied (issue #3939). Whatever the next
 * such bug is, the guard below turns it into a failure the operator can see:
 * if the loop drains while `main()` is still pending, it prints why to stderr
 * and exits with its own status, {@link UNSETTLED_COMMAND_EXIT_CODE}.
 *
 * `beforeExit` fires only for a NATURAL exit (never for `process.exit()` or a
 * fatal signal), and only once the loop is empty, so it costs a command
 * nothing that finishes normally. A command that settles `main()` and lets the
 * loop drain is untouched: the promise has settled by then. Another
 * `beforeExit` listener that resumed `main()` would find the message already
 * printed; none exists in cdkd or its dependencies today.
 */

import { pasteableCommand } from '../utils/pasteable-command.js';

/**
 * The exit status of a command whose `main()` never settled: 70, `EX_SOFTWARE`
 * (sysexits.h, "internal software error"). It REPLACES any code the command
 * had already set, so a stall is never mistaken for a command's own verdict
 * (`cdkd diff` exits 1 on changes, for one) and never for success.
 */
export const UNSETTLED_COMMAND_EXIT_CODE = 70;

/** What an operator is told when the event loop drained under a pending command. */
export function unsettledCommandMessage(): string {
  return (
    'Error: cdkd stopped before the command finished: it was waiting on work that ' +
    'nothing could resume, so the process ran out of things to do. This is most ' +
    'likely a cdkd bug; please report it at https://github.com/go-to-k/cdkd/issues. ' +
    'The command did not complete, and anything after the point it stopped did not run.\n' +
    'If the command takes a stack lock, it may still be held: it expires at its TTL, ' +
    'or, once no other cdkd process is working on the stack, ' +
    `release it with: ${pasteableCommand('cdkd force-unlock', [{ hole: 'stack-name' }]).command}\n`
  );
}

/** The `code` of `CliUsageError` (`src/cli/arg-parser.ts`). */
export const CLI_USAGE_ERROR_CODE = 'cdkd.invalidArgument';

export function runCli(main: () => Promise<void>): void {
  let settled = false;
  const onBeforeExit = (): void => {
    // Once only: writing the message can schedule I/O, after which the loop
    // drains again and `beforeExit` fires a second time.
    process.off('beforeExit', onBeforeExit);
    if (settled) return;
    process.exitCode = UNSETTLED_COMMAND_EXIT_CODE;
    process.stderr.write(unsettledCommandMessage());
  };
  process.on('beforeExit', onBeforeExit);

  main().then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      // A usage error raised while commander parses an option value
      // (`CliUsageError`, go-to-k/cdkd#6251): its message is already
      // display-safe and complete, so print it like commander's own errors.
      // Matched by its code: importing the class would load commander before
      // `index.ts` answers a bare `--version`.
      const usage = error as { code?: unknown; message?: unknown; exitCode?: unknown } | null;
      if (
        usage?.code === CLI_USAGE_ERROR_CODE &&
        typeof usage.message === 'string' &&
        typeof usage.exitCode === 'number'
      ) {
        process.stderr.write(`${usage.message}\n`);
        process.exit(usage.exitCode);
      }
      console.error('Fatal error:', error);
      process.exit(1);
    }
  );
}
