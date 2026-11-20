import type { CloudFormationTemplate } from '../../types/resource.js';
import type { ResourceChange, ResourceState } from '../../types/state.js';
import { isLegacyHandleId } from '../../provisioning/wait-condition-handle-id.js';

/** Why the row updates, shown by `cdkd diff` and the deploy plan. */
export const LEGACY_HANDLE_HEAL_REASON =
  'issues a signal URL in place of the placeholder id an earlier cdkd recorded';

/**
 * go-to-k/cdkd#6704: a `AWS::CloudFormation::WaitConditionHandle` recorded
 * before #6694 holds a placeholder id with no URL behind it, and the type has
 * no properties, so no template edit ever re-creates it. When another
 * resource references the handle (user data that signals it, a wait
 * condition) or an output exposes it, its row becomes an UPDATE the handle provider carries out by
 * issuing a URL; the returned ids seed the replacement pass, so every reader
 * of the handle's `Ref` is updated after it in the same deploy. An
 * unreferenced handle (a placeholder resource such as
 * `cdk-multi-region-stack`'s) is left as it is: nothing could use a URL.
 */
export function markLegacyHandleHeals(
  changes: Map<string, ResourceChange>,
  currentResources: Record<string, ResourceState>,
  desiredTemplate: CloudFormationTemplate,
  extractReferences: (value: unknown) => Set<string>
): string[] {
  const legacy: string[] = [];
  for (const [logicalId, record] of Object.entries(currentResources)) {
    if (
      record.resourceType === 'AWS::CloudFormation::WaitConditionHandle' &&
      isLegacyHandleId(record.physicalId) &&
      desiredTemplate.Resources[logicalId]?.Type === 'AWS::CloudFormation::WaitConditionHandle'
    ) {
      legacy.push(logicalId);
    }
  }
  if (legacy.length === 0) return [];

  const referenced = new Set<string>();
  const noteReferences = (refs: Set<string>, self?: string): void => {
    for (const handleId of legacy) {
      if (handleId !== self && refs.has(handleId)) referenced.add(handleId);
    }
  };
  for (const [logicalId, resource] of Object.entries(desiredTemplate.Resources)) {
    noteReferences(extractReferences(resource.Properties ?? {}), logicalId);
  }
  // An output exposing the handle hands its URL to whoever reads the stack.
  for (const output of Object.values(desiredTemplate.Outputs ?? {})) {
    noteReferences(extractReferences(output));
  }

  const healed: string[] = [];
  for (const handleId of referenced) {
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
