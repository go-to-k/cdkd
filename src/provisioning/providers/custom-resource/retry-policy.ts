import { LAMBDA_FUNCTION_ARN } from './lambda-waiter.js';

/**
 * IAM-authorization-propagation signals in a custom resource FAILED reason that
 * indicate the backing Lambda's freshly-attached execution-role policy has not
 * yet taken effect for its assumed-role session (so a recycle + retry will
 * succeed once IAM settles). Lowercase substrings. Intentionally narrow — these
 * are the IAM-permission-not-yet-effective phrases only, NOT generic transient
 * errors (throttling / timeouts), which must not trigger a CR re-invoke.
 *
 * **This set is deliberately NARROWER than
 * `IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS` (`src/deployment/retryable-errors.ts`)
 * and stays that way** (issue
 * [#2033](https://github.com/go-to-k/cdkd/issues/2033), which asked whether the
 * narrowing was still intended or a list that had stopped tracking its
 * counterpart).
 *
 * "Narrower", not "a subset" — an earlier revision of this comment said SUBSET
 * and that was FALSE of the list beside it. Three of these six entries appear
 * in no form in the shared list (`no identity-based policy allows`, both
 * `not in the state functionActive` spellings), and a fourth appears there only
 * ANCHORED: the shared list carries `Firehose is unable to assume role` /
 * `is unable to assume provided role` / `is unable to assume the role` and
 * deliberately refuses the bare `is unable to assume` this list uses, so that a
 * permanent `... is unable to assume role X because of an explicit deny` cannot
 * burn a retry budget. The bare spelling is right HERE — the text is the
 * handler's own reason about the race cdkd created — and wrong for AWS-authored
 * text about a call cdkd made, which is why
 * {@link CR_THROWN_AUTHZ_EXTRA_SIGNALS} does not re-export it.
 *
 * The narrowing is intended, because the two lists are consumed under different
 * COSTS and classify text with different AUTHORS:
 *
 *  - This set is matched against the HANDLER's own FAILED `Reason` (and, since
 *    #1674, against arbitrary handler stdout in the log tail). A match here buys
 *    a re-INVOKE, which re-runs the user's `Create` — a non-idempotent handler
 *    repeats partial work, and a Provider-framework `onEvent` can create a
 *    SECOND physical resource and orphan the first (the accepted cost stated on
 *    {@link CR_TRANSIENT_AUTHZ_LOG_SIGNALS}). So the phrases must name the race
 *    cdkd ITSELF created — the backing function's freshly-attached execution
 *    role — and nothing else. Most of the superset's entries describe a
 *    DOWNSTREAM call the handler made (`Invalid principal in policy`,
 *    `Cannot access stream`, `KMS key is invalid for CreateGrant`,
 *    `Invalid InstanceProfile`, …); a re-invoke is not the remedy for those, so
 *    each one would buy a recycle plus an identical re-failure. The three the
 *    issue named specifically — `role defined for the function`, `trust policy`,
 *    `Invalid principal in policy` — are exactly that shape when they arrive in
 *    a handler-authored reason, and the first two are ALREADY covered here in
 *    the spelling that matters (`cannot be assumed` / `is unable to assume` are
 *    what Lambda emits for an unassumable execution role).
 *  - The shared list is matched against text AWS wrote about a call CDKD made.
 *    It is used, in full, by
 *    {@link CustomResourceProvider.isTransientAuthzThrow} for a THROWN error
 *    from one of the provider's OWN SDK calls — see that method for why the
 *    wider list is correct there and costs nothing extra.
 *
 * So the answer to "should these converge" is no; what was genuinely missing was
 * the second consumer, not a wider first one.
 */
export const CR_TRANSIENT_AUTHZ_SIGNALS: readonly string[] = [
  'not authorized to perform',
  'no identity-based policy allows',
  'is not in the state functionactive',
  'not in the state functionactive',
  'cannot be assumed',
  'is unable to assume',
];

/**
 * The CR-specific spellings {@link CustomResourceProvider.isTransientAuthzThrow}
 * adds ON TOP of `IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS` — i.e. exactly the
 * phrases the shared list does not carry in any form (issue #2033).
 *
 * Deliberately NOT `CR_TRANSIENT_AUTHZ_SIGNALS` itself, which is what the first
 * cut of the fix used. Three of that list's entries are already covered by the
 * shared list (`not authorized to perform` / `cannot be assumed`, plus the three
 * ANCHORED `unable to assume` spellings), so re-uniting the whole thing bought
 * nothing except the bare, UN-anchored `is unable to assume` — which the shared
 * list refuses on purpose so a permanent explicit-deny cannot spend a 47.75s
 * budget before failing. This list is the difference, and only the difference.
 *
 * Lower-cased substrings, matched against a lower-cased message (the shared list
 * is mixed-case and matched verbatim by `isIamPropagationError`).
 *
 * `is not in the state functionactive` from the sibling list is omitted as a
 * pure superstring of the entry below it: any message matching it matches this
 * one too.
 */
export const CR_THROWN_AUTHZ_EXTRA_SIGNALS: readonly string[] = [
  'no identity-based policy allows',
  'not in the state functionactive',
];

/**
 * The same IAM-authorization-propagation signals, matched against the backing
 * function's INVOCATION LOG TAIL rather than the FAILED reason (issue #1674).
 *
 * Why a second set is needed at all: the reason string is written by the
 * handler, and a handler that wraps an SDK / CLI failure in its own message —
 * normal handler hygiene — erases every authz phrase before cdkd ever sees it.
 * CDK's `BucketDeployment` is the widely-used instance: `aws_command()` lets
 * `subprocess.check_call` raise, and `str(CalledProcessError)` is only
 * `Command '[...]' returned non-zero exit status 1.`, so the 403 on the asset
 * object reaches cdkd with no authz wording at all and the retry above never
 * fires — on a resource GUARANTEED to race, since CDK generates the handler
 * role, its inline policy and the custom resource in the same stack.
 *
 * The 403 does survive in the function's own log, which a `LogType: 'Tail'`
 * invoke returns inline (no CloudWatch Logs dependency, no extra API call, no
 * additional IAM permission — see `invokeLambda`). So this set adds the
 * CLI / SDK-level spellings of the SAME denial that the handler swallowed:
 * botocore's `An error occurred (403) when calling the HeadObject operation`
 * and the `AccessDenied` / `AccessDeniedException` error codes.
 *
 * Deliberately still NARROW, for the reason `isTransientAuthzFailure`
 * documents: a bare `403` / `forbidden` would match a handler legitimately
 * logging an unrelated downstream denial, and generic transient errors
 * (throttling / timeouts) must not trigger a CR re-invoke at all.
 *
 * ACCEPTED COST, stated because a log surface is noisier than a
 * handler-authored reason: a handler that merely LOGS a genuine, permanent
 * `AccessDenied` — one it caught, or one no propagation will fix — now buys
 * `transientAuthzMaxRetries` extra invokes plus a
 * `recycleBackingFunctionExecEnv` each. Bounded (2 by default; set
 * `CDKD_CR_AUTHZ_MAX_RETRIES=0` to disable the RETRY — the log-tail scan and the
 * reason annotation below still run, since they only describe the failure), and
 * the original failure still surfaces afterwards, so the failure is DELAYED,
 * never masked.
 *
 * The cost is NOT purely wasted time, and saying only "delayed, never masked"
 * would undersell it: a re-invoke re-runs the handler's `Create`, so a handler
 * that is not idempotent and had already done partial work repeats that work —
 * and under the CDK Provider framework the re-invoked `onEvent` can create a
 * SECOND physical resource, orphaning the first. That exposure is not new (the
 * pre-existing reason-string match has always been able to retry), but the log
 * signal widens what reaches it. The trade is still deliberate: the alternative
 * is the pre-#1674 behavior, where the propagation race this whole mechanism
 * exists for fails the deploy on its first attempt, every time.
 */
export const CR_TRANSIENT_AUTHZ_LOG_SIGNALS: readonly string[] = [
  ...CR_TRANSIENT_AUTHZ_SIGNALS,
  'an error occurred (403)',
  'accessdenied',
  'access denied',
];

/**
 * Cap for the backing function's log tail when it is surfaced in an EPHEMERAL
 * warning — the `FunctionError` arm and the unexplained-FAILED arm. Deliberately
 * far larger than `truncateReason`'s 200-char default — a crashed handler's real
 * cause is often several lines above the last one (a Python traceback) — but not
 * unbounded: this lands in CI logs and terminal scrollback. Lambda caps the tail
 * at 4 KB regardless, so this only trims the extreme case.
 */
export const CR_LOG_TAIL_WARN_MAX_CHARS = 2000;

/**
 * Head of the transient `Description` `recycleBackingFunctionExecEnv` writes
 * onto a backing function (the custom resource's logical id and `)` follow).
 * A read starting with it is a marker an earlier restore failed to remove,
 * never the function's own text (issue #5738).
 */
export const CR_RECYCLE_DESCRIPTION_PREFIX = 'cdkd: recycled for IAM-propagation retry (';

/**
 * How many times the recycle's restore re-sends after a
 * `ResourceConflictException` (the marker's update still InProgress), each
 * after waiting up to `CR_RECYCLE_RESTORE_CONFLICT_WAIT_SECONDS` for the
 * function to settle. Small: the restore is best-effort (issue #5738).
 */
export const CR_RECYCLE_RESTORE_CONFLICT_RETRIES = 2;

export const CR_RECYCLE_RESTORE_CONFLICT_WAIT_SECONDS = 60;

/**
 * ONE wall-clock budget for a whole recycle: the marker's waiter (up to 120s),
 * the restore's conflict waits and the restore's waiter all draw from it, so
 * a recycle never costs more than the 240s the marker write plus its waiter
 * and a restore waiter could before the conflict re-sends existed. With
 * `CR_AUTHZ_MAX_RETRIES_CEILING` recycles that stays well inside the deploy
 * engine's 1h per-resource deadline.
 */
export const CR_RECYCLE_BUDGET_SECONDS = 240;

/**
 * The smallest remaining budget a waiter is started with: the SDK refuses a
 * `maxWaitTime` not above `minDelay` (1s), and a sub-2s wait settles nothing.
 */
export const CR_RECYCLE_MIN_WAIT_SECONDS = 2;

/**
 * The key `recycleBackingFunctionExecEnv` serialises and remembers a
 * Description under. `Description` is FUNCTION-level configuration, so a
 * qualified ServiceToken (`...:function:f:$LATEST`, an alias, a version) and
 * the unqualified ARN name ONE function and must share a key; region and
 * account stay in it. A token that is not a Lambda function ARN is its own key.
 */
export function recycleFunctionKey(serviceToken: string): string {
  if (!LAMBDA_FUNCTION_ARN.test(serviceToken)) return serviceToken;
  return serviceToken.split(':').slice(0, 7).join(':');
}

/** Default for `CDKD_CR_AUTHZ_MAX_RETRIES` — see `transientAuthzMaxRetries`. */
export const CR_AUTHZ_MAX_RETRIES_DEFAULT = 2;

/**
 * Hard ceiling for `CDKD_CR_AUTHZ_MAX_RETRIES`.
 *
 * The knob's units are RE-INVOCATIONS OF THE USER'S HANDLER, each one also
 * paying a `recycleBackingFunctionExecEnv` (a `GetFunctionConfiguration`, the
 * marker and restore `UpdateFunctionConfiguration`s with the restore's bounded
 * conflict re-sends, and their waiters — all inside one
 * `CR_RECYCLE_BUDGET_SECONDS` = 240s budget). Ten of those is already far past the point where an
 * IAM-propagation race would have settled, so anything above it is a typo or a
 * misunderstanding rather than a preference — and left unclamped a `1e9`
 * passes the finite / `>= 0` gate and re-invokes until the deploy engine's
 * per-resource deadline fires an hour later.
 */
export const CR_AUTHZ_MAX_RETRIES_CEILING = 10;

/**
 * Bound for the `.cause` walks in this file, matching the depth
 * `isMarkedNonRetryable` / `isThrottlingError` use in
 * `src/deployment/retryable-errors/marks.ts`. Bounded rather than unbounded so a
 * cyclic chain cannot hang the classifier.
 */
export const CR_ERROR_CAUSE_MAX_DEPTH = 5;

/**
 * Sleep seam for this provider's hand-rolled waits (the pre-delivery retry
 * backoff and the S3 response poll).
 *
 * Mutable module state ONLY so tests can run a 47.75s retry schedule without
 * spending 47.75s; production never reassigns it. Mirrors the
 * `deleteTableRetryDelays.sleep` seam the DynamoDB providers use, and the
 * `sleep` option `withRetry` already exposes for the same reason.
 */
export const customResourceRetryDelays = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Backoff between account lookups on the DELETE path only, when
 * `getAccountInfo` refuses (issue [#1730](https://github.com/go-to-k/cdkd/issues/1730)).
 *
 * A refused Delete is never sent, so the resource is reported `skipped` — and
 * the same destroy run deletes the backing Lambda, after which no later
 * destroy can reach the handler (see {@link CR_SKIP_NOT_A_RETRY_CAVEAT}). A
 * transient STS blip would therefore leave whatever the handler manages to be
 * torn down by hand. `getAccountInfo` never caches a failure, so asking again can
 * recover; create / update need no such loop, because their refusal fails
 * before anything exists and the next deploy simply retries.
 */
export const DELETE_ACCOUNT_LOOKUP_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];

/**
 * Lines Lambda emits for EVERY invocation regardless of what the handler logged.
 * A tail consisting only of these carries no diagnostic value, and it is the
 * COMMON case — `LogResult` is never absent on a `LogType: 'Tail'` invoke, so a
 * bare `!== undefined` check filters nothing and would dump boilerplate on every
 * unexplained failure.
 *
 * The COLD-START platform lines (`INIT_START` / `INIT_REPORT`, the SnapStart
 * `RESTORE_*` pair, `EXTENSION`) matter as much as the per-invoke ones here, and
 * arguably more: the IAM-propagation race this whole mechanism exists for IS a
 * cold-start phenomenon, so those lines are present precisely when this arm
 * fires. Omitting them would have left the filter inert in its own main case.
 *
 * The trailing space is load-bearing: a handler's `print("REPORT: no bucket")`
 * emits `REPORT:` and must NOT be classified as boilerplate.
 */
export const CR_LOG_TAIL_BOILERPLATE =
  /^(START|END|REPORT|XRAY|INIT_START|INIT_REPORT|RESTORE_START|RESTORE_REPORT|EXTENSION) /;

/**
 * Matches an SNS topic ARN in ANY AWS partition (issue #1815).
 *
 * The partition segment is read OFF THE ARN rather than derived from a region
 * through `derivePartitionAndUrlSuffix` (`src/utils/aws-partition.ts`), which
 * is the right tool for the seven sites PR #1834 fixed but the wrong one here.
 * That helper answers "given a region, which partition am I in"; this is a
 * CLASSIFIER over an ARN the caller already holds, so the partition is present
 * in the input and needs no derivation — and there is no region in hand at
 * this call site to derive from anyway.
 *
 * `aws[a-z0-9-]*` deliberately accepts any partition name rather than
 * enumerating today's (`aws` / `aws-cn` / `aws-us-gov` / `aws-iso*` /
 * `aws-eusc`), matching `IAM_ROLE_ARN_RE` in `src/utils/role-arn.ts`. A closed
 * list is exactly the failure this issue is about: it goes stale the moment
 * AWS adds a partition. Being loose is safe for a routing predicate — the
 * service segment (`:sns:`) is what discriminates, and a string that is not a
 * real ARN cannot be a valid ServiceToken in the first place.
 */
export const SNS_SERVICE_TOKEN_ARN_RE = /^arn:aws[a-z0-9-]*:sns:/;
