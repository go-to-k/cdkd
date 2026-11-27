import type { CloudFormationTemplate } from '../../types/resource.js';
import type { ResourceChange } from '../../types/state.js';

/** The replication-group properties `UseOnlineResharding` keeps from replacing. */
export const ONLINE_RESHARDING_PROPERTIES: readonly string[] = [
  'NumNodeGroups',
  'NodeGroupConfiguration',
];

/**
 * `UpdatePolicy.UseOnlineResharding` is a literal `true` / `"true"`. An
 * intrinsic (an `Fn::If`) reads as false: the diff then plans the replacement
 * and the stateful gate refuses it before any call, the safe side.
 */
export function usesOnlineResharding(updatePolicy: unknown): boolean {
  if (typeof updatePolicy !== 'object' || updatePolicy === null) return false;
  const value = (updatePolicy as Record<string, unknown>)['UseOnlineResharding'];
  return value === true || value === 'true';
}

/**
 * go-to-k/cdkd#7100: an ElastiCache replication group whose template declares
 * `UpdatePolicy: { UseOnlineResharding: true }` is never replaced on a
 * `NumNodeGroups` / `NodeGroupConfiguration` change. MEASURED against
 * CloudFormation (us-east-1, 2026-11-27, cluster-mode-enabled Redis 7.1,
 * `default.redis7.cluster.on`): under the policy, NumNodeGroups 1 -> 2
 * resharded in place under the same physical id, and a NodeGroupConfiguration
 * ReplicaCount change failed the update (the handler refused it) without a
 * replacement. Without the policy, both replaced the group.
 *
 * cdkd has no online-resharding path, so the change goes to Cloud Control in
 * place, which refuses it before applying anything (`NotUpdatable`); the
 * refusal's remedy names CloudFormation's online resharding. Never a
 * replacement: the group is stateful and CloudFormation keeps its data.
 * Runs on every diff, whatever `--update-policy` says: it only ever removes a
 * replacement.
 */
export function keepOnlineReshardingInPlace(
  changes: Map<string, ResourceChange>,
  desiredTemplate: CloudFormationTemplate
): void {
  for (const [logicalId, change] of changes) {
    if (change.changeType !== 'UPDATE') continue;
    if (change.resourceType !== 'AWS::ElastiCache::ReplicationGroup') continue;
    if (!usesOnlineResharding(desiredTemplate.Resources[logicalId]?.UpdatePolicy)) continue;
    for (const pc of change.propertyChanges ?? []) {
      const top = pc.path.split(/[.[]/)[0] ?? pc.path;
      if (ONLINE_RESHARDING_PROPERTIES.includes(top)) pc.requiresReplacement = false;
    }
  }
}
