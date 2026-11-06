import type { CustomResourceProvider } from '../custom-resource-provider.js';
import type { InvocationResponse } from '@aws-sdk/client-lambda';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { displaySafe } from '../../../utils/display-safe.js';
import { UNRENDERABLE } from '../../../state/lock-contention-message.js';
import type { InterruptWatch } from '../../interrupt-watch.js';
import {
  purgeNoncurrentKeyVersions,
  CUSTOM_RESOURCE_RESPONSE_OBJECT_DESCRIPTION,
} from '../../../state/s3-noncurrent-version-purge.js';
import type { ResourceImportInput, ResourceImportResult } from '../../../types/resource.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import {
  type CfnCustomResourceResponse,
  parseLambdaPayload,
  decodeInvokeLogTail,
} from './lambda-payload.js';
import { CR_LOG_TAIL_WARN_MAX_CHARS, customResourceRetryDelays } from './retry-policy.js';
import {
  hasHandlerLogOutput,
  parseCfnResponseBody,
  describeCfnResponseBody,
} from './response-body.js';

/**
 * Get custom resource response from either Lambda payload or S3
 *
 * Strategy:
 * 1. If Lambda returned a direct payload with Status field → use it (cfn-response inline)
 * 2. If Lambda returned a payload with PhysicalResourceId → use it (simple handler)
 * 3. Otherwise, poll S3 for the response (cfn-response via ResponseURL)
 */
export async function getCustomResourceResponse(
  this: CustomResourceProvider,
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
          this.truncateReason(
            mask === undefined ? logTail : mask(logTail),
            CR_LOG_TAIL_WARN_MAX_CHARS
          )
      );
    }
    throw new Error(
      `Lambda function error (${lambdaResponse.FunctionError}): ${mask === undefined ? errorPayload : mask(errorPayload)}`
    );
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
    // DISCARDING `error.message` is LOAD-BEARING here, not incidental. A
    // DELETE whose caller passed no masker hands `parseLambdaPayload` none
    // (see deletePathMasker), so its refusal message can quote a delete-bag
    // value verbatim. Logging the error object would make that arm a leak
    // the day a caller with a plaintext bag forgets its masker.
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
export async function prepareInvocation(
  this: CustomResourceProvider,
  logicalId: string,
  watch: InterruptWatch,
  mask: MaskerFn | undefined
): Promise<{
  requestId: string;
  responseKey: string;
  responseURL: string;
}> {
  const requestId = `cdkd-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const responseKey = this.getResponseKey(requestId);
  const responseURL = await this.generateResponseURL(responseKey, logicalId, watch, mask);
  return { requestId, responseKey, responseURL };
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
export async function pollS3Response(
  this: CustomResourceProvider,
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
export function getResponseKey(this: CustomResourceProvider, requestId: string): string {
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
export async function cleanupResponseObject(
  this: CustomResourceProvider,
  responseKey: string
): Promise<void> {
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
    // Issue [#2346]/[#2635]: every value rendered here goes through
    // `displaySafe`, and every one that CAN sanitize to nothing carries a
    // `|| UNRENDERABLE` floor -- an unusable value must not read as an empty
    // one. `responseKey` is the deliberate exception and gets no floor:
    // `getResponseKey` always appends `/cdkd-<digits>-<alnum>.json`, so it
    // can never sanitize to empty, and a branch that cannot fire is dead code
    // rather than a fence (measured in issue [#2610]'s final review round --
    // the floor was added, probed, and came back GREEN because nothing can
    // reach it). `error.message` is AWS-supplied text, and `responseKey`
    // is `${this.responsePrefix}/${requestId}.json` — the request id is
    // cdkd-minted (`prepareInvocation`), but the PREFIX is caller-supplied
    // config (`CustomResourceProviderConfig.responsePrefix`), so the key is
    // not a literal either. The issue body said the request id was the
    // non-literal half; it is not, and the sanitization is warranted by the
    // prefix instead. `bucket` is cdkd-authored and
    // takes the `asciiOnly` POSITIVE allowlist (an S3 bucket name has a known
    // ASCII charset, so that form has no residual at all), matching the
    // sibling purge paths this line runs immediately before
    // (`src/state/s3-noncurrent-version-purge.ts`,
    // `src/state/s3-replication-purge-gap.ts`). Sanitizing two of three and
    // leaving the third raw is the mixed-rendering residual that round was
    // closing.
    this.logger.debug(
      `Failed to delete custom-resource response object s3://${
        displaySafe(bucket, { asciiOnly: true }) || UNRENDERABLE
      }/${displaySafe(responseKey)}; ` +
        `it remains as a current object. Underlying error: ` +
        `${displaySafe(describeAwsFailure(error).detail) || UNRENDERABLE}`
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
export function stringifyProperties(
  this: CustomResourceProvider,
  properties: Record<string, unknown>
): Record<string, unknown> {
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

export function sleep(this: CustomResourceProvider, ms: number): Promise<void> {
  return customResourceRetryDelays.sleep(ms);
}

/**
 * `sleep` that checks the interrupt watch at most a second apart, mirroring
 * `withRetry`'s own once-per-second probe. Throws the watch's error when the
 * user has hit Ctrl-C, so the retry loop unwinds instead of sitting out the
 * remaining backoff.
 */
export async function sleepInterruptibly(
  this: CustomResourceProvider,
  ms: number,
  watch: InterruptWatch
): Promise<void> {
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
export async function importImpl(
  this: CustomResourceProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    return { physicalId: input.knownPhysicalId, attributes: {} };
  }
  return null;
}
