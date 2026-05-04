import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Integration test for the `AWS::EC2::NatGateway` SDK provider.
 *
 * The stack is the smallest shape that exercises every code path in
 * the new provider:
 *   - `CreateNatGateway` (via the public-subnet NAT) + `applyTags`
 *   - `waitUntilNatGatewayAvailable` (default behavior, skipped under
 *     `--no-wait`)
 *   - Routes referencing the NAT (default route from the private
 *     subnet, automatically added by the L2 VPC construct)
 *   - `DeleteNatGateway` + `waitUntilNatGatewayDeleted` on destroy
 *
 * Why two AZs but `natGateways: 1`: forces the second AZ's PrivateEgress
 * subnet to share the single NAT, which exercises the multi-route /
 * shared-NAT path that real-world stacks usually take. Two AZs do not
 * meaningfully add to deploy time (NAT itself is the dominant cost).
 *
 * Why no Lambda / EC2 instance: keeps the test focused on the NAT
 * provider and avoids the ENI-attach / IAM-propagation overhead that
 * `vpc-lambda-cr-race` already covers. A misbehaving NAT delete
 * (DependencyViolation) still surfaces here because the VPC and
 * Subnets that depend on it have to come down too.
 */
export class VpcNatGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.50.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'PrivateEgress',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID (NAT Gateway lives in the public subnet of this VPC)',
    });
  }
}
