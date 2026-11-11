import { markNonRetryable } from '../deployment/retryable-errors.js';
import { safeMsg } from '../utils/display-safe.js';
import { ProvisioningError } from '../utils/error-handler.js';

/** The types whose create restores from `SourceDBClusterIdentifier`. */
const RESTORING_TYPES: ReadonlySet<string> = new Set([
  'AWS::DocDB::DBCluster',
  'AWS::Neptune::DBCluster',
  'AWS::RDS::DBCluster',
]);

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
 * Whether `snapshot` is one of the automated snapshots of cluster `name`
 * (`rds:<cluster>-YYYY-MM-DD-HH-MM`, or its ARN): AWS deletes those with the
 * cluster, where a manual snapshot survives it (go-to-k/cdkd#5628).
 */
function automatedSnapshotOf(snapshot: string, name: string): boolean {
  const id = snapshot.startsWith('arn:')
    ? (snapshot.split(':cluster-snapshot:')[1] ?? '')
    : snapshot;
  const match = /^rds:(.+)-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/i.exec(id);
  return match !== null && match[1]!.toLowerCase() === name;
}

/**
 * Refuses a restore whose source is the very cluster `physicalId` names
 * (#5638), or one of that cluster's automated snapshots, which its delete
 * removes too (go-to-k/cdkd#5628). Every delete-first replacement calls this BEFORE its delete: the
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
  const snapshot = properties['SnapshotIdentifier'];
  if (
    typeof snapshot === 'string' &&
    automatedSnapshotOf(snapshot, clusterName(physicalId)) &&
    !elsewhere(snapshot, scope)
  ) {
    throw markNonRetryable(
      new ProvisioningError(
        safeMsg`${resourceType} ${logicalId}: SnapshotIdentifier names an automated snapshot of the cluster this creates or replaces, which its delete removes; restore from a manual snapshot instead. Nothing was changed.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
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
