import { EcsTaskResolutionError } from 'cdk-local/internal';

export type {
  ResolvedEcsTask,
  ResolvedEcsContainer,
  ResolvedEcsImage,
  ResolvedEcsVolume,
  EcsImageResolutionContext,
  ParsedEcsTarget,
  EcsImageResolutionNeeds,
} from './ecs-task-resolver/types.js';
export { detectEcsImageResolutionNeeds } from './ecs-task-resolver/needs.js';
export { parseEcsTarget, resolveEcsTaskTarget } from './ecs-task-resolver/target.js';
export { assertEcsTaskImagesResolvable } from './ecs-task-resolver/image.js';
export { TASK_ROLE_ACCOUNT_PLACEHOLDER } from './ecs-task-resolver/role-arn.js';
export { checkVolumeHostPath } from './ecs-task-resolver/volume.js';
export { applyCrossStackResolverToTask } from './ecs-task-resolver/cross-stack.js';

// Re-exported from cdk-local so this still-local module, the shimmed
// `cloud-map-resolver` (which throws it), and every host-side
// `instanceof` / `toThrow(EcsTaskResolutionError)` share ONE class identity
// across the package boundary.
export { EcsTaskResolutionError };

/**
 * Derive the AWS partition / URL suffix for an AWS region.
 *
 * The IMPLEMENTATION moved to `src/utils/aws-partition.ts` (issue #1681 PR
 * review): it gained a consumer in the provisioning layer, and a provider
 * importing from `src/local/**` would invert the layering. Re-exported here so
 * every existing `cdkd local *` call site is unchanged.
 */
export { derivePartitionAndUrlSuffix } from '../utils/aws-partition.js';
