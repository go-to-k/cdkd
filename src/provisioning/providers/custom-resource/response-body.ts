import { displaySafe } from '../../../utils/display-safe.js';
import { hasAddressablePhysicalId } from '../../../state/malformed-resources-bag.js';
import type { AwsAccountInfo } from '../../../deployment/intrinsic-function-resolver.js';
import type { CfnCustomResourceResponse } from './lambda-payload.js';
import { CR_LOG_TAIL_BOILERPLATE } from './retry-policy.js';

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
export function syntheticStackId(logicalId: string, accountInfo: AwsAccountInfo): string {
  return `arn:${accountInfo.partition}:cloudformation:${accountInfo.region}:${accountInfo.accountId}:stack/cdkd-${logicalId}/cdkd`;
}

/**
 * `true` when the tail contains at least one line the HANDLER produced.
 *
 * Deliberately a positive test for handler output rather than a length check:
 * the boilerplate lines carry a RequestId and a duration, so a tail of nothing
 * but boilerplate is several hundred characters and passes any size threshold.
 */
export function hasHandlerLogOutput(logTail: string): boolean {
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
export type CfnResponseBodyParse =
  | { kind: 'envelope'; response: CfnCustomResourceResponse }
  | { kind: 'non-object' }
  | { kind: 'unparseable' };

/**
 * Parse a response body without trusting it. The body is written by the
 * customer's Lambda handler through a pre-signed URL, so it is UNTRUSTED
 * input: it may be truncated, may be a JSON scalar, or may be `null`. Every
 * one of those must be a normal "keep polling" outcome rather than a throw.
 */
export function parseCfnResponseBody(body: string): CfnResponseBodyParse {
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
export function capForLog(value: string): string {
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
export const DESCRIBE_MAX_FIELD_CHARS = 200;

/** Whole-line clamp, applied after the per-field caps. */
export const DESCRIBE_MAX_LINE_CHARS = 1000;

/** How many `Data` key names the poll log line names before counting the rest. */
export const DESCRIBE_MAX_DATA_KEYS = 20;

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
export function describeCfnResponseBody(body: string, parsed: CfnResponseBodyParse): string {
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
 * The handler's `PhysicalResourceId` when cdkd can address the resource by it,
 * else `undefined` (go-to-k/cdkd#3211). CloudFormation requires a non-empty
 * string; cdkd has always read an empty or absent one as "none given" and
 * fallen back, and a whitespace-only or non-string one takes that same
 * fallback rather than a refusal of a handler that did its work.
 */
export function respondedPhysicalId(response: {
  PhysicalResourceId?: unknown;
}): string | undefined {
  return hasAddressablePhysicalId({ physicalId: response.PhysicalResourceId })
    ? (response.PhysicalResourceId as string)
    : undefined;
}
