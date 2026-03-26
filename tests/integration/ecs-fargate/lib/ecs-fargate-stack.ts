import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';

/**
 * ECS Fargate example stack
 *
 * Demonstrates:
 * - VPC creation with minimal config (1 AZ, no NAT gateway)
 * - ECS Cluster creation
 * - Fargate Task Definition with container using a public ECR image
 * - Fargate Service with desiredCount: 0 (tests resource creation without running containers)
 * - IAM execution role (auto-created by CDK)
 * - Resource dependencies (Service → Cluster → VPC)
 * - Fn::GetAtt for outputs
 */
export class EcsFargateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a minimal VPC (1 AZ, no NAT gateway to minimize cost)
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // Create ECS Cluster
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `cdkd-ecs-fargate-test`,
    });

    // Create Fargate Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    // Add container using a public ECR image (no Docker build needed)
    taskDefinition.addContainer('AppContainer', {
      image: ecs.ContainerImage.fromRegistry(
        'public.ecr.aws/amazonlinux/amazonlinux:latest'
      ),
      memoryLimitMiB: 512,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'cdkd-ecs-fargate',
      }),
      command: ['echo', 'hello'],
    });

    // Create Fargate Service with desiredCount: 0
    // This tests resource creation without actually running containers
    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: 0,
      assignPublicIp: true,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });

    // Outputs using Fn::GetAtt
    new cdk.CfnOutput(this, 'ClusterArn', {
      value: cluster.clusterArn,
      description: 'ECS Cluster ARN',
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: cluster.clusterName,
      description: 'ECS Cluster name',
    });

    new cdk.CfnOutput(this, 'ServiceName', {
      value: service.serviceName,
      description: 'ECS Fargate Service name',
    });

    new cdk.CfnOutput(this, 'TaskDefinitionArn', {
      value: taskDefinition.taskDefinitionArn,
      description: 'Fargate Task Definition ARN',
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID',
    });
  }
}
