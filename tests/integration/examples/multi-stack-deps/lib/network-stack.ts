import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Network stack that creates VPC and Security Group.
 *
 * Exports VPC ID for downstream stacks to reference.
 * Uses minimal VPC configuration (1 AZ, no NAT) to keep costs down.
 */
export class NetworkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a minimal VPC (1 AZ, no NAT gateway to minimize cost)
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // Create a Security Group
    const sg = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc,
      description: 'Security group for multi-stack-deps example',
      allowAllOutbound: true,
    });

    // Export VPC ID
    new cdk.CfnOutput(this, 'VpcIdExport', {
      value: vpc.vpcId,
      description: 'VPC ID',
      exportName: 'MultiStackDeps-VpcId',
    });

    // Export Security Group ID
    new cdk.CfnOutput(this, 'SecurityGroupIdExport', {
      value: sg.securityGroupId,
      description: 'Security Group ID',
      exportName: 'MultiStackDeps-SecurityGroupId',
    });
  }
}
