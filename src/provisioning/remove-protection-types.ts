import { ccProtectionRegistryTypes } from './cc-protection-properties.js';

/**
 * The resource types whose SDK provider's `delete()` flips a protection flag
 * off under `DeleteContext.removeProtection` (issue
 * [#2660](https://github.com/go-to-k/cdkd/issues/2660)).
 *
 * This is the ONE list the `--remove-protection` help strings render from, on
 * `cdkd destroy` and `cdkd state destroy`. The Cloud Control half comes from
 * {@link ccProtectionRegistryTypes}. Both copies of the help were hand-written
 * before, and two types the providers honour (`AWS::EMR::Cluster`,
 * `AWS::DynamoDB::GlobalTable`) were missing from both.
 *
 * `tests/unit/provisioning/remove-protection-types.test.ts` binds this list to
 * the provider tree in both directions: each type's registered provider reads
 * `removeProtection`, and each provider file that reads it registers at least
 * one type here. A new provider gaining the flip fails that test until its type
 * is added.
 */
export const SDK_REMOVE_PROTECTION_TYPES: readonly string[] = [
  'AWS::Logs::LogGroup',
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBCluster',
  'AWS::DocDB::DBCluster',
  'AWS::Neptune::DBCluster',
  'AWS::Neptune::DBInstance',
  'AWS::DynamoDB::Table',
  'AWS::DynamoDB::GlobalTable',
  'AWS::EC2::Instance',
  'AWS::Cognito::UserPool',
  'AWS::AutoScaling::AutoScalingGroup',
  'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'AWS::EMR::Cluster',
];

/** Every type `--remove-protection` covers: the SDK list, then the Cloud Control registry. */
export function removeProtectionTypes(): string[] {
  return [...SDK_REMOVE_PROTECTION_TYPES, ...ccProtectionRegistryTypes()];
}

/** The types as the help prints them: `A, B, and C`. */
export function removeProtectionTypeList(): string {
  const types = removeProtectionTypes();
  if (types.length < 2) return types.join('');
  return `${types.slice(0, -1).join(', ')}, and ${types[types.length - 1]!}`;
}
