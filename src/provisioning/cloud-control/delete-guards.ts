import { canonicalizeRegion } from '../../utils/aws-partition.js';
import { isTerminationProtectionPropagationError } from '../ec2-termination-protection.js';
import type { EC2Client } from '@aws-sdk/client-ec2';
import { isAmbiguousCcHandlerErrorCode } from '../../deployment/retryable-errors.js';
import { isWaitAbandonedError } from '../wait-abandoned.js';
import { CloudControlOperationFailedError } from './shared.js';

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
 *     SDK-unwired rule: a type WITH an SDK provider goes to Cloud Control
 *     exactly when its template uses a property that provider would silently
 *     DROP. Suppressing it for buckets means `disableCcApiFallback` on
 *     `S3BucketProvider`, which converts those deploys from "provisioned
 *     correctly via CC" into a hard `buildUnroutableSdkUnwiredMessage` throw.
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
 *     resource only when its property bags carry no actionable SDK-unwired property --
 *     which is the opposite of this case by construction. Were a type somehow
 *     admitted anyway, the divert would send the SDK-unwired property back
 *     down the dropping path on the next deploy; the property gate is what
 *     prevents it.
 *
 * So the confirmation belongs where the delete is actually issued. The set is
 * a set rather than an `if` because the hazard is not S3-specific in kind: any
 * type whose physical id is globally unique but whose RESOURCE is regional can
 * be named by a state record that denotes something in another region.
 * `AWS::S3::Bucket` is the only instance recorded so far (issue #2283).
 */
export const CC_DELETE_IDENTITY_CHECKED_TYPES: ReadonlySet<string> = new Set(['AWS::S3::Bucket']);

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
export function bucketLocationToRegion(constraint: string | null | undefined): string {
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
export function isNoSuchBucketError(error: unknown): boolean {
  return (error as { name?: string } | undefined)?.name === 'NoSuchBucket';
}

/**
 * The snapshot-capable types whose Cloud Control delete handler takes a final
 * snapshot on every delete, and the SDK provider family
 * {@link deletesThroughSdkProvider} hands them to instead. RDS is read from the
 * handler source (#3993); Neptune was MEASURED by the
 * `cc-final-snapshot-handlers` fixture (#4029), which also measured
 * `AWS::ElastiCache::CacheCluster` leaving none.
 */
export const SDK_DELETE_FAMILIES: ReadonlyMap<string, 'rds' | 'neptune'> = new Map([
  ['AWS::RDS::DBCluster', 'rds'],
  ['AWS::RDS::DBInstance', 'rds'],
  ['AWS::Neptune::DBCluster', 'neptune'],
]);

/**
 * Whether `CloudControlProvider.delete` hands this resource to its SDK
 * provider instead of issuing `DeleteResource` (issues #3993, #4029), once the
 * delete's governing policy is `Delete` or `--skip-final-snapshot` opted out.
 *
 * The RDS registry handlers take a final snapshot whenever the handler
 * request's `snapshotRequested` is null (`BooleanUtils.isNotFalse`), and
 * Cloud Control never sets it; `DeleteResource` has no parameter that does.
 * CloudFormation sends `false` for `DeletionPolicy: Delete`, so the snapshot
 * exists only on the Cloud Control route.
 *
 * An RDS global-cluster member goes too: `RDSProvider` detaches it by the
 * recorded `GlobalClusterIdentifier` first, as the handler does (issue #4029).
 * A cluster stays on Cloud Control, with a warning, when that value is present
 * but NOT a string (an unresolved intrinsic an import recorded): cdkd cannot
 * name the global cluster to detach from. A Neptune cluster stays when it
 * records ANY `GlobalClusterIdentifier`: `NeptuneProvider` has no detach, and
 * the Neptune handler's source is not public.
 */
export function deletesThroughSdkProvider(
  resourceType: string,
  properties: Record<string, unknown> | undefined
): boolean {
  const family = SDK_DELETE_FAMILIES.get(resourceType);
  if (family === undefined) return false;
  if (resourceType === 'AWS::RDS::DBInstance') return true;
  const globalCluster = properties?.['GlobalClusterIdentifier'];
  if (globalCluster === undefined || globalCluster === null) return true;
  if (family === 'neptune') {
    return typeof globalCluster === 'string' && globalCluster.trim() === '';
  }
  return typeof globalCluster === 'string';
}

/**
 * A Cloud Control-routed `AWS::EC2::Instance` under `--remove-protection`:
 * its region-pinned EC2 client, and whether the pre-flip read saw the guard
 * ON (issue #2204).
 */
export interface ProtectedEc2Instance {
  readonly client: EC2Client;
  readonly observedOn: boolean;
}

/**
 * Whether a failed Cloud Control DELETE attempt may already be deleting the
 * resource (issue #2204), so its `--remove-protection` guard must not be put
 * back:
 *
 *  - an abandoned wait;
 *  - a handler FAILED whose code leaves open that the service acted
 *    (`isAmbiguousCcHandlerErrorCode`) — except an EC2 instance's
 *    termination-protection refusal, which is a refusal whatever code the
 *    handler files it under and is exactly what the instance's compensation
 *    exists for;
 *  - a CONFLICT (`ResourceConflictException`, or a handler `ResourceConflict`)
 *    when an EARLIER attempt of the same record already may have been
 *    deleting (`priorMayBeDeleting`). A handler `ResourceConflict`, or a
 *    synchronous conflict after an ABANDONED earlier attempt, is most likely
 *    that delete still running. A synchronous conflict after an earlier
 *    attempt that FAILED ambiguously cannot be that request, which had ended;
 *    it is more likely this run's own flip-off patch still in progress (one
 *    counted as landed after its wait was abandoned), and standing down there
 *    is the cautious side: a re-enable would conflict with the same patch.
 *    On a first attempt a conflict stays a refusal.
 *
 * Standing down on a TERMINAL failure is never silent:
 * `CloudControlProvider.delete` warns, naming the check and restore commands.
 * A retryable failure on the destroy loop's last attempt is terminal too
 * (`runDeleteAttempt`, issue #4318), so it gets the same line.
 */
export function ccDeleteMayHaveActed(
  error: unknown,
  isProtectedEc2Instance: boolean,
  priorMayBeDeleting: boolean
): boolean {
  if (isWaitAbandonedError(error)) return true;
  if (priorMayBeDeleting && isCcConflict(error)) return true;
  if (!(error instanceof CloudControlOperationFailedError) || error.ccOperation !== 'DELETE') {
    return false;
  }
  if (!isAmbiguousCcHandlerErrorCode(error.ccErrorCode)) return false;
  return !(isProtectedEc2Instance && isTerminationProtectionPropagationError(error.message));
}

/** A Cloud Control conflict, synchronous or handler-reported. */
export function isCcConflict(error: unknown): boolean {
  if (error instanceof CloudControlOperationFailedError) {
    return error.ccErrorCode === 'ResourceConflict';
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'ResourceConflictException'
  );
}
