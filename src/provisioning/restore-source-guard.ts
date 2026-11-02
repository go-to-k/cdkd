import { markNonRetryable } from '../deployment/retryable-errors.js';
import { safeMsg } from '../utils/display-safe.js';
import { ProvisioningError } from '../utils/error-handler.js';

/** The types whose create restores from `SourceDBClusterIdentifier`. */
const RESTORING_TYPES: ReadonlySet<string> = new Set(['AWS::Neptune::DBCluster']);

/** Where a call runs, as far as the caller knows. */
export interface RestoreSourceScope {
  region?: string | undefined;
  account?: string | undefined;
}

/** A cluster's name in any spelling AWS takes: an ARN ends in it, and case does not count. */
function clusterName(identifier: string): string {
  return (identifier.split(':').pop() ?? identifier).toLowerCase();
}

/**
 * Whether an ARN names another region or account than `scope`: a same-named
 * cluster there is another cluster. Unknown on either side counts as the same,
 * which keeps the refusal: the deletion it guards cannot be undone.
 */
function elsewhere(identifier: string, scope: RestoreSourceScope): boolean {
  if (!identifier.startsWith('arn:')) return false;
  const [, , , region, account] = identifier.split(':');
  const differs = (carried: string | undefined, known: string | undefined): boolean =>
    Boolean(carried) && known !== undefined && carried !== known;
  return differs(region, scope.region) || differs(account, scope.account);
}

/**
 * Refuses a restore whose source is the very cluster `physicalId` names
 * (#5638). Every delete-first replacement calls this BEFORE its delete: the
 * restore after it would read a source that no longer exists. A final snapshot
 * under `UpdateReplacePolicy: Snapshot` keeps the data, but this restore never
 * reads it. The provider's create calls it too, where a replacement's name may
 * have been generated. `properties` is RESOLVED. A LEAF: the deploy engine must
 * not load a provider to ask.
 */
export function refuseRestoreFromItself(
  resourceType: string,
  properties: Record<string, unknown>,
  physicalId: string,
  logicalId: string,
  scope: RestoreSourceScope
): void {
  if (!RESTORING_TYPES.has(resourceType)) return;
  const source = properties['SourceDBClusterIdentifier'];
  if (typeof source !== 'string' || clusterName(source) !== clusterName(physicalId)) return;
  if (elsewhere(source, scope)) return;
  throw markNonRetryable(
    new ProvisioningError(
      safeMsg`${resourceType} ${logicalId}: SourceDBClusterIdentifier must be another cluster than the one this creates or replaces; nothing was changed.`,
      resourceType,
      logicalId,
      physicalId
    )
  );
}
