import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';

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

    // Create ECS Cluster with Cloud Map namespace for Service Connect
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `cdkd-ecs-fargate-test`,
      defaultCloudMapNamespace: {
        name: 'cdkd-test.local',
        // `useForServiceConnect: true` is what makes CDK set the CfnCluster's
        // `ServiceConnectDefaults: { Namespace: <namespaceArn> }`. Without it,
        // `defaultCloudMapNamespace` only wires the namespace for the Service's
        // serviceConnectConfiguration and leaves the Cluster property unset —
        // so the verify.sh ServiceConnectDefaults assertion (added with the
        // #609 backfill in PR #726) could never pass. This makes the fixture
        // actually synthesize the property the backfill is meant to exercise.
        useForServiceConnect: true,
      },
    });

    // Create Fargate Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    // Exercise the #609 backfill: EnableFaultInjection rides on
    // RegisterTaskDefinition. The L2 FargateTaskDefinition does not
    // expose `enableFaultInjection`, so reach the CfnTaskDefinition via
    // the L1 escape hatch.
    const cfnTaskDef = taskDefinition.node.defaultChild as ecs.CfnTaskDefinition;
    cfnTaskDef.enableFaultInjection = true;

    // Explicit LogGroup so destroy actually deletes it (CDK's default
    // awsLogs() auto-LogGroup uses RemovalPolicy.RETAIN, which leaves
    // orphans across integ re-runs and trips the leftover-resources gate).
    const containerLogGroup = new logs.LogGroup(this, 'AppContainerLogGroup', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_DAY,
    });

    // Add container using a public ECR image (no Docker build needed)
    const container = taskDefinition.addContainer('AppContainer', {
      image: ecs.ContainerImage.fromRegistry(
        'public.ecr.aws/amazonlinux/amazonlinux:latest'
      ),
      memoryLimitMiB: 512,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: containerLogGroup,
        streamPrefix: 'cdkd-ecs-fargate',
      }),
      command: ['echo', 'hello'],
      portMappings: [
        {
          containerPort: 80,
          name: 'http',
        },
      ],
    });

    // Create Fargate Service with desiredCount: 0 and Service Connect
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
          },
        ],
      },
    });
    // The Service references `cluster.defaultCloudMapNamespace` by NAME for
    // Service Connect (no Ref edge in the synthesized template), so cdkd's
    // DAG cannot infer the dependency. Without this explicit addDependency
    // the namespace and the Service race, and AWS rejects the Service create
    // with "Failed to retrieve namespace for cdkd-test.local".
    if (cluster.defaultCloudMapNamespace) {
      service.node.addDependency(cluster.defaultCloudMapNamespace);
    }

    // Application Auto Scaling on the Fargate Service. The synthesized
    // AWS::ApplicationAutoScaling::ScalableTarget consumes
    // Fn::GetAtt(Service, 'Name') via its ResourceId
    // (`service/<cluster>/<service.Name>`) — exercising the cross-resource
    // Name attribute round-trip through cdkd's intrinsic resolver.
    const scalableTarget = service.autoScaleTaskCount({
      minCapacity: 0,
      maxCapacity: 2,
    });
    scalableTarget.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
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
