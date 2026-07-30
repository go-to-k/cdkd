/**
 * Deletion-protection properties for Cloud-Control-routed resource types.
 *
 * Cloud Control's DeleteResource has no notion of deletion protection: a
 * protected resource simply fails to delete. For types WITH an SDK provider,
 * `--remove-protection` is implemented inside each provider's `delete()`
 * (RDS / DynamoDB / Cognito / etc.), and two special cases are hardcoded in
 * `CloudControlProvider.delete` (ASG delegation, EC2 `DisableApiTermination`).
 * This registry covers the remaining case: a CC-routed type whose protection
 * is an ordinary top-level boolean template property that can be flipped off
 * in-place via a CC UpdateResource patch right before DeleteResource.
 *
 * Only add entries verified against real AWS (the property name must match
 * the type's CFn schema exactly, and the type's UPDATE handler must support
 * flipping it in-place). Candidates such as `AWS::QLDB::Ledger`
 * (`DeletionProtection`) or `AWS::RDS::GlobalCluster` (`DeletionProtection`)
 * can join once live-verified — see issue #1312.
 */
const CC_PROTECTION_PROPERTIES: Record<string, string> = {
  // Verified via tests/integration/dsql (issue #1312).
  'AWS::DSQL::Cluster': 'DeletionProtectionEnabled',
};

/**
 * Returns the top-level protection property name for a CC-routed resource
 * type, or undefined when the type has no registered protection property.
 */
export function ccProtectionProperty(resourceType: string): string | undefined {
  return CC_PROTECTION_PROPERTIES[resourceType];
}
