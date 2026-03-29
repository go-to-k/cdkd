import { getLogger } from './logger.js';

/**
 * Base error class for cdkd
 */
export class CdkdError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'CdkdError';
    Object.setPrototypeOf(this, CdkdError.prototype);
  }
}

/**
 * State management errors
 */
export class StateError extends CdkdError {
  constructor(message: string, cause?: Error) {
    super(message, 'STATE_ERROR', cause);
    this.name = 'StateError';
    Object.setPrototypeOf(this, StateError.prototype);
  }
}

/**
 * Lock acquisition errors
 */
export class LockError extends CdkdError {
  constructor(message: string, cause?: Error) {
    super(message, 'LOCK_ERROR', cause);
    this.name = 'LockError';
    Object.setPrototypeOf(this, LockError.prototype);
  }
}

/**
 * Synthesis errors
 */
export class SynthesisError extends CdkdError {
  constructor(message: string, cause?: Error) {
    super(message, 'SYNTHESIS_ERROR', cause);
    this.name = 'SynthesisError';
    Object.setPrototypeOf(this, SynthesisError.prototype);
  }
}

/**
 * Asset errors
 */
export class AssetError extends CdkdError {
  constructor(message: string, cause?: Error) {
    super(message, 'ASSET_ERROR', cause);
    this.name = 'AssetError';
    Object.setPrototypeOf(this, AssetError.prototype);
  }
}

/**
 * Resource provisioning errors
 */
export class ProvisioningError extends CdkdError {
  constructor(
    message: string,
    public readonly resourceType: string,
    public readonly logicalId: string,
    public readonly physicalId?: string,
    cause?: Error
  ) {
    super(message, 'PROVISIONING_ERROR', cause);
    this.name = 'ProvisioningError';
    Object.setPrototypeOf(this, ProvisioningError.prototype);
  }
}

/**
 * Dependency resolution errors
 */
export class DependencyError extends CdkdError {
  constructor(message: string, cause?: Error) {
    super(message, 'DEPENDENCY_ERROR', cause);
    this.name = 'DependencyError';
    Object.setPrototypeOf(this, DependencyError.prototype);
  }
}

/**
 * Configuration errors
 */
export class ConfigError extends CdkdError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONFIG_ERROR', cause);
    this.name = 'ConfigError';
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

/**
 * Check if error is a cdkd error
 */
export function isCdkdError(error: unknown): error is CdkdError {
  return error instanceof CdkdError;
}

/**
 * Format error for display
 */
export function formatError(error: unknown): string {
  if (isCdkdError(error)) {
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
