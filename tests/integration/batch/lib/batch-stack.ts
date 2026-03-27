import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as batch from 'aws-cdk-lib/aws-batch';

/**
 * AWS Batch example stack (Fargate)
 *
 * Demonstrates:
 * - VPC with public subnet (1 AZ, no NAT for cost saving)
 * - Batch Compute Environment (Fargate type)
 * - Batch Job Queue
 * - Batch Job Definition (container with Fargate)
 * - IAM Execution Role for ECS tasks
 * - Resource dependencies (Compute Env → Job Queue, Role → Job Definition)
 *
 * Uses L1 (Cfn) constructs for Batch resources.
 */
export class BatchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC with 1 AZ and public subnet only (no NAT for cost saving)
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

    // Security Group for Batch Compute Environment
    const sg = new ec2.SecurityGroup(this, 'BatchSecurityGroup', {
      vpc,
      description: 'Security group for Batch Fargate compute environment',
      allowAllOutbound: true,
    });

    // ECS Task Execution Role (required for Fargate tasks to pull images)
    const executionRole = new iam.Role(this, 'BatchExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyArn(
          'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'
        ),
      ],
    });

    // Batch Compute Environment (Fargate)
    const computeEnv = new batch.CfnComputeEnvironment(this, 'ComputeEnv', {
      type: 'MANAGED',
      computeResources: {
        type: 'FARGATE',
        maxvCpus: 2,
        subnets: vpc.publicSubnets.map((s) => s.subnetId),
        securityGroupIds: [sg.securityGroupId],
      },
    });

    // Batch Job Queue
    const jobQueue = new batch.CfnJobQueue(this, 'JobQueue', {
      priority: 1,
      computeEnvironmentOrder: [
        {
          order: 1,
          computeEnvironment: computeEnv.ref,
        },
      ],
    });

    // Batch Job Definition (Fargate container)
    const jobDef = new batch.CfnJobDefinition(this, 'JobDef', {
      type: 'container',
      platformCapabilities: ['FARGATE'],
      containerProperties: {
        image: 'public.ecr.aws/amazonlinux/amazonlinux:2023',
        command: ['echo', 'Hello from AWS Batch!'],
        resourceRequirements: [
          { type: 'VCPU', value: '0.25' },
          { type: 'MEMORY', value: '512' },
        ],
        executionRoleArn: executionRole.roleArn,
        networkConfiguration: {
          assignPublicIp: 'ENABLED',
        },
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'ComputeEnvironmentArn', {
      value: computeEnv.attrComputeEnvironmentArn,
      description: 'Batch Compute Environment ARN',
    });

    new cdk.CfnOutput(this, 'JobQueueArn', {
      value: jobQueue.attrJobQueueArn,
      description: 'Batch Job Queue ARN',
    });

    new cdk.CfnOutput(this, 'JobDefinitionArn', {
      value: jobDef.ref,
      description: 'Batch Job Definition ARN',
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID',
    });

    new cdk.CfnOutput(this, 'ExecutionRoleArn', {
      value: executionRole.roleArn,
      description: 'ECS Task Execution Role ARN',
    });
  }
}
