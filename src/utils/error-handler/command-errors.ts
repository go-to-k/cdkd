import { CdkdError } from './base-errors.js';

/**
 * Signals that `cdkd local start-api`'s route discovery hit an unsupported
 * shape — non-AWS_PROXY integration, ApiGwV2 service integration
 * (`IntegrationSubtype` set), WebSocket protocol, Lambda::Url with an
 * unrecognized `AuthType` (anything other than `'NONE'` / `'AWS_IAM'`),
 * or an unsupported intrinsic function in `IntegrationUri`. (Lambda::Url
 * with `InvokeMode: RESPONSE_STREAM` is a normal route dispatched via
 * the streaming protocol — #467. Lambda::Url with `AuthType: 'AWS_IAM'`
 * is a normal route verified through the SigV4 pipeline — #621.)
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
 * CloudFormation macro / `Fn::Transform` expansion failure (#463).
 *
 * cdkd hands templates that declare `Transform: [...]` (or carry
 * `Fn::Transform: {...}` snippets) to CloudFormation server-side via a
 * transient `CreateChangeSet --change-set-type CREATE` against a
 * `cdkd-macro-expand-<id>` stack name. This error wraps every failure
 * mode of that round-trip:
 *
 *   - `CreateChangeSet` rejection (bad template, missing macro IAM
 *     permission, custom macro not found in the account).
 *   - Changeset settles in `FAILED` (`StatusReason` from CFn is
 *     surfaced verbatim — typically a custom macro Lambda error).
 *   - Waiter timeout (the macro Lambda is stuck or oversized).
 *   - `GetTemplate --template-stage Processed` returns no body (would
 *     indicate a CFn-side regression — fail loud rather than silently
 *     proceed with the un-expanded template).
 *   - Multi-stage detection: the expanded template still contains
 *     macros, which cdkd v1 does not support (the design intentionally
 *     rejects this so a second round-trip is not silently triggered).
 *
 * The error surfaces at exit code 2 (partial-failure family) — the
 * cleanup `finally` in the expander always runs `DeleteChangeSet` +
 * `DeleteStack` regardless of this error firing, so a failed
 * expansion never leaves a transient CFn stack behind in a routine
 * case. The user can re-run `cdkd deploy` once the upstream cause is
 * fixed.
 */
export class MacroExpansionError extends CdkdError {
  readonly exitCode: number = 2;

  constructor(message: string, cause?: Error) {
    super(message, 'MACRO_EXPANSION_ERROR', cause);
    this.name = 'MacroExpansionError';
    Object.setPrototypeOf(this, MacroExpansionError.prototype);
  }
}
