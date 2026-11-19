import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Update of a Lambda function that is still `Pending` (go-to-k/cdkd#6605).
 *
 * cdkd's create returns before the function is `Active`, and a VPC function
 * stays `Pending` for minutes. AWS refuses an update in that window
 * (`...is currently in the following state: 'Pending'`), which failed the
 * deploy. Phase 1 creates the function in two isolated subnets; Phase 2
 * (`CDKD_TEST_UPDATE=true`) redeploys at once with the VPC removed, so the
 * update lands inside the `Pending` window.
 *
 * The role and the security group are declared in both phases, so the
 * function's `VpcConfig` is the only change Phase 2 makes.
 *
 *   covers: AWS::Lambda::Function
 *   covers: AWS::EC2::VPC
 *   covers: AWS::EC2::Subnet
 *   covers: AWS::EC2::SecurityGroup
 *   covers: AWS::IAM::Role
 */
export class LambdaVpcUpdateWhilePendingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    const securityGroup = new ec2.SecurityGroup(this, 'FnSg', {
      vpc,
      allowAllOutbound: false,
    });
    const role = new iam.Role(this, 'FnRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });

    const inVpc = process.env.CDKD_TEST_UPDATE !== 'true';
    new lambda.Function(this, 'Fn', {
      functionName: `${this.stackName}-fn`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
      role,
      ...(inVpc
        ? {
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            securityGroups: [securityGroup],
          }
        : {}),
    });
  }
}
