/**
 * AWS partition / URL-suffix derivation, shared across layers.
 *
 * Lives in `src/utils/` because it has consumers in two different layers: the
 * `cdkd local *` command family (which passes a region in once to keep the STS
 * hop minimal) and the provisioning layer's `AppSyncProvider`, which rebuilds a
 * child resource's ARN when AWS did not report one.
 *
 * It was originally defined in `src/local/ecs-task-resolver.ts`, which
 * re-exports it so every existing call site is unchanged; a provisioning
 * provider importing from `src/local/**` would invert the layering.
 *
 * NOTE this is the mapping to prefer over `getAccountInfo().partition`
 * (`src/deployment/intrinsic-function-resolver.ts`), which is hardcoded to
 * `'aws'` and says so in its own comment.
 */

/**
 * Derive the AWS partition / URL suffix for an AWS region. Same mapping
 * CloudFormation applies to `${AWS::Partition}` / `${AWS::URLSuffix}`.
 */
export function derivePartitionAndUrlSuffix(region: string): {
  partition: string;
  urlSuffix: string;
} {
  if (region.startsWith('cn-')) return { partition: 'aws-cn', urlSuffix: 'amazonaws.com.cn' };
  if (region.startsWith('us-gov-')) return { partition: 'aws-us-gov', urlSuffix: 'amazonaws.com' };
  if (region.startsWith('us-iso-')) return { partition: 'aws-iso', urlSuffix: 'c2s.ic.gov' };
  if (region.startsWith('us-isob-')) return { partition: 'aws-iso-b', urlSuffix: 'sc2s.sgov.gov' };
  return { partition: 'aws', urlSuffix: 'amazonaws.com' };
}
