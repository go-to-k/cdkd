import type { Logger, LogLevel } from '../types/config.js';
import { getLiveRenderer } from './live-renderer.js';
import { getCurrentStackOutputBuffer } from './stack-context.js';

/**
 * ANSI color codes
 *
 * Kept internal — `ConsoleLogger.formatMessage` references these for the
 * verbose/compact mode level prefixes. For inline color wrapping in
 * production code, import from `./colors.js` instead (which lives in a
 * separate module so unit tests that mock `logger.ts` don't strip color
 * helpers as a side effect).
 */
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

/**
 * Whether stdout has been claimed by a machine-readable payload.
 *
 * Issue [#2230](https://github.com/go-to-k/cdkd/issues/2230). `info` and
 * `debug` resolve to `console.info` / `console.debug`, which write to
 * STDOUT — the same stream a `--json` command prints its payload on. A
 * command whose remediation path logs a status line therefore hands a pipe
 * consumer prose wrapped around the document, and the failure is silent in
 * the worst direction: the human sees correct-looking output while the
 * parser sees a syntax error, or succeeds against a truncated read.
 *
 * MODULE-LEVEL rather than an instance field on purpose. The decision is a
 * property of the PROCESS's stdout, not of one logger object: `child()`
 * hands out fresh {@link ChildLogger} instances (`role-arn`, the state
 * backend, ...) that would each need the flag set individually, and those
 * are exactly the loggers a command cannot reach from its own file.
 *
 * OPT-IN, and deliberately not derived from a `--json` flag inside the
 * logger: nothing changes for a command that does not call
 * {@link reserveStdoutForPayload}. Every `--json` surface keeps its payload
 * stream clean one way or the other, but NOT all by this mechanism, and the
 * count is easy to state one short: SEVEN call this — `cdkd drift`'s original
 * call, plus the six issue
 * [#2280](https://github.com/go-to-k/cdkd/issues/2280) added to it (`cdkd
 * list`, `cdkd events`, and the four `cdkd state {list,resources,show,info}`
 * subcommands) — while `cdkd diff` predates the mechanism and demotes the
 * logger to `warn` instead, which SUPPRESSES its info-level lines rather than
 * moving them. Do not read "every `--json` surface" as "every `--json`
 * surface calls this".
 *
 * A `--json` flag is NOT what makes a stream a payload stream, though, and
 * issue [#2410](https://github.com/go-to-k/cdkd/issues/2410) is the four
 * commands where it is not involved at all: `cdkd synth` (the template),
 * `cdkd list` in EVERY mode (the YAML and the one-id-per-line spellings, not
 * just `--json`), `cdkd local invoke` (the function response) and
 * `cdkd local invoke-agentcore` (the agent response). Those call it
 * UNCONDITIONALLY at command entry, so for them the DEFAULT human output
 * contract is the one that moved — deliberately, and documented per command
 * in `docs/cli-reference.md`. What has NOT changed is that the decision stays
 * with the command: a command whose stdout is a human surface (`cdkd deploy`,
 * `cdkd local start-api`, `cdkd local run-task`) still never calls this.
 */
let stdoutReservedForPayload = false;

/**
 * Claim stdout for a machine-readable payload: `info` / `debug` lines route
 * to stderr for the rest of the process.
 *
 * The lines are MOVED, not dropped. An operator watching a terminal still
 * sees every status line; only the byte stream a pipe reads changes.
 */
export function reserveStdoutForPayload(): void {
  stdoutReservedForPayload = true;
}

/**
 * Hand stdout back. Exists for tests — the CLI runs one command per process
 * and never releases the reservation.
 */
export function releaseStdoutForPayload(): void {
  stdoutReservedForPayload = false;
}

/**
 * Whether {@link reserveStdoutForPayload} is in effect.
 *
 * ONE production caller, and the carve-out is narrow enough to state: a
 * writer that does NOT go through {@link ConsoleLogger} and therefore cannot
 * be routed by {@link ConsoleLogger.emit}. Today that is `spawnStreaming` in
 * `src/utils/docker-cmd.ts`, which mirrors a child process's stdout live
 * under `--verbose`; issue
 * [#2410](https://github.com/go-to-k/cdkd/issues/2410) made it join the
 * logger on stderr while a command holds the reservation.
 *
 * That is the ONLY shape this predicate is for. A COMMAND must never branch
 * on it — a command's own prose already flows through the logger, so
 * consulting this would be a second copy of a decision `emit` already makes,
 * and the two would drift. If you are reaching for it from a `commands/`
 * file, the answer is `reserveStdoutForPayload()` instead.
 *
 * Also used by tests, alongside {@link releaseStdoutForPayload}.
 */
export function isStdoutReservedForPayload(): boolean {
  return stdoutReservedForPayload;
}

/**
 * Format timestamp
 */
function formatTimestamp(): string {
  const now = new Date();
  return now.toISOString();
}

/**
 * Console logger implementation
 *
 * Supports two output modes:
 * - verbose (debug level): timestamps, module prefixes, all details
 * - compact (info level): clean output without timestamps or prefixes
 */
export class ConsoleLogger implements Logger {
  private level: LogLevel;
  private useColors: boolean;

  constructor(level: LogLevel = 'info', useColors: boolean = true) {
    this.level = level;
    this.useColors = useColors;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const currentLevelIndex = levels.indexOf(this.level);
    const messageLevelIndex = levels.indexOf(level);
    return messageLevelIndex >= currentLevelIndex;
  }

  private formatMessage(level: LogLevel, message: string, ...args: unknown[]): string {
    const formattedArgs = args.length > 0 ? ' ' + args.map((a) => JSON.stringify(a)).join(' ') : '';

    // Verbose mode: full timestamps and level
    if (this.level === 'debug') {
      const timestamp = formatTimestamp();
      const levelStr = level.toUpperCase().padEnd(5);

      if (this.useColors) {
        const levelColor = {
          debug: colors.gray,
          info: colors.blue,
          warn: colors.yellow,
          error: colors.red,
        }[level];

        return `${colors.dim}${timestamp}${colors.reset} ${levelColor}${levelStr}${colors.reset} ${message}${formattedArgs}`;
      }

      return `${timestamp} ${levelStr} ${message}${formattedArgs}`;
    }

    // Compact mode: clean output
    if (this.useColors) {
      if (level === 'error') {
        return `${colors.red}${message}${formattedArgs}${colors.reset}`;
      }
      if (level === 'warn') {
        return `${colors.yellow}${message}${formattedArgs}${colors.reset}`;
      }
      return `${message}${formattedArgs}`;
    }

    return `${message}${formattedArgs}`;
  }

  /**
   * Route a formatted log line. When a per-stack output buffer is active in
   * the current async context (parallel multi-stack deploy), capture the
   * line into the buffer so it can be flushed as one atomic block when the
   * stack finishes. Otherwise fall through to the live renderer / console
   * as before.
   *
   * `warn` / `error` already go to stderr via `console.warn` / `console.error`.
   * `info` / `debug` go to stdout — and JOIN them on stderr while
   * {@link stdoutReservedForPayload} is set, so the reserving command's payload
   * is the only thing on stdout.
   *
   * KNOWN GAP, latent and deliberately not restructured (issues
   * [#2230](https://github.com/go-to-k/cdkd/issues/2230) and
   * [#2410](https://github.com/go-to-k/cdkd/issues/2410)): the stack-output
   * buffer short-circuits ABOVE the reservation check, so a line captured under
   * `runStackBuffered` is replayed by whatever flushes the buffer and never
   * consults the reservation at all. Unreachable today — `deploy.ts`'s
   * `runStackBuffered` call is the only thing that opens a buffer, and `deploy`
   * reserves nothing (its stdout is a human surface); a bare line number here
   * would go stale on the next edit to that file without anything noticing — so the fix would be untestable and would have to guess
   * where the flush should route.
   *
   * That rationale survives #2410 unchanged, and it is worth restating WHY,
   * because #2410 widened the reserving population from a `--json`-only set to
   * one that includes commands with no flag at all. The four it added —
   * `cdkd synth`, `cdkd list`, `cdkd local invoke`,
   * `cdkd local invoke-agentcore` — run NO work inside `runStackBuffered`:
   * buffering exists for the parallel multi-stack deploy path, which none of
   * them enters. So the gap stays latent, and the condition for it becoming
   * REAL is unchanged in substance but wider in reach: it is no longer "a
   * `--json` command runs work inside `runStackBuffered`" but "ANY reserving
   * command does". Whoever does that must route the flush, not just call
   * {@link reserveStdoutForPayload}.
   */
  private emit(level: LogLevel, formatted: string): void {
    const buffer = getCurrentStackOutputBuffer();
    if (buffer) {
      buffer.lines.push(formatted);
      return;
    }
    getLiveRenderer().printAbove(() => {
      if (level === 'error') console.error(formatted);
      else if (level === 'warn') console.warn(formatted);
      else if (stdoutReservedForPayload) console.error(formatted);
      else if (level === 'info') console.info(formatted);
      else console.debug(formatted);
    });
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      this.emit('debug', this.formatMessage('debug', message, ...args));
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog('info')) {
      this.emit('info', this.formatMessage('info', message, ...args));
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      this.emit('warn', this.formatMessage('warn', message, ...args));
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog('error')) {
      this.emit('error', this.formatMessage('error', message, ...args));
    }
  }

  /**
   * Set log level
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  /**
   * Create a child logger with a prefix
   *
   * In verbose mode, prefix is shown as [Prefix]. In compact mode, prefix is hidden.
   */
  child(prefix: string): ChildLogger {
    return new ChildLogger(prefix, this.useColors);
  }
}

/**
 * Child logger that always syncs level from global logger
 */
class ChildLogger extends ConsoleLogger {
  private readonly prefix: string;

  constructor(prefix: string, useColors: boolean) {
    super('info', useColors);
    this.prefix = prefix;
  }

  private syncLevel(): void {
    if (globalLogger) {
      this.setLevel(globalLogger.getLevel());
    }
  }

  override debug(message: string, ...args: unknown[]): void {
    this.syncLevel();
    super.debug(`[${this.prefix}] ${message}`, ...args);
  }

  override info(message: string, ...args: unknown[]): void {
    this.syncLevel();
    const msg = this.getLevel() === 'debug' ? `[${this.prefix}] ${message}` : message;
    super.info(msg, ...args);
  }

  override warn(message: string, ...args: unknown[]): void {
    this.syncLevel();
    const msg = this.getLevel() === 'debug' ? `[${this.prefix}] ${message}` : message;
    super.warn(msg, ...args);
  }

  override error(message: string, ...args: unknown[]): void {
    this.syncLevel();
    const msg = this.getLevel() === 'debug' ? `[${this.prefix}] ${message}` : message;
    super.error(msg, ...args);
  }
}

/**
 * Global logger instance
 */
let globalLogger: ConsoleLogger | null = null;

/**
 * Get or create global logger
 */
export function getLogger(): ConsoleLogger {
  if (!globalLogger) {
    globalLogger = new ConsoleLogger();
  }
  return globalLogger;
}

/**
 * Set global logger instance
 */
export function setLogger(logger: ConsoleLogger): void {
  globalLogger = logger;
}
