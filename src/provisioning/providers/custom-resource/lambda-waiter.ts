import { LambdaClient, waitUntilFunctionActiveV2 } from '@aws-sdk/client-lambda';
import { describeAwsFailure, verbosePointerSentence } from '../../../utils/aws-failure-text.js';
import { getLogger } from '../../../utils/logger.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { lambdaStatusParts } from './lambda-payload.js';

/**
 * The rejections a readiness waiter's `GetFunction` polls met, deduplicated by
 * name and message, with a count each.
 *
 * Recorded because `@smithy/util-waiter` keeps only `<status>: <message>` of a
 * rejection as its `observedResponses` key, which drops the `name` / `$fault`
 * that `describeAwsFailure` (`src/utils/aws-failure-text.ts`, issue #2302)
 * classifies on. Holding the real `Error` lets that ONE classifier decide what
 * of each rejection is safe to throw, instead of a second one re-derived from
 * a string.
 */
export class WaiterRejections {
  /** By `name`, then by `message`: two-level, so no joined string key is needed. */
  private readonly seen = new Map<string, Map<string, { error: Error; count: number }>>();
  /** The same entries in first-seen order, which is the order they are rendered in. */
  private readonly ordered: Array<{ error: Error; count: number }> = [];

  /** Rejections that were not an `Error`: nothing to classify, so only counted. */
  nonErrors = 0;

  record(error: unknown): void {
    if (!(error instanceof Error)) {
      this.nonErrors += 1;
      return;
    }
    let byMessage = this.seen.get(error.name);
    if (byMessage === undefined) {
      byMessage = new Map();
      this.seen.set(error.name, byMessage);
    }
    const entry = byMessage.get(error.message);
    if (entry === undefined) {
      const created = { error, count: 1 };
      byMessage.set(error.message, created);
      this.ordered.push(created);
    } else entry.count += 1;
  }

  entries(): Array<{ error: Error; count: number }> {
    return [...this.ordered];
  }
}

/**
 * `client`, with every rejected `send` recorded into `rejections` and rethrown
 * unchanged — the client handed to the two readiness waiters, so their
 * failure can be described from the real errors. A prototype-chained view, so
 * the waiter still reads the real client's `config` (its 403 warning logger).
 * Every argument is forwarded; a callback-form call (no promise returned) is
 * passed through unobserved.
 */
export function observingLambdaClient(
  client: LambdaClient,
  rejections: WaiterRejections
): LambdaClient {
  const send = client.send.bind(client) as (...args: unknown[]) => unknown;
  const observed = Object.create(client) as LambdaClient;
  Object.defineProperty(observed, 'send', {
    value: (...args: unknown[]): unknown => {
      const result = send(...args);
      if (!(result instanceof Promise)) return result;
      return result.catch((error: unknown) => {
        rejections.record(error);
        throw error;
      });
    },
  });
  return observed;
}

/** The HTTP status of a rejection, when a deserialized response carried one. */
export function rejectionStatus(error: Error): number | undefined {
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Whether a rejection is a failure to DESERIALIZE the response, whose text can
 * quote the body: V8's `JSON.parse` `SyntaxError` message carries ~10
 * characters either side of the error position, and the SDK keeps the raw body
 * on `$responseBodyText` / `$response`. Such a rejection is reported by status
 * and name only, on both the thrown and the debug side — a truncated
 * `GetFunction` body puts a fragment of an environment variable there.
 */
export function carriesResponseBody(error: Error): boolean {
  const e = error as { $responseBodyText?: unknown; $response?: unknown; $fault?: unknown };
  return (
    e.$responseBodyText !== undefined ||
    (e.$response !== undefined && e.$fault === undefined) ||
    error.name === 'SyntaxError' ||
    error.message.includes('Deserialization error')
  );
}

/** One recorded rejection as a thrown-text line: status plus `describeAwsFailure`'s summary. */
export function rejectionLine(error: Error, count: number): string {
  const status = rejectionStatus(error);
  const prefix = `(x${count}) ${status === undefined ? '' : `${status}: `}`;
  if (carriesResponseBody(error)) return safeMsg`${prefix}${error.name} (response body withheld)`;
  // `safeMsg`: a pass-through summary is the rejection's own free text (a
  // transport message), flattened to one line so it cannot forge a row.
  return safeMsg`${prefix}${describeAwsFailure(error).summary}`;
}

/**
 * Each recorded rejection's FULL text, for `logger.debug` — the half
 * `describeAwsFailure` withheld from the thrown message (an AWS `AccessDenied`
 * names the caller's account, role and session). Only the redacted ones: a
 * pass-through is already in the thrown text.
 */
export function waiterRejectionDebugLines(rejections: WaiterRejections): string[] {
  const lines: string[] = [];
  for (const { error, count } of rejections.entries()) {
    const described = describeAwsFailure(error);
    if (!described.redacted || carriesResponseBody(error)) continue;
    const status = rejectionStatus(error);
    lines.push(
      `(x${count}) ${status === undefined ? '' : `${status}: `}${error.name}: ${described.detail}`
    );
  }
  return lines;
}

/**
 * A Lambda readiness-waiter failure, described without its payload, or
 * `undefined` when `error` is not one (its message is not a JSON object
 * carrying a `state`) — see `waitForBackingLambdaReady` for the whole argument.
 *
 * EVERY arm of `@smithy/util-waiter`'s `checkExceptions` can carry the whole
 * `GetFunction` response, `Configuration.Environment.Variables` in plaintext
 * and the presigned `Code.Location` included:
 *
 *  - a FAILURE throws `JSON.stringify(result)`, whose `reason` is the response;
 *  - a TIMEOUT or ABORT throws `JSON.stringify({...result, reason: '<fixed>'})`,
 *    and `result.observedResponses` is keyed by `createMessageFromResponse`:
 *    `<status>: OK` for a response carrying `$metadata.httpStatusCode` (every
 *    response the real Lambda client returns), `JSON.stringify(response)` for
 *    one that does not, and `<status>: <message>` / `<message>` for a rejected
 *    poll — whose message is an AWS `AccessDenied` naming the caller's account,
 *    role and session, or a credential / network failure.
 *
 * `JSON.stringify` escapes a secret containing `"`, `\` or a newline out of a
 * literal masker's reach, `Code.Location` is in no secrets bag, and a function
 * still holding a ROTATED secret's old plaintext holds one no bag of this
 * deploy knows. So what is kept is an allowlist:
 *
 *  - the waiter state and its fixed `reason` string;
 *  - the function's state and reason-code fields, from `reason`, or else from
 *    the most recently FIRST-SEEN observed key that parses as one
 *    (`observedResponses` keeps each key at its first-seen position, so a
 *    repeated key is not moved to the end); a reason SENTENCE is only marked
 *    withheld and returned in `reasons` for `debug` ({@link lambdaStatusParts});
 *  - `<status>: OK` keys;
 *  - each recorded REJECTION as `describeAwsFailure` summarizes it — its class
 *    for an AWS-authored one (a credential failure included), its text for a
 *    transport or cdkd one — with the withheld half going to `logger.debug`
 *    ({@link waiterRejectionDebugLines}); a deserialization failure by status
 *    and name only ({@link carriesResponseBody}).
 *
 * A `{` / `[`-leading key (a serialized response) is only COUNTED; so is a
 * non-`Error` rejection, and every rejection key when there is no record to
 * classify it by (the rejection keys themselves are never rendered).
 */
export function describeLambdaWaiterFailure(
  error: unknown,
  rejections: WaiterRejections
): { text: string; reasons: string[] } | undefined {
  if (!(error instanceof Error)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(error.message);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !('state' in parsed)) return undefined;
  const result = parsed as { state?: unknown; reason?: unknown; observedResponses?: unknown };
  const observed =
    typeof result.observedResponses === 'object' &&
    result.observedResponses !== null &&
    !Array.isArray(result.observedResponses)
      ? (result.observedResponses as Record<string, unknown>)
      : {};
  const { parts, reasons } = lambdaStatusParts(result.reason);
  if (parts.length === 0) {
    for (const key of Object.keys(observed).reverse()) {
      let response: unknown;
      try {
        response = JSON.parse(key);
      } catch {
        continue;
      }
      const observedStatus = lambdaStatusParts(response);
      if (observedStatus.parts.length > 0) {
        parts.push(...observedStatus.parts);
        reasons.push(...observedStatus.reasons);
        break;
      }
    }
  }
  const lines: string[] = [];
  let payloads = 0;
  let rejectionKeys = 0;
  for (const [key, count] of Object.entries(observed)) {
    if (key.startsWith('{') || key.startsWith('[')) payloads += 1;
    else if (/^\d{3}: OK$/.test(key)) {
      lines.push(typeof count === 'number' ? `(x${count}) ${key}` : key);
    } else rejectionKeys += 1;
  }
  const recorded = rejections.entries();
  for (const { error: rejection, count } of recorded) {
    lines.push(rejectionLine(rejection, count));
  }
  if (lines.length > 0) parts.push(`observed: ${lines.join('; ')}`);
  if (payloads > 0) parts.push(`${payloads} observed response(s) withheld`);
  const nonErrors = rejections.nonErrors;
  if (nonErrors > 0) parts.push(`${nonErrors} non-Error rejection(s) withheld`);
  if (recorded.length === 0 && nonErrors === 0 && rejectionKeys > 0) {
    // A deliberate fail-closed backstop, unreachable while both waiters get
    // the observing client: a rejection key with no record to classify it by
    // is counted, never rendered. Reached by the thrown-retry suite, which
    // mocks the waiters.
    parts.push(`${rejectionKeys} observed error message(s) withheld`);
  }
  const state = typeof result.state === 'string' ? result.state : 'failure';
  const reason =
    typeof result.reason === 'string' && result.reason !== '' ? `: ${result.reason}` : '';
  return {
    text:
      `${error.name} (waiter ${state}${reason}; ` +
      `${parts.length > 0 ? parts.join(', ') : 'no function status reported'}). ` +
      (reasons.length > 0 ? verbosePointerSentence() : '') +
      `The waiter's raw payload is withheld because it embeds the whole GetFunction ` +
      `response, environment variables included; run \`aws lambda get-function\` for the detail.`,
    reasons,
  };
}

/**
 * If `error` is a failed Lambda waiter, overwrite its `message` (and the first
 * line of its `stack`) IN PLACE with the {@link describeLambdaWaiterFailure}
 * text and return that text; otherwise return `undefined` and leave `error`
 * alone. The status reason sentences that text withholds go to `debug` first,
 * since the rewrite removes them from the error too.
 *
 * In place, not only in the wrapper's message, because the caught error stays
 * the wrapper's direct `cause` (the classifiers walk the chain, and
 * `scripts/check-provider-error-cause.ts` requires the caught value itself),
 * and a render that walks the chain — the CLI's fatal `util.inspect` of an
 * escaped error — would otherwise print the payload.
 */
export function withholdWaiterPayload(
  error: unknown,
  rejections: WaiterRejections,
  debug: (line: string) => void
): string | undefined {
  const failure = describeLambdaWaiterFailure(error, rejections);
  if (failure === undefined || !(error instanceof Error)) return undefined;
  for (const reason of failure.reasons) debug(safeMsg`Lambda waiter status reason: ${reason}`);
  const described = failure.text;
  const header = `${error.name}: ${error.message}`;
  const stack = typeof error.stack === 'string' ? error.stack : '';
  try {
    Object.defineProperty(error, 'message', {
      value: described,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(error, 'stack', {
      value: stack.startsWith(header)
        ? `${error.name}: ${described}${stack.slice(header.length)}`
        : `${error.name}: ${described}`,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch {
    // A frozen error cannot be rewritten: the wrapper's message still withholds
    // the payload, but its cause would not. Unreachable for
    // `@smithy/util-waiter`, which throws a plain, extensible `Error`.
  }
  return described;
}

/**
 * Render a Lambda readiness-waiter failure for a message that is persisted
 * (issue #2033). Anything that is not a waiter-shaped error (unreachable from
 * the two waiter calls, which catch every client exception) keeps only its
 * NAME: the fallback withholds too rather than relaying an unknown message.
 */
export function describeWaiterFailure(
  error: unknown,
  rejections: WaiterRejections,
  debug: (line: string) => void
): string {
  const withheld = withholdWaiterPayload(error, rejections, debug);
  if (withheld !== undefined) return withheld;
  const name = error instanceof Error ? error.name : 'Error';
  return (
    `${name} (no function status reported). ` +
    `The waiter's raw payload is withheld because it embeds the whole GetFunction ` +
    `response, environment variables included; run \`aws lambda get-function\` for the detail.`
  );
}

/**
 * Wait until a Lambda function is `State=Active`, for a consumer that AWS
 * rejects while the function is `Pending` (an ELBv2 Lambda target,
 * go-to-k/cdkd#5002). The same waiter, cadence and payload-withholding as
 * `waitForBackingLambdaReady`; the thrown error is `markNonRetryable` (the
 * waiter already polled to its budget) and its text carries no AWS message
 * or `GetFunction` payload. `abortSignal` stops the wait on a Ctrl-C.
 * `maxWaitSeconds` caps the budget (default 600) for a caller that shares one
 * deadline across several functions.
 */
export async function waitForLambdaFunctionActive(
  client: LambdaClient,
  functionArn: string,
  abortSignal?: AbortSignal,
  maxWaitSeconds = 600
): Promise<void> {
  const rejections = new WaiterRejections();
  try {
    await waitUntilFunctionActiveV2(
      {
        client: observingLambdaClient(client, rejections),
        maxWaitTime: maxWaitSeconds,
        minDelay: 1,
        maxDelay: 5,
        ...(abortSignal ? { abortSignal } : {}),
      },
      { FunctionName: functionArn }
    );
  } catch (error) {
    const log = getLogger().child('LambdaActiveWait');
    for (const line of waiterRejectionDebugLines(rejections)) {
      log.debug(safeMsg`Active waiter for ${functionArn} observed ${line}`);
    }
    throw markNonRetryable(
      new Error(
        `Lambda function ${functionArn} did not reach the Active state: ${describeWaiterFailure(
          error,
          rejections,
          (line) => log.debug(line)
        )}`,
        { cause: error }
      )
    );
  }
}

/**
 * `arn:<partition>:lambda:<region>:<account>:function:<name>[:<qualifier>]`.
 * A layer (`:layer:`) or an event-source mapping ARN never matches: only a
 * function can be `Pending`.
 */
export const LAMBDA_FUNCTION_ARN =
  /^arn:aws(?:-[a-z]+)*:lambda:[a-z0-9-]+:\d{12}:function:[\w-]+(?::[\w$-]+)?$/;

/** Bounds on the property walk: a custom resource bag is user data, not a trusted shape. */
export const REFERENCED_LAMBDA_MAX_DEPTH = 8;

export const REFERENCED_LAMBDA_MAX_ARNS = 16;

/** ONE budget for the whole scan: stuck functions must not add up to hours before the handler runs. */
export const REFERENCED_LAMBDA_MAX_WAIT_SECONDS = 600;

/**
 * The Lambda function ARNs a custom resource's resolved properties point at,
 * other than its own backing function (`excludeArn`), in first-seen order and
 * de-duplicated. Only string VALUES are read, never keys.
 *
 * A handler that hands such an ARN to an AWS API (the CDK `BucketNotifications`
 * handler passes it to `PutBucketNotificationConfiguration` as a destination)
 * is a consumer that AWS rejects while the function is still `Pending`, exactly
 * as an ELBv2 Lambda target is (go-to-k/cdkd#5002).
 *
 * `maxArns` bounds the scan (default {@link REFERENCED_LAMBDA_MAX_ARNS}). A caller
 * that filters the result afterwards passes `Infinity` and caps the FILTERED list
 * itself, so a function that is new on update is not hidden behind ARNs that
 * were already there.
 */
export function collectReferencedLambdaFunctionArns(
  properties: unknown,
  excludeArn: string,
  maxArns: number = REFERENCED_LAMBDA_MAX_ARNS
): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (found.size >= maxArns || depth > REFERENCED_LAMBDA_MAX_DEPTH) return;
    if (typeof value === 'string') {
      if (value !== excludeArn && LAMBDA_FUNCTION_ARN.test(value)) found.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  walk(properties, 0);
  return [...found];
}
