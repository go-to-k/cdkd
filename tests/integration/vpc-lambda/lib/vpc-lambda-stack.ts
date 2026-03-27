import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * VPC Lambda example stack
 *
 * Demonstrates:
 * - VPC with public and private subnets (1 AZ, 1 NAT Gateway)
 * - Security Group for Lambda
 * - Lambda function deployed in VPC private subnet
 * - VpcConfig (SubnetIds, SecurityGroupIds) resolution
 * - CfnOutputs for VPC ID, function name, security group ID
 */
export class VpcLambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create VPC with 1 AZ, 1 NAT Gateway, public + private subnets
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 1,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 24, name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    // Create Security Group for Lambda
    const sg = new ec2.SecurityGroup(this, 'LambdaSg', { vpc });

    // Create Lambda function in VPC private subnet
    const fn = new lambda.Function(this, 'VpcFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline('def handler(event, context): return {"statusCode": 200}'),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [sg],
    });

    // Outputs
    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID',
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
      description: 'Lambda function name',
    });

    new cdk.CfnOutput(this, 'SecurityGroupId', {
      value: sg.securityGroupId,
      description: 'Security Group ID',
    });
  }
}
