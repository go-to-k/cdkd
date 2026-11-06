import type { FirehoseProvider } from '../firehose-provider.js';
import {
  DescribeDeliveryStreamCommand,
  StartDeliveryStreamEncryptionCommand,
  StopDeliveryStreamEncryptionCommand,
  type DeliveryStreamEncryptionConfiguration,
  type DeliveryStreamEncryptionConfigurationInput,
} from '@aws-sdk/client-firehose';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { startInterruptWatch } from '../../interrupt-watch.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  enclosingDeadlineExpired,
  enclosingDeadlineRemainingMs,
} from '../../../deployment/resource-deadline.js';
import {
  ENCRYPTION_KEY,
  encryptionMatches,
  ENCRYPTION_POLL_INTERVAL_MS,
  ENCRYPTION_POLL_MAX_ATTEMPTS,
  terminalEncryptionFailures,
} from './shared.js';

/**
 * Apply a changed `DeliveryStreamEncryptionConfigurationInput` (issue
 * #5357): `StartDeliveryStreamEncryption` for a new or changed block,
 * `StopDeliveryStreamEncryption` for a removed one, as CloudFormation does
 * (both measured on a CFn stack, a removal alone and beside a Tags change).
 *
 * Both calls only START an asynchronous transition (ENABLING / DISABLING,
 * measured at 80-95 s), so the update waits for its end state. An earlier
 * transition is waited out first, and the call is skipped when the stream
 * already holds the requested state, since AWS answers
 * `InvalidArgumentException` to a Start with the customer-managed key already
 * in use and to a Stop on a stream that is not encrypted. That includes
 * `ENABLING_FAILED` after a rejected Start: measured, it reports no KeyType
 * and a Stop there is refused as "already disabled".
 */
export async function applyEncryptionUpdate(
  this: FirehoseProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  desired: { kind: 'absent' } | { kind: 'usable'; keyType: string; keyArn?: string },
  mask: MaskerFn,
  markUnsettled: ((propertyName: string) => void) | undefined
): Promise<void> {
  const settled = await this.waitForEncryption(logicalId, physicalId, resourceType, mask, {
    what: 'settle',
    done: (enc) => enc?.Status !== 'ENABLING' && enc?.Status !== 'DISABLING',
  });
  if (desired.kind === 'absent') {
    if (settled?.Status !== 'ENABLED' && settled?.Status !== 'DISABLING_FAILED') return;
    this.refuseToStartTransition(logicalId, physicalId, resourceType, 'disable');
    // go-to-k/cdkd#5380: after the refusal, before the call: from here a
    // failure leaves the stream in a state the record may not describe.
    markUnsettled?.(ENCRYPTION_KEY);
    await this.getClient().send(
      new StopDeliveryStreamEncryptionCommand({ DeliveryStreamName: physicalId })
    );
    await this.warnIfUnfinished(logicalId, 'StopDeliveryStreamEncryption', markUnsettled, () =>
      this.waitForEncryption(logicalId, physicalId, resourceType, mask, {
        what: 'disable',
        done: (enc) => enc === undefined || enc.Status === 'DISABLED',
        inProgress: 'DISABLING',
        failed: 'DISABLING_FAILED',
        staleFailure: settled.Status === 'DISABLING_FAILED',
      })
    );
    return;
  }
  if (encryptionMatches(settled, desired)) return;
  this.refuseToStartTransition(logicalId, physicalId, resourceType, 'enable');
  markUnsettled?.(ENCRYPTION_KEY);
  await this.getClient().send(
    new StartDeliveryStreamEncryptionCommand({
      DeliveryStreamName: physicalId,
      DeliveryStreamEncryptionConfigurationInput: {
        KeyType: desired.keyType as DeliveryStreamEncryptionConfigurationInput['KeyType'],
        ...(desired.keyArn !== undefined && { KeyARN: desired.keyArn }),
      },
    })
  );
  await this.warnIfUnfinished(logicalId, 'StartDeliveryStreamEncryption', markUnsettled, () =>
    this.waitForEncryption(logicalId, physicalId, resourceType, mask, {
      what: 'enable',
      done: (enc) => encryptionMatches(enc, desired),
      inProgress: 'ENABLING',
      failed: 'ENABLING_FAILED',
      staleFailure: settled?.Status === 'ENABLING_FAILED',
    })
  );
}

/**
 * Run the wait that follows an accepted Start / Stop, and when it fails
 * (a `*_FAILED` report, a timeout, the resource deadline, Ctrl-C) warn before
 * rethrowing. A throwing `update()` leaves the PREVIOUS block in state, while
 * the stream can still finish the transition, or after a `*_FAILED` hold
 * neither setting. On a deploy the call was preceded by `markUnsettled`
 * (go-to-k/cdkd#5380), so the record names the key unsettled and the next
 * deploy reads the stream and converges it, whichever template it applies.
 * Elsewhere (a rollback revert, `drift --revert`) nothing marks it, so the
 * warning points at `cdkd drift`.
 */
export async function warnIfUnfinished<T>(
  this: FirehoseProvider,
  logicalId: string,
  call: 'StartDeliveryStreamEncryption' | 'StopDeliveryStreamEncryption',
  markUnsettled: ((propertyName: string) => void) | undefined,
  wait: () => Promise<T>
): Promise<T> {
  try {
    return await wait();
  } catch (error) {
    const outcome =
      typeof error === 'object' && error !== null && terminalEncryptionFailures.has(error)
        ? 'AWS reported the change failed, so the stream may no longer match'
        : 'the stream may still finish the change, so it may no longer match';
    this.logger.warn(
      safeMsg`Firehose delivery stream ${logicalId}: ${call} was sent but the encryption change did not finish; ${outcome} the previous setting cdkd keeps recorded. `.concat(
        markUnsettled === undefined
          ? "Run 'cdkd drift' to compare, then 'cdkd drift --revert' to apply the recorded setting or 'cdkd drift --accept' to record the stream's."
          : `cdkd records ${ENCRYPTION_KEY} as unsettled, so the next 'cdkd deploy' reads the stream and applies the template's setting. To keep the stream as it ends up instead, run 'cdkd drift --accept' once the stream no longer reads ENABLING or DISABLING (an accept during the transition keeps the key unsettled).`
      )
    );
    throw error;
  }
}

/**
 * Refuse to START an encryption transition once the engine's per-resource
 * deadline has run out, or after Ctrl-C. The deadline does not cancel this
 * update: the engine has already failed the resource and moved on, so a
 * Start / Stop sent now would change the stream with nobody waiting on it.
 * A signal that landed during the settle wait's last read is caught here:
 * that wait returns on a settled report before it re-checks, and the latch
 * is sticky, so a fresh watch reads it.
 */
export function refuseToStartTransition(
  this: FirehoseProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  what: 'enable' | 'disable'
): void {
  const watch = startInterruptWatch(`Firehose ${logicalId} encryption ${what}`);
  try {
    if (watch.isInterrupted()) throw watch.onInterrupted();
  } finally {
    watch.dispose();
  }
  // `remainingMs` reads the clock, so it can reach 0 before the timer that
  // sets `expired` has run.
  if (!enclosingDeadlineExpired() && enclosingDeadlineRemainingMs() > 0) return;
  throw markNonRetryable(
    new ProvisioningError(
      `The resource timeout expired before encryption could be ${what}d on Firehose ` +
        `delivery stream ${logicalId}; no encryption call was sent`,
      resourceType,
      logicalId,
      physicalId
    )
  );
}

/**
 * Poll `DescribeDeliveryStream` until `done` accepts the reported
 * encryption, and return it. A `failed` report is terminal and names AWS's
 * failure description, masked, and non-retryable: a retry would only issue
 * the same call against the same key. When the stream already reported
 * `failed` before the call (`staleFailure`), that report counts only after
 * the `inProgress` status has been seen, so an earlier failure is never
 * blamed on this call. Ctrl-C stops the wait with an `InterruptedWaitError`.
 * Either way the update is not recorded, so a redeploy of the same template
 * re-reads the stream and issues only what is still missing.
 */
export async function waitForEncryption(
  this: FirehoseProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  mask: MaskerFn,
  opts: {
    what: 'settle' | 'enable' | 'disable';
    done: (enc: DeliveryStreamEncryptionConfiguration | undefined) => boolean;
    inProgress?: 'ENABLING' | 'DISABLING';
    failed?: 'ENABLING_FAILED' | 'DISABLING_FAILED';
    staleFailure?: boolean;
  }
): Promise<DeliveryStreamEncryptionConfiguration | undefined> {
  const { what, done, inProgress, failed } = opts;
  const watch = startInterruptWatch(`Firehose ${logicalId} encryption ${what}`);
  try {
    let last: string | undefined;
    let sawInProgress = false;
    for (let attempt = 1; attempt <= ENCRYPTION_POLL_MAX_ATTEMPTS; attempt++) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      // The engine's deadline does not cancel this update, so a wait that
      // outlived it would keep polling with nobody waiting on it. Checked
      // before the read, so the wait ends as the deadline does.
      if (enclosingDeadlineRemainingMs() <= 0) {
        throw markNonRetryable(
          new ProvisioningError(
            `The resource timeout expired while waiting to ${what} encryption on Firehose ` +
              `delivery stream ${logicalId} (last status: ${last ?? 'none reported'})`,
            resourceType,
            logicalId,
            physicalId
          )
        );
      }
      const resp = await this.getClient().send(
        new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
      );
      const enc = resp.DeliveryStreamDescription?.DeliveryStreamEncryptionConfiguration;
      if (done(enc)) return enc;
      last = enc?.Status;
      if (last !== undefined && last === inProgress) sawInProgress = true;
      if (failed !== undefined && last === failed && (sawInProgress || !opts.staleFailure)) {
        const failure = enc?.FailureDescription;
        const terminal = markNonRetryable(
          new ProvisioningError(
            `Failed to ${what} encryption on Firehose delivery stream ${logicalId}: AWS reports ` +
              `${failed}` +
              (failure ? ` (${mask(`${failure.Type ?? ''}: ${failure.Details ?? ''}`)})` : ''),
            resourceType,
            logicalId,
            physicalId
          )
        );
        terminalEncryptionFailures.add(terminal);
        throw terminal;
      }
      if (watch.isInterrupted()) throw watch.onInterrupted();
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, Math.min(ENCRYPTION_POLL_INTERVAL_MS, enclosingDeadlineRemainingMs()))
        )
      );
    }
    throw markNonRetryable(
      new ProvisioningError(
        `Timed out waiting to ${what} encryption on Firehose delivery stream ${logicalId} ` +
          `(last status: ${last ?? 'none reported'})`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  } finally {
    watch.dispose();
  }
}
