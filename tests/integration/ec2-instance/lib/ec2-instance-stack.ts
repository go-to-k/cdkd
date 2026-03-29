import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * EC2 Instance example stack
 *
 * Demonstrates:
 * - VPC creation with public subnet (1 AZ, no NAT gateways for cost saving)
 * - EC2 Instance (t3.micro, Amazon Linux 2023)
 * - Security Group with SSH ingress rule
 * - Resource dependencies (Instance depends on VPC, Subnet, SecurityGroup)
 * - Fn::GetAtt for outputs (Instance ID, Public IP, Private IP)
 */
export class Ec2InstanceStack extends cdk.Stack {
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

    // Create Security Group allowing SSH
    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSG', {
      vpc,
      description: 'Security group for EC2 instance',
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'Allow SSH from anywhere'
    );

    // Create EC2 Instance with Amazon Linux 2023
    const instance = new ec2.Instance(this, 'Instance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup,
    });

    // Outputs
    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'EC2 Instance ID',
    });

    new cdk.CfnOutput(this, 'PublicIp', {
      value: instance.instancePublicIp,
      description: 'EC2 Instance Public IP',
    });

    new cdk.CfnOutput(this, 'PrivateIp', {
      value: instance.instancePrivateIp,
      description: 'EC2 Instance Private IP',
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID',
    });
  }
}
