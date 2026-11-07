import { plainOrDescribed } from '../pasteable-command.js';
import { safeMsg } from '../display-safe.js';
import { hasResourceTypeShape, TIMEOUT_FLAG_RESOURCE_TYPE } from '../resource-type-shape.js';

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
 * `getAccountInfo` could not name the deploy's AWS account: STS failed (or
 * answered with no `Account`) and `AWS_ACCOUNT_ID` is unset or malformed (issue
 * [#1730](https://github.com/go-to-k/cdkd/issues/1730)).
 *
 * There is no placeholder account to fall back to, so every caller either gets
 * the real id or this. A caller that can degrade WITHOUT the account (omit an
 * ARN attribute it would record, leave an import-time name unresolved) matches
 * on this class; everything else lets it propagate.
 *
 * Carries NO `cause`: `formatError` renders a cause at default verbosity, and
 * the STS failure's text may be AWS-authored. The message names the failure by
 * `describeAwsFailure(...).summary`, which withholds AWS-authored message text
 * (a cdkd- or SDK-authored one such as `ECONNREFUSED` passes through whole),
 * and the full text goes to the debug log.
 */
export class AccountIdUnavailableError extends CdkdError {
  constructor(message: string) {
    super(message, 'ACCOUNT_ID_UNAVAILABLE');
    this.name = 'AccountIdUnavailableError';
    Object.setPrototypeOf(this, AccountIdUnavailableError.prototype);
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
 * Control-flow signal: the user declined a pre-provisioning confirmation
 * prompt, so the deploy must unwind WITHOUT being reported as a failure.
 *
 * Raised from `DeployEngineOptions.onCurrentStateLoaded` (the post-lock
 * gate the `--prefix-user-supplied-names` migration check runs in). The
 * engine does not catch it — it propagates out of `deploy()` through the
 * usual `finally`, which releases the lock and stops the renderer — and the
 * deploy CLI catches it and returns quietly instead of logging an error or
 * recording a FAILED run event. Nothing has been provisioned at that point.
 */
export class DeployCancelledError extends CdkdError {
  constructor(message = 'Deployment cancelled by user') {
    super(message, 'DEPLOY_CANCELLED');
    this.name = 'DeployCancelledError';
    Object.setPrototypeOf(this, DeployCancelledError.prototype);
  }
}

/**
 * The operator declined the `--require-approval` prompt (go-to-k/cdkd#5136).
 *
 * A failure to the work graph, so stacks depending on the declined one are
 * skipped, but an expected outcome to the operator: like the AWS CDK CLI's
 * `AbortError`, it prints as a yellow line without the failure framing, and
 * the run still exits 1 because the template was not applied. Read through
 * {@link isSoftAbort}: `maskSecretsInError` hands on a rebuilt copy, which keeps
 * the own `softAbort` property.
 */
export class DeploymentNotApprovedError extends CdkdError {
  readonly softAbort = true;

  constructor(message: string) {
    super(message, 'DEPLOY_NOT_APPROVED');
    this.name = 'DeploymentNotApprovedError';
    Object.setPrototypeOf(this, DeploymentNotApprovedError.prototype);
  }
}

/** Whether `error` is a declined confirmation ({@link DeploymentNotApprovedError}). */
export function isSoftAbort(error: unknown): boolean {
  return error instanceof Error && (error as Error & { softAbort?: unknown }).softAbort === true;
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
    // The logical id and type come from a template or a state record, and this
    // multi-line message is printed whole (the destroy runner's failure line).
    // A line break in either would open a line of its own, and padding would
    // wrap into one on screen -- a counterfeit row (go-to-k/cdkd#3773). So each
    // is named only in the shape a real one has, and described otherwise;
    // `safeMsg` folds whatever else is interpolated.
    const shownId = plainOrDescribed(logicalId, 'logical id');
    const shownType = hasResourceTypeShape(resourceType)
      ? resourceType
      : 'a resource type that is not printable as typed';
    // The per-type form names the type only when `--resource-timeout` would
    // accept it: the parser reads the same pattern.
    const remedy =
      hasResourceTypeShape(resourceType) && TIMEOUT_FLAG_RESOURCE_TYPE.test(resourceType)
        ? safeMsg`slow ENI provisioning. Re-run with --resource-timeout ${resourceType}='<DURATION>'\n` +
          'to bump the budget for this resource type only, or --verbose to see the\n'
        : "slow ENI provisioning. Re-run with a larger --resource-timeout '<DURATION>',\n" +
          'or --verbose to see the\n';
    super(
      safeMsg`Resource ${shownId} (${shownType}) in ${region} timed out after ${timeoutLabel} during ${operation} (elapsed ${elapsedLabel}).\n` +
        'This may indicate a stuck Cloud Control polling loop, hung Custom Resource, or\n' +
        remedy +
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
