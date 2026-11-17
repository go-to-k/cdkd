import type { CloudFormationTemplate } from '../../types/resource.js';
import type { ResourceChange } from '../../types/state.js';
import {
  REPLACEMENT_TRIGGER_PROPERTIES,
  changedTriggers,
  willReplaceGroup,
} from '../../provisioning/providers/asg/update-policy.js';

/**
 * go-to-k/cdkd#6437: under `--update-policy`, an Auto Scaling group whose
 * template declares `AutoScalingReplacingUpdate` with `WillReplace: true` is
 * REPLACED when its update changes a trigger property
 * ({@link REPLACEMENT_TRIGGER_PROPERTIES}). Decided here, in the diff, so the
 * replacement is seen where every other one is: the reader promotion re-points
 * the group's `Ref` / `Fn::GetAtt` readers (a scaling policy, a lifecycle
 * hook) at the new group, the plan-time prompt and `cdkd diff` show a
 * replacement, and the generated-name guard plans the next name.
 *
 * Each trigger property change is marked `requiresReplacement` and
 * `updatePolicyReplacement` (so the engine knows the policy, not the type,
 * asked for it); a `requiresReplacement` change is what seeds the
 * replacement pass.
 * A change the promotion made (a launch template version read through
 * `Fn::GetAtt`) keeps its ceiling flags, so the engine replaces only when
 * the resolved value moved. Idempotent; called before each replacement pass.
 */
export function markUpdatePolicyReplacements(
  changes: Map<string, ResourceChange>,
  desiredTemplate: CloudFormationTemplate
): void {
  for (const [logicalId, change] of changes) {
    if (change.changeType !== 'UPDATE') continue;
    if (change.resourceType !== 'AWS::AutoScaling::AutoScalingGroup') continue;
    const updatePolicy = desiredTemplate.Resources[logicalId]?.UpdatePolicy;
    if (typeof updatePolicy !== 'object' || updatePolicy === null) continue;
    if (!willReplaceGroup(updatePolicy as Record<string, unknown>)) continue;
    for (const pc of change.propertyChanges ?? []) {
      if (pc.noEchoPromoted === true) continue;
      const top = pc.path.split(/[.[]/)[0] ?? pc.path;
      if (!REPLACEMENT_TRIGGER_PROPERTIES.includes(top)) continue;
      // The provider's own reading of a template edit: a reordered subnet
      // list or `2` against `'2'` is no change. A propagated value is left
      // to the engine, which lowers it when the resolved value did not move.
      if (
        pc.inPlacePropagated !== true &&
        pc.replacementPropagated !== true &&
        changedTriggers([top], change.desiredProperties ?? {}, change.currentProperties ?? {})
          .length === 0
      ) {
        continue;
      }
      pc.requiresReplacement = true;
      pc.updatePolicyReplacement = true;
    }
  }
}
