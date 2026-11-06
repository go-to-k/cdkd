import type { LambdaFunctionProvider } from '../lambda-function-provider.js';
import { describeAwsFailure, describeAwsStatusReason } from '../../../utils/aws-failure-text.js';
import type { FunctionConfiguration } from '@aws-sdk/client-lambda';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markRedactedCause, relayedNameCollision } from '../../../deployment/retryable-errors.js';
import { isAuxiliaryFailure } from '../../auxiliary-failure.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';
import { withholdWaiterPayload, LATEST_PUBLISHED } from './shared.js';

/**
 * The failure wrap this provider's create / update catches throw.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
 * caller's assumed-role ARN. AWS's own text goes to `debug` through the
 * operation's masker, and the wrap is stamped `markRedactedCause`, so the
 * retry classifiers read the withheld text (`concurrent update operation`,
 * `currently in the following state`) on the `cause` chain. An "already
 * exist(s)" is restated ({@link relayedNameCollision}), so a create-first
 * replacement still recognises the collision (issue #1625), except from a
 * post-create call's failure ({@link markAuxiliaryFailure}), where "it" would
 * read as this function. Every post-create call today reaches this wrap as
 * {@link applyPostCreateConfig}'s cdkd-authored refusal, which keeps its
 * text, so the gate guards a post-create call made outside it. A non-`Error` throw is withheld the same way, and
 * stamped only when `build` threads a cause for it (create / update do: a
 * thrown string keeps its retry classification on that chain).
 *
 * A cdkd-authored or transport error keeps its text, MASKED: AWS quotes
 * request values (a role, a layer, a subnet) back in its own words. When the
 * mask changed that text, the wrap is stamped `markRedactedCause` too. A
 * failed waiter's payload is withheld in the caught error itself
 * ({@link withholdWaiterPayload}). A method, not a module function, so
 * `gen-update-wrap-coverage` sees the catch that throws it as a
 * `ProvisioningError` wrap factory.
 *
 * `build` must thread `error` as `cause`, and runs twice on an AWS-authored
 * failure, so it must stay a side-effect-free constructor call.
 */
export function wrapMaskedError(
  this: LambdaFunctionProvider,
  log: MaskedLogSinks,
  error: unknown,
  build: (maskedText: string) => ProvisioningError
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (failure.redacted) {
    this.logger.debug(log.mask(build(log.mask(failure.detail)).message));
    const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
    const wrapped = build(`${log.mask(failure.summary)}${relay}`);
    // A non-Error throw is stamped too when `build` gave it a cause to read.
    return wrapped.cause !== undefined ? markRedactedCause(wrapped) : wrapped;
  }
  // `.detail` is byte-identical to the `.message` / `String()` ternary and
  // cannot throw on an unconvertible value (go-to-k/cdkd#3361).
  const raw = failure.detail;
  // A failed waiter's payload is withheld in the caught error itself.
  const text = withholdWaiterPayload(error, log.mask)?.masked ?? log.mask(raw);
  const wrapped = build(text);
  return text === raw ? wrapped : markRedactedCause(wrapped);
}

/**
 * The error a `Failed` read of `$LATEST.PUBLISHED` throws: AWS's reason goes
 * to `debug` and the `cause`, the message carries its code and the
 * `--verbose` pointer (go-to-k/cdkd#2319). No reason keeps cdkd's fallback.
 */
export function wrapStatusReasonError(
  this: LambdaFunctionProvider,
  target: { logicalId: string; resourceType: string; functionName: string },
  log: MaskedLogSinks,
  cfg: FunctionConfiguration
): ProvisioningError {
  const { logicalId, resourceType, functionName } = target;
  const head = `Lambda function ${logicalId}: ${LATEST_PUBLISHED} failed: `;
  const text = describeAwsStatusReason(
    {
      code: cfg.StateReasonCode ?? cfg.LastUpdateStatusReasonCode,
      message: cfg.StateReason ?? cfg.LastUpdateStatusReason,
    },
    'no reason given'
  );
  const build = (detail: string, cause?: Error): ProvisioningError =>
    new ProvisioningError(
      `${head}${log.mask(detail)}`,
      resourceType,
      logicalId,
      functionName,
      cause
    );
  if (!text.redacted) return build(text.summary);
  log.debug(log.mask(`${head}${text.detail}`));
  return markRedactedCause(build(text.summary, new Error(text.detail)));
}
