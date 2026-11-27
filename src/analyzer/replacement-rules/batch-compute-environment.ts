import { isDeepStrictEqual } from 'node:util';
import type { ReplacementSiblings } from './types.js';

/**
 * The `ComputeResources` members whose change AWS Batch can apply only as an
 * infrastructure update (go-to-k/cdkd#7098). MEASURED through Cloud Control
 * (us-east-1, 2026-11-27, #7083): on an EC2 environment created with
 * BEST_FIT_PROGRESSIVE, `InstanceTypes` and `Tags` applied in place under the
 * same ARN when the update model carried `ReplaceComputeEnvironment: false`.
 * With it `true` or absent, every member here answered `NotUpdatable`. That
 * covers `Type` too (EC2 -> SPOT, and FARGATE -> FARGATE_SPOT). `Subnets`,
 * `SecurityGroupIds` and the vCPU counts applied in place either way, so they
 * are not listed.
 */
const INFRASTRUCTURE_UPDATE_MEMBERS = [
  'AllocationStrategy',
  'BidPercentage',
  'Ec2Configuration',
  'Ec2KeyPair',
  'ImageId',
  'InstanceRole',
  'InstanceTypes',
  'LaunchTemplate',
  'PlacementGroup',
  'Tags',
  'Type',
] as const;

/** `ComputeResources` paths the registry schema makes create-only: always a replacement. */
const CREATE_ONLY_PATHS: ReadonlyArray<readonly string[]> = [
  ['SpotIamFleetRole'],
  ['ManagedInstancesProvider', 'InstanceLaunchTemplate', 'CapacityOptionType'],
  ['ManagedInstancesProvider', 'InstanceLaunchTemplate', 'FipsEnabled'],
];

function at(value: unknown, path: readonly string[]): unknown {
  let cursor = value;
  for (const segment of path) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** `false` / `"false"` is false; anything else, absence included, is CloudFormation's default `true`. */
function replacesComputeEnvironment(value: unknown): boolean {
  return !(value === false || value === 'false');
}

/**
 * Conditional-replacement predicate for `AWS::Batch::ComputeEnvironment`
 * `ComputeResources` (go-to-k/cdkd#7098). A change to a schema create-only
 * member always replaces. A change to an infrastructure-update member
 * replaces unless the desired template sets `ReplaceComputeEnvironment:
 * false`, which is CloudFormation's documented switch and the shape measured
 * applying in place. CDK's L2 `ManagedEc2EcsComputeEnvironment` emits `false`
 * by default, so an L2 environment keeps its in-place update. Anything else
 * (`Subnets`, `SecurityGroupIds`, vCPU counts) stays in place.
 *
 * Without the sibling bags the common case answers in place, as the other
 * sibling predicates do.
 */
export function batchComputeResourcesChangeReplaces(
  oldValue: unknown,
  newValue: unknown,
  siblings?: ReplacementSiblings
): boolean {
  if (CREATE_ONLY_PATHS.some((p) => !isDeepStrictEqual(at(oldValue, p), at(newValue, p)))) {
    return true;
  }
  const infrastructureChanged = INFRASTRUCTURE_UPDATE_MEMBERS.some(
    (member) => !isDeepStrictEqual(at(oldValue, [member]), at(newValue, [member]))
  );
  if (!infrastructureChanged || siblings === undefined) return false;
  return replacesComputeEnvironment(siblings.newProperties['ReplaceComputeEnvironment']);
}
