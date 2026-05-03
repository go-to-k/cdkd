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
 * Resource provisioning timeout errors (per-resource wall-clock deadline).
 *
 * Thrown by `withResourceDeadline` when a single CREATE / UPDATE / DELETE
 * operation exceeds the user-configured `--resource-timeout`. The deploy
 * engine catches this, wraps it in {@link ProvisioningError}, and lets the
 * existing failure path (interrupt siblings → pre-rollback save → rollback
 * unless `--no-rollback`) take over.
 *
 * The message intentionally names the resource, type, region, elapsed time
 * and operation, plus how to override the default. Long-running providers
 * (e.g. Custom Resource: 1h polling cap) self-report their needed budget
 * via `getMinResourceTimeoutMs()`, so the user only needs a per-type
 * override (`--resource-timeout TYPE=DURATION`) when they want to bump a
 * specific non-self-reporting type or shorten a self-reported one.
 */
export class ResourceTimeoutError extends CdkdError {
  constructor(
    public readonly logicalId: string,
    public readonly resourceType: string,
    public readonly region: string,
    public readonly elapsedMs: number,
    public readonly operation: 'CREATE' | 'UPDATE' | 'DELETE',
    public readonly timeoutMs: number
  ) {
    const elapsedLabel = formatDuration(elapsedMs);
    const timeoutLabel = formatDuration(timeoutMs);
    super(
      `Resource ${logicalId} (${resourceType}) in ${region} timed out after ${timeoutLabel} during ${operation} (elapsed ${elapsedLabel}).\n` +
        'This may indicate a stuck Cloud Control polling loop, hung Custom Resource, or\n' +
        `slow ENI provisioning. Re-run with --resource-timeout ${resourceType}=<DURATION>\n` +
        'to bump the budget for this resource type only, or --verbose to see the\n' +
        'underlying provider activity.',
      'RESOURCE_TIMEOUT'
    );
    this.name = 'ResourceTimeoutError';
    Object.setPrototypeOf(this, ResourceTimeoutError.prototype);
  }
}

/**
 * Format a duration in milliseconds as a short human-readable label
 * (`30m`, `1h30m`, `45s`). Used by {@link ResourceTimeoutError} so the
 * error message stays compact.
 */
function formatDuration(ms: number): string {
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)}s`;
  }
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
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

/**
 * Context passed to {@link normalizeAwsError} so the rewritten message can
 * name the bucket/operation that produced the synthetic SDK error.
 */
export interface NormalizeAwsErrorContext {
  bucket?: string;
  operation?: string;
}

/**
 * Convert AWS SDK v3's synthetic `Unknown` / `UnknownError` exception into
 * an actionable `Error` keyed off `$metadata.httpStatusCode`.
 *
 * Background — why this helper exists:
 *   AWS SDK v3 produces a synthetic `name: 'Unknown'`, `message:
 *   'UnknownError'` exception when the protocol parser hits a HEAD response
 *   with an empty body. The most common trigger is `HeadBucket` against a
 *   bucket in a different region than the client (S3 returns 301
 *   PermanentRedirect with `x-amz-bucket-region` set, but the redirect
 *   middleware doesn't recover from the empty body). Surfacing the literal
 *   string `UnknownError` to users is uninformative.
 *
 * Behavior:
 *   - Non-AWS-SDK errors (anything where `name` is not `Unknown` and
 *     `message` is not `UnknownError`) pass through unchanged.
 *   - AWS SDK Unknown errors are mapped by HTTP status:
 *     - 301 → `Bucket '<name>' is in a different region…` (auto-resolved
 *       elsewhere; if this surfaces, it's a bug worth reporting).
 *     - 403 → `Access denied to bucket '<name>'.`
 *     - 404 → `Bucket '<name>' does not exist.`
 *     - other / unknown → `S3 error during <operation> on '<bucket>' (HTTP
 *       <status>).`
 */
export function normalizeAwsError(err: unknown, context: NormalizeAwsErrorContext = {}): Error {
  if (!(err instanceof Error)) {
    return new Error(String(err));
  }

  // Detect the AWS SDK v3 "Unknown" synthetic exception. Other errors pass
  // through unchanged so we don't accidentally rewrite a legitimate AWS
  // error message.
  const isUnknown = err.name === 'Unknown' || err.message === 'UnknownError';
  if (!isUnknown) return err;

  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  const status = meta?.httpStatusCode;
  const bucket = context.bucket ?? '<unknown bucket>';
  const operation = context.operation ?? 'operation';

  switch (status) {
    case 301: {
      // Try to surface the bucket's actual region from the response header
      // when the SDK exposes it. Header keys are lowercased by the SDK.
      const responseHeaders = (err as { $response?: { headers?: Record<string, string> } })
        .$response?.headers;
      const region =
        responseHeaders?.['x-amz-bucket-region'] ?? responseHeaders?.['X-Amz-Bucket-Region'];
      const where = region ? ` (in ${region})` : '';
      return new Error(
        `Bucket '${bucket}'${where} is in a different region than the client. ` +
          `cdkd resolves this automatically; if you see this message, please report it.`
      );
    }
    case 403:
      return new Error(
        `Access denied to bucket '${bucket}'. Verify credentials and bucket policy.`
      );
    case 404:
      return new Error(`Bucket '${bucket}' does not exist.`);
    default: {
      const statusStr = status !== undefined ? `HTTP ${status}` : 'unknown HTTP status';
      return new Error(
        `S3 error during ${operation} on '${bucket}' (${statusStr}). ` +
          `See CloudTrail for details.`
      );
    }
  }
}
