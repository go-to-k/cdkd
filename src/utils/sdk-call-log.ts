/**
 * The SDK CALL LOG (state schema v12's measurement harness,
 * go-to-k/cdkd#4847 / #4852): with `CDKD_SDK_CALL_LOG=<file>` set, every AWS
 * SDK command a client built from `awsClientDefaults` sends is counted per
 * client and command, and the counts are written to `<file>` as JSON when the
 * process exits. Unset (the default), nothing is installed and nothing is
 * counted.
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
import { writeFileSync } from 'node:fs';

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
 * `{ logger }` for a client config when `CDKD_SDK_CALL_LOG` names a file, else
 * `undefined`. The first call installs the exit hook that writes the file.
 */
export function sdkCallLogConfig(): { logger: typeof CALL_LOG_LOGGER } | undefined {
  const target = process.env[SDK_CALL_LOG_ENV];
  if (target === undefined || target === '') return undefined;
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      try {
        writeFileSync(target, `${JSON.stringify(sdkCallCounts(), null, 2)}\n`);
      } catch {
        // A measurement aid: an unwritable path must not fail the command.
      }
    });
  }
  return { logger: CALL_LOG_LOGGER };
}
