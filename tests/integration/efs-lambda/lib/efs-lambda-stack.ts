import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * EFS Lambda example stack
 *
 * Demonstrates:
 * - VPC with public and private subnets (1 AZ, 1 NAT Gateway)
 * - EFS FileSystem with lifecycle policy and DESTROY removal
 * - EFS Access Point with POSIX user and ACL configuration
 * - Lambda function in VPC private subnet with EFS mount
 * - Security Groups for EFS and Lambda connectivity
 * - CfnOutputs for VPC ID, filesystem ID, function name
 *
 * Tests: AWS::EFS::FileSystem, AWS::EFS::MountTarget, AWS::EFS::AccessPoint
 */
export class EfsLambdaStack extends cdk.Stack {
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

    // Create EFS FileSystem
    const fs = new efs.FileSystem(this, 'SharedFs', {
      vpc,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_7_DAYS,
    });

    // Create EFS Access Point for Lambda
    const accessPoint = fs.addAccessPoint('LambdaAP', {
      path: '/lambda',
      createAcl: { ownerGid: '1001', ownerUid: '1001', permissions: '750' },
      posixUser: { gid: '1001', uid: '1001' },
    });

    // Create Lambda function with EFS mount
    const fn = new lambda.Function(this, 'EfsFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'import os\ndef handler(event, context):\n    files = os.listdir("/mnt/shared")\n    return {"statusCode": 200, "body": str(files)}'
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      filesystem: lambda.FileSystem.fromEfsAccessPoint(accessPoint, '/mnt/shared'),
    });

    // Outputs
    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID',
    });

    new cdk.CfnOutput(this, 'FileSystemId', {
      value: fs.fileSystemId,
      description: 'EFS FileSystem ID',
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
      description: 'Lambda function name',
    });
  }
}
