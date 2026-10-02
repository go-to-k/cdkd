/**
 * Transient-error classification: the message tables, the non-retryable and
 * redacted-cause marks, the transient / ambiguous-outcome classifiers, the
 * name-collision predicates and `isUpdateUnsupportedError`. The implementation
 * lives in `retryable-errors/*.ts` (issue #4452); this module re-exports exactly
 * the names it always exported, so no importer changes.
 *
 * The family is a graph LEAF. Its ONE import outside `retryable-errors/` is
 * `aws-failure-text.ts`, itself a zero-import leaf, which keeps the module
 * graph flat -- this is reached from the retry path of every command, and
 * `error-handler.ts` imports it without a cycle.
 */
export {
  IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS,
  NAME_COOLDOWN_ERROR_MESSAGE_PATTERNS,
  RETRYABLE_ERROR_MESSAGE_PATTERNS,
  RETRYABLE_HTTP_STATUS_CODES,
} from './retryable-errors/patterns.js';
export {
  THROTTLING_ERROR_NAMES,
  markRedactedCause,
  wrapMaskedAwsError,
  hasRedactedCause,
  markNonRetryable,
  isMarkedNonRetryable,
  isThrottlingError,
} from './retryable-errors/marks.js';
export {
  TRANSIENT_SERVER_ERROR_STATUS_CODES,
  isTransientServerError,
  isAmbiguousCcHandlerErrorCode,
  isAmbiguousOutcomeError,
  type RetryClassificationSignals,
  describeRetryClassificationSignals,
  formatRetryClassificationSignals,
  isRetryableTransientError,
  retryClassificationText,
  isIamPropagationError,
} from './retryable-errors/transient.js';
export {
  isNameCollisionError,
  NAME_COLLISION_ERROR_NAMES,
  markNameCollision,
  markReplayMayCollide,
  hasReplayMayCollide,
  isNameCollisionErrorFrom,
  isReplayedNameCollisionFrom,
  isNameCooldownError,
  isRecreateRetryableError,
} from './retryable-errors/name-collision.js';
export {
  CC_UNSUPPORTED_ACTION_ERROR_NAME,
  isUpdateUnsupportedError,
} from './retryable-errors/update-unsupported.js';
