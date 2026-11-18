import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

/**
 * Security group rule description edits (go-to-k/cdkd#6514).
 *
 * A description-only change used to revoke the rule and authorize it again:
 * the rule was briefly absent and came back with a new `sgr-` id, and the
 * standalone rule was reported `replaced`. CloudFormation updates the
 * description in place, keeping the rule.
 *
 * One group (`allowAllOutbound: false`) with an inline ingress rule and an
 * inline egress rule (CDK writes a CIDR peer's rules inline), plus a standalone
 * `AWS::EC2::SecurityGroupIngress`. `CDKD_TEST_UPDATE` picks the descriptions:
 * unset is v1; `v2` changes all three; `v3` keeps the inline rules at v2 and
 * drops the standalone rule's description.
 *
 * covers: AWS::EC2::SecurityGroup, AWS::EC2::SecurityGroupIngress, AWS::EC2::VPC
 */
export class SgRuleDescriptionUpdateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const mode = process.env.CDKD_TEST_UPDATE ?? '';
    const inline = mode === 'v2' || mode === 'v3' ? 'v2' : 'v1';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.96.0.0/16'),
      maxAzs: 1,
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    cdk.Tags.of(vpc).add('cdkd-integ', 'sg-rule-description-update');

    const group = new ec2.SecurityGroup(this, 'Group', {
      vpc,
      description: 'cdkd 6514 group',
      allowAllOutbound: false,
    });
    group.addIngressRule(ec2.Peer.ipv4('10.97.0.0/16'), ec2.Port.tcp(443), `cdkd 6514 ingress ${inline}`);
    group.addEgressRule(ec2.Peer.ipv4('10.97.0.0/16'), ec2.Port.tcp(443), `cdkd 6514 egress ${inline}`);

    new ec2.CfnSecurityGroupIngress(this, 'Standalone', {
      groupId: group.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 8443,
      toPort: 8443,
      cidrIp: '10.97.0.0/16',
      ...(mode === 'v3' ? {} : { description: `cdkd 6514 standalone ${mode === 'v2' ? 'v2' : 'v1'}` }),
    });
  }
}
