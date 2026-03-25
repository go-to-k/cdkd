import type { Logger, LogLevel } from '../types/config.js';

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
    const timestamp = formatTimestamp();
    const levelStr = level.toUpperCase().padEnd(5);
    const formattedArgs = args.length > 0 ? ' ' + args.map((a) => JSON.stringify(a)).join(' ') : '';

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

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      console.debug(this.formatMessage('debug', message, ...args));
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog('info')) {
      console.info(this.formatMessage('info', message, ...args));
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, ...args));
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message, ...args));
    }
  }

  /**
   * Set log level
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Create a child logger with a prefix
   */
  child(prefix: string): ConsoleLogger {
    const childLogger = new ConsoleLogger(this.level, this.useColors);
    const originalDebug = childLogger.debug.bind(childLogger);
    const originalInfo = childLogger.info.bind(childLogger);
    const originalWarn = childLogger.warn.bind(childLogger);
    const originalError = childLogger.error.bind(childLogger);

    childLogger.debug = (msg, ...args) => originalDebug(`[${prefix}] ${msg}`, ...args);
    childLogger.info = (msg, ...args) => originalInfo(`[${prefix}] ${msg}`, ...args);
    childLogger.warn = (msg, ...args) => originalWarn(`[${prefix}] ${msg}`, ...args);
    childLogger.error = (msg, ...args) => originalError(`[${prefix}] ${msg}`, ...args);

    return childLogger;
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
