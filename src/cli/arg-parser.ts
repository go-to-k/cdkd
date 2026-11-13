import { CommanderError, InvalidArgumentError } from 'commander';

/**
 * Wrap an option's `argParser` so a rejected value is a usage error
 * (go-to-k/cdkd#6251).
 *
 * Commander renders an `InvalidArgumentError` thrown from a parser as
 * `error: option '--x <v>' argument 'bad' is invalid. <message>` and exits 1.
 * Any other error escapes the parse to the top-level handler, which prints
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
      throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
    }
  };
}

/**
 * `argParser` for a count option such as `--concurrency`: a positive whole
 * number, written in digits. `parseInt` alone turned `bogus` into `NaN`,
 * which failed much later (or not at all) instead of at the flag.
 */
export function parsePositiveIntegerOption(value: string): number {
  const trimmed = value.trim();
  const n = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(n) || n < 1) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }
  return n;
}
