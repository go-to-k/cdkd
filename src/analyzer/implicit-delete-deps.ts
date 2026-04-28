/**
 * Type-based implicit deletion dependency rules.
 *
 * CloudFormation expresses creation order via Ref / Fn::GetAtt / DependsOn.
 * For deletion, AWS additionally enforces ordering rules that aren't visible
 * in those references — for example, an InternetGateway can't be deleted
 * while it's still attached to a VPC, even though the attachment Ref's the
 * IGW (not the other way around). This module centralizes those type-based
 * rules so that both the deploy engine (DELETE phase) and the destroy
 * command apply the same ordering.
 *
 * Each entry maps `KEY` → list of types that must be deleted BEFORE the
 * KEY type. Reading example:
 *
 *   'AWS::EC2::Subnet': ['AWS::Lambda::Function']
 *
 * = "every Subnet in this stack must be deleted AFTER every Lambda in
 *    this stack" — required because Lambda's VpcConfig leaves an ENI in
 *    the subnet for some time after the function is deleted, and tearing
 *    the subnet down first triggers a DependencyViolation.
 */
export const IMPLICIT_DELETE_DEPENDENCIES: Record<string, readonly string[]> = {
  // IGW must be deleted AFTER VPCGatewayAttachment
  'AWS::EC2::InternetGateway': ['AWS::EC2::VPCGatewayAttachment'],

  // EventBus must be deleted AFTER Rules on that bus
  'AWS::Events::EventBus': ['AWS::Events::Rule'],

  // Athena workgroup must be deleted AFTER its named queries
  'AWS::Athena::WorkGroup': ['AWS::Athena::NamedQuery'],

  // CloudFront managed-policy-style resources must be deleted AFTER
  // any Distribution that references them
  'AWS::CloudFront::ResponseHeadersPolicy': ['AWS::CloudFront::Distribution'],
  'AWS::CloudFront::CachePolicy': ['AWS::CloudFront::Distribution'],
  'AWS::CloudFront::OriginAccessControl': ['AWS::CloudFront::Distribution'],

  // VPC must be deleted AFTER all VPC-dependent resources
  'AWS::EC2::VPC': [
    'AWS::EC2::Subnet',
    'AWS::EC2::SecurityGroup',
    'AWS::EC2::InternetGateway',
    'AWS::EC2::EgressOnlyInternetGateway',
    'AWS::EC2::VPCGatewayAttachment',
    'AWS::EC2::RouteTable',
  ],

  // Subnet must be deleted AFTER any Lambda that may still hold an ENI
  // in it. Lambda DELETE returns immediately but the ENI is detached
  // asynchronously by AWS, so deleting the Subnet first races the detach
  // and yields "DependencyViolation".
  'AWS::EC2::Subnet': ['AWS::EC2::SubnetRouteTableAssociation', 'AWS::Lambda::Function'],

  // RouteTable must be deleted AFTER Route and Association
  'AWS::EC2::RouteTable': ['AWS::EC2::Route', 'AWS::EC2::SubnetRouteTableAssociation'],

  // SecurityGroup must be deleted AFTER any Lambda whose ENI is bound
  // to it (same ENI-detach race as Subnet above).
  'AWS::EC2::SecurityGroup': [
    'AWS::EC2::SecurityGroupIngress',
    'AWS::EC2::SecurityGroupEgress',
    'AWS::Lambda::Function',
  ],
};
