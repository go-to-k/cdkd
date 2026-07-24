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
import { getAwsClients } from '../../utils/aws-clients.js';
import { rebuildClientForBucketRegion } from '../../utils/bucket-region-client.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

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
function parseLambdaPayload(payloadBytes: Uint8Array | undefined): CustomResourceResponsePayload {
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
    throw new Error(`Invalid Lambda response payload format: ${JSON.stringify(parsed)}`);
  }

  return parsed;
}

/**
 * IAM-authorization-propagation signals in a custom resource FAILED reason that
 * indicate the backing Lambda's freshly-attached execution-role policy has not
 * yet taken effect for its assumed-role session (so a recycle + retry will
 * succeed once IAM settles). Lowercase substrings. Intentionally narrow — these
 * are the IAM-permission-not-yet-effective phrases only, NOT generic transient
 * errors (throttling / timeouts), which must not trigger a CR re-invoke.
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
   * Whether `this.s3Client` is a provider-OWNED client (built from the
   * `setResponseBucket` region hint or by a region-correction rebuild)
   * vs the shared `AwsClients.s3` instance from the constructor. Owned
   * clients are `destroy()`ed when replaced; the shared one never is.
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
   * How many extra times to re-invoke a custom resource whose handler returned
   * FAILED with a *transient IAM-authorization* reason (e.g. the CDK Provider
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
   * Override via `CDKD_CR_AUTHZ_MAX_RETRIES` (0 disables).
   */
  private readonly transientAuthzMaxRetries: number = (() => {
    const raw = process.env['CDKD_CR_AUTHZ_MAX_RETRIES'];
    if (raw === undefined || raw === '') return 2;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 2;
  })();

  constructor(config?: CustomResourceProviderConfig) {
    const awsClients = getAwsClients();
    this.lambdaClient = awsClients.lambda;
    this.snsClient = awsClients.sns;
    this.s3Client = awsClients.s3;
    this.responseBucket = config?.responseBucket;
    this.responsePrefix = config?.responsePrefix ?? 'custom-resource-responses';
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
   * Set the S3 bucket for custom resource responses
   * Called by ProviderRegistry when state bucket is configured
   */
  setResponseBucket(bucket: string, bucketRegion?: string): void {
    this.responseBucket = bucket;
    // The supplied bucketRegion is only a starting HINT (deploy.ts passes the
    // deploy/base region, which is NOT necessarily where the state bucket
    // lives — the account-scoped default bucket is region-free, issue #1195).
    // The bucket's ACTUAL region is resolved lazily via ensureResponseClient()
    // before the first S3 operation, so the pre-signed ResponseURL always
    // targets the right regional endpoint.
    if (bucketRegion) {
      this.replaceS3Client(new S3Client({ region: bucketRegion }));
    }
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
   * Create a custom resource by invoking its Lambda handler
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
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
          StackId: `arn:aws:cloudformation:us-east-1:000000000000:stack/cdkd-${logicalId}/cdkd`,
          ResourceProperties: this.stringifyProperties(properties),
        })
      );

      if (cfnResponse.Status === 'FAILED') {
        throw new Error(
          `Custom resource handler returned FAILED: ${cfnResponse.Reason || 'Unknown reason'}`
        );
      }

      const physicalId: string = cfnResponse.PhysicalResourceId || logicalId;
      const attributes: Record<string, unknown> = cfnResponse.Data || {};

      this.logger.debug(`Successfully created custom resource ${logicalId}: ${physicalId}`);

      return { physicalId, attributes };
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
    previousProperties: Record<string, unknown>
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
          StackId: `arn:aws:cloudformation:us-east-1:000000000000:stack/cdkd-${logicalId}/cdkd`,
          ResourceProperties: this.stringifyProperties(properties),
          OldResourceProperties: this.stringifyProperties(previousProperties),
        })
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

      return { physicalId: newPhysicalId, wasReplaced, attributes };
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
  ): Promise<void> {
    // Custom resources delegate deletion to a user-provided Lambda handler.
    // The Lambda invocation itself does not surface a `*NotFound` for the
    // managed resource, so the region-mismatch check has no signal to act on
    // here; the underlying Lambda's region is determined by its ARN, which is
    // already encoded in the ServiceToken regardless of the cdkd client's
    // region. The context parameter is accepted for interface conformity.
    this.logger.debug(`Deleting custom resource ${logicalId}: ${physicalId} (${resourceType})`);

    if (!properties) {
      this.logger.warn(
        `No properties available for custom resource ${logicalId}, skipping deletion`
      );
      return;
    }

    const serviceToken = properties['ServiceToken'];

    if (!serviceToken) {
      this.logger.warn(`No ServiceToken found for custom resource ${logicalId}, skipping deletion`);
      return;
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
      this.logger.warn(
        `Backing Lambda for custom resource ${logicalId} no longer exists (${serviceToken}); ` +
          `treating the custom resource as already deleted`
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
          StackId: `arn:aws:cloudformation:us-east-1:000000000000:stack/cdkd-${logicalId}/cdkd`,
          ResourceProperties: this.stringifyProperties(properties),
        })
      );

      if (cfnResponse.Status === 'FAILED') {
        this.logger.warn(
          `Custom resource delete handler returned FAILED for ${logicalId}: ${cfnResponse.Reason || 'Unknown reason'}`
        );
      } else {
        this.logger.debug(`Successfully deleted custom resource ${logicalId}`);
      }
    } catch (error) {
      // For deletion, we should be more lenient with errors
      this.logger.warn(
        `Failed to delete custom resource ${logicalId}, but continuing: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if a ServiceToken is an SNS topic ARN
   */
  isSnsServiceToken(serviceToken: string): boolean {
    return serviceToken.startsWith('arn:aws:sns:');
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
   * `buildRequest` is called once per attempt with the fresh invocation so the
   * CFn request body always carries the matching ResponseURL / RequestId.
   * Returns the final response; the caller decides what a terminal FAILED means
   * (create/update throw, delete warns-and-continues).
   */
  private async invokeCustomResourceWithRetry(
    serviceToken: string,
    logicalId: string,
    operation: string,
    buildRequest: (invocation: {
      requestId: string;
      responseKey: string;
      responseURL: string;
    }) => Record<string, unknown>
  ): Promise<CfnCustomResourceResponse> {
    for (let attempt = 0; ; attempt++) {
      const invocation = await this.prepareInvocation();
      const request = buildRequest(invocation);

      this.logger.debug(
        `Sending custom resource ${operation.toLowerCase()} request: ${serviceToken}`
      );

      const cfnResponse = await this.sendRequest(
        serviceToken,
        request,
        invocation.responseKey,
        logicalId,
        operation
      );

      if (
        cfnResponse.Status === 'FAILED' &&
        attempt < this.transientAuthzMaxRetries &&
        this.isTransientAuthzFailure(cfnResponse.Reason)
      ) {
        this.logger.warn(
          `Custom resource ${operation} for ${logicalId} returned a transient IAM-authorization FAILED ` +
            `(attempt ${attempt + 1}/${this.transientAuthzMaxRetries + 1}): ${this.truncateReason(cfnResponse.Reason)}. ` +
            `Recycling the backing function's execution environment and retrying so its next cold start picks up the propagated policy.`
        );
        await this.recycleBackingFunctionExecEnv(serviceToken, logicalId);
        continue;
      }

      return cfnResponse;
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

  /** Truncate a CR FAILED reason for log readability. */
  private truncateReason(reason: string | undefined, max = 200): string {
    const r = reason ?? 'Unknown reason';
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
        { client: this.lambdaClient, maxWaitTime: 120 },
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
   */
  private async sendRequest(
    serviceToken: string,
    request: Record<string, unknown>,
    responseKey: string,
    logicalId: string,
    operation: string
  ): Promise<CfnCustomResourceResponse> {
    if (this.isSnsServiceToken(serviceToken)) {
      this.logger.debug(`ServiceToken is SNS topic, publishing to: ${serviceToken}`);
      await this.publishToSns(serviceToken, request);
      return await this.pollS3Response(responseKey, logicalId, operation);
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

    const response = await this.invokeLambda(serviceToken, request);
    return await this.getCustomResourceResponse(response, responseKey, logicalId, operation);
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
   */
  private async waitForBackingLambdaReady(serviceToken: string, logicalId: string): Promise<void> {
    try {
      await waitUntilFunctionActiveV2(
        { client: this.lambdaClient, maxWaitTime: 600 },
        { FunctionName: serviceToken }
      );
      await waitUntilFunctionUpdatedV2(
        { client: this.lambdaClient, maxWaitTime: 600 },
        { FunctionName: serviceToken }
      );
    } catch (error) {
      throw new Error(
        `Lambda backing custom resource ${logicalId} (${serviceToken}) did not reach a ready state for Invoke: ${
          error instanceof Error ? error.message : String(error)
        }`
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
   */
  private async invokeLambda(
    serviceToken: string,
    request: Record<string, unknown>
  ): Promise<InvocationResponse> {
    return await this.lambdaClient.send(
      new InvokeCommand({
        FunctionName: serviceToken,
        InvocationType: 'RequestResponse',
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
    operation: string
  ): Promise<CfnCustomResourceResponse> {
    // Check for Lambda execution errors
    if (lambdaResponse.FunctionError) {
      const errorPayload = lambdaResponse.Payload
        ? Buffer.from(lambdaResponse.Payload).toString()
        : 'Unknown';
      throw new Error(`Lambda function error (${lambdaResponse.FunctionError}): ${errorPayload}`);
    }

    // Try to parse direct Lambda response
    // Track whether Lambda returned a meaningful payload. If not, this likely indicates
    // an async pattern (e.g., CDK Provider framework with isCompleteHandler that delegates
    // to Step Functions for polling).
    let hasDirectPayload = false;
    try {
      const payload = parseLambdaPayload(lambdaResponse.Payload);

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
        return result;
      }

      // Payload parsed but contained no recognizable fields (e.g., empty object from
      // CDK Provider framework after starting Step Functions). Mark as no direct payload.
      hasDirectPayload = Object.keys(payload).length > 0;
    } catch {
      // Payload parsing failed, try S3
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
  private async prepareInvocation(): Promise<{
    requestId: string;
    responseKey: string;
    responseURL: string;
  }> {
    const requestId = `cdkd-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const responseKey = this.getResponseKey(requestId);
    const responseURL = await this.generateResponseURL(responseKey);
    return { requestId, responseKey, responseURL };
  }

  /**
   * Generate a pre-signed S3 PUT URL for Lambda to send its response
   */
  private async generateResponseURL(responseKey: string): Promise<string> {
    if (!this.responseBucket) {
      // Fallback: return a dummy URL (legacy behavior)
      return 'https://localhost/cfn-response-not-configured';
    }

    // The pre-signed URL's host is region-specific: sign against the bucket's
    // ACTUAL region, not the deploy region (issue #1195).
    await this.ensureResponseClient();

    // Create an empty placeholder object first (so the key exists for cleanup)
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.responseBucket,
        Key: responseKey,
        Body: '',
        ContentLength: 0,
        ContentType: 'application/json',
      })
    );

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
            this.logger.debug(`Got S3 response for ${logicalId}: ${body.substring(0, 200)}`);

            try {
              const cfnResponse = JSON.parse(body) as CfnCustomResourceResponse;

              // Validate response has required fields
              if (cfnResponse.Status === 'SUCCESS' || cfnResponse.Status === 'FAILED') {
                // Cleanup the response object
                await this.cleanupResponseObject(responseKey);
                return cfnResponse;
              }
            } catch {
              // JSON parse failed, response not yet written properly
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
   * Cleanup response object from S3
   */
  private async cleanupResponseObject(responseKey: string): Promise<void> {
    if (!this.responseBucket) return;

    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.responseBucket,
          Key: responseKey,
        })
      );
    } catch {
      // Ignore cleanup errors
    }
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
    return new Promise((resolve) => setTimeout(resolve, ms));
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
