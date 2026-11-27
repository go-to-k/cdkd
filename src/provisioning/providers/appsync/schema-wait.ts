import { GetSchemaCreationStatusCommand } from '@aws-sdk/client-appsync';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { describeAwsFailure, describeAwsStatusReason } from '../../../utils/aws-failure-text.js';
import {
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
  markRedactedCause,
} from '../../../deployment/retryable-errors.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { startInterruptWatch } from '../../interrupt-watch.js';
import { resolvedResourceTimeoutMs } from '../../resource-timeout-registry.js';
import type { AppSyncProvider } from '../appsync-provider.js';

/** The longest pause between two `GetSchemaCreationStatus` reads. */
export const SCHEMA_POLL_MAX_INTERVAL_MS = 5_000;
/** The wait's cap; an explicit `--resource-timeout` can only lower it (half of it). */
export const SCHEMA_WAIT_MAX_MS = 15 * 60_000;

/** The statuses AppSync reports once the schema it was given is in place. */
const APPLIED = new Set(['SUCCESS', 'ACTIVE']);

/**
 * Wait for the schema a `StartSchemaCreation` just submitted to be applied
 * (go-to-k/cdkd#7127). AppSync applies it asynchronously: until
 * `GetSchemaCreationStatus` leaves `PROCESSING` the API still serves the
 * previous schema, and a schema AppSync refuses ends `FAILED`. CloudFormation
 * waits the same way and fails the resource (`NotStabilized`) on `FAILED`.
 *
 * Without the wait the observed-baseline capture read the previous schema (so
 * `cdkd drift --revert` pushed it back, and AppSync dropped the resolvers of
 * the fields it lacks), and a refused schema deployed with exit 0.
 *
 * `--no-wait` does not skip it: this is the resource's own completion, not
 * stabilization — a `FAILED` schema IS a failed create or update.
 *
 * Every status other than `PROCESSING` (or none) ends the wait. `SUCCESS` /
 * `ACTIVE` mean applied; `FAILED`, `NOT_APPLICABLE` ("no schema creation is
 * ongoing", which right after a start leaves the outcome unknown) and
 * `DELETING` (the API is going away) fail the resource with AWS's `details`,
 * which go to `debug` through `mask` — the thrown message is persisted, so it
 * carries the `--verbose` pointer (go-to-k/cdkd#2319). A throttled or
 * transient read re-polls.
 *
 * `startStatus` is the `status` `StartSchemaCreation` answered, the first
 * observation of THIS submission. It seeds the last-status report only: every
 * outcome, a refusal included, is decided by a poll (only `PROCESSING` has been
 * measured as a start answer).
 *
 * Bounded by {@link SCHEMA_WAIT_MAX_MS}, lowered to half an explicit
 * `--resource-timeout` so this message wins over the outer deadline — the
 * formula of the Connect / VPC endpoint / Pipes waits, so a raised flag never
 * shortens the wait — and Ctrl-C aware.
 */
export async function waitForSchemaCreation(
  this: AppSyncProvider,
  apiId: string,
  logicalId: string,
  resourceType: string,
  phase: 'create' | 'update',
  mask: MaskerFn,
  startStatus?: string
): Promise<void> {
  const userTimeoutMs = resolvedResourceTimeoutMs(resourceType);
  const maxWaitMs =
    userTimeoutMs === undefined
      ? SCHEMA_WAIT_MAX_MS
      : Math.min(SCHEMA_WAIT_MAX_MS, userTimeoutMs / 2);
  const wrapRefusedError = (status: string, details: string | undefined): ProvisioningError => {
    const reason = describeAwsStatusReason({ message: details }, '');
    const build = (text: string, cause?: Error): ProvisioningError =>
      new ProvisioningError(
        `GraphQL schema ${logicalId} ${phase} failed: AWS AppSync reports ${status}${text}`,
        resourceType,
        logicalId,
        apiId,
        cause
      );
    if (!reason.redacted) return markNonRetryable(build(''));
    this.logger.debug(mask(build(`: ${mask(reason.detail)}`).message));
    return markNonRetryable(
      markRedactedCause(build(`. ${reason.summary}`, new Error(reason.detail)))
    );
  };
  const isRefusal = (status: string | undefined): status is string =>
    status !== undefined && status !== 'PROCESSING' && !APPLIED.has(status);
  const startedAt = this.now();
  const watch = startInterruptWatch(`GraphQL schema ${logicalId} ${phase}`);
  try {
    let lastStatus: string | undefined = startStatus;
    let interval = 1_000;
    for (;;) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      try {
        const response = await this.getClient().send(new GetSchemaCreationStatusCommand({ apiId }));
        const status = response.status;
        lastStatus = status;
        if (status !== undefined && APPLIED.has(status)) return;
        if (isRefusal(status)) throw wrapRefusedError(status, response.details);
        this.logger.debug(safeMsg`GraphQL schema ${logicalId}: ${status ?? 'no status'}, waiting`);
      } catch (error) {
        if (error instanceof ProvisioningError) throw error;
        if (!isThrottlingError(error) && !isTransientServerError(error)) {
          const cause = error instanceof Error ? error : undefined;
          throw this.wrapCaughtError(
            mask,
            error,
            (text) =>
              new ProvisioningError(
                `Failed to read the schema status of GraphQL schema ${logicalId} after its ${phase}: ${text}`,
                resourceType,
                logicalId,
                apiId,
                cause
              )
          );
        }
        this.logger.debug(
          safeMsg`GraphQL schema ${logicalId}: status read failed transiently (${describeAwsFailure(error).summary}), re-polling`
        );
      }
      const remainingMs = maxWaitMs - (this.now() - startedAt);
      if (remainingMs <= 0) {
        throw markNonRetryable(
          new ProvisioningError(
            `GraphQL schema ${logicalId} was not applied within ${Math.round(maxWaitMs / 1000)}s ` +
              `of its ${phase} (last status: ${lastStatus ?? 'unknown'}). AppSync may still be ` +
              `applying it: check 'aws appsync get-schema-creation-status --api-id ${mask(apiId)}', ` +
              'then deploy again.',
            resourceType,
            logicalId,
            apiId
          )
        );
      }
      await this.sleep(Math.min(interval, remainingMs));
      interval = Math.min(interval * 2, SCHEMA_POLL_MAX_INTERVAL_MS);
    }
  } finally {
    watch.dispose();
  }
}
