/**
 * The SDK CALL LOG (state schema v12's measurement harness,
 * go-to-k/cdkd#4847 / #4852): with `CDKD_SDK_CALL_LOG=<file>` set, every AWS
 * SDK command a client built from `awsClientDefaults` sends is counted per
 * client and command, and ONE JSON line is APPENDED to `<file>` when the
 * process exits: `{ pid, argv, at, counts }`. Appended, so a script running
 * several cdkd processes against one file keeps a line per process. `argv` is
 * the command line with every flag VALUE dropped (flag names and the leading
 * positional arguments are kept), so no parameter value or secret passed on
 * the command line is written. Unset (the default), nothing is installed and
 * nothing is counted.
 *
 * It rides the SDK's own logger middleware: a client config's `logger` is
 * called once per command (outside the retry loop, so a retried call counts
 * once) with `clientName` / `commandName`, on success (`info`) and on failure
 * (`error`). Only those two names are read; the input / output the middleware
 * passes are dropped unread. The other levels stay no-ops, as a client without
 * a logger has them.
 *
 * This module sits in the import closure `scripts/audit-provider-coverage.ts`
 * resolves the way `node` does, so it imports nothing relative.
 */
import { appendFileSync } from 'node:fs';

/** The environment variable naming the file the counts are written to. */
export const SDK_CALL_LOG_ENV = 'CDKD_SDK_CALL_LOG';

/** client name -> command name -> count. Nested, so no composite key is built. */
const counts = new Map<string, Map<string, number>>();
let exitHookInstalled = false;

function record(entry: unknown): void {
  if (entry === null || typeof entry !== 'object') return;
  const { clientName, commandName } = entry as { clientName?: unknown; commandName?: unknown };
  const client = typeof clientName === 'string' ? clientName : '?';
  const command = typeof commandName === 'string' ? commandName : '?';
  let perClient = counts.get(client);
  if (perClient === undefined) {
    perClient = new Map();
    counts.set(client, perClient);
  }
  perClient.set(command, (perClient.get(command) ?? 0) + 1);
}

/** The counts so far as `{ "<client>.<command>": n }`, sorted (SDK names hold no `.`). */
export function sdkCallCounts(): Record<string, number> {
  const rows: Array<[string, number]> = [];
  for (const [client, perClient] of counts) {
    for (const [command, n] of perClient) rows.push([[client, command].join('.'), n]);
  }
  return Object.fromEntries(rows.sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Clear the counts (tests). */
export function resetSdkCallCounts(): void {
  counts.clear();
}

const noop = (..._args: unknown[]): void => {};

/** The logger a client config carries while the call log is on. A plain object, as the SDK expects. */
const CALL_LOG_LOGGER = {
  trace: noop,
  debug: noop,
  info: (...args: unknown[]): void => record(args[0]),
  warn: noop,
  error: (...args: unknown[]): void => record(args[0]),
};

/**
 * `argv` (the arguments after the script) with every flag VALUE dropped:
 * a flag token keeps only its name ({@link flagName}), and once a flag appears every following
 * non-flag token is dropped, since without the command's option table a
 * flag's value cannot be told from a positional. The leading positionals (the
 * subcommand and stack names) are kept. Lossy in the safe direction: a value
 * is never kept.
 */
export function sanitizedArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  let afterFlag = false;
  for (const arg of argv) {
    if (arg.startsWith('-') && arg !== '-') {
      afterFlag = true;
      const name = flagName(arg);
      if (name !== undefined) out.push(name);
    } else if (!afterFlag) {
      out.push(arg);
    }
  }
  return out;
}

/**
 * A flag token's NAME, or `undefined` when none is safe to keep: `--name` /
 * `--name=value` keep `--name` when it is a plain option name; a single-dash
 * token keeps only `-x`, since a short option may carry its value attached
 * (`-anode app.js`, `-ckey=value`) or bundle another short option.
 */
function flagName(arg: string): string | undefined {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    return /^--[A-Za-z][A-Za-z0-9-]*$/.test(name) ? name : undefined;
  }
  return /^-[A-Za-z]/.test(arg) ? arg.slice(0, 2) : undefined;
}

/** The one line a process appends: pid, sanitized argv, ISO time, counts. */
export function sdkCallLogLine(): string {
  return `${JSON.stringify({
    pid: process.pid,
    argv: sanitizedArgv(process.argv.slice(2)),
    at: new Date().toISOString(),
    counts: sdkCallCounts(),
  })}\n`;
}

/**
 * `{ logger }` for a client config when `CDKD_SDK_CALL_LOG` names a file, else
 * `undefined`. The first call installs the exit hook that appends the line.
 */
export function sdkCallLogConfig(): { logger: typeof CALL_LOG_LOGGER } | undefined {
  const target = process.env[SDK_CALL_LOG_ENV];
  if (target === undefined || target === '') return undefined;
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      try {
        appendFileSync(target, sdkCallLogLine());
      } catch {
        // A measurement aid: an unwritable path must not fail the command.
      }
    });
  }
  return { logger: CALL_LOG_LOGGER };
}
