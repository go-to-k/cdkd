import { canonicalizeRegion } from '../../utils/aws-partition.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { markWaitAbandoned } from '../wait-abandoned.js';

/**
 * AWS Cloud Control API Provider
 *
 * Provisions resources using the Cloud Control API, which provides
 * a unified interface for managing AWS resources.
 *
 * Note: Not all AWS resources are supported by Cloud Control API.
 * Use isSupportedResourceType() to check before usage.
 */
/**
 * Properties that CC API expects as JSON strings, not objects.
 * CC API schema declares these as type: ["string", "object"] but
 * the implementation only accepts strings.
 */
export const JSON_STRING_PROPERTIES: Record<string, Set<string>> = {
  'AWS::Events::Rule': new Set(['EventPattern']),
};

/**
 * Stringify object properties that CC API expects as JSON strings.
 */
export function stringifyJsonProperties(
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  const jsonProps = JSON_STRING_PROPERTIES[resourceType];
  if (!jsonProps) return properties;

  const result = { ...properties };
  for (const key of jsonProps) {
    if (key in result && typeof result[key] === 'object' && result[key] !== null) {
      result[key] = JSON.stringify(result[key]);
    }
  }
  return result;
}

/**
 * Recursively strip null and undefined values from an object.
 * This prevents CC API errors caused by null property values
 * (e.g., EventBridge Rule with null ScheduleExpression causes Java NPE).
 */
export function stripNullValues(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return undefined;
  }
  if (Array.isArray(obj)) {
    return obj.map(stripNullValues).filter((v) => v !== undefined);
  }
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const stripped = stripNullValues(value);
      if (stripped !== undefined) {
        result[key] = stripped;
      }
    }
    return result;
  }
  return obj;
}

/**
 * The region an S3 `301 PermanentRedirect` names for a bucket
 * (go-to-k/cdkd#5264): the `x-amz-bucket-region` response header, or the
 * error's `Region` / `BucketRegion` field. `undefined` for any other error,
 * or a value that is not a region.
 */
export function s3RedirectRegion(error: unknown): string | undefined {
  const e = error as
    | {
        name?: unknown;
        Region?: unknown;
        BucketRegion?: unknown;
        $metadata?: { httpStatusCode?: unknown };
        $response?: { headers?: Record<string, unknown> };
      }
    | null
    | undefined;
  if (e?.name !== 'PermanentRedirect' && e?.$metadata?.httpStatusCode !== 301) return undefined;
  for (const candidate of [
    e?.$response?.headers?.['x-amz-bucket-region'],
    e?.Region,
    e?.BucketRegion,
  ]) {
    if (typeof candidate !== 'string') continue;
    const region = canonicalizeRegion(candidate.trim());
    if (region !== undefined && /^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) return region;
  }
  return undefined;
}

/**
 * Thrown when a Cloud Control operation's async progress event reports
 * FAILED. Carries the handler-reported `ErrorCode` and the operation kind so
 * the CREATE path can distinguish "our CreateResource materialized a resource
 * and then failed stabilization" (the remnant must be deleted or every outer
 * retry collides with AlreadyExists — surfaced by AWS::Synthetics::Canary,
 * whose create materializes the canary before the IAM-propagation race lands
 * it in ERROR state) from "the resource already existed before this create"
 * (`ErrorCode: AlreadyExists` — deleting by that identifier would destroy a
 * pre-existing user resource, so it is never cleaned up).
 */
export class CloudControlOperationFailedError extends ProvisioningError {
  public readonly ccErrorCode: string | undefined;
  public readonly ccOperation: string;

  constructor(
    message: string,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined,
    ccErrorCode: string | undefined,
    ccOperation: string
  ) {
    super(message, resourceType, logicalId, physicalId);
    this.ccErrorCode = ccErrorCode;
    this.ccOperation = ccOperation;
    this.name = 'CloudControlOperationFailedError';
    Object.setPrototypeOf(this, CloudControlOperationFailedError.prototype);
  }
}

/**
 * Thrown when cdkd STOPPED WAITING on a Cloud Control operation it had already
 * submitted — never when the operation itself reported a verdict (issue
 * [#3236](https://github.com/go-to-k/cdkd/issues/3236)).
 *
 * Deliberately NOT a subclass of {@link CloudControlOperationFailedError}, and
 * the distinction is load-bearing in three places that key off that class:
 * `cleanupFailedCreateRemnant`'s first guard, `delete()`'s structured
 * `ErrorCode: NotFound` absorption, and `isUpdateUnsupportedError`'s chain
 * walk. All three ask "what did the handler report", and the answer here is
 * NOTHING — the handler was still running when cdkd lost sight of it. In
 * particular the remnant cleanup must not fire: it deletes by
 * `error.physicalId`, and an identifier seen on an IN_PROGRESS event names a
 * resource whose create may be about to SUCCEED.
 *
 * Carries {@link requestToken} because that token is the only handle on an
 * operation cdkd has no state record for, and Cloud Control keeps a request's
 * status queryable by it well after the operation settles. Before this class
 * the token lived only in `waitForOperation`'s parameter list, so a poll that
 * threw discarded it and the resource — which AWS went on to create — became
 * invisible to state, to rollback and to `cdkd destroy`.
 *
 * **The protection is the MARKER, not the wording** — `markWaitAbandoned` in
 * the constructor below, which four already-deleted classifiers test before
 * their substring match (`src/provisioning/wait-abandoned.ts` names them;
 * `.claude/rules/cloud-control-wait.md` carries the whole contract). An
 * earlier revision of this comment said the wording was the protection, and
 * that is exactly what review disproved: the message interpolates the LOGICAL
 * ID and the last-seen IDENTIFIER, both user- or template-chosen, so a
 * resource named `PageNotFound` satisfies every needle no matter how carefully
 * the template is worded.
 *
 * The wording constraint is still KEPT as a second layer — the message avoids
 * the phrases where it can, the same discipline `src/deployment/delete-outcome.ts`
 * and `src/provisioning/nested-stack-messages.ts` carry, and
 * `tests/unit/provisioning/cloud-control-wait-abandoned.test.ts` asserts it
 * over the RENDERED message (cause text and identifier clause included) rather
 * than over the template. But it is belt to the marker's braces. Do not reword
 * this comment back into a claim that it suffices.
 */
export class CloudControlWaitAbandonedError extends ProvisioningError {
  public readonly requestToken: string;
  public readonly ccOperation: 'CREATE' | 'UPDATE' | 'DELETE';
  /**
   * The `Identifier` from the last progress event cdkd managed to read, when
   * one carried it. Cloud Control populates it on IN_PROGRESS events once the
   * handler has materialized the resource, so on a CREATE this is frequently
   * the physical id of the very resource that is about to go untracked — worth
   * printing, and deliberately NOT worth acting on (see the remnant-cleanup
   * note above).
   */
  public readonly lastSeenIdentifier: string | undefined;

  constructor(
    message: string,
    resourceType: string,
    logicalId: string,
    requestToken: string,
    ccOperation: 'CREATE' | 'UPDATE' | 'DELETE',
    lastSeenIdentifier: string | undefined,
    cause?: Error
  ) {
    // `physicalId` is DERIVED here rather than taken as a second positional
    // parameter: the two must always agree, and two adjacent
    // `string | undefined` arguments that must agree is a call site waiting to
    // pass one and forget the other.
    super(message, resourceType, logicalId, lastSeenIdentifier, cause);
    this.requestToken = requestToken;
    this.ccOperation = ccOperation;
    this.lastSeenIdentifier = lastSeenIdentifier;
    this.name = 'CloudControlWaitAbandonedError';
    Object.setPrototypeOf(this, CloudControlWaitAbandonedError.prototype);
    // Marked in the CONSTRUCTOR, not at the throw sites: every instance of this
    // class is an abandoned wait, and the marker is what the THREE foreign
    // already-deleted classifiers read (`deploy-engine/update-in-place.ts`,
    // `deploy-engine/delete.ts`, `destroy-runner.ts`) — they cannot see this
    // class. Marking per-throw is
    // one forgotten call from re-opening the state-drop, which is the reason
    // `ResourceUpdateNotSupportedError` marks in its constructor too.
    markWaitAbandoned(this, { requestToken, operation: ccOperation });
  }
}

/**
 * How a re-polled abandoned request ended
 * ({@link CloudControlProvider.resumeAbandonedRequest}, go-to-k/cdkd#3252).
 */
export type AbandonedRequestOutcome =
  | { status: 'succeeded'; identifier: string }
  | { status: 'failed'; remnant?: string }
  | { status: 'cancelled'; remnant?: string }
  | { status: 'not-found' }
  /** Still running after the poll budget, or its status could not be read. */
  | { status: 'unresolved'; error: unknown };

export function failedOutcome(
  errorCode: string | undefined,
  identifier: string | undefined
): AbandonedRequestOutcome {
  return identifier && errorCode !== 'AlreadyExists' && errorCode !== 'ResourceConflict'
    ? { status: 'failed', remnant: identifier }
    : { status: 'failed' };
}
