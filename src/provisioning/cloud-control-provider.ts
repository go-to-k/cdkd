import {
  CloudControlClient,
  CreateResourceCommand,
  UpdateResourceCommand,
  DeleteResourceCommand,
  GetResourceCommand,
  GetResourceRequestStatusCommand,
  type GetResourceRequestStatusCommandOutput,
  type ProgressEvent,
} from '@aws-sdk/client-cloudcontrol';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  RDSClient,
} from '@aws-sdk/client-rds';
import { GetRestApiCommand } from '@aws-sdk/client-api-gateway';
import { GetCloudFrontOriginAccessIdentityCommand } from '@aws-sdk/client-cloudfront';
import { GetFunctionUrlConfigCommand } from '@aws-sdk/client-lambda';
import {
  DescribeConnectionCommand,
  DescribeApiDestinationCommand,
} from '@aws-sdk/client-eventbridge';
import { DescribeReplicationGroupsCommand, ElastiCacheClient } from '@aws-sdk/client-elasticache';
import { DescribeClustersCommand, RedshiftClient } from '@aws-sdk/client-redshift';
import { DescribeDomainCommand, OpenSearchClient } from '@aws-sdk/client-opensearch';
import { GetBucketLocationCommand } from '@aws-sdk/client-s3';
import { getAccountInfo, type AwsAccountInfo } from '../deployment/intrinsic-function-resolver.js';
import { canonicalizeRegion, derivePartitionAndUrlSuffix } from '../utils/aws-partition.js';
import { getAwsClients } from '../utils/aws-clients.js';
import {
  disableInstanceApiTermination,
  isTerminationProtectionPropagationError,
  TERMINATION_PROTECTION_MAX_ATTEMPTS,
} from './ec2-termination-protection.js';
import { getLogger } from '../utils/logger.js';
import { ProvisioningError } from '../utils/error-handler.js';
import {
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
  markRedactedCause,
} from '../deployment/retryable-errors.js';
// The same sanitize-and-shell-quote treatment `replacement-protection-advice.ts`
// gives the physical id it pastes into a command (issue #2669), for the request
// token `abandonWait` pastes into its `aws cloudcontrol` resume line.
import { shellQuote } from '../state/lock-contention-message.js';
// Safe from `cloud-control-provider.ts` despite the dense engine -> executor ->
// registry -> provider ring: `delete-outcome.ts` is a documented LEAF whose only
// imports are types, so a new edge INTO it cannot close a cycle.
import { withIndeterminateGuard } from '../deployment/delete-outcome.js';
import { describeAwsFailure, redactedAwsFailureSummary } from '../utils/aws-failure-text.js';
import { displaySafe } from '../utils/display-safe.js';
import { JsonPatchGenerator } from './json-patch-generator.js';
import { getTopLevelWriteOnlyProperties } from './write-only-properties.js';
import { getTopLevelReadOnlyProperties } from './read-only-properties.js';
import { SECRET_MASK } from '../deployment/secret-redaction.js';
import { assertRegionMatch, type DeleteContext, type RegionCheckPhase } from './region-check.js';
import { ccProtectionProperty, type CcProtectionEntry } from './cc-protection-properties.js';
import { isNonProvisionable } from './unsupported-types.js';
import { slowCcOperationTimeoutMs } from './slow-cc-operation-timeouts.js';
import { isWaitAbandonedError, markWaitAbandoned } from './wait-abandoned.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  IndeterminateGuard,
} from '../types/resource.js';
import { awsClientDefaults } from '../utils/aws-client-defaults.js';

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
const JSON_STRING_PROPERTIES: Record<string, Set<string>> = {
  'AWS::Events::Rule': new Set(['EventPattern']),
};

/**
 * Stringify object properties that CC API expects as JSON strings.
 */
function stringifyJsonProperties(
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
function stripNullValues(obj: unknown): unknown {
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
    // already-deleted classifiers read (`deploy-engine.ts` x2,
    // `destroy-runner.ts`) — they cannot see this class. Marking per-throw is
    // one forgotten call from re-opening the state-drop, which is the reason
    // `ResourceUpdateNotSupportedError` marks in its constructor too.
    markWaitAbandoned(this);
  }
}

/**
 * Node / undici socket-level failure codes, i.e. the request never reached
 * Cloud Control or its response never came back.
 *
 * Mirrors `@smithy/service-error-classification`'s own
 * `NODEJS_TIMEOUT_ERROR_CODES` (`ECONNRESET` / `ECONNREFUSED` / `EPIPE` /
 * `ETIMEDOUT`), widened by the DNS and route shapes a dropped VPN also
 * produces. The SDK already retries every one of these under STANDARD mode —
 * three attempts, sub-second — so an error that reaches cdkd here is one the
 * SDK's own budget did not outlast, not one it declined to retry.
 */
const POLL_TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
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
]);

/** SDK error names for a request that timed out or was aborted in transit. */
const POLL_TRANSPORT_ERROR_NAMES: ReadonlySet<string> = new Set([
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
const POLL_TRANSPORT_CODE_IN_MESSAGE = new RegExp(
  `\\b(?:${[...POLL_TRANSPORT_ERROR_CODES].join('|')})\\b`
);

/**
 * The `.cause` walk depth. It is `retryable-errors.ts`'s `MAX_CAUSE_CHAIN_DEPTH`
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
const POLL_CAUSE_CHAIN_DEPTH = 5;

/**
 * The ONE name whose message must be withheld from a non-`debug` line, and the
 * enumeration behind why it is exactly one.
 *
 * `@smithy/property-provider` exports a family of three -- `ProviderError`, and
 * its subclasses `CredentialsProviderError` and `TokenProviderError` -- plus
 * `@smithy/credential-provider-imds`'s `InstanceMetadataV1FallbackError`, the
 * only subclass OF `CredentialsProviderError` in the installed tree. (All four
 * set `name`; the qualifier is what makes the sentence true, and an earlier
 * revision read "the only subclass that overrides `name`", which is false of
 * the three siblings.) Each was read rather than reasoned about, because the
 * answers differ and go BOTH ways:
 *
 *  - `CredentialsProviderError` is the one that leaks.
 *    `@aws-sdk/credential-provider-process` wraps EVERY exec failure in it, so
 *    its message interpolates the helper's ARGV and its stderr. Measured
 *    through a real client: `Command failed: /bin/sh -c 'echo "vault: token
 *    hvs.<...> rejected" >&2; exit 1'` followed by that stderr. An aws-vault /
 *    saml2aws setup whose credentials expire mid-wait would persist a token.
 *  - `TokenProviderError` must NOT be reduced. Its message IS the remedy --
 *    `Token is expired. To refresh this SSO session run 'aws sso login' with
 *    the corresponding profile.` -- so reducing it to a wire name would delete
 *    the fix instruction. A round-9 revision of this predicate matched the
 *    whole `*ProviderError` suffix and did exactly that.
 *
 *    The benefit is NOT realized on THIS path today, and saying otherwise was
 *    the claim review measured false: `@aws-sdk/credential-provider-sso`
 *    catches every token failure and rethrows it as a
 *    `CredentialsProviderError`, so the shape cannot escape a SigV4 client and
 *    an SSO expiry reaches here already reduced. The carve-out is a rule about
 *    the FAMILY, kept because the rewrap is upstream behaviour that can change
 *    and because the reduction is wrong for this class on any path that does
 *    surface it -- not a user-visible improvement this PR delivers.
 *  - `ProviderError` (the base) and `InstanceMetadataV1FallbackError` carry
 *    connectivity and CONFIG wording respectively -- the IMDS one interpolates
 *    three fixed literals naming config keys, with no argv, stderr, profile
 *    value or identity in it. Both are more useful raw.
 *
 * So string EQUALITY is right here, and it is right by enumeration rather than
 * by assumption. Re-check this list when the SDK major moves; do not widen it
 * to a suffix.
 *
 * The specific mechanism to re-check is `ProviderError.from()`, which does
 * `Object.assign(new this(...), error)` -- that copies a SOURCE error's own
 * `name` over the class field and would defeat string equality outright. It
 * has ZERO call sites anywhere in `node_modules` today, which is the only
 * reason equality is safe rather than merely correct-looking.
 */
const CREDENTIAL_LEAK_ERROR_NAME = 'CredentialsProviderError';

/** What one poll failure may say on each of the two channels. */
interface PollFailureText {
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
 * The authorship test is NOT `describeAwsFailure`'s. That one keys on the mere
 * PRESENCE of `$metadata`, and `@smithy/core`'s retry middleware stamps
 * `$metadata = {attempts, totalRetryDelay}` onto EVERY error it gives up on --
 * socket errors included. Measured against a real client pointed at a closed
 * port:
 *
 *     name 'Error', code 'ECONNREFUSED', $fault undefined,
 *     message 'connect ECONNREFUSED 127.0.0.1:1',
 *     $metadata { attempts: 3, totalRetryDelay: 58 }
 *
 * so reducing on it DELETES `connect ECONNREFUSED ...` -- the exact wording
 * issue [#3236](https://github.com/go-to-k/cdkd/issues/3236) was reported with
 * -- and leaves the bare token `Error.`, a socket error's `name` being `Error`.
 * The discriminator here is a real SERVICE signal instead: `$fault`, or a
 * NUMERIC `$metadata.httpStatusCode`, which a transport failure never carries
 * and a service rejection always does.
 *
 * Credential resolution carries NEITHER signal, which is why
 * {@link CREDENTIAL_LEAK_ERROR_NAME} is a third arm. That is measured, not
 * read off the middleware table -- review round 8 argued from middleware
 * priorities that identity is resolved inside the retry middleware, and a real
 * `CloudControlClient` whose credential provider throws answers
 * `{name:'CredentialsProviderError', $fault: undefined, $metadata: undefined}`.
 * The mechanism, confirmed afterwards: identity is resolved by
 * `httpAuthSchemeMiddleware` at step `serialize`, which WRAPS retry's
 * `finalizeRequest`, and retry's own catch CREATES `$metadata` when it is
 * absent -- so an escaping error with none PROVES it never entered retry. Do
 * not "correct" this back.
 *
 * Retiring the divergence with the shared helper is
 * [#3297](https://github.com/go-to-k/cdkd/issues/3297).
 */
function describePollFailure(error: unknown): PollFailureText {
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

  const serviceAuthored =
    (error as { $fault?: unknown }).$fault !== undefined ||
    typeof (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode ===
      'number' ||
    error.name === CREDENTIAL_LEAK_ERROR_NAME;

  if (!serviceAuthored) {
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

  // `redactedAwsFailureSummary` rather than `describeAwsFailure(...).summary`:
  // that helper applies its OWN authorship test, so for the credential case the
  // two disagree and it hands back the RAW message. Where they disagree, THIS
  // predicate wins.
  return {
    display: redactedAwsFailureSummary(error),
    detail: error.message,
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
 * decision, which relies on the structured `ErrorCode: NotFound` /
 * `ResourceNotFoundException` signals plus the long-standing narrow
 * substrings (issue #1252).
 */
export function isNotFoundMessage(message: string): boolean {
  return /not\s*found|does\s*not\s*exist|no\s*such|non\s*existent|\bno\b[^.;:]{0,80}\bfound\b/i.test(
    message
  );
}

/**
 * When a Cloud Control operation FAILS with an authorization error whose
 * Java-SDK trailer names a service OTHER than Cloud Control itself
 * ("... (Service: SesV2, Status Code: 403, Request ID: ...)"), the rejection
 * happened inside the AWS-managed resource handler's own downstream call —
 * cdkd's credentials already authenticated to Cloud Control to start the
 * operation, so the caller's local credential setup is not the culprit. The
 * raw StatusMessage reads like a local credential problem and sends users off
 * to debug their own keys (issue #1468: the AWS::SES::EmailIdentity UPDATE
 * handler's SesV2 call 403'd reproducibly while the exact same SesV2
 * operations succeeded when invoked directly with the same credentials).
 * Returns a re-framing hint to append to the failure message, or '' when the
 * shape does not match.
 *
 * Wording constraint: the hint is appended to an error message that
 * downstream matchers test against (isNotFoundMessage above, the
 * retryable-error message table in src/deployment/retryable-errors.ts), so it
 * must not introduce a "not found" / "does not exist" / "no such" match nor
 * any retryable-pattern substring. Pinned by a unit test.
 */
export function handlerAuthFailureHint(statusMessage: string): string {
  const match = /\(Service:\s*([A-Za-z0-9._-]+)[,;]\s*Status Code:\s*403[,;)]/i.exec(statusMessage);
  if (!match) {
    return '';
  }
  const service = match[1] ?? '';
  // A 403 from Cloud Control itself IS a caller-credential problem — only a
  // downstream service's refusal gets re-framed.
  if (/cloudcontrol/i.test(service)) {
    return '';
  }
  return (
    ` [hint: this 403 was returned by ${service} to the AWS-managed resource handler running the ` +
    `operation, not to cdkd directly — these credentials already passed Cloud Control's own auth ` +
    `to start it. If the equivalent ${service} API call succeeds with the same credentials, the ` +
    `resource handler itself is failing (an upstream AWS issue worth retrying later), not your ` +
    `local credential setup.]`
  );
}

/** How many key names a malformed-model log line may carry. */
const MAX_LOGGED_MODEL_KEYS = 12;

/**
 * Summarize a JSON document by its KEY NAMES, for a log line that must not
 * carry the document's values (issue #1908).
 *
 * The document failed to parse, so the keys cannot be read structurally; this
 * matches the `"name":` lexical form instead. That is a deliberate trade: the
 * pattern requires the colon, so a bare string VALUE is never reported, and the
 * only way a value reaches the line is if the document contains a string that
 * is itself followed by a colon -- which for an AWS readback means a nested
 * key. Values are what must not leak, and a key-shaped token is not one.
 */
function describeJsonKeys(document: string): string {
  const keys: string[] = [];
  const seen = new Set<string>();
  const pattern = /"([^"\\]{1,64})"\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(document)) !== null) {
    const key = match[1]!;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    if (keys.length >= MAX_LOGGED_MODEL_KEYS) break;
  }
  if (keys.length === 0) return 'no readable key names';
  const suffix =
    pattern.lastIndex < document.length && keys.length >= MAX_LOGGED_MODEL_KEYS ? ', ...' : '';
  return `keys: ${keys.join(', ')}${suffix}`;
}

/**
 * Resource types whose Cloud-Control-routed DELETE gets a pre-flight
 * IDENTITY confirmation -- proof that the physical id the state record names
 * denotes a resource in the region this destroy is targeting -- before
 * `DeleteResource` is issued (issue #2283).
 *
 * WHY THIS IS A HOOK HERE AND NOT A ROUTING CHANGE
 * ------------------------------------------------
 * The issue offered two shapes and called the routing change "much smaller":
 * stop letting `AWS::S3::Bucket` reach Cloud Control at all, now that
 * `S3BucketProvider` carries its own region guard (issues #2227 / #2245).
 * Reading `provider-registry.ts` settles it the other way, for two reasons:
 *
 *  1. There is no per-type "CC auto-route list" to remove the type FROM. The
 *     route at `provider-registry.ts` step 3-5 is the generic issue #614
 *     silent-drop rule: a type WITH an SDK provider goes to Cloud Control
 *     exactly when its template uses a property that provider would silently
 *     DROP. Suppressing it for buckets means `disableCcApiFallback` on
 *     `S3BucketProvider`, which converts those deploys from "provisioned
 *     correctly via CC" into a hard `buildUnroutableSilentDropMessage` throw.
 *     That is a strictly larger behaviour change than this guard, and it
 *     regresses the bug #614 was filed for.
 *
 *  2. It would not even close the hazard. Step 2 of `getProviderFor` is the
 *     STICKY rule: a resource whose state says `provisionedBy: 'cc-api'`
 *     routes to this provider BEFORE the SDK provider is ever consulted, and
 *     `disableCcApiFallback` is not read on that path. The poisoned pre-guard
 *     state record the issue is about is precisely a record that already says
 *     `cc-api`, so it would still arrive here. Only adding the type to
 *     `STICKY_CC_MIGRATION_EXEMPT` would divert it. Since issue #2719 that
 *     table admits two modes, and NEITHER helps here: `'cc-broken'` is for
 *     types Cloud Control cannot manage, and `'sdk-coverage'` diverts a
 *     resource only when its property bags carry no actionable silent drop --
 *     which is the opposite of this case by construction. Were a type somehow
 *     admitted anyway, the divert would send the silent-drop property back
 *     down the dropping path on the next deploy; the property gate is what
 *     prevents it.
 *
 * So the confirmation belongs where the delete is actually issued. The set is
 * a set rather than an `if` because the hazard is not S3-specific in kind: any
 * type whose physical id is globally unique but whose RESOURCE is regional can
 * be named by a state record that denotes something in another region.
 * `AWS::S3::Bucket` is the only instance recorded so far (issue #2283).
 */
const CC_DELETE_IDENTITY_CHECKED_TYPES: ReadonlySet<string> = new Set(['AWS::S3::Bucket']);

/**
 * Whether a Cloud-Control-routed DELETE of `resourceType` is preceded by the
 * pre-flight identity confirmation described on
 * {@link CC_DELETE_IDENTITY_CHECKED_TYPES}.
 *
 * Exported so the routing decision is assertable in BOTH polarities: the
 * guarded type, and a control type that must keep issuing its `DeleteResource`
 * with no extra probe and no new IAM dependency.
 */
export function requiresCcDeleteIdentityCheck(resourceType: string): boolean {
  return CC_DELETE_IDENTITY_CHECKED_TYPES.has(resourceType);
}

/**
 * `IndeterminateGuard.guard` for the pre-flight identity confirmation above
 * (issue [#2301](https://github.com/go-to-k/cdkd/issues/2301)).
 *
 * Named for the GUARD, not for the type or the API it happens to probe today:
 * the value is persisted into `deployments/*.jsonl` and is therefore a user
 * contract, and the set it fires for is
 * {@link CC_DELETE_IDENTITY_CHECKED_TYPES} — a set that is expected to grow to
 * any type whose physical id is globally unique while its resource is
 * regional. `s3` / `get-bucket-location` in the id would go stale on the first
 * such addition, and a stale id cannot be corrected without breaking readers.
 */
export const CC_DELETE_REGION_IDENTITY_GUARD = 'cc-delete-region-identity';

/**
 * The region a `GetBucketLocation` answer denotes, canonicalized.
 *
 * Two legacy wire shapes, both still returned, which is why this is a function
 * rather than a field read: a bucket in `us-east-1` answers with an EMPTY /
 * null `LocationConstraint` (absent therefore means `us-east-1`, never
 * "unknown" -- folding it to unknown would make the commonest region
 * permanently indeterminate), and `EU` is a legacy alias for `eu-west-1`.
 *
 * THREE copies of this fold exist and neither of the other two is reusable
 * here:
 *
 *  - `providers/s3-bucket-provider.ts`'s private twin is the SDK route's
 *    guard, reached by a different routing decision, and it additionally
 *    reads `x-amz-bucket-region` off a `CreateBucket` 409 -- a signal that
 *    does not exist on this path, where the probe is a PRE-flight with no
 *    prior error to read. Folding them together would export a create-shaped
 *    API into a delete-only call site.
 *  - `utils/aws-region-resolver.ts:147` holds only the us-east-1 HALF of the
 *    fold, inline (`response.LocationConstraint || 'us-east-1'`, with no `EU`
 *    case at all), and is wrong here twice
 *    over: it is fail-OPEN by contract (it never throws and returns
 *    `fallbackRegion` on a failed probe, which would report this deploy's own
 *    region and let the foreign bucket through), and it passes
 *    `ExpectedBucketOwner`, which is the opposite of what this probe needs --
 *    see {@link CloudControlProvider.confirmDeleteTargetIdentity}. It also
 *    caches, so a second call in one process would skip the probe entirely.
 *
 * Each copy is pinned by unit tests on its own side, for exactly the fold it
 * carries: `s3-bucket-provider-already-owned-region.test.ts:223-224` for the
 * SDK twin's `''` / `null` spellings, `aws-region-resolver.test.ts:66` / `:74`
 * for the resolver's us-east-1 half, and this module's own suite for all three
 * us-east-1 spellings plus both polarities of the `EU` alias.
 */
function bucketLocationToRegion(constraint: string | null | undefined): string {
  const value = canonicalizeRegion((constraint ?? '').trim());
  if (value === '') return 'us-east-1';
  if (value === 'eu') return 'eu-west-1';
  return value;
}

/**
 * Whether an S3 error means the NAMED BUCKET IS ABSENT, as opposed to the
 * probe being unable to answer.
 *
 * The wire CODE alone, never a message match. Collapsing "absent" into "could
 * not answer" (or the reverse) is the failure mode the issue #2245 review
 * named: a bare 404 from a proxy, `AWS_ENDPOINT_URL`, or an S3-compatible
 * gateway must not be read as a positive statement about a bucket's region.
 */
function isNoSuchBucketError(error: unknown): boolean {
  return (error as { name?: string } | undefined)?.name === 'NoSuchBucket';
}

export class CloudControlProvider implements ResourceProvider {
  private cloudControlClient: CloudControlClient;
  private logger = getLogger().child('CloudControlProvider');
  private patchGenerator = new JsonPatchGenerator();
  /**
   * Types whose unresolvable-schema import warning has already been printed —
   * see `maskUncertifiedModelValues`. Per-instance so a test cannot inherit
   * another test's suppression.
   */
  private readonly warnedUnresolvableSchemaTypes = new Set<string>();

  // Maximum time to wait for operation completion (15 minutes)
  private readonly MAX_WAIT_TIME_MS = 15 * 60 * 1000;
  // Initial poll interval (1 second) - increases with 1.5x exponential backoff
  private readonly INITIAL_POLL_INTERVAL_MS = 1_000;
  // Maximum poll interval (10 seconds)
  private readonly MAX_POLL_INTERVAL_MS = 10_000;
  /**
   * How long an UNBROKEN run of transient poll failures is tolerated before
   * `waitForOperation` gives up and throws {@link CloudControlWaitAbandonedError}
   * (issue #3236). Reset by any poll that gets an answer, so it measures one
   * outage rather than a session's total flakiness.
   *
   * It is a SECOND bound INSIDE the existing wall-clock budget, never an
   * extension of one: the `while` condition below still holds, so re-polling
   * can only consume time the wait already had. `slow-cc-operation-timeouts.ts`
   * couples that budget to the two outer per-resource deadlines deliberately,
   * and a separate attempt budget able to outlive it would break the coupling.
   *
   * Two minutes because the failures that reach this loop have already
   * outlasted the SDK's own three STANDARD-mode attempts, so the population is
   * outages of seconds to minutes — a VPN reconnect, a DHCP renew, a throttle
   * that needs more than the SDK's sub-second backoff. Waiting the FULL budget
   * instead (up to 60 min for a slow type) would buy nothing the resume hint
   * does not: past this point the operation is equally unreachable, and the
   * user gets the same request token thirteen to fifty-eight minutes sooner.
   */
  private readonly POLL_TRANSIENT_GRACE_MS = 2 * 60 * 1000;
  /**
   * The grace `disableCcProtection`'s wait takes instead (issue
   * go-to-k/cdkd#3253 item 1). Its call site carries the reasoning; the short
   * version is that the flip is best-effort and swallowed, so a long wait there
   * is dead wall clock on a destroy that is failing anyway.
   */
  private readonly PROTECTION_FLIP_TRANSIENT_GRACE_MS = 10_000;

  constructor() {
    const awsClients = getAwsClients();
    this.cloudControlClient = awsClients.cloudControl;
  }

  /**
   * Create a resource using Cloud Control API
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating resource ${logicalId} (${resourceType})`);

    try {
      // Start resource creation
      const cleanProperties = stripNullValues(properties) as Record<string, unknown>;
      const ccProperties = stringifyJsonProperties(resourceType, cleanProperties);
      const desiredState = JSON.stringify(ccProperties);
      // Log the top-level property KEYS only, never the values (GHSA fix, sibling
      // of the update-path patch-log masking below): a CC-routed resource with no
      // SDK provider may carry a resolved `{{resolve:secretsmanager:...}}` value
      // in `ccProperties`, and this provider has no access to the resolver's
      // recorded-secret map to mask it. Keys are enough to debug a CREATE; the
      // full document still goes to AWS below.
      this.logger.debug(
        `DesiredState for ${logicalId}: keys=${JSON.stringify(Object.keys(ccProperties))}`
      );
      const createResponse = await this.cloudControlClient.send(
        new CreateResourceCommand({
          TypeName: resourceType,
          DesiredState: desiredState,
        })
      );

      if (!createResponse.ProgressEvent?.RequestToken) {
        throw new ProvisioningError(
          `Failed to create resource ${logicalId}: No request token received`,
          resourceType,
          logicalId
        );
      }

      this.logger.debug(
        `Create request submitted for ${logicalId}, token: ${createResponse.ProgressEvent.RequestToken}`
      );

      // Wait for creation to complete
      const progressEvent = await this.waitForOperation(
        createResponse.ProgressEvent.RequestToken,
        logicalId,
        'CREATE',
        resourceType
      );

      if (!progressEvent.Identifier) {
        throw new ProvisioningError(
          `Failed to create resource ${logicalId}: No physical ID returned`,
          resourceType,
          logicalId
        );
      }

      this.logger.debug(`Created resource ${logicalId}, physical ID: ${progressEvent.Identifier}`);

      // Parse resource properties to extract attributes
      const result: ResourceCreateResult = {
        physicalId: progressEvent.Identifier,
      };

      if (progressEvent.ResourceModel) {
        result.attributes = this.parseResourceModel(progressEvent.ResourceModel);
      }

      // Generic sparse-model read-back (issue #1105) — BEFORE the per-type
      // enrichment switch so its `if (!enriched['X'])` gating composes.
      result.attributes = await this.mergeSparseModelReadback(
        resourceType,
        progressEvent.Identifier,
        result.attributes || {}
      );

      // Enrich attributes with computed values for specific resource types
      result.attributes = await this.enrichResourceAttributes(
        resourceType,
        progressEvent.Identifier,
        result.attributes
      );

      return result;
    } catch (error) {
      await this.cleanupFailedCreateRemnant(error, resourceType, logicalId);
      this.handleError(error, 'CREATE', resourceType, logicalId);
    }
  }

  /**
   * Best-effort deletion of the physical resource a FAILED async CREATE left
   * behind.
   *
   * Some Cloud Control create handlers materialize the resource first and
   * stabilize it afterwards (e.g. `AWS::Synthetics::Canary` creates the canary
   * entity, then builds its backing Lambda). When stabilization fails — most
   * commonly the just-created-IAM-role propagation race cdkd's fast path is
   * prone to — the FAILED progress event carries the materialized resource's
   * `Identifier`, but the half-created remnant keeps occupying the name. The
   * deploy engine's outer `withRetry` then re-invokes `create()` (the
   * stabilization message matches the transient-error patterns) and every
   * retry fails with `AlreadyExists` instead of recovering, and the remnant is
   * ALSO invisible to rollback (the create never returned, so it is not in
   * state) — an orphan CloudFormation would have deleted on rollback.
   *
   * Deleting the remnant here restores both behaviors: the next retry starts
   * with a free name (and succeeds once AWS stabilizes), and a final failure
   * leaves nothing behind.
   *
   * Safety: never fires when the handler reported `ErrorCode: AlreadyExists`
   * — there the identifier names a resource that pre-dates this create (our
   * CreateCanary repro's SECOND attempt reported exactly that shape), and
   * deleting it would destroy a user's pre-existing resource. Handlers may
   * also stuff a speculative identifier into a FAILED event without having
   * materialized anything (observed on `AWS::CodeDeploy::DeploymentGroup`);
   * the delete then no-ops via the NotFound-idempotent path (structured
   * `ErrorCode: NotFound` or the canonical message substrings), and a
   * service-worded not-found the delete path cannot recognize (CodeDeploy's
   * "No Deployment Group found for name: ...") is downgraded here to an
   * already-gone info instead of the misleading "remove it manually" warning
   * (issue #1252). Real cleanup failures are warned, not thrown — the
   * original create error must surface.
   */
  private async cleanupFailedCreateRemnant(
    error: unknown,
    resourceType: string,
    logicalId: string
  ): Promise<void> {
    if (!(error instanceof CloudControlOperationFailedError)) return;
    if (error.ccOperation !== 'CREATE' || !error.physicalId) return;
    if (error.ccErrorCode === 'AlreadyExists') return;
    // ResourceConflict means the identifier is undergoing ANOTHER in-flight
    // operation — the identifier may name a resource this request did not
    // materialize, so deleting it is not ours to do either.
    if (error.ccErrorCode === 'ResourceConflict') return;

    this.logger.info(
      `CREATE of ${logicalId} failed after materializing ${error.physicalId}; deleting the remnant so a retry can re-create it`
    );
    try {
      // Reuse the provider's own delete: it polls the async operation to
      // completion and already treats NotFound as idempotent success.
      const cleanupResult = await this.delete(logicalId, error.physicalId, resourceType);
      // Issue #1778 confirmed the ACCOUNTING half of "the result is
      // uninteresting here": this is a CREATE path, so nothing it returns
      // reaches the destroy runner's deleted/skipped counters, and the only
      // consumer of a failure is the warning below (the original create error
      // must surface either way). What is NOT uninteresting is the MESSAGE:
      // the debug line below asserts the remnant was removed, so a skip made
      // it say the opposite of what happened. A skip is also the one outcome
      // that means the name is still taken, which is exactly what the caller's
      // retry is about to trip over — so it takes the same warning a failed
      // cleanup takes.
      //
      // Reachability note: the delegating branch in `delete` (the only
      // producer of a skip on this provider today) is gated on
      // `context.removeProtection`, and this call passes no context at all, so
      // the branch below is unreachable from here as the code stands. It is
      // kept because the reachability is a property of a DIFFERENT method's
      // internals, not of this call site, and the cost of being wrong about it
      // is a false "removed" line over an occupied name.
      if (cleanupResult?.outcome === 'skipped') {
        this.logger.warn(
          `Skipped deleting the remnant ${error.physicalId} left by the failed CREATE of ${logicalId} ` +
            `(a retry may fail with AlreadyExists until it is removed manually): ${displaySafe(cleanupResult.reason)}`
        );
        return;
      }
      this.logger.debug(`Removed failed-create remnant ${error.physicalId} for ${logicalId}`);
    } catch (cleanupError) {
      // Deliberately the RAW message, and deliberately NOT the guarded
      // `describePollFailure(...).display` that `disableCcProtection`'s twin
      // catch takes. Two reasons, both measured after a round-10 review
      // proposed converting this site as well:
      //
      //  - the bare `String()` arm is UNREACHABLE here. Every throw into this
      //    catch comes from `this.delete(...)` above, which wraps whatever it
      //    caught into a `ProvisioningError` — always an `Error`. The flip's
      //    catch differs because its `UpdateResource` SEND is inside it, so a
      //    non-`Error` rejection reaches that one raw. A case written against
      //    this site stayed green under the bare form; that is why.
      //  - reducing the text here would be a NO-OP today and a decision-changer
      //    the moment the wrapper stops being cdkd-authored. Measured: applying
      //    the conversion leaves the whole provisioning suite green, because
      //    every error leaving `this.delete()` is a cdkd-authored
      //    `ProvisioningError` carrying no `$fault` and no numeric
      //    `httpStatusCode`, so `describePollFailure` hands back the raw
      //    message anyway. The risk is real but LATENT: `message` feeds
      //    `isNotFoundMessage` five lines down, which matches service PROSE
      //    ("No Deployment Group found for name: ..."), so on any future path
      //    where an AWS-authored error reaches this catch the reduction would
      //    silently stop that classifier recognising the shapes it exists for.
      //    An earlier revision of this comment stated that as a live risk,
      //    which review measured false.
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      // Ahead of `isNotFoundMessage`, and NOT a duplicate of the four
      // already-deleted guards elsewhere — this one matches with a
      // case-INSENSITIVE regex, so it has a failure mode they do not. Since
      // issue go-to-k/cdkd#3236 the cleanup delete can abandon its own wait,
      // and that message interpolates the transport cause: a
      // `getaddrinfo ENOTFOUND cloudcontrolapi...` contains `NOTFOUND`, which
      // `/not\s*found/i` matches (measured). The arm would then log "was
      // already gone; nothing to clean up" and SUPPRESS the
      // "remove it manually / a retry may fail with AlreadyExists" warning —
      // over a remnant still occupying the name, which is the one thing the
      // caller's retry is about to trip over.
      if (isWaitAbandonedError(cleanupError)) {
        // The clause goes BEFORE the interpolated message, not after it: that
        // message ends with the abandonment's pasteable `aws cloudcontrol` line
        // and `displaySafe`'s default mode flattens its newline to a space, so
        // appending cdkd prose puts text after a command on one line — the rule
        // `buildResumeCommand` establishes, one level out.
        this.logger.warn(
          `Could not confirm whether the remnant ${error.physicalId} left by the failed CREATE of ${logicalId} was removed ` +
            `(a retry may fail with AlreadyExists until it is removed manually): ${displaySafe(message)}`
        );
        return;
      }
      // A not-found on the remnant delete means the remnant is ALREADY gone —
      // the failed CREATE never actually materialized it, or it vanished
      // before the delete landed. delete() absorbs the structured
      // `ErrorCode: NotFound` shape itself; this fallback catches handlers
      // that report a non-NotFound code with a service-worded message.
      if (isNotFoundMessage(message)) {
        this.logger.info(
          `The remnant ${error.physicalId} left by the failed CREATE of ${logicalId} was already gone (not found); nothing to clean up`
        );
        return;
      }
      // `displaySafe` for the same reason its siblings in this function carry
      // it: the message is an AWS failure, not cdkd-authored text, and
      // `ConsoleLogger.formatMessage` sanitizes EXTRA ARGS only. All THREE warn
      // arms in this function take the same treatment — sanitize the
      // interpolated value, and put cdkd's own clause before it rather than
      // after. An earlier revision did two of the three and miscounted them.
      //
      // Only THIS arm's call is load-bearing, and the asymmetry is measured
      // rather than assumed: deleting `displaySafe` from the ABANDONED arm or
      // the SKIPPED arm leaves the whole suite green, because the first
      // receives text `abandonWait` has already sanitized and the second
      // receives a provider-authored skip reason. This arm is the only one
      // interpolating a raw caught message, and it is the one the fence in
      // `cloud-control-wait-abandoned.test.ts` pins. The other two stay: what
      // arrives sanitized today is an upstream property, not one this function
      // controls.
      this.logger.warn(
        `Failed to delete the remnant ${error.physicalId} left by the failed CREATE of ${logicalId} ` +
          `(a retry may fail with AlreadyExists until it is removed manually): ${displaySafe(message)}`
      );
    }
  }

  /**
   * Update a resource using Cloud Control API
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(
      `Updating resource ${logicalId} (${resourceType}), physical ID: ${physicalId}`
    );

    // Issue #2301 item 1. Ahead of EVERY call this method makes -- including
    // the `DescribeType` behind `getTopLevelWriteOnlyProperties` -- because a
    // refusal here should cost nothing and reach AWS with nothing.
    //
    // `context` is new on this method: `ResourceProvider.update` has taken an
    // `UpdateContext` since issue #1732, but this provider never declared the
    // parameter and the interface carried no region field until now. The
    // consequence of the gap is a misapplied configuration rather than the
    // delete path's unrecoverable destruction, which is why issue #2283 took
    // delete first -- not because this path was safe.
    await this.assertRecordedRegionAgainstClient(
      'pre-update',
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId
    );

    try {
      // Strip null/undefined values and stringify JSON properties before generating patch
      const cleanPreviousProperties = stringifyJsonProperties(
        resourceType,
        stripNullValues(previousProperties) as Record<string, unknown>
      );
      const cleanProperties = stringifyJsonProperties(
        resourceType,
        stripNullValues(properties) as Record<string, unknown>
      );

      // Generate JSON Patch document
      let patch = this.patchGenerator.generatePatch(cleanPreviousProperties, cleanProperties);

      if (patch.length === 0) {
        // No changes detected
        this.logger.debug(`No property changes detected for ${logicalId}, skipping update`);
        return {
          physicalId,
          wasReplaced: false,
        };
      }

      // Issue #809: Cloud Control applies the patch read-modify-write, and
      // the type's read handler cannot return write-only properties — so any
      // write-only property absent from the patch document silently vanishes
      // from the desired state on every UPDATE (e.g. AWS::ECS::Service loses
      // VolumeConfigurations and the update hard-fails). Mirror
      // terraform-provider-awscc: strip every write-only property from the
      // PREVIOUS side so the patch generator naturally emits `add` ops for
      // all write-only properties present in the desired properties. Only
      // write-only properties are force-included — blanket-upserting ALL
      // desired properties would risk false replacement signals on
      // createOnlyProperties whose read-back form differs from the stored
      // form. The DescribeType lookup is cached per type and degrades to the
      // minimal patch (with a warning) when the API is unavailable.
      const writeOnlyProperties = await getTopLevelWriteOnlyProperties(resourceType);
      if (writeOnlyProperties.size > 0) {
        const previousWithoutWriteOnly = { ...cleanPreviousProperties };
        for (const propertyName of writeOnlyProperties) {
          delete previousWithoutWriteOnly[propertyName];
        }
        patch = this.patchGenerator.generatePatch(previousWithoutWriteOnly, cleanProperties);
        if (patch.length === 0) {
          // The only "changes" were write-only properties REMOVED from the
          // desired properties — Cloud Control cannot remove what its read
          // handler never returns, so there is nothing to send.
          this.logger.debug(
            `Only removed write-only properties detected for ${logicalId}, skipping update`
          );
          return {
            physicalId,
            wasReplaced: false,
          };
        }
      }

      // Log the patch OPERATIONS + PATHS only, never the values (GHSA fix): a
      // patch value can be a resolved secret (a Cloud-Control-routed
      // `{{resolve:secretsmanager:...}}` property, e.g. Cognito
      // `ProviderDetails.client_secret`), and this provider has no access to the
      // resolver's recorded-secret map to mask it. Paths are enough to debug
      // patch generation; the full document still goes to AWS below.
      this.logger.debug(
        `Generated ${patch.length} patch operations for ${logicalId}: ${JSON.stringify(
          patch.map((op) => {
            const anyOp = op as { op?: unknown; path?: unknown };
            return { op: anyOp.op, path: anyOp.path };
          })
        )}`
      );

      // Start resource update
      const updateResponse = await this.cloudControlClient.send(
        new UpdateResourceCommand({
          TypeName: resourceType,
          Identifier: physicalId,
          PatchDocument: JSON.stringify(patch),
        })
      );

      if (!updateResponse.ProgressEvent?.RequestToken) {
        throw new ProvisioningError(
          `Failed to update resource ${logicalId}: No request token received`,
          resourceType,
          logicalId,
          physicalId
        );
      }

      this.logger.debug(
        `Update request submitted for ${logicalId}, token: ${updateResponse.ProgressEvent.RequestToken}`
      );

      // Wait for update to complete
      const progressEvent = await this.waitForOperation(
        updateResponse.ProgressEvent.RequestToken,
        logicalId,
        'UPDATE',
        resourceType
      );

      this.logger.debug(`Updated resource ${logicalId}`);

      // Parse resource properties to extract attributes
      // Resource replacement for immutable property changes is detected and handled
      // by DeployEngine (immutable property detection + CREATE→DELETE flow) before
      // reaching this update method, so wasReplaced is always false here.
      const result: ResourceUpdateResult = {
        physicalId,
        wasReplaced: false,
      };

      if (progressEvent.ResourceModel) {
        result.attributes = this.parseResourceModel(progressEvent.ResourceModel);
      }

      // Generic sparse-model read-back (issue #1105). Also covers UPDATE
      // staleness: a ProgressEvent that omits attributes present at CREATE
      // would otherwise leave stale values in state — the read-back refreshes
      // them from the AWS-current model.
      result.attributes = await this.mergeSparseModelReadback(
        resourceType,
        physicalId,
        result.attributes || {}
      );

      // Enrich attributes with computed values for specific resource types
      result.attributes = await this.enrichResourceAttributes(
        resourceType,
        physicalId,
        result.attributes
      );

      return result;
    } catch (error) {
      this.handleError(error, 'UPDATE', resourceType, logicalId, physicalId);
    }
  }

  /**
   * Delete a resource using Cloud Control API
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    this.logger.debug(
      `Deleting resource ${logicalId} (${resourceType}), physical ID: ${physicalId}`
    );

    // Fail closed on `DeletionPolicy: Snapshot` (issue #1352): Cloud Control
    // `DeleteResource` has no final-snapshot parameter, so this provider
    // CANNOT honor `finalSnapshotIdentifier`. The destroy call sites already
    // refuse cc-api-routed atomic types before the delete, so this is
    // defense-in-depth against a future call site passing the field to a
    // provider that would silently ignore it — the exact silent data loss
    // the field exists to prevent.
    if (context?.finalSnapshotIdentifier !== undefined) {
      throw new ProvisioningError(
        `${logicalId} (${resourceType}) requires a final snapshot ` +
          `(DeletionPolicy: Snapshot), but the Cloud Control API delete route has no ` +
          `final-snapshot parameter. Re-run with --skip-final-snapshot after snapshotting ` +
          `manually, or retain the resource.`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    // Issue #2301 item 2: the record's region, checked UNCONDITIONALLY and for
    // EVERY Cloud-Control-routed type, before anything below runs.
    //
    // Until this existed, `assertRegionMatch` ran only in the `NotFound` arm of
    // the catch block at the bottom of this method -- which a wrong-region
    // delete usually never reaches. A Cloud Control `Identifier` is most often
    // a NAME, and the same name commonly exists in the client's region too
    // (the same stack deployed to two regions; cdkd's own `resource-name.ts`
    // derives an identical name from an identical stack + logical id). So the
    // delete succeeds -- against the wrong resource, unrecoverably -- and the
    // guard that was supposed to catch it sat on the branch that error never
    // takes. The hardening costs ZERO API calls beyond resolving the client's
    // own configured region, and it is type-INDEPENDENT: unlike
    // `confirmDeleteTargetIdentity` below it is not about S3, the global
    // bucket namespace, or the region redirect.
    //
    // Ordering against the two neighbours here is deliberate. It comes AFTER
    // the `finalSnapshotIdentifier` fail-closed above, which is a pure
    // context-shape refusal needing no I/O, and BEFORE
    // `confirmDeleteTargetIdentity`, which spends a `GetBucketLocation`: when
    // both would refuse, the cheaper and more general answer should win.
    //
    // The `update()` twin is at the top of `update()` (issue #2301 item 1);
    // `UpdateContext` now carries `expectedRegion` for it.
    await this.assertRecordedRegionAgainstClient(
      'pre-delete',
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId
    );

    // Pre-flight identity confirmation (issue #2283). Deliberately placed
    // ahead of EVERY mutating step below -- the `--remove-protection` flips,
    // the SDK delegations, and the `DeleteResource` itself -- because a
    // protection flip or an ASG force-delete against the wrong resource is
    // already damage, not merely a wasted call.
    //
    // With the PRODUCTION tables that ordering is unobservable: the only
    // guarded type is `AWS::S3::Bucket`, which has no entry in
    // `cc-protection-properties.ts` and is neither delegating type, so today
    // no mutating step actually precedes the probe for any member of the set.
    // Measured: moving this call below all three `--remove-protection` blocks
    // left the unit suite fully green UNTIL the injected case described below
    // was added, so "zero Cloud Control traffic on a refusal" fences a
    // mutation that SKIPS the guard but not one that MOVES it. That half is
    // now fenced by
    // `cloud-control-s3-delete-identity-2283.test.ts`, which injects a
    // `ccProtectionProperty` entry for the bucket type so the delete has a
    // real `UpdateResourceCommand` to issue first -- a test-side injection,
    // with no production routing changed. The two SDK delegations above
    // (`AWS::AutoScaling::AutoScalingGroup`, `AWS::EC2::Instance`) remain
    // UNFENCED, and deliberately so: fencing them would mean putting a
    // delegating type into `CC_DELETE_IDENTITY_CHECKED_TYPES`, which is a
    // routing change rather than a test.
    // Issue #2301 item 3: a guard that could NOT answer proceeds, but the
    // outcome must survive the run. A provider cannot reach the deployment-event
    // recorder, so the verdict rides out on `ResourceDeleteResult` and the
    // destroy runner persists it. Every `return` below this line therefore has
    // to carry it — see `withIndeterminateGuard`.
    const indeterminateGuard = await this.confirmDeleteTargetIdentity(
      logicalId,
      resourceType,
      physicalId,
      context
    );

    // `--remove-protection` for an `AWS::AutoScaling::AutoScalingGroup` routed
    // through Cloud Control (its template set a silent-drop property such as
    // `AvailabilityZoneIds`, so the #614 routing rule sent the whole resource
    // via Cloud Control instead of the SDK ASGProvider). Cloud Control's
    // DeleteResource cannot ForceDelete the group, clear its
    // `DeletionProtection`, or terminate the EC2-level termination-protected
    // instances the group launched — so a bare CC delete of a protected ASG
    // fails (or leaves the group + instances behind). Delegate to the SDK
    // ASGProvider, which owns the full protected force-delete sequence (group
    // `DeletionProtection` flip -> per-instance `DisableApiTermination` flip ->
    // `DeleteAutoScalingGroup(ForceDelete: true)` -> wait-gone). This keeps a
    // single source of truth for protected-ASG deletion shared across both
    // routing paths (issue #798; the SDK path is issue #796). `context` carries
    // `expectedRegion`, so the delegated provider's region check is preserved.
    if (
      context?.removeProtection === true &&
      resourceType === 'AWS::AutoScaling::AutoScalingGroup'
    ) {
      this.logger.debug(
        `Delegating protected AutoScalingGroup ${logicalId} delete to the SDK ASGProvider (Cloud Control cannot force-delete a protected ASG)`
      );
      const { ASGProvider } = await import('./providers/asg-provider.js');
      // Issue #1778: PROPAGATE the delegate's verdict instead of discarding it.
      //
      // The contract for a delegating caller had two candidate shapes: assert
      // the delegate cannot skip, or pass its outcome upward. Propagation wins
      // for the same reason `NestedStackProvider.delete` propagates the child
      // runner's `skippedCount` / `interrupted` — the whole point of the
      // #1752 mechanism is that "the provider returned normally" is NOT the
      // same claim as "the resource is gone". Swallowing the delegate's
      // `'skipped'` here would make the destroy runner print
      // `✓ <id> (AWS::AutoScaling::AutoScalingGroup) deleted`, drop the state
      // record and exit 0 over an ASG the SDK provider explicitly said it
      // could not address. An assertion, by contrast, would have to be
      // re-verified every time `ASGProvider.delete` grows an arm (issue #1770
      // is adding exactly that class of arm elsewhere), and it fails LOUDLY on
      // a case the delegate considers merely unaddressable.
      //
      // Typed through the `ResourceProvider` interface deliberately: it is the
      // interface's `Promise<void | ResourceDeleteResult>` that keeps this
      // forwarding correct if `ASGProvider.delete` widens its own concrete
      // return type later, so no edit is needed here when it does.
      const asgProvider: ResourceProvider = new ASGProvider();
      // Issue #2301 item 3: the pre-flight ran HERE, before the delegation, so
      // its verdict is this provider's to report — the delegate never saw it
      // and cannot. Merged into whichever outcome the delegate returned rather
      // than replacing it, for the same reason the delegate's `'skipped'` is
      // propagated at all: the two facts are independent.
      //
      // UNREACHABLE with today's tables (`AWS::AutoScaling::AutoScalingGroup`
      // is not in `CC_DELETE_IDENTITY_CHECKED_TYPES`, so `indeterminateGuard`
      // is always `undefined` here) and written anyway, because the alternative
      // is a silent drop the day a delegating type joins that set.
      return withIndeterminateGuard(
        await asgProvider.delete(logicalId, physicalId, resourceType, _properties, context),
        indeterminateGuard
      );
    }

    // `--remove-protection` for an `AWS::EC2::Instance` routed through Cloud
    // Control (e.g. its template tripped the #614 silent-drop routing): Cloud
    // Control's DeleteResource has no notion of `DisableApiTermination`, so it
    // 400s "The instance ... may not be terminated. Modify its
    // 'disableApiTermination' instance attribute and try again." We flip the
    // attribute off first, then retry the delete through the modify->delete
    // propagation window (the modify WRITE lags the delete READ — see
    // ec2-termination-protection.ts). Gated on removeProtection so a protected
    // instance destroyed WITHOUT the flag still fails fast.
    const isProtectedEc2Instance =
      context?.removeProtection === true && resourceType === 'AWS::EC2::Instance';
    if (isProtectedEc2Instance) {
      await disableInstanceApiTermination(getAwsClients().ec2, physicalId, this.logger);
    }

    // `--remove-protection` for CC-routed types whose deletion protection is
    // an ordinary top-level property (issues #1312 / #1314, e.g.
    // `AWS::DSQL::Cluster.DeletionProtectionEnabled`): set it to its "off"
    // value in-place via a CC UpdateResource patch, then proceed with the
    // normal delete. Best-effort — the flip is idempotent, and if it fails
    // (throttle, IAM, unexpected schema) the delete below surfaces the real
    // error, matching the EC2 `DisableApiTermination` precedent above. Gated
    // on removeProtection so a protected resource destroyed WITHOUT the flag
    // still fails fast.
    if (context?.removeProtection === true) {
      const protectionEntry = ccProtectionProperty(resourceType);
      if (protectionEntry) {
        // Deliberately unconditional (no state-property pre-check): recorded
        // properties can be stale vs. an out-of-band console/CLI flip, and
        // the patch is idempotent.
        await this.disableCcProtection(logicalId, physicalId, resourceType, protectionEntry);
      }
    }

    const maxAttempts = isProtectedEc2Instance ? TERMINATION_PROTECTION_MAX_ATTEMPTS : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        // Start resource deletion
        const deleteResponse = await this.cloudControlClient.send(
          new DeleteResourceCommand({
            TypeName: resourceType,
            Identifier: physicalId,
          })
        );

        if (!deleteResponse.ProgressEvent?.RequestToken) {
          throw new ProvisioningError(
            `Failed to delete resource ${logicalId}: No request token received`,
            resourceType,
            logicalId,
            physicalId
          );
        }

        this.logger.debug(
          `Delete request submitted for ${logicalId}, token: ${deleteResponse.ProgressEvent.RequestToken}`
        );

        // Wait for deletion to complete
        await this.waitForOperation(
          deleteResponse.ProgressEvent.RequestToken,
          logicalId,
          'DELETE',
          resourceType
        );

        this.logger.debug(`Deleted resource ${logicalId}`);
        return withIndeterminateGuard(undefined, indeterminateGuard);
      } catch (error) {
        // Treat "not found" / "does not exist" as idempotent success for DELETE,
        // but only when the AWS client is operating against the same region the
        // resource was deployed to. A region mismatch must surface — otherwise a
        // destroy run with the wrong region would silently strip every resource
        // from state while leaving the actual AWS resources orphaned.
        //
        // The handler-reported `ErrorCode: NotFound` on an async FAILED DELETE
        // is the STRUCTURED form of the same signal — some service handlers
        // word their StatusMessage without any of the canonical substrings
        // (CodeDeploy: "No Deployment Group found for name: ..."), so the
        // message match alone misses them (issue #1252).
        const err = error as { name?: string; message?: string };
        const notFoundErrorCode =
          error instanceof CloudControlOperationFailedError &&
          error.ccOperation === 'DELETE' &&
          error.ccErrorCode === 'NotFound';
        // An ABANDONED wait is the one shape here that says the OPPOSITE of
        // already-gone: cdkd stopped watching a delete that may still be
        // running (issue #3236). The heuristics below are message SUBSTRING
        // tests over a message that interpolates the LOGICAL ID, so a resource
        // named `PageNotFound` — or any name containing `not found` /
        // `does not exist` — would satisfy them and this arm would drop the
        // state row over a live resource. Measured: it did.
        //
        // Structural, not a wording rule, because the wording cannot be made
        // safe: the interpolated inputs are the user's. This is also the one
        // consumer of those phrases with no `isMarkedNonRetryable` guard in
        // front of it, and a DELETE abandonment is deliberately unmarked so
        // the destroy runner can re-issue the delete.
        // Through the SHARED predicate, not a local `instanceof`: this is one
        // of FOUR classifiers that must refuse an abandoned wait, and the
        // other three (`deploy-engine.ts` x2, `destroy-runner.ts`) cannot see
        // the class. One spelling means they cannot disagree about what an
        // abandoned wait is — the divergence this area keeps collapsing.
        if (
          !isWaitAbandonedError(error) &&
          (notFoundErrorCode ||
            err.name === 'ResourceNotFoundException' ||
            err.message?.includes('does not exist') ||
            err.message?.includes('not found') ||
            err.message?.includes('NotFound'))
        ) {
          // Through the SAME helper as the pre-flight above (issue #2301
          // review), not a second hand-rolled comparison. Two comparisons of
          // the same two values in one method, normalised differently, is a
          // disagreement waiting to be reached -- and it WAS reachable: this
          // arm compared raw, so a client region of `US-EAST-1` (which
          // `foldRegionOption` does not fold, because it only folds `--region`
          // / `AWS_REGION` / `AWS_DEFAULT_REGION` and not a profile's
          // `region = US-EAST-1`) passed the pre-flight and was then REFUSED
          // here against a state region of `us-east-1`. Sharing the helper
          // also means this refusal is marked non-retryable and gets the same
          // typed-refusal protection from the "already deleted" message
          // classifiers as the pre-flight one.
          await this.assertRecordedRegionAgainstClient(
            'not-found',
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(
            `Resource ${logicalId} already deleted (not found), treating as success`
          );
          // Still carries the guard: an unanswerable identity probe followed by
          // a `NotFound` delete is exactly the sequence a DENIED probe produces
          // when the name really does denote something elsewhere, so this is
          // the LAST place to drop the record.
          return withIndeterminateGuard(undefined, indeterminateGuard);
        }
        if (
          isProtectedEc2Instance &&
          isTerminationProtectionPropagationError(err.message ?? '') &&
          attempt < maxAttempts
        ) {
          this.logger.debug(
            `Cloud Control delete of ${logicalId} raced the DisableApiTermination flip-off (attempt ${attempt}/${maxAttempts}); re-flipping and retrying`
          );
          await disableInstanceApiTermination(getAwsClients().ec2, physicalId, this.logger);
          await this.sleep(3000 * attempt);
          continue;
        }
        this.handleError(error, 'DELETE', resourceType, logicalId, physicalId);
      }
    }
  }

  /**
   * Refuse a Cloud Control call whose target region cannot be shown to be the
   * one the state record was written in (issue #2301).
   *
   * The ONE place this comparison happens, for all three phases: the
   * pre-flights at the top of `delete()` and `update()`, and the reactive
   * `not-found` arm inside `delete()`'s catch block. They can therefore never
   * disagree about what "unknown region" means, nor about how a region is
   * SPELLED -- the second one was live before this became shared: the reactive
   * arm compared raw while the pre-flight folded case, so one correct call
   * could pass the first and be refused by the second. THREE inputs, THREE outcomes, and they are
   * deliberately not two:
   *
   *  - NO recorded region (`undefined`, or an empty / whitespace-only string)
   *    -> PROCEED, and do not even resolve the client region. This is the
   *    guard's OWN default: a `version: 1` state record predates the
   *    region-scoped key layout and carries no region at all, and callers
   *    typed `region: string` (`deploy-engine.ts`'s `stackRegion`) can hand
   *    over `''`. Refusing on the absence would break every ordinary
   *    destroy / update of a pre-v2 record, which is the over-tightening
   *    failure a one-directional fence never sees.
   *  - A recorded region that MATCHES the client -> proceed silently. This is
   *    the ordinary path and it must stay free of new refusals: the whole
   *    fleet of same-region deletes and updates runs through here.
   *  - A recorded region that DIFFERS, or a client region that cannot be
   *    resolved at all -> REFUSE before issuing anything.
   *
   * The unresolvable-client-region arm is the one asymmetry worth naming:
   * {@link CloudControlProvider.confirmDeleteTargetIdentity} PROCEEDS when it
   * cannot establish a region, and this helper refuses. The two are answering
   * different questions. That probe asks a remote service where a globally
   * unique NAME lives, and a least-privilege role that was never granted
   * `s3:GetBucketLocation` would be stranded by a refusal. Here the caller has
   * positively recorded a region, the comparison is local and free, and a
   * client that cannot say where it points cannot be shown to point at that
   * region -- the same answer `assertRegionMatch` has always given on its
   * `not-found` phase.
   *
   * The refusal is marked non-retryable because it is deterministic: both
   * loops that wrap these calls -- the destroy runner's own attempt loop and
   * the deploy engine's / rollback executor's `withRetry` -- would otherwise
   * spend their full budget re-deriving the same verdict, which reads to a
   * user as flaky AWS rather than as a refusal.
   */
  private async assertRecordedRegionAgainstClient(
    phase: RegionCheckPhase,
    expectedRegion: string | undefined,
    resourceType: string,
    logicalId: string,
    physicalId: string
  ): Promise<void> {
    // Trimmed AND case-folded, matching `confirmDeleteTargetIdentity` below.
    // Both halves are load-bearing and both were MEASURED against this suite:
    // a `--region US-EAST-1` destroy and a padded state region are correct
    // inputs, and comparing them raw (which is what the `not-found` phase has
    // always done, on a branch narrow enough that it never showed) would
    // refuse them. A guard that rejects its own callers' ordinary spellings is
    // the over-tightening half of this change, not a stricter version of it.
    const recordedRegion = canonicalizeRegion(expectedRegion?.trim());
    if (recordedRegion === undefined || recordedRegion === '') return;

    let clientRegion: string | undefined;
    try {
      clientRegion = canonicalizeRegion((await this.cloudControlClient.config.region())?.trim());
    } catch (error) {
      // Resolution FAILED, which is not the same as "resolved to something
      // else" -- leave it undefined so `assertRegionMatch` produces the
      // "client region is unknown" refusal rather than letting a raw SDK
      // credential-chain error surface from a guard.
      this.logger.debug(
        `Could not resolve the Cloud Control client region before the ${phase} region check ` +
          `for ${logicalId} (${resourceType}): ` +
          // `.detail` is right on a `debug` line, and it is the guarded
          // stringification: a bare `String(value)` throws on a
          // null-prototype object, and this catch exists so the region check
          // can produce its own refusal rather than letting a raw SDK error
          // surface.
          // `displaySafe` for consistency with the other two detail lines on
          // this path: `debug` is lower-exposure than the persisted message,
          // not exposure-free, and this text comes from the SDK.
          `${displaySafe(describeAwsFailure(error).detail)}`
      );
      clientRegion = undefined;
    }

    try {
      assertRegionMatch(clientRegion, recordedRegion, resourceType, logicalId, physicalId, phase);
    } catch (error) {
      throw markNonRetryable(error as Error);
    }
  }

  /**
   * Confirm that the resource `physicalId` names actually lives in the region
   * this destroy is targeting, for the types in
   * {@link CC_DELETE_IDENTITY_CHECKED_TYPES}. No-op for every other type.
   *
   * WHAT THIS GUARDS THAT `assertRegionMatch` DOES NOT
   * ---------------------------------------------------
   * The `assertRegionMatch` comparison — which since issue #2301 runs both as
   * an unconditional pre-flight and on the `NotFound` arm below — compares the
   * CLIENT's region against the STATE's. That misses this hazard however often
   * it runs: both of its inputs can agree while the bucket the physical id
   * names sits somewhere else entirely. An `AWS::S3::Bucket` physical id is
   * a GLOBALLY unique name, so a state record written before the issue #2227 /
   * #2245 guards existed can name a bucket that is ours but lives elsewhere --
   * a cdkd-GENERATED bucket name carries no region or account: for a name cdkd
   * derives itself, `resource-name.ts:240` builds
   * `` `${currentStackName}-${name}` `` whenever `resource-name.ts:239`'s
   * `shouldPrefix` holds, so the same stack deployed to two regions produces
   * the same bucket name by construction. (That guard has a second, unrelated
   * path -- it also drops the prefix when there is no ambient stack name at
   * all -- so it is quoted here rather than enumerated.) And a delete of such a bucket is NOT expected to come back
   * `NotFound`: the mechanism issues #2245 / #2283 record is that S3 follows
   * the region redirect for a body-bearing operation, so the delete lands on
   * the live bucket in the other region and this catch block is never entered.
   * Nothing downstream can undo that, which is why the confirmation is
   * pre-flight rather than a wider net around the existing handler. The live
   * arm in `tests/integration/s3-lifecycle` (phase 0c) is what holds that
   * mechanism to account on THIS route.
   *
   * THE PROBE HAS THREE OUTCOMES AND ALL THREE ARE DISTINCT
   * -------------------------------------------------------
   *  - ANSWERED, region matches -> proceed silently. The hot path costs one
   *    `GetBucketLocation`.
   *  - ANSWERED, region differs -> REFUSE, non-retryable. Both retry loops
   *    that wrap a `delete()` honour the marker and would otherwise re-run the
   *    whole delete for their full budget before surfacing the same
   *    deterministic message, which reads as flaky AWS: the destroy path's own
   *    loop (`destroy-runner.ts:1328`, which runs FOUR attempts -- `attempt`
   *    goes 0..`maxAttempts` and `maxAttempts` is 3 at `:1326` -- with
   *    `isMarkedNonRetryable` gating both of its retryable arms at `:1372`)
   *    and the deploy engine's `withRetry` (`retry.ts:332`) on the
   *    replacement-delete path.
   *  - COULD NOT ANSWER -> proceed, but WARN at default verbosity. Refusing
   *    would strand destroys for least-privilege roles that never granted
   *    `s3:GetBucketLocation`, with no escape hatch. But proceeding SILENTLY
   *    is what the issue #2245 review rejected: a bucket policy denying
   *    `s3:GetBucketLocation` -- settable by anyone holding
   *    `s3:PutBucketPolicy` on the target -- would disable this guard while
   *    the operator's output stayed identical to a normal destroy. Failing
   *    closed on 403 alone is not the answer either, because a missing IAM
   *    grant and a hostile `Deny` are the same wire response.
   *
   * A bucket that is ABSENT is a fourth thing and is NOT the warning case: the
   * name denotes nothing, so there is nothing to delete in the wrong region,
   * and the `DeleteResource` below reaches its existing `NotFound` /
   * `assertRegionMatch` handling. Warning there would fire on every ordinary
   * re-run of an already-completed destroy.
   *
   * `GetBucketLocation` and not `HeadBucket`: a cross-region `HeadBucket` 301s
   * and SDK v3's region-redirect middleware mishandles the empty-body HEAD
   * response, yielding a synthetic `name: 'Unknown'`. That would land every
   * foreign-region bucket -- the exact case this exists to catch -- in the
   * indeterminate arm, which PROCEEDS. `src/utils/aws-region-resolver.ts`
   * records the same finding, and the SDK-side guard re-learned it the
   * expensive way.
   *
   * RETURN VALUE (issue #2301 item 3). `undefined` means the guard reached a
   * verdict — it confirmed the region, or the type is unguarded, or the bucket
   * is absent (a fourth outcome, not an indeterminate one, per the paragraph
   * above). An {@link IndeterminateGuard} means it could NOT, and the caller
   * must carry it out through `ResourceDeleteResult` so the destroy runner can
   * persist a `RESOURCE_GUARD_INDETERMINATE` event. A MISMATCH still throws.
   *
   * The two indeterminate arms below produce THREE distinct `reason` texts,
   * not two, and that is deliberate: the region-resolution arm falls THROUGH
   * into the no-region warn, so before this change a client whose SDK region
   * chain REJECTED was reported identically to one that was never asked. The
   * remedies differ (fix the credential chain / pass `--region` vs. repair the
   * state record), so the durable record — and the warn beside it — names
   * which happened.
   */
  private async confirmDeleteTargetIdentity(
    logicalId: string,
    resourceType: string,
    physicalId: string,
    context?: DeleteContext
  ): Promise<IndeterminateGuard | undefined> {
    if (!requiresCcDeleteIdentityCheck(resourceType)) return undefined;

    // `expectedRegion` is the state's recorded region and is the right
    // comparand when it is there. The client region is the fallback rather
    // than a skip: it is where `DeleteResource` will actually run, so a
    // mismatch against it is the same wrong-target delete.
    //
    // Its population, MEASURED rather than assumed (an earlier revision of
    // this comment claimed the "type-only `getProvider` call sites (destroy /
    // drift / state-refresh)", which is wrong on both halves: destroy, drift
    // and state-refresh all use `getProviderFor` WITH `provisionedBy`
    // -- `destroy-runner.ts:1284`, `drift.ts:2122` / `:3930`,
    // `state.ts:2340` / `:2394` -- and drift / state-refresh never call
    // `delete()` at all; the real `getProvider(` sites are `import.ts`,
    // `deploy-engine.ts` and `canonicalize-properties.ts`):
    //
    //  - `destroy-runner.ts:1336` spreads `expectedRegion` only when
    //    `state.region !== undefined`, so a PRE-v2 state record (where
    //    `region` was not yet part of the key layout) arrives with no region.
    //  - any caller threading an EMPTY region string. `deploy-engine.ts`
    //    types its `stackRegion` as `string`, so `''` reaches here as a
    //    DEFINED value.
    //
    // That second case is why this is not a bare `??`: `''` is not `null` or
    // `undefined`, so `??` would accept it, skip the client fallback, and
    // land in the warn below whose text ("neither ... reports a region")
    // would then be false, because the client was never asked.
    const recordedRegion = context?.expectedRegion?.trim();
    let expectedRegion: string | undefined =
      recordedRegion === undefined || recordedRegion === '' ? undefined : recordedRegion;
    // Set only when the SDK region chain REJECTED, which is a different fact
    // from "resolved to nothing" and gets a different `reason` / warn tail.
    let clientRegionError: string | undefined;
    if (expectedRegion === undefined) {
      try {
        const clientRegion = (await this.cloudControlClient.config.region())?.trim();
        expectedRegion =
          clientRegion === undefined || clientRegion === '' ? undefined : clientRegion;
      } catch (error) {
        // Same policy as a probe that cannot answer: report and PROCEED. An
        // unresolvable SDK region chain must not abort a delete that would
        // otherwise have run -- that would make this guard fail closed on one
        // input while failing open on every other undeterminable one. The
        // warn immediately below is the visible outcome.
        // Issue #2302's split, applied BEFORE the value can reach a durable
        // record. `summary` is the half safe to persist; `detail` is AWS's own
        // wording and goes to `debug` only. A cdkd- or SDK-authored failure
        // passes through unreduced, which is the point of the narrow rule.
        const clientRegionFailure = describeAwsFailure(error);
        clientRegionError = clientRegionFailure.summary;
        this.logger.debug(
          `Could not resolve the Cloud Control client region while confirming ${physicalId}: ` +
            `${clientRegionFailure.detail}`
        );
        expectedRegion = undefined;
      }
    }
    if (expectedRegion === undefined) {
      // The two spellings share the head so the pre-existing needle still
      // matches, and diverge on the tail so the fixed text is not a lie about
      // which of the two happened. `reason` mirrors the tail rather than
      // paraphrasing it: a durable record that disagrees with the terminal is
      // worse than either alone.
      const reason =
        clientRegionError === undefined
          ? `neither the stack state nor the AWS client reports a region`
          : `the stack state records no region and the AWS client's region could not be ` +
            `resolved: ${clientRegionError}`;
      // The persisted `reason` above keeps its cause VERBATIM -- it ends the
      // string, so its own trailing period is correct -- while the warn strips
      // it, because the warn appends another sentence. Exactly the split the
      // probe arm below uses, and the reason this arm needs it too:
      // `clientRegionError` is a `describeAwsFailure` summary, so its REDACTED
      // shape already ends in the helper's own sentence and would render
      // `own message.. Proceeding with the delete.` The sibling commit fixed
      // only the arm the live run happened to exercise.
      this.logger.warn(
        `Could not confirm that ${resourceType} ${physicalId} (${logicalId}) is the resource ` +
          `this destroy targets: ${reason.replace(/[.\s]+$/, '')}. Proceeding with the delete.`
      );
      return { guard: CC_DELETE_REGION_IDENTITY_GUARD, reason };
    }
    const wantRegion = canonicalizeRegion(expectedRegion);

    let actualRegion: string;
    try {
      // Deliberately NO `ExpectedBucketOwner`, unlike `state.ts:1738` and
      // `utils/aws-region-resolver.ts`, which both pass it. Those two are
      // asking "is this MY bucket, and where is it", and a foreign-owned
      // bucket 403ing is the answer they want. This probe asks the opposite
      // question: the whole hazard is a name that resolves to a bucket cdkd
      // must NOT delete, and the guard has to hear the foreign answer to
      // refuse. Adding the parameter back to match the convention would turn
      // every cross-account collision from a REFUSAL into a 403 -> the
      // indeterminate arm -> warn-and-proceed. Leaking the region of a bucket
      // whose NAME is already in this account's state file is not a
      // disclosure; deleting it is the harm.
      const location = await getAwsClients().s3.send(
        new GetBucketLocationCommand({ Bucket: physicalId })
      );
      actualRegion = bucketLocationToRegion(location.LocationConstraint);
    } catch (error) {
      if (isNoSuchBucketError(error)) {
        this.logger.debug(
          `Bucket ${physicalId} (${logicalId}) is already absent; leaving the delete to the ` +
            `Cloud Control idempotency path`
        );
        return undefined;
      }
      // NEVER AWS's own message here, in either half (issue
      // [#2302](https://github.com/go-to-k/cdkd/issues/2302)). The headline
      // population for this arm is a bucket policy DENYING
      // `s3:GetBucketLocation`, and S3 words that `AccessDenied` as `User:
      // arn:aws:sts::<account>:assumed-role/<role>/<session> is not authorized
      // to perform: ...` -- so interpolating it writes the destroying
      // principal's account id, role name and session name to the terminal AND,
      // since issue #2301 item 3, into `deployments/{runId}.jsonl`, which
      // `cdkd destroy` deliberately does not sweep. Making the guard DURABLE
      // must not make the caller durable: the attacker sets the policy, so they
      // choose when that record is written. The SDK-routed twin of this guard
      // reached the same answer at `s3-bucket-provider.ts`'s `probeFailedCause`.
      // Both halves are emitted, per that helper's contract -- the class in the
      // persisted `reason`, AWS's wording at `debug`, because the wording is
      // what separates a missing IAM grant from a bucket-policy `Deny` and that
      // distinction is the operator's next action.
      const failure = describeAwsFailure(error);
      this.logger.debug(
        `s3:GetBucketLocation on ${physicalId} (${logicalId}) failed: ${failure.detail}`
      );
      // Trailing sentence punctuation is stripped before this clause re-adds
      // it, because the two `summary` shapes disagree about it: a REDACTED one
      // ends in the helper's `VERBOSE_POINTER` sentence and already carries a
      // period, while a passed-through cdkd- or SDK-authored message usually
      // does not. Interpolating either directly is wrong for the other -- the
      // live run of `s3-lifecycle` phase 0c-ID printed `for AWS's own
      // message.. S3 bucket names ...` to a user-facing security warning.
      const summarySentence = failure.summary.replace(/[.\s]+$/, '');
      this.logger.warn(
        `Could not confirm which region S3 bucket ${physicalId} (${logicalId}) lives in before ` +
          `deleting it: ${summarySentence}. S3 bucket names are globally unique, so cdkd cannot ` +
          `rule out that this name denotes a bucket in another region. Grant s3:GetBucketLocation ` +
          `on the bucket to enable the check. Proceeding with the delete.`
      );
      return {
        guard: CC_DELETE_REGION_IDENTITY_GUARD,
        reason: `s3:GetBucketLocation on ${physicalId} could not be answered: ${failure.summary}`,
      };
    }

    if (actualRegion === wantRegion) {
      this.logger.debug(
        `Confirmed S3 bucket ${physicalId} (${logicalId}) lives in ${wantRegion} before deleting it`
      );
      return undefined;
    }

    throw markNonRetryable(
      new ProvisioningError(
        `Refusing to delete S3 bucket ${physicalId} for ${logicalId} (${resourceType}): the ` +
          `bucket carrying that name lives in ${actualRegion}, while this destroy targets ` +
          `${wantRegion}. S3 bucket names are globally unique, so a physical id recorded in ` +
          `cdkd state can denote a bucket in a different region. S3 follows the region ` +
          `redirect for a body-bearing operation, so issuing this delete risks destroying the ` +
          `live bucket in ${actualRegion} instead, unrecoverably, rather than reporting the ` +
          `bucket absent. Confirm the physical id recorded in cdkd state ` +
          `(cdkd state show) and correct the record: --region does not change this comparison, ` +
          `which reads the region stored in the state file, so re-running the destroy with a ` +
          `different flag value will not resolve it.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }

  /**
   * Set a registry-declared deletion-protection property to its "off" value
   * in-place via a CC UpdateResource patch (issues #1312 / #1314).
   * Best-effort: failures are logged at warn and swallowed — the subsequent
   * DeleteResource surfaces the real error if the protection is still on.
   * The `add` patch op is used (RFC 6902: replaces when the path exists,
   * adds when absent), so the flip is idempotent regardless of whether the
   * live model carries the property.
   */
  private async disableCcProtection(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    entry: CcProtectionEntry
  ): Promise<void> {
    const protectionProperty = entry.property;
    this.logger.debug(
      `Disabling ${protectionProperty} on ${logicalId} (${resourceType}) before delete (--remove-protection)`
    );
    try {
      const patch = [{ op: 'add', path: `/${protectionProperty}`, value: entry.offValue }];
      const response = await this.cloudControlClient.send(
        new UpdateResourceCommand({
          TypeName: resourceType,
          Identifier: physicalId,
          PatchDocument: JSON.stringify(patch),
        })
      );
      if (!response.ProgressEvent?.RequestToken) {
        this.logger.warn(
          `Could not disable ${protectionProperty} on ${logicalId}: no request token received; proceeding with delete`
        );
        return;
      }
      // A SHORT transient grace, not the poll's usual two minutes (issue
      // go-to-k/cdkd#3253 item 1). This flip is best-effort by construction —
      // the catch below swallows every failure and proceeds — so waiting out a
      // network outage here buys nothing: the `DeleteResource` that follows
      // surfaces the real error if the protection is still on, and under the
      // same outage that delete fails too. Spending the full grace would add
      // two minutes of dead wall clock per protected resource to a destroy
      // that is going to fail anyway.
      //
      // Not ZERO, which would abandon on the FIRST failure and lose the cheap
      // recovery the fence exists for: a one-second blip mid-flip is exactly
      // the case re-polling handles, and ten seconds covers it at the 1s ->
      // 1.5s -> 2.25s -> 3.4s schedule (8.125s of sleep across five re-polls,
      // giving up at ~13.2s of wall clock).
      //
      // The TRADEOFF this buys, stated because the paragraph above does not
      // cover it: for an outage of roughly 13s to 120s the old behaviour
      // recovered — the flip re-polled, the link came back, the delete
      // succeeded — and now the flip is abandoned and `delete()` issues its
      // `DeleteResource` while the link is still down. That delete gets ONE
      // attempt on this path and `isRetryableTransientError` answers false for
      // a socket error, so it fails hard and the user re-runs. Accepted
      // deliberately: the destroy runner's own retry plus the idempotent `add`
      // patch recover on that re-run, the cost is a retry rather than data
      // loss, and the alternative charges every `--remove-protection` destroy
      // two minutes per protected resource to serve that one band. Every
      // UNPROTECTED sibling in the same destroy keeps the full grace.
      await this.waitForOperation(
        response.ProgressEvent.RequestToken,
        logicalId,
        'UPDATE',
        resourceType,
        this.PROTECTION_FLIP_TRANSIENT_GRACE_MS
      );
      this.logger.debug(`Disabled ${protectionProperty} on ${logicalId}`);
    } catch (error) {
      // `displaySafe` for the same reason the poll warn above carries it: this
      // message is not fully cdkd-controlled. An abandonment arrives
      // pre-sanitized, but a NON-transient `UpdateResource` failure does not —
      // an `AccessDeniedException` here quotes
      // `User: arn:aws:sts::<acct>:assumed-role/<role>/<session>` — and
      // `ConsoleLogger.formatMessage` sanitizes EXTRA ARGS only, never the
      // message string.
      // `describePollFailure(...).display` rather than a bare
      // `String(error)`: this catch exists to SWALLOW so the delete can
      // proceed, and `String(value)` throws on a null-prototype object — an
      // out-throw here would abort a `--remove-protection` delete from the one
      // place built to let it continue. It also reduces a credential failure,
      // which the raw read did not: this line is default-verbosity.
      const described = describePollFailure(error);
      // Sanitize BEFORE testing for emptiness, and render NO clause when the
      // result is empty -- the same shape `abandonWait` uses, for the same
      // reachable case: `asSdkError` normalizes a non-`Error` rejection into an
      // `Error` with `message: ''`, and this catch encloses the
      // `UpdateResource` SEND, so one arrives here. Without the guard the line
      // ends `proceeding with delete: ` -- a colon promising a reason and then
      // giving none.
      const safeMessage = displaySafe(described.display);
      // `proceeding with delete` goes BEFORE the interpolated message, not
      // after it: an abandonment reaches this catch (the flip's own 10s grace),
      // and its message ends with the pasteable `aws cloudcontrol` line, whose
      // newline `displaySafe` flattens — so appending cdkd prose puts a second
      // clause after a command an operator may paste. Same rule as the two
      // remnant warns and as `buildResumeCommand` itself.
      this.logger.warn(
        `Could not disable ${protectionProperty} on ${logicalId} (${resourceType}), proceeding with delete${safeMessage === '' ? '' : `: ${safeMessage}`}`
      );
      // The DETAIL half of the split, and it is REQUIRED rather than tidy: the
      // warn above now carries a REDUCED text, and a reduction with nothing
      // behind it is a DELETION. An `AccessDeniedException` here is the case
      // that matters -- the wire name says "authorization", and the sentence
      // that says WHICH action and WHICH principal is the one an operator needs
      // to fix their policy. `logger.debug` is where it belongs: this line
      // quotes the caller's own assumed-role ARN.
      const detail = described.detail;
      if (detail !== '') {
        this.logger.debug(
          `Could not disable ${protectionProperty} on ${logicalId}, underlying failure: ${displaySafe(detail)}`
        );
      }
    }
  }

  /**
   * Get current state of a resource
   */
  async getResourceState(
    resourceType: string,
    physicalId: string
  ): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.cloudControlClient.send(
        new GetResourceCommand({
          TypeName: resourceType,
          Identifier: physicalId,
        })
      );

      if (!response.ResourceDescription?.Properties) {
        return null;
      }

      return this.parseResourceModel(response.ResourceDescription.Properties);
    } catch (error) {
      const err = error as { name?: string };
      if (err.name === 'ResourceNotFoundException') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Wait for an asynchronous operation to complete.
   *
   * Reached from FOUR call sites — `create()`, `update()`, `delete()` and
   * `disableCcProtection()` — so everything here is CREATE / UPDATE / DELETE
   * behavior at once.
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
  private async waitForOperation(
    requestToken: string,
    logicalId: string,
    operation: 'CREATE' | 'UPDATE' | 'DELETE',
    resourceType: string,
    /**
     * Per-call override of {@link POLL_TRANSIENT_GRACE_MS}. Only
     * `disableCcProtection` passes one; every provisioning call site takes the
     * default, and a new one should have to say why it does not.
     */
    transientGraceMs: number = this.POLL_TRANSIENT_GRACE_MS
  ): Promise<ProgressEvent> {
    const startTime = Date.now();
    let attempts = 0;
    let pollInterval = this.INITIAL_POLL_INTERVAL_MS;
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
          return progressEvent;

        case 'FAILED': {
          const failureMessage = progressEvent.StatusMessage || 'Unknown error';
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
          throw new ProvisioningError(
            `${operation} cancelled for ${logicalId}`,
            progressEvent.TypeName || 'Unknown',
            logicalId,
            progressEvent.Identifier
          );

        case 'IN_PROGRESS':
        case 'PENDING':
          // Exponential backoff with 1.5x multiplier for flatter curve:
          // 1s → 1.5s → 2.25s → 3.4s → 5s → 7.5s → 10s (capped)
          // Most CC API operations complete in 1-5s, so slower ramp-up
          // polls more frequently during the common case.
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
  private async abandonWait(
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
        ? 'cdkd has NO state record for it, so any resource it creates is untracked by rollback and by cdkd destroy'
        : operation === 'DELETE'
          ? 'the resource may or may not have been removed; its state record is kept so a re-run can finish the delete'
          : 'its state record still holds the PREVIOUS properties, so the record may no longer describe the live resource';

    const error = new CloudControlWaitAbandonedError(
      `${operation} of ${logicalId} was accepted by Cloud Control API, but cdkd stopped waiting for it ` +
        // The identifier clause goes BEFORE the command, never after it: glued
        // on afterwards it rendered on the SAME line as the pasteable command,
        // so a template-chosen identifier sat inside what reads as a shell
        // line while taking only sanitize — one of the three steps
        // `replacement-protection-advice.ts` requires, with no quote and no
        // suppress. Putting it ahead means the command is the last thing on
        // its line and nothing user-chosen follows it.
        `(${reason}${causeText}). The operation may still be running in AWS, and ${consequence}.` +
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
  private async buildResumeCommand(requestToken: string): Promise<string> {
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
    return `aws cloudcontrol get-resource-request-status --request-token ${shellQuote(safeToken)}${regionFlag}`;
  }

  /**
   * Parse resource model JSON string.
   *
   * On a parse failure the WARN line logs the error's CLASS plus the model's
   * SHAPE. The `debug` line beside it DOES carry the raw parser message, echo
   * included, and naming that carve-out is the point (issue
   * [#3290](https://github.com/go-to-k/cdkd/issues/3290)): an unqualified
   * promise that a sibling line falsifies is exactly what that issue was filed
   * for. What follows is about the WARN line — never its
   * body (issue #1908, a GHSA-p5qg-v9gv-hc7w residual). The model is an AWS
   * readback, and a read handler cannot return write-only properties (the #809
   * premise), so the common secret shapes are absent — but a `{{resolve:...}}`
   * secret resolved into a NON-write-only property can round-trip back here,
   * and the previous `Raw model: <first 500 chars>` line would have printed it.
   * Truncation is not a mitigation: 500 characters is precisely where a
   * document's leading values sit.
   *
   * KEY NAMES are logged and values are not, which is the whole distinction —
   * a key is a property name from the type's schema, a value is the data. That
   * keeps the line diagnostic (it says WHICH document failed to parse) without
   * carrying anything sensitive.
   */
  private parseResourceModel(resourceModel: string): Record<string, unknown> {
    try {
      return JSON.parse(resourceModel) as Record<string, unknown>;
    } catch (error) {
      // The error's CLASS, never its message (issue go-to-k/cdkd#3290). The
      // comment above promises this line carries the model's SHAPE and not its
      // body, and `JSON.parse`'s own message breaks that promise: V8 ECHOES the
      // input around the failure point. Measured on Node 24 —
      // `JSON.parse('{"pw": hunter2SuperSecretValue}')` answers
      // `Unexpected token 'h', "{"pw": hunter2Sup"... is not valid JSON`, so
      // roughly thirty characters of the model reach a WARN line, i.e. default
      // verbosity. `describeAwsFailure` is the same instrument `abandonWait`
      // uses, and the `Model shape:` clause below already carries the
      // diagnosis this line exists for — WHICH document failed to parse.
      const described = describeAwsFailure(error);
      this.logger.warn(
        `Failed to parse resource model: ${described.redacted ? described.summary : error instanceof Error ? error.name : 'Error'}\n` +
          `Model shape: ${resourceModel.length} chars, ${describeJsonKeys(resourceModel)}`
      );
      this.logger.debug(`Resource model parse failure detail: ${displaySafe(described.detail)}`);
      return {};
    }
  }

  /**
   * Account info for an ARN / URI this provider SYNTHESIZES and records, or
   * `undefined` when it must not be built (issue
   * [#1730](https://github.com/go-to-k/cdkd/issues/1730)).
   *
   * `getAccountInfo` falls back to a hardcoded `123456789012` when STS cannot
   * answer, and an ARN built from it is structurally valid with no wildcard in
   * any field — so `isPlaceholderArn` (issue #1681) cannot catch it and every
   * downstream consumer receives a confidently wrong value that is then
   * RECORDED into state as the resource's `Fn::GetAtt` answer.
   *
   * Omitting the attribute is the honest answer and mirrors
   * `AppSyncProvider.childImportAttributes`: the resolver's own
   * `guardedPhysicalIdFallback` then hard-fails an `*Arn` read with a message
   * naming the cause, instead of a green deploy shipping an ARN for someone
   * else's account, and the record heals on the resource's next update.
   */
  private async accountInfoForSynthesizedArn(
    resourceType: string,
    attributeName: string,
    physicalId: string
  ): Promise<AwsAccountInfo | undefined> {
    // The provider's OWN region, not the ambient one. `getAccountInfo()` with no
    // override resolves `process.env['AWS_REGION']`, which `deploy` mutates
    // globally while stacks run concurrently (`--stack-concurrency`, default 4)
    // — so a multi-region deploy could synthesize an ARN carrying a sibling
    // stack's region. Before issue #1746 this call inherited whichever region
    // the FIRST caller cached, which was wrong in a different way; passing the
    // client's region is the answer that is right under both.
    const accountInfo = await getAccountInfo(await this.cloudControlClient.config.region());
    if (accountInfo.fabricated) {
      this.logger.warn(
        `Not enriching ${resourceType} ${attributeName} for ${physicalId}: STS did not report ` +
          `this deploy's account id, so the value would be built from a placeholder account and ` +
          `would be indistinguishable from a real one. Fix the credentials (or set ` +
          `AWS_ACCOUNT_ID) and deploy again — the record heals on the next update.`
      );
      return undefined;
    }
    return accountInfo;
  }

  /**
   * Enrich resource attributes with computed values
   *
   * This method adds fallback attributes for edge cases where CC API
   * may not return certain values.
   *
   * It passes every other key through AS-IS, and on the CREATE / UPDATE path
   * that bag is still the WHOLE resource model. This comment used to justify
   * that by saying the model's property names match `Fn::GetAtt` attribute
   * names; they do not — the model is every readable property, and
   * CloudFormation rejects a `Fn::GetAtt` naming a writable one. Issue
   * [#2847](https://github.com/go-to-k/cdkd/issues/2847) narrowed the IMPORT
   * path for that reason; the deploy path is issue
   * [#2925](https://github.com/go-to-k/cdkd/issues/2925), which also carries
   * why the same narrowing cannot simply be copied here.
   */
  private async enrichResourceAttributes(
    resourceType: string,
    physicalId: string,
    attributes: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const enriched: Record<string, unknown> = { ...attributes };

    // Fallback: compute attributes that CC API may not return
    switch (resourceType) {
      case 'AWS::S3::Bucket':
        // S3 bucket ARN: arn:aws:s3:::bucket-name
        if (!enriched['Arn']) {
          enriched['Arn'] = `arn:aws:s3:::${physicalId}`;
        }
        break;

      case 'AWS::RDS::DBCluster':
        // Issue #381: CC API's progressEvent.ResourceModel for RDS DBCluster
        // doesn't reliably surface Endpoint / Port / ReaderEndpoint until
        // the cluster reaches `available` AND a writer instance attaches.
        // Even when it does surface them, the shape is `Endpoint: <string>`
        // (NOT nested `Endpoint: { Address, Port }` as the CFn schema would
        // suggest). CDK's `Connections.allowDefaultPortFrom(...)` emits
        // `AWS::EC2::SecurityGroupIngress` rules with
        // `Fn::GetAtt: [<Cluster>, 'Endpoint.Port']` — pre-fix the resolver
        // fell through to `physicalId` and AWS rejected with
        // `Invalid integer value <cluster-id>`. Match the SDK provider's
        // flat-key shape (`'Endpoint.Port': '3306'`, `'Endpoint.Address':
        // '...'`, `'ReadEndpoint.Address': '...'`) by calling
        // `DescribeDBClusters` once after create and overlaying the
        // flat-key attributes. Best-effort: a failed Describe (e.g.
        // permissions gap) falls back to the unchanged CC-API attribute
        // shape, and `Fn::GetAtt` consumers will then hit the resolver's
        // own nested-path walk (Issue #381 part 1, same PR) — which still
        // misses for the not-nested-object case but at least doesn't
        // crash. The double-defence is intentional: enrichment populates
        // the canonical shape for the happy path; the resolver fallback
        // catches CC-API responses that DO have nested objects.
        try {
          // CC API client uses the cdkd-resolved region; the RDSClient
          // inherits via env / profile, same as DynamoDB / API Gateway
          // enrichment branches above.
          const rdsClient = new RDSClient({ ...awsClientDefaults() });
          const describeResponse = await rdsClient.send(
            new DescribeDBClustersCommand({ DBClusterIdentifier: physicalId })
          );
          const cluster = describeResponse.DBClusters?.[0];
          if (cluster) {
            if (cluster.Endpoint) enriched['Endpoint.Address'] = cluster.Endpoint;
            if (cluster.Port !== undefined) enriched['Endpoint.Port'] = String(cluster.Port);
            if (cluster.ReaderEndpoint) enriched['ReadEndpoint.Address'] = cluster.ReaderEndpoint;
            if (cluster.DBClusterArn) enriched['Arn'] = cluster.DBClusterArn;
            if (cluster.DbClusterResourceId) {
              enriched['DBClusterResourceId'] = cluster.DbClusterResourceId;
            }
            this.logger.debug(
              `Enriched RDS DBCluster ${physicalId} with Endpoint/Port/Arn from DescribeDBClusters`
            );
          }
        } catch (error) {
          // Best-effort: a failed Describe shouldn't fail the deploy.
          // The resolver's nested-path walk is the second line of defence.
          this.logger.debug(
            `Failed to enrich RDS DBCluster ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        break;

      case 'AWS::RDS::DBInstance':
        // Sibling of the DBCluster branch above: a DBInstance whose template
        // sets a silent-drop top-level property (BackupRetentionPeriod /
        // CopyTagsToSnapshot / MultiAZ / PubliclyAccessible / StorageType /
        // etc. — see the `AWS::RDS::DBInstance` silentDrop set in
        // property-coverage.generated.ts) is routed entirely through CC API
        // by the #614 silent-drop routing rule, which bypasses
        // RDSProvider.create — so the flat-key `Endpoint.Address` /
        // `Endpoint.Port` attributes the SDK provider would have populated
        // never get set, and `Fn::GetAtt(<DBInstance>, 'Endpoint.Address')`
        // falls through the resolver's constructAttribute branch to
        // `physicalId` (the DB identifier, not the endpoint hostname).
        // SHAPE DIFFERENCE vs the DBCluster case: DescribeDBInstances returns
        // `Endpoint` as a NESTED object `{ Address, Port, HostedZoneId }`
        // (NOT a flat string like DBCluster's `Endpoint`). Flatten it into
        // the SDK provider's flat-key attribute shape so consumers resolve.
        // Best-effort: a failed Describe (e.g. permissions gap) leaves the
        // CC-API attribute shape unchanged and must not fail the deploy.
        try {
          // The RDSClient inherits the cdkd-resolved region via env / profile,
          // same as the DBCluster / DynamoDB / API Gateway branches.
          const rdsClient = new RDSClient({ ...awsClientDefaults() });
          const describeResponse = await rdsClient.send(
            new DescribeDBInstancesCommand({ DBInstanceIdentifier: physicalId })
          );
          const inst = describeResponse.DBInstances?.[0];
          if (inst) {
            if (inst.Endpoint?.Address) enriched['Endpoint.Address'] = inst.Endpoint.Address;
            if (inst.Endpoint?.Port !== undefined) {
              enriched['Endpoint.Port'] = String(inst.Endpoint.Port);
            }
            if (inst.Endpoint?.HostedZoneId) {
              enriched['Endpoint.HostedZoneId'] = inst.Endpoint.HostedZoneId;
            }
            if (inst.DBInstanceArn) enriched['Arn'] = inst.DBInstanceArn;
            this.logger.debug(
              `Enriched RDS DBInstance ${physicalId} with Endpoint/Port/Arn from DescribeDBInstances`
            );
          }
        } catch (error) {
          // Best-effort: a failed Describe shouldn't fail the deploy.
          this.logger.debug(
            `Failed to enrich RDS DBInstance ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        break;

      case 'AWS::DynamoDB::Table':
        // Fallback: CC API GetResource may not include StreamArn when streams are enabled.
        // Call DescribeTable to retrieve LatestStreamArn if not already present.
        if (!enriched['StreamArn']) {
          try {
            const dynamoDBClient = getAwsClients().dynamoDB;
            const describeResponse = await dynamoDBClient.send(
              new DescribeTableCommand({ TableName: physicalId })
            );
            const latestStreamArn = describeResponse.Table?.LatestStreamArn;
            if (latestStreamArn) {
              enriched['StreamArn'] = latestStreamArn;
              this.logger.debug(
                `Enriched DynamoDB StreamArn for ${physicalId}: ${latestStreamArn}`
              );
            }
          } catch (error) {
            // Best-effort: don't fail the operation if DescribeTable fails
            this.logger.debug(
              `Failed to get DynamoDB StreamArn for ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        break;

      case 'AWS::ApiGateway::RestApi':
        // Fallback: ensure RootResourceId is present.
        // CC API GetResource typically returns it, but retrieve via SDK if missing.
        if (!enriched['RootResourceId']) {
          try {
            const apiGatewayClient = getAwsClients().apiGateway;
            const getRestApiResponse = await apiGatewayClient.send(
              new GetRestApiCommand({ restApiId: physicalId })
            );
            if (getRestApiResponse.rootResourceId) {
              enriched['RootResourceId'] = getRestApiResponse.rootResourceId;
              this.logger.debug(
                `Enriched RestApi RootResourceId for ${physicalId}: ${getRestApiResponse.rootResourceId}`
              );
            }
          } catch (error) {
            // Best-effort: don't fail the operation if GetRestApi fails
            this.logger.debug(
              `Failed to get RestApi RootResourceId for ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        // Ensure RestApiId is set (physical ID is the rest-api-id)
        if (!enriched['RestApiId']) {
          enriched['RestApiId'] = physicalId;
        }
        break;

      case 'AWS::CloudFront::CloudFrontOriginAccessIdentity':
        // Fallback: ensure S3CanonicalUserId is present.
        // CC API GetResource typically returns it, but retrieve via SDK if missing.
        if (!enriched['S3CanonicalUserId']) {
          try {
            const cloudFrontClient = getAwsClients().cloudFront;
            const oaiResponse = await cloudFrontClient.send(
              new GetCloudFrontOriginAccessIdentityCommand({ Id: physicalId })
            );
            const s3CanonicalUserId = oaiResponse.CloudFrontOriginAccessIdentity?.S3CanonicalUserId;
            if (s3CanonicalUserId) {
              enriched['S3CanonicalUserId'] = s3CanonicalUserId;
              this.logger.debug(
                `Enriched CloudFront OAI S3CanonicalUserId for ${physicalId}: ${s3CanonicalUserId}`
              );
            }
          } catch (error) {
            // Best-effort: don't fail the operation
            this.logger.debug(
              `Failed to get CloudFront OAI S3CanonicalUserId for ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        break;

      case 'AWS::KMS::Key':
        // CC API may not return Arn in ResourceModel.
        // Physical ID is the KeyId (UUID), so construct the ARN.
        if (!enriched['Arn']) {
          try {
            const kmsAccountInfo = await this.accountInfoForSynthesizedArn(
              resourceType,
              'Arn',
              physicalId
            );
            if (kmsAccountInfo) {
              // The region segment is FOLDED (issue #1850). The SOURCE folds too
              // (`effectiveAccountInfoRegion`, issue #1882), so this is defense
              // in depth rather than the only fold; both are kept, since
              // double-folding is a no-op. An earlier revision called
              // `accountInfo.region` "whatever spelling the caller supplied" and
              // said `cdkd deploy --region US-EAST-1` is REACHABLE because DNS
              // is case-insensitive "and the deploy SUCCEEDS" -- both false, and
              // corrected here with issue #1882's measurement: `foldRegionOption`
              // makes the flag canonical at every handler's entry (issue #2065),
              // so a raw spelling never gets that far, and SigV4 would refuse it
              // if it did. What IS reachable is a Cloud Assembly carrying a raw
              // region, whose clients cdkd folds. Unfolded, cdkd would record
              // `arn:aws:kms:US-EAST-1:...`, which no IAM policy matches
              // (policy matching IS case-sensitive) and every SDK call taking the
              // ARN rejects. The value is persisted into state.json, so it is
              // also what every later `Fn::GetAtt` / `cdkd drift` reads. The
              // PARTITION needs no fold — `derivePartitionAndUrlSuffix`
              // canonicalizes its own input (issue #1795) — and double-folding is
              // a no-op, which is what makes the two safe side by side.
              enriched['Arn'] =
                `arn:${kmsAccountInfo.partition}:kms:${canonicalizeRegion(kmsAccountInfo.region)}:${kmsAccountInfo.accountId}:key/${physicalId}`;
              this.logger.debug(
                `Enriched KMS Key Arn for ${physicalId}: ${String(enriched['Arn'])}`
              );
            }
          } catch (error) {
            this.logger.debug(
              `Failed to construct KMS Key Arn for ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        if (!enriched['KeyId']) {
          enriched['KeyId'] = physicalId;
        }
        break;

      case 'AWS::CloudFront::OriginAccessControl':
        // CC API physicalId is the OAC ID
        if (!enriched['Id']) enriched['Id'] = physicalId;
        break;

      case 'AWS::Route53::HealthCheck':
        // CC API physicalId is the HealthCheck ID
        if (!enriched['HealthCheckId']) enriched['HealthCheckId'] = physicalId;
        break;

      case 'AWS::ECR::Repository':
        // CC API physicalId is the repository name, construct ARN
        if (!enriched['Arn']) {
          try {
            const ecrAccountInfo = await this.accountInfoForSynthesizedArn(
              resourceType,
              'Arn',
              physicalId
            );
            if (ecrAccountInfo) {
              // Region segment folded — see the KMS Key branch above (issue #1850).
              enriched['Arn'] =
                `arn:${ecrAccountInfo.partition}:ecr:${canonicalizeRegion(ecrAccountInfo.region)}:${ecrAccountInfo.accountId}:repository/${physicalId}`;
              this.logger.debug(
                `Enriched ECR Repository Arn for ${physicalId}: ${String(enriched['Arn'])}`
              );
            }
          } catch (error) {
            this.logger.debug(
              `Failed to construct ECR Repository Arn: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        if (!enriched['RepositoryUri']) {
          try {
            const ecrAccountInfo = await this.accountInfoForSynthesizedArn(
              resourceType,
              'RepositoryUri',
              physicalId
            );
            if (ecrAccountInfo) {
              // URL suffix derived, not hardcoded — `amazonaws.com.cn` in
              // `aws-cn` (issue #1730 review); mirrors the resolver's own
              // `RepositoryUri` branch so the two cannot disagree. That parity
              // is what issue #1850 had to RESTORE rather than assume: folding
              // the region here alone would have made the two disagree for an
              // upper-cased region, so the resolver folds at its own
              // `constructAttribute` destructure in the same change.
              //
              // The region label is FOLDED for the same reason the ARNs above are
              // (issue #1850), and this is the site where it matters MOST: the
              // recorded URI is handed to `docker` and parsed back by
              // `parseEcrRegistryHost` (`src/utils/ecr-uri.ts`), whose own
              // canonical-segment guards are what an upper-cased label has to get
              // past. Recording the canonical spelling is the half of that story
              // cdkd owns.
              const { urlSuffix } = derivePartitionAndUrlSuffix(ecrAccountInfo.region);
              enriched['RepositoryUri'] =
                `${ecrAccountInfo.accountId}.dkr.ecr.${canonicalizeRegion(ecrAccountInfo.region)}.${urlSuffix}/${physicalId}`;
            }
          } catch {
            /* best effort */
          }
        }
        break;

      case 'AWS::EC2::EIP':
        // CC API returns composite physicalId: "PublicIp|AllocationId"
        // Extract individual attributes for Fn::GetAtt resolution
        if (physicalId.includes('|')) {
          const [publicIp, allocationId] = physicalId.split('|');
          if (!enriched['AllocationId']) enriched['AllocationId'] = allocationId;
          if (!enriched['PublicIp']) enriched['PublicIp'] = publicIp;
          this.logger.debug(
            `Enriched EIP attributes: AllocationId=${allocationId}, PublicIp=${publicIp}`
          );
        }
        break;

      case 'AWS::Lambda::Version':
        // CC API physicalId for Lambda Version is the full version ARN
        // (e.g., arn:aws:lambda:us-east-1:123456:function:MyFunc:1).
        // Lambda::Alias FunctionVersion property needs just the version number.
        if (!enriched['Version']) {
          const versionSegments = physicalId.split(':');
          const versionNumber = versionSegments[versionSegments.length - 1];
          enriched['Version'] = versionNumber;
          this.logger.debug(`Enriched Lambda Version for ${physicalId}: ${versionNumber}`);
        }
        break;

      case 'AWS::Kinesis::Stream':
        // CC API physicalId for Kinesis Stream is the stream name, not the ARN.
        // Fn::GetAtt [Stream, Arn] needs the full ARN.
        if (!enriched['Arn']) {
          try {
            const kinesisAccountInfo = await this.accountInfoForSynthesizedArn(
              resourceType,
              'Arn',
              physicalId
            );
            if (kinesisAccountInfo) {
              // Region segment folded — see the KMS Key branch above (issue #1850).
              enriched['Arn'] =
                `arn:${kinesisAccountInfo.partition}:kinesis:${canonicalizeRegion(kinesisAccountInfo.region)}:${kinesisAccountInfo.accountId}:stream/${physicalId}`;
              this.logger.debug(
                `Enriched Kinesis Stream Arn for ${physicalId}: ${String(enriched['Arn'])}`
              );
            }
          } catch (error) {
            this.logger.debug(
              `Failed to construct Kinesis Stream Arn for ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        break;

      case 'AWS::Lambda::Url':
        // CC API CREATE response may not include FunctionUrl in ResourceModel.
        // Use Lambda SDK to retrieve it for Fn::GetAtt resolution.
        if (!enriched['FunctionUrl']) {
          try {
            const lambdaClient = getAwsClients().lambda;
            // physicalId is the FunctionArn for Lambda URL
            const urlConfig = await lambdaClient.send(
              new GetFunctionUrlConfigCommand({ FunctionName: physicalId })
            );
            if (urlConfig.FunctionUrl) {
              enriched['FunctionUrl'] = urlConfig.FunctionUrl;
              this.logger.debug(
                `Enriched Lambda URL FunctionUrl for ${physicalId}: ${urlConfig.FunctionUrl}`
              );
            }
            if (urlConfig.FunctionArn) {
              enriched['FunctionArn'] = urlConfig.FunctionArn;
            }
          } catch (error) {
            this.logger.debug(
              `Failed to get Lambda URL config for ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        break;

      case 'AWS::Events::Connection':
        // AWS::Events::Connection has NO SDK provider, so it always routes
        // through Cloud Control. Its primaryIdentifier is `Name`, so the CC API
        // physicalId is the connection NAME, not the ARN. The readOnly
        // attributes `Arn` / `SecretArn` / `ArnForPolicy` therefore fall through
        // the resolver's `constructAttribute` to the physicalId (the name) — and
        // a downstream `AWS::Events::ApiDestination` whose `ConnectionArn` is
        // `Fn::GetAtt(<Connection>, 'Arn')` (the canonical CDK shape) gets the
        // bare name instead of an ARN, so the ApiDestination CREATE fails CC
        // model validation (`#/ConnectionArn: failed validation constraint for
        // keyword [pattern]`). The full connection ARN carries a random unique
        // suffix (`.../connection/<name>/<uuid>`) so it cannot be constructed
        // from account + region + name; call DescribeConnection to recover it.
        // Best-effort: a failed Describe leaves the CC-API attribute shape
        // unchanged and must not fail the deploy. Same enrichment-gap bug class
        // as #844 / #864 / #865 / #866.
        if (!enriched['Arn'] || !enriched['SecretArn'] || !enriched['ArnForPolicy']) {
          try {
            const eventBridgeClient = getAwsClients().eventBridge;
            const conn = await eventBridgeClient.send(
              new DescribeConnectionCommand({ Name: physicalId })
            );
            if (conn.ConnectionArn) {
              if (!enriched['Arn']) enriched['Arn'] = conn.ConnectionArn;
              // ArnForPolicy is the connection ARN WITHOUT the trailing unique
              // suffix (`arn:...:connection/<name>`), used in IAM policies.
              // DescribeConnection does not return it, so derive it from the
              // full ARN by stripping the last `/<segment>`.
              if (!enriched['ArnForPolicy']) {
                const lastSlash = conn.ConnectionArn.lastIndexOf('/');
                if (lastSlash > 0) {
                  enriched['ArnForPolicy'] = conn.ConnectionArn.slice(0, lastSlash);
                }
              }
            }
            if (conn.SecretArn && !enriched['SecretArn']) {
              enriched['SecretArn'] = conn.SecretArn;
            }
            this.logger.debug(
              `Enriched Events Connection ${physicalId} with Arn/SecretArn/ArnForPolicy from DescribeConnection`
            );
          } catch (error) {
            this.logger.debug(
              `Failed to enrich Events Connection ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        break;

      case 'AWS::Events::ApiDestination':
        // Sibling of the Events::Connection case: ApiDestination's
        // primaryIdentifier is `Name`, so the CC physicalId is the name and the
        // readOnly `Arn` / `ArnForPolicy` attributes fall through to it. An
        // `AWS::Events::Rule` target referencing the ApiDestination by
        // `Fn::GetAtt(<ApiDestination>, 'Arn')` would otherwise get the bare
        // name. The full ARN carries a unique suffix, so call
        // DescribeApiDestination to recover it. Best-effort.
        if (!enriched['Arn'] || !enriched['ArnForPolicy']) {
          try {
            const eventBridgeClient = getAwsClients().eventBridge;
            const dest = await eventBridgeClient.send(
              new DescribeApiDestinationCommand({ Name: physicalId })
            );
            if (dest.ApiDestinationArn) {
              if (!enriched['Arn']) enriched['Arn'] = dest.ApiDestinationArn;
              if (!enriched['ArnForPolicy']) {
                const lastSlash = dest.ApiDestinationArn.lastIndexOf('/');
                if (lastSlash > 0) {
                  enriched['ArnForPolicy'] = dest.ApiDestinationArn.slice(0, lastSlash);
                }
              }
            }
            this.logger.debug(
              `Enriched Events ApiDestination ${physicalId} with Arn/ArnForPolicy from DescribeApiDestination`
            );
          } catch (error) {
            this.logger.debug(
              `Failed to enrich Events ApiDestination ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        break;

      case 'AWS::ElastiCache::ReplicationGroup': {
        // ElastiCache ReplicationGroup has NO SDK provider, so it always routes
        // through Cloud Control — and the CC API GetResource model does not
        // surface the connection endpoints in the flat-key shape cdkd's
        // intrinsic resolver expects. `Fn::GetAtt(<RG>, 'PrimaryEndPoint.Address')`
        // (and the Reader / Configuration variants) would otherwise fall through
        // the resolver's `constructAttribute` to `physicalId` (the replication-
        // group id, NOT the Redis hostname), so a security-group rule / client
        // connection string built from it points at garbage.
        //
        // SHAPE NOTE: the CFn return-value attribute names use capital-P
        // `EndPoint` (`PrimaryEndPoint.Address`, `ReaderEndPoint.Address`,
        // `ConfigurationEndPoint.Address`, `ReadEndPoint.Addresses` list) while
        // the AWS SDK fields are `Endpoint` (lower p) on
        // `NodeGroups[].PrimaryEndpoint` / `NodeGroups[].ReaderEndpoint` and the
        // top-level `ConfigurationEndpoint` (cluster-mode). We populate the
        // flat-keys with the CFn casing so the resolver finds them.
        // Best-effort: a failed Describe leaves the CC-API attribute shape
        // unchanged and must not fail the deploy.
        try {
          const elastiCacheClient = new ElastiCacheClient({ ...awsClientDefaults() });
          const describeResponse = await elastiCacheClient.send(
            new DescribeReplicationGroupsCommand({ ReplicationGroupId: physicalId })
          );
          const rg = describeResponse.ReplicationGroups?.[0];
          if (rg) {
            // Cluster-mode-disabled: NodeGroups[0] carries the primary/reader.
            const primaryNode = rg.NodeGroups?.[0];
            if (primaryNode?.PrimaryEndpoint?.Address) {
              enriched['PrimaryEndPoint.Address'] = primaryNode.PrimaryEndpoint.Address;
            }
            if (primaryNode?.PrimaryEndpoint?.Port !== undefined) {
              enriched['PrimaryEndPoint.Port'] = String(primaryNode.PrimaryEndpoint.Port);
            }
            if (primaryNode?.ReaderEndpoint?.Address) {
              enriched['ReaderEndPoint.Address'] = primaryNode.ReaderEndpoint.Address;
            }
            if (primaryNode?.ReaderEndpoint?.Port !== undefined) {
              enriched['ReaderEndPoint.Port'] = String(primaryNode.ReaderEndpoint.Port);
            }
            // Cluster-mode-enabled: a single ConfigurationEndpoint fronts all shards.
            if (rg.ConfigurationEndpoint?.Address) {
              enriched['ConfigurationEndPoint.Address'] = rg.ConfigurationEndpoint.Address;
            }
            if (rg.ConfigurationEndpoint?.Port !== undefined) {
              enriched['ConfigurationEndPoint.Port'] = String(rg.ConfigurationEndpoint.Port);
            }
            // ReadEndPoint.Addresses / .Ports are CFn comma-delimited LIST
            // attributes covering the read-capable endpoints. Per the CFn
            // return-value docs these list "the primary and the read-only
            // replicas", so collect BOTH the primary and reader endpoint of
            // every node group (a reader-only list would be empty for a
            // single-node cluster-mode-disabled RG, diverging from CFn).
            const readEndpoints = (rg.NodeGroups ?? []).flatMap((ng) => [
              ng.PrimaryEndpoint,
              ng.ReaderEndpoint,
            ]);
            const readAddrs = readEndpoints
              .map((ep) => ep?.Address)
              .filter((a): a is string => typeof a === 'string' && a.length > 0);
            const readPorts = readEndpoints
              .map((ep) => ep?.Port)
              .filter((p): p is number => p !== undefined);
            if (readAddrs.length > 0) {
              enriched['ReadEndPoint.Addresses'] = readAddrs.join(',');
            }
            if (readPorts.length > 0) {
              enriched['ReadEndPoint.Ports'] = readPorts.map(String).join(',');
            }
            this.logger.debug(
              `Enriched ElastiCache ReplicationGroup ${physicalId} with endpoint attributes from DescribeReplicationGroups`
            );
          }
        } catch (error) {
          this.logger.debug(
            `Failed to enrich ElastiCache ReplicationGroup ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        break;
      }

      case 'AWS::Redshift::Cluster': {
        // Redshift Cluster has no SDK provider, so it always routes through
        // Cloud Control. The CC API GetResource model does not reliably surface
        // the cluster endpoint, so `Fn::GetAtt(<Cluster>, 'Endpoint.Address')` /
        // `Endpoint.Port` (the JDBC/ODBC connection coordinates) would fall
        // through the resolver's constructAttribute to the physicalId (the
        // cluster identifier, NOT the endpoint hostname). Overlay the flat-key
        // Endpoint.Address / Endpoint.Port from DescribeClusters. The SDK
        // `Cluster.Endpoint` object uses the SAME `Endpoint.Address` /
        // `Endpoint.Port` names as the CFn return values (no casing quirk,
        // unlike ElastiCache). Best-effort: a failed Describe leaves the CC-API
        // attribute shape unchanged and never fails the deploy.
        try {
          const redshiftClient = new RedshiftClient({ ...awsClientDefaults() });
          const describeResponse = await redshiftClient.send(
            new DescribeClustersCommand({ ClusterIdentifier: physicalId })
          );
          const cluster = describeResponse.Clusters?.[0];
          if (cluster?.Endpoint) {
            if (cluster.Endpoint.Address) {
              enriched['Endpoint.Address'] = cluster.Endpoint.Address;
            }
            if (cluster.Endpoint.Port !== undefined) {
              enriched['Endpoint.Port'] = String(cluster.Endpoint.Port);
            }
            this.logger.debug(
              `Enriched Redshift Cluster ${physicalId} with Endpoint.Address/Port from DescribeClusters`
            );
          }
        } catch (error) {
          this.logger.debug(
            `Failed to enrich Redshift Cluster ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        break;
      }

      case 'AWS::OpenSearchService::Domain': {
        // OpenSearch Service Domain has no SDK provider, so it always routes
        // through Cloud Control. The CC API GetResource model does not surface
        // the search endpoint / ARN in the flat-key shape cdkd's intrinsic
        // resolver expects, so `Fn::GetAtt(<Domain>, 'DomainEndpoint')` (the
        // https://search-... URL clients connect to) and
        // `Fn::GetAtt(<Domain>, 'Arn')` / 'DomainArn' would fall through the
        // resolver's constructAttribute to the physicalId (the domain NAME,
        // NOT the endpoint hostname / ARN). Overlay them from DescribeDomain.
        //
        // SHAPE NOTE: the CFn return-value names are `DomainEndpoint` (single,
        // public access) / `DomainEndpoints` (map, e.g. { vpc: '...' } for
        // VPC-deployed domains) / `Arn` (and the alias `DomainArn`) / `Id`.
        // The SDK `DomainStatus` fields are `Endpoint` (public) / `Endpoints`
        // (map) / `ARN` / `DomainId`. We populate the flat-keys with the CFn
        // names so the resolver finds them; for a VPC domain (no public
        // `Endpoint`) we fall back to the `vpc` entry of the `Endpoints` map.
        // Best-effort: a failed Describe leaves the CC-API attribute shape
        // unchanged and never fails the deploy.
        try {
          const openSearchClient = new OpenSearchClient({ ...awsClientDefaults() });
          const describeResponse = await openSearchClient.send(
            new DescribeDomainCommand({ DomainName: physicalId })
          );
          const domain = describeResponse.DomainStatus;
          if (domain) {
            const endpoint = domain.Endpoint ?? domain.Endpoints?.['vpc'];
            if (endpoint) {
              enriched['DomainEndpoint'] = endpoint;
            }
            if (domain.ARN) {
              enriched['Arn'] = domain.ARN;
              enriched['DomainArn'] = domain.ARN;
            }
            if (domain.DomainId) {
              enriched['Id'] = domain.DomainId;
            }
            this.logger.debug(
              `Enriched OpenSearch Domain ${physicalId} with DomainEndpoint/Arn from DescribeDomain`
            );
          }
        } catch (error) {
          this.logger.debug(
            `Failed to enrich OpenSearch Domain ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        break;
      }

      case 'AWS::Backup::BackupVault': {
        // Backup types have NO SDK provider, so they always route through
        // Cloud Control. The CC API CREATE response's ResourceModel is sparse
        // for Backup and does not reliably surface the vault ARN, so
        // `Fn::GetAtt(<Vault>, 'BackupVaultArn')` (the canonical CDK shape,
        // emitted by `vault.backupVaultArn`) would fall through the resolver's
        // constructAttribute to the physicalId — which for BackupVault is the
        // vault NAME, not the ARN. AWS then rejects a BackupPlan rule /
        // selection that references the bare name where an ARN is required.
        // Overlay the ARN from a CC GetResource read-back on the physicalId.
        // The read-back is gated SOLELY on the ARN (the one real computed
        // GetAtt target) — BackupVaultName has a cheap physicalId fallback
        // below and does not justify a read-back on its own. Best-effort: a
        // failed read leaves the CC-API attribute shape unchanged and never
        // fails the deploy.
        if (!enriched['BackupVaultArn']) {
          const model = await this.readCcResourceModel(resourceType, physicalId);
          if (model) {
            if (typeof model['BackupVaultArn'] === 'string') {
              enriched['BackupVaultArn'] = model['BackupVaultArn'];
            }
            // BackupVaultName Ref-return is the physicalId; surface it too so
            // Fn::GetAtt(<Vault>, 'BackupVaultName') resolves.
            if (!enriched['BackupVaultName'] && typeof model['BackupVaultName'] === 'string') {
              enriched['BackupVaultName'] = model['BackupVaultName'];
            }
            this.logger.debug(
              `Enriched Backup BackupVault ${physicalId} with BackupVaultArn from CC GetResource`
            );
          }
        }
        if (!enriched['BackupVaultName']) {
          enriched['BackupVaultName'] = physicalId;
        }
        break;
      }

      case 'AWS::Backup::BackupPlan': {
        // Sibling of the BackupVault branch: the CC CREATE ResourceModel does
        // not reliably surface the plan ARN / version id, so
        // `Fn::GetAtt(<Plan>, 'BackupPlanArn')` / `'VersionId'` fall through to
        // the physicalId (the BackupPlanId). Overlay both from a CC
        // GetResource read-back. Best-effort.
        if (!enriched['BackupPlanArn'] || !enriched['VersionId']) {
          const model = await this.readCcResourceModel(resourceType, physicalId);
          if (model) {
            if (!enriched['BackupPlanArn'] && typeof model['BackupPlanArn'] === 'string') {
              enriched['BackupPlanArn'] = model['BackupPlanArn'];
            }
            if (!enriched['VersionId'] && typeof model['VersionId'] === 'string') {
              enriched['VersionId'] = model['VersionId'];
            }
            if (!enriched['BackupPlanId'] && typeof model['BackupPlanId'] === 'string') {
              enriched['BackupPlanId'] = model['BackupPlanId'];
            }
            this.logger.debug(
              `Enriched Backup BackupPlan ${physicalId} with BackupPlanArn/VersionId from CC GetResource`
            );
          }
        }
        if (!enriched['BackupPlanId']) {
          enriched['BackupPlanId'] = physicalId;
        }
        break;
      }

      case 'AWS::Backup::BackupSelection': {
        // BackupSelection's CC primaryIdentifier is a single `Id` whose VALUE
        // is the compound `<SelectionId>_<BackupPlanId>` joined by an UNDERSCORE
        // (both segments are UUIDs, so `_` is unambiguous) — CFn's Ref returns
        // the SelectionId. `Fn::GetAtt(<Selection>, 'SelectionId')` would
        // otherwise fall through to the compound physicalId. Extract the
        // SelectionId from the compound id (before the first underscore) as a
        // best-effort fallback, and prefer the CC read-back model's value when
        // available (issue #995 corrected the separator from `|` to `_`).
        if (!enriched['SelectionId'] || !enriched['BackupPlanId']) {
          const firstUnderscore = physicalId.indexOf('_');
          if (firstUnderscore > 0) {
            if (!enriched['SelectionId']) {
              enriched['SelectionId'] = physicalId.substring(0, firstUnderscore);
            }
            if (!enriched['BackupPlanId']) {
              enriched['BackupPlanId'] = physicalId.substring(firstUnderscore + 1);
            }
          }
          const model = await this.readCcResourceModel(resourceType, physicalId);
          if (model) {
            if (typeof model['SelectionId'] === 'string') {
              enriched['SelectionId'] = model['SelectionId'];
            }
            if (typeof model['BackupPlanId'] === 'string') {
              enriched['BackupPlanId'] = model['BackupPlanId'];
            }
            this.logger.debug(
              `Enriched Backup BackupSelection ${physicalId} with SelectionId from CC GetResource`
            );
          }
        }
        break;
      }

      case 'AWS::Pipes::Pipe': {
        // Pipes has NO SDK provider, so it always routes through Cloud
        // Control, and the CC CREATE ResourceModel is sparse — it does not
        // surface the pipe ARN. `Fn::GetAtt(<Pipe>, 'Arn')` would fall
        // through the resolver's constructAttribute to the physicalId (the
        // pipe NAME), poisoning IAM policies / alarm actions / outputs that
        // need the ARN. Overlay the documented GetAtt attributes from a CC
        // GetResource read-back. Best-effort: a failed read leaves the
        // attribute shape unchanged and never fails the deploy. (issue #1103)
        if (!enriched['Arn']) {
          const model = await this.readCcResourceModel(resourceType, physicalId);
          if (model) {
            if (typeof model['Arn'] === 'string') {
              enriched['Arn'] = model['Arn'];
            }
            if (!enriched['CurrentState'] && typeof model['CurrentState'] === 'string') {
              enriched['CurrentState'] = model['CurrentState'];
            }
            if (!enriched['StateReason'] && typeof model['StateReason'] === 'string') {
              enriched['StateReason'] = model['StateReason'];
            }
            if (!enriched['CreationTime'] && typeof model['CreationTime'] === 'string') {
              enriched['CreationTime'] = model['CreationTime'];
            }
            if (!enriched['LastModifiedTime'] && typeof model['LastModifiedTime'] === 'string') {
              enriched['LastModifiedTime'] = model['LastModifiedTime'];
            }
            this.logger.debug(`Enriched Pipes Pipe ${physicalId} with Arn from CC GetResource`);
          }
        }
        break;
      }

      case 'AWS::S3::AccessPoint': {
        // Same class as the Pipes branch: the physicalId is the access point
        // NAME while Arn / Alias are readOnly attributes the sparse CREATE
        // ResourceModel omits. Alias is load-bearing for S3 data access (the
        // `...-s3alias` bucket-style name handed to S3 clients), so falling
        // back to the bare name breaks consumers silently. (issue #1103)
        if (!enriched['Arn'] || !enriched['Alias']) {
          const model = await this.readCcResourceModel(resourceType, physicalId);
          if (model) {
            if (!enriched['Arn'] && typeof model['Arn'] === 'string') {
              enriched['Arn'] = model['Arn'];
            }
            if (!enriched['Alias'] && typeof model['Alias'] === 'string') {
              enriched['Alias'] = model['Alias'];
            }
            if (!enriched['NetworkOrigin'] && typeof model['NetworkOrigin'] === 'string') {
              enriched['NetworkOrigin'] = model['NetworkOrigin'];
            }
            this.logger.debug(
              `Enriched S3 AccessPoint ${physicalId} with Arn/Alias from CC GetResource`
            );
          }
        }
        break;
      }

      case 'AWS::ResourceGroups::Group': {
        // Same class: the physicalId is the group NAME and Arn is the only
        // computed GetAtt attribute; the sparse CREATE ResourceModel omits
        // it, so the resolver would hand the bare name to consumers that
        // need the ARN (e.g. IAM policies). (issue #1103)
        if (!enriched['Arn']) {
          const model = await this.readCcResourceModel(resourceType, physicalId);
          if (model) {
            if (typeof model['Arn'] === 'string') {
              enriched['Arn'] = model['Arn'];
            }
            this.logger.debug(
              `Enriched ResourceGroups Group ${physicalId} with Arn from CC GetResource`
            );
          }
        }
        break;
      }

      default:
        break;
    }

    return enriched;
  }

  /**
   * Generic sparse-model read-back (issue #1105). When the CREATE / UPDATE
   * `ProgressEvent.ResourceModel` yielded a sparse attribute map, issue ONE
   * best-effort `GetResource` read-back and merge the returned model over the
   * parsed attributes. Closes the "pure-CC type with a sparse CREATE model →
   * empty state attributes → `Fn::GetAtt` silently resolves to the bare
   * physicalId" class generically instead of per-type (previously fixed
   * type-by-type in #984 / #1103). Runs BEFORE `enrichResourceAttributes` so
   * the per-type overlays' `if (!enriched['X'])` gating composes naturally
   * (no second GetResource for a type the read-back already filled).
   * Best-effort: a failed read-back leaves the attributes as-is and never
   * fails the deploy (same never-throw contract as `readCcResourceModel`).
   */
  private async mergeSparseModelReadback(
    resourceType: string,
    physicalId: string,
    attributes: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (!this.isSparseAttributeMap(attributes, physicalId)) {
      return attributes;
    }
    const model = await this.readCcResourceModel(resourceType, physicalId);
    if (!model) {
      return attributes;
    }
    this.logger.debug(
      `Merged CC GetResource read-back over sparse ${resourceType} attributes for ${physicalId}`
    );
    // Read-back wins: the sparseness predicate admits nothing beyond
    // identifier echoes, and on UPDATE the read-back is by definition fresher
    // than whatever the ProgressEvent omitted.
    return { ...attributes, ...model };
  }

  /**
   * Conservative sparseness predicate for `mergeSparseModelReadback`. A map
   * is sparse when it is empty or carries nothing beyond an echo of the
   * identifier — every value is a string equal to the physicalId or to one
   * segment of a compound `|`-joined CC primaryIdentifier. Sparseness is
   * empirically per-type: `AWS::ApiGatewayV2::Api` returns `ApiEndpoint` in
   * its CREATE model (NOT sparse — no extra GetResource), while Pipes /
   * S3 AccessPoint / ResourceGroups / Backup return nothing usable (sparse —
   * read-back fires). Any non-identifier value (a URL, an ARN, an echoed
   * input property, a nested object) means the model carried real
   * information, so we skip the extra API call.
   */
  private isSparseAttributeMap(attributes: Record<string, unknown>, physicalId: string): boolean {
    const values = Object.values(attributes);
    if (values.length === 0) {
      return true;
    }
    const identifierEchoes = new Set(physicalId.split('|'));
    identifierEchoes.add(physicalId);
    return values.every((value) => typeof value === 'string' && identifierEchoes.has(value));
  }

  /**
   * Read the Cloud Control GetResource model for a pure-CC resource and
   * return its parsed property map, or `undefined` on any failure. Types with
   * no SDK provider always route through Cloud Control, whose async CREATE
   * ResourceModel is sparse for several types, so this generic CC read-back is
   * the cleanest source of their readOnly attributes (ARNs, aliases,
   * VersionId, SelectionId) — the type's registry schema lists them under
   * readOnlyProperties, which the CC read handler does return. Originally
   * Backup-scoped (issue #984); generalized for Pipes / S3 AccessPoint /
   * ResourceGroups in issue #1103, and reused by the generic sparse-model
   * read-back (issue #1105). Best-effort: never throws.
   */
  private async readCcResourceModel(
    resourceType: string,
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await this.cloudControlClient.send(
        new GetResourceCommand({
          TypeName: resourceType,
          Identifier: physicalId,
        })
      );
      const raw = response.ResourceDescription?.Properties;
      if (typeof raw !== 'string' || raw.length === 0) {
        return undefined;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return undefined;
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      this.logger.debug(
        `Failed to read CC model for ${resourceType} ${physicalId}: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }

  /**
   * Handle errors and throw ProvisioningError
   */
  private handleError(
    error: unknown,
    operation: string,
    resourceType: string,
    logicalId: string,
    physicalId?: string
  ): never {
    const err = error as { name?: string; message?: string };

    // Check if resource type is not supported
    if (err.name === 'UnsupportedActionException' || err.name === 'TypeNotFoundException') {
      throw new ProvisioningError(
        `Resource type ${resourceType} is not supported by Cloud Control API and no SDK provider is registered.\n` +
          `Please report this issue at https://github.com/go-to-k/cdkd/issues so we can add SDK provider support.\n` +
          `Error: ${err.message || 'Unknown error'}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }

    // Re-throw if already a ProvisioningError
    if (error instanceof ProvisioningError) {
      throw error;
    }

    // Wrap other errors
    throw new ProvisioningError(
      `${operation} failed for ${logicalId}: ${err.message || 'Unknown error'}`,
      resourceType,
      logicalId,
      physicalId,
      error instanceof Error ? error : undefined
    );
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check if a resource type is supported by Cloud Control API
   *
   * This is a best-effort check. Some resource types may still fail
   * even if they appear to be supported.
   */
  static isSupportedResourceType(resourceType: string): boolean {
    // Common resource types that are NOT supported by Cloud Control API
    const unsupportedTypes = new Set([
      // IAM (most types not supported by Cloud Control; cdkd ships SDK
      // providers for these instead).
      'AWS::IAM::Role',
      'AWS::IAM::Policy',
      'AWS::IAM::User',
      'AWS::IAM::Group',
      'AWS::IAM::InstanceProfile',

      // Lambda layers
      'AWS::Lambda::LayerVersion',

      // S3 bucket policies (use SDK instead)
      'AWS::S3::BucketPolicy',

      // CloudFormation-specific resources
      'AWS::CloudFormation::Stack',
      'AWS::CloudFormation::WaitCondition',
      'AWS::CloudFormation::WaitConditionHandle',
      'AWS::CloudFormation::CustomResource',

      // CDK-specific resources
      'AWS::CDK::Metadata',
      'Custom::CDKBucketDeployment',
      'Custom::S3AutoDeleteObjects',

      // Route53 hosted zones (complex)
      'AWS::Route53::HostedZone',
    ]);

    if (unsupportedTypes.has(resourceType)) {
      return false;
    }

    // Custom resources are never supported by Cloud Control
    if (
      resourceType.startsWith('Custom::') ||
      resourceType.startsWith('AWS::CloudFormation::CustomResource')
    ) {
      return false;
    }

    // AWS-declared NON_PROVISIONABLE (provider-coverage tier3): AWS itself
    // reports that Cloud Control cannot create/update/delete these, and cdkd
    // has no SDK provider for them. Reject so pre-flight fails fast with an
    // actionable message instead of letting the optimistic fallthrough below
    // reach an opaque mid-deploy Cloud Control CreateResource failure.
    if (isNonProvisionable(resourceType)) {
      return false;
    }

    // Most other AWS:: resources should be supported
    // (This is optimistic; some may still fail)
    return resourceType.startsWith('AWS::');
  }

  /**
   * Read the AWS-current properties of a resource managed via Cloud Control
   * API, for `cdkd drift` comparison.
   *
   * Strategy: `GetResource(TypeName, Identifier)` returns `ResourceModel` as
   * a JSON string of every property AWS reports for the resource. Parse and
   * surface it as the AWS-current snapshot — the drift command intersects
   * this against the keys present in cdkd state, so AWS-only keys (timestamps,
   * generated ids, etc.) are filtered out at compare time.
   *
   * Returns `undefined` for the unique cases that mean "drift unknown" (the
   * resource was deleted out from under cdkd, or the response had no
   * Properties field). Re-throws on any other error so the drift command can
   * surface throttling / access-denied issues to the user.
   *
   * This single CC API implementation gives drift detection coverage to every
   * resource type that goes through CC API — the majority of cdkd's surface.
   * SDK Providers add their own `readCurrentState` incrementally (PR D).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await this.cloudControlClient.send(
        new GetResourceCommand({
          TypeName: resourceType,
          Identifier: physicalId,
        })
      );

      const raw = response.ResourceDescription?.Properties;
      if (typeof raw !== 'string' || raw.length === 0) {
        return undefined;
      }

      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return undefined;
      }

      return parsed as Record<string, unknown>;
    } catch (error) {
      const err = error as { name?: string };
      if (err.name === 'ResourceNotFoundException') {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Adopt an already-deployed resource into cdkd state via Cloud Control API.
   *
   * Strategy: explicit-override only.
   *   - With `knownPhysicalId` (from `--resource <id>=<physicalId>` or
   *     `--resource-mapping`): call `GetResource(TypeName, Identifier)`,
   *     parse `ResourceModel` (returned as a JSON string by CC API), and
   *     return the ATTRIBUTE keys as `attributes` — see
   *     {@link maskUncertifiedModelValues} for what "attribute" means here and
   *     why every other key comes back MASKED rather than dropped.
   *   - Without `knownPhysicalId`: return `null`. CC API has no efficient
   *     `aws:cdk:path`-tag lookup — `ListResources` returns identifiers
   *     only, so tag lookup would require one `GetResource` per resource
   *     in the account, plus per-service tag-API calls (which CC API
   *     doesn't expose uniformly). Cost vs. value isn't worth it; users
   *     who need adoption for CC-API-only resource types should pass
   *     `--resource <id>=<physicalId>` for those resources.
   *
   * SDK providers (S3, Lambda, IAM Role, etc.) implement their own
   * `import` with tag-based auto-lookup; this fallback only kicks in for
   * resource types that don't have a dedicated SDK provider.
   *
   * ---
   *
   * The rest of this block is the design of the attribute narrowing
   * {@link maskUncertifiedModelValues} performs — every LEAF of a model key
   * cdkd cannot certify is an ATTRIBUTE is replaced with {@link SECRET_MASK},
   * container shape preserved, and the certified attributes are left untouched
   * (issue [#2847](https://github.com/go-to-k/cdkd/issues/2847)).
   *
   * It lives HERE, on `import()`, rather than in a second block above the
   * method, and that is deliberate: two consecutive block comments attach only
   * the LAST one, so splitting this back out silently orphans whichever doc
   * ends up first. Keep it as ONE block.
   *
   * ## What is being fixed
   *
   * `GetResource` returns the resource MODEL — every readable property, not
   * just the attributes. `cdkd import` persisted that model verbatim into
   * `ResourceState.attributes`, through no redactor, for every
   * Cloud-Control-routed type. Where the model carries a credential, the
   * credential landed in `state.json` in the clear.
   *
   * ## Why "attribute" means `readOnlyProperties`
   *
   * That is CloudFormation's own definition: a type's `readOnlyProperties` are
   * exactly what `Fn::GetAtt` may read, and CloudFormation REJECTS a
   * `Fn::GetAtt` naming a writable property at template validation. So a key
   * outside that set was never a legitimate attribute, and cdkd persisting it
   * bought nothing a valid template could use.
   *
   * ## Why MASK and not DROP — the load-bearing decision
   *
   * Dropping looks cleaner and is WRONG here, because there is no live
   * fallback on the read side. `IntrinsicFunctionResolver.resolveGetAtt` looks
   * the key up in this bag and, on a miss, falls through to
   * `constructAttribute` — which synthesizes from `physicalId` alone and, for
   * an attribute name that is neither `*Arn` nor `*Url`, WARNS and returns the
   * physical id. That is a silently wrong value shipped to AWS. There is no
   * `provider.getAttribute` rescue on the deploy path (the only caller of it
   * outside the providers is `cdkd orphan`), and this class has no
   * `getAttribute` at all.
   *
   * Masking keeps the KEY present, so the lookup HITS and the value flows
   * through `noteAttributeSecrecy` into `ResolverContext.redactedAttributeReads`,
   * where `DeployEngine.refuseRedactedAttributeReads` FAILS the resource rather
   * than sending the mask. So the outcome is a loud, named refusal instead of a
   * wrong value — which is the trade this repo already made for the mask-only
   * channel (issue #2274), reusing its machinery rather than inventing a second
   * sentinel nothing downstream recognises.
   *
   * ONE SHAPE ESCAPES THAT, and it is stated rather than left to be discovered:
   * an uncertified EMPTY container (`{}` / `[]`) has no leaf to mask, so no
   * `SECRET_MASK` lands under that key and no refusal can fire for it. A DOTTED
   * read through it breaks at `Object.hasOwn` and falls to `constructAttribute`;
   * a FLAT read returns the empty container itself. It is not a DISCLOSURE — the
   * container was empty at AWS, so there was nothing to disclose — but the
   * refusal genuinely does not fire there.
   *
   * ## The unresolvable-schema arm is FAIL-CLOSED
   *
   * `getTopLevelReadOnlyProperties` answers `undefined` when it could not find
   * out — a missing `cloudformation:DescribeType` grant, an exhausted throttle
   * retry, or a type with no registry entry. cdkd then cannot tell an attribute
   * from a property for this type, so it certifies NOTHING and masks the whole
   * model, warning at default verbosity with the grant to add. Failing OPEN
   * here would make a missing IAM permission silently restore the exact
   * disclosure this method exists to close.
   *
   * ## An UNREADABLE MODEL warns at the same volume as an unreadable schema
   *
   * The two arms below the `GetResource` — a `JSON.parse` failure, and a model
   * that parsed to something other than an object — cannot mask anything (there
   * is no bag to walk), so they yield `attributes: {}`. That is the DROP
   * outcome this design rejects one section up: the key is absent,
   * `resolveGetAtt` falls through to `constructAttribute`, and the physical id
   * ships. "cdkd could not read the model" is the same epistemic state as "cdkd
   * could not read the schema", so both report at DEFAULT verbosity. They used
   * to differ — the schema arm warned while these logged at `debug` — which
   * meant the one outcome that ships a wrong value silently was the one nobody
   * was told about. Neither line prints any part of the model: the parse arm
   * prints the error's NAME only (V8 embeds an input snippet in a
   * `SyntaxError`'s message) and the non-object arm prints the SHAPE only.
   *
   * ## What this does NOT close, stated as the danger direction
   *
   * A CREDENTIAL THAT IS ITSELF A READ-ONLY ATTRIBUTE IS STILL PERSISTED IN THE
   * CLEAR. `readOnlyProperties` is a structural test, not a sensitivity one, and
   * the registry schema offers nothing better to key on: it has no general
   * sensitivity marking. The nearest things it does have were both checked and
   * neither serves — `"format": "password"` is declared by a single property in
   * AWS's whole published bundle, and `writeOnlyProperties` (a real "cannot be
   * returned by a read" marker, declared by a minority of types) describes
   * values `GetResource` never returns, so masking them would be inert here. So
   * the "mask by the schema's own marking" shape the issue floated is NARROWED
   * to nothing usable rather than refuted outright. Known members of the
   * surviving class include `AWS::IAM::AccessKey`'s `SecretAccessKey`,
   * `AWS::Cognito::UserPoolClient`'s `ClientSecret` and
   * `AWS::EC2::IpamExternalResourceVerificationToken`'s `TokenValue`. The list
   * is not claimed to be exhaustive and no count is quoted here, because
   * nothing in the tree fences one; the derivation and its residual are
   * recorded on the issue.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (!input.knownPhysicalId) {
      // Explicit-override-only: no auto lookup via CC API.
      return null;
    }

    try {
      const resp = await this.cloudControlClient.send(
        new GetResourceCommand({
          TypeName: input.resourceType,
          Identifier: input.knownPhysicalId,
        })
      );

      // CC API returns `ResourceModel` as a JSON string of the resource's
      // whole model. Its keys do NOT map 1:1 to GetAtt-compatible attribute
      // names — this comment claimed they did until issue
      // [#2847](https://github.com/go-to-k/cdkd/issues/2847) — so the parsed
      // model is filtered through `maskUncertifiedModelValues` before it
      // becomes state.
      //
      // The `try` wraps the `JSON.parse` and NOTHING ELSE. It used to span the
      // masking call too, whose `catch` then turned any failure of the schema
      // lookup into `attributes = {}` under a "Failed to parse" message — the
      // DROP outcome this design explicitly rejects, reached silently and
      // mislabelled. A masking failure must propagate to the outer catch and
      // fail the import loudly.
      // SANITISED because the two lines below are DEFAULT verbosity since this
      // fix round; at `debug` they reached a developer who had asked for them.
      // Both interpolate the `--resource <id>=<physicalId>` value the user
      // typed and the template's own `Type`, neither of which cdkd validates,
      // so an ANSI or line-break sequence in either forges terminal output and
      // JSON-log lines. `asciiOnly` matches what `lock-contention-message.ts`
      // applies to the same class of value.
      const safeType = displaySafe(input.resourceType, { asciiOnly: true });
      const safeId = displaySafe(input.knownPhysicalId, { asciiOnly: true });
      let parsedModel: Record<string, unknown> | undefined;
      const raw = resp.ResourceDescription?.Properties;
      if (typeof raw === 'string' && raw.length > 0) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            parsedModel = parsed as Record<string, unknown>;
          } else {
            // A model that PARSED but is not an object (an array, a primitive,
            // `null`) took the same silent path as a parse failure and logged
            // NOTHING — the narrowed `try` walks straight past it. Same
            // outcome, so it gets the same diagnosable line; the SHAPE is safe
            // to name, unlike the value.
            // `typeof null` is `'object'`, so a bare `typeof` renders the null
            // shape as "parsed to object, not an object" — a self-contradiction
            // in the one branch whose entire job is to be diagnosable.
            const shape =
              parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed;
            this.logger.warn(
              `CC API ResourceModel for ${safeType}/${safeId} parsed to ` +
                `${shape}, not an object — recording no attributes for it. An Fn::GetAtt against ` +
                `this resource will fall back to a value constructed from its physical id.`
            );
          }
        } catch (parseErr) {
          // NAME ONLY, never the message: V8 embeds an input snippet in a
          // `SyntaxError`, and the input here is the resource model. Measured on
          // Node 24.19.0: `JSON.parse('not-json{{{')` reports
          // `Unexpected token 'o', "not-json{{{" is not valid JSON`, so a
          // truncated model whose head is a credential echoes that credential
          // into the log. Fenced by
          // `tests/unit/provisioning/cloud-control-import-attribute-narrowing.test.ts`.
          this.logger.warn(
            `Failed to parse CC API ResourceModel for ${safeType}/${safeId}: ${
              parseErr instanceof Error ? parseErr.name : typeof parseErr
            }. Recording no attributes for it; an Fn::GetAtt against this resource will fall ` +
              `back to a value constructed from its physical id.`
          );
          // Fall through with empty attributes — physicalId is enough
          // to register the resource in state. Fn::GetAtt will
          // reconstruct attributes via constructAttribute at deploy.
        }
      }

      const attributes =
        parsedModel === undefined
          ? {}
          : await this.maskUncertifiedModelValues(
              parsedModel,
              input.resourceType,
              input.knownPhysicalId
            );

      return { physicalId: input.knownPhysicalId, attributes };
    } catch (error) {
      // ResourceNotFoundException → null (caller marks "not found").
      // Any other error (access denied, bad TypeName, throttling) →
      // re-throw so the caller can surface it.
      const err = error as { name?: string };
      if (err.name === 'ResourceNotFoundException') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Replace every LEAF cdkd cannot certify belongs to an ATTRIBUTE with
   * {@link SECRET_MASK}, preserving container SHAPE, and leave the certified
   * attributes untouched. The argument for masking rather than dropping, and
   * for the fail-closed `undefined` arm, is on {@link import} above.
   *
   * ## Why the walk is RECURSIVE — this was a measured defect, not caution
   *
   * The first cut replaced the whole VALUE, so an uncertified `Endpoint`
   * object became the string `'***'`. `IntrinsicFunctionResolver.resolveGetAtt`
   * resolves `Endpoint.Address` by WALKING the dotted path: it tests
   * `typeof cursor === 'object'`, which a string fails, so the walk breaks with
   * `cursor === undefined`, `noteAttributeSecrecy` is NEVER called, and control
   * reaches `constructAttribute` — the physical-id fallback. That is precisely
   * the silently-wrong-value outcome the mask exists to prevent, so
   * whole-value masking DEFEATED its own justification for every nested
   * attribute. Masking leaves keeps the containers walkable, so the walk lands
   * on a `'***'` LEAF and notes it, and the refusal fires — for any container
   * that HAS a leaf. An EMPTY one has none, and `import()`'s doc carries that
   * gap; do not read this sentence as covering it.
   *
   * Arrays keep their length and element positions for the same reason.
   *
   * ## The bag is null-prototype
   *
   * `JSON.parse` can yield a legal own key `__proto__`; assigning that on an
   * ordinary object literal writes the PROTOTYPE instead of an own property and
   * the key vanishes from the bag — a DROP, the one outcome this method must
   * never produce. `Object.create(null)` makes the assignment ordinary.
   */
  private async maskUncertifiedModelValues(
    model: Record<string, unknown>,
    resourceType: string,
    physicalId: string
  ): Promise<Record<string, unknown>> {
    // SANITISED for the same reason as `import()`'s two arms: `resourceType` is
    // the template's own `Type` and `physicalId` the `--resource` value the
    // user typed, neither validated by cdkd, and the warn below prints at
    // DEFAULT verbosity where an ANSI or line-break sequence forges output.
    // The debug line takes them too — it is one `--verbose` away, and a split
    // convention inside one method is how the next line gets it wrong.
    const safeType = displaySafe(resourceType, { asciiOnly: true });
    const safeId = displaySafe(physicalId, { asciiOnly: true });
    const attributeNames = await getTopLevelReadOnlyProperties(resourceType);
    if (attributeNames === undefined) {
      // ONCE PER TYPE, not once per resource: a whole-stack import of N
      // Cloud-Control-routed resources of one type would otherwise print N
      // identical default-verbosity warnings. Per-INSTANCE rather than
      // module-global so the set cannot leak between tests (the registry holds
      // one provider instance per run, so production still dedupes).
      if (!this.warnedUnresolvableSchemaTypes.has(resourceType)) {
        this.warnedUnresolvableSchemaTypes.add(resourceType);
        this.logger.warn(
          `Could not resolve the CloudFormation schema for ${safeType}, so ` +
            `cdkd cannot tell which of its Cloud Control model keys are ` +
            `Fn::GetAtt attributes. Every imported attribute for this type is ` +
            `recorded as "${SECRET_MASK}" rather than risking a credential in ` +
            `state.json; an Fn::GetAtt against such a resource fails with a ` +
            `named refusal until that resource is next created or updated by a ` +
            `deploy. Grant cloudformation:DescribeType and re-import to record ` +
            `its attributes.`
        );
      }
    }
    const masked: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let maskedCount = 0;
    for (const [key, value] of Object.entries(model)) {
      if (attributeNames?.has(key)) {
        masked[key] = value;
      } else {
        masked[key] = maskLeavesDeep(value);
        maskedCount++;
      }
    }
    if (maskedCount > 0 && attributeNames !== undefined) {
      this.logger.debug(
        `Masked ${maskedCount} non-attribute key(s) out of the ${safeType} ` +
          `Cloud Control model for ${safeId}: they are not in the type's ` +
          `readOnlyProperties, so CloudFormation would reject an Fn::GetAtt ` +
          `naming them and cdkd has no evidence they are safe to persist.`
      );
    }
    return masked;
  }
}

/**
 * Every LEAF of `value` replaced by {@link SECRET_MASK}, with object and array
 * CONTAINERS rebuilt at the same shape. See
 * `CloudControlProvider.maskUncertifiedModelValues` for why the shape must
 * survive.
 *
 * A `JSON.parse` result is acyclic by construction, so no visited-set is
 * needed — that answers CYCLES and nothing else. It is NOT a depth guarantee:
 * measured on this repo's node, `JSON.parse` survives ~100,000 nesting levels
 * while this recursion throws `RangeError` between 1,000 and 5,000. No Cloud
 * Control resource model comes close, and the `try` in `import()` is narrowed
 * to the parse, so such a `RangeError` would fail the import loudly rather than
 * degrade it silently — which is the direction this design wants. Recorded so
 * the acyclic sentence is not read as covering depth.
 */
function maskLeavesDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => maskLeavesDeep(element));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = maskLeavesDeep(nested);
    }
    return out;
  }
  return SECRET_MASK;
}
