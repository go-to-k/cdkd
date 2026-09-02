import {
  CloudControlClient,
  CreateResourceCommand,
  UpdateResourceCommand,
  DeleteResourceCommand,
  GetResourceCommand,
  GetResourceRequestStatusCommand,
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
import { markNonRetryable } from '../deployment/retryable-errors.js';
// Safe from `cloud-control-provider.ts` despite the dense engine -> executor ->
// registry -> provider ring: `delete-outcome.ts` is a documented LEAF whose only
// imports are types, so a new edge INTO it cannot close a cycle.
import { withIndeterminateGuard } from '../deployment/delete-outcome.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { JsonPatchGenerator } from './json-patch-generator.js';
import { getTopLevelWriteOnlyProperties } from './write-only-properties.js';
import { assertRegionMatch, type DeleteContext, type RegionCheckPhase } from './region-check.js';
import { ccProtectionProperty, type CcProtectionEntry } from './cc-protection-properties.js';
import { isNonProvisionable } from './unsupported-types.js';
import { slowCcOperationTimeoutMs } from './slow-cc-operation-timeouts.js';
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
 *     `STICKY_CC_MIGRATION_EXEMPT` would divert it -- and that set is reserved
 *     for types whose CC routing is BROKEN, which would then send the
 *     silent-drop property back down the dropping path on the next deploy.
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

  // Maximum time to wait for operation completion (15 minutes)
  private readonly MAX_WAIT_TIME_MS = 15 * 60 * 1000;
  // Initial poll interval (1 second) - increases with 1.5x exponential backoff
  private readonly INITIAL_POLL_INTERVAL_MS = 1_000;
  // Maximum poll interval (10 seconds)
  private readonly MAX_POLL_INTERVAL_MS = 10_000;

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
          `Skipped deleting the remnant ${error.physicalId} left by the failed CREATE of ${logicalId}: ` +
            `${cleanupResult.reason} — a retry may fail with AlreadyExists until it is removed manually`
        );
        return;
      }
      this.logger.debug(`Removed failed-create remnant ${error.physicalId} for ${logicalId}`);
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
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
      this.logger.warn(
        `Failed to delete the remnant ${error.physicalId} left by the failed CREATE of ${logicalId}: ${message} — ` +
          `a retry may fail with AlreadyExists until it is removed manually`
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
        if (
          notFoundErrorCode ||
          err.name === 'ResourceNotFoundException' ||
          err.message?.includes('does not exist') ||
          err.message?.includes('not found') ||
          err.message?.includes('NotFound')
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
          `${error instanceof Error ? error.message : String(error)}`
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
      this.logger.warn(
        `Could not confirm that ${resourceType} ${physicalId} (${logicalId}) is the resource ` +
          `this destroy targets: ${reason}. Proceeding with the delete.`
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
      await this.waitForOperation(
        response.ProgressEvent.RequestToken,
        logicalId,
        'UPDATE',
        resourceType
      );
      this.logger.debug(`Disabled ${protectionProperty} on ${logicalId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Could not disable ${protectionProperty} on ${logicalId} (${resourceType}): ${message}; proceeding with delete`
      );
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
   * Wait for an asynchronous operation to complete
   */
  private async waitForOperation(
    requestToken: string,
    logicalId: string,
    operation: 'CREATE' | 'UPDATE' | 'DELETE',
    resourceType: string
  ): Promise<ProgressEvent> {
    const startTime = Date.now();
    let attempts = 0;
    let pollInterval = this.INITIAL_POLL_INTERVAL_MS;

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

      const statusResponse = await this.cloudControlClient.send(
        new GetResourceRequestStatusCommand({
          RequestToken: requestToken,
        })
      );

      const progressEvent = statusResponse.ProgressEvent;

      if (!progressEvent) {
        throw new ProvisioningError(
          `Failed to get status for ${logicalId}: No progress event`,
          'Unknown',
          logicalId
        );
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

    throw new ProvisioningError(
      `${operation} timeout for ${logicalId} after ${maxWaitMs / 1000}s`,
      'Unknown',
      logicalId
    );
  }

  /**
   * Parse resource model JSON string.
   *
   * On a parse failure this logs the error plus the model's SHAPE — never its
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to parse resource model: ${errorMessage}\n` +
          `Model shape: ${resourceModel.length} chars, ${describeJsonKeys(resourceModel)}`
      );
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
   * CC API GetResource returns property names that match CloudFormation
   * Fn::GetAtt attribute names, so all properties are passed through as-is.
   * This method adds fallback attributes for edge cases where CC API
   * may not return certain values.
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
          const rdsClient = new RDSClient({});
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
          const rdsClient = new RDSClient({});
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
          const elastiCacheClient = new ElastiCacheClient({});
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
          const redshiftClient = new RedshiftClient({});
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
          const openSearchClient = new OpenSearchClient({});
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
   *     return its keys as `attributes`.
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

      // CC API returns `ResourceModel` as a JSON string of all the
      // resource's properties — its keys map 1:1 to GetAtt-compatible
      // attribute names. Parse and surface them so deploy-time
      // `Fn::GetAtt` resolution can find them in state.
      let attributes: Record<string, unknown> = {};
      const raw = resp.ResourceDescription?.Properties;
      if (typeof raw === 'string' && raw.length > 0) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            attributes = parsed as Record<string, unknown>;
          }
        } catch (parseErr) {
          this.logger.debug(
            `Failed to parse CC API ResourceModel for ${input.resourceType}/${input.knownPhysicalId}: ${
              parseErr instanceof Error ? parseErr.message : String(parseErr)
            }`
          );
          // Fall through with empty attributes — physicalId is enough
          // to register the resource in state. Fn::GetAtt will
          // reconstruct attributes via constructAttribute at deploy.
        }
      }

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
}
