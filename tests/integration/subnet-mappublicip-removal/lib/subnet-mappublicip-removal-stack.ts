import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

/** covers: AWS::EC2::Subnet */
export class SubnetMapPublicIpRemovalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // go-to-k/cdkd#6342: `create` declares MapPublicIpOnLaunch true; the
    // removal phase drops it (CloudFormation keeps the live true); `readd-false`
    // declares false over a record that holds no value.
    const phase = process.env.CDKD_TEST_UPDATE ?? 'create';
    const removed = process.env.CDKD_TEST_REMOVAL === 'true';
    const vpc = new ec2.CfnVPC(this, 'Vpc', { cidrBlock: '10.63.0.0/16' });
    const subnet = new ec2.CfnSubnet(this, 'Subnet', {
      vpcId: vpc.ref,
      cidrBlock: '10.63.1.0/24',
      ...(!removed && { mapPublicIpOnLaunch: phase !== 'readd-false' }),
      // A second, ordinary difference, so each phase is an update.
      tags: [{ key: 'Phase', value: removed ? 'remove' : phase }],
    });

    new cdk.CfnOutput(this, 'SubnetId', { value: subnet.ref });
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.ref });
  }
}
