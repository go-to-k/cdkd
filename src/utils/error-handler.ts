import { getLogger } from './logger.js';

/**
 * Base error class for cdkq
 */
export class CdkqError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'CdkqError';
    Object.setPrototypeOf(this, CdkqError.prototype);
  }
}

/**
 * State management errors
 */
export class StateError extends CdkqError {
  constructor(message: string, cause?: Error) {
    super(message, 'STATE_ERROR', cause);
    this.name = 'StateError';
  }
}

/**
 * Lock acquisition errors
 */
export class LockError extends CdkqError {
  constructor(message: string, cause?: Error) {
    super(message, 'LOCK_ERROR', cause);
    this.name = 'LockError';
  }
}

/**
 * Synthesis errors
 */
export class SynthesisError extends CdkqError {
  constructor(message: string, cause?: Error) {
    super(message, 'SYNTHESIS_ERROR', cause);
    this.name = 'SynthesisError';
  }
}

/**
 * Asset errors
 */
export class AssetError extends CdkqError {
  constructor(message: string, cause?: Error) {
    super(message, 'ASSET_ERROR', cause);
    this.name = 'AssetError';
  }
}

/**
 * Resource provisioning errors
 */
export class ProvisioningError extends CdkqError {
  constructor(
    message: string,
    public readonly resourceType: string,
    public readonly logicalId: string,
    public readonly physicalId?: string,
    cause?: Error
  ) {
    super(message, 'PROVISIONING_ERROR', cause);
    this.name = 'ProvisioningError';
  }
}

/**
 * Dependency resolution errors
 */
export class DependencyError extends CdkqError {
  constructor(message: string, cause?: Error) {
    super(message, 'DEPENDENCY_ERROR', cause);
    this.name = 'DependencyError';
  }
}

/**
 * Configuration errors
 */
export class ConfigError extends CdkqError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONFIG_ERROR', cause);
    this.name = 'ConfigError';
  }
}

/**
 * Check if error is a cdkq error
 */
export function isCdkqError(error: unknown): error is CdkqError {
  return error instanceof CdkqError;
}

/**
 * Format error for display
 */
export function formatError(error: unknown): string {
  if (isCdkqError(error)) {
    let message = `${error.name}: ${error.message}`;
    if (error.cause) {
      message += `\nCaused by: ${error.cause.message}`;
    }
    return message;
  }

  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

/**
 * Global error handler
 */
export function handleError(error: unknown): never {
  const logger = getLogger();
  logger.error(formatError(error));

  if (error instanceof Error && error.stack) {
    logger.debug('Stack trace:', error.stack);
  }

  process.exit(1);
}

/**
 * Wrap async function with error handling
 *
 * Note: Uses `any[]` for args to support Commander.js action handlers
 * which can have various parameter types
 */
export function withErrorHandling<Args extends unknown[], Return extends Promise<void> | void>(
  fn: (...args: Args) => Return
): (...args: Args) => Promise<void> {
  return async (...args: Args): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      handleError(error);
    }
  };
}
