import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import {
  MAX_CAUSE_CHAIN_DEPTH,
  THROTTLING_ERROR_NAMES,
  isMarkedNonRetryable,
  isThrottlingError,
  hasRedactedCause,
} from './marks.js';
import {
  RETRYABLE_ERROR_MESSAGE_PATTERNS,
  IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS,
} from './patterns.js';

/**
 * HTTP status codes that indicate a TRANSIENT SERVER-side failure worth
 * retrying (issue #2026).
 *
 * Mirrors `@smithy/service-error-classification`'s own
 * `TRANSIENT_ERROR_STATUS_CODES` (`[500, 502, 503, 504]`), which is what the
 * AWS SDK's default retry strategy treats as transient. Deliberately a
 * SEPARATE set from {@link RETRYABLE_HTTP_STATUS_CODES} rather than an
 * extension of it, because that one is consumed by {@link isThrottlingError},
 * which SEVEN call sites across four files pass as a deliberately NARROW
 * `isRetryable`: `describe-type.ts:67` (which states the intent outright --
 * "retry ONLY throttle-shaped failures"), `dynamodb-globaltable-provider.ts`
 * (x4), `export.ts:1744`, and `intrinsic-resolver/dynamic-ref-lookups.ts` (`sendWithThrottleRetry`). Widening
 * the shared set would have silently converted every one of them from "retry
 * throttles" into "retry throttles and server errors", which none of them
 * asked for.
 *
 * Three FURTHER sites call it as a bare classification rather than as a retry
 * filter -- `drift.ts:518`, `export.ts:1755`, `dynamodb-index-busy-delete.ts:381`
 * -- and they make the case stronger, not weaker: `drift.ts` would have started
 * returning `undefined` (reporting "cannot compare") for a resource whose read
 * merely 500'd, and the index poll would have waited a server error out as
 * though it were a throttle.
 *
 * Measured, not inferred. `tests/integration/iam-propagation-stress` against
 * real AWS (us-east-1, 2026-08-19 08:57:30Z, round 11 of 11) produced:
 *
 *   StressQueuePolicyDC3E35C3: gave up after 5 IAM-propagation retries over
 *   5.75s of propagation backoff - Failed to create SQS queue policy
 *   StressQueuePolicyDC3E35C3: UnknownError
 *   [name=InternalFailure http=500 requestId=ebf581cc-6072-5ffc-943a-e33312488615]
 *
 * SQS answered a `SetQueueAttributes` mid-propagation with HTTP 500
 * `InternalFailure` and an empty message body -- hence the `UnknownError`
 * placeholder, which matches no message pattern. With 500 absent from every
 * status set, `withRetry` classified it non-retryable and threw at 5.75s of a
 * 47.75s budget the sequence needed roughly 10s of.
 *
 * Why 502 and 504 come along rather than only the measured 500: they are the
 * same class (a gateway or timeout between AWS's edge and the service), the
 * SDK groups all four, and adding only the one status seen would leave the
 * identical defect behind for its siblings.
 *
 * Note the SDK has ALREADY retried these before cdkd sees them (default
 * `maxAttempts` is 3), so a 5xx reaching this classifier is one that persisted
 * across the SDK's own attempts. That is an argument FOR retrying it here, not
 * against: the eventual-consistency window this schedule exists to cover is
 * measured in seconds, while the SDK's three attempts span well under one.
 *
 * ACCEPTED RISK, stated rather than discovered later: this makes a
 * NON-IDEMPOTENT create retryable on a 500 that may have succeeded
 * server-side, so a replay can leave a resource that is absent from state and
 * therefore from destroy. The class is PRE-EXISTING -- the SDK's own three
 * attempts already reach it, and 503 was already retryable here -- but this
 * widens the window from ~1s to the full schedule. Judged worth it because the
 * alternative is the measured failure (a deploy that dies outright on a
 * transient 500), and because the durable remedy is per-provider idempotency
 * tokens rather than a blanket refusal to retry server errors.
 *
 * STATUS (issue #2039, and read this before citing the paragraph above). The
 * two worked examples this note used to carry -- `RunInstances` sent with no
 * `ClientToken`, and `IAMAccessKeyProvider` minting an unnamed key -- are both
 * FIXED, so quoting them as live hazards would now mislead. `RunInstances`,
 * `CreateNatGateway`, `CreateRouteTable`, `CreateNetworkAcl` and
 * `CreateHostedZone` carry a retry-stable token from
 * `src/provisioning/providers/idempotency-token.ts`, and `CreateAccessKey`
 * (which has no token member) reconciles the orphan its own failed attempt
 * left. The claim that "only four providers use one at all" was also wrong when
 * written: six did, and two of those regenerated the token per attempt, which
 * is worse than none. What REMAINS accepted here is the residue -- roughly 25
 * creates across 16 providers audited in issue #2039 and enumerated in issue
 * #2080 -- so this set stays as-is and the remedy stays per-provider.
 */
export const TRANSIENT_SERVER_ERROR_STATUS_CODES: ReadonlySet<number> = new Set([
  500, 502, 503, 504,
]);

/**
 * Walk the error + its `.cause` chain (bounded, same depth 5 as
 * {@link isThrottlingError}) looking for a transient SERVER-side HTTP status
 * ({@link TRANSIENT_SERVER_ERROR_STATUS_CODES}) on `$metadata`.
 *
 * The walk is what makes it work in practice: providers wrap the AWS error in
 * a `ProvisioningError`, so the `$metadata` carrying the status sits one link
 * down, and the wrapper's interpolated message is all a message-based
 * classifier can see. In the measured failure that message was the literal
 * `UnknownError`, so the status was the ONLY usable evidence in the whole
 * error.
 */
export function isTransientServerError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH && current != null; depth++) {
    const status = (current as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode;
    if (status !== undefined && TRANSIENT_SERVER_ERROR_STATUS_CODES.has(status)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Node socket error codes that can surface AFTER the request was written, so
 * the service may have acted on it: a reset or broken pipe mid-exchange, and a
 * timeout (which Node also raises for a connect that never completed -- counted
 * anyway, see {@link isAmbiguousOutcomeError}). Taken from
 * `@smithy/service-error-classification`'s `NODEJS_TIMEOUT_ERROR_CODES` minus
 * `ECONNREFUSED`, whose connection was never established; its
 * `NODEJS_NETWORK_ERROR_CODES` (`EHOSTUNREACH`, `ENETUNREACH`, `ENOTFOUND`) are
 * left out for the same reason.
 *
 * `EADDRNOTAVAIL` is IN, like `ETIMEDOUT`, for the same reason: Node raises it
 * both for a connect that could not bind a local address (nothing sent) and,
 * as `read EADDRNOTAVAIL`, on an established socket whose local address went
 * away -- the shape issue #4331 observed, after the request may have been
 * written. Neither form says which happened.
 */
const AMBIGUOUS_SOCKET_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EADDRNOTAVAIL',
]);

/**
 * Cloud Control handler `ErrorCode`s (the CloudFormation resource-handler
 * contract) that report a CREATE failing AFTER the handler may have made the
 * resource: the downstream service or the handler failed mid-flight, timed
 * out, or the resource was made and never stabilized. Read off a
 * `CloudControlOperationFailedError`'s `ccErrorCode`, which carries no HTTP
 * status.
 *
 * `GeneralServiceException` and the handler's `Throttling` are IN, unlike an
 * SDK-level throttle: a handler reports either from inside its create, after
 * the resource may be materialized (`cleanupFailedCreateRemnant` in
 * `cloud-control-provider.ts` exists for exactly that shape), and when that
 * cleanup misses, the replay's `AlreadyExists` is the resource colliding with
 * itself. Arming only withholds a delete-first, per the rule in
 * {@link isAmbiguousOutcomeError}.
 *
 * Excluded: codes stating the request was refused before anything was made
 * (`InvalidRequest`, `AccessDenied`, `InvalidCredentials`, `AlreadyExists`,
 * `ServiceLimitExceeded`, `NotFound`, `NotUpdatable`, `ResourceConflict`,
 * `UnauthorizedTaggingOperation`).
 */
const AMBIGUOUS_CC_HANDLER_ERROR_CODES: ReadonlySet<string> = new Set([
  'InternalFailure',
  // Not in `@aws-sdk/client-cloudcontrol`'s `HandlerErrorCode` enum; it is the
  // CloudFormation handler contract's code, kept since a handler can emit it.
  'HandlerInternalFailure',
  'ServiceInternalError',
  'NetworkFailure',
  'NotStabilized',
  'ServiceTimeout',
  'GeneralServiceException',
  'Throttling',
]);

/**
 * Whether a Cloud Control handler `ErrorCode` leaves open that the service
 * acted ({@link AMBIGUOUS_CC_HANDLER_ERROR_CODES}). Also read by the
 * `--remove-protection` compensation (issue #2204), where an ambiguous DELETE
 * may already be deleting and an ambiguous flip-off UPDATE may have landed.
 */
export function isAmbiguousCcHandlerErrorCode(code: string | undefined): boolean {
  return code !== undefined && AMBIGUOUS_CC_HANDLER_ERROR_CODES.has(code);
}

/**
 * True when a call ended WITHOUT telling cdkd whether the service acted on it
 * (issue [#3978](https://github.com/go-to-k/cdkd/issues/3978)): the request
 * may have succeeded server-side, so a replay of a create can meet the
 * resource that very request made.
 *
 * Walks the bounded `cause` chain ({@link MAX_CAUSE_CHAIN_DEPTH}). A link is
 * ambiguous when it carries
 *
 *  - a status in {@link TRANSIENT_SERVER_ERROR_STATUS_CODES} (500 / 502 / 503 /
 *    504) -- the service or a gateway failed after accepting the request; or
 *  - a socket code in {@link AMBIGUOUS_SOCKET_ERROR_CODES}, or the SDK's
 *    client-side `TimeoutError` -- the request was sent and no answer was read.
 *  - a Cloud Control handler code in {@link AMBIGUOUS_CC_HANDLER_ERROR_CODES}
 *    -- the handler may have made the resource before failing.
 *
 * The socket and `TimeoutError` arms reach no replay today: no classifier
 * `withRetry` runs retries a socket error, so the error that armed the latch
 * is the one thrown. They are there for when one does.
 *
 * NOT ambiguous, because the service declared it did nothing: an SDK-level
 * THROTTLE, i.e. a link named in {@link THROTTLING_ERROR_NAMES} (S3's
 * `SlowDown` is a 503) or flagged `$retryable.throttling` by the SDK. (A Cloud
 * Control HANDLER's `Throttling` is the opposite case: see
 * {@link AMBIGUOUS_CC_HANDLER_ERROR_CODES}.) A throttle link ends the
 * walk with `false` even above a 5xx cause. Nor is any 4xx (S3's
 * `RequestTimeout` included: the server saying it never received the whole
 * request), 501, or a failure with no status and none of those codes.
 *
 * Errs toward TRUE on purpose: every reader treats true as "no answer from
 * the service", the safe direction. In `withRetry`'s latch it WITHHOLDS the
 * name-collision credit from what that call throws from then on, the arming
 * attempt's own error included -- a false positive leaves a genuine collision
 * refused rather than deleted-first, while a false negative deletes a live
 * resource. The other readers (`AmbiguousCreateLatch`,
 * `withoutServerErrorRetries` -- 5xx only, the CodeCommit delete-target
 * check, the DynamoDB stream-member read) look before creating again, refuse
 * the SDK's silent replay of a tokenless create, rethrow instead of deleting
 * unconfirmed, or keep the declared value.
 *
 * Never throws: it runs in a retry loop's `catch`, where an out-throw would
 * replace the error being handled; an unreadable link reads as not ambiguous.
 */
export function isAmbiguousOutcomeError(error: unknown): boolean {
  try {
    let current: unknown = error;
    for (
      let depth = 0;
      depth < MAX_CAUSE_CHAIN_DEPTH && typeof current === 'object' && current !== null;
      depth++
    ) {
      const link = current as {
        name?: unknown;
        code?: unknown;
        ccErrorCode?: unknown;
        $retryable?: { throttling?: unknown };
        $metadata?: { httpStatusCode?: unknown };
        cause?: unknown;
      };
      if (typeof link.name === 'string' && THROTTLING_ERROR_NAMES.has(link.name)) return false;
      if (link.$retryable?.throttling === true) return false;
      const status = link.$metadata?.httpStatusCode;
      if (typeof status === 'number' && TRANSIENT_SERVER_ERROR_STATUS_CODES.has(status)) {
        return true;
      }
      if (typeof link.code === 'string' && AMBIGUOUS_SOCKET_ERROR_CODES.has(link.code)) return true;
      // Deliberately unscoped (any link named so, not only an SDK one): no cdkd
      // class uses the name, and a false hit only withholds a delete-first.
      if (link.name === 'TimeoutError') return true;
      if (
        typeof link.ccErrorCode === 'string' &&
        AMBIGUOUS_CC_HANDLER_ERROR_CODES.has(link.ccErrorCode)
      ) {
        return true;
      }
      current = link.cause;
    }
  } catch {
    // Unreadable chain: not ambiguous, per the doc above.
  }
  return false;
}

/**
 * The signals `isRetryableTransientError` had available when it classified an
 * error, rendered for a log line (issue #2026).
 *
 * NOT a classification input — nothing in this file or in `withRetry` reads it
 * back. It exists because the give-up summary added for issue #2018 reports the
 * error's MESSAGE, and the message is precisely the field that had gone missing
 * in the failure that motivated this: a sequence terminated on
 * `UnknownError`, which is what the AWS SDK v3 `decorateServiceException`
 * substitutes when a service response carries no message text at all
 * (`@smithy/smithy-client`: `exception.message || exception.Message ||
 * "UnknownError"`). With the message degenerate, the two fields that actually
 * decide {@link isThrottlingError} — the error `name` and
 * `$metadata.httpStatusCode` — were the only remaining evidence, and neither
 * reached any log at any verbosity. Diagnosing the give-up therefore required
 * a second real-AWS reproduction rather than a line from the first.
 */
export interface RetryClassificationSignals {
  /** The name of the AWS-side error, or the deepest name when none carries `$metadata`. */
  name?: string | undefined;
  /**
   * `$metadata.httpStatusCode` — the value both status sets are tested
   * against: {@link RETRYABLE_HTTP_STATUS_CODES} via {@link isThrottlingError},
   * and {@link TRANSIENT_SERVER_ERROR_STATUS_CODES} via
   * {@link isTransientServerError}.
   */
  httpStatusCode?: number | undefined;
  /** AWS request id, so a give-up can be taken to AWS support without a re-run. */
  requestId?: string | undefined;
  /**
   * True when NO link in the cause chain carried a `$metadata` object.
   *
   * Load-bearing rather than cosmetic, and the reason absence is reported
   * explicitly instead of as a missing field: a smithy `ServiceException` is
   * built by `deserializeMetadata(output)`, which always populates
   * `httpStatusCode` from the HTTP response, so its ABSENCE means the failure
   * never reached error deserialization at all (a network / parse failure
   * wrapped by a provider) — a different defect with a different fix from a
   * status that is present but unlisted. A blank field cannot tell those apart
   * from a truncated cause chain.
   */
  noMetadata: boolean;
}

/**
 * Collect {@link RetryClassificationSignals} from an error and its bounded
 * `.cause` chain — the SAME walk, to the same depth 5, that
 * {@link isThrottlingError} performs, so the line reports what the classifier
 * genuinely saw rather than a second opinion gathered differently.
 *
 * The signals are taken from the first link carrying a `$metadata` object,
 * because that link IS the AWS SDK error by construction: `$metadata` is
 * attached by the SDK's own `deserializeMetadata`, so nothing else can carry
 * it. When no link has one, the fallback is the deepest name found BELOW depth
 * 0 -- which keeps the field useful for the wrapped-network-error case, where
 * the name is all that survives.
 *
 * Excluding depth 0 from that fallback is deliberate and is what stops the
 * suffix from being noise. The error `withRetry` is handed is the provider's
 * own wrapper by construction (every provider catches the AWS error and
 * rethrows a `ProvisioningError`), so its `name` is a cdkd class name and says
 * nothing about the service. Reporting it produced the actively misleading
 * ` [name=ProvisioningError no-$metadata]` on a wrapper carrying no cause at
 * all -- a suffix asserting the SDK never parsed a response, about an error
 * that never came from the SDK.
 *
 * Nothing is lost in the case this helper exists for. A degenerate
 * `UnknownError` message can only be produced by `decorateServiceException`,
 * i.e. by a smithy `ServiceException`, and those always carry `$metadata` --
 * so that case is answered by the FIRST branch and never reaches this
 * fallback.
 *
 * Known narrowness: the first link with a NUMERIC status wins, so an outer
 * link carrying a 400 that wraps a cause carrying a 500 reports the 400 while
 * `isTransientServerError` retried on the 500. Left as-is because cdkd's own
 * wrappers carry no `$metadata` at all, so producing that shape takes two
 * stacked SDK errors -- but it is the same "must not contradict the
 * classifier" case one link further out, and is the thing to revisit if such a
 * chain is ever observed. A cdkd module deliberately importing no other module, this one
 * cannot ask `error instanceof CdkdError` directly: `error-handler.ts` imports
 * `markNonRetryable` from here, so the dependency only runs one way.
 */
export function describeRetryClassificationSignals(error: unknown): RetryClassificationSignals {
  let current: unknown = error;
  let deepestName: string | undefined;
  // Retained from the FIRST link carrying a `$metadata` object, so a chain
  // whose metadata has a request id but no status still reports the id.
  let sawMetadata = false;
  let metadataName: string | undefined;
  let metadataRequestId: string | undefined;

  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH && current != null; depth++) {
    const name = (current as { name?: unknown }).name;
    // Depth 0 is the provider's wrapper -- see the note above on why its name
    // is excluded from the no-$metadata fallback. It is still eligible via the
    // `$metadata` branch below, where the metadata itself proves the link came
    // from the SDK rather than from cdkd.
    if (depth > 0 && typeof name === 'string' && name !== '') {
      deepestName = name;
    }

    const metadata = (current as { $metadata?: unknown }).$metadata;
    if (metadata != null && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const { httpStatusCode, requestId } = metadata as {
        httpStatusCode?: unknown;
        requestId?: unknown;
      };
      const linkName = typeof name === 'string' && name !== '' ? name : undefined;
      if (!sawMetadata) {
        sawMetadata = true;
        metadataName = linkName;
        metadataRequestId =
          typeof requestId === 'string' && requestId !== '' ? requestId : undefined;
      }
      // Return only on a link that actually carries a STATUS. Returning on any
      // `$metadata` object was wrong in a shape the AWS SDK really produces: a
      // network failure carries `$metadata: { attempts, totalRetryDelay }` with
      // no `httpStatusCode`, and wrapping a 500 below it. The walk stopped at
      // the outer link and reported no `http=` at all -- while
      // `isTransientServerError`, which walks past it, HAD found the 500 and
      // retried on it. A line whose whole purpose is "what the classifier saw"
      // must not contradict the classifier.
      if (typeof httpStatusCode === 'number') {
        return {
          name: linkName ?? deepestName,
          httpStatusCode,
          // Falls back to an id retained from a SHALLOWER `$metadata` that had
          // no status: a chain can carry the request id on the outer link and
          // the status on the inner one, and dropping the id there loses the
          // single field AWS support needs.
          requestId:
            (typeof requestId === 'string' && requestId !== '' ? requestId : undefined) ??
            metadataRequestId,
          noMetadata: false,
        };
      }
    }
    current = (current as { cause?: unknown }).cause;
  }

  return {
    name: metadataName ?? deepestName,
    requestId: metadataRequestId,
    // FALSE when a `$metadata` was seen without a usable status: the response
    // DID reach the SDK's error deserialization, so the "never got that far"
    // reading the flag exists for would be a lie. Absent status and absent
    // metadata are genuinely different findings.
    noMetadata: !sawMetadata,
  };
}

/**
 * Render {@link describeRetryClassificationSignals} as a compact log suffix.
 *
 * Returns `''` when there is nothing to say (no name and no metadata), so a
 * caller can append unconditionally without emitting an empty bracket pair.
 */
export function formatRetryClassificationSignals(error: unknown): string {
  const signals = describeRetryClassificationSignals(error);
  // Nothing identifiable in the chain -- no name, no status, no request id.
  // Bail BEFORE the `no-$metadata` token below: on its own that token is not a
  // finding but noise, because "the failure never reached error
  // deserialization" is only informative about an error we can NAME. Emitting
  // it unconditionally appended a content-free ` [no-$metadata]` to the
  // give-up line for every non-AWS throw. A lone request id DOES count as
  // identifying, since it is the one field that lets AWS support find the call.
  if (
    signals.name === undefined &&
    signals.httpStatusCode === undefined &&
    signals.requestId === undefined
  ) {
    return '';
  }
  const parts: string[] = [];
  if (signals.name !== undefined) parts.push(`name=${signals.name}`);
  if (signals.httpStatusCode !== undefined) parts.push(`http=${signals.httpStatusCode}`);
  if (signals.requestId !== undefined) parts.push(`requestId=${signals.requestId}`);
  // Reported as a POSITIVE token rather than by omission: "no $metadata" is a
  // finding (the failure never reached error deserialization), and a reader
  // scanning for a missing `http=` cannot distinguish it from a status the
  // chain simply did not carry.
  if (signals.noMetadata) parts.push('no-$metadata');
  return ` [${parts.join(' ')}]`;
}

/**
 * Determine whether an AWS error should be retried.
 *
 * Checks (in order):
 *   0. {@link isMarkedNonRetryable} — a cdkd-authored refusal is terminal by
 *      declaration, ahead of every message / name heuristic below. FIRST on
 *      purpose: the marker states the error cannot succeed on a retry, so
 *      nothing a later check reads out of the message can overturn it.
 *   1. Rate-limit signal on the error or any wrapped cause — throttling error
 *      `name` or retryable HTTP status (most AWS throttles are HTTP 400, not
 *      429, so the name check carries most of the weight). See
 *      {@link isThrottlingError}.
 *   2. Transient SERVER-side HTTP status (500 / 502 / 503 / 504) on the error
 *      or any wrapped cause — see {@link isTransientServerError}. Ahead of the
 *      message patterns because it is the only check that still works when the
 *      response carried NO message (issue #2026).
 *   3. Substring match against {@link RETRYABLE_ERROR_MESSAGE_PATTERNS}
 */
export function isRetryableTransientError(error: unknown, message: string): boolean {
  if (isMarkedNonRetryable(error)) return false;
  if (isThrottlingError(error)) return true;
  // Issue #2026: a transient SERVER error (HTTP 500 / 502 / 503 / 504). Placed
  // after the throttle check and before the message patterns because it is the
  // check that survives an EMPTY message -- the measured failure carried the
  // SDK's `UnknownError` placeholder, so every pattern below had nothing to
  // match against and the sequence died at 12% of its budget.
  if (isTransientServerError(error)) return true;

  return RETRYABLE_ERROR_MESSAGE_PATTERNS.some((p) => message.includes(p));
}

/**
 * The text every MESSAGE-based retry classifier should read: this error's own
 * message plus every message down its `cause` chain.
 *
 * Every classifier in this module that reads a message reads the TOP-LEVEL one,
 * and that was sound only while cdkd's wrappers copied their cause's text
 * verbatim -- which they did, everywhere, until issue
 * [#2302](https://github.com/go-to-k/cdkd/issues/2302). A wrapper on a THROWN
 * path may now deliberately WITHHOLD AWS's wording, because a thrown message is
 * captured into the persisted `deployments/{runId}.jsonl` store and S3's
 * `AccessDenied` names the caller's account, role and session. Measured on
 * `S3BucketProvider.create` before this function existed: the wrap turned
 * `not authorized to perform` (retryable, and on the DENSE IAM-propagation
 * cadence) and `conflicting conditional operation` (retryable) into
 * NON-retryable, i.e. the redaction silently removed a retry the deploy
 * depended on.
 *
 * This is the missing THIRD walk rather than a new idea: {@link
 * isMarkedNonRetryable} and {@link isThrottlingError} already walk the same
 * chain, for the same stated reason (cdkd wraps SDK errors routinely).
 *
 * It cannot resurrect a cdkd refusal: every consumer checks
 * {@link isMarkedNonRetryable} FIRST, that marker is itself chain-walked, and
 * both walks are bounded by the SAME {@link MAX_CAUSE_CHAIN_DEPTH}.
 *
 * It is a NO-OP for every error that has not opted in via
 * {@link markRedactedCause} -- which is every wrapper on `main` outside
 * #2302's redacting sites. An earlier revision justified itself with a wider
 * claim, that every wrapper on `main` COPIES its cause's message; that claim is
 * false (`custom-resource-provider.ts`'s `describeWaiterFailure` already
 * withholds the raw waiter payload, and it is not the only wrapper that does),
 * and it does not need to be true. The opt-in stamp makes the no-op a property
 * of the mechanism rather than of a survey.
 *
 * NEVER use the result as a LOG line or a thrown message: it is the union of
 * exactly the text the redaction exists to withhold. `retry.ts` keeps the
 * top-level message for its `warn` / `debug` output and uses this only to
 * classify.
 */
export function retryClassificationText(error: unknown): string {
  // `.detail`, not a bare ternary: this is the FIRST thing the destroy retry
  // loop does with a caught value (`destroy-runner.ts` calls it inside the
  // per-resource retry catch, upstream of every handler that would RECORD the
  // failure), so a `String()` that throws here replaces the AWS failure with a
  // `TypeError` before anything can say what actually happened. Byte-identical
  // to the ternary it replaced, so the substring tests below -- and the
  // `.includes('Too Many Requests')` at the call site -- match exactly what
  // they matched before (go-to-k/cdkd#3348).
  const top = describeAwsFailure(error).detail;
  // OPT-IN, and that is the whole safety argument. Reading the chain
  // unconditionally would re-classify every wrapper whose message does not
  // already carry its cause's text, and that population is neither empty nor
  // uniformly deliberate. The decisive member is `deploy-engine.ts`'s outer
  // per-resource wrap, whose whole message is `Failed to <op> resource <id>`:
  // it is UNMARKED and sits on every resource failure in the tree, so an
  // unconditional join flips it from terminal to retryable whenever the cause
  // happens to carry a retryable substring -- measured on that wrap, a
  // `DependencyViolation` cause and a `does not exist` cause both flip
  // `false -> true`. That is a large behavior change with nothing to do with
  // #2302's redaction.
  //
  // The audited list of non-carrying sites lives in the PR body rather than
  // here, deliberately: a count in a comment goes stale silently, and two
  // independently written counting rules agreed on the SITES while disagreeing
  // on how many constructions to divide them by.
  //
  // So the join fires only for a chain that says it withheld something.
  // `markNonRetryable` is checked FIRST by every consumer and is walked to
  // the SAME depth as this, so a marked refusal still cannot be resurrected
  // by the widened text -- the two walks agree by construction rather than
  // by assertion (an earlier revision walked 10 here against the marker's 5,
  // which left a refusal marked at depth 6-10 readable but unmarkable).
  if (!hasRedactedCause(error)) return top;

  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  // A `visited` set as well as the depth bound, because a nested-stack chain
  // grows one `ProvisioningError` per level and a self-referencing `cause` is
  // cheap to construct.
  for (
    let depth = 0;
    depth < MAX_CAUSE_CHAIN_DEPTH && current != null && !seen.has(current);
    depth++
  ) {
    seen.add(current);
    if (current instanceof Error) {
      if (current.message) parts.push(current.message);
    } else {
      // A non-`Error` link, at ANY depth. `new Error(m, { cause: 'a string' })`
      // is legal and a provider can rethrow a non-`Error` value, so a link
      // gated on `depth === 0` both dropped the text AND dead-ended the walk
      // one link early. Stringify it and keep going: `cause` is readable off a
      // non-object too (it is simply `undefined`), so the loop terminates.
      //
      // `String()` can THROW, and where this runs makes that fatal rather than
      // untidy: `Object.create(null)` has no `Symbol.toPrimitive`, no
      // `toString` and no `valueOf`, so stringifying it raises
      // `TypeError: Cannot convert object to primitive value`. Both callers
      // invoke this INSIDE a catch block (`destroy-runner.ts`'s delete loop and
      // `retry.ts`'s attempt loop), so an exception here would REPLACE the real
      // failure with an unrelated `TypeError` and lose the error the caller was
      // about to classify and rethrow. Same reasoning as `markNonRetryable`'s
      // `isExtensible` guard: a helper on a failure path must not out-throw the
      // failure it is describing. The `depth === 0` gate bounded this by
      // accident; widening the walk removed that bound, so the guard is now
      // explicit. A link that cannot be stringified contributes NO text and the
      // walk continues, which is the same outcome as an `Error` with an empty
      // message.
      try {
        parts.push(String(current));
      } catch {
        // Deliberately silent: there is no text to add, and this function has
        // no logger by design (its whole output is classification-only text
        // that must never be logged).
      }
    }
    current = (current as { cause?: unknown } | undefined)?.cause;
  }
  return parts.join('\n');
}

/**
 * True when the message is a just-created-IAM-entity propagation rejection
 * ({@link IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS}).
 *
 * This does NOT decide retryability — every pattern it matches is already in
 * {@link RETRYABLE_ERROR_MESSAGE_PATTERNS}. It only selects the retry CADENCE:
 * `withRetry` polls this class densely (sub-second initial delay, low cap)
 * because IAM propagation usually resolves within seconds, whereas the
 * generic exponential schedule is tuned for throttling and long resource-state
 * transitions.
 *
 * Deliberately message-only (no error-object inspection): the propagation
 * signal is always carried in the vendor's message text, and cdkd wraps the
 * original error in a `ProvisioningError` that preserves it.
 */
export function isIamPropagationError(message: string): boolean {
  return IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS.some((p) => message.includes(p));
}
