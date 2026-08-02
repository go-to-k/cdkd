import { ProvisioningError } from '../utils/error-handler.js';

/**
 * Context passed to provider delete operations.
 *
 * `expectedRegion` is the region that the resource is expected to live in,
 * sourced from the stack state (`StackState.region`). When set, providers
 * use it to verify that a `NotFound` error from the AWS client is genuinely
 * "the resource is gone", and not a silent miss caused by the client
 * pointing at a different region than where the resource actually lives.
 */
export interface DeleteContext {
  /**
   * Region recorded in the stack state when the resource was created.
   * Optional: when omitted (or set to undefined), providers preserve their
   * existing idempotent behavior — i.e., NotFound is treated as success
   * without verification. The explicit `undefined` is permitted so callers
   * can spread `state.region` (which is itself `string | undefined`)
   * directly without first narrowing.
   */
  expectedRegion?: string | undefined;

  /**
   * If true, providers MUST flip per-resource deletion protection off
   * in-place before issuing the actual delete API call. Set by `cdkd
   * destroy --remove-protection` / `cdkd state destroy --remove-protection`.
   *
   * Providers handle the in-place flip-off only for protection-bearing
   * resource types (e.g. `AWS::Logs::LogGroup` `DeletionProtectionEnabled`,
   * `AWS::RDS::DBInstance` / `DBCluster` `DeletionProtection`,
   * `AWS::DocDB::DBCluster` `DeletionProtection` (DocDB DBInstance has
   * no protection field), `AWS::Neptune::DBCluster` /
   * `AWS::Neptune::DBInstance` `DeletionProtection`,
   * `AWS::DynamoDB::Table` `DeletionProtectionEnabled`,
   * `AWS::EC2::Instance` `DisableApiTermination`,
   * `AWS::ElasticLoadBalancingV2::LoadBalancer`
   * `deletion_protection.enabled` attribute). Resource types that do not
   * have a corresponding protection field treat this flag as a no-op —
   * the existing delete logic runs unchanged.
   *
   * The flip-off call is idempotent: it is always issued when this flag
   * is set (and protection is supported on the type), regardless of
   * whether the resource actually has protection enabled. AWS APIs
   * accept the no-op (already-disabled) case without error; "not found"
   * / similar errors during the flip-off are logged at debug and the
   * delete proceeds.
   *
   * When `false` (the default), providers behave exactly as before —
   * deletion protection blocks the destroy with whatever error AWS
   * returns (`OperationNotPermitted` / `InvalidParameterCombination` /
   * etc.) so the user must opt into the bypass explicitly.
   *
   * Note: prior to this flag, the RDS DBInstance / DBCluster providers
   * unconditionally issued a `ModifyDB{Instance,Cluster}` to clear
   * `DeletionProtection: false` before every destroy. That implicit
   * behavior is now gated on `removeProtection === true` to match the
   * other provider types — destroying an RDS resource whose deletion
   * protection was set externally (console, AWS CLI) without
   * `--remove-protection` will surface AWS's `InvalidParameterCombination`
   * error rather than silently succeed.
   */
  removeProtection?: boolean;

  /**
   * If true, the caller carries explicit user consent to destroy the DATA a
   * resource still contains (issue #1340). Set ONLY by the deploy engine's
   * replacement / recreate delete paths when `--force-stateful-recreation`
   * was passed — the flag whose documented meaning is "I accept a
   * data-losing recreation of a stateful resource".
   *
   * Providers that gate data-destroying force-cleanup consult it as one of
   * their accepted intent signals:
   *   - `AWS::S3::Bucket`: allows emptying a non-empty bucket (all object
   *     versions + delete markers) before `DeleteBucket`.
   *   - `AWS::ECR::Repository`: allows `DeleteRepository(force: true)` on a
   *     repository that still contains images.
   *
   * Plain `cdkd destroy` / `cdkd state destroy` never set it — there the
   * template-borne intent signals (CDK's `aws-cdk:auto-delete-objects` /
   * `aws-cdk:auto-delete-images` tags, `EmptyOnDelete: true`) are the only
   * accepted opt-ins, and without one the provider surfaces AWS's
   * not-empty error exactly like CloudFormation's DELETE_FAILED. This is
   * the same implicit-force -> explicit-opt-in migration `removeProtection`
   * went through (see its note above).
   */
  forceDataDelete?: boolean;

  /**
   * When set, the resource's `DeletionPolicy` is `Snapshot` (issue #1352) and
   * the provider MUST create a final snapshot under this identifier as part
   * of the delete — for the `ATOMIC_FINAL_SNAPSHOT_TYPES` (see
   * `src/provisioning/final-snapshot.ts`) that means flipping the delete call
   * from `SkipFinalSnapshot: true` to the API's atomic final-snapshot form
   * (e.g. RDS `DeleteDBInstance(FinalDBSnapshotIdentifier, SkipFinalSnapshot:
   * false)`). The destroy call sites generate the identifier via
   * `buildFinalSnapshotIdentifier()` and only pass it for types in that set
   * AND only when the resource is SDK-routed, so a provider that does not
   * read the field is never silently skipped — unsupported Snapshot-tagged
   * types are refused before the delete, a `provisionedBy: 'cc-api'` atomic
   * type is refused too (Cloud Control `DeleteResource` has no final-snapshot
   * parameter), and `CloudControlProvider.delete` additionally fail-closes
   * if the field ever reaches it.
   *
   * One CFn-documented nuance the RDS provider must apply: a DBInstance that
   * is a member of a DBCluster (`DBClusterIdentifier` present in its
   * properties) is deleted WITHOUT a final snapshot even under `Snapshot`
   * (cluster-level snapshots cover it) — matching CloudFormation.
   *
   * Absent (`undefined`) = no final snapshot: policy is not `Snapshot`, or
   * the user passed `--skip-final-snapshot`.
   */
  finalSnapshotIdentifier?: string;
}

/**
 * Verify that the AWS client's region matches the region the resource is
 * expected to live in before treating a `NotFound` error as idempotent
 * delete success.
 *
 * Why: a destroy run with the wrong region would otherwise receive
 * `*NotFound` for every resource and silently strip them all from state,
 * leaving the actual AWS resources orphaned in the real region. The
 * silent-failure incident that motivated this check was a Lambda in
 * `us-west-2` removed from state by a destroy that ran with a `us-east-1`
 * client.
 *
 * Behavior:
 * - If `expectedRegion` is unset, this is a no-op (back-compat: existing
 *   idempotent semantics preserved for callers that have not been
 *   threaded with state region).
 * - If `clientRegion` matches `expectedRegion`, returns silently.
 * - Otherwise throws `ProvisioningError` so the caller surfaces the
 *   mismatch instead of swallowing the NotFound.
 *
 * @param clientRegion Region resolved from the AWS SDK client config
 *   (typically `await client.config.region()`).
 * @param expectedRegion Region recorded in stack state, or undefined if
 *   the caller has no expected region.
 * @param resourceType CloudFormation resource type, used in the error
 *   message and on the thrown ProvisioningError.
 * @param logicalId Logical ID of the resource, used in the error message
 *   and on the thrown ProvisioningError.
 * @param physicalId Optional physical ID, used in the error message and
 *   on the thrown ProvisioningError.
 */
export function assertRegionMatch(
  clientRegion: string | undefined,
  expectedRegion: string | undefined,
  resourceType: string,
  logicalId: string,
  physicalId?: string
): void {
  if (!expectedRegion) {
    // Back-compat: caller did not supply state region, preserve previous
    // idempotent behavior.
    return;
  }

  if (!clientRegion) {
    throw new ProvisioningError(
      `Refusing to treat NotFound as idempotent delete success for ${logicalId} ` +
        `(${resourceType}): AWS client region is unknown but stack state expects ` +
        `${expectedRegion}. The resource may exist in ${expectedRegion} and would ` +
        `be silently removed from state if this NotFound were trusted.`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  if (clientRegion !== expectedRegion) {
    throw new ProvisioningError(
      `Refusing to treat NotFound as idempotent delete success for ${logicalId} ` +
        `(${resourceType}): AWS client region ${clientRegion} does not match stack ` +
        `state region ${expectedRegion}. The resource likely still exists in ` +
        `${expectedRegion}; rerun the destroy with the correct region (e.g. ` +
        `--region ${expectedRegion}).`,
      resourceType,
      logicalId,
      physicalId
    );
  }
}
