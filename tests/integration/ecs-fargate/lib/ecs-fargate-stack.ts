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
 * - Service Connect with CloudMap namespace
 * - Application Auto Scaling (ScalableTarget + ScalingPolicy)
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

    // Create ECS Cluster with CloudMap namespace for Service Connect
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `cdkd-ecs-fargate-test`,
      defaultCloudMapNamespace: {
        name: 'cdkd-test.local',
      },
    });

    // Create Fargate Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    // Add container using a public ECR image (no Docker build needed)
    const container = taskDefinition.addContainer('AppContainer', {
      image: ecs.ContainerImage.fromRegistry(
        'public.ecr.aws/amazonlinux/amazonlinux:latest'
      ),
      memoryLimitMiB: 512,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'cdkd-ecs-fargate',
      }),
      command: ['echo', 'hello'],
    });

    // Add named port mapping for Service Connect
    container.addPortMappings({
      containerPort: 80,
      name: 'http',
      protocol: ecs.Protocol.TCP,
    });

    // Create Fargate Service with desiredCount: 0 and Service Connect enabled
    // This tests resource creation without actually running containers
    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: 0,
      assignPublicIp: true,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      serviceConnectConfiguration: {
        services: [
          {
            portMappingName: 'http',
            dnsName: 'web',
            port: 80,
          },
        ],
      },
    });

    // Auto Scaling for the Fargate Service
    const scaling = service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 3,
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
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

    new cdk.CfnOutput(this, 'AutoScalingMinCapacity', {
      value: '1',
      description: 'Auto Scaling min capacity',
    });

    new cdk.CfnOutput(this, 'AutoScalingMaxCapacity', {
      value: '3',
      description: 'Auto Scaling max capacity',
    });
  }
}
