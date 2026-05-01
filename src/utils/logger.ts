import type { Logger, LogLevel } from '../types/config.js';
import { getLiveRenderer } from './live-renderer.js';
import { getCurrentStackOutputBuffer } from './stack-context.js';

/**
 * ANSI color codes
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
  constructor(
    private level: LogLevel = 'info',
    private useColors: boolean = true
  ) {}

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
  constructor(
    private readonly prefix: string,
    useColors: boolean
  ) {
    super('info', useColors);
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
