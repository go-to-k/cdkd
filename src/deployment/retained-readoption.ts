/**
 * go-to-k/cdkd#4705: the stack's retained-resource record (`retained.json`)
 * -- what this stack, under this prefix, let go of while it still exists
 * (`DeletionPolicy: Retain` on a destroy, or on a deploy that removes the
 * resource) and a later create of the same stack here may take back by its
 * generated name. Shared by `cdkd destroy` and the deploy engine.
 */
import type { RetainedResource, S3StateBackend } from '../state/s3-state-backend.js';
import type { ResourceState } from '../types/state.js';
import { replacementCreateAdoptsName } from './replacement-name-holder.js';
import { explicitNamePropertyFor } from '../provisioning/resource-name.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { displayStackName, safeMsg } from '../utils/display-safe.js';

/**
 * go-to-k/cdkd#4705: whether a kept resource is one a later create of the
 * stack would take back by name -- a name-adopting SDK type whose record
 * carries no template name (its name is cdkd-generated), with a physical id.
 */
export function keptForReadoption(resource: ResourceState): resource is ResourceState & {
  physicalId: string;
} {
  if (!replacementCreateAdoptsName(resource.resourceType, resource.provisionedBy)) return false;
  if (typeof resource.physicalId !== 'string' || resource.physicalId === '') return false;
  const property = explicitNamePropertyFor(resource.resourceType);
  const properties = resource.properties as Record<string, unknown> | undefined;
  return property === undefined || !properties?.[property];
}

/**
 * go-to-k/cdkd#4705: merge `kept` into the stack's retained-resource record
 * under this prefix (`S3StateBackend.saveRetainedResources`), replacing an
 * earlier entry of the same logical id. Best-effort: a failure is warned, and
 * the next deploy's create of such a resource is then refused with the
 * `cdkd import` remedy instead of taking it back.
 */
export async function recordRetainedForReadoption(
  backend: Pick<S3StateBackend, 'loadRetainedResources' | 'saveRetainedResources'>,
  stackName: string,
  region: string,
  kept: readonly RetainedResource[],
  logger: { warn(message: string): void }
): Promise<void> {
  if (kept.length === 0) return;
  try {
    const keptIds = new Set(kept.map((k) => k.logicalId));
    // An unreadable record is not overwritten: what it lists would be lost.
    const earlier = await backend.loadRetainedResources(stackName, region);
    await backend.saveRetainedResources(stackName, region, [
      ...earlier.filter((e) => !keptIds.has(e.logicalId)),
      ...kept,
    ]);
  } catch (error) {
    logger.warn(
      safeMsg`Could not record the ${String(kept.length)} kept resource(s) of ${displayStackName(stackName)} ` +
        safeMsg`a later deploy takes back by name (${describeAwsFailure(error).summary}). That deploy ` +
        `refuses to create them over the kept ones; adopt them with 'cdkd import' then.`
    );
  }
}
