import { LambdaClient, type InvocationResponse } from '@aws-sdk/client-lambda';
import { SNSClient } from '@aws-sdk/client-sns';
import { S3Client } from '@aws-sdk/client-s3';
import { type ConsoleLogger, getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { IAM_PROPAGATION_MAX_RETRIES } from '../../deployment/retry.js';
import type { InterruptWatch } from '../interrupt-watch.js';
import { CUSTOM_RESOURCE_RESPONSE_PREFIX } from '../../state/state-prefix.js';
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
import type { MaskerFn } from '../masked-retry-logger.js';
import type {
  CfnCustomResourceResponse,
  CustomResourceProviderConfig,
} from './custom-resource/lambda-payload.js';
import type { WaiterRejections } from './custom-resource/lambda-waiter.js';
import {
  CR_AUTHZ_MAX_RETRIES_DEFAULT,
  CR_AUTHZ_MAX_RETRIES_CEILING,
} from './custom-resource/retry-policy.js';
import {
  getMinResourceTimeoutMs,
  setResponseBucket,
  replaceS3Client,
  ensureResponseClient,
  resolveSyntheticStackId,
  wrapCaughtError,
  create,
  update,
} from './custom-resource/create-update.js';
import {
  deleteImpl,
  refuseResolvedSecret,
  isSnsServiceToken,
  isBackingLambdaGone,
} from './custom-resource/delete.js';
import {
  invokeCustomResourceWithRetry,
  isTransientAuthzFailure,
  isTransientAuthzThrow,
  findTransientAuthzLogLine,
  truncateReason,
  generateResponseURL,
} from './custom-resource/invoke-retry.js';
import {
  recycleBackingFunctionExecEnv,
  recycleAndRestore,
  readOriginalDescription,
  waitForBackingFunctionUpdated,
  describeRecycleFailure,
  debugWaiterRejections,
} from './custom-resource/recycle.js';
import {
  sendRequest,
  waitForBackingLambdaReady,
  waitForReferencedLambdasActive,
  publishToSns,
  invokeLambda,
} from './custom-resource/dispatch.js';
import {
  getCustomResourceResponse,
  prepareInvocation,
  pollS3Response,
  getResponseKey,
  cleanupResponseObject,
  stringifyProperties,
  sleep,
  sleepInterruptibly,
  importImpl,
} from './custom-resource/response.js';

export {
  CR_NO_PROPERTIES_SKIP_REASON,
  CR_NO_SERVICE_TOKEN_SKIP_REASON,
  CR_MASKED_SERVICE_TOKEN_SKIP_REASON,
  CR_NOECHO_PROPERTIES_SKIP_REASON,
  CR_MASKED_PROPERTIES_SKIP_REASON,
  CR_REFERENCE_SERVICE_TOKEN_SKIP_REASON,
  CR_DELETE_INVOKE_FAILED_SKIP_REASON,
  CR_DELETE_HANDLER_FAILED_SKIP_REASON,
  CR_BACKING_LAMBDA_GONE_SKIP_REASON,
} from './custom-resource/delete-skip-reasons.js';
export type { CustomResourceProviderConfig } from './custom-resource/lambda-payload.js';
export {
  waitForLambdaFunctionActive,
  collectReferencedLambdaFunctionArns,
} from './custom-resource/lambda-waiter.js';
export { customResourceRetryDelays } from './custom-resource/retry-policy.js';

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
  lambdaClient: LambdaClient;
  snsClient: SNSClient;
  s3Client: S3Client;
  logger: ConsoleLogger = getLogger().child('CustomResourceProvider');
  responseBucket: string | undefined;
  responsePrefix: string;

  /**
   * Memoization for the lazy response-bucket region correction
   * (`ensureResponseClient`). Mirrors the `clientResolved` /
   * `resolveInFlight` pattern of the three other state-bucket S3
   * consumers (S3StateBackend / LockManager / ExportIndexStore), plus a
   * generation counter: `setResponseBucket` bumps it so a probe that was
   * still in flight when the bucket was re-set cannot commit its stale
   * client / resolved flag against the new bucket.
   */
  responseClientResolved = false;
  responseClientResolveInFlight: Promise<void> | null = null;
  responseClientGeneration = 0;

  /**
   * Whether `this.s3Client` is a provider-OWNED client (built by a
   * region-correction rebuild) vs the shared `AwsClients.s3` instance
   * from the constructor. Owned clients are `destroy()`ed when replaced;
   * the shared one never is.
   */
  ownsS3Client = false;

  /**
   * Per-backing-function serialisation of `recycleBackingFunctionExecEnv`
   * (issue #5738). The provider is a singleton, so two custom resources on
   * one ServiceToken can recycle concurrently; unserialised, the second would
   * read the first's recycle marker as the function's "prior" Description and
   * write it back last, leaving the marker on the function for good. Each
   * entry is the tail of that function's chain and is dropped once idle.
   */
  readonly recycleChains = new Map<string, Promise<void>>();

  /**
   * The last Description read off each backing function that was NOT a cdkd
   * recycle marker (issue #5738). Consulted only when a recycle reads a
   * marker back — a previous restore that failed — so a later recycle still
   * restores the ORIGINAL text, never the previous recycle's.
   */
  readonly originalDescriptions = new Map<string, string>();

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
   * | Lambda `Invoke` / SNS `Publish` | YES, but only PRE-DELIVERY, on {@link CustomResourceProvider.preDeliveryAuthzMaxRetries} — its OWN budget, the same dense 47.75s schedule every other resource type gets | a replay re-delivers the request, which is the hazard this flag exists for, so the PRE-delivery fence is what makes the budget affordable: nothing has been delivered, so a replay re-invokes NOTHING. That rests on {@link CustomResourceProvider.isTransientAuthzThrow} admitting FRONT-DOOR rejections only — `delivered === false` alone does not establish it, since the flag flips when the call RETURNS — so read that method's doc before adding a pattern to the shared list it reads |
   * | `waitUntilFunctionActiveV2` / `waitUntilFunctionUpdatedV2` | ALREADY, by the SDK waiter — and their wrapped failure is `markNonRetryable`d, so the loop below does not replay it either | measured against `@aws-sdk/client-lambda`: the generated `checkState` catches EVERY exception and returns `RETRY`, so a mid-propagation 403 on `lambda:GetFunction` is polled out to `maxWaitTime` (600s). Wrapping them again would only stack a second budget on top — and `@smithy/util-waiter` serializes its `observedResponses` into the TIMEOUT message, whose keys read `403: User: … is not authorized to perform: lambda:GetFunction …`, so a classifier reading that message would have replayed a PERMANENT denial for 3 x 600s |
   * | `GetFunction` (delete-path backing-Lambda probe) | NO, deliberately | it already fails OPEN — anything but a definitive `ResourceNotFoundException` falls through to the normal invoke path, whose waiters cover the same propagation window one call later. Retrying would only delay that fall-through by up to 47.75s on a genuine permission denial |
   * | anything AFTER delivery (`pollS3Response`, the `FunctionError` throw, `cleanupResponseObject`) | NO, deliberately | the handler is running and will PUT to the URL of THIS attempt; a replay strands it at a key nobody polls, which is precisely the bug `disableOuterRetry` prevents |
   */
  readonly disableOuterRetry = true;

  /** Max time to wait for synchronous S3 response after Lambda invocation (30 seconds) */
  readonly SYNC_RESPONSE_TIMEOUT_MS = 30_000;
  /** Max time to wait for async S3 response (CDK Provider framework with isCompleteHandler) */
  readonly asyncResponseTimeoutMs: number;
  /** Default async response timeout: 1 hour (matches CDK's default totalTimeout) */
  private static readonly DEFAULT_ASYNC_RESPONSE_TIMEOUT_MS = 3_600_000;
  /** Initial poll interval for checking S3 response (2 seconds) */
  readonly INITIAL_POLL_INTERVAL_MS = 2_000;
  /** Max poll interval for async polling with exponential backoff (30 seconds) */
  readonly MAX_POLL_INTERVAL_MS = 30_000;

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
   * a pre-delivery throw it replays invokes the handler ZERO times, so the
   * argument that bounds this number does not apply there at all. That "zero"
   * is carried by {@link CustomResourceProvider.isTransientAuthzThrow}
   * admitting FRONT-DOOR rejections only, not by the `delivered === false`
   * gate reading it off — see that method's doc. Sharing it was measured
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
  readonly transientAuthzMaxRetries: number = (() => {
    const raw = process.env['CDKD_CR_AUTHZ_MAX_RETRIES'];
    if (raw === undefined || raw === '') return CR_AUTHZ_MAX_RETRIES_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return CR_AUTHZ_MAX_RETRIES_DEFAULT;
    // Clamp, do not trust. Every unit of this budget costs one re-invoke of the
    // user's handler PLUS a `recycleBackingFunctionExecEnv` (a
    // `GetFunctionConfiguration`, the marker and restore
    // `UpdateFunctionConfiguration`s with the restore's bounded conflict
    // re-sends, and their waiters, all inside one 240s
    // `CR_RECYCLE_BUDGET_SECONDS` budget), so an unbounded value —
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
   * **Why it can afford that while its sibling cannot**: the handler has been
   * invoked ZERO times, so a replay re-runs NOTHING — no partial work repeated,
   * no second physical resource from a Provider-framework `onEvent`, no
   * stranded response URL. That guarantee comes from
   * {@link CustomResourceProvider.isTransientAuthzThrow} admitting FRONT-DOOR
   * rejections only, NOT from the `delivered === false` gate on its own: that
   * flag flips when `Invoke` / `Publish` returns, so a throw between acceptance
   * and resolution reaches the catch with it still false. It is the second
   * fence, for a delivery that COMPLETED — read that method's doc before adding
   * a pattern the shared list carries. The
   * only cost of a retry here is one `PutObject` + one presign, and the
   * abandoned placeholder is swept before the next attempt. So the constraint
   * that keeps `transientAuthzMaxRetries` at 2 is simply absent, and matching
   * every other resource type is the correct answer instead.
   *
   * A thrown retry also skips the exec-env recycle, because every rejection this
   * arm admits is decided before the handler can run: no environment was ever
   * CREATED, so there is no warm container holding stale credentials to
   * invalidate. ("Before an execution environment is engaged" would be the
   * weaker bar -- the issue #3227 VPC rejections are raised DURING environment
   * setup, at ENI attach, not before it starts.) For the
   * original case that is also a matter of whose permission it is -- the
   * deploying principal's `lambda:InvokeFunction`, not the function's role --
   * but that is not the general reason: the issue #3227 entries can surface as
   * a VPC-networking rejection about the FUNCTION's own role
   * (`EC2AccessDeniedException`), and there is still nothing to recycle,
   * for the same reason.
   *
   * Deliberately NOT overridable by an env var. It bounds no handler
   * invocation, so there is nothing for a user to trade off — the same reason
   * the placeholder `PutObject`'s `withRetry` takes no knob either.
   */
  readonly preDeliveryAuthzMaxRetries: number = IAM_PROPAGATION_MAX_RETRIES;

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
  readonly configuredRegion: string | undefined;

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

  getMinResourceTimeoutMs(): number {
    return getMinResourceTimeoutMs.call(this);
  }

  setResponseBucket(bucket: string): void {
    return setResponseBucket.call(this, bucket);
  }

  replaceS3Client(replacement: S3Client): void {
    return replaceS3Client.call(this, replacement);
  }

  ensureResponseClient(): Promise<void> {
    return ensureResponseClient.call(this);
  }

  resolveSyntheticStackId(
    logicalId: string,
    operation: string,
    watch: InterruptWatch
  ): Promise<string> {
    return resolveSyntheticStackId.call(this, logicalId, operation, watch);
  }

  wrapCaughtError(
    mask: MaskerFn | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    return wrapCaughtError.call(this, mask, error, build);
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  refuseResolvedSecret(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    physicalId?: string,
    previousProperties?: Record<string, unknown>
  ): void {
    return refuseResolvedSecret.call(
      this,
      logicalId,
      resourceType,
      properties,
      physicalId,
      previousProperties
    );
  }

  isSnsServiceToken(serviceToken: string): boolean {
    return isSnsServiceToken.call(this, serviceToken);
  }

  isBackingLambdaGone(serviceToken: string): Promise<boolean> {
    return isBackingLambdaGone.call(this, serviceToken);
  }

  invokeCustomResourceWithRetry(
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
    return invokeCustomResourceWithRetry.call(
      this,
      serviceToken,
      logicalId,
      operation,
      buildRequest,
      mask,
      referenced
    );
  }

  isTransientAuthzFailure(reason: string | undefined): boolean {
    return isTransientAuthzFailure.call(this, reason);
  }

  isTransientAuthzThrow(error: unknown): boolean {
    return isTransientAuthzThrow.call(this, error);
  }

  findTransientAuthzLogLine(
    logTail: string | undefined
  ): { line: string; signal: string } | undefined {
    return findTransientAuthzLogLine.call(this, logTail);
  }

  truncateReason(reason: string | undefined, max = 200): string {
    return truncateReason.call(this, reason, max);
  }

  recycleBackingFunctionExecEnv(
    serviceToken: string,
    logicalId: string,
    mask: MaskerFn | undefined
  ): Promise<void> {
    return recycleBackingFunctionExecEnv.call(this, serviceToken, logicalId, mask);
  }

  recycleAndRestore(
    serviceToken: string,
    key: string,
    logicalId: string,
    mask: MaskerFn | undefined
  ): Promise<void> {
    return recycleAndRestore.call(this, serviceToken, key, logicalId, mask);
  }

  readOriginalDescription(
    serviceToken: string,
    key: string,
    logicalId: string,
    mask: MaskerFn | undefined
  ): Promise<string | undefined> {
    return readOriginalDescription.call(this, serviceToken, key, logicalId, mask);
  }

  waitForBackingFunctionUpdated(
    serviceToken: string,
    rejections: WaiterRejections,
    maxWaitTime = 120
  ): Promise<void> {
    return waitForBackingFunctionUpdated.call(this, serviceToken, rejections, maxWaitTime);
  }

  describeRecycleFailure(
    error: unknown,
    rejections: WaiterRejections,
    mask: MaskerFn | undefined
  ): string {
    return describeRecycleFailure.call(this, error, rejections, mask);
  }

  debugWaiterRejections(logicalId: string, rejections: WaiterRejections): void {
    return debugWaiterRejections.call(this, logicalId, rejections);
  }

  sendRequest(
    serviceToken: string,
    request: Record<string, unknown>,
    responseKey: string,
    logicalId: string,
    operation: string,
    onDelivered: () => void,
    mask: MaskerFn | undefined
  ): Promise<{ response: CfnCustomResourceResponse; logResult?: string }> {
    return sendRequest.call(
      this,
      serviceToken,
      request,
      responseKey,
      logicalId,
      operation,
      onDelivered,
      mask
    );
  }

  waitForBackingLambdaReady(
    serviceToken: string,
    logicalId: string,
    mask: MaskerFn | undefined
  ): Promise<void> {
    return waitForBackingLambdaReady.call(this, serviceToken, logicalId, mask);
  }

  waitForReferencedLambdasActive(
    logicalId: string,
    serviceToken: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown> | undefined,
    watch: InterruptWatch,
    mask: MaskerFn | undefined
  ): Promise<void> {
    return waitForReferencedLambdasActive.call(
      this,
      logicalId,
      serviceToken,
      properties,
      previousProperties,
      watch,
      mask
    );
  }

  publishToSns(topicArn: string, request: Record<string, unknown>): Promise<void> {
    return publishToSns.call(this, topicArn, request);
  }

  invokeLambda(
    serviceToken: string,
    request: Record<string, unknown>
  ): Promise<InvocationResponse> {
    return invokeLambda.call(this, serviceToken, request);
  }

  getCustomResourceResponse(
    lambdaResponse: InvocationResponse,
    responseKey: string,
    logicalId: string,
    operation: string,
    mask: MaskerFn | undefined
  ): Promise<CfnCustomResourceResponse> {
    return getCustomResourceResponse.call(
      this,
      lambdaResponse,
      responseKey,
      logicalId,
      operation,
      mask
    );
  }

  prepareInvocation(
    logicalId: string,
    watch: InterruptWatch,
    mask: MaskerFn | undefined
  ): Promise<{
    requestId: string;
    responseKey: string;
    responseURL: string;
  }> {
    return prepareInvocation.call(this, logicalId, watch, mask);
  }

  generateResponseURL(
    responseKey: string,
    logicalId: string,
    watch: InterruptWatch,
    mask: MaskerFn | undefined
  ): Promise<string> {
    return generateResponseURL.call(this, responseKey, logicalId, watch, mask);
  }

  pollS3Response(
    responseKey: string,
    logicalId: string,
    operation: string,
    timeoutMs: number = this.SYNC_RESPONSE_TIMEOUT_MS,
    useBackoff: boolean = false
  ): Promise<CfnCustomResourceResponse> {
    return pollS3Response.call(this, responseKey, logicalId, operation, timeoutMs, useBackoff);
  }

  getResponseKey(requestId: string): string {
    return getResponseKey.call(this, requestId);
  }

  cleanupResponseObject(responseKey: string): Promise<void> {
    return cleanupResponseObject.call(this, responseKey);
  }

  stringifyProperties(properties: Record<string, unknown>): Record<string, unknown> {
    return stringifyProperties.call(this, properties);
  }

  sleep(ms: number): Promise<void> {
    return sleep.call(this, ms);
  }

  sleepInterruptibly(ms: number, watch: InterruptWatch): Promise<void> {
    return sleepInterruptibly.call(this, ms, watch);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
