import type { ECSProvider } from '../ecs-provider.js';
import { DeleteServiceCommand, DescribeServicesCommand, type Service } from '@aws-sdk/client-ecs';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { isAmbiguousOutcomeError } from '../../../deployment/retryable-errors.js';
import { isPlainImportValue, VALUE_NOT_SHOWN } from '../../import-helpers.js';
import { logicalIdShown } from '../../composite-id.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { CREATION_DATE_SKEW_MARGIN_MS, isInsideWindow } from '../ambiguous-create.js';
import type { NameHeldBefore } from '../create-ownership.js';

/**
 * `true` when the service ANSWERED with a 2xx and the SDK could not read the
 * body (a response the model does not parse: go-to-k/cdkd#6284 met an
 * emulator's ISO `createdAt` where the JSON protocol expects epoch seconds).
 * `@smithy/middleware-serde` stamps the response's status on such an error as
 * `$metadata.httpStatusCode`. The call SUCCEEDED; only its answer is lost.
 */
export function answeredSuccess(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null | undefined)
    ?.$metadata?.httpStatusCode;
  return typeof status === 'number' && status >= 200 && status < 300;
}

/**
 * Whether a `CreateService` that threw may still have created the service
 * (go-to-k/cdkd#6284): it answered 2xx with an unreadable body, or it ended
 * with no definite answer (`isAmbiguousOutcomeError`: a 5xx, a reset or
 * timeout after the request was sent). A 4xx, a named throttle, or a failure
 * raised before anything was sent is a definite refusal.
 */
export function createServiceOutcomeUnknown(error: unknown): boolean {
  return answeredSuccess(error) || isAmbiguousOutcomeError(error);
}

/** What `settleAmbiguousCreateService` needs from the failed attempt. */
export interface AmbiguousCreateServiceAttempt {
  readonly logicalId: string;
  readonly cluster: string | undefined;
  /** The name cdkd SENT. */
  readonly serviceName: string;
  readonly createError: unknown;
  /** `Date.now()` just before the `CreateService` send. */
  readonly attemptStartMs: number;
  readonly heldBefore: NameHeldBefore;
  /**
   * `true` when the by-name lookup before `CreateService` actually RAN
   * (go-to-k/cdkd#4403); `heldBefore` is then a measurement, not the
   * `'free'` default the create path assigns when it skips the lookup.
   */
  readonly heldBeforeMeasured: boolean;
}

/**
 * After `CreateService` itself threw with an outcome that leaves open whether
 * ECS created the service (go-to-k/cdkd#6284), find out, and return the ARN
 * of a service this create made, for the caller to mark on the error it
 * throws (`markCreatedBeforeFailure`) so the failed-CREATE journal names it
 * and the rollback, `cdkd rollback` and `cdkd destroy` delete it. Returns
 * `undefined` when there is nothing to mark.
 *
 * Marked rather than deleted: an engine retry of a 5xx sends the identical
 * `CreateService` again, which ECS answers with this same ACTIVE service; a
 * service deleted here would be DRAINING and refuse that retry.
 *
 * Identity evidence, as the steady-state cleanup's (go-to-k/cdkd#4403): a
 * service that held the name BEFORE the create (`heldBefore === 'held'`,
 * which ECS may have handed back) is never this create's. Otherwise the
 * service found under the name is this create's when the pre-create lookup
 * MEASURED the name free, or when its `createdAt` falls inside the attempt's
 * skew-widened window. Unlike the report-only orphan lookups of
 * `orphan-report.ts`, the name is not the evidence here: a service name is
 * unique per cluster, and either proof ties the service to this create's
 * attempt; the measured-free one is what the steady-state cleanup deletes on.
 *
 * When the lookup cannot answer, a `CreateService` that answered 2xx with the
 * name measured free has PROVABLY made the service, but its ARN is unknown:
 * it is deleted by name (no wait), a `DeleteService` 2xx counting as accepted
 * for the same reason. Anything else is reported with the commands to inspect
 * and delete it, never acted on.
 */
export async function settleAmbiguousCreateService(
  this: ECSProvider,
  attempt: AmbiguousCreateServiceAttempt,
  log: MaskedLogSinks
): Promise<string | undefined> {
  // Runs in the create's `catch`: an out-throw would replace the error
  // being handled.
  try {
    return await settle.call(this, attempt, log);
  } catch (error) {
    log.debug(
      `Looking for ECS service ${attempt.logicalId} after its ambiguous CreateService failure failed: ${describeAwsFailure(error).detail}`
    );
    return undefined;
  }
}

async function settle(
  this: ECSProvider,
  attempt: AmbiguousCreateServiceAttempt,
  log: MaskedLogSinks
): Promise<string | undefined> {
  const { logicalId, cluster, serviceName, createError } = attempt;
  if (!createServiceOutcomeUnknown(createError)) return undefined;
  if (attempt.heldBefore === 'held') {
    log.debug(
      `CreateService for ECS service ${logicalId} failed without a definite answer, but a service already held the name before it: not this create's`
    );
    return undefined;
  }
  const window = {
    floorMs: attempt.attemptStartMs - CREATION_DATE_SKEW_MARGIN_MS,
    ceilingMs: Date.now() + CREATION_DATE_SKEW_MARGIN_MS,
  };
  const measuredFree = attempt.heldBeforeMeasured && attempt.heldBefore === 'free';
  const aws = pasteableAwsCommand(log.mask);
  // A truthy NON-string reaches the tag and withholds the command: dropping
  // `--cluster` would address the default cluster instead.
  const clusterArg = cluster ? aws` --cluster ${cluster}` : aws``;
  const shown = (value: string): string =>
    isPlainImportValue(value) ? `(${value})` : VALUE_NOT_SHOWN;
  const subject = `ECS service ${logicalIdShown(logicalId)} ${shown(serviceName)}`;

  let found: Service | undefined;
  let lookupFailure: string | undefined;
  try {
    const response = await this.getClient().send(
      new DescribeServicesCommand({ cluster, services: [serviceName] })
    );
    const services = response?.services ?? [];
    const failures = response?.failures ?? [];
    if (services.length === 0 && failures.length === 1 && failures[0]?.reason === 'MISSING') {
      log.debug(`No ECS service ${logicalId} exists after its ambiguous CreateService failure`);
      return undefined;
    }
    if (failures.length > 0 || services.length !== 1 || !services[0]!.serviceArn) {
      lookupFailure = 'DescribeServices gave no readable answer for the service name';
    } else {
      found = services[0];
    }
  } catch (lookupError) {
    const failure = describeAwsFailure(lookupError);
    log.debug(`DescribeServices for ECS service ${logicalId} failed with: ${failure.detail}`);
    lookupFailure = `DescribeServices: ${failure.summary.replace(/\.$/, '')}`;
  }

  if (found !== undefined) {
    if (found.status === 'INACTIVE') {
      log.debug(`ECS service ${logicalId} is INACTIVE after its ambiguous CreateService failure`);
      return undefined;
    }
    const arn = found.serviceArn!;
    if (!measuredFree && !isInsideWindow(found.createdAt, window)) {
      log.debug(
        `ECS service ${logicalId} exists after its ambiguous CreateService failure, but nothing shows this create made it (created ${found.createdAt?.toISOString() ?? 'at an unknown time'}): left alone`
      );
      return undefined;
    }
    log.warn(
      `CreateService for ${subject} failed without a definite answer, but ECS created the service ${shown(arn)}. It is recorded on the failed create, so the rollback, cdkd rollback or cdkd destroy deletes it.`
    );
    return arn;
  }

  const describeCommand = aws`aws ecs describe-services${clusterArg} --services ${serviceName}`;
  const deleteCommand = aws`aws ecs delete-service${clusterArg} --service ${serviceName} --force`;
  if (!(answeredSuccess(createError) && measuredFree)) {
    log.warn(
      `CreateService for ${subject} failed without a definite answer, so ECS may have created the service, which no cdkd state records, and cdkd could not look for it (${lookupFailure}). Inspect it: ${describeCommand.render()}. Only after confirming it is this deploy's and not another's, delete it: ${deleteCommand.render()}.`
    );
    return undefined;
  }
  try {
    await this.getClient().send(
      new DeleteServiceCommand({ cluster, service: serviceName, force: true })
    );
  } catch (deleteError) {
    if (this.isServiceNotFoundException(deleteError)) {
      log.debug(`ECS service ${logicalId} was already gone when its cleanup ran`);
      return undefined;
    }
    if (!answeredSuccess(deleteError)) {
      const failure = describeAwsFailure(deleteError);
      const head = `Failed to clean up ${subject}, which CreateService created before its answer could not be read: `;
      if (failure.redacted) log.debug(`${head}${failure.detail}`);
      log.warn(
        `${head}${failure.redacted ? `${failure.summary} ` : `${failure.detail}. `}Manual deletion may be required before the next deploy: ${deleteCommand.render()}`
      );
      return undefined;
    }
  }
  log.warn(
    `Deleted ${subject}: CreateService created it but its answer could not be read (${lookupFailure}), so the next deploy's CreateService does not collide on the name.`
  );
  return undefined;
}
