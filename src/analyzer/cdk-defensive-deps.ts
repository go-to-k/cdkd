import type { CloudFormationTemplate, TemplateResource } from '../types/resource.js';

/**
 * CDK-injected defensive `DependsOn` edges that block deploy parallelization
 * but are not required for AWS API correctness.
 *
 * The CDK constructs eagerly inject `DependsOn` from VPC Lambdas (and adjacent
 * resources — IAM Role / Policy that the Lambda uses, the Lambda::Url that
 * derives its FunctionUrl from the Lambda, the EventSourceMapping that wires
 * the Lambda to a queue) onto the private subnets' `DefaultRoute` /
 * `RouteTableAssociation` so that nothing tries to invoke the Lambda before
 * its egress path to the internet is up. The dependency is real at *runtime*
 * (a Lambda code call to a third-party API can't reach the internet without a
 * NAT route), but it is NOT required at *deploy time* — `CreateFunction` /
 * `CreateFunctionUrlConfig` / `AddPermission` / `CreateEventSourceMapping`
 * all accept a function in `Pending` state and AWS resolves the asynchronous
 * ENI provisioning + route binding in the background. cdkd's existing Custom
 * Resource path already relies on this: the post-`CreateFunction` `State=Active`
 * wait was deliberately moved to `CustomResourceProvider.sendRequest` (the
 * one consumer that breaks against `Pending`) so that VPC Lambdas don't
 * double the deploy time of the average benchmark stack — see
 * `src/provisioning/providers/lambda-function-provider.ts` and PR #121.
 *
 * The cost of leaving this defensive edge in place: a CloudFront Distribution
 * whose Origin is `Lambda::Url.FunctionUrl` cannot start its ~3-min edge
 * propagation until the Lambda finishes, which itself cannot start until the
 * NAT GW is `available` (~2 min). That serialization adds ~5 min to every
 * VPC + Lambda + CloudFront stack. Relaxing the defensive edge collapses
 * the two waits onto one timeline (`max(NAT, CF) ≈ CF`), measured at −45.6%
 * on `bench-cdk-sample` (387s → 211s).
 *
 * The list below is intentionally narrow (`from`-types that the CDK actually
 * decorates with these route DependsOns + `to`-types that are pure egress
 * wiring). It is NOT a general "ignore all DependsOn" toggle — Ref / GetAtt
 * edges are untouched, and DependsOn pairs outside this list are also kept.
 */
const DEFENSIVE_DEPENDS_ON_TYPE_PAIRS: ReadonlyArray<{
  fromType: string;
  toType: string;
}> = [
  // VPC Lambda's execution Role (and its inline Policy) get DependsOn'd onto
  // the route only because CDK assumes the Lambda will run before the route
  // is up. The Role/Policy create call itself is VPC-agnostic.
  { fromType: 'AWS::IAM::Role', toType: 'AWS::EC2::Route' },
  { fromType: 'AWS::IAM::Role', toType: 'AWS::EC2::SubnetRouteTableAssociation' },
  { fromType: 'AWS::IAM::Policy', toType: 'AWS::EC2::Route' },
  { fromType: 'AWS::IAM::Policy', toType: 'AWS::EC2::SubnetRouteTableAssociation' },

  // VPC Lambda itself: CreateFunction returns synchronously while the
  // function is still in Pending; the route only matters once the function
  // is invoked at runtime.
  { fromType: 'AWS::Lambda::Function', toType: 'AWS::EC2::Route' },
  { fromType: 'AWS::Lambda::Function', toType: 'AWS::EC2::SubnetRouteTableAssociation' },

  // Lambda::Url is just a deterministic URL derivation off the function; it
  // doesn't need the function's runtime egress to exist.
  { fromType: 'AWS::Lambda::Url', toType: 'AWS::EC2::Route' },
  { fromType: 'AWS::Lambda::Url', toType: 'AWS::EC2::SubnetRouteTableAssociation' },

  // EventSourceMapping just registers the wire-up; AWS handles delivery
  // async and will retry once the function reaches Active.
  { fromType: 'AWS::Lambda::EventSourceMapping', toType: 'AWS::EC2::Route' },
  {
    fromType: 'AWS::Lambda::EventSourceMapping',
    toType: 'AWS::EC2::SubnetRouteTableAssociation',
  },
];

/**
 * Compute the set of DependsOn entries on `resource` that fall under one of
 * the CDK-defensive type pairs above. The DAG builder skips these edges
 * when relaxation is enabled.
 *
 * Returns the subset of DependsOn target logical IDs that can be skipped.
 * DependsOn entries that don't match any rule (or that aren't strings, or
 * that point to non-existent resources) are returned untouched (i.e. NOT in
 * the skip set), so they continue to be added to the graph.
 */
export function defensiveDependsOnToSkip(
  resource: TemplateResource,
  template: CloudFormationTemplate
): Set<string> {
  const skip = new Set<string>();

  if (!resource.DependsOn) {
    return skip;
  }

  const dependsOn = Array.isArray(resource.DependsOn) ? resource.DependsOn : [resource.DependsOn];

  for (const dep of dependsOn) {
    if (typeof dep !== 'string') continue;
    const target = template.Resources[dep];
    if (!target) continue;
    const fromType = resource.Type;
    const toType = target.Type;
    if (!fromType || !toType) continue;
    const matched = DEFENSIVE_DEPENDS_ON_TYPE_PAIRS.some(
      (pair) => pair.fromType === fromType && pair.toType === toType
    );
    if (matched) {
      skip.add(dep);
    }
  }

  return skip;
}
