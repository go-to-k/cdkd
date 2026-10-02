import { RETRYABLE_HTTP_STATUS_CODES } from './patterns.js';

/**
 * AWS SDK v3 canonical throttling error names. Mirrors
 * `@aws-sdk/service-error-classification`'s `THROTTLING_ERROR_CODES` — any
 * error (or wrapped cause) whose `name` is one of these is a transient rate-
 * limit rejection worth retrying with backoff. Detecting by NAME is more
 * robust than by HTTP status because most AWS throttles surface as HTTP 400
 * (not 429) with the throttling signal carried only in the error code / name
 * (e.g. SSM `ThrottlingException` for the `Rate exceeded` message).
 */
export const THROTTLING_ERROR_NAMES: ReadonlySet<string> = new Set([
  'BandwidthLimitExceeded',
  'EC2ThrottledException',
  'LimitExceededException',
  'PriorRequestNotComplete',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'RequestThrottled',
  'RequestThrottledException',
  'SlowDown',
  'ThrottledException',
  'Throttling',
  'ThrottlingException',
  'TooManyRequestsException',
  'TransactionInProgressException',
]);

/**
 * Marker for an error cdkd raised as a DELIBERATE refusal rather than as a
 * relayed AWS failure (issue [#1778](https://github.com/go-to-k/cdkd/issues/1778)).
 *
 * Every classifier below is SUBSTRING-based, which is the right shape for
 * relaying a vendor's message and the wrong one for cdkd's own prose: a
 * refusal message is assembled from values cdkd does not control — a provider
 * `reason`, a state-borne physicalId, a template logical id — and any of them
 * can happen to contain a retryable pattern. Measured: a resource named
 * `MyDependencyViolationSub` puts `DependencyViolation` in the message, so a
 * deterministic refusal was classified transient and burned the whole backoff
 * schedule before failing exactly as it would have immediately. Keeping the
 * offending values OUT of the message narrows that surface but cannot close
 * it, because a message with no identifiers at all is not diagnosable.
 *
 * A marker inverts the burden: the raiser STATES that the error is terminal,
 * so no wording can make it retryable. Deliberately a `Symbol.for` key —
 * global-registry symbols survive a duplicated module instance (dual
 * bundling), where a module-local symbol would silently stop matching — and
 * non-enumerable, so it cannot leak into a serialized error payload.
 */
const NON_RETRYABLE_MARKER = Symbol.for('cdkd.nonRetryable');

/**
 * How far every `.cause` walk in this module reads.
 *
 * ONE constant rather than five literals, because the walks are only sound
 * together: {@link isMarkedNonRetryable} is what stops a deliberate refusal
 * being read as transient, so any walk that reads text FURTHER than the marker
 * walk creates a band where a refusal is legible but its marker is not.
 * {@link retryClassificationText} shipped at 10 against the marker's 5 for
 * exactly that reason, and the chain shape that makes the band reachable is
 * the one the code already cites -- a nested-stack failure grows one
 * `ProvisioningError` per level.
 */
export const MAX_CAUSE_CHAIN_DEPTH = 5;

/**
 * Stamped on an error whose own message deliberately WITHHOLDS text its
 * `cause` carries (issue [#2302](https://github.com/go-to-k/cdkd/issues/2302)).
 *
 * Distinct from {@link NON_RETRYABLE_MARKER} and orthogonal to it: this one
 * says nothing about whether the error should be retried, only that the
 * message a classifier would normally read is INCOMPLETE.
 */
const REDACTED_CAUSE_MARKER = Symbol.for('cdkd.redactedCause');

/**
 * Declare that this error's message withholds text its `cause` carries, so the
 * message-based retry classifiers must read the CHAIN instead
 * (issue [#2302](https://github.com/go-to-k/cdkd/issues/2302)).
 *
 * cdkd's retry classifiers match by SUBSTRING over a message. That is sound
 * only while a wrapper copies its cause's text, which every wrapper did until
 * #2302 started reducing an AWS failure to its error CLASS -- S3 words its
 * `AccessDenied` as `User: arn:aws:sts::<account>:assumed-role/<role>/<session>
 * is not authorized to perform: ...`, and a THROWN message is captured into the
 * persisted `deployments/{runId}.jsonl` store. Redacting it also removed the
 * substrings the pattern table matches on: measured on `S3BucketProvider`,
 * `not authorized to perform` (retryable, on the DENSE IAM-propagation cadence)
 * and S3's `conflicting conditional operation` both went NON-retryable.
 *
 * Call it at every site that redacts, and only there. It is deliberately an
 * opt-in stamp rather than an unconditional chain read -- see
 * {@link retryClassificationText} for the measurement that forced that choice.
 *
 * Same non-extensible tolerance as {@link markNonRetryable}, for the same
 * reason: callers use it inline around the error they are about to throw, so a
 * `TypeError` here would replace the refusal with an unrelated crash. Losing
 * the stamp degrades to reading the top-level message, i.e. the pre-#2302
 * classification of a message that is now shorter -- worse, but not a crash.
 */
export function markRedactedCause<E extends Error>(error: E): E {
  if (!Object.isExtensible(error)) return error;
  Object.defineProperty(error, REDACTED_CAUSE_MARKER, {
    value: true,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return error;
}

/**
 * Build a failure wrap whose message quotes `error`'s text through `mask`, and
 * {@link markRedactedCause} it exactly when the mask changed that text
 * (issue [#4244](https://github.com/go-to-k/cdkd/issues/4244)).
 *
 * A provider masks AWS's text before joining it into its own message (issue
 * #2177), and a secret or derived-name needle can overlap the retry table's
 * wording (`currently in the following state: Pending`, `cannot be assumed`):
 * the stamp makes the classifiers read the unmasked chain, so the retry
 * survives the mask. `build` must pass `error` as the wrap's `cause` -- the
 * stamp names a chain for the classifiers to read. An unchanged text is left
 * unstamped, so it classifies on its own message as before. A thrown
 * non-`Error` value has no chain to thread, so its stamp reads nothing and it
 * keeps its masked-message classification.
 *
 * Only for relayed AWS text: a cdkd-authored refusal quoting a user value must
 * not be stamped, or a value spelling retry wording would make it retryable.
 */
export function wrapMaskedAwsError<E extends Error>(
  mask: (text: string) => string,
  error: unknown,
  build: (maskedText: string) => E
): E {
  const raw = error instanceof Error ? error.message : String(error);
  const masked = mask(raw);
  const wrapped = build(masked);
  return masked === raw ? wrapped : markRedactedCause(wrapped);
}

/**
 * True when the error, or anything in its bounded `.cause` chain, was stamped
 * by {@link markRedactedCause}.
 *
 * Walked rather than read off the top link, because the redacting error is
 * itself wrapped further out: `deploy-engine.ts` re-wraps every provider
 * failure, so by the time a classifier sees it the stamp is one or more links
 * deep. Same {@link MAX_CAUSE_CHAIN_DEPTH} as the marker walk, which is what
 * lets {@link retryClassificationText} claim the two agree.
 */
export function hasRedactedCause(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH && current != null; depth++) {
    if (typeof current === 'object' || typeof current === 'function') {
      if ((current as Record<symbol, unknown>)[REDACTED_CAUSE_MARKER] === true) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Mark a cdkd-authored refusal as terminal and return it, for
 * `throw markNonRetryable(new ProvisioningError(...))`.
 *
 * Reach for it when the error means "this cannot succeed on a retry" as a
 * matter of cdkd's own logic — NOT for a relayed AWS failure, whose
 * retryability is the classifiers' business.
 *
 * The known live instance this JSDoc used to flag as uncovered —
 * `ResourceUpdateNotSupportedError` (`src/utils/error-handler.ts`), which
 * interpolates the logical id and is thrown by ~20 providers from inside the
 * retried `update()` in `deploy-engine.ts` — IS covered as of issue
 * [#1838](https://github.com/go-to-k/cdkd/issues/1838): it marks itself in its
 * CONSTRUCTOR, so every construction is terminal and no provider throw site
 * has to remember. That is the shape to prefer for a whole error CLASS that is
 * always a refusal; mark at the `throw` (as the SNS abort below does) only
 * when the class is retryable in general and this one raising of it is not.
 */
export function markNonRetryable<E extends Error>(error: E): E {
  // `E extends Error`, not `object`: a class or a shared prototype is an
  // object too, and the reader below is a PROTOTYPE-CHAIN lookup, so marking
  // one would silently mark every instance of it as terminal.
  //
  // A non-extensible (frozen / sealed) error is returned UNMARKED rather than
  // allowed to throw. Callers use this inline — `throw markNonRetryable(...)`
  // — so a `TypeError` raised here would REPLACE the refusal the caller meant
  // to raise, turning a precise message into an unrelated crash. Losing the
  // marker degrades to the pre-marker behavior (the message heuristics still
  // apply); losing the refusal loses the diagnosis.
  if (!Object.isExtensible(error)) return error;
  Object.defineProperty(error, NON_RETRYABLE_MARKER, {
    value: true,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return error;
}

/**
 * True when the error, or anything in its bounded `.cause` chain, was marked
 * by {@link markNonRetryable}.
 *
 * The chain walk mirrors {@link isThrottlingError}'s: cdkd wraps errors, so a
 * marked refusal can end up one or more links deep, and a marker that stopped
 * counting after a single wrap would be a fence that quietly falls open.
 *
 * That reach is DIRECTIONAL, and the upward direction is a hazard worth
 * stating. Downward — a marked refusal wrapped by an outer error — is the
 * intended case and stays terminal. UPWARD is the inverse: wrapping a marked
 * refusal as the `cause` of a genuinely RETRYABLE outer error
 * (`new Error(msg, { cause: markedRefusal })`) makes the outer error terminal
 * too, because this walk finds the marker on the cause. That shape IS
 * constructed today, on purpose: `deploy-engine.ts`'s `--strict-getatt`
 * output re-wrap threads `{ cause: error }` precisely so a marked resolver
 * refusal survives the wrap (issue #1874) — the wrapper inlines the refusal's
 * text, including template-controlled identifiers, so without the cause the
 * marker is dropped and the classifier can read the copied text as transient.
 * The hazard is therefore not "can this be built" but "is the OUTER error
 * genuinely retryable": wrapping a marked refusal as the cause of a
 * transient error would stop retrying something that should retry. Thread the
 * cause when the wrapper is as terminal as its cause (the case above); strip
 * or re-raise it when the wrapper is retryable in its own right. That applies
 * to every `markNonRetryable` call site — `grep -rn 'markNonRetryable(' src/`
 * is the authority, deliberately in place of a list here.
 *
 * **Do not restate the sites as a count or an enumeration.** Both have already
 * gone stale in this one comment: it first said "six", which was the count of
 * `IntrinsicResolutionRefusalError` THROW sites transplanted from the other
 * file, and the per-file list that replaced it was stale within a day, when a
 * parallel lane added two sites in `nested-stack-provider.ts`. Marking is a
 * per-site judgement any lane can make, so any tally written here is a
 * snapshot of one moment that then reads as complete — which is the defect
 * {@link file://../utils/error-handler.ts}'s own enumeration warning
 * describes. What is stable, and all a reader needs, is the RULE above.
 */
export function isMarkedNonRetryable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH && current != null; depth++) {
    if (typeof current === 'object' || typeof current === 'function') {
      if ((current as Record<symbol, unknown>)[NON_RETRYABLE_MARKER] === true) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Walk the error + its `.cause` chain (bounded) looking for a rate-limit
 * signal — either an AWS SDK v3 throttling error `name`
 * ({@link THROTTLING_ERROR_NAMES}) or a retryable HTTP status
 * ({@link RETRYABLE_HTTP_STATUS_CODES}) on `$metadata`.
 *
 * cdkd wraps the original AWS error in a `ProvisioningError`, so the signal is
 * typically one cause-link deep; the bounded walk also tolerates SDK errors
 * that nest a `$response`/cause without exploding on a cyclic chain.
 *
 * BOTH signals are checked at EVERY depth. An earlier version checked the name
 * to depth 5 but the HTTP status only at depths 0 and 1, so a 429 nested two
 * links deep was missed.
 */
export function isThrottlingError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH && current != null; depth++) {
    const name = (current as { name?: unknown }).name;
    if (typeof name === 'string' && THROTTLING_ERROR_NAMES.has(name)) return true;

    const status = (current as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode;
    if (status !== undefined && RETRYABLE_HTTP_STATUS_CODES.has(status)) return true;

    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
