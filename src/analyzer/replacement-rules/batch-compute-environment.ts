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

/**
 * `ComputeResources` paths the registry schema makes create-only: always a
 * replacement. The hand rule owns the whole property, so the schema fallback
 * no longer reads them; a test holds this list equal to the committed schema
 * snapshot.
 */
export const CREATE_ONLY_PATHS: ReadonlyArray<readonly string[]> = [
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

/**
 * Why Batch refuses this environment any infrastructure update, or undefined.
 * MEASURED with the Batch API and Cloud Control (us-east-1, 2026-11-27, #7098),
 * `ReplaceComputeEnvironment: false` sent: a FARGATE / FARGATE_SPOT environment
 * answers "The following parameters can't be updated for Fargate compute
 * environment: allocationStrategy, ..., type", and an EC2 / SPOT environment
 * whose allocation strategy is BEST_FIT (the default when unset) answers
 * "Fields allocationStrategy, ..., securityGroupIds, subnets, tags, type, ...".
 */
function noInfrastructureUpdate(current: unknown): 'fargate' | 'best-fit' | undefined {
  const type = at(current, ['Type']);
  if (type === 'FARGATE' || type === 'FARGATE_SPOT') return 'fargate';
  const strategy = at(current, ['AllocationStrategy']);
  return strategy === undefined || strategy === 'BEST_FIT' ? 'best-fit' : undefined;
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
 * applying in place. On a Fargate or BEST_FIT environment, which Batch never
 * updates that way, it replaces regardless, and on BEST_FIT so does a subnet
 * or security-group change. CDK's L2 `ManagedEc2EcsComputeEnvironment` emits
 * `false` and BEST_FIT_PROGRESSIVE by default, so an L2 EC2 environment keeps
 * its in-place update. Anything else (`Subnets`, `SecurityGroupIds` and vCPU
 * counts elsewhere) stays in place.
 *
 * Without the sibling bags the common case answers in place, as the other
 * sibling predicates do. Known residue: a synthetic probe with no values (an
 * in-place promotion of a member read from a same-deploy update, such as a
 * `LaunchTemplate.Version` from `GetAtt LatestVersionNumber`) answers in place
 * too, as it did before this rule.
 */
export function batchComputeResourcesChangeReplaces(
  oldValue: unknown,
  newValue: unknown,
  siblings?: ReplacementSiblings
): boolean {
  if (CREATE_ONLY_PATHS.some((p) => !isDeepStrictEqual(at(oldValue, p), at(newValue, p)))) {
    return true;
  }
  const changed = (member: string): boolean =>
    !isDeepStrictEqual(at(oldValue, [member]), at(newValue, [member]));
  if (!INFRASTRUCTURE_UPDATE_MEMBERS.some(changed)) {
    // A BEST_FIT environment takes no infrastructure update at all, so its
    // subnets and security groups cannot move in place either.
    return (
      noInfrastructureUpdate(oldValue) === 'best-fit' &&
      (changed('Subnets') || changed('SecurityGroupIds'))
    );
  }
  // Batch itself refuses these environments any infrastructure update, so
  // nothing but a replacement applies the change, whatever the template says.
  if (noInfrastructureUpdate(oldValue) !== undefined) return true;
  if (siblings === undefined) return false;
  return replacesComputeEnvironment(siblings.newProperties['ReplaceComputeEnvironment']);
}
