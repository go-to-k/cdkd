import type { CloudControlProvider } from '../cloud-control-provider.js';
import {
  GetResourceCommand,
  GetResourceRequestStatusCommand,
  type GetResourceRequestStatusCommandOutput,
  type ProgressEvent,
} from '@aws-sdk/client-cloudcontrol';
import { recordPhase } from '../../utils/phase-timings.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { markNonRetryable, markRedactedCause } from '../../deployment/retryable-errors.js';
import { shellQuote } from '../../state/lock-contention-message.js';
import { displaySafe, safeMsg } from '../../utils/display-safe.js';
import { withPasteableAwsProfile } from '../../utils/pasteable-aws-profile.js';
import { maskerOrIdentity } from '../masked-retry-logger.js';
import { getTopLevelDeployAttributeNames } from '../read-only-properties.js';
import { isInterruptedWaitError } from '../interrupt-watch.js';
import { slowCcOperationTimeoutMs } from '../slow-cc-operation-timeouts.js';
import type { CreateContext, ResourceCreateResult } from '../../types/resource.js';
import {
  CloudControlOperationFailedError,
  CloudControlWaitAbandonedError,
  type AbandonedRequestOutcome,
  failedOutcome,
} from './shared.js';
import { describePollFailure, isTransientPollFailure } from './poll-failure.js';
import { maskCallerIdentity, handlerAuthFailureHint } from './caller-identity.js';

/**
 * Wait for an asynchronous operation to complete.
 *
 * Reached from FIVE call sites — `create()`, `update()`, `delete()`,
 * `disableCcProtection()` and `reEnableCcProtection()` — so everything here
 * is CREATE / UPDATE / DELETE behavior at once.
 *
 * The poll is fenced against its own transport (issue #3236). Before that,
 * a `GetResourceRequestStatus` that failed for ANY reason propagated out of
 * this loop, out of `create()`, and took the `RequestToken` — which lives
 * only in this parameter list — with it. The Cloud Control operation keeps
 * running server-side regardless, so a CREATE that AWS went on to complete
 * left a live resource with no state record: invisible to rollback, to
 * `cdkd destroy`, and to `cleanupFailedCreateRemnant` (whose first guard
 * admits only a `CloudControlOperationFailedError`, which a transport
 * failure never is). Reported against a `AWS::RDS::DBInstance` whose CREATE
 * outlived a dropped VPN; the untracked instance then blocked the deletion
 * of five tracked resources that depended on it.
 *
 * Re-polling is IDEMPOTENT in a way replaying the create is not, which is
 * what makes this the right layer for the fix: `GetResourceRequestStatus`
 * invokes no resource handler and the token is unchanged across attempts, so
 * the duplicate-create hazard of go-to-k/cdkd#2039 is structurally absent.
 * The complementary half is {@link CloudControlWaitAbandonedError}, for the
 * outage that outlives the grace or the budget.
 */
export async function waitForOperation(
  this: CloudControlProvider,
  requestToken: string,
  logicalId: string,
  operation: 'CREATE' | 'UPDATE' | 'DELETE',
  resourceType: string,
  /**
   * Per-call override of {@link POLL_TRANSIENT_GRACE_MS}. Only the
   * `--remove-protection` flip and its compensation (`disableCcProtection`,
   * `reEnableCcProtection`) pass one; every provisioning call site takes the
   * default, and a new one should have to say why it does not.
   */
  transientGraceMs: number = this.POLL_TRANSIENT_GRACE_MS
): Promise<ProgressEvent> {
  const startTime = Date.now();
  let attempts = 0;
  let pollInterval = this.INITIAL_POLL_INTERVAL_MS;
  let lastSleepMs = 0;
  // Hoisted out of the loop body deliberately: the identifier is re-bound per
  // pass, so without this the one fact worth reporting about an abandoned
  // wait — what the operation had already named — would be discarded with
  // the iteration that read it.
  let lastSeenIdentifier: string | undefined;
  let transientOutageStartedAt: number | undefined;
  let lastTransientError: unknown;

  // Known-slow types (OpenSearch domains, RDS / Redshift / ElastiCache
  // clusters) legitimately exceed the flat 15-min poll cap on CREATE /
  // DELETE, so lift the cap to their per-type floor. `Math.max` guarantees
  // the cap only ever grows — a normal type keeps the 15-min default.
  // See slow-cc-operation-timeouts.ts for why this floor is shared with the
  // outer per-resource deadline (they must not drift apart).
  const maxWaitMs = Math.max(
    this.MAX_WAIT_TIME_MS,
    slowCcOperationTimeoutMs(resourceType, operation)
  );

  while (Date.now() - startTime < maxWaitMs) {
    attempts++;

    // Annotated rather than inferred. The rationale is NARROWER than an
    // earlier revision claimed ("no compile error"): measured, a
    // falling-through catch is a compile error EITHER way -- `TS2454 used
    // before being assigned` with the annotation, `TS18048 possibly
    // undefined` without it. What the annotation buys is that the error
    // names the ASSIGNMENT rather than a downstream property read, and that
    // the binding is not an evolving `any` a future edit can widen silently.
    let statusResponse: GetResourceRequestStatusCommandOutput;
    try {
      statusResponse = await this.cloudControlClient.send(
        new GetResourceRequestStatusCommand({
          RequestToken: requestToken,
        })
      );
    } catch (error) {
      // Scoped to the `send` expression ALONE, on purpose: the loop's own
      // deliberate throws below — the missing progress event, the FAILED
      // event, CANCEL_COMPLETE — are all raised AFTER this resolves, so no
      // widening of this `try` could swallow one of them.
      // A NON-transient poll failure carries the token out too (round-4
      // review). `isTransientPollFailure` fails CLOSED, which is right for
      // deciding whether to RE-POLL — an `AccessDeniedException` on
      // `GetResourceRequestStatus` can only be re-derived, so spinning on it
      // is pointless. But aborting bare discarded the `RequestToken`, which
      // is issue #3236's whole defect arriving from a permissions error
      // instead of a socket error: a least-privilege role granted
      // `cloudcontrol:CreateResource` but not the status read submits a
      // CREATE, cannot watch it, and AWS goes on to complete it.
      //
      // So: do not retry, but do not lose the handle either. The grace arm
      // and the deadline arm both already carry it; this was the one exit
      // that did not.
      if (!isTransientPollFailure(error)) {
        throw await this.abandonWait(
          requestToken,
          logicalId,
          operation,
          resourceType,
          lastSeenIdentifier,
          'cdkd could not read the operation status and the failure is not retryable',
          error
        );
      }

      transientOutageStartedAt ??= Date.now();
      lastTransientError = error;
      const outageMs = Date.now() - transientOutageStartedAt;
      if (outageMs >= transientGraceMs) {
        throw await this.abandonWait(
          requestToken,
          logicalId,
          operation,
          resourceType,
          lastSeenIdentifier,
          `cdkd could not reach Cloud Control API for ${Math.round(outageMs / 1000)}s`,
          error
        );
      }

      // `displaySafe` because the cause text is not fully cdkd-controlled —
      // an `AWS_ENDPOINT_URL_CLOUDCONTROL` / profile `endpoint_url` lands in
      // `getaddrinfo ENOTFOUND <host>` — and `ConsoleLogger.formatMessage`
      // sanitises EXTRA ARGS only, never the message string.
      //
      // "MAY still be running", not "is": the poll failed, so cdkd does not
      // know. The thrown error hedges for the same reason, and an
      // unconditional claim here would contradict it at default verbosity.
      //
      // Sanitize BEFORE testing for emptiness, and render NO clause when the
      // result is empty -- `abandonWait`'s shape, for the same reachable
      // case: `asSdkError` normalizes a non-`Error` rejection into an `Error`
      // with `message: ''`, which would otherwise render `(attempt 3):  — `.
      const safePollText = displaySafe(describePollFailure(error).display);
      this.logger.warn(
        `${operation} ${logicalId}: could not read the Cloud Control operation status ` +
          // `describePollFailure(...).display`, the SAME decision the
          // abandonment makes, for two reasons.
          //
          // It must not be `.detail`: that field's contract is `logger.debug`
          // ONLY, and this line runs at DEFAULT verbosity. The gap was
          // reachable — `POLL_TRANSPORT_CODE_IN_MESSAGE` matches a socket
          // code ANYWHERE in the message, so a `credential_process` stderr
          // containing `ETIMEDOUT` classifies transient and this warn printed
          // the helper's argv and stderr on every re-poll, while the
          // abandonment that eventually followed reduced them.
          //
          // And it must not be an inline
          // `error instanceof Error ? error.message : String(error)`: the
          // bare `String(value)` THROWS on a null-prototype object or a
          // hostile `toString`. Measured — a duck-typed `Object.create(null)`
          // rejection replaced the whole abandonment with `TypeError: Cannot
          // convert object to primitive value`, INSIDE the poll loop, so it
          // fired before the grace could expire and took the `RequestToken`
          // with it: #3236's own defect re-entering through the line that
          // reports it.
          `(attempt ${attempts})${safePollText === '' ? '' : `: ${safePollText}`} — ` +
          `the operation may still be running in AWS; re-polling the same request token in ${pollInterval}ms`
      );
      await this.sleep(pollInterval);
      pollInterval = Math.min(Math.ceil(pollInterval * 1.5), this.MAX_POLL_INTERVAL_MS);
      continue;
    }

    // An answered poll ends the outage: the grace measures ONE unbroken run
    // of failures, so a flaky link that answers every other attempt keeps
    // the full wall-clock budget instead of being killed by an accumulated
    // total it never actually spent unreachable.
    transientOutageStartedAt = undefined;
    lastTransientError = undefined;

    const progressEvent = statusResponse.ProgressEvent;

    if (!progressEvent) {
      throw new ProvisioningError(
        `Failed to get status for ${logicalId}: No progress event`,
        'Unknown',
        logicalId
      );
    }

    if (progressEvent.Identifier) {
      lastSeenIdentifier = progressEvent.Identifier;
    }

    this.logger.debug(
      `${operation} ${logicalId}: ${progressEvent.OperationStatus} (attempt ${attempts}, next poll ${pollInterval}ms)`
    );

    switch (progressEvent.OperationStatus) {
      case 'SUCCESS':
        // go-to-k/cdkd#5200: the sleep before this poll bounds how late the
        // completion was seen. Inert unless CDKD_PHASE_TIMINGS=1.
        recordPhase(
          'cloud control polls',
          `${operation.toLowerCase()}: last poll gap`,
          attempts > 1 ? lastSleepMs : 0,
          `${logicalId} after ${attempts} poll(s)`
        );
        return progressEvent;

      case 'FAILED': {
        const rawFailureMessage = progressEvent.StatusMessage || 'Unknown error';
        // The handler's text stays in the message, since it is what a user
        // fixes the template from (`Property validation failure: ...`), but
        // with the caller's principal ARN and account id masked: this
        // message is persisted in the `RESOURCE_FAILED` event, and a denial
        // quotes `User: arn:aws:sts::<account>:assumed-role/...`
        // (go-to-k/cdkd#2319). The unmasked text goes to `--verbose`.
        const failureMessage = maskCallerIdentity(rawFailureMessage);
        if (failureMessage !== rawFailureMessage) {
          this.logger.debug(
            `${operation} ${logicalId}: handler StatusMessage before caller-identity masking: ` +
              displaySafe(rawFailureMessage)
          );
        }
        throw new CloudControlOperationFailedError(
          `${operation} failed for ${logicalId}: ${failureMessage}${handlerAuthFailureHint(failureMessage)}`,
          progressEvent.TypeName || 'Unknown',
          logicalId,
          progressEvent.Identifier,
          progressEvent.ErrorCode,
          operation
        );
      }

      case 'CANCEL_COMPLETE':
        // NOTE: a CREATE cancelled after materialization (external
        // CancelResourceRequest mid-create) can also leave a remnant, but
        // it throws a plain ProvisioningError so cleanupFailedCreateRemnant
        // deliberately does not fire — cancellation is an explicit external
        // action, not a transient failure a retry should paper over.
        throw Object.assign(
          new ProvisioningError(
            `${operation} cancelled for ${logicalId}`,
            progressEvent.TypeName || 'Unknown',
            logicalId,
            progressEvent.Identifier
          ),
          // Typed, for `resumeAbandonedRequest` (go-to-k/cdkd#3252): the
          // message carries the template-chosen logical id.
          { ccOperationCancelled: true }
        );

      case 'IN_PROGRESS':
      case 'PENDING':
      // A cancel on its way to CANCEL_COMPLETE (go-to-k/cdkd#3252's re-poll
      // can meet one): waited on without the unknown-status warning.
      case 'CANCEL_IN_PROGRESS':
        // Exponential backoff with 1.5x multiplier for flatter curve:
        // 1s → 1.5s → 2.25s → 3.4s → 5s → 7.5s → 10s (capped)
        // Most CC API operations complete in 1-5s, so slower ramp-up
        // polls more frequently during the common case.
        if (progressEvent.RetryAfter instanceof Date) {
          recordPhase(
            'cloud control polls',
            'RetryAfter hint, ahead of now',
            Math.max(0, progressEvent.RetryAfter.getTime() - Date.now()),
            `next sleep ${pollInterval}ms`
          );
        }
        lastSleepMs = pollInterval;
        await this.sleep(pollInterval);
        pollInterval = Math.min(Math.ceil(pollInterval * 1.5), this.MAX_POLL_INTERVAL_MS);
        break;

      default:
        this.logger.warn(
          `Unknown operation status for ${logicalId}: ${progressEvent.OperationStatus}`
        );
        await this.sleep(pollInterval);
        pollInterval = Math.min(Math.ceil(pollInterval * 1.5), this.MAX_POLL_INTERVAL_MS);
    }
  }

  // The deadline loses the token exactly as a transport failure did (issue
  // #3236): the operation is STILL RUNNING when cdkd stops waiting, so this
  // arm has always had the same untracked-resource consequence as the one
  // above and now takes the same error.
  //
  // The `<OP> timeout for <id> after <n>s` wording is KEPT, and the reason is
  // that nothing depends on it rather than that something does — an earlier
  // revision of this comment claimed `tests/integration/opensearch-domain-getatt`
  // and the retry classifiers read it, and both halves are false (that
  // fixture contains no `timeout` match, and `isRetryableTransientError`
  // measured FALSE for `CREATE timeout for X after 900s`). It is kept
  // because it is the wording users have been reading, and changing it would
  // be churn.
  throw await this.abandonWait(
    requestToken,
    logicalId,
    operation,
    resourceType,
    lastSeenIdentifier,
    `${operation} timeout for ${logicalId} after ${maxWaitMs / 1000}s`,
    // Passed RAW, not `instanceof Error ? … : undefined`. `abandonWait` has
    // its own non-`Error` arm, which WITHHOLDS the value and still reports
    // that something arrived; filtering here re-created, on this arm alone,
    // the "abandonment stating no reason at all" that arm exists to remove.
    // Reachable: an answered poll clears this, so it is set exactly when the
    // last attempt failed transiently inside the grace and the wall clock
    // then expired — and `isTransientPollFailure` duck-types `code` / `name`
    // / `message` off any object, so a non-`Error` throw does reach here.
    lastTransientError
  );
}

/**
 * The {@link create} result for a resource an earlier run's CREATE made
 * after cdkd stopped waiting for it (go-to-k/cdkd#3252): `identifier` is
 * what that request's SUCCESS event named. Nothing is sent but reads: the
 * model comes from `GetResource` and then takes the create path's own
 * attribute pipeline, so the record matches one a create that returned
 * would have written. Throws when the resource cannot be read, so the
 * caller falls back to an ordinary create.
 */
export async function resumeCreatedResource(
  this: CloudControlProvider,
  logicalId: string,
  resourceType: string,
  identifier: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  const mask = maskerOrIdentity(context?.maskSecrets);
  const attributeNamesLookup = getTopLevelDeployAttributeNames(resourceType);
  // Read directly rather than through `readCcResourceModel`, which reads
  // every failure as "no model": only NotFound may send the caller on to a
  // create, since any other failure leaves the resource standing.
  let raw: string | undefined;
  try {
    const response = await this.cloudControlClient.send(
      new GetResourceCommand({ TypeName: resourceType, Identifier: identifier })
    );
    raw = response.ResourceDescription?.Properties;
  } catch (error) {
    if ((error as { name?: string }).name === 'ResourceNotFoundException') {
      throw Object.assign(
        new ProvisioningError(
          `${logicalId}'s resource that an earlier CREATE made no longer exists`,
          resourceType,
          logicalId,
          identifier,
          error instanceof Error ? error : undefined
        ),
        { resumedResourceGone: true }
      );
    }
    throw error;
  }
  const model = typeof raw === 'string' && raw !== '' ? this.parseResourceModel(raw) : {};
  const modelKeys = Object.keys(model);
  const enriched = await this.enrichResourceAttributes(resourceType, identifier, model);
  return {
    physicalId: identifier,
    attributes: await this.maskDeployedNonAttributeKeys(
      enriched,
      modelKeys,
      resourceType,
      identifier,
      attributeNamesLookup,
      properties,
      mask
    ),
  };
}

/**
 * Re-poll a request an earlier run abandoned (go-to-k/cdkd#3252) and report
 * how it ended. Never sends a write: `GetResourceRequestStatus` invokes no
 * handler. A request still running is waited on through
 * {@link waitForOperation}, with its usual budget and transport fence.
 *
 * `remnant` on a FAILED create is the identifier `cleanupFailedCreateRemnant`
 * would delete in the original run: set only when the event named one and
 * the error code says it is not another owner's (`AlreadyExists`) or under
 * another operation (`ResourceConflict`).
 */
export async function resumeAbandonedRequest(
  this: CloudControlProvider,
  requestToken: string,
  logicalId: string,
  resourceType: string
): Promise<AbandonedRequestOutcome> {
  let first: GetResourceRequestStatusCommandOutput;
  try {
    first = await this.cloudControlClient.send(
      new GetResourceRequestStatusCommand({ RequestToken: requestToken })
    );
  } catch (error) {
    if ((error as { name?: string }).name === 'RequestTokenNotFoundException') {
      return { status: 'not-found' };
    }
    return { status: 'unresolved', error };
  }
  let event = first.ProgressEvent;
  // The journal names the type; a request of another type or operation is
  // not the one it recorded, and nothing it made is this resource.
  if (
    (event?.TypeName !== undefined && event.TypeName !== resourceType) ||
    (event?.Operation !== undefined && event.Operation !== 'CREATE')
  ) {
    return {
      status: 'unresolved',
      error: new Error('the request is not a CREATE of the type the journal records'),
    };
  }
  // Any status short of an end (PENDING, IN_PROGRESS, CANCEL_IN_PROGRESS)
  // is waited on, as `waitForOperation` itself keeps polling one.
  const ended = ['SUCCESS', 'FAILED', 'CANCEL_COMPLETE'];
  if (event !== undefined && !ended.includes(String(event.OperationStatus))) {
    try {
      event = await this.waitForOperation(requestToken, logicalId, 'CREATE', resourceType);
    } catch (error) {
      if (error instanceof CloudControlOperationFailedError) {
        return failedOutcome(error.ccErrorCode, error.physicalId);
      }
      if ((error as { ccOperationCancelled?: unknown }).ccOperationCancelled === true) {
        const made = (error as ProvisioningError).physicalId;
        return made ? { status: 'cancelled', remnant: made } : { status: 'cancelled' };
      }
      // Ctrl-C while waiting: the run is stopping, not the request unknown.
      if (isInterruptedWaitError(error)) throw error;
      // A `CloudControlWaitAbandonedError` (the poll budget ran out, or the
      // status could not be read) or anything unexpected: still unknown.
      return { status: 'unresolved', error };
    }
  }
  switch (event?.OperationStatus) {
    case 'SUCCESS':
      return event.Identifier
        ? { status: 'succeeded', identifier: event.Identifier }
        : { status: 'unresolved', error: new Error('the SUCCESS event named no Identifier') };
    case 'FAILED':
      return failedOutcome(event.ErrorCode, event.Identifier);
    case 'CANCEL_COMPLETE':
      // A create cancelled after it materialized can leave its resource.
      return event.Identifier
        ? { status: 'cancelled', remnant: event.Identifier }
        : { status: 'cancelled' };
    default:
      return {
        status: 'unresolved',
        error: new Error(`unexpected operation status ${String(event?.OperationStatus)}`),
      };
  }
}

/**
 * Build the {@link CloudControlWaitAbandonedError} for a wait cdkd is giving
 * up on while the operation is, as far as cdkd knows, still running (issue
 * [#3236](https://github.com/go-to-k/cdkd/issues/3236)).
 *
 * Returns rather than throws so every call site reads `throw await
 * this.abandonWait(...)` — the `throw` stays visible at the site, which is
 * what keeps the control flow legible to the compiler and to a reader.
 *
 * CREATE is marked non-retryable and the other two are not, and the
 * asymmetry is the whole point rather than an oversight:
 *
 *  - **CREATE** — a replay issues a SECOND `CreateResource` for a resource
 *    the first call is already creating, which is go-to-k/cdkd#2039's
 *    duplicate-create. It must be refused, and the marker is what refuses
 *    it — but by a different mechanism than an earlier revision of this
 *    comment claimed. That one said the message interpolates AWS's own
 *    `Rate exceeded`, which `RETRYABLE_ERROR_MESSAGE_PATTERNS` matches; a
 *    real `ThrottlingException` carries `$fault`, so its cause is REDUCED to
 *    the wire code and the message no longer contains that wording.
 *    Re-measured at this head: without the marker `isRetryableTransientError`
 *    still answers TRUE, via `isThrottlingError`'s CHAIN walk over the
 *    threaded cause rather than via the message. The marker stays
 *    load-bearing; only the route changed.
 *  - **DELETE** — a replay issues a second `DeleteResource`, which is
 *    idempotent: if the first delete landed, the retry meets the
 *    already-gone signal `delete()` absorbs. Retrying is strictly better
 *    than surfacing a failure over a resource that may be gone.
 *  - **UPDATE** — a replay re-derives and re-sends the same patch, the
 *    behavior every other UPDATE failure already gets.
 */
export async function abandonWait(
  this: CloudControlProvider,
  requestToken: string,
  logicalId: string,
  operation: 'CREATE' | 'UPDATE' | 'DELETE',
  resourceType: string,
  lastSeenIdentifier: string | undefined,
  reason: string,
  cause: unknown
): Promise<CloudControlWaitAbandonedError> {
  // WHAT the cause text may say. The decision is `describePollFailure`'s
  // (module-level, above), shared with the re-poll warn so one poll failure
  // cannot be reduced on one line and rendered raw on the other.
  //
  // This message is PERSISTED verbatim into `deployments/{runId}.jsonl` by
  // `extractDeploymentEventError`, a store restricted to error-plus-metadata
  // that outlives the run, so it is the STRICTER of the two readers and the
  // reason the helper exists at all.
  const described = describePollFailure(cause);

  // Sanitize BEFORE testing for emptiness, never after: `displaySafe` maps
  // C0 / C1 / bidi to a space and then TRIMS, so a whitespace-only or
  // control-only message renders `''` — and a guard keyed on the RAW value
  // lets exactly that case back through as the dangling `(<reason>: ).` this
  // guard exists to remove.
  const safeDisplay = displaySafe(described.display);
  const causeText = safeDisplay === '' ? '' : `: ${safeDisplay}`;

  if (described.detail !== '') {
    this.logger.debug(
      `${operation} ${logicalId}: the abandoned operation's underlying failure was: ${displaySafe(described.detail)}`
    );
  }

  // `asciiOnly` because this clause renders on the SAME line as the pasteable
  // command: the denylist mode leaves bidi marks and zero-width joiners,
  // which can visually reorder a command an operator is about to paste. The
  // identifier can be template-chosen (GlobalTable, ASG).
  const identifierClause =
    lastSeenIdentifier === undefined
      ? ''
      : ` The last status cdkd read named the resource ${displaySafe(lastSeenIdentifier, { asciiOnly: true })}.`;

  // Worded per operation. Saying "cdkd has NO state record" unconditionally
  // is false for DELETE and UPDATE, whose resources DO have a record that the
  // failure preserves — only the OPERATION is unrecorded there.
  const consequence =
    operation === 'CREATE'
      ? 'cdkd has NO state record for it: when the failed deploy records the request in the ' +
        "stack's rollback journal, the next cdkd deploy, destroy or rollback checks how it ended, " +
        'and otherwise any resource it creates is untracked'
      : operation === 'DELETE'
        ? 'the resource may or may not have been removed; its state record is kept so a re-run can finish the delete'
        : 'its state record still holds the PREVIOUS properties, so the record may no longer describe the live resource';

  const error = new CloudControlWaitAbandonedError(
    safeMsg`${operation} of ${logicalId} was accepted by Cloud Control API, but cdkd stopped waiting for it ` +
      // The identifier clause goes BEFORE the command, never after it: glued
      // on afterwards it rendered on the SAME line as the pasteable command,
      // so a template-chosen identifier sat inside what reads as a shell
      // line while taking only sanitize — one of the three steps
      // `replacement-protection-advice.ts` requires, with no quote and no
      // suppress. Putting it ahead means the command is the last thing on
      // its line and nothing user-chosen follows it.
      safeMsg`(${reason}${causeText}). The operation may still be running in AWS, and ${consequence}.` +
      `${identifierClause} Check what it did with:\n  ${await this.buildResumeCommand(requestToken)}`,
    resourceType,
    logicalId,
    requestToken,
    operation,
    lastSeenIdentifier,
    cause instanceof Error ? cause : undefined
  );

  // `markRedactedCause` ONLY when the chain actually carries the text that
  // was withheld — `aws-failure-text.ts` states that precondition and says
  // stamping without it is worse than not stamping at all. So it is gated on
  // BOTH the reduction having happened and a real `Error` having been
  // threaded as `cause`. It exists because the retry classifiers match by
  // substring, and reducing `AccessDeniedException` to its wire code removes
  // the `not authorized to perform` wording the IAM-propagation grid keys on;
  // the marker is the opt-in `retryable-errors.ts` provides for exactly that.
  // `describePollFailure` already folds in the precondition
  // `aws-failure-text.ts` states: stamp ONLY when the chain carries the text
  // that was withheld. So `marker` is false for an absent cause, for a
  // non-`Error` (nothing is threaded as `cause`), and for a `$fault`-bearing
  // `Error` whose `message` is `''` — which `asSdkError` can hand up, and
  // which would opt the classifier into reading a chain with no text in it.
  if (described.marker) markRedactedCause(error);

  return operation === 'CREATE' ? markNonRetryable(error) : error;
}

/**
 * The `aws cloudcontrol get-resource-request-status` line an abandoned wait
 * hands the user — the only way back to an operation cdkd has no record of.
 *
 * SANITIZE-then-QUOTE-then-SUPPRESS, the full convention
 * `replacement-protection-advice.ts` applies (issue
 * [#2669](https://github.com/go-to-k/cdkd/issues/2669)) — quoting ALONE is
 * not it, and the gap is not theoretical here. The region comes from
 * `config.region()`, i.e. `--region` / `AWS_REGION` / a profile's `region =`
 * line, so it is USER text: `AWS_REGION=$'us-east-1\nrm -rf x'` is inert once
 * `shellQuote` wraps it, and still renders a two-line "recovery command" on
 * the terminal and into `deployments/{runId}.jsonl` — the forgery
 * `lock-contention-message.ts` says quoting does not cover. So each part is
 * `displaySafe`d first and DROPPED when sanitizing changed it: the region
 * flag is simply omitted (absent is already legal — the user supplies their
 * own), and a changed TOKEN suppresses the whole command, since a command
 * naming the wrong operation is worse than none.
 *
 * The region is best-effort in a second sense: `config.region` is a resolver
 * that can throw (no credentials, no configured region), and a wait that
 * already failed must not fail a second time inside its own error message.
 */
export async function buildResumeCommand(
  this: CloudControlProvider,
  requestToken: string
): Promise<string> {
  const safeToken = displaySafe(requestToken, { asciiOnly: true });
  // The `!safeToken` arm matches `replacement-protection-advice.ts`'s
  // convention verbatim rather than being narrowed to the change test alone.
  // Unreachable today -- every call site guards a falsy token before the wait
  // starts -- but a seam that diverges from the convention it copied is how
  // the next copy loses the arm that IS reachable.
  if (!safeToken || safeToken !== requestToken) {
    return '(cdkd cannot render a safe resume command for this request token — see the Cloud Control console)';
  }

  let region: string | undefined;
  try {
    region = (await this.cloudControlClient.config.region())?.trim();
  } catch {
    region = undefined;
  }
  const safeRegion =
    region === undefined || region === '' || displaySafe(region, { asciiOnly: true }) !== region
      ? undefined
      : region;
  const regionFlag = safeRegion === undefined ? '' : ` --region ${shellQuote(safeRegion)}`;
  return `${withPasteableAwsProfile('aws cloudcontrol get-resource-request-status')} --request-token ${shellQuote(safeToken)}${regionFlag}`;
}
