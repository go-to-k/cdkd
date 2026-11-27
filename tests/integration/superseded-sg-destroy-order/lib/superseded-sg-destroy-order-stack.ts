import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';

/**
 * A superseded security group on destroy (go-to-k/cdkd#7073) and on a deploy
 * that removes its VPC (go-to-k/cdkd#7076).
 *
 * A VPC (one isolated subnet, no NAT) and a security group whose description
 * `CDKD_TEST_UPDATE=v2` changes, which replaces the group. `verify.sh` pins the
 * v1 group with an out-of-band network interface before the v2 deploy and
 * stops that deploy (SIGINT) once state records the old group in
 * `supersededResources`, so the old group is carried. The interface is then
 * removed, and either `cdkd destroy` or a `CDKD_TEST_UPDATE=v3` deploy (the
 * VPC and the group removed from the template) must delete the old group
 * before the VPC its record depends on. A topic keeps the v3 stack non-empty.
 *
 * covers: AWS::EC2::SecurityGroup, AWS::EC2::VPC, AWS::EC2::Subnet, AWS::SNS::Topic
 */
export class SupersededSgDestroyOrderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const mode = process.env.CDKD_TEST_UPDATE ?? '';

    new sns.Topic(this, 'Keep');
    if (mode === 'v3') return;

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
      description: `cdkd 7073 group ${mode === 'v2' ? 'v2' : 'v1'}`,
      allowAllOutbound: true,
    });
  }
}
