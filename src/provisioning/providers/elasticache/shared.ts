import { safeMsg } from '../../../utils/display-safe.js';
import { slowCcOperationTimeoutMs } from '../../slow-cc-operation-timeouts.js';

/**
 * How long a cache-cluster delete waits for the cluster to be gone: the Cloud
 * Control route's own DELETE floor for the type. A Redis delete can pass ten
 * minutes, and a timeout here left the cluster `deleting` with the delete
 * reported failed (issue #4029, measured by `cc-final-snapshot-handlers`).
 */
export const CACHE_DELETE_WAIT_MS = Math.max(
  600_000,
  slowCcOperationTimeoutMs('AWS::ElastiCache::CacheCluster', 'DELETE')
);

/**
 * How long an update waits for the cluster to report its template
 * `CacheNodeType` (issue #5438): a cache.t4g scale took about ten minutes on
 * both engines, past the 10-minute cap other modifies use. It matches the
 * type's UPDATE floor in `slow-cc-operation-timeouts.ts` (60 minutes), which
 * also lifts the engine's update deadline for the type, so the engine does
 * not give up on a scale this wait is still following.
 */
export const NODE_TYPE_MODIFY_WAIT_MS = Math.max(
  60 * 60_000,
  slowCcOperationTimeoutMs('AWS::ElastiCache::CacheCluster', 'UPDATE')
);

/**
 * How long after the Modify an `available` cluster still showing the old
 * state, with nothing of the change pending -- the old node type (#5438), or
 * a node it was told to remove (#5441) -- counts as a change AWS dropped
 * rather than one not yet started (AWS logged "Applying modification" about
 * 20 seconds after the Modify in the #5438 measurements).
 */
export const MODIFY_DROPPED_AFTER_MS = 2 * 60_000;

/**
 * `CacheClusterStatus` values (the SDK's documented set) a cluster does not
 * leave without a user action, so the available-wait fails on them at once:
 * `restore-failed` (a seed RDB from SnapshotArns it could not load; AWS's
 * guide says delete the cluster and start over) and `incompatible-network`.
 */
export const TERMINAL_CLUSTER_STATUSES: ReadonlySet<string> = new Set([
  'restore-failed',
  'incompatible-network',
]);

/**
 * The members of `a` left after taking out one occurrence per member of `b`
 * (a multiset difference): the Availability Zones a desired
 * `PreferredAvailabilityZones` list asks for that no live node occupies.
 */
export function availabilityZonesNotCovered(a: readonly string[], b: readonly string[]): string[] {
  const remaining = [...b];
  const out: string[] = [];
  for (const az of a) {
    const i = remaining.indexOf(az);
    if (i >= 0) remaining.splice(i, 1);
    else out.push(az);
  }
  return out;
}

/**
 * The cache node ids a `NumCacheNodes` decrease removes, matching what
 * CloudFormation sent (issue #5441, CloudTrail on real change-set runs,
 * memcached, us-east-1): it keeps the nodes with the HIGHEST ids --
 * 3 nodes to 1 removed `0001, 0002`; two nodes in us-east-1a and one in
 * us-east-1c, to `[us-east-1c, us-east-1a]`, removed the lower us-east-1a
 * node -- and, with a desired `PreferredAvailabilityZones`, keeps only nodes
 * whose zone the list still names (`[1a, 1b, 1c]` to `[1a, 1c]` removed the
 * us-east-1b node). Returned lowest id first, as CloudFormation sent them.
 *
 * `undefined` when the kept nodes cannot reach the desired count without
 * adding a node in a new zone: a removal and an addition in one update.
 */
export function nodesToRemove(
  nodes: readonly { id: string | undefined; zone: string | undefined }[],
  desiredCount: number,
  desiredZones: readonly string[] | undefined
): string[] | undefined {
  const remainingZones = desiredZones === undefined ? undefined : [...desiredZones];
  // A node the describe gives no id cannot be named for removal: keep it.
  const named = nodes.filter(
    (n): n is { id: string; zone: string | undefined } => n.id !== undefined
  );
  const keep = new Set<string>();
  const unnamed = nodes.length - named.length;
  const byIdDesc = [...named].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  for (const node of byIdDesc) {
    if (keep.size + unnamed >= desiredCount) break;
    if (remainingZones === undefined) {
      keep.add(node.id);
      continue;
    }
    const i = node.zone === undefined ? -1 : remainingZones.indexOf(node.zone);
    if (i >= 0) {
      remainingZones.splice(i, 1);
      keep.add(node.id);
    }
  }
  if (keep.size + unnamed < desiredCount) return undefined;
  return named
    .map((n) => n.id)
    .filter((id) => !keep.has(id))
    .sort();
}

/**
 * `AWS::ElastiCache::CacheCluster` properties whose REMOVAL from the template
 * leaves the live value in place (issue #1160): ModifyCacheCluster keeps a
 * member it is not sent, and cdkd sends none of these on removal, because
 * CloudFormation keeps each of them too. Measured with real CloudFormation
 * stacks in us-east-1, each property set to a non-default value at create and
 * then removed, read back for minutes after the update:
 *
 * - #5545 (2026-10-30), redis 7.0 and memcached 1.6.17 dual_stack clusters,
 *   alone and beside a changed SnapshotRetentionLimit / maintenance window
 *   (the companion change landed): EngineVersion stayed 7.0.7 / 1.6.17, the
 *   custom CacheParameterGroupName stayed (no move to `default.<family>`),
 *   PreferredMaintenanceWindow and SnapshotWindow stayed, and a memcached
 *   IpDiscovery `ipv6` stayed (a redis CacheCluster refuses IpDiscovery at
 *   create: "cannot be chosen for cluster mode disabled"). CloudTrail showed
 *   CloudFormation's ModifyCacheCluster carrying none of the five. On a
 *   memcached cluster, removing TransitEncryptionEnabled (true) or
 *   PreferredAvailabilityZone, each alone, was an in-place update that kept
 *   encryption on and the node's zone.
 * - #5004: SnapshotRetentionLimit, AutoMinorVersionUpgrade,
 *   NotificationTopicArn. #5491: VpcSecurityGroupIds.
 *
 * update() names these in its own warning, since the shared caller's line
 * says CloudFormation would reset the value.
 */
export const KEPT_ON_REMOVAL = [
  'EngineVersion',
  'CacheParameterGroupName',
  'PreferredMaintenanceWindow',
  'SnapshotWindow',
  'IpDiscovery',
  'SnapshotRetentionLimit',
  'AutoMinorVersionUpgrade',
  'NotificationTopicArn',
  'VpcSecurityGroupIds',
  'TransitEncryptionEnabled',
  'PreferredAvailabilityZone',
] as const;

/**
 * The {@link KEPT_ON_REMOVAL} members ModifyCacheCluster has no member for:
 * declaring a value cannot change them either, only a replacement can
 * (`warnTransitEncryptionNotApplied`, `warnNotAppliedInPlace`).
 */
export const NOT_MODIFIABLE = new Set<string>([
  'TransitEncryptionEnabled',
  'PreferredAvailabilityZone',
]);

/**
 * Placement removals (go-to-k/cdkd#5558). CloudFormation REPLACES a memcached
 * `single-az` cluster that a removal leaves with no zone, which the
 * replacement rules plan before update() runs, and keeps the nodes where they
 * are otherwise as far as measured (a `cross-az` cluster, or a `single-az`
 * one keeping its zone list: the Modify carried neither member). update()
 * sends nothing for either, and its own line says what was measured rather
 * than "as CloudFormation leaves it", since a shape the rules keep in place
 * may be one nobody measured.
 */
export const PLACEMENT_ON_REMOVAL = ['AZMode', 'PreferredAvailabilityZones'] as const;

/**
 * The warning lines for {@link KEPT_ON_REMOVAL} and
 * {@link PLACEMENT_ON_REMOVAL} removals, one per group that has names. Names
 * are template-borne, so they go through `safeMsg`. A rollback revert
 * restores an earlier state record, so there the property is one the failed
 * deploy ADDED, and the line says only what the rollback does.
 */
export const removalWarnings = (
  logicalId: string,
  kept: readonly string[],
  placement: readonly string[],
  caller: 'deploy' | 'rollback'
): string[] => {
  const lines: string[] = [];
  const head = (names: readonly string[]): string =>
    safeMsg`${logicalId} (AWS::ElastiCache::CacheCluster): ${names.length === 1 ? 'property' : 'properties'} ${names.join(', ')}`;
  if (kept.length > 0) {
    const one = kept.length === 1;
    const fixed = kept.filter((name) => NOT_MODIFIABLE.has(name));
    const replaceNote =
      fixed.length === 0
        ? ''
        : safeMsg` (${fixed.join(', ')} ${fixed.length === 1 ? 'changes' : 'change'} only by replacing the cluster)`;
    lines.push(
      caller === 'rollback'
        ? `${head(kept)} ${one ? 'is' : 'are'} absent from the state being restored; the rollback sends nothing for ${one ? 'it' : 'them'}, so the cluster keeps the value it holds now.`
        : `${head(kept)} ${one ? 'was' : 'were'} removed from the template and ${one ? 'keeps its' : 'keep their'} current AWS value, as CloudFormation leaves ${one ? 'it' : 'them'}; cdkd sends nothing for a removed property. To change a value, declare it explicitly${replaceNote}.`
    );
  }
  if (placement.length > 0) {
    const one = placement.length === 1;
    lines.push(
      caller === 'rollback'
        ? `${head(placement)} ${one ? 'is' : 'are'} absent from the state being restored; the rollback leaves the cluster unchanged.`
        : `${head(placement)} ${one ? 'was' : 'were'} removed from the template; cdkd sends nothing for a removed property, so the nodes stay in their zones. CloudFormation updates a cross-az cluster, or a single-az one that keeps its zone list, in place. It replaces a memcached single-az cluster left with no zone, and cdkd plans that replacement too (go-to-k/cdkd#5558). To move the nodes, replace the cluster, for example by changing its logical ID.`
    );
  }
  return lines;
};
