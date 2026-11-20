import type { CloudFormationTemplate } from '../../types/resource.js';
import type { ResourceChange, ResourceState } from '../../types/state.js';
import { isLegacyHandleId } from '../../provisioning/wait-condition-handle-id.js';

/** Why the row updates, shown by `cdkd diff` and the deploy plan. */
export const LEGACY_HANDLE_HEAL_REASON =
  'issues a signal URL in place of the placeholder id an earlier cdkd recorded';

/**
 * go-to-k/cdkd#6704: a `AWS::CloudFormation::WaitConditionHandle` recorded
 * before #6694 holds a placeholder id with no URL behind it, and the type has
 * no properties, so no template edit ever re-creates it. When a
 * `AWS::CloudFormation::WaitCondition` in the template waits on the handle —
 * the one case that would otherwise be refused — its row becomes an UPDATE the
 * handle provider carries out by issuing a URL, and the returned ids seed the
 * replacement pass so every reader of the handle's `Ref` is updated after it
 * in the same deploy.
 *
 * Any other reference leaves the handle as it is (the maintainer's call):
 * re-issuing changes every reader, and an EC2 instance whose `UserData`
 * embeds the handle is stopped and started for it, while user data does not
 * run again on a booted instance, so nothing would signal the new URL anyway.
 */
export function markLegacyHandleHeals(
  changes: Map<string, ResourceChange>,
  currentResources: Record<string, ResourceState>,
  desiredTemplate: CloudFormationTemplate,
  extractReferences: (value: unknown) => Set<string>
): string[] {
  const legacy = new Set<string>();
  for (const [logicalId, record] of Object.entries(currentResources)) {
    if (
      record.resourceType === 'AWS::CloudFormation::WaitConditionHandle' &&
      isLegacyHandleId(record.physicalId) &&
      desiredTemplate.Resources[logicalId]?.Type === 'AWS::CloudFormation::WaitConditionHandle'
    ) {
      legacy.add(logicalId);
    }
  }
  if (legacy.size === 0) return [];

  const waitedOn = new Set<string>();
  for (const resource of Object.values(desiredTemplate.Resources)) {
    if (resource.Type !== 'AWS::CloudFormation::WaitCondition') continue;
    for (const ref of extractReferences(resource.Properties?.['Handle'])) {
      if (legacy.has(ref)) waitedOn.add(ref);
    }
  }

  const healed: string[] = [];
  for (const handleId of waitedOn) {
    const change = changes.get(handleId);
    if (change === undefined) continue;
    if (change.changeType !== 'NO_CHANGE' && change.changeType !== 'UPDATE') continue;
    change.changeType = 'UPDATE';
    change.propertyChanges ??= [];
    change.providerReplacement = LEGACY_HANDLE_HEAL_REASON;
    healed.push(handleId);
  }
  return healed;
}
