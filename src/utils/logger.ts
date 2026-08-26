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
 * {@link reserveStdoutForPayload}. Today only `cdkd drift --json` does, so
 * no other command's output contract moves.
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
 * TEST-ONLY, like {@link releaseStdoutForPayload} and stated for the same
 * reason: there is no production caller, and an exported predicate with none
 * otherwise reads as a seam some command is expected to branch on. Nothing
 * should — the routing decision belongs to {@link ConsoleLogger.emit}, and a
 * caller re-deriving it would be a second place to keep in step.
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
   * {@link stdoutReservedForPayload} is set, so a `--json` payload is the only
   * thing on stdout.
   *
   * KNOWN GAP, latent and deliberately not restructured (issue
   * [#2230](https://github.com/go-to-k/cdkd/issues/2230)): the stack-output
   * buffer short-circuits ABOVE the reservation check, so a line captured under
   * `runStackBuffered` is replayed by whatever flushes the buffer and never
   * consults the reservation at all. Unreachable today — `deploy.ts` is the only
   * caller that opens a buffer and it has no `--json` mode — so the fix would be
   * untestable and would have to guess where the flush should route. It becomes
   * REAL the moment a `--json` command runs work inside `runStackBuffered`;
   * whoever does that must route the flush, not just call
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
