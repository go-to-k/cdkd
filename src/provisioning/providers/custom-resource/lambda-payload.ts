import { maskDeep, type MaskerFn } from '../../masked-retry-logger.js';

/**
 * CloudFormation Custom Resource Response format
 * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-responses.html
 */
export interface CfnCustomResourceResponse {
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
export interface CustomResourceResponsePayload {
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
export function isCustomResourceResponsePayload(
  value: unknown
): value is CustomResourceResponsePayload {
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
export function parseLambdaPayload(
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
    // Two arms rather than an identity default, because the DELETE path may
    // have no masker (see {@link deletePathMasker}) and a per-SITE critic
    // cannot say "masked on two of three paths". Splitting the message makes
    // the unmasked path its OWN site, so it is recorded in
    // `scripts/check-provider-secret-mask.ts`'s `EXEMPT` list — counted and
    // re-audited every run — while the masked arm stays fenced: deleting its
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
 * `text` closed with exactly one full stop: a redacted `describeAwsFailure`
 * summary already ends with `VERBOSE_POINTER`'s, and a pass-through may not.
 */
export function asSentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
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
export function decodeInvokeLogTail(logResult: string | undefined): string | undefined {
  if (!logResult) return undefined;
  try {
    const decoded = Buffer.from(logResult, 'base64').toString('utf8');
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The backing function's own STATUS fields out of one `GetFunction` response
 * (issue #2033). Literal reads of AWS-authored fields only — never the whole
 * payload, which carries `Configuration.Environment.Variables` and the
 * presigned `Code.Location`.
 *
 * `parts` are the state and reason-CODE fields as `Key=value`, plus a
 * `Key withheld` marker for each reason SENTENCE present; `reasons` are those
 * sentences as `Key=value`, for `logger.debug` only (go-to-k/cdkd#2319). A
 * thrown message is persisted to `deployments/{runId}.jsonl`, and AWS words a
 * reason with ARNs: a `KMSAccessDenied` reason quotes the denied principal's
 * assumed-role ARN, which names the account. The code keeps the diagnosis.
 */
export function lambdaStatusParts(response: unknown): { parts: string[]; reasons: string[] } {
  const config = (response as { Configuration?: unknown } | null | undefined)?.Configuration;
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { parts: [], reasons: [] };
  }
  const fields = config as Record<string, unknown>;
  const status: Array<[string, unknown, 'shown' | 'withheld']> = [
    ['State', fields['State'], 'shown'],
    ['StateReasonCode', fields['StateReasonCode'], 'shown'],
    ['StateReason', fields['StateReason'], 'withheld'],
    ['LastUpdateStatus', fields['LastUpdateStatus'], 'shown'],
    ['LastUpdateStatusReasonCode', fields['LastUpdateStatusReasonCode'], 'shown'],
    ['LastUpdateStatusReason', fields['LastUpdateStatusReason'], 'withheld'],
  ];
  const parts: string[] = [];
  const reasons: string[] = [];
  for (const [key, value, kind] of status) {
    if (typeof value !== 'string' || value === '') continue;
    if (kind === 'shown') parts.push(`${key}=${value}`);
    else {
      parts.push(`${key} withheld`);
      reasons.push(`${key}=${value}`);
    }
  }
  return { parts, reasons };
}
