import { getLogger } from './logger.js';

/**
 * Base error class for cdkd
 */
export class CdkdError extends Error {
  public readonly code: string;
  public readonly cause: Error | undefined;

  constructor(message: string, code: string, cause?: Error) {
    super(message);
    this.code = code;
    this.cause = cause;
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
 * Local-invoke `docker build` failures.
 *
 * Surfaces the stderr captured from `docker build` so the user can
 * re-run the same command directly to debug Dockerfile syntax errors
 * or missing build context. Used by `src/local/docker-image-builder.ts`
 * (PR 5) for container Lambdas; the parallel `AssetError` covers the
 * `cdkd publish-assets` / `cdkd deploy` build path. Kept distinct from
 * `AssetError` so `cdkd local invoke` failures don't show up under the
 * "asset" error class.
 */
export class LocalInvokeBuildError extends CdkdError {
  constructor(message: string, cause?: Error) {
    super(message, 'LOCAL_INVOKE_BUILD_ERROR', cause);
    this.name = 'LocalInvokeBuildError';
    Object.setPrototypeOf(this, LocalInvokeBuildError.prototype);
  }
}

/**
 * Resource provisioning errors
 */
export class ProvisioningError extends CdkdError {
  public readonly resourceType: string;
  public readonly logicalId: string;
  public readonly physicalId: string | undefined;

  constructor(
    message: string,
    resourceType: string,
    logicalId: string,
    physicalId?: string,
    cause?: Error
  ) {
    super(message, 'PROVISIONING_ERROR', cause);
    this.resourceType = resourceType;
    this.logicalId = logicalId;
    this.physicalId = physicalId;
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
  public readonly logicalId: string;
  public readonly resourceType: string;
  public readonly region: string;
  public readonly elapsedMs: number;
  public readonly operation: 'CREATE' | 'UPDATE' | 'DELETE';
  public readonly timeoutMs: number;

  constructor(
    logicalId: string,
    resourceType: string,
    region: string,
    elapsedMs: number,
    operation: 'CREATE' | 'UPDATE' | 'DELETE',
    timeoutMs: number
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
    this.logicalId = logicalId;
    this.resourceType = resourceType;
    this.region = region;
    this.elapsedMs = elapsedMs;
    this.operation = operation;
    this.timeoutMs = timeoutMs;
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
 * Signals a partial-failure outcome that should map to exit code 2 (not 1).
 *
 * Used by `cdkd destroy` and `cdkd state destroy` when one or more
 * per-resource deletes failed but the overall command finished its work
 * (state.json is preserved, the rest of the stack was deleted, and the
 * user can re-run to clean up the remaining resources).
 *
 * Exit code conventions:
 *   - 0: command completed successfully, no resources left in error state.
 *   - 1: command-level failure (auth error, bad arguments, synth crash,
 *        unhandled exception). Default for any thrown error.
 *   - 2: partial failure — work completed but some resources are still in
 *        an error state. Re-running typically resolves it. Documented in
 *        README's "Exit codes" section.
 *
 * `handleError` recognizes this class via `instanceof` and uses its
 * `exitCode` instead of the default 1.
 */
export class PartialFailureError extends CdkdError {
  readonly exitCode: number = 2;

  constructor(message: string, cause?: Error) {
    super(message, 'PARTIAL_FAILURE', cause);
    this.name = 'PartialFailureError';
    Object.setPrototypeOf(this, PartialFailureError.prototype);
  }
}

/**
 * Signals that a provider cannot perform an in-place `update` for a
 * resource type — most commonly because the AWS resource is structurally
 * immutable (`AWS::Lambda::LayerVersion`, `AWS::S3Tables::TableBucket` once
 * created, certain `AWS::EC2::*` sub-resources) or because the provider
 * surfaces a sub-resource attachment whose only mutation pattern is
 * delete + add (Lambda permission statements, IAM policy attachments).
 *
 * Surfaced through `cdkd drift --revert`, which calls
 * `provider.update(logicalId, physicalId, type, stateProps, awsProps)` to
 * push cdkd state values back into AWS for every drifted resource. When a
 * provider throws this error, the drift command collects it as a
 * per-resource outcome distinct from a generic AWS update failure: the
 * fix is to re-deploy with `--replace` (or recreate the resource), not to
 * retry the update.
 *
 * Carries the same `exitCode = 2` as {@link PartialFailureError} so a
 * drift run that hits one immutable resource is reported as partial-
 * success rather than fatal — the rest of the drifted resources still
 * had their `update` invoked, and the user has a clear next step printed
 * for the unsupported one.
 */
export class ResourceUpdateNotSupportedError extends CdkdError {
  readonly exitCode: number = 2;
  public readonly resourceType: string;
  public readonly logicalId: string;
  /**
   * Human-readable hint printed alongside the error. The default is
   * "use cdkd deploy with --replace, or change the resource definition
   * to create a new version" — providers are encouraged to override
   * with a more specific suggestion when one is available (e.g.
   * Lambda::Permission's "delete + add a new statement").
   */
  public readonly suggestion: string | undefined;

  constructor(resourceType: string, logicalId: string, suggestion?: string, cause?: Error) {
    const tail = suggestion
      ? suggestion
      : 'use cdkd deploy with --replace, or change the resource definition to create a new version';
    super(
      `${resourceType} (${logicalId}) cannot be updated in place: ${tail}.`,
      'RESOURCE_UPDATE_NOT_SUPPORTED',
      cause
    );
    this.resourceType = resourceType;
    this.logicalId = logicalId;
    this.suggestion = suggestion;
    this.name = 'ResourceUpdateNotSupportedError';
    Object.setPrototypeOf(this, ResourceUpdateNotSupportedError.prototype);
  }
}

/**
 * Signals a refusal to destroy a stack whose CDK manifest has
 * `terminationProtection: true`.
 *
 * Surfaced from `cdkd destroy <stack>` / `cdkd destroy --all` BEFORE
 * any lock acquisition or per-resource delete. In multi-stack runs
 * (e.g. `--all`) this counts as a per-stack failure and the rest of
 * the targets continue — the aggregated count is wrapped in
 * {@link PartialFailureError} so the command exits with code 2.
 *
 * The bypass workflow is documented in the message: edit the CDK code
 * (`new Stack(app, '...', { terminationProtection: false })`),
 * redeploy, then retry the destroy. A future `--remove-protection`
 * flag (separate scope) will provide an explicit one-shot bypass.
 *
 * Note: `cdkd state destroy` (state-only, no synth) does NOT honor
 * `terminationProtection` — the flag is a CDK property not persisted
 * in cdkd's state.json. Use `cdkd destroy` when synth is available.
 */
export class StackTerminationProtectionError extends CdkdError {
  public readonly stackName: string;

  constructor(stackName: string, cause?: Error) {
    super(
      `Stack '${stackName}' has terminationProtection: true and cannot be destroyed. ` +
        `Set terminationProtection: false in the CDK code, redeploy, then retry 'cdkd destroy ${stackName}'.`,
      'STACK_TERMINATION_PROTECTION',
      cause
    );
    this.stackName = stackName;
    this.name = 'StackTerminationProtectionError';
    Object.setPrototypeOf(this, StackTerminationProtectionError.prototype);
  }
}

/**
 * One consumer that still references the producer being destroyed via
 * `Fn::ImportValue`. Surfaced inside {@link StackHasActiveImportsError}.
 */
export interface ActiveImportConsumer {
  consumerStack: string;
  consumerRegion: string;
  exportName: string;
}

/**
 * `cdkd destroy <producer>` refused because at least one consumer stack
 * still records an `Fn::ImportValue` reference to one of the producer's
 * outputs. This matches CloudFormation's strong-reference semantics —
 * CFn rejects `DeleteStack` for an exporter while an importer exists.
 *
 * cdkd has no `--force` escape hatch for this (intentionally, mirroring
 * CFn). The error message lists every offending consumer and points the
 * user at the two valid resolution paths:
 *
 *  1. Destroy the consumer first: `cdkd destroy <consumer>`
 *  2. Remove the `Fn::ImportValue` from the consumer's template and
 *     redeploy, then retry the producer destroy.
 *
 * Weak-reference consumers (`Fn::GetStackOutput`, cdkd-specific) never
 * trigger this error by design — the producer stays deletable
 * independently of consumers when the user intentionally chose a weak
 * reference at template-authoring time.
 *
 * Exit code 2 (same as `PartialFailureError`) so multi-stack `cdkd
 * destroy --all` runs that partially succeed still surface as
 * non-zero without being indistinguishable from a fatal cdkd error.
 */
export class StackHasActiveImportsError extends CdkdError {
  readonly exitCode: number = 2;
  public readonly producerStack: string;
  public readonly producerRegion: string;
  public readonly consumers: ActiveImportConsumer[];

  constructor(
    producerStack: string,
    producerRegion: string,
    consumers: ActiveImportConsumer[],
    cause?: Error
  ) {
    const lines = consumers.map(
      (c) => `  - ${c.consumerStack} (${c.consumerRegion}): imports export '${c.exportName}'`
    );
    super(
      `Cannot destroy stack '${producerStack}' (${producerRegion}): ` +
        `the following stacks still import its outputs via Fn::ImportValue:\n` +
        `${lines.join('\n')}\n\n` +
        `This matches CloudFormation's strong-reference semantics — exports are\n` +
        `protected as long as a consumer references them.\n\n` +
        `To proceed:\n` +
        `  1. Destroy the consumer first: cdkd destroy <consumer-stack>\n` +
        `  2. Or remove the Fn::ImportValue from the consumer's template\n` +
        `     (e.g. inline the value, or refactor) and re-deploy the consumer,\n` +
        `     then retry this destroy.\n\n` +
        `Note: cdkd's Fn::GetStackOutput intrinsic is a weak alternative that\n` +
        `does NOT protect the producer — use it when you intentionally want\n` +
        `the producer to be deletable independently of consumers.`,
      'STACK_HAS_ACTIVE_IMPORTS',
      cause
    );
    this.producerStack = producerStack;
    this.producerRegion = producerRegion;
    this.consumers = consumers;
    this.name = 'StackHasActiveImportsError';
    Object.setPrototypeOf(this, StackHasActiveImportsError.prototype);
  }
}

/**
 * Signals that `cdkd local start-api`'s route discovery hit an unsupported
 * shape — non-AWS_PROXY integration, ApiGwV2 service integration
 * (`IntegrationSubtype` set), WebSocket protocol, Lambda::Url with
 * `AuthType !== 'NONE'`, or an unsupported intrinsic function in
 * `IntegrationUri`. (Lambda::Url with `InvokeMode: RESPONSE_STREAM` is
 * a normal route dispatched via the streaming protocol — #467.)
 *
 * The message names every offending route and points the user at the
 * deferred follow-up PR (8b for authorizers, etc.). Hard-error at
 * discovery so the server never starts in a half-working state.
 */
export class RouteDiscoveryError extends CdkdError {
  constructor(message: string, cause?: Error) {
    super(message, 'ROUTE_DISCOVERY_ERROR', cause);
    this.name = 'RouteDiscoveryError';
    Object.setPrototypeOf(this, RouteDiscoveryError.prototype);
  }
}

/**
 * Signals an unrecoverable failure inside `cdkd local start-api`'s HTTP
 * server — port-binding failure, RIE returned malformed JSON, container
 * pool acquire timed out, etc. Distinct from {@link RouteDiscoveryError}
 * which fires before the server starts.
 */
export class StartApiServerError extends CdkdError {
  constructor(message: string, cause?: Error) {
    super(message, 'START_API_SERVER_ERROR', cause);
    this.name = 'StartApiServerError';
    Object.setPrototypeOf(this, StartApiServerError.prototype);
  }
}

/**
 * Signals a `cdkd local run-task` orchestration failure that did not
 * originate from a lower-level module (those throw their own narrower
 * errors — `EcsTaskResolutionError`, `EcsSecretsResolutionError`,
 * `DockerRunnerError`, `LocalInvokeBuildError`). Used by the runner /
 * CLI when the failure is meaningful only at the task-orchestrator
 * layer (e.g. cyclic dependsOn, essential container did not start).
 */
export class LocalRunTaskError extends CdkdError {
  constructor(message: string, cause?: Error) {
    super(message, 'LOCAL_RUN_TASK_ERROR', cause);
    this.name = 'LocalRunTaskError';
    Object.setPrototypeOf(this, LocalRunTaskError.prototype);
  }
}

/**
 * Signals a `cdkd local start-service` orchestration failure (Phase 2
 * of #262 — `AWS::ECS::Service` emulator). Distinct from
 * `LocalRunTaskError` because the service runner has its own lifecycle
 * (long-running replica pool, restart-on-exit), so a failure inside it
 * carries different operator semantics than a one-shot task failure.
 */
export class LocalStartServiceError extends CdkdError {
  constructor(message: string, cause?: Error) {
    super(message, 'LOCAL_START_SERVICE_ERROR', cause);
    this.name = 'LocalStartServiceError';
    Object.setPrototypeOf(this, LocalStartServiceError.prototype);
  }
}

/**
 * Signals that the upstream `cdk` CLI is not available on PATH (or at
 * the override path passed via `--cdk-bin`). Surfaced from `cdkd migrate`
 * (#465 PR A) before any other work runs.
 *
 * The message includes the install hint `npm install -g aws-cdk@latest`
 * so users on a fresh machine see exactly how to recover.
 */
export class MissingCdkCliError extends CdkdError {
  constructor(detail?: string, cause?: Error) {
    const head = detail ?? "upstream 'cdk' CLI not found on PATH";
    super(
      `${head}. ` +
        `'cdkd migrate' shells out to the upstream aws-cdk CLI for L1 codegen — ` +
        `install it with 'npm install -g aws-cdk@latest' (or pass --cdk-bin <path>).`,
      'MISSING_CDK_CLI',
      cause
    );
    this.name = 'MissingCdkCliError';
    Object.setPrototypeOf(this, MissingCdkCliError.prototype);
  }
}

/**
 * Generic local-migrate orchestration failure (#465 PR A). Used by
 * `cdkd migrate` for pre-flight rejections (Custom Resource / nested
 * stack / non-terminal CFn stack state), output-dir collisions, and
 * `cdk migrate` subprocess failures whose underlying stderr is folded
 * into the error message. Exit code 2 (partial-failure family) because
 * some pre-flight failures leave the user with a partially-populated
 * output directory that's still useful for debugging.
 */
export class LocalMigrateError extends CdkdError {
  readonly exitCode: number = 2;

  constructor(message: string, cause?: Error) {
    super(message, 'LOCAL_MIGRATE_ERROR', cause);
    this.name = 'LocalMigrateError';
    Object.setPrototypeOf(this, LocalMigrateError.prototype);
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
 *
 * Default exit code is 1 (general error). `PartialFailureError`
 * overrides it to 2 so callers can distinguish "command crashed /
 * unauthorized / bad arguments" from "command completed but some
 * resources are still in an error state, re-run to clean up".
 *
 * A {@link CdkdError} subclass may set `silent = true` to suppress the
 * default `logger.error` line — used by `cdkd drift` where the command
 * has already printed a richer report and only needs the exit code.
 */
export function handleError(error: unknown): never {
  const logger = getLogger();
  const silent = error instanceof CdkdError && (error as CdkdError & { silent?: boolean }).silent;
  if (!silent) {
    logger.error(formatError(error));
  }

  if (error instanceof Error && error.stack) {
    logger.debug('Stack trace:', error.stack);
  }

  const exitCode = error instanceof PartialFailureError ? error.exitCode : 1;
  process.exit(exitCode);
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
