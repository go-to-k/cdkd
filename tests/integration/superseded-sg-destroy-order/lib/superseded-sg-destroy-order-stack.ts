import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

/**
 * A superseded security group on destroy (go-to-k/cdkd#7073).
 *
 * A VPC (one isolated subnet, no NAT) and a security group whose description
 * `CDKD_TEST_UPDATE=v2` changes, which replaces the group. `verify.sh` pins the
 * v1 group with an out-of-band network interface before the v2 deploy, so the
 * old group's delete fails and cdkd keeps it in `supersededResources`; the
 * interface is removed before `cdkd destroy`, which must delete the old group
 * before the VPC its record depends on.
 *
 * covers: AWS::EC2::SecurityGroup, AWS::EC2::VPC, AWS::EC2::Subnet
 */
export class SupersededSgDestroyOrderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const version = process.env.CDKD_TEST_UPDATE === 'v2' ? 'v2' : 'v1';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.98.0.0/16'),
      maxAzs: 1,
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    cdk.Tags.of(vpc).add('cdkd-integ', 'superseded-sg-destroy-order');

    new ec2.SecurityGroup(this, 'Group', {
      vpc,
      description: `cdkd 7073 group ${version}`,
      allowAllOutbound: true,
    });
  }
}
