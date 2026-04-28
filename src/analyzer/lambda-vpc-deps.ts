/**
 * Lambda VpcConfig implicit deletion dependencies.
 *
 * AWS::Lambda::Function with a VpcConfig holds onto an ENI in the configured
 * subnets / security groups for some time AFTER the function is deleted.
 * If we tear down the VPC's Subnets / SecurityGroups before the ENI is fully
 * detached, the EC2 API rejects the delete with "has dependencies" /
 * "DependencyViolation".
 *
 * The Ref-based dependency expressed by `VpcConfig.SubnetIds: [{ Ref: ... }]`
 * is normally captured by `TemplateParser.extractDependencies` and recorded
 * in `state.dependencies`, which already gives the correct teardown order.
 * This module provides a defense-in-depth, property-based extractor so the
 * ordering still holds when:
 *   - state was written by an older cdkd version that did not record the dep
 *   - extractDependencies misses a wrapping intrinsic for some reason
 *
 * The returned edges express: "the Lambda must be deleted BEFORE each
 * referenced Subnet / SecurityGroup".
 */
import type { TemplateResource } from '../types/resource.js';

/** A single dependency edge for the DELETE phase. */
export interface DeleteDepEdge {
  /** Logical ID that must be deleted FIRST. */
  before: string;
  /** Logical ID that must be deleted AFTER `before`. */
  after: string;
}

/**
 * Minimal shape used by extractLambdaVpcDeleteDeps: a logical-ID-keyed map of
 * resources where each entry exposes a CloudFormation-style `Type` and
 * `Properties`. Both `TemplateResource` and the ad-hoc per-stack template
 * built in destroy.ts conform to this.
 */
export type ResourceLike = Pick<TemplateResource, 'Type' | 'Properties'>;

/**
 * Extract implicit delete edges for AWS::Lambda::Function with a VpcConfig.
 *
 * For each Lambda function in the input map, scans
 * `Properties.VpcConfig.SubnetIds` and `Properties.VpcConfig.SecurityGroupIds`
 * for `{ Ref: <logicalId> }` / `{ "Fn::GetAtt": [<logicalId>, ...] }`
 * references. Every referenced ID that exists in the input map produces an
 * edge `{ before: <lambdaId>, after: <targetId> }`.
 *
 * Notes:
 *  - Properties already resolved to physical IDs (state.properties after
 *    deploy) yield no edges. That is intentional — in that case the caller
 *    should rely on `state.dependencies`, which preserves logical IDs.
 *  - Self-edges and edges pointing to absent IDs are filtered out.
 *  - Returned edges are de-duplicated.
 */
export function extractLambdaVpcDeleteDeps(
  resources: Record<string, ResourceLike>
): DeleteDepEdge[] {
  const edges: DeleteDepEdge[] = [];
  const seen = new Set<string>();

  for (const [lambdaId, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::Lambda::Function') continue;

    const vpcConfig = (resource.Properties ?? {})['VpcConfig'];
    if (!isObject(vpcConfig)) continue;

    const targets = new Set<string>();
    collectRefIds(vpcConfig['SubnetIds'], targets);
    collectRefIds(vpcConfig['SecurityGroupIds'], targets);

    for (const targetId of targets) {
      if (targetId === lambdaId) continue;
      if (!(targetId in resources)) continue;
      const key = `${lambdaId}\u0000${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ before: lambdaId, after: targetId });
    }
  }

  return edges;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Walk `value` (typically an array) and collect every logical ID referenced
 * via `{ Ref: ... }` or `{ "Fn::GetAtt": [<id>, ...] }`. Pseudo parameters
 * (Refs starting with `AWS::`) are skipped.
 */
function collectRefIds(value: unknown, out: Set<string>): void {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const item of value) collectRefIds(item, out);
    return;
  }

  if (!isObject(value)) return;

  if (typeof value['Ref'] === 'string') {
    const ref = value['Ref'];
    if (!ref.startsWith('AWS::')) out.add(ref);
    return;
  }

  if (Array.isArray(value['Fn::GetAtt'])) {
    const arr = value['Fn::GetAtt'];
    if (typeof arr[0] === 'string') out.add(arr[0]);
    return;
  }

  // Other intrinsics (Fn::Join, Fn::If, ...) cannot be statically resolved
  // without a full IntrinsicResolver pass; the regular extractDependencies
  // path handles those at deploy time.
}
