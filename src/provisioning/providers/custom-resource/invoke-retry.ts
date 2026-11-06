import type { CustomResourceProvider } from '../custom-resource-provider.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { displaySafe, safeMsg } from '../../../utils/display-safe.js';
import { UNRENDERABLE } from '../../../state/lock-contention-message.js';
import {
  CR_S3_ENDPOINT_ENV,
  customResourceS3Endpoint,
  responsePresignClient,
  warnIfNodeHandlersCannotRespond,
  type CustomResourceS3Endpoint,
} from '../custom-resource-response-endpoint.js';
import {
  withRetry,
  IAM_PROPAGATION_INITIAL_DELAY_MS,
  IAM_PROPAGATION_MAX_DELAY_MS,
} from '../../../deployment/retry.js';
import { startInterruptWatch, type InterruptWatch } from '../../interrupt-watch.js';
import { CUSTOM_RESOURCE_RESPONSE_PREFIX } from '../../../state/state-prefix.js';
import { ensureCustomResourceResponseExpirationOnce } from '../../../state/state-bucket-lifecycle.js';
import {
  isIamPropagationError,
  isMarkedNonRetryable,
  markNonRetryable,
} from '../../../deployment/retryable-errors.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import {
  type CfnCustomResourceResponse,
  asSentence,
  decodeInvokeLogTail,
} from './lambda-payload.js';
import {
  CR_TRANSIENT_AUTHZ_SIGNALS,
  CR_THROWN_AUTHZ_EXTRA_SIGNALS,
  CR_TRANSIENT_AUTHZ_LOG_SIGNALS,
  CR_LOG_TAIL_WARN_MAX_CHARS,
  CR_ERROR_CAUSE_MAX_DEPTH,
  customResourceRetryDelays,
} from './retry-policy.js';
import { hasHandlerLogOutput } from './response-body.js';

/**
 * Invoke a custom resource, retrying on a *transient IAM-authorization*
 * FAILED response.
 *
 * Why this exists: cdkd's fast SDK path attaches a backing Lambda's
 * execution-role inline policy and invokes the function ~1s later. If IAM has
 * not propagated the policy to the assumed-role session by the function's
 * first cold start, the session caches stale (policy-less) credentials for
 * the warm container's whole life — so the CDK Provider framework's
 * `lambda:GetFunction` / initial invoke 403s ("not authorized to perform" /
 * "not in the state functionActive") and the custom resource FAILS.
 * CloudFormation never hits this because its deployment latency lets IAM
 * settle first. This is the CR-path analogue of the IAM-propagation retry
 * cdkd's `withRetry` already applies to every other resource type — the CR
 * provider opts out of that outer retry (`disableOuterRetry`) to avoid
 * stranding a pre-signed response URL at an S3 key nobody polls, so we retry
 * HERE, deriving a FRESH response URL + RequestId per attempt (via
 * `prepareInvocation()`) and recycling the backing function's execution
 * environment between tries so its next cold start re-assumes the role.
 *
 * **The loop covers TWO error shapes** (issue #2033). The original one is the
 * handler's RETURNED `Status: 'FAILED'`. The second is an error THROWN by one
 * of the provider's OWN SDK calls before the request reached the handler —
 * which used to leave `create()` directly, because the loop body had no
 * `try` / `catch` at any point, making every such call single-shot while every
 * other resource type got the outer `withRetry`'s 26 attempts for the identical
 * wording. The `delivered` flag below is what keeps the second arm honest: it
 * flips the moment `Invoke` / `Publish` RETURNS, and a throw after that point
 * is rethrown untouched no matter how transient it reads, because the handler
 * is running and will PUT to THIS attempt's response URL. See
 * {@link CustomResourceProvider.disableOuterRetry} for the whole per-call
 * table, and {@link CustomResourceProvider.isTransientAuthzThrow} for why a
 * PRE-delivery throw is safe to replay at all.
 *
 * `buildRequest` is called once per attempt with the fresh invocation so the
 * CFn request body always carries the matching ResponseURL / RequestId. The
 * synthetic `StackId` rides the same bag although it is stable across
 * attempts (issue #1866), for an ORDERING reason rather than a freshness one:
 * resolving it needs an `await`, and every await before the SIGINT watch
 * below is installed is a window in which Ctrl-C is dead — `docs/
 * provider-development.md` requires a new wait site to be interruptible, and
 * the pre-delivery backoff this method owns is 47.75s long.
 *
 * Returns the final response; the caller decides what a terminal FAILED means
 * (create / update throw; delete warns and returns `'skipped'` — issue
 * #2054, which replaced its warn-and-continue).
 */
export async function invokeCustomResourceWithRetry(
  this: CustomResourceProvider,
  serviceToken: string,
  logicalId: string,
  operation: string,
  buildRequest: (invocation: {
    requestId: string;
    responseKey: string;
    responseURL: string;
    stackId: string;
  }) => Record<string, unknown>,
  mask: MaskerFn | undefined,
  referenced?: {
    properties: Record<string, unknown>;
    previousProperties?: Record<string, unknown>;
  }
): Promise<CfnCustomResourceResponse> {
  // One watch for the whole invocation, disposed in the `finally` below, so
  // Ctrl-C aborts a 47.75s pre-delivery backoff and the placeholder
  // `PutObject`'s own retry schedule instead of sitting them out.
  const watch = startInterruptWatch(`Custom resource ${logicalId}`);
  // Masked BEFORE truncation, so a cut cannot leave half a needle: the
  // handler's reason and log can echo the payload (go-to-k/cdkd#4682).
  const shown = (text: string): string => (mask === undefined ? text : mask(text));
  try {
    // Resolved ONCE per call, and deliberately AFTER the watch above: the
    // value does not vary between attempts. It REJECTS when STS cannot name
    // the account (issue #1730), before any invocation: create / update
    // fail, and delete — after a bounded re-ask — reports the resource
    // `skipped` and keeps it.
    const stackId = await this.resolveSyntheticStackId(logicalId, operation, watch);
    // Once per call, never per attempt: a retry re-invokes the handler, not the
    // functions its properties name. Create / update only (delete passes none).
    if (referenced !== undefined) {
      await this.waitForReferencedLambdasActive(
        logicalId,
        serviceToken,
        referenced.properties,
        referenced.previousProperties,
        watch,
        mask
      );
    }
    // Two budgets, counted SEPARATELY (issue #2033). Sharing the loop counter
    // would let a pre-delivery throw consume the FAILED-response arm's budget
    // — with the arms on 26 and 2, three thrown retries would silently leave
    // the handler's own transient-authz FAILED un-retried, which is the
    // behavior this provider shipped with before the thrown arm existed.
    let preDeliveryRetries = 0;
    let failedResponseRetries = 0;

    for (let attempt = 0; ; attempt++) {
      // Flipped by `sendRequest` the instant `Invoke` / `Publish` returns. Read
      // ONLY by the catch below, and re-declared per attempt so a previous
      // attempt can never vouch for this one.
      let delivered = false;
      let cfnResponse: CfnCustomResourceResponse;
      let logResult: string | undefined;
      // Hoisted out of the `try` so the catch can sweep the placeholder object
      // this attempt minted. Without it every replayed attempt leaves an empty
      // object behind in the state bucket, and nothing else collects them —
      // `cdkd gc` scans the ASSET bucket, not this prefix.
      let invocation: { requestId: string; responseKey: string; responseURL: string } | undefined;

      try {
        invocation = await this.prepareInvocation(logicalId, watch, mask);
        const request = buildRequest({ ...invocation, stackId });

        this.logger.debug(
          `Sending custom resource ${operation.toLowerCase()} request: ${serviceToken}`
        );

        const sent = await this.sendRequest(
          serviceToken,
          request,
          invocation.responseKey,
          logicalId,
          operation,
          () => {
            delivered = true;
          },
          mask
        );
        cfnResponse = sent.response;
        logResult = sent.logResult;
      } catch (error) {
        if (
          delivered ||
          preDeliveryRetries >= this.preDeliveryAuthzMaxRetries ||
          !this.isTransientAuthzThrow(error)
        ) {
          throw error;
        }
        // No exec-env recycle here, unlike the FAILED-response arm: every
        // rejection `isTransientAuthzThrow` admits is decided before the
        // handler can run -- no environment was ever created -- so there is
        // no warm container holding stale credentials to invalidate. The deploying principal's
        // `lambda:InvokeFunction` / `s3:PutObject` denial is the common case,
        // but the rationale is not "whose permission" -- a VPC-networking
        // rejection about the function's own role (issue #3227) arrives here
        // too, and likewise created no environment. And
        // `UpdateFunctionConfiguration` would need the very permissions that
        // may still be propagating.
        const delayMs = Math.min(
          IAM_PROPAGATION_INITIAL_DELAY_MS * Math.pow(2, preDeliveryRetries),
          IAM_PROPAGATION_MAX_DELAY_MS
        );
        // The class at warn, AWS's sentence at debug (go-to-k/cdkd#2319):
        // an `AccessDeniedException` names the caller's assumed-role ARN,
        // which the masker does not cover.
        const failure = describeAwsFailure(error);
        this.logger.warn(
          `Custom resource ${operation} for ${logicalId} hit a transient IAM-authorization error ` +
            `before the request was delivered (attempt ${attempt + 1}/${this.preDeliveryAuthzMaxRetries + 1}): ` +
            `${asSentence(this.truncateReason(shown(failure.summary)))} ` +
            `Retrying in ${delayMs / 1000}s with a fresh response URL and RequestId.`
        );
        if (failure.redacted) {
          this.logger.debug(
            `Custom resource ${operation} for ${logicalId} pre-delivery failure detail: ${shown(failure.detail)}`
          );
        }
        // Best-effort, and BEFORE the sleep so an interrupt cannot skip it.
        // The next attempt signs a fresh key, so this one is unreachable.
        if (invocation !== undefined) {
          await this.cleanupResponseObject(invocation.responseKey);
        }
        preDeliveryRetries += 1;
        await this.sleepInterruptibly(delayMs, watch);
        continue;
      }

      // The reason string is the primary signal; the invocation log tail is the
      // fallback for a handler that swallowed the authz wording (issue #1674).
      // Only scanned on FAILED — the happy path must not pay for it.
      const reasonIsAuthz =
        cfnResponse.Status === 'FAILED' && this.isTransientAuthzFailure(cfnResponse.Reason);
      // Decoded ONCE and only on the branch that can consume it: both the signal
      // scan below and the unexplained-failure arm further down read this.
      const logTail =
        cfnResponse.Status === 'FAILED' && !reasonIsAuthz
          ? decodeInvokeLogTail(logResult)
          : undefined;
      const logAuthzMatch =
        logTail === undefined ? undefined : this.findTransientAuthzLogLine(logTail);

      if (
        cfnResponse.Status === 'FAILED' &&
        failedResponseRetries < this.transientAuthzMaxRetries &&
        (reasonIsAuthz || logAuthzMatch !== undefined)
      ) {
        failedResponseRetries += 1;
        this.logger.warn(
          `Custom resource ${operation} for ${logicalId} returned a transient IAM-authorization FAILED ` +
            `(attempt ${attempt + 1}/${this.transientAuthzMaxRetries + 1}): ${this.truncateReason(cfnResponse.Reason === undefined ? undefined : shown(cfnResponse.Reason))}. ` +
            (logAuthzMatch === undefined
              ? ''
              : `The handler's reason carried no authorization wording; the denial was found in the backing function's log: ${this.truncateReason(shown(logAuthzMatch.line))}. `) +
            `Recycling the backing function's execution environment and retrying so its next cold start picks up the propagated policy.`
        );
        await this.recycleBackingFunctionExecEnv(serviceToken, logicalId, mask);
        continue;
      }

      // Terminal FAILED whose reason hides an authorization denial: annotate the
      // reason so the finding reaches every consumer — the create / update
      // throw, the delete skip's warning (issue #2054; it was a
      // warn-and-continue when this note was written), and the `deployments/` record
      // `cdkd events` replays. Surfacing it only in a log line would leave the
      // post-mortem record pointing at CloudWatch, which is the complaint issue
      // #1674 filed.
      //
      // What is folded in is the matched SIGNAL PHRASE — one of the fixed
      // `CR_TRANSIENT_AUTHZ_LOG_SIGNALS` strings, authored by cdkd — and NOT the
      // verbatim log line. Two reviewers independently rejected the verbatim
      // form and were right: a `Reason` reaches `extractDeploymentEventError`
      // and is persisted to `deployments/{runId}.jsonl`, which outlives
      // `cdkd destroy` and is contractually error + metadata, never anything
      // that may carry secrets. An ordinary handler line such as
      // `logger.error(f"AccessDenied writing {event}")` is arbitrary handler
      // stdout, and truncating it to 200 chars bounds the VOLUME, not the
      // CLASS — 200 chars is precisely where a dumped `ResourceProperties`
      // begins. The earlier "the reason is already handler-authored text"
      // defence does not transfer either: a reason is text the handler CHOSE to
      // hand to CloudFormation, a log line is text it wrote for itself.
      // The verbatim line still reaches the operator, in the ephemeral warn
      // above and in the `FunctionError` arm's warn.
      if (cfnResponse.Status === 'FAILED' && logAuthzMatch !== undefined) {
        return {
          ...cfnResponse,
          Reason:
            `${cfnResponse.Reason ?? 'Unknown reason'} ` +
            `[cdkd: the reason carried no authorization wording, but the backing function's ` +
            `invocation log matched the IAM-authorization signal "${logAuthzMatch.signal}" — ` +
            `see the cdkd warning for the log line, or the function's CloudWatch log group]`,
        };
      }

      // Terminal FAILED that NOTHING explained (issue #1687): the reason carried
      // no authz wording and the log matched no signal either, so this is the
      // 404 / traceback / JSON-decode class. #1674 fixed the diagnostic only for
      // the authz subset; for everything else cdkd had decoded the tail and then
      // thrown it away, leaving the user with `returned non-zero exit status 1.`
      // and a trip to CloudWatch — literally the second half of what #1674
      // reported.
      //
      // EPHEMERAL and capped, never folded into the reason: a reason is
      // persisted to `deployments/{runId}.jsonl`, which outlives `cdkd destroy`
      // and is contractually free of anything that may carry secrets, and a log
      // tail is arbitrary handler stdout. That is the same data-class split the
      // `FunctionError` arm makes — this is its FAILED-path twin.
      // `reasonIsAuthz` is excluded on purpose: there the reason ALREADY names
      // the cause (that is the #756 path), so dumping the tail beside it is
      // noise on a failure that is already explained. The `logAuthzMatch` case
      // has returned above for the same reason.
      //
      // Two things the WORDING has to be honest about, because this arm asserts
      // a causal link the signal arm does not:
      //   - cdkd only knows the reason matched no authz signal. The reason may
      //     be perfectly informative, so this does not claim it was useless.
      //   - the tail belongs to the DISPATCH invoke. For a handler that works
      //     inline that IS where the failure happened, but for the CDK Provider
      //     framework's async pattern the FAILED arrives from `pollS3Response`
      //     and was authored by a LATER Step-Functions-driven execution, whose
      //     log this is not. On the signal path that mismatch costs only a
      //     redundant retry; here it would present an unrelated log as THE
      //     explanation, so the message names which invocation it came from and
      //     lets the reader judge.
      if (logTail !== undefined && hasHandlerLogOutput(logTail)) {
        this.logger.warn(
          `Custom resource ${operation} for ${logicalId} failed and cdkd could not classify ` +
            `the reason. Log tail from the DISPATCH invocation (for the CDK Provider ` +
            `framework's async pattern the failure may have occurred in a later execution, ` +
            `whose log this is not):\n` +
            this.truncateReason(shown(logTail), CR_LOG_TAIL_WARN_MAX_CHARS)
        );
      }

      return cfnResponse;
    }
  } finally {
    watch.dispose();
  }
}

/**
 * Classify a custom resource FAILED reason as a transient IAM-authorization
 * race (worth retrying).
 *
 * Deliberately NARROW — only the IAM-permission-not-yet-effective signals,
 * NOT cdkd's broad transient classifier (`isRetryableTransientError`, which
 * also matches throttling / generic timeouts). A custom resource that FAILED
 * for an unrelated reason (user handler bug, a real timeout, a downstream API
 * error) must NOT be re-invoked — that would mask genuine failures and waste
 * the framework's ~minutes-long waiter per attempt. These phrases are the
 * IAM-authz subset of cdkd's `RETRYABLE_ERROR_MESSAGE_PATTERNS`, plus the CDK
 * Provider framework's `waitUntilFunctionActive` state phrasing.
 */
export function isTransientAuthzFailure(
  this: CustomResourceProvider,
  reason: string | undefined
): boolean {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  return CR_TRANSIENT_AUTHZ_SIGNALS.some((p) => lower.includes(p));
}

/**
 * Classify an error THROWN by one of the provider's own SDK calls as a
 * transient IAM-authorization race worth replaying (issue #2033).
 *
 * The list is cdkd's shared `IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS` — the
 * same one every other resource type is classified with, via `withRetry` —
 * plus {@link CR_THROWN_AUTHZ_EXTRA_SIGNALS}, the two CR-specific spellings
 * the shared list does not carry in any form. That is deliberately WIDER than
 * the FAILED-reason classifier, and the asymmetry is the whole point: this
 * text was written by AWS about a call CDKD made, whereas a FAILED reason was
 * written by the user's handler about a call IT made. See
 * {@link CR_TRANSIENT_AUTHZ_SIGNALS} for the full argument, including why the
 * bare `is unable to assume` spelling stays on that side of the line.
 *
 * **Two REFUSALS come before any pattern**, and each closes a way for a
 * single call to be given two retry budgets:
 *
 *  - `isMarkedNonRetryable` — cdkd's own declaration that this raising cannot
 *    succeed on a replay. Both of the provider's already-retried calls stamp
 *    it: the placeholder `PutObject` after its `withRetry` is exhausted, and
 *    `waitForBackingLambdaReady` after the SDK waiter has polled for its full
 *    600s. The marker rather than the wording is what makes the second one
 *    sound: `@smithy/util-waiter` serializes `observedResponses` into its
 *    TIMEOUT message and those keys read
 *    `403: User: … is not authorized to perform: lambda:GetFunction …`, so a
 *    PERMANENT denial matched every pattern here and a message-shaped fence
 *    would be one AWS wording change from failing open. It also refuses a
 *    cdkd-authored REFUSAL whose text happens to carry an authz phrase.
 *  - the `.cause` chain is WALKED (bounded), matching `isThrottlingError` /
 *    `isMarkedNonRetryable`. cdkd wraps SDK errors routinely, and issue #2040
 *    documents the drop-`cause` class in this very directory; a top-level-only
 *    read would silently un-retry a wrapped propagation denial.
 *
 * **Replaying an `Invoke` is safe here because every rejection this admits
 * is decided before the handler can run, so the handler provably did not run.**
 * Nearly every pattern in the union is an AUTHORIZATION or
 * REQUEST-VALIDATION rejection, decided at the API front door, before any
 * execution environment is engaged -- the commonest way to satisfy that, but
 * not the only one (see below). Either way a replay cannot re-deliver work —
 * the hazard `disableOuterRetry` exists for.
 *
 * The union is shared, so it can acquire a member that is NOT front-door, and
 * one already has: the Lambda CapacityProvider operator-role rejection added
 * for issue #3174 is emitted by a Cloud Control RESOURCE HANDLER, i.e. after
 * its own request was accepted. It is inert here only because no CR `Invoke`
 * failure carries that text. Do NOT discharge the next such entry against
 * `delivered`: `onDelivered()` runs after `invokeLambda` RESOLVES, so a throw
 * between acceptance and resolution — the exact window a post-acceptance
 * rejection arrives in — reaches this classifier with the flag still false.
 * Front-door-ness is therefore a property each entry owes, not one the shared
 * list confers, and it is judged ON THIS PATH: a wording that is
 * post-acceptance where it originates is admissible if it cannot reach a CR
 * `Invoke` / `Publish` failure at all, OR if the only `Invoke` / `Publish`
 * rejection that could carry it is itself decided before the handler can run.
 * BOTH replayed calls are in scope: this classifier gates the SNS `Publish`
 * replay as well as the Lambda `Invoke` one, so an argument about `Invoke`
 * alone does not admit an entry. The issue #3227 entries rest on the second
 * arm for `Invoke` -- `EC2AccessDeniedException` /
 * `InvalidSecurityGroupIDException` are raised when Lambda cannot set up VPC
 * networking, during setup and before the handler can run -- and on the
 * first for `Publish`, which carries no Lambda VPC-networking text at all.
 * The argument must cover the whole matched substring. The
 * literal-set fence in `custom-resource-provider-thrown-retry.test.ts`
 * enforces that an entry arrives examined, and carries the ledger.
 *
 * It is also why this classifier deliberately does NOT reach for the broader
 * `isRetryableTransientError`: a throttle, an HTTP 5xx or a socket timeout can
 * each arrive AFTER the request was accepted, so replaying one could invoke a
 * non-idempotent handler twice. Those classes stay single-shot on this path by
 * design, and the caller's `delivered` flag is the second, independent fence
 * for a delivery that COMPLETED — the case it can observe.
 */
export function isTransientAuthzThrow(this: CustomResourceProvider, error: unknown): boolean {
  if (isMarkedNonRetryable(error)) return false;

  let current: unknown = error;
  for (let depth = 0; depth < CR_ERROR_CAUSE_MAX_DEPTH && current != null; depth++) {
    // Only an `Error`'s message or a thrown string is text cdkd can
    // classify. Anything else stringifies to `[object Object]`, which
    // matches no pattern anyway, so it is skipped rather than coerced.
    const message =
      current instanceof Error ? current.message : typeof current === 'string' ? current : '';
    if (message !== '') {
      // The shared list is mixed-case and matched verbatim; the CR extras are
      // lower-cased substrings and matched against a lower-cased message.
      const lower = message.toLowerCase();
      if (
        isIamPropagationError(message) ||
        CR_THROWN_AUTHZ_EXTRA_SIGNALS.some((p) => lower.includes(p))
      ) {
        return true;
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Find the IAM-authorization denial inside a backing function's invocation
 * log tail, for the case the FAILED reason itself carries none (issue #1674).
 *
 * Returns the FIRST matching log LINE rather than a boolean, so the caller can
 * put the denial the handler swallowed into its message — today the user has
 * to open CloudWatch to discover that `returned non-zero exit status 1` was a
 * 403 on the asset object. The line is returned verbatim (the caller
 * truncates); only the MATCH is case-insensitive.
 *
 * Absent for an SNS-backed custom resource — no Lambda invoke, so no tail.
 *
 * **Known bound.** The tail always belongs to the DISPATCH invoke. For a
 * handler that does its work inline and PUTs the cfn-response itself (CDK's
 * `BucketDeployment` — the case this exists for), that IS where the failure
 * happened. For the CDK Provider framework's genuinely async pattern it is
 * NOT: the failure happens later, in a Step-Functions-driven handler, so a
 * stray denial logged by the `onEvent` wrapper can buy a bounded extra retry
 * with a message pointing at the wrong execution. That path is otherwise
 * covered by the reason string, which the framework populates from the
 * underlying error, so the cost is redundancy rather than a wrong answer.
 *
 * Suppressing the tail for the async pattern is NOT the fix, and the reason
 * is worth recording: `isAsyncPattern` in `getCustomResourceResponse` means
 * only "the invoke returned no direct payload", which is equally true of
 * `BucketDeployment` — its Python handler returns `None`. Gating on it would
 * switch off exactly the case this feature exists for.
 */
export function findTransientAuthzLogLine(
  this: CustomResourceProvider,
  logTail: string | undefined
): { line: string; signal: string } | undefined {
  if (!logTail) return undefined;
  for (const line of logTail.split('\n')) {
    const lower = line.toLowerCase();
    const signal = CR_TRANSIENT_AUTHZ_LOG_SIGNALS.find((p) => lower.includes(p));
    if (signal !== undefined) {
      return { line: line.trim(), signal };
    }
  }
  return undefined;
}

/** Truncate a CR FAILED reason for log readability. */
export function truncateReason(
  this: CustomResourceProvider,
  reason: string | undefined,
  max = 200
): string {
  // `displaySafe` for the same reason the poll line uses it, and this channel
  // is the LOUDER one: every consumer of this helper interpolates the result
  // into `logger.warn`, which is not gated by `--verbose`, and its inputs are
  // the handler-authored `Reason` and the Lambda `logTail` -- the same
  // untrusted document the poll line reads. Sanitising the quiet channel
  // while leaving this one raw would have moved the problem rather than
  // closed it. Sliced AFTER sanitising, so truncation cannot re-expose an
  // escape that the sanitiser had neutralised.
  const r = displaySafe(reason ?? 'Unknown reason');
  return r.length > max ? `${r.slice(0, max)}...` : r;
}

/**
 * Generate a pre-signed S3 PUT URL for Lambda to send its response
 */
export async function generateResponseURL(
  this: CustomResourceProvider,
  responseKey: string,
  logicalId: string,
  watch: InterruptWatch,
  mask: MaskerFn | undefined
): Promise<string> {
  if (!this.responseBucket) {
    // Fallback: return a dummy URL (legacy behavior)
    return 'https://localhost/cfn-response-not-configured';
  }

  // Read (and validate) `CDKD_CR_S3_ENDPOINT_URL` BEFORE the placeholder
  // PUT, so a malformed value refuses without leaving an object behind.
  let signingEndpoint: CustomResourceS3Endpoint | undefined;
  try {
    signingEndpoint = customResourceS3Endpoint();
  } catch (error) {
    throw markNonRetryable(error as Error);
  }

  // The pre-signed URL's host is region-specific: sign against the bucket's
  // ACTUAL region, not the deploy region (issue #1195).
  await this.ensureResponseClient();

  // Create an empty placeholder object first (so the key exists for cleanup).
  //
  // This is the one AWS call in the whole invocation path that is BOTH
  // pre-delivery and fully idempotent — an empty PUT at a key cdkd minted one
  // line ago, touching nothing in the response-URL lifecycle — so it gets the
  // shared `withRetry` and, with it, the same dense IAM-propagation schedule
  // (0.25s -> 0.5s -> 1s -> 2s ..., 47.75s) every other resource type gets.
  // Until issue #2033 it was single-shot: a `s3:PutObject` denial while the
  // deploying principal's freshly-attached state-bucket policy was still
  // propagating failed the resource on attempt 0.
  //
  // The exhausted throw is `markNonRetryable`d so the invoke loop's own
  // pre-delivery arm does NOT re-enter with a second budget: without that,
  // one `s3:PutObject` denial cost 26 retries here x 26 attempts out there,
  // while this JSDoc claimed the call had "its OWN budget".
  //
  // `isInterrupted` / `onInterrupted` are threaded per
  // `docs/provider-development.md`: a new `withRetry` that omits them leaves
  // Ctrl-C dead for the whole 47.75s schedule.
  const bucket = this.responseBucket;
  // Issue #2353: give an already-bootstrapped state bucket the expiration
  // rule for responses. Memoized per process, so only the FIRST response this
  // process writes starts it (one GET, plus a listing and one PUT the first
  // time), and it is NOT awaited: no custom resource waits on it, and Ctrl-C
  // is not held by it. The promise never rejects; a missing lifecycle
  // permission is a warning. Skipped for a non-default `responsePrefix`,
  // which the rule does not name.
  if (this.responsePrefix === CUSTOM_RESOURCE_RESPONSE_PREFIX) {
    void ensureCustomResourceResponseExpirationOnce(this.s3Client, bucket, this.logger);
  }
  try {
    await withRetry(
      () =>
        this.s3Client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: responseKey,
            Body: '',
            ContentLength: 0,
            ContentType: 'application/json',
          })
        ),
      `${logicalId} (custom-resource response placeholder)`,
      {
        logger: this.logger,
        isInterrupted: watch.isInterrupted,
        onInterrupted: watch.onInterrupted,
        sleep: customResourceRetryDelays.sleep,
      }
    );
  } catch (error) {
    if (error instanceof Error) throw markNonRetryable(error);
    // A non-`Error` rejection is withheld like the create / update wrap
    // withholds it (go-to-k/cdkd#2319): a plain `Error` built from its text
    // would read as cdkd-authored and reach the persisted message.
    const failure = describeAwsFailure(error);
    this.logger.debug(
      maskerOrIdentity(mask)(`Response placeholder PutObject failure detail: ${failure.detail}`)
    );
    throw markNonRetryable(new Error(failure.summary));
  }

  // Generate pre-signed PUT URL (valid for 2 hours to accommodate async Provider framework
  // patterns where Step Functions may poll isCompleteHandler for up to 1 hour)
  // Don't specify ContentType so any Content-Type is accepted (cfn-response may send different types)
  const command = new PutObjectCommand({
    Bucket: this.responseBucket,
    Key: responseKey,
  });

  // `CDKD_CR_S3_ENDPOINT_URL` signs for the endpoint the Lambda can reach,
  // with the (region-corrected) response client's region and credentials.
  // The host is part of the signature, so it is signed for, never rewritten.
  let signer = this.s3Client;
  if (signingEndpoint !== undefined) {
    signer = await responsePresignClient(this.s3Client, signingEndpoint);
    warnIfNodeHandlersCannotRespond(signingEndpoint, this.logger);
    // The origin only: the URL itself is a bearer credential.
    this.logger.debug(
      safeMsg`Signing the custom resource ResponseURL for ${CR_S3_ENDPOINT_ENV} (${signingEndpoint.origin})`
    );
  }
  const presignedUrl = await getSignedUrl(signer, command, {
    expiresIn: 7200,
  });

  // The SIBLING of the `cleanupResponseObject` line below, found by the issue
  // [#2635] sweep rather than named by the issue: it renders the same two
  // values (`responseBucket`, and a `responseKey` carrying a
  // provider-supplied request id) into the same kind of debug line, so
  // sanitizing one and not the other is the one-of-N widening
  // `src/utils/display-safe.ts`'s header exists to stop.
  this.logger.debug(
    `Generated pre-signed URL for response: s3://${
      displaySafe(this.responseBucket, { asciiOnly: true }) || UNRENDERABLE
    }/${displaySafe(responseKey)}`
  );
  return presignedUrl;
}
