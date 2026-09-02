import {
  LambdaClient,
  InvokeCommand,
  GetFunctionCommand,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionActiveV2,
  waitUntilFunctionUpdatedV2,
  type InvocationResponse,
} from '@aws-sdk/client-lambda';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getLogger } from '../../utils/logger.js';
import { displaySafe } from '../../utils/display-safe.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import {
  getAccountInfo,
  type AwsAccountInfo,
} from '../../deployment/intrinsic-function-resolver.js';
import { rebuildClientForBucketRegion } from '../../utils/bucket-region-client.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import {
  withRetry,
  IAM_PROPAGATION_INITIAL_DELAY_MS,
  IAM_PROPAGATION_MAX_DELAY_MS,
  IAM_PROPAGATION_MAX_RETRIES,
} from '../../deployment/retry.js';
import { startInterruptWatch, type InterruptWatch } from '../interrupt-watch.js';
import { CUSTOM_RESOURCE_RESPONSE_PREFIX } from '../../state/state-prefix.js';
import {
  purgeNoncurrentKeyVersions,
  CUSTOM_RESOURCE_RESPONSE_OBJECT_DESCRIPTION,
} from '../../state/s3-noncurrent-version-purge.js';
import {
  isIamPropagationError,
  isMarkedNonRetryable,
  markNonRetryable,
} from '../../deployment/retryable-errors.js';
import { type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceDeleteResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
} from '../../types/resource.js';
import { maskDeep, maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';

/**
 * The DELETE path threads NO masker (issue #2178).
 *
 * `DeleteContext` carries no masker by the `SecretMaskingContext` contract — a
 * delete's payload is a physical id rather than a resolved property bag — so
 * there is no capability to thread here.
 *
 * This is deliberately `undefined` and NOT `maskerOrIdentity(undefined)`, which
 * is what it was until the review of this change. An identity function typed
 * `MaskerFn` is a masker that fences nothing, and issue
 * [#2007](https://github.com/go-to-k/cdkd/issues/2007) records why that is
 * WORSE than no masker at all: its presence stops the next author looking. The
 * critic now REFUSES an identity-bound masker (see
 * `scripts/check-provider-secret-mask.ts`), so this spelling is the only one
 * that both compiles and states the truth — and the message site it feeds is
 * recorded in that critic's `EXEMPT` list, where it is counted and re-audited
 * on every run rather than hidden inside the masked count.
 *
 * `src/types/resource.ts` requires the capability to be THREADED before a
 * delete-path message may claim to mask; retiring this constant is that work,
 * not a rename.
 */
const DELETE_PATH_UNMASKED = undefined;

/**
 * The short `ResourceDeleteResult.reason` the no-properties DELETE arm reports
 * (issue [#1770](https://github.com/go-to-k/cdkd/issues/1770)).
 *
 * Rendered inline on the destroy status line, so it is the SHORT form; the full
 * remediation sentence goes out as the `logger.warn` beside it.
 */
export const CR_NO_PROPERTIES_SKIP_REASON = 'no properties in state — Delete handler not invoked';

/**
 * Sibling of {@link CR_NO_PROPERTIES_SKIP_REASON} for the arm where properties
 * exist but carry no `ServiceToken`. Distinct because the repair differs: one
 * record lost everything, the other lost the one field that names the handler.
 */
export const CR_NO_SERVICE_TOKEN_SKIP_REASON =
  'no ServiceToken in state — Delete handler not invoked';

/**
 * Third sibling of the two above, for the arm where cdkd HAD everything it
 * needed and the Delete request still could not be completed — a permanent
 * `lambda:InvokeFunction` denial, an exhausted readiness waiter, a response
 * that never arrived.
 *
 * That arm used to swallow the error and return `undefined`, which
 * `deleteSkipReason` reads as DELETED: `cdkd destroy` printed `✓ … deleted`,
 * dropped the state record and exited 0 over a handler that never received a
 * `Delete` — silently orphaning everything that handler manages. It is the
 * same silent-orphan class issue
 * [#1752](https://github.com/go-to-k/cdkd/issues/1752) removed from the two
 * arms above, reached through the catch rather than through a guard.
 *
 * **Fixed wording, no interpolation.** The underlying AWS message goes out on
 * the `logger.warn` beside it and NOT into the reason, because a `reason` is
 * rendered into the `Error` the deploy-side replacement sites throw, whose
 * catch classifies an already-deleted resource by SUBSTRING — an AWS message
 * carrying `does not exist` / `not found` would make a skip read as "already
 * gone" and drop the record again, one layer further out. Same rule the
 * `sns-subscription` abort follows.
 *
 * The premise is "the resource was NOT destroyed", not "no AWS call was
 * issued": the handler may have run and failed, or run and had its response
 * lost. Both leave the resource unproven, which is what a skip asserts.
 */
export const CR_DELETE_INVOKE_FAILED_SKIP_REASON =
  'Delete request to the handler did not complete — resource unproven';

/**
 * Fourth sibling of the three above, for the arm where the handler RAN, was
 * reached, and answered `Status: 'FAILED'` (issue
 * [#2054](https://github.com/go-to-k/cdkd/issues/2054)).
 *
 * The terminal FAILED arm used to warn and fall through to `return undefined`,
 * which `deleteSkipReason` reads as DELETED — so cdkd dropped the state
 * record, printed the row as deleted and exited 0 over a resource the handler
 * had EXPLICITLY said it did not delete. It is the same silent-orphan class
 * {@link CR_DELETE_INVOKE_FAILED_SKIP_REASON} removed from the throw arm,
 * reached through the handler's RESPONSE instead.
 *
 * **Unconditional, with no already-gone classifier.** A handler that reports
 * FAILED because the thing it manages was already absent is a real and common
 * shape, and today's leniency lets those destroys finish green. Classifying
 * the reason to keep them green was rejected: the reason is free text a user's
 * handler writes, so any classifier is a guess, and a wrong guess
 * re-introduces exactly the orphan this arm exists to stop.
 *
 * This is therefore a COMPATIBILITY BREAK: a destroy whose delete handler
 * reports FAILED now exits 2 with the record kept, where it used to exit 0
 * with the record dropped.
 *
 * **The two callers have DIFFERENT escape hatches, and only one of them is a
 * flag.** On `cdkd deploy` the skip is forced back to exit 0 by
 * `--allow-unaddressed` (issue #1960, the flag that settled the analogous
 * exit-code question). `cdkd destroy` has no such flag — a skip raises
 * `PartialFailureError` unconditionally (`src/cli/commands/destroy.ts`) — so
 * there the remedy is the one that command's own summary names: confirm the
 * resource is gone, then drop the record with `cdkd state orphan <stack>`.
 * Messages must not offer the flag on the destroy path, which is the path this
 * arm is mostly reached from.
 *
 * **Fixed wording, no interpolation**, for the reason spelled out on
 * {@link CR_DELETE_INVOKE_FAILED_SKIP_REASON}: the handler's own `Reason` is a
 * user-authored string, it goes out on the `logger.warn` beside this, and a
 * `Reason` carrying `does not exist` / `not found` would make the deploy-side
 * replacement sites classify the skip as "already gone" and drop the record
 * one layer further out.
 */
export const CR_DELETE_HANDLER_FAILED_SKIP_REASON =
  'Delete handler reported FAILED — resource unproven';

/**
 * The deploy-side caveat both skip warnings in this file carry (issue
 * [#1762](https://github.com/go-to-k/cdkd/issues/1762)).
 *
 * "Repair state.json and re-run" is only true on DESTROY, where the skip KEEPS
 * the record. The same arms are ALSO reached from `deploy-engine.ts` and
 * `rollback-executor.ts`, which discard the delete result and DROP the record —
 * there the id is gone, so re-running cannot help and the resource has to be
 * torn down by hand. Mirrors the caveat `compositeIdFormatMessage` already
 * carries for the composite-id family.
 */
/**
 * The bound BOTH delete-path skips in this file have to state (found in review
 * of issue [#2054](https://github.com/go-to-k/cdkd/issues/2054)).
 *
 * A skip KEEPS the state record, and the natural thing to promise is that a
 * re-run retries the handler. **On `cdkd destroy` that promise is false**, and
 * it is false in the direction that matters. `destroy-runner.ts` walks every
 * reverse-DAG level regardless of skips, so the SAME run that skipped the
 * custom resource goes on to delete its backing Lambda. The next
 * `cdkd destroy` therefore reaches the issue-#804 pre-check above, finds the
 * function gone, and treats the resource as already deleted — dropping the
 * record and exiting 0 over a resource the handler explicitly refused to
 * remove, which is the very silent orphan #2054 removed one run earlier.
 *
 * Closing it properly means making that pre-check answer `'skipped'` when the
 * teardown was never PROVEN, which needs a durable "a prior run skipped this"
 * signal. Every candidate is outside this file: a `ResourceState` field (a
 * state-schema bump), or a `DeleteContext` flag threaded from
 * `destroy-runner.ts`. So the record is described here as what it actually is
 * — a POINTER to something that has to be torn down by hand — rather than as a
 * retry that will not happen.
 */
const CR_SKIP_NOT_A_RETRY_CAVEAT =
  `NOTE this record is a POINTER, not a retry: the same destroy run deletes the backing Lambda, ` +
  `so the next 'cdkd destroy' finds the handler gone and DROPS this record (issue 804 pre-check). ` +
  `Tear the resource down by hand, then clear the stack's records with 'cdkd state orphan <stack>' ` +
  `— that command drops EVERY record for the stack, not just this one.`;

const DEPLOY_SKIP_CAVEAT =
  `NOTE this arm is ALSO reached from cdkd deploy. Since issue 1762 the DELETE of a resource ` +
  `removed from the template behaves like destroy — the record is KEPT and the next deploy ` +
  `re-attempts it — but a REPLACEMENT / rollback delete FAILS the resource instead ` +
  `(https://github.com/go-to-k/cdkd/issues/1762), leaving the old one untracked; there, tear the resource down by hand.`;

/**
 * CloudFormation Custom Resource Response format
 * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-responses.html
 */
interface CfnCustomResourceResponse {
  Status: 'SUCCESS' | 'FAILED';
  Reason?: string;
  PhysicalResourceId?: string;
  StackId?: string;
  RequestId?: string;
  LogicalResourceId?: string;
  NoEcho?: boolean;
  Data?: Record<string, unknown>;
}

/**
 * Custom Resource Lambda Response Payload (direct return)
 * Some handlers return data directly in the Lambda payload instead of via ResponseURL
 */
interface CustomResourceResponsePayload {
  PhysicalResourceId?: string;
  Data?: Record<string, unknown>;
  /**
   * The same `NoEcho` a full cfn-response envelope carries (issue
   * [#2274](https://github.com/go-to-k/cdkd/issues/2274)). A simple handler
   * returns a BARE object rather than a cfn-response document, and cdkd
   * synthesizes the envelope for it below — so without this field the
   * declaration was dropped for the whole simple-handler delivery shape, which
   * is the one the CDK `custom_resources` sample handlers and this repo's own
   * `custom-resource-getatt-data` fixture use. Declared explicitly even though
   * the index signature would admit it, so the copy below cannot read as
   * incidental.
   */
  NoEcho?: boolean;
  [key: string]: unknown;
}

/**
 * Configuration for Custom Resource Provider
 */
export interface CustomResourceProviderConfig {
  /** S3 bucket name for storing custom resource responses */
  responseBucket?: string;
  /** S3 key prefix for response objects */
  responsePrefix?: string;
  /**
   * Max time (ms) to wait for async custom resource responses (e.g., CDK Provider framework
   * with isCompleteHandler that uses Step Functions polling).
   * Default: 1 hour (3600000ms), matching CDK's default totalTimeout.
   */
  asyncResponseTimeoutMs?: number;
}

/**
 * Type guard to validate Lambda response payload structure
 */
function isCustomResourceResponsePayload(value: unknown): value is CustomResourceResponsePayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const payload = value as Record<string, unknown>;

  if ('PhysicalResourceId' in payload && typeof payload['PhysicalResourceId'] !== 'string') {
    return false;
  }

  if ('Data' in payload) {
    if (typeof payload['Data'] !== 'object' || payload['Data'] === null) {
      return false;
    }
  }

  return true;
}

/**
 * Parse Lambda response payload with type safety
 */
function parseLambdaPayload(
  payloadBytes: Uint8Array | undefined,
  mask: MaskerFn | undefined
): CustomResourceResponsePayload {
  if (!payloadBytes) {
    return {};
  }

  const payloadString = Buffer.from(payloadBytes).toString();

  // Handle empty or null responses
  if (!payloadString || payloadString === 'null' || payloadString === '""') {
    return {};
  }

  const parsed: unknown = JSON.parse(payloadString);

  if (!isCustomResourceResponsePayload(parsed)) {
    // Issue #2178: masked BEFORE stringifying, on the paths that HAVE a masker.
    // A handler routinely echoes its `ResourceProperties` back in `Data`, and
    // those arrive RESOLVED, so this payload can carry plaintext. Masking the
    // FINISHED message cannot recover it — `JSON.stringify` escapes `"` / `\` /
    // newlines out of existence.
    //
    // Two arms rather than an identity default, because the DELETE path has no
    // masker to thread (see {@link DELETE_PATH_UNMASKED}) and a per-SITE critic
    // cannot say "masked on two of three paths". Splitting the message makes
    // the unmasked path its OWN site, so it is recorded in
    // `scripts/check-provider-secret-mask.ts`'s `EXEMPT` list — counted,
    // re-audited every run, and self-retiring the moment `DeleteContext` gains
    // the capability — while the masked arm stays fenced: deleting its
    // `maskDeep` wrap reds the critic.
    //
    // Exposure TODAY is nil in both arms, and saying so is the point: the only
    // caller wraps this in `try { … } catch { this.logger.debug('Lambda payload
    // parse failed …') }`, which DISCARDS the error without reading
    // `error.message`. Swallowing a parse failure that way is its own smell —
    // it is recorded here rather than hidden behind the mask. The mask stays
    // because the bound is forward-looking: the moment that catch logs
    // `error.message`, the delete arm leaks, and the split above is what keeps
    // that visible instead of letting one masked-looking site cover both.
    if (mask === undefined) {
      throw new Error(`Invalid Lambda response payload format: ${JSON.stringify(parsed)}`);
    }
    throw new Error(
      `Invalid Lambda response payload format: ${JSON.stringify(maskDeep(parsed, mask))}`
    );
  }

  return parsed;
}

/**
 * Decode the base64 `LogResult` a `LogType: 'Tail'` invoke returns into the
 * backing function's log tail (issue #1674).
 *
 * Best-effort by design: this only ever feeds diagnostics and the retry
 * classifier, so nothing here may fail a deploy that is otherwise fine. Node's
 * base64 decoder is LENIENT — it drops invalid characters rather than throwing —
 * so a malformed value decodes to garbage, which simply matches no signal; the
 * `catch` is belt-and-braces for that contract changing, not a live path.
 */
function decodeInvokeLogTail(logResult: string | undefined): string | undefined {
  if (!logResult) return undefined;
  try {
    const decoded = Buffer.from(logResult, 'base64').toString('utf8');
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Recover the backing function's own STATUS fields from an
 * `@smithy/util-waiter` failure message, or `undefined` when they are not
 * there (issue #2033).
 *
 * The message is `JSON.stringify(result)` and `result.reason` is, for both
 * Lambda readiness waiters, the ENTIRE `GetFunction` response. Only these
 * AWS-authored status fields are lifted out of it — never the whole payload,
 * which carries `Configuration.Environment.Variables` into a durable store.
 *
 * Best-effort by construction: a non-JSON message, a different waiter shape, or
 * a payload with no `Configuration` all yield `undefined`, and the caller falls
 * back to a fixed sentence.
 */
function extractWaiterFunctionStatus(message: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }
  const reason = (parsed as { reason?: unknown } | null)?.reason;
  const config = (reason as { Configuration?: unknown } | null)?.Configuration;
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined;
  const fields = config as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of [
    'State',
    'StateReasonCode',
    'StateReason',
    'LastUpdateStatus',
    'LastUpdateStatusReasonCode',
    'LastUpdateStatusReason',
  ]) {
    const value = fields[key];
    if (typeof value === 'string' && value !== '') parts.push(`${key}=${value}`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * Render a Lambda readiness-waiter failure for a message that is persisted
 * (issue #2033) — see `waitForBackingLambdaReady` for the whole argument.
 *
 * TIMEOUT / ABORT keep the waiter's own message: its `observedResponses` keys
 * are status lines `@smithy/util-waiter` builds itself (`403: <AWS message>`),
 * which is exactly the diagnostic a stalled waiter needs and carries no
 * response body. Every other state serialized the full `GetFunction` response,
 * so that arm reports the error NAME plus the function's own status fields.
 */
function describeWaiterFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'TimeoutError' || name === 'AbortError') return message;
  const status = extractWaiterFunctionStatus(message);
  return (
    `${name} (${status ?? 'no function status reported'}). ` +
    `The waiter's raw payload is withheld because it embeds the whole GetFunction ` +
    `response, environment variables included; run \`aws lambda get-function\` for the detail.`
  );
}

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
const CR_TRANSIENT_AUTHZ_SIGNALS: readonly string[] = [
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
const CR_THROWN_AUTHZ_EXTRA_SIGNALS: readonly string[] = [
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
const CR_TRANSIENT_AUTHZ_LOG_SIGNALS: readonly string[] = [
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
const CR_LOG_TAIL_WARN_MAX_CHARS = 2000;

/** Default for `CDKD_CR_AUTHZ_MAX_RETRIES` — see `transientAuthzMaxRetries`. */
const CR_AUTHZ_MAX_RETRIES_DEFAULT = 2;

/**
 * Hard ceiling for `CDKD_CR_AUTHZ_MAX_RETRIES`.
 *
 * The knob's units are RE-INVOCATIONS OF THE USER'S HANDLER, each one also
 * paying a `recycleBackingFunctionExecEnv` (an `UpdateFunctionConfiguration`
 * plus a 120s waiter). Ten of those is already far past the point where an
 * IAM-propagation race would have settled, so anything above it is a typo or a
 * misunderstanding rather than a preference — and left unclamped a `1e9`
 * passes the finite / `>= 0` gate and re-invokes until the deploy engine's
 * per-resource deadline fires an hour later.
 */
const CR_AUTHZ_MAX_RETRIES_CEILING = 10;

/**
 * Bound for the `.cause` walks in this file, matching the depth
 * `isMarkedNonRetryable` / `isThrottlingError` use in
 * `src/deployment/retryable-errors.ts`. Bounded rather than unbounded so a
 * cyclic chain cannot hang the classifier.
 */
const CR_ERROR_CAUSE_MAX_DEPTH = 5;

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
const CR_LOG_TAIL_BOILERPLATE =
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
const SNS_SERVICE_TOKEN_ARN_RE = /^arn:aws[a-z0-9-]*:sns:/;

/**
 * Account segment {@link syntheticStackId} falls back to when STS could not
 * answer (`AwsAccountInfo.fabricated`, issue
 * [#1730](https://github.com/go-to-k/cdkd/issues/1730)).
 *
 * The Cloud Control enrichment sites answer a fabricated account by OMITTING
 * the value they would have built. That is not available here — `StackId` is a
 * REQUIRED member of the custom-resource request payload — so the choice is
 * between two wrong strings, and the honest one is the one a handler cannot
 * mistake for real. `getAccountInfo`'s own fallback id (`123456789012`) is
 * shaped exactly like a live account; the all-zero id is not a valid AWS
 * account and reads as the placeholder it is.
 */
const SYNTHETIC_STACK_ID_PLACEHOLDER_ACCOUNT = '000000000000';

/**
 * The synthetic `StackId` handed to a custom-resource handler in place of the
 * CloudFormation stack ARN cdkd does not have.
 *
 * Partition / region / account are synthesized TOGETHER from the real deploy
 * context (issue [#1866](https://github.com/go-to-k/cdkd/issues/1866)). Every
 * segment used to be fabricated — `arn:aws:cloudformation:us-east-1:0000...`
 * regardless of where the deploy actually ran — and CloudFormation-authored
 * handlers DO read `event.StackId`: to re-derive the region / account they are
 * running in, to build ARNs, to name log streams, to correlate a response.
 * Each of those read a coherent-looking ARN and got an answer that addresses
 * nothing.
 *
 * Deriving only ONE segment is worse than deriving none, which is why issue
 * #1815 deliberately left the hardcoded `arn:aws:` prefix alone rather than
 * partition-deriving it in isolation: `arn:aws-cn:cloudformation:us-east-1:…`
 * is a China partition carrying a commercial region, strictly LESS coherent
 * than a uniformly-commercial fabrication. So this takes the whole
 * {@link AwsAccountInfo} — where `partition` is already derived FROM `region`
 * — rather than any one field.
 *
 * The stack-NAME segment stays synthetic (`cdkd-<logicalId>`): cdkd has no
 * CloudFormation stack, so there is no real value to put there.
 *
 * Factored into one place so the rationale cannot go stale against two other
 * copies: the create / update / delete request builders all use it, through
 * {@link CustomResourceProvider.resolveSyntheticStackId}.
 */
function syntheticStackId(logicalId: string, accountInfo: AwsAccountInfo): string {
  const account = accountInfo.fabricated
    ? SYNTHETIC_STACK_ID_PLACEHOLDER_ACCOUNT
    : accountInfo.accountId;
  return `arn:${accountInfo.partition}:cloudformation:${accountInfo.region}:${account}:stack/cdkd-${logicalId}/cdkd`;
}

/**
 * `true` when the tail contains at least one line the HANDLER produced.
 *
 * Deliberately a positive test for handler output rather than a length check:
 * the boilerplate lines carry a RequestId and a duration, so a tail of nothing
 * but boilerplate is several hundred characters and passes any size threshold.
 */
function hasHandlerLogOutput(logTail: string): boolean {
  return logTail
    .split('\n')
    .some((line) => line.trim().length > 0 && !CR_LOG_TAIL_BOILERPLATE.test(line.trimStart()));
}

/**
 * Outcome of parsing a custom-resource response body read back from S3.
 *
 * The three cases the poll loop must tell apart WITHOUT echoing the body
 * (issue #2250): a usable response document, valid JSON that is not one (a
 * bare scalar, an array, or `null` — what a handler writing the wrong shape
 * produces), and bytes that do not parse at all (typically a partially
 * written object caught mid-upload).
 */
type CfnResponseBodyParse =
  | { kind: 'envelope'; response: CfnCustomResourceResponse }
  | { kind: 'non-object' }
  | { kind: 'unparseable' };

/**
 * Parse a response body without trusting it. The body is written by the
 * customer's Lambda handler through a pre-signed URL, so it is UNTRUSTED
 * input: it may be truncated, may be a JSON scalar, or may be `null`. Every
 * one of those must be a normal "keep polling" outcome rather than a throw.
 */
function parseCfnResponseBody(body: string): CfnResponseBodyParse {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { kind: 'unparseable' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'non-object' };
  }
  return { kind: 'envelope', response: value as CfnCustomResourceResponse };
}

/**
 * Every field of the response is HANDLER-CONTROLLED, so each one is made safe
 * to render before it reaches a log line, and capped.
 *
 * Both halves are regressions this function introduced and a review caught.
 * The line it replaced printed `body.substring(0, 200)` -- raw WIRE json, where
 * the encoder had already escaped control characters as `\u001b`, and which was
 * capped at 200 characters by construction. Parsing first UNDOES the escaping:
 * an ESC and a newline reach the terminal as real bytes, so a handler (or
 * anyone holding the pre-signed response URL) could clear the screen and print
 * a forged `ERROR [cdkd]` line into a CI transcript. Measured: a
 * `PhysicalResourceId` carrying `ESC[2J` plus a newline rendered both. And
 * dropping the substring removed the bound -- a 5000-char id with 300 `Data`
 * keys rendered a 19,714-character line, re-emitted on EVERY poll.
 *
 * `displaySafe` is this repo's one answer to the first (issue
 * https://github.com/go-to-k/cdkd/issues/2170); `state.ts` already applies the
 * same treatment to this very value when it prints a state record.
 */
function capForLog(value: string): string {
  const safe = displaySafe(value);
  const capped =
    safe.length > DESCRIBE_MAX_FIELD_CHARS
      ? `${safe.slice(0, DESCRIBE_MAX_FIELD_CHARS)}...(${safe.length} chars)`
      : safe;
  // QUOTED, because `displaySafe` removes control characters and nothing else.
  // The fields below are interpolated into `Status=<a> PhysicalResourceId=<b>
  // Data keys [<c>, <d>]`, so a handler-chosen value carrying `]`, `=` or `,`
  // forges the rest of the record while every character in it is printable.
  // Measured: a `Data` KEY of `x] Status=SUCCESS PhysicalResourceId=forged-id
  // Data keys [y` rendered a line on which `grep 'Status=SUCCESS'` matches a
  // response whose real Status is FAILED. Weaker than the newline forgery the
  // control-character fix closed -- it cannot start a new log RECORD -- but the
  // same intent, and not reachable by sanitising characters, because the
  // characters are legitimate.
  //
  // `JSON.stringify` is the whole fix rather than an escape table: it quotes,
  // escapes the delimiters, and well-forms a lone surrogate that the slice
  // above can create by cutting a pair in half.
  return JSON.stringify(capped);
}

/** Per-field cap for the poll log line. */
const DESCRIBE_MAX_FIELD_CHARS = 200;
/** Whole-line clamp, applied after the per-field caps. */
const DESCRIBE_MAX_LINE_CHARS = 1000;
/** How many `Data` key names the poll log line names before counting the rest. */
const DESCRIBE_MAX_DATA_KEYS = 20;

/**
 * Render a NON-SENSITIVE one-line summary of a custom-resource response body
 * for the poll's debug log (issue #2250).
 *
 * The body is the CloudFormation custom-resource response document, and its
 * `Data` field is the documented place a handler returns a GENERATED VALUE —
 * including a generated secret. The previous log line emitted
 * `body.substring(0, 200)`, which put those values on the terminal (and, in
 * CI, into the retained build log) on every poll under `--verbose`.
 *
 * What survives here is everything the line was actually useful for: WHICH
 * resource answered (the caller adds the logical id), WHETHER it succeeded
 * (`Status`), what identity it claimed (`PhysicalResourceId` — already
 * persisted to state.json, so not a new channel), and WHICH keys came back
 * (`Object.keys(Data)`). The `Data` VALUES never appear, and neither does
 * `Reason`, which is free-form handler text that can quote them.
 *
 * For a body that is not a usable envelope, only its LENGTH is reported —
 * never its bytes. That keeps the diagnostic for the case it matters most in
 * (a handler writing a malformed response) without turning the fallback into
 * the same prefix echo through another door.
 */
function describeCfnResponseBody(body: string, parsed: CfnResponseBodyParse): string {
  if (parsed.kind !== 'envelope') {
    const shape = parsed.kind === 'unparseable' ? 'unparseable body' : 'JSON body is not an object';
    return `${shape} (${body.length} chars)`;
  }

  // Read defensively: the parse only proved the body is SOME object, not that
  // it matches `CfnCustomResourceResponse`.
  const envelope = parsed.response as unknown as Record<string, unknown>;
  const status = typeof envelope['Status'] === 'string' ? envelope['Status'] : '<absent>';
  const physicalId =
    typeof envelope['PhysicalResourceId'] === 'string'
      ? envelope['PhysicalResourceId']
      : '<absent>';

  const data = envelope['Data'];
  let dataPart: string;
  if (data === undefined) {
    dataPart = 'Data absent';
  } else if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const keys = Object.keys(data);
    const shown = keys.slice(0, DESCRIBE_MAX_DATA_KEYS).map((k) => capForLog(k));
    const omitted = keys.length - shown.length;
    dataPart = `Data keys [${shown.join(', ')}${omitted > 0 ? `, +${omitted} more` : ''}]`;
  } else {
    dataPart = 'Data not an object';
  }

  const line = `Status=${capForLog(status)} PhysicalResourceId=${capForLog(physicalId)} ${dataPart}`;
  // Outer clamp on top of the per-field caps. Those bound each PART; the line
  // is their sum, so 20 keys at the field cap still renders ~4.6 KB against the
  // 200 characters the `substring(0, 200)` this replaced allowed by
  // construction -- re-emitted on every poll of a resource that can run for an
  // hour. The per-field caps stay: they are what keeps one long field from
  // consuming the whole budget and hiding the others.
  return line.length > DESCRIBE_MAX_LINE_CHARS
    ? `${line.slice(0, DESCRIBE_MAX_LINE_CHARS)}...(${line.length} chars total)`
    : line;
}

/**
 * Custom Resource Provider
 *
 * Implements Lambda-backed custom resources by invoking the Lambda function
 * specified in the ServiceToken property.
 *
 * This provider follows the CloudFormation custom resource protocol:
 * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/custom-resources.html
 *
 * Supports both standard custom resources and CDK's Provider framework:
 *
 * **Standard custom resources:**
 * - ServiceToken Lambda is invoked synchronously
 * - Handler sends cfn-response to ResponseURL (S3 pre-signed URL) or returns directly
 * - Short polling timeout (30 seconds)
 *
 * **CDK Provider framework (with isCompleteHandler):**
 * - ServiceToken points to the framework's onEvent wrapper Lambda
 * - Lambda invokes user's onEventHandler, then starts a Step Functions state machine
 * - Step Functions polls the isCompleteHandler until IsComplete: true
 * - Step Functions sends cfn-response to ResponseURL when done
 * - Lambda returns null/empty payload (async pattern detected automatically)
 * - Long polling timeout with exponential backoff (default: 1 hour)
 *
 * Response handling strategy:
 * 1. Generate a pre-signed S3 PUT URL as the ResponseURL (valid for 2 hours)
 * 2. Invoke Lambda synchronously (RequestResponse)
 * 3. Check Lambda payload for direct response (simple handlers)
 * 4. If no direct response, detect async pattern and poll S3 with appropriate timeout
 */
export class CustomResourceProvider implements ResourceProvider {
  private lambdaClient: LambdaClient;
  private snsClient: SNSClient;
  private s3Client: S3Client;
  private logger = getLogger().child('CustomResourceProvider');
  private responseBucket: string | undefined;
  private responsePrefix: string;

  /**
   * Memoization for the lazy response-bucket region correction
   * (`ensureResponseClient`). Mirrors the `clientResolved` /
   * `resolveInFlight` pattern of the three other state-bucket S3
   * consumers (S3StateBackend / LockManager / ExportIndexStore), plus a
   * generation counter: `setResponseBucket` bumps it so a probe that was
   * still in flight when the bucket was re-set cannot commit its stale
   * client / resolved flag against the new bucket.
   */
  private responseClientResolved = false;
  private responseClientResolveInFlight: Promise<void> | null = null;
  private responseClientGeneration = 0;

  /**
   * Whether `this.s3Client` is a provider-OWNED client (built by a
   * region-correction rebuild) vs the shared `AwsClients.s3` instance
   * from the constructor. Owned clients are `destroy()`ed when replaced;
   * the shared one never is.
   */
  private ownsS3Client = false;

  /**
   * Opt out of the deploy engine's outer transient-error retry loop.
   *
   * The loop re-invokes `provider.create()` from the top on a transient
   * SDK error (IAM propagation, HTTP 429/503, etc.). Each invocation
   * generates a brand-new RequestId and a brand-new pre-signed S3
   * response URL via `prepareInvocation()`. If the underlying Lambda has
   * already started — e.g. an outer retry fired between the placeholder
   * `PutObject` and the `Invoke`, or after the `Invoke` returned but a
   * spurious downstream error fired — the first attempt's Lambda
   * response lands at an S3 key that nobody polls, hanging the deploy
   * until the polling timeout. The provider already polls with its own
   * exponential backoff for async patterns (CDK Provider framework with
   * isCompleteHandler), so an outer retry adds nothing but the multi-
   * key bug.
   *
   * **Opting out of the outer loop is a promise to retry HERE, and that
   * promise is kept PER CALL — not per attempt.** Issue
   * [#2033](https://github.com/go-to-k/cdkd/issues/2033) found the claim
   * backed for exactly one error SHAPE: the internal loop keyed only on the
   * handler's RETURNED `cfnResponse.Status === 'FAILED'`, and its body had no
   * `try` / `catch` at any point, so a THROWN error from any AWS SDK call the
   * provider itself makes left `create()` directly and was single-shot — while
   * every other resource type got 26 retries over 47.75s for the identical
   * wording. The per-call decision, in one place:
   *
   * | call | retried on a throw? | why |
   * |---|---|---|
   * | S3 `PutObject` (response-key placeholder) | YES, own `withRetry` (the standard dense propagation schedule, 47.75s) — and its exhausted throw is `markNonRetryable`d so the loop below cannot spend a SECOND budget on it | idempotent PUT of an empty object at a key cdkd just minted; touches no response-URL lifecycle, so a replay is free |
   * | Lambda `Invoke` / SNS `Publish` | YES, but only PRE-DELIVERY, on {@link CustomResourceProvider.preDeliveryAuthzMaxRetries} — its OWN budget, the same dense 47.75s schedule every other resource type gets | a replay re-delivers the request, which is the hazard this flag exists for, so the PRE-delivery fence is what makes the budget affordable: nothing has been delivered, so a replay re-invokes NOTHING — see {@link CustomResourceProvider.isTransientAuthzThrow} |
   * | `waitUntilFunctionActiveV2` / `waitUntilFunctionUpdatedV2` | ALREADY, by the SDK waiter — and their wrapped failure is `markNonRetryable`d, so the loop below does not replay it either | measured against `@aws-sdk/client-lambda`: the generated `checkState` catches EVERY exception and returns `RETRY`, so a mid-propagation 403 on `lambda:GetFunction` is polled out to `maxWaitTime` (600s). Wrapping them again would only stack a second budget on top — and `@smithy/util-waiter` serializes its `observedResponses` into the TIMEOUT message, whose keys read `403: User: … is not authorized to perform: lambda:GetFunction …`, so a classifier reading that message would have replayed a PERMANENT denial for 3 x 600s |
   * | `GetFunction` (delete-path backing-Lambda probe) | NO, deliberately | it already fails OPEN — anything but a definitive `ResourceNotFoundException` falls through to the normal invoke path, whose waiters cover the same propagation window one call later. Retrying would only delay that fall-through by up to 47.75s on a genuine permission denial |
   * | anything AFTER delivery (`pollS3Response`, the `FunctionError` throw, `cleanupResponseObject`) | NO, deliberately | the handler is running and will PUT to the URL of THIS attempt; a replay strands it at a key nobody polls, which is precisely the bug `disableOuterRetry` prevents |
   */
  readonly disableOuterRetry = true;

  /** Max time to wait for synchronous S3 response after Lambda invocation (30 seconds) */
  private readonly SYNC_RESPONSE_TIMEOUT_MS = 30_000;
  /** Max time to wait for async S3 response (CDK Provider framework with isCompleteHandler) */
  private readonly asyncResponseTimeoutMs: number;
  /** Default async response timeout: 1 hour (matches CDK's default totalTimeout) */
  private static readonly DEFAULT_ASYNC_RESPONSE_TIMEOUT_MS = 3_600_000;
  /** Initial poll interval for checking S3 response (2 seconds) */
  private readonly INITIAL_POLL_INTERVAL_MS = 2_000;
  /** Max poll interval for async polling with exponential backoff (30 seconds) */
  private readonly MAX_POLL_INTERVAL_MS = 30_000;

  /**
   * How many extra times to RE-INVOKE a custom resource whose handler returned
   * FAILED with a *transient IAM-authorization* reason.
   *
   * TWO error shapes, TWO budgets, deliberately (issue #2033) — this one and
   * {@link CustomResourceProvider.preDeliveryAuthzMaxRetries}. This budget
   * governs the shape where the handler ALREADY RAN: it returned FAILED with a
   * transient-authz reason (e.g. the CDK Provider
   * framework's `lambda:GetFunction` / "not in the state functionActive" 403
   * when the framework role's freshly-attached inline policy has not yet
   * propagated to the assumed-role session). cdkd's fast SDK path invokes the
   * backing Lambda ~1s after `PutRolePolicy`, so the first cold-start can cache
   * stale credentials; CloudFormation never hits this because its deployment
   * latency gives IAM time to settle. This is the CR-path analogue of the
   * IAM-propagation retry cdkd's `withRetry` already applies to every other
   * resource (the CR provider opts out of that outer retry via
   * `disableOuterRetry` to avoid stranding a pre-signed response URL — so we
   * retry HERE instead, deriving a fresh response URL + RequestId per attempt
   * and recycling the backing function's execution environment between tries).
   *
   * **It is SMALL (2) because every retry it authorises RE-RUNS THE USER'S
   * HANDLER**, and that is the whole reason the second shape does not share it:
   * a pre-delivery throw invokes the handler ZERO times, so the argument that
   * bounds this number does not apply there at all. Sharing it was measured
   * wrong — 2 retries on the dense schedule is 250ms + 500ms of coverage, i.e.
   * 0.75s against an IAM-propagation window this repo has measured at 7-12s, so
   * issue #2033's own scenario still failed with the fix in place.
   *
   * Override via `CDKD_CR_AUTHZ_MAX_RETRIES` (clamped to
   * {@link CR_AUTHZ_MAX_RETRIES_CEILING}). `0` disables the RE-INVOKE only —
   * the issue-#1674 log-tail scan and the reason annotation it produces still
   * run, because they describe the failure rather than react to it.
   *
   * It does NOT disable either of the two retries that cannot reach the
   * handler: the response-placeholder `PutObject` retry in
   * `generateResponseURL`, and the pre-delivery arm above. Neither is what this
   * knob exists to bound — it bounds how many times a user's handler may be
   * re-run — and a user turning off re-invokes should not thereby lose the
   * propagation coverage every other resource type gets for free.
   */
  private readonly transientAuthzMaxRetries: number = (() => {
    const raw = process.env['CDKD_CR_AUTHZ_MAX_RETRIES'];
    if (raw === undefined || raw === '') return CR_AUTHZ_MAX_RETRIES_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return CR_AUTHZ_MAX_RETRIES_DEFAULT;
    // Clamp, do not trust. Every unit of this budget costs one re-invoke of the
    // user's handler PLUS a `recycleBackingFunctionExecEnv` (an
    // `UpdateFunctionConfiguration` and a waiter), so an unbounded value —
    // `1e9` is finite and `>= 0`, so it passed — re-invokes until the deploy
    // engine's 1h per-resource deadline fires, with a non-idempotent handler
    // repeating its partial work every time.
    const clamped = Math.min(Math.floor(n), CR_AUTHZ_MAX_RETRIES_CEILING);
    if (clamped !== n) {
      this.logger.warn(
        `CDKD_CR_AUTHZ_MAX_RETRIES=${raw} is out of range; using ${clamped} ` +
          `(whole numbers, at most ${CR_AUTHZ_MAX_RETRIES_CEILING} — each retry re-invokes the ` +
          `custom resource handler).`
      );
    }
    return clamped;
  })();

  /**
   * Budget for the PRE-DELIVERY thrown arm — a transient IAM-authorization
   * error thrown by the `Invoke` / `Publish` itself BEFORE the request reached
   * the handler (issue #2033). The reported shape is an `AccessDeniedException`
   * on `lambda:InvokeFunction` while the DEPLOYING principal's own
   * freshly-attached policy is still propagating.
   *
   * It is {@link IAM_PROPAGATION_MAX_RETRIES} — the same 26 retries over 47.75s
   * that `withRetry` gives every other resource type for the identical wording,
   * on the same dense schedule ({@link IAM_PROPAGATION_INITIAL_DELAY_MS}
   * doubling to {@link IAM_PROPAGATION_MAX_DELAY_MS}). The measured window this
   * has to cover is 7-12s; the FAILED-response budget's 0.75s does not.
   *
   * **Why it can afford that while its sibling cannot**: it fires only when
   * `delivered === false`, so the handler has been invoked ZERO times and a
   * replay re-runs NOTHING — no partial work repeated, no second physical
   * resource from a Provider-framework `onEvent`, no stranded response URL. The
   * only cost of a retry here is one `PutObject` + one presign, and the
   * abandoned placeholder is swept before the next attempt. So the constraint
   * that keeps `transientAuthzMaxRetries` at 2 is simply absent, and matching
   * every other resource type is the correct answer instead.
   *
   * A thrown retry also skips the exec-env recycle: the denial is on CDKD's own
   * principal, not on the backing function's role, so there is no warm
   * container holding stale credentials to invalidate.
   *
   * Deliberately NOT overridable by an env var. It bounds no handler
   * invocation, so there is nothing for a user to trade off — the same reason
   * the placeholder `PutObject`'s `withRetry` takes no knob either.
   */
  private readonly preDeliveryAuthzMaxRetries: number = IAM_PROPAGATION_MAX_RETRIES;

  /**
   * The region the client bag this provider was built from was EXPLICITLY
   * configured with, or `undefined` (issue #1866).
   *
   * Captured in the constructor, beside the clients, rather than read per call:
   * `cdkd deploy` builds a region-configured `AwsClients` and a fresh
   * `ProviderRegistry` per stack, and with `--stack-concurrency` (default 4) it
   * swaps the process-global bag while other stacks are mid-flight — so a
   * call-time read can hand a SIBLING stack's region. Pairing it with the
   * clients keeps the two consistent by construction.
   *
   * `AwsClients.configuredRegion` is deliberately the only region a client bag
   * will answer (see its own note on why `client.config.region()` is unsound),
   * and `undefined` means no region was pinned anywhere — which
   * {@link getAccountInfo} then resolves from `AWS_REGION` itself.
   */
  private readonly configuredRegion: string | undefined;

  constructor(config?: CustomResourceProviderConfig) {
    const awsClients = getAwsClients();
    this.lambdaClient = awsClients.lambda;
    this.snsClient = awsClients.sns;
    this.s3Client = awsClients.s3;
    this.configuredRegion = awsClients.configuredRegion;
    this.responseBucket = config?.responseBucket;
    this.responsePrefix = config?.responsePrefix ?? CUSTOM_RESOURCE_RESPONSE_PREFIX;
    this.asyncResponseTimeoutMs =
      config?.asyncResponseTimeoutMs ?? CustomResourceProvider.DEFAULT_ASYNC_RESPONSE_TIMEOUT_MS;
  }

  /**
   * Self-reported minimum per-resource timeout.
   *
   * Custom Resource async invocations (CDK Provider framework with
   * `isCompleteHandler`) poll for up to `asyncResponseTimeoutMs`
   * (default 1 hour, matching CDK's `totalTimeout` default). The deploy
   * engine's global `--resource-timeout` default is 30 minutes, which
   * would abort a perfectly healthy CR mid-poll. By self-reporting the
   * polling cap, the engine lifts the deadline to `max(self-report,
   * global)` for CR resources only; a user-supplied per-type override
   * (`--resource-timeout AWS::CloudFormation::CustomResource=5m`) still
   * wins for explicit escape-hatching.
   */
  getMinResourceTimeoutMs(): number {
    return this.asyncResponseTimeoutMs;
  }

  /**
   * Set the S3 bucket for custom resource responses.
   * Called by ProviderRegistry when the state bucket is configured.
   *
   * There is deliberately NO region parameter (issue #1202): the bucket's
   * ACTUAL region is resolved lazily via `ensureResponseClient()` before
   * the first S3 operation (issue #1195), starting from the shared
   * `AwsClients.s3` client so `--profile` / static credentials carry into
   * both the `GetBucketLocation` probe and the rebuilt client. The former
   * deploy-region hint parameter built a default-credential-chain client
   * (dropping `--profile`) and added nothing — the probe resolves the
   * bucket's real region regardless of the starting client's region.
   */
  setResponseBucket(bucket: string): void {
    this.responseBucket = bucket;
    this.responseClientGeneration++;
    this.responseClientResolved = false;
    this.responseClientResolveInFlight = null;
  }

  /**
   * Swap `this.s3Client`, destroying the previous client when the
   * provider owned it (never the shared `AwsClients.s3` instance).
   * The optional call tolerates test doubles without a `destroy`.
   */
  private replaceS3Client(replacement: S3Client): void {
    if (this.ownsS3Client) {
      (this.s3Client as { destroy?: () => void }).destroy?.();
    }
    this.s3Client = replacement;
    this.ownsS3Client = true;
  }

  /**
   * Resolve the response bucket's actual region and, if it differs from the
   * current S3 client's configured region, swap in a region-corrected client
   * before any response-bucket S3 operation (placeholder `PutObject`,
   * pre-signed `ResponseURL` signing, response polling, cleanup).
   *
   * The response bucket is cdkd's state bucket, which can live in a
   * different region from the deploy region (`cdkd deploy --region` /
   * `AWS_REGION` against the account-scoped region-free default bucket).
   * A pre-signed URL's host is region-specific, so signing with the deploy
   * region against a foreign-region bucket makes S3 return a
   * 301 PermanentRedirect (issue #1195). Mirrors the lazy
   * `ensureClientForBucket()` correction the state backend (#60), the
   * LockManager (#803), and the ExportIndexStore (#819) already do via the
   * shared `rebuildClientForBucketRegion` helper (#827).
   *
   * `tolerateNonStandardClient` keeps test doubles (a bare `{ send }`
   * object from a mocked `getAwsClients`) on the no-rebuild path, and
   * `resolveBucketRegion` never throws (probe failures degrade to
   * "no rebuild"), so this can only improve the client's region.
   */
  private async ensureResponseClient(): Promise<void> {
    if (this.responseClientResolved || !this.responseBucket) return;
    if (this.responseClientResolveInFlight) return this.responseClientResolveInFlight;

    const bucket = this.responseBucket;
    const generation = this.responseClientGeneration;
    this.responseClientResolveInFlight = (async (): Promise<void> => {
      try {
        const replacement = await rebuildClientForBucketRegion(this.s3Client, bucket, {
          reuseClientCredentials: true,
          tolerateNonStandardClient: true,
          onRebuild: ({ bucketRegion, currentRegion }) => {
            this.logger.debug(
              `Custom resource response bucket '${bucket}' is in '${bucketRegion}' (client was '${String(currentRegion)}'); building a region-corrected S3 client for response operations.`
            );
          },
        });
        if (generation !== this.responseClientGeneration) {
          // A setResponseBucket re-arm superseded this probe while it was
          // in flight — its result targets the OLD bucket; committing it
          // would pin the wrong client AND suppress the new bucket's
          // resolution. Discard it (the next operation re-probes).
          (replacement as { destroy?: () => void } | null)?.destroy?.();
          return;
        }
        if (replacement) {
          this.replaceS3Client(replacement);
        }
        this.responseClientResolved = true;
      } finally {
        if (generation === this.responseClientGeneration) {
          this.responseClientResolveInFlight = null;
        }
      }
    })();

    return this.responseClientResolveInFlight;
  }

  /**
   * Resolve {@link syntheticStackId} against this deploy's REAL account /
   * region / partition (issue #1866).
   *
   * `getAccountInfo` never throws — it answers a `fabricated` account when STS
   * cannot, which {@link SYNTHETIC_STACK_ID_PLACEHOLDER_ACCOUNT} handles — so
   * this cannot turn a working deploy into a failing one on the credential
   * path. It is resolved ONCE per `create` / `update` / `delete` rather than
   * per invocation attempt: the value does not vary between attempts, and the
   * request builder the retry loop re-runs is synchronous.
   */
  private async resolveSyntheticStackId(logicalId: string): Promise<string> {
    const accountInfo = await getAccountInfo(this.configuredRegion);
    if (accountInfo.fabricated) {
      this.logger.warn(
        `Custom resource ${logicalId}: STS did not report this deploy's account id, so the ` +
          `synthetic StackId handed to the handler carries the placeholder account ` +
          `${SYNTHETIC_STACK_ID_PLACEHOLDER_ACCOUNT}. A handler that parses StackId to re-derive ` +
          `the account it is running in will not get a usable one — fix the credentials (or set ` +
          `AWS_ACCOUNT_ID) and re-run.`
      );
    }
    return syntheticStackId(logicalId, accountInfo);
  }

  /**
   * Create a custom resource by invoking its Lambda handler
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating custom resource ${logicalId} (${resourceType})`);

    const serviceToken = properties['ServiceToken'];

    if (!serviceToken) {
      throw new ProvisioningError(
        `ServiceToken is required for custom resource ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (typeof serviceToken !== 'string') {
      throw new ProvisioningError(
        `Custom Resource ${logicalId}: ServiceToken is not a resolved string ARN (got ${typeof serviceToken}). ` +
          `This usually indicates state was written by a pre-fix cdkd import; ` +
          `re-run \`cdkd import\` or \`cdkd state orphan <stack>\` to recover.`,
        resourceType,
        logicalId
      );
    }

    try {
      const cfnResponse = await this.invokeCustomResourceWithRetry(
        serviceToken,
        logicalId,
        'Create',
        (invocation) => ({
          RequestType: 'Create',
          RequestId: invocation.requestId,
          ResponseURL: invocation.responseURL,
          ResourceType: resourceType,
          LogicalResourceId: logicalId,
          StackId: invocation.stackId,
          ResourceProperties: this.stringifyProperties(properties),
        }),
        // Issue #2178: the handler's response can echo the RESOLVED
        // `ResourceProperties` back, so the payload refusal masks before it
        // stringifies. Absent means unmasked.
        maskerOrIdentity(context?.maskSecrets)
      );

      if (cfnResponse.Status === 'FAILED') {
        throw new Error(
          `Custom resource handler returned FAILED: ${cfnResponse.Reason || 'Unknown reason'}`
        );
      }

      const physicalId: string = cfnResponse.PhysicalResourceId || logicalId;
      const attributes: Record<string, unknown> = cfnResponse.Data || {};

      this.logger.debug(`Successfully created custom resource ${logicalId}: ${physicalId}`);

      // Issue #2274: relay the handler's own `NoEcho` declaration to the deploy
      // engine, which turns it into MASK-ONLY redaction needles so the
      // generated value never reaches `state.json`. NOT masked here: the
      // attributes returned from this method are what `Fn::GetAtt` resolves
      // to, and CloudFormation delivers that value to a dependent resource in
      // the CLEAR (measured on the issue thread against real CFn). Masking at
      // capture would store the literal mask as the dependent's real property.
      return {
        physicalId,
        attributes,
        ...(cfnResponse.NoEcho === true && { noEchoAttributes: true }),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create custom resource ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update a custom resource by invoking its Lambda handler
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating custom resource ${logicalId}: ${physicalId} (${resourceType})`);

    const serviceToken = properties['ServiceToken'];

    if (!serviceToken) {
      throw new ProvisioningError(
        `ServiceToken is required for custom resource ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    if (typeof serviceToken !== 'string') {
      throw new ProvisioningError(
        `Custom Resource ${logicalId}: ServiceToken is not a resolved string ARN (got ${typeof serviceToken}). ` +
          `This usually indicates state was written by a pre-fix cdkd import; ` +
          `re-run \`cdkd import\` or \`cdkd state orphan <stack>\` to recover.`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      const cfnResponse = await this.invokeCustomResourceWithRetry(
        serviceToken,
        logicalId,
        'Update',
        (invocation) => ({
          RequestType: 'Update',
          RequestId: invocation.requestId,
          ResponseURL: invocation.responseURL,
          ResourceType: resourceType,
          LogicalResourceId: logicalId,
          PhysicalResourceId: physicalId,
          StackId: invocation.stackId,
          ResourceProperties: this.stringifyProperties(properties),
          OldResourceProperties: this.stringifyProperties(previousProperties),
        }),
        // Issue #2178: see `create()` — same payload refusal, same bag.
        maskerOrIdentity(context?.maskSecrets)
      );

      if (cfnResponse.Status === 'FAILED') {
        throw new Error(
          `Custom resource handler returned FAILED: ${cfnResponse.Reason || 'Unknown reason'}`
        );
      }

      const newPhysicalId: string = cfnResponse.PhysicalResourceId || physicalId;
      const wasReplaced: boolean = newPhysicalId !== physicalId;
      const attributes: Record<string, unknown> = cfnResponse.Data || {};

      this.logger.debug(
        `Successfully updated custom resource ${logicalId}: ${newPhysicalId}${wasReplaced ? ' (replaced)' : ''}`
      );

      // Issue #2274: see `create()` — same relay, same reason for not masking
      // here. `NoEcho` is per RESPONSE, so a handler that sets it on Create and
      // omits it on Update genuinely declares this response public; that is the
      // handler's contract to keep, and cdkd reports what it was told.
      return {
        physicalId: newPhysicalId,
        wasReplaced,
        attributes,
        ...(cfnResponse.NoEcho === true && { noEchoAttributes: true }),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update custom resource ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a custom resource by invoking its Lambda handler
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    _context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    // Custom resources delegate deletion to a user-provided Lambda handler.
    // The Lambda invocation itself does not surface a `*NotFound` for the
    // managed resource, so the region-mismatch check has no signal to act on
    // here; the underlying Lambda's region is determined by its ARN, which is
    // already encoded in the ServiceToken regardless of the cdkd client's
    // region. The context parameter is accepted for interface conformity.
    this.logger.debug(`Deleting custom resource ${logicalId}: ${physicalId} (${resourceType})`);

    // Issue #1770: the two arms below are SKIPS, not deletes. A custom
    // resource's teardown lives entirely in the user's handler, and the only
    // way to reach it is `ServiceToken`. Without it the handler never sees a
    // `Delete` request, so whatever the resource manages (records in a
    // third-party API, objects in another account, a DNS entry) is untouched.
    // Contrast the backing-Lambda-is-gone pre-check further down, which stays
    // a `deleted`: there the handler CANNOT run ever again, so the record is
    // dead weight rather than a live resource.
    //
    // "LEFT IN PLACE" is unconditional for these two, unlike the
    // Lambda-permission / IAM-policy arms which qualify it: what survives is
    // whatever the user's handler provisioned OUTSIDE this stack (a record in a
    // third-party API, an object in another account), and no other delete in
    // this destroy can undo that. Deleting the backing Lambda does not either —
    // it only makes the teardown permanently unreachable.
    if (!properties) {
      this.logger.warn(
        `No properties available for custom resource ${logicalId}, skipping deletion — the ` +
          `handler is never invoked, so anything this custom resource manages is LEFT IN ` +
          `PLACE. Restore the record's properties in state.json and re-run, or tear the ` +
          `resource down by hand. ${DEPLOY_SKIP_CAVEAT}`
      );
      return { outcome: 'skipped', reason: CR_NO_PROPERTIES_SKIP_REASON };
    }

    const serviceToken = properties['ServiceToken'];

    if (!serviceToken) {
      this.logger.warn(
        `No ServiceToken found for custom resource ${logicalId}, skipping deletion — there is ` +
          `no handler to send the Delete request to, so anything this custom resource manages ` +
          `is LEFT IN PLACE. Restore ServiceToken in state.json and re-run, or tear the ` +
          `resource down by hand. ${DEPLOY_SKIP_CAVEAT}`
      );
      return { outcome: 'skipped', reason: CR_NO_SERVICE_TOKEN_SKIP_REASON };
    }

    if (typeof serviceToken !== 'string') {
      throw new ProvisioningError(
        `Custom Resource ${logicalId}: ServiceToken is not a resolved string ARN (got ${typeof serviceToken}). ` +
          `This usually indicates state was written by a pre-fix cdkd import; ` +
          `re-run \`cdkd import\` or \`cdkd state orphan <stack>\` to recover.`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    // Fail-fast for re-run idempotency (issue #804): after an interrupted /
    // partially-failed destroy, the preserved state can still list a Custom
    // Resource whose backing Lambda was ALSO deleted in the first run. The
    // delete handler can never run again in that case — but without this
    // pre-check, `waitForBackingLambdaReady`'s SDK waiters classify
    // `ResourceNotFoundException` as RETRY (no error acceptor) and poll
    // GetFunction for the full 10-minute `maxWaitTime` before the lenient
    // catch below swallows the timeout. One GetFunction up front turns that
    // stall into the same instant warn-and-continue every other provider's
    // "not found" path gets. Delete-only: create / update against a missing
    // function must keep failing loudly through the normal invoke path.
    if (!this.isSnsServiceToken(serviceToken) && (await this.isBackingLambdaGone(serviceToken))) {
      // Still a DELETE, deliberately — see {@link CR_SKIP_NOT_A_RETRY_CAVEAT}
      // for why the honest answer (`'skipped'`) is not taken here. Flipping it
      // would turn a currently-green teardown red for the legitimate shape too
      // (a shared provider stack destroyed before its consumers, where the
      // ServiceToken points at a Lambda another stack already removed), and
      // that trade is the maintainer's call, not this arm's.
      //
      // What IS fixed here is the silence: this used to read as a clean
      // success, so a record kept by a skip one run earlier disappeared with no
      // hint that anything survived.
      this.logger.warn(
        `Backing Lambda for custom resource ${logicalId} no longer exists (${serviceToken}); ` +
          `treating the custom resource as already deleted and DROPPING its state record. The ` +
          `handler can never run again, so if its teardown was never PROVEN — e.g. an earlier ` +
          `run reported this resource as skipped (issue 2054) — whatever it manages is still ` +
          `LIVE and is now untracked by cdkd. Check for leftovers before treating the stack as ` +
          `gone.`
      );
      return;
    }

    try {
      const cfnResponse = await this.invokeCustomResourceWithRetry(
        serviceToken,
        logicalId,
        'Delete',
        (invocation) => ({
          RequestType: 'Delete',
          RequestId: invocation.requestId,
          ResponseURL: invocation.responseURL,
          ResourceType: resourceType,
          LogicalResourceId: logicalId,
          PhysicalResourceId: physicalId,
          StackId: invocation.stackId,
          ResourceProperties: this.stringifyProperties(properties),
        }),
        // `DeleteContext` carries no masker by the SecretMaskingContext
        // contract — see DELETE_PATH_UNMASKED.
        DELETE_PATH_UNMASKED
      );

      // Issue #2054: the handler RAN and said it did not delete. This arm used
      // to warn and fall through to `return undefined`, which `deleteSkipReason`
      // reads as DELETED — so the record was dropped, the row printed as
      // deleted and the destroy exited 0 over a resource the handler had
      // explicitly refused to remove. Same silent-orphan class as the catch
      // below (issue #2033) and the two guard arms above (issue #1752),
      // reached through the RESPONSE rather than a throw. See
      // {@link CR_DELETE_HANDLER_FAILED_SKIP_REASON} for why this is
      // unconditional (no already-gone classifier) and for the compatibility
      // break it carries.
      if (cfnResponse.Status === 'FAILED') {
        this.logger.warn(
          `Custom resource delete handler returned FAILED for ${logicalId}: ` +
            `${cfnResponse.Reason || 'Unknown reason'}. The handler reported that it did NOT ` +
            `delete, so anything this custom resource manages is LEFT IN PLACE — cdkd is KEEPING ` +
            `the state record and the run exits non-zero. ${CR_SKIP_NOT_A_RETRY_CAVEAT} ` +
            `('cdkd deploy' also accepts --allow-unaddressed, which forces exit 0; ` +
            `'cdkd destroy' has no such flag.) ${DEPLOY_SKIP_CAVEAT}`
        );
        return { outcome: 'skipped', reason: CR_DELETE_HANDLER_FAILED_SKIP_REASON };
      }
      this.logger.debug(`Successfully deleted custom resource ${logicalId}`);
    } catch (error) {
      // Issue #2033: lenient, but NOT silent. This catch used to swallow the
      // error and fall through to `return undefined`, which `deleteSkipReason`
      // reads as DELETED — so `cdkd destroy` printed `✓ … deleted`, dropped the
      // state record and exited 0 over a handler that never received a
      // `Delete`. A permanent `lambda:InvokeFunction` denial therefore silently
      // ORPHANED everything that handler manages, with the id needed to reach
      // it deleted in the same breath.
      //
      // It is the same silent-orphan class the two guard arms above already
      // report as `'skipped'` (issue #1752); the only difference is that this
      // one is reached through a throw. Continuing to warn-and-continue is
      // still right — a destroy must not abort on one custom resource — but the
      // OUTCOME has to say the resource is unproven, so the runner keeps the
      // record, counts it apart and exits 2.
      //
      // The AWS message goes in the WARNING, never in the `reason`: a reason is
      // rendered into the `Error` the deploy-side replacement sites throw, and
      // their catch classifies "already deleted" by substring, so an AWS text
      // carrying `does not exist` would put the record right back in the bin.
      this.logger.warn(
        `Failed to delete custom resource ${logicalId}, but continuing: ${error instanceof Error ? error.message : String(error)}. ` +
          `The Delete handler did not complete, so anything this custom resource manages may still ` +
          `be LIVE — cdkd is KEEPING the state record and the run exits non-zero. ` +
          `${CR_SKIP_NOT_A_RETRY_CAVEAT} ${DEPLOY_SKIP_CAVEAT}`
      );
      return { outcome: 'skipped', reason: CR_DELETE_INVOKE_FAILED_SKIP_REASON };
    }
  }

  /**
   * Check if a ServiceToken is an SNS topic ARN.
   *
   * This is the SNS-vs-Lambda routing decision for the whole provider — it
   * gates `sendRequest` (publish to SNS + poll S3 vs synchronous Invoke), the
   * delete path's backing-Lambda pre-check, and `recycleBackingFunctionExecEnv`.
   * A hardcoded `arn:aws:` prefix therefore did not merely record a wrong
   * string outside the commercial partition: an `arn:aws-cn:sns:` /
   * `arn:aws-us-gov:sns:` ServiceToken was classified Lambda-backed and every
   * one of those paths took the wrong branch (issue #1815). See
   * {@link SNS_SERVICE_TOKEN_ARN_RE} for why the partition is read off the ARN.
   */
  isSnsServiceToken(serviceToken: string): boolean {
    return SNS_SERVICE_TOKEN_ARN_RE.test(serviceToken);
  }

  /**
   * Single GetFunction probe used by the delete path's fail-fast pre-check
   * (issue #804). Returns true ONLY on a definitive
   * `ResourceNotFoundException` — the one signal that proves the backing
   * Lambda is gone and the delete handler can never run. Any other failure
   * (throttle, IAM denial, network) is inconclusive: fall through to the
   * normal invoke path, which has its own error handling and the lenient
   * delete catch.
   */
  private async isBackingLambdaGone(serviceToken: string): Promise<boolean> {
    try {
      await this.lambdaClient.send(new GetFunctionCommand({ FunctionName: serviceToken }));
      return false;
    } catch (error) {
      if ((error as { name?: string }).name === 'ResourceNotFoundException') {
        return true;
      }
      this.logger.debug(
        `GetFunction pre-check for ${serviceToken} failed inconclusively (${
          error instanceof Error ? error.message : String(error)
        }); proceeding with the normal delete invoke`
      );
      return false;
    }
  }

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
  private async invokeCustomResourceWithRetry(
    serviceToken: string,
    logicalId: string,
    operation: string,
    buildRequest: (invocation: {
      requestId: string;
      responseKey: string;
      responseURL: string;
      stackId: string;
    }) => Record<string, unknown>,
    mask: MaskerFn | undefined
  ): Promise<CfnCustomResourceResponse> {
    // One watch for the whole invocation, disposed in the `finally` below, so
    // Ctrl-C aborts a 47.75s pre-delivery backoff and the placeholder
    // `PutObject`'s own retry schedule instead of sitting them out.
    const watch = startInterruptWatch(`Custom resource ${logicalId}`);
    try {
      // Resolved ONCE per call, and deliberately AFTER the watch above: the
      // value does not vary between attempts, and `getAccountInfo` never
      // throws, so there is nothing to gain from re-resolving it per attempt.
      const stackId = await this.resolveSyntheticStackId(logicalId);
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
          invocation = await this.prepareInvocation(logicalId, watch);
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
          // No exec-env recycle here, unlike the FAILED-response arm: the denial
          // is on CDKD's OWN principal (the deploying role's `lambda:InvokeFunction`
          // / `s3:PutObject`), not on the backing function's execution role, so
          // there is no warm container holding stale credentials to invalidate —
          // and `UpdateFunctionConfiguration` would need the very permissions that
          // are still propagating.
          const delayMs = Math.min(
            IAM_PROPAGATION_INITIAL_DELAY_MS * Math.pow(2, preDeliveryRetries),
            IAM_PROPAGATION_MAX_DELAY_MS
          );
          this.logger.warn(
            `Custom resource ${operation} for ${logicalId} hit a transient IAM-authorization error ` +
              `before the request was delivered (attempt ${attempt + 1}/${this.preDeliveryAuthzMaxRetries + 1}): ` +
              `${this.truncateReason(error instanceof Error ? error.message : String(error))}. ` +
              `Retrying in ${delayMs / 1000}s with a fresh response URL and RequestId.`
          );
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
              `(attempt ${attempt + 1}/${this.transientAuthzMaxRetries + 1}): ${this.truncateReason(cfnResponse.Reason)}. ` +
              (logAuthzMatch === undefined
                ? ''
                : `The handler's reason carried no authorization wording; the denial was found in the backing function's log: ${this.truncateReason(logAuthzMatch.line)}. `) +
              `Recycling the backing function's execution environment and retrying so its next cold start picks up the propagated policy.`
          );
          await this.recycleBackingFunctionExecEnv(serviceToken, logicalId);
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
              this.truncateReason(logTail, CR_LOG_TAIL_WARN_MAX_CHARS)
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
  private isTransientAuthzFailure(reason: string | undefined): boolean {
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
   * **Every pattern in that union is an AUTHORIZATION or REQUEST-VALIDATION
   * rejection, and that is what makes replaying an `Invoke` safe here.** Such a
   * rejection is decided at the API front door, before any execution environment
   * is engaged, so the handler provably did not run and a replay cannot
   * re-deliver work — the hazard `disableOuterRetry` exists for. It is also why
   * this classifier deliberately does NOT reach for the broader
   * `isRetryableTransientError`: a throttle, an HTTP 5xx or a socket timeout can
   * each arrive AFTER the request was accepted, so replaying one could invoke a
   * non-idempotent handler twice. Those classes stay single-shot on this path by
   * design, and the caller's `delivered` flag is the second, independent fence.
   */
  private isTransientAuthzThrow(error: unknown): boolean {
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
  private findTransientAuthzLogLine(
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
  private truncateReason(reason: string | undefined, max = 200): string {
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
   * Force the backing Lambda to drop its warm execution environment(s) so the
   * next invoke cold-starts and re-assumes the execution role, picking up the
   * now-propagated inline policy. A plain re-invoke would otherwise reuse the
   * same warm container that cached the stale credentials. Best-effort: any
   * failure (e.g. cdkd's own creds lack `lambda:UpdateFunctionConfiguration`)
   * degrades to a debug log and we still retry the invoke.
   *
   * The no-op `Description` write is the least-intrusive way to invalidate warm
   * containers. It persists on the backing function, but cdkd never reconciles
   * the CDK Provider framework's backing Lambda against a template `Description`
   * (the synthesized template leaves it empty / CDK-default and cdkd's diff only
   * compares state-recorded properties), so it does not surface as drift on a
   * later deploy. Only the IAM-propagation retry path (rare) ever sets it.
   */
  private async recycleBackingFunctionExecEnv(
    serviceToken: string,
    logicalId: string
  ): Promise<void> {
    // SNS-backed custom resources have no Lambda to recycle (the token is a
    // topic ARN); skip the pointless, guaranteed-to-fail API call.
    if (this.isSnsServiceToken(serviceToken)) return;
    try {
      await this.lambdaClient.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName: serviceToken,
          Description: `cdkd: recycled for IAM-propagation retry (${logicalId})`,
        })
      );
      await waitUntilFunctionUpdatedV2(
        // Explicit cadence per the repo-wide waiter rule (#1291 item 5);
        // matches the Lambda V2 waiters' own dense 1s default.
        { client: this.lambdaClient, maxWaitTime: 120, minDelay: 1, maxDelay: 5 },
        { FunctionName: serviceToken }
      );
    } catch (error) {
      this.logger.debug(
        `Could not recycle backing function for ${logicalId} (${
          error instanceof Error ? error.message : String(error)
        }); retrying invoke without a forced cold start`
      );
    }
  }

  /**
   * Send custom resource request via the appropriate service (Lambda or SNS)
   * For Lambda: invokes synchronously and returns the response
   * For SNS: publishes to topic and polls S3 for response
   *
   * Also returns the backing function's raw invocation `LogResult` when there
   * is one, so the caller can recover an authorization denial the handler
   * erased from the FAILED reason (issue #1674). Returned UNDECODED so the
   * happy path pays nothing — only a FAILED whose reason missed decodes it.
   * Absent on the SNS path: there is no Lambda invoke to attach a log to.
   *
   * `onDelivered` is invoked exactly once, the moment the `Invoke` / `Publish`
   * RETURNS — i.e. at the point after which a replay would re-deliver the
   * request to the handler and strand this attempt's pre-signed response URL.
   * The caller's retry-on-throw arm is fenced on it (issue #2033). Deliberately
   * called AFTER the send rather than before: a rejection at the API front door
   * (the IAM-propagation class this arm exists for) means the handler never ran,
   * and treating that as delivered would leave the reported failure single-shot.
   */
  private async sendRequest(
    serviceToken: string,
    request: Record<string, unknown>,
    responseKey: string,
    logicalId: string,
    operation: string,
    onDelivered: () => void,
    mask: MaskerFn | undefined
  ): Promise<{ response: CfnCustomResourceResponse; logResult?: string }> {
    if (this.isSnsServiceToken(serviceToken)) {
      this.logger.debug(`ServiceToken is SNS topic, publishing to: ${serviceToken}`);
      await this.publishToSns(serviceToken, request);
      onDelivered();
      return { response: await this.pollS3Response(responseKey, logicalId, operation) };
    }

    // Block until the backing Lambda is in a ready-to-Invoke state. The
    // Lambda CREATE / UPDATE returns synchronously while State / LastUpdateStatus
    // is still `Pending` / `InProgress`; a synchronous Invoke against
    // either fails with "The function is currently in the following
    // state: Pending" / "InProgress" (see PR #121). We wait HERE — at the
    // one consumer that breaks against not-ready Lambdas — instead of
    // gating every Lambda CREATE on Active, which doubled deploy time on
    // VPC-Lambda benchmark stacks.
    await this.waitForBackingLambdaReady(serviceToken, logicalId);

    const invokeResponse = await this.invokeLambda(serviceToken, request);
    onDelivered();
    return {
      response: await this.getCustomResourceResponse(
        invokeResponse,
        responseKey,
        logicalId,
        operation,
        mask
      ),
      ...(invokeResponse.LogResult === undefined ? {} : { logResult: invokeResponse.LogResult }),
    };
  }

  /**
   * Block until the backing Lambda function for a Custom Resource is in a
   * state that accepts a synchronous Invoke.
   *
   * Two sequential waiters:
   *   1. `waitUntilFunctionActiveV2` — handles the post-CreateFunction
   *      `Pending` window (image pull, VPC ENI attachment, layer init).
   *   2. `waitUntilFunctionUpdatedV2` — handles the post-Update
   *      `InProgress` window (configuration / code swap settling).
   * Together they cover the only two transient states that reject
   * synchronous Invokes.
   *
   * In the common case (Lambda has been Active for a while, no in-flight
   * Update), both waiters return on first poll → ~2 GetFunction calls →
   * ~200ms overhead. That's the price for correctness; the alternative
   * (whole-stack Active wait at Lambda CREATE) is ~5–10 minutes per
   * VPC-attached function.
   *
   * `serviceToken` is the Lambda function ARN; the Lambda SDK accepts
   * both name and ARN as `FunctionName`, so we pass the ARN through
   * unchanged.
   *
   * `maxWaitTime` is set generously (10 min) because VPC ENI attachment
   * has been observed to take 8+ minutes in pathological cases. The
   * deploy engine's per-resource `--resource-timeout` (default 30 min)
   * still bounds the outer Custom Resource provisioning attempt, so
   * this waiter cap is layered defense, not the only timeout.
   *
   * **The wrapped failure is `markNonRetryable`d, and its message is NOT the
   * waiter's** (issue #2033). Both halves are about `@smithy/util-waiter`'s
   * `checkExceptions`, which serializes its whole result into the `Error`
   * message:
   *
   *  - On TIMEOUT that includes `observedResponses`, whose keys read
   *    `403: User: … is not authorized to perform: lambda:GetFunction on
   *    resource: …`. The waiter's generated `checkState` catches EVERY
   *    exception and returns `RETRY`, so reaching here means a 600s budget was
   *    already spent — yet the message matched
   *    {@link CustomResourceProvider.isTransientAuthzThrow} exactly, so a
   *    PERMANENT `lambda:GetFunction` denial was replayed for 3 x 600s instead
   *    of 10 minutes, blowing any `--resource-timeout
   *    AWS::CloudFormation::CustomResource=15m`. The marker is a property of
   *    the error object, so unlike a wording test it cannot be defeated by AWS
   *    rephrasing the denial.
   *  - On the non-TIMEOUT arm (`State: Failed`, i.e. an ENI / VPC failure) the
   *    serialized result carries `reason` and `final`, which for this waiter
   *    are the ENTIRE `GetFunction` response — `Configuration.Environment.
   *    Variables` included. That message reached `ProvisioningError.message`
   *    and `extractDeploymentEventError` persisted it to
   *    `deployments/{runId}.jsonl`, a durable store that outlives
   *    `cdkd destroy` and is contractually "error + metadata only, never
   *    resource properties, because they may contain secrets"
   *    (`docs/deployment-events.md`). So this arm interpolates the error NAME
   *    plus a fixed sentence, and recovers only the function's own
   *    `State` / `StateReason` / `StateReasonCode` — AWS-authored status
   *    fields — from the serialized payload. The TIMEOUT / ABORT arms keep
   *    their message: `observedResponses` keys are status lines built by
   *    `createMessageFromResponse`, never a response body.
   */
  private async waitForBackingLambdaReady(serviceToken: string, logicalId: string): Promise<void> {
    try {
      await waitUntilFunctionActiveV2(
        // Explicit cadence per the repo-wide waiter rule (#1291 item 5);
        // matches the Lambda V2 waiters' own dense 1s default.
        { client: this.lambdaClient, maxWaitTime: 600, minDelay: 1, maxDelay: 5 },
        { FunctionName: serviceToken }
      );
      await waitUntilFunctionUpdatedV2(
        // Explicit cadence per the repo-wide waiter rule (#1291 item 5);
        // matches the Lambda V2 waiters' own dense 1s default.
        { client: this.lambdaClient, maxWaitTime: 600, minDelay: 1, maxDelay: 5 },
        { FunctionName: serviceToken }
      );
    } catch (error) {
      throw markNonRetryable(
        new Error(
          `Lambda backing custom resource ${logicalId} (${serviceToken}) did not reach a ready state for Invoke: ${describeWaiterFailure(
            error
          )}`,
          { cause: error }
        )
      );
    }
  }

  /**
   * Publish custom resource request to an SNS topic
   */
  private async publishToSns(topicArn: string, request: Record<string, unknown>): Promise<void> {
    await this.snsClient.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify(request),
      })
    );
  }

  /**
   * Invoke Lambda function synchronously
   *
   * `LogType: 'Tail'` makes Lambda return the last 4 KB of THIS invocation's
   * log, base64-encoded, in `LogResult` (issue #1674). It is only valid with
   * `RequestResponse`, which is what this path always uses. This is deliberately
   * preferred over reading the function's CloudWatch log group after the fact:
   * it needs no CloudWatch Logs client, no `logs:GetLogEvents` on cdkd's own
   * credentials, and no extra API call — the tail rides the invoke response
   * cdkd already waits for, and is scoped to the exact invocation that failed
   * rather than to whatever happens to be latest in the log stream.
   */
  private async invokeLambda(
    serviceToken: string,
    request: Record<string, unknown>
  ): Promise<InvocationResponse> {
    return await this.lambdaClient.send(
      new InvokeCommand({
        FunctionName: serviceToken,
        InvocationType: 'RequestResponse',
        LogType: 'Tail',
        Payload: Buffer.from(JSON.stringify(request)),
      })
    );
  }

  /**
   * Get custom resource response from either Lambda payload or S3
   *
   * Strategy:
   * 1. If Lambda returned a direct payload with Status field → use it (cfn-response inline)
   * 2. If Lambda returned a payload with PhysicalResourceId → use it (simple handler)
   * 3. Otherwise, poll S3 for the response (cfn-response via ResponseURL)
   */
  private async getCustomResourceResponse(
    lambdaResponse: InvocationResponse,
    responseKey: string,
    logicalId: string,
    operation: string,
    mask: MaskerFn | undefined
  ): Promise<CfnCustomResourceResponse> {
    // Check for Lambda execution errors
    if (lambdaResponse.FunctionError) {
      const errorPayload = lambdaResponse.Payload
        ? Buffer.from(lambdaResponse.Payload).toString()
        : 'Unknown';
      // A handler that dies instead of sending a cfn-response leaves the real
      // cause only in its log, and the `LogType: 'Tail'` invoke already carries
      // it — so LOG it rather than sending the user to CloudWatch (issue #1674).
      //
      // Deliberately a `warn` and NOT part of the thrown message: a thrown
      // error's `message` is captured by `extractDeploymentEventError` and
      // persisted to `deployments/{runId}.jsonl`, which OUTLIVES `cdkd destroy`.
      // That store's contract is error + metadata only, explicitly never
      // anything that may carry secrets — and a log tail is arbitrary handler
      // stdout, so a `print(event)` in a handler would write the custom
      // resource's `ResourceProperties` into it. The warning is ephemeral, so
      // the diagnostic is available without widening what cdkd stores.
      //
      // Still capped: ephemeral is not free — this lands in CI logs and
      // terminal scrollback, where the same `print(event)` argument applies
      // with less force but does apply. The cap is generous relative to
      // `truncateReason`'s 200 because a crashed handler's cause is often
      // several lines above the last one (a Python traceback), and the whole
      // tail is Lambda-capped at 4 KB regardless.
      // Same `hasHandlerLogOutput` filter as the unexplained-FAILED arm: both
      // surface the SAME data class through the same ephemeral channel, so a
      // boilerplate-only tail is worth exactly as little here. Keeping the two
      // gates identical is also what makes `CR_LOG_TAIL_BOILERPLATE`'s claim
      // ("a tail consisting only of these carries no diagnostic value") true of
      // the whole file rather than of one arm. Reaching it needs a crashed or
      // timed-out handler that logged nothing at all — Lambda's own
      // `Task timed out after ...` and `Runtime exited with error: ...` lines
      // are NOT boilerplate by this regex, so the realistic crash shapes still
      // print.
      const logTail = decodeInvokeLogTail(lambdaResponse.LogResult);
      if (logTail !== undefined && hasHandlerLogOutput(logTail)) {
        this.logger.warn(
          `Backing function log tail for ${logicalId} (${operation}):\n` +
            this.truncateReason(logTail, CR_LOG_TAIL_WARN_MAX_CHARS)
        );
      }
      throw new Error(`Lambda function error (${lambdaResponse.FunctionError}): ${errorPayload}`);
    }

    // Try to parse direct Lambda response
    // Track whether Lambda returned a meaningful payload. If not, this likely indicates
    // an async pattern (e.g., CDK Provider framework with isCompleteHandler that delegates
    // to Step Functions for polling).
    let hasDirectPayload = false;
    try {
      const payload = parseLambdaPayload(lambdaResponse.Payload, mask);

      // Check if this is a full cfn-response (has Status field)
      if (
        'Status' in payload &&
        (payload['Status'] === 'SUCCESS' || payload['Status'] === 'FAILED')
      ) {
        this.logger.debug(`Got direct cfn-response from Lambda for ${logicalId}`);
        await this.cleanupResponseObject(responseKey);
        return payload as unknown as CfnCustomResourceResponse;
      }

      // Check if this is a simple handler response (has PhysicalResourceId but no Status)
      if (payload.PhysicalResourceId || payload.Data) {
        this.logger.debug(`Got simple handler response from Lambda for ${logicalId}`);
        await this.cleanupResponseObject(responseKey);
        const result: CfnCustomResourceResponse = {
          Status: 'SUCCESS',
        };
        if (payload.PhysicalResourceId) {
          result.PhysicalResourceId = payload.PhysicalResourceId;
        }
        if (payload.Data) {
          result.Data = payload.Data;
        }
        // Issue #2274: carry `NoEcho` across the synthesis. This arm builds a
        // NEW envelope from two named fields, so anything the handler declared
        // beside them was silently dropped — and `NoEcho` is the one field
        // whose loss is a DISCLOSURE rather than a missing convenience: the
        // handler said its `Data` is sensitive and cdkd persisted it in the
        // clear. The other two delivery shapes (a full cfn-response in the
        // direct payload, and the S3 / ResponseURL envelope through
        // `parseCfnResponseBody`) cast the whole object and never lost it, so
        // this was a per-shape hole rather than a missing feature.
        //
        // `=== true` rather than a truthiness copy: the payload is UNTRUSTED
        // handler output, so a `NoEcho: "false"` string must not be read as a
        // declaration. Erring the other way would be safe here (it only masks
        // more) but the envelope field is a boolean and the two readers of this
        // result treat it as one.
        if (payload.NoEcho === true) {
          result.NoEcho = true;
        }
        return result;
      }

      // Payload parsed but contained no recognizable fields (e.g., empty object from
      // CDK Provider framework after starting Step Functions). Mark as no direct payload.
      hasDirectPayload = Object.keys(payload).length > 0;
    } catch {
      // Payload parsing failed, try S3.
      //
      // DISCARDING `error.message` is LOAD-BEARING here, not incidental. On the
      // DELETE path `parseLambdaPayload` is handed no masker (see
      // DELETE_PATH_UNMASKED and issue #2007), so its refusal message can quote
      // a delete-bag value verbatim, and the delete bag CAN be resolved
      // plaintext on the in-process rollback path. Logging the error object
      // would turn today's nil exposure into a live leak. Thread the capability
      // before widening this catch.
      this.logger.debug(`Lambda payload parse failed for ${logicalId}, checking S3 response`);
    }

    // Poll S3 for response (cfn-response module sends to ResponseURL)
    if (!this.responseBucket) {
      this.logger.warn(
        `No response bucket configured for custom resource ${logicalId}. ` +
          `The Lambda handler likely uses cfn-response module which sends to ResponseURL. ` +
          `Configure --state-bucket to enable S3-based response handling.`
      );
      return {
        Status: 'SUCCESS',
        PhysicalResourceId: logicalId,
      };
    }

    // Detect async custom resource pattern (CDK Provider framework with isCompleteHandler).
    // When the framework Lambda starts a Step Functions state machine for async polling,
    // it returns no meaningful payload (empty/null). In this case, the Step Functions
    // will eventually PUT the cfn-response to the ResponseURL, which may take up to
    // the configured totalTimeout (default: 1 hour in CDK).
    // We use a longer timeout for this case vs the short timeout for synchronous handlers.
    const isAsyncPattern = !hasDirectPayload;
    if (isAsyncPattern) {
      this.logger.debug(
        `Custom resource ${logicalId} uses async Provider framework. ` +
          `Waiting up to ${Math.round(this.asyncResponseTimeoutMs / 60_000)} minutes.`
      );
    } else {
      this.logger.debug(`Waiting for S3 response from Lambda for ${logicalId} (${operation})`);
    }

    const timeoutMs = isAsyncPattern ? this.asyncResponseTimeoutMs : this.SYNC_RESPONSE_TIMEOUT_MS;
    return await this.pollS3Response(responseKey, logicalId, operation, timeoutMs, isAsyncPattern);
  }

  /**
   * Prepare a single Custom Resource invocation: generate the request id,
   * derive the S3 response key from it, sign the pre-signed PUT URL for that
   * key, and return all three together.
   *
   * **The request id, response key, and response URL must all be derived from
   * the SAME generation step.** Previously these were generated by separate
   * calls inside `create` / `update` / `delete`, which made it possible for a
   * future refactor (e.g. wrapping URL signing in a retry that re-rolls the
   * id) to silently break the invariant — the Lambda would write to one S3
   * key while cdkd polled a different one, hanging the deploy until the
   * polling timeout (up to 1 hour). See issue #90.
   *
   * Centralising this in one helper makes that invariant impossible to
   * violate at the call sites.
   */
  private async prepareInvocation(
    logicalId: string,
    watch: InterruptWatch
  ): Promise<{
    requestId: string;
    responseKey: string;
    responseURL: string;
  }> {
    const requestId = `cdkd-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const responseKey = this.getResponseKey(requestId);
    const responseURL = await this.generateResponseURL(responseKey, logicalId, watch);
    return { requestId, responseKey, responseURL };
  }

  /**
   * Generate a pre-signed S3 PUT URL for Lambda to send its response
   */
  private async generateResponseURL(
    responseKey: string,
    logicalId: string,
    watch: InterruptWatch
  ): Promise<string> {
    if (!this.responseBucket) {
      // Fallback: return a dummy URL (legacy behavior)
      return 'https://localhost/cfn-response-not-configured';
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
      throw markNonRetryable(error instanceof Error ? error : new Error(String(error)));
    }

    // Generate pre-signed PUT URL (valid for 2 hours to accommodate async Provider framework
    // patterns where Step Functions may poll isCompleteHandler for up to 1 hour)
    // Don't specify ContentType so any Content-Type is accepted (cfn-response may send different types)
    const command = new PutObjectCommand({
      Bucket: this.responseBucket,
      Key: responseKey,
    });

    const presignedUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: 7200,
    });

    this.logger.debug(
      `Generated pre-signed URL for response: s3://${this.responseBucket}/${responseKey}`
    );
    return presignedUrl;
  }

  /**
   * Poll S3 for the custom resource response
   *
   * Uses exponential backoff for polling interval:
   * - Sync mode (standard handlers): starts at 2s, no backoff (short timeout)
   * - Async mode (Provider framework with isCompleteHandler): starts at 2s, backs off to 30s max
   *
   * @param responseKey S3 key where response will be written
   * @param logicalId Logical resource ID for logging
   * @param operation Operation type (Create/Update/Delete) for logging
   * @param timeoutMs Maximum time to wait for response
   * @param useBackoff Whether to use exponential backoff (for async/long-running operations)
   */
  private async pollS3Response(
    responseKey: string,
    logicalId: string,
    operation: string,
    timeoutMs: number = this.SYNC_RESPONSE_TIMEOUT_MS,
    useBackoff: boolean = false
  ): Promise<CfnCustomResourceResponse> {
    const startTime = Date.now();
    let currentInterval = this.INITIAL_POLL_INTERVAL_MS;
    let pollCount = 0;

    // Listen for SIGINT to abort polling early
    let interrupted = false;
    const sigintHandler = () => {
      interrupted = true;
    };
    process.on('SIGINT', sigintHandler);

    try {
      while (Date.now() - startTime < timeoutMs) {
        if (interrupted) {
          await this.cleanupResponseObject(responseKey);
          process.removeListener('SIGINT', sigintHandler);
          throw new Error(`Custom resource ${logicalId} interrupted by user`);
        }

        pollCount++;
        try {
          const response = await this.s3Client.send(
            new GetObjectCommand({
              Bucket: this.responseBucket!,
              Key: responseKey,
            })
          );

          const body = await response.Body?.transformToString();
          if (body && body.length > 0) {
            // Issue #2250: this line used to log `body.substring(0, 200)`. The
            // body is the custom-resource RESPONSE DOCUMENT, whose `Data` is
            // the documented place a handler returns a generated value — so a
            // generated secret sitting behind a short `PhysicalResourceId`
            // landed inside that window and reached the terminal (and CI logs)
            // on every poll under `--verbose`. Log the ENVELOPE instead.
            //
            // The parse is hoisted ABOVE the log so one result feeds both the
            // summary and the terminal-status check — but the log itself still
            // fires for a body that does NOT parse, which is deliberate: a
            // malformed response is exactly when the diagnostic is worth most.
            // That arm reports the body's LENGTH only, never its bytes.
            //
            // The old `try` also spanned the cleanup + return below. Nothing
            // relied on that: `cleanupResponseObject` swallows its own errors,
            // so the only throw the catch ever saw was `JSON.parse`'s.
            const parsed = parseCfnResponseBody(body);
            this.logger.debug(
              `Got S3 response for ${logicalId}: ${describeCfnResponseBody(body, parsed)}`
            );

            if (parsed.kind === 'envelope') {
              const cfnResponse = parsed.response;

              // Validate response has required fields
              if (cfnResponse.Status === 'SUCCESS' || cfnResponse.Status === 'FAILED') {
                // Cleanup the response object
                await this.cleanupResponseObject(responseKey);
                return cfnResponse;
              }
            } else {
              // Not a usable response document yet — a truncated write, or a
              // handler that wrote a bare JSON scalar. Keep polling.
              this.logger.debug(`S3 response not yet valid JSON for ${logicalId}, retrying...`);
            }
          }
        } catch (error) {
          const err = error as { name?: string };
          if (err.name !== 'NoSuchKey') {
            this.logger.debug(`Error reading S3 response for ${logicalId}: ${err.name}`);
          }
        }

        await this.sleep(currentInterval);

        // Apply exponential backoff for async patterns (long-running operations)
        if (useBackoff) {
          currentInterval = Math.min(currentInterval * 1.5, this.MAX_POLL_INTERVAL_MS);

          // Log progress periodically for long-running operations
          if (pollCount % 10 === 0) {
            const elapsedSec = Math.round((Date.now() - startTime) / 1000);
            this.logger.info(
              `Still waiting for async custom resource ${logicalId} (${operation})... ` +
                `${elapsedSec}s elapsed, polling every ${Math.round(currentInterval / 1000)}s`
            );
          }
        }
      }

      // Cleanup on timeout
      await this.cleanupResponseObject(responseKey);

      const elapsedMin = Math.round((Date.now() - startTime) / 60_000);
      throw new Error(
        `Timeout waiting for custom resource response for ${logicalId} (${operation}) ` +
          `after ${elapsedMin} minutes. ` +
          (useBackoff
            ? `The async custom resource handler (Provider framework with isCompleteHandler) did not complete within the timeout. ` +
              `Check the Step Functions execution and isCompleteHandler Lambda logs for errors.`
            : `The Lambda handler may not be sending a response to ResponseURL.`)
      );
    } finally {
      process.removeListener('SIGINT', sigintHandler);
    }
  }

  /**
   * Get S3 key for response object
   */
  private getResponseKey(requestId: string): string {
    return `${this.responsePrefix}/${requestId}.json`;
  }

  /**
   * Cleanup response object from S3.
   *
   * TWO steps, and the second one is not housekeeping (issue
   * [#2340](https://github.com/go-to-k/cdkd/issues/2340)). `cdkd bootstrap`
   * turns VERSIONING ON for the state bucket, so a bare `DeleteObject` writes
   * a DELETE MARKER and leaves every prior version readable through
   * `GetObject` with a `VersionId`. The object at this key is not a
   * placeholder by then: the handler replied through the pre-signed
   * ResponseURL and PUT its FULL cfn-response body there, `Data` included —
   * which is exactly where a handler-minted secret (a generated password, an
   * issued API key) lives. Delete-only cleanup therefore reports success while
   * the secret stays retrievable by anyone holding `s3:GetObjectVersion` on
   * the state bucket.
   *
   * The purge itself lives in `purgeNoncurrentKeyVersions`, SHARED with `cdkd
   * gc`'s sweep of the abandoned objects at this same prefix — see that
   * module for why it is scoped to the exact key and to what is not
   * `IsLatest`, and why it never throws.
   */
  private async cleanupResponseObject(responseKey: string): Promise<void> {
    if (!this.responseBucket) return;
    const bucket = this.responseBucket;

    // This arm swallows its error because cleanup runs from `finally` blocks
    // and from the timeout arm, and must never abort its caller. Swallowed is
    // NOT the same as succeeded, so it says on the way out what it leaves
    // behind — the response object stays CURRENT — which is not inferable
    // from this method's `void` return. The purge arm below has the same
    // property, enforced inside the shared helper rather than here.
    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: responseKey,
        })
      );
    } catch (error) {
      this.logger.debug(
        `Failed to delete custom-resource response object s3://${bucket}/${responseKey}; ` +
          `it remains as a current object. Underlying error: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Delegated to the SHARED implementation rather than open-coded here:
    // `cdkd gc` sweeps the ABANDONED objects at this same prefix and needs the
    // identical purge, and two copies is how one of them keeps the defect
    // after the other is fixed. The helper never throws and owns the warning,
    // so the cleanup path's must-not-abort property holds by construction.
    await purgeNoncurrentKeyVersions(this.s3Client, bucket, [responseKey], {
      logger: this.logger,
      // Per-caller, because the warning names what a reader must go and
      // inspect and this module is no longer the only caller (issue #2346).
      // The SHARED constant, not a literal: `cdkd gc` deletes this same object
      // and must produce the identical sentence.
      objectDescription: CUSTOM_RESOURCE_RESPONSE_OBJECT_DESCRIPTION,
    });
  }

  /**
   * Convert property values to strings for CloudFormation compatibility
   *
   * CloudFormation converts all ResourceProperties values to strings before
   * passing them to Lambda handlers. Some CDK internal handlers (like
   * BucketNotificationsHandler) depend on this behavior (e.g., calling .lower()
   * on boolean values).
   */
  private stringifyProperties(properties: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (typeof value === 'boolean') {
        result[key] = String(value);
      } else if (typeof value === 'number') {
        result[key] = String(value);
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[key] = this.stringifyProperties(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private sleep(ms: number): Promise<void> {
    return customResourceRetryDelays.sleep(ms);
  }

  /**
   * `sleep` that checks the interrupt watch at most a second apart, mirroring
   * `withRetry`'s own once-per-second probe. Throws the watch's error when the
   * user has hit Ctrl-C, so the retry loop unwinds instead of sitting out the
   * remaining backoff.
   */
  private async sleepInterruptibly(ms: number, watch: InterruptWatch): Promise<void> {
    let remaining = ms;
    while (remaining > 0) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      const chunk = Math.min(1_000, remaining);
      await this.sleep(chunk);
      remaining -= chunk;
    }
    if (watch.isInterrupted()) throw watch.onInterrupted();
  }

  /**
   * Adopt an existing custom resource into cdkd state.
   *
   * **Explicit override only.** A custom resource's identity is the
   * `PhysicalResourceId` returned by its user-supplied Lambda handler at
   * Create time — there is no AWS-side resource cdkd can introspect, no
   * tag API, and no `aws:cdk:path` to look up by. cdkd cannot rediscover
   * a custom resource without invoking the handler, which would mutate
   * state.
   *
   * Users adopting an existing custom resource should pass
   * `--resource <logicalId>=<physicalResourceId>` — the same value the
   * handler returned originally.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      return { physicalId: input.knownPhysicalId, attributes: {} };
    }
    return null;
  }
}
