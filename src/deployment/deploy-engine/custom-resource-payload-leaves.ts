import type { CloudFormationTemplate } from '../../types/resource.js';
import type { ResourceState } from '../../types/state.js';
import { isCustomResourceType } from '../../provisioning/custom-resource-secure-references.js';
import { typedPayloadLeavesOf } from '../../provisioning/custom-resource-payload-types.js';

/**
 * go-to-k/cdkd#6309: for a custom resource, the `typedPayloadLeaves` of the
 * bag this deploy resolved from `template`: handed to the provider's create /
 * update and recorded beside `properties`, so a later `Update` (as
 * `OldResourceProperties`) and `Delete` type the bag the way the template
 * that wrote it did. `undefined` for any other type, or with no template bag,
 * which records nothing.
 * CPU only, over the one resource's bag: no AWS call.
 */
export function customResourcePayloadLeaves(
  resourceType: string,
  templateProperties: unknown,
  resolvedProperties: Record<string, unknown>,
  template: CloudFormationTemplate | undefined,
  conditions: Readonly<Record<string, boolean>> | undefined,
  stateResources: Readonly<Record<string, ResourceState>>
): (string | number)[][] | undefined {
  // No template bag: the positions are not known (the pre-#6309 rule).
  if (!isCustomResourceType(resourceType) || templateProperties === undefined) return undefined;
  return typedPayloadLeavesOf(templateProperties, resolvedProperties, {
    conditions,
    resourceTypeOf: (id) =>
      template?.Resources?.[id]?.Type ??
      (Object.hasOwn(stateResources, id) ? stateResources[id]?.resourceType : undefined),
  }).map((coordinate) => [...coordinate]);
}

/** The record field for `leaves`: nothing when they are not known. */
export function customResourcePayloadLeavesField(leaves: (string | number)[][] | undefined): {
  typedPayloadLeaves?: (string | number)[][];
} {
  return leaves === undefined ? {} : { typedPayloadLeaves: leaves };
}
