import { isThrottlingError, isTransientServerError } from '../../deployment/retryable-errors.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { isWaitAbandonedError } from '../wait-abandoned.js';
import { markNotGone } from '../not-gone.js';
import { CloudControlOperationFailedError } from './shared.js';

/**
 * Node / undici socket-level failure codes, i.e. the request never reached
 * Cloud Control or its response never came back.
 *
 * Mirrors `@smithy/service-error-classification`'s own
 * `NODEJS_TIMEOUT_ERROR_CODES` (`ECONNRESET` / `ECONNREFUSED` / `EPIPE` /
 * `ETIMEDOUT`), widened by the DNS and route shapes a dropped VPN also
 * produces. The SDK retries those four and its `NODEJS_NETWORK_ERROR_CODES`
 * (`EHOSTUNREACH` / `ENETUNREACH` / `ENOTFOUND`) under STANDARD mode -- three
 * attempts, sub-second -- so one of THOSE reaching cdkd here is one the SDK's
 * own budget did not outlast. The rest (`ECONNABORTED`, `EAI_AGAIN`,
 * `ENETDOWN`, `EPROTO`, `EADDRNOTAVAIL`) the SDK does not classify, so they
 * arrive on the first failure.
 *
 * `EADDRNOTAVAIL` is a LOCAL-address failure: `connect EADDRNOTAVAIL` when the
 * host could not bind one (ephemeral ports exhausted), `read EADDRNOTAVAIL`
 * when an established socket's local address went away -- the form issue
 * [#4331](https://github.com/go-to-k/cdkd/issues/4331) observed. Either way
 * the status poll is a read of the same token, so re-polling is safe whether
 * or not the failed request reached Cloud Control.
 */
export const POLL_TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPROTO',
  'EADDRNOTAVAIL',
]);

/** SDK error names for a request that timed out or was aborted in transit. */
export const POLL_TRANSPORT_ERROR_NAMES: ReadonlySet<string> = new Set([
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
  'RequestAbortedException',
]);

/**
 * Matches one of {@link POLL_TRANSPORT_ERROR_CODES} as a whole word inside a
 * message that lost its `code` property.
 *
 * DERIVED from the set rather than hand-spelled, so the two can never disagree
 * about which codes count — and so the pattern cannot be wrong about a code's
 * LENGTH, which a hand-written `E[A-Z]{3,10}` was: it is eleven characters
 * after the `E` in `ECONNREFUSED`, the exact code the issue reported, so the
 * arm silently matched nothing for the case it was added for.
 */
export const POLL_TRANSPORT_CODE_IN_MESSAGE = new RegExp(
  `\\b(?:${[...POLL_TRANSPORT_ERROR_CODES].join('|')})\\b`
);

/**
 * The `.cause` walk depth. It is `retryable-errors/marks.ts`'s `MAX_CAUSE_CHAIN_DEPTH`
 * VALUE, and equality is the requirement rather than a coincidence: a transport
 * code this predicate finds at a depth `isThrottlingError` /
 * `isMarkedNonRetryable` / `isRetryableTransientError` structurally cannot
 * reach means two classifiers answering differently about one chain, which is
 * the divergence this area keeps collapsing. A literal because that constant is
 * module-private there, and `tests/unit/provisioning/cloud-control-wait-abandoned.test.ts`
 * pins the pair by building a chain one hop deeper than the bound and asserting
 * BOTH refuse it -- a claim an earlier revision made with no such case behind
 * it, which is exactly the shape a fence audit greps for.
 *
 * cdkd wraps errors (`ProvisioningError` keeps the raw one as `cause`), so the
 * socket error is routinely one or two hops down; the bound also keeps a cyclic
 * chain from hanging the classifier.
 */
export const POLL_CAUSE_CHAIN_DEPTH = 5;

/** What one poll failure may say on each of the two channels. */
export interface PollFailureText {
  /**
   * Safe for a user-facing OR PERSISTED line. `''` when there is nothing to
   * say -- an absent cause, or a message that is empty once sanitized -- so a
   * caller renders no clause at all rather than a colon promising a reason.
   */
  readonly display: string;
  /**
   * The full text, for `logger.debug` ONLY. `''` when nothing was withheld, so
   * a caller can skip a line that would only repeat `display`.
   */
  readonly detail: string;
  /**
   * Whether the caller should `markRedactedCause` the error it builds. True
   * only when a reduction happened AND the chain will carry the withheld text
   * -- `aws-failure-text.ts` states that precondition and says stamping
   * without it is worse than not stamping at all.
   */
  readonly marker: boolean;
}

/**
 * Decide what a `GetResourceRequestStatus` failure may say outside `--verbose`.
 *
 * ONE function because there are TWO readers and they must not disagree about
 * one error: `abandonWait`, whose message is persisted verbatim into
 * `deployments/{runId}.jsonl`, and the re-poll `logger.warn`, which runs at
 * DEFAULT verbosity. They were separate, and the gap was reachable rather than
 * theoretical -- `POLL_TRANSPORT_CODE_IN_MESSAGE` matches a socket code
 * ANYWHERE in the message, so a `credential_process` stderr that happens to
 * contain `ETIMEDOUT` classifies as transient, and the warn printed the helper
 * argv and stderr on every re-poll while the abandonment that eventually
 * followed reduced them.
 *
 * The authorship decision is `describeAwsFailure`'s, not a local copy. It was
 * one for a while: this module fixed the `$metadata`-presence defect before the
 * shared helper could, and carried its own three-arm predicate with a comment
 * saying why. Issue [#3297](https://github.com/go-to-k/cdkd/issues/3297) fixed
 * the helper and deleted the duplicate, so one error can no longer be
 * classified two ways. The measurements behind those arms -- what smithy stamps
 * and on what, why credential resolution carries neither signal, and which
 * `*ProviderError` siblings are deliberately left raw -- live with the
 * predicate now, in `aws-failure-text.ts`.
 */
export function describePollFailure(error: unknown): PollFailureText {
  if (error === undefined) return { display: '', detail: '', marker: false };

  if (!(error instanceof Error)) {
    // A non-`Error` rejection is WITHHELD but still REPORTED.
    // `isTransientPollFailure` duck-types `code` / `name` / `message` off any
    // object, so such a throw IS admitted and spends the grace -- and an
    // earlier revision then rendered an abandonment stating no reason at all.
    // `summary` names the TYPE and never the value. `detail` is
    // `String(value)`, which for a plain object is `[object Object]` -- so for
    // this shape the value reaches NEITHER channel, and that is a measured cost
    // rather than an oversight: a shape with no class to fall back on is the
    // one with the fewest guarantees about what is inside it. No marker either:
    // nothing is threaded as `cause`, the precondition's other half.
    const other = describeAwsFailure(error);
    return { display: other.summary, detail: other.detail, marker: false };
  }

  // `describeAwsFailure`'s OWN authorship test, not a local copy of it. The two
  // were the same three arms spelled twice, because this module fixed the
  // predicate before the shared helper did; issue
  // [#3297](https://github.com/go-to-k/cdkd/issues/3297) fixed the helper and
  // deleted the duplicate, so one error can no longer be classified two ways.
  const described = describeAwsFailure(error);

  if (!described.redacted) {
    // Transport wording is KEPT -- it names a host, never a caller -- and
    // nothing is withheld, so there is no `debug` line to emit and no marker.
    return { display: error.message, detail: '', marker: false };
  }

  // An EMPTY message reduces to NOTHING, not to a pointer at nothing:
  // `asSdkError` normalizes a non-`Error` rejection that crosses the retry
  // middleware into `Object.assign(new Error(), obj)`, and rendering that
  // through the summary builder yields `Error. Re-run with --verbose for AWS's
  // own message.` -- an instruction to go and read an empty string.
  if (error.message === '') return { display: '', detail: '', marker: false };

  // `described.summary` now, not a hand-built one: the helper's authorship test
  // IS this function's, so the two can no longer disagree about the credential
  // case and there is nothing left for a local spelling to win.
  return {
    display: described.summary,
    detail: described.detail,
    marker: true,
  };
}

/**
 * True when a `GetResourceRequestStatus` call failed for a reason that says
 * nothing about the OPERATION — the poll could not be delivered or answered,
 * so re-polling the same token is the correct response.
 *
 * Fail-CLOSED: an unmodelled shape answers false, so the wait is not RETRIED.
 * It is still ABANDONED rather than aborted bare — the caller carries the
 * request token out on that arm too, since losing the handle is issue #3236's
 * defect whatever the trigger. The safe direction here is about retrying, not
 * about reporting: the errors this must NOT absorb are the ones a retry can
 * only re-derive —
 * `RequestTokenNotFoundException` (the token is genuinely gone),
 * `AccessDeniedException`, `ValidationException`.
 *
 * Throttles and transient 5xx are in scope alongside transport, and not as a
 * generalization for its own sake: they are the same defect with a different
 * trigger, and the throttle case is the WORSE of the two today. The abort
 * is retryable by BOTH routes the classifier offers — `isThrottlingError`'s
 * chain walk over the threaded cause, and (before the cause is reduced to its
 * wire code) AWS's own `Rate exceeded` wording against
 * `RETRYABLE_ERROR_MESSAGE_PATTERNS` — so the deploy engine's outer `withRetry`
 * re-invokes `create()` and duplicates a resource that is already being created
 * (go-to-k/cdkd#2039), where the transport case merely loses track of one.
 * Measured, not assumed: `isRetryableTransientError` answers true for a
 * throttle and false for `connect ECONNREFUSED ...`.
 *
 * The message arm exists for a wrapper that dropped `.code` while keeping the
 * text. It is scoped by its SOURCE — the only input is an error thrown by the
 * SDK out of `cloudControlClient.send`, never template- or user-authored text
 * — so an `E`-prefixed token there denotes a socket error rather than
 * something a user happened to type.
 */
export function isTransientPollFailure(error: unknown): boolean {
  if (isThrottlingError(error) || isTransientServerError(error)) return true;

  let current: unknown = error;
  for (let depth = 0; depth < POLL_CAUSE_CHAIN_DEPTH && current != null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && POLL_TRANSPORT_ERROR_CODES.has(code)) return true;

    const name = (current as { name?: unknown }).name;
    if (typeof name === 'string' && POLL_TRANSPORT_ERROR_NAMES.has(name)) return true;

    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string' && POLL_TRANSPORT_CODE_IN_MESSAGE.test(message)) return true;

    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Matches service-worded "the resource is gone" failure messages, including
 * shapes whose wording lacks the canonical `not found` substring (CodeDeploy:
 * "No Deployment Group found for name: ..."). Deliberately scoped to the
 * failed-CREATE remnant-cleanup path, where a false positive only downgrades
 * a warning to an info — it is NOT used for the main DELETE idempotency
 * decision, which reads only the structured `ErrorCode: NotFound` /
 * `ResourceNotFoundException` signals (issues #1252, #5225; see
 * {@link isCcDeleteGoneError}).
 */
export function isNotFoundMessage(message: string): boolean {
  return /not\s*found|does\s*not\s*exist|no\s*such|non\s*existent|\bno\b[^.;:]{0,80}\bfound\b/i.test(
    message
  );
}

/**
 * Whether a failure of `deleteThroughCloudControl`'s delete says THIS
 * resource is gone (issue #5225). Returning true drops the state record.
 *
 * Only typed signals count: the handler's `ErrorCode: NotFound` on a FAILED
 * DELETE event, `DeleteResource`'s own `ResourceNotFoundException`, and, on
 * the EC2 volume path (`volumePath`), `DeleteVolume`'s
 * `InvalidVolume.NotFound`. Message prose never counts. The message holds the
 * handler's `StatusMessage`, which can name a missing DEPENDENCY ("subnet ...
 * not found") under a non-`NotFound` code, and it holds the logical id.
 * `TypeNotFoundException` names the registry TYPE, never the resource.
 *
 * Before #5225 the arm also matched `does not exist` / `not found` /
 * `NotFound` in the message. Those needles date from the first commit, and no
 * handler was ever recorded as needing them. #1252 went the other way: the
 * needles MISSED a gone resource, so it added the typed `NotFound` code.
 * An abandoned wait is never gone (issue #3236), whatever its class.
 */
export function isCcDeleteGoneError(error: unknown, volumePath: boolean): boolean {
  if (isWaitAbandonedError(error)) return false;
  if (error instanceof CloudControlOperationFailedError) {
    return error.ccOperation === 'DELETE' && error.ccErrorCode === 'NotFound';
  }
  const name = (error as { name?: unknown } | null | undefined)?.name;
  if (volumePath) return name === 'InvalidVolume.NotFound';
  return name === 'ResourceNotFoundException';
}

/**
 * Mark a delete failure NOT GONE when its message holds a phrase the
 * downstream already-deleted classifiers match (issues #5225, #5228):
 * `deploy-engine/delete.ts`, `deploy-engine/update-in-place.ts` and
 * `destroy-runner.ts`. `NotFound` covers `NotFoundException` and
 * `ResourceNotFoundException`; `not found` covers `was not found`. Those
 * classifiers check `isMarkedNotGone` before their substring test. Without
 * the mark, a failure that {@link isCcDeleteGoneError} kept would be read as
 * "already deleted" one level up, and the record dropped there.
 *
 * Retryability is untouched: a throttle on a resource whose logical id
 * spells `NotFound`, or a `Policy Error: PrincipalNotFound` propagation race,
 * keeps its retries and, once they run out, is still not read as gone. An
 * abandoned wait carries its own marker, which every downstream classifier
 * refuses, so it needs no second one.
 */
export function markNotGoneOnNeedle(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const message = error.message;
  if (
    !isWaitAbandonedError(error) &&
    (message.includes('does not exist') ||
      message.includes('not found') ||
      message.includes('NotFound') ||
      message.includes('No policy found') ||
      message.includes('NoSuchEntity'))
  ) {
    return markNotGone(error);
  }
  return error;
}
