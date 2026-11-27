import type { CloudFormationTemplate } from '../../types/resource.js';
import type { ResourceChange } from '../../types/state.js';

/**
 * The version property `UpdatePolicy.EnableVersionUpgrade` upgrades in place,
 * per type.
 */
export const VERSION_UPGRADE_PROPERTIES: ReadonlyMap<string, string> = new Map([
  ['AWS::Elasticsearch::Domain', 'ElasticsearchVersion'],
]);

/**
 * `UpdatePolicy.EnableVersionUpgrade` is a literal `true` / `"true"`. An
 * intrinsic (an `Fn::If`) reads as false: the diff then plans the replacement
 * and the stateful gate refuses it before any call, the safe side.
 */
export function enablesVersionUpgrade(updatePolicy: unknown): boolean {
  if (typeof updatePolicy !== 'object' || updatePolicy === null) return false;
  const value = (updatePolicy as Record<string, unknown>)['EnableVersionUpgrade'];
  return value === true || value === 'true';
}

/**
 * go-to-k/cdkd#7130: an Elasticsearch domain whose template declares
 * `UpdatePolicy: { EnableVersionUpgrade: true }` is never replaced on an
 * `ElasticsearchVersion` change. MEASURED against CloudFormation (us-east-1,
 * t3.small): without the policy, 7.9 -> 7.10 failed "CloudFormation cannot
 * update a stack when a custom-named resource requires replacing", so it
 * replaces; under the policy, CloudFormation upgrades the domain in place.
 *
 * Runs on every diff, whatever `--update-policy` says: it only ever removes a
 * replacement.
 */
export function keepVersionUpgradeInPlace(
  changes: Map<string, ResourceChange>,
  desiredTemplate: CloudFormationTemplate
): void {
  for (const [logicalId, change] of changes) {
    if (change.changeType !== 'UPDATE') continue;
    const property = VERSION_UPGRADE_PROPERTIES.get(change.resourceType);
    if (property === undefined) continue;
    if (!enablesVersionUpgrade(desiredTemplate.Resources[logicalId]?.UpdatePolicy)) continue;
    for (const pc of change.propertyChanges ?? []) {
      const top = pc.path.split(/[.[]/)[0] ?? pc.path;
      if (top === property) pc.requiresReplacement = false;
    }
  }
}
