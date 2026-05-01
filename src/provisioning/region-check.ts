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
