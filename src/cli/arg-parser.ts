import { CommanderError, InvalidArgumentError } from 'commander';
import { displayIdent, displaySafe } from '../utils/display-safe.js';
import { CLI_USAGE_ERROR_CODE } from './run-cli.js';

/**
 * A rejected option value whose raw text is not safe to print
 * (go-to-k/cdkd#6251, #2438). Commander's own `InvalidArgumentError`
 * rendering echoes the raw argument (`argument '<raw>' is invalid`), so a
 * value that carries a control byte takes this route instead: commander
 * rethrows any other error from a parser unchanged, and `runCli` prints a
 * `CommanderError`'s message and exits with its code, without a stack trace.
 */
export class CliUsageError extends CommanderError {
  constructor(message: string) {
    super(1, CLI_USAGE_ERROR_CODE, message);
    this.name = 'CliUsageError';
  }
}

/**
 * Wrap an option's `argParser` so a rejected value is a usage error
 * (go-to-k/cdkd#6251).
 *
 * Commander renders an `InvalidArgumentError` thrown from a parser as
 * `error: option '--x <v>' argument 'bad' is invalid. <message>` and exits 1.
 * Any other error escaped the parse to the top-level handler, which printed
 * `Fatal error:` with a stack trace through commander's internals. The
 * wrapped parsers stay plain functions throwing `Error`, so their direct
 * callers and tests are unchanged.
 */
export function cliArgParser<T, P>(
  parse: (value: string, previous: P) => T
): (value: string, previous: P) => T {
  return (value, previous) => {
    try {
      return parse(value, previous);
    } catch (error) {
      if (error instanceof CommanderError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (displaySafe(value) === value) throw new InvalidArgumentError(message);
      throw new CliUsageError(`error: ${displaySafe(message)}`);
    }
  };
}

/**
 * `argParser` for a count option such as `--concurrency`: a positive whole
 * number, written in digits. `parseInt` alone turned `bogus` into `NaN`,
 * which failed much later (or not at all) instead of at the flag.
 */
export const parsePositiveIntegerOption = cliArgParser((value: string): number => {
  const trimmed = value.trim();
  const n = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(n) || n < 1) {
    throw new Error(`Expected a positive integer, got ${displayIdent(value)}.`);
  }
  return n;
});
