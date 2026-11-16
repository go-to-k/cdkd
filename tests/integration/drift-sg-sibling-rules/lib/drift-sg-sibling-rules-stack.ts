import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Integ probe for go-to-k/cdkd#6418: a rule a SIBLING standalone
 * `AWS::EC2::SecurityGroupIngress` / `AWS::EC2::SecurityGroupEgress`
 * authorizes on a group is that resource's, not the group's.
 *
 * CDK never inlines a security-group-to-security-group rule, so
 * `a.connections.allowFrom(b, ...)` is a standalone rule resource while the
 * group's CIDR rules stay in its inline lists. Before the fix `cdkd drift`
 * reported the sibling's rule as `SecurityGroupIngress` drift on a fresh
 * stack, and `cdkd drift --revert` REVOKED it while printing success.
 *
 * - SgA declares an inline CIDR ingress AND an inline CIDR egress, so both of
 *   its lists are non-empty (the #1498 undeclared-empty fold does not apply).
 * - `a.connections.allowFrom(b, 5432)` adds a standalone ingress on SgA;
 *   `a.connections.allowTo(b, 8080)` adds a standalone egress on SgA and a
 *   standalone ingress on SgB, which declares an inline ingress of its own.
 * - `CDKD_TEST_UPDATE=inline` adds a second inline ingress to SgA, so the
 *   group is UPDATED (and its drift baseline re-captured) while the sibling
 *   rules exist.
 * - `CDKD_TEST_UPDATE=inline,nofrom` (go-to-k/cdkd#6420) removes the 5432
 *   standalone ingress, whose delete revokes the rule.
 *
 * covers: AWS::EC2::SecurityGroup
 * covers: AWS::EC2::SecurityGroupIngress
 * covers: AWS::EC2::SecurityGroupEgress
 */
export class DriftSgSiblingRulesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const modes = (process.env.CDKD_TEST_UPDATE ?? '').split(',');

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'pub', subnetType: ec2.SubnetType.PUBLIC }],
    });

    const a = new ec2.SecurityGroup(this, 'SgA', {
      vpc,
      allowAllOutbound: false,
      description: 'cdkd 6418 group A',
    });
    a.addIngressRule(ec2.Peer.ipv4('10.0.0.0/16'), ec2.Port.tcp(443), 'inline https');
    a.addEgressRule(ec2.Peer.ipv4('10.0.0.0/16'), ec2.Port.tcp(443), 'inline egress https');
    if (modes.includes('inline')) {
      a.addIngressRule(ec2.Peer.ipv4('10.2.0.0/16'), ec2.Port.tcp(8443), 'inline update');
    }

    const b = new ec2.SecurityGroup(this, 'SgB', {
      vpc,
      allowAllOutbound: true,
      description: 'cdkd 6418 group B',
    });
    b.addIngressRule(ec2.Peer.ipv4('10.1.0.0/16'), ec2.Port.tcp(22), 'inline ssh');

    if (!modes.includes('nofrom')) {
      a.connections.allowFrom(b, ec2.Port.tcp(5432), 'from B');
    }
    a.connections.allowTo(b, ec2.Port.tcp(8080), 'to B');

    new cdk.CfnOutput(this, 'GroupA', { value: a.securityGroupId });
    new cdk.CfnOutput(this, 'GroupB', { value: b.securityGroupId });
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
  }
}
