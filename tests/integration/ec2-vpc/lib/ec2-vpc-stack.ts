import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * EC2/VPC example stack
 *
 * Demonstrates:
 * - VPC creation with public subnet (1 AZ, no NAT gateways for cost saving)
 * - Security Group with ingress rule
 * - Resource dependencies (Security Group depends on VPC)
 * - Fn::GetAtt for outputs (VPC ID, Security Group ID, Subnet IDs)
 *
 * Note: No EC2 instances are created to avoid costs.
 * This stack only provisions networking resources (VPC, Subnet, Security Group).
 */
export class Ec2VpcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create VPC with 1 AZ and no NAT gateways (cost saving)
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

    // Create Security Group with HTTP ingress rule
    const securityGroup = new ec2.SecurityGroup(this, 'WebSecurityGroup', {
      vpc,
      description: 'Allow HTTP traffic from anywhere',
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP from anywhere'
    );

    // VPC Flow Log (to CloudWatch Logs)
    const flowLog = new ec2.FlowLog(this, 'VpcFlowLog', {
      resourceType: ec2.FlowLogResourceType.fromVpc(vpc),
      destination: ec2.FlowLogDestination.toCloudWatchLogs(),
    });

    // Outputs
    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID',
    });

    new cdk.CfnOutput(this, 'SecurityGroupId', {
      value: securityGroup.securityGroupId,
      description: 'Security Group ID',
    });

    new cdk.CfnOutput(this, 'PublicSubnetIds', {
      value: vpc.publicSubnets.map((s) => s.subnetId).join(','),
      description: 'Public Subnet IDs',
    });

    new cdk.CfnOutput(this, 'FlowLogId', {
      value: flowLog.flowLogId,
      description: 'VPC Flow Log ID',
    });
  }
}
