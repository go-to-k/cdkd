import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';

/**
 * ECS Fargate Service UPDATE-props example stack (issue #975).
 *
 * Exercises the SDK-routed `ECSProvider.updateService()` path. Before the
 * #975 fix, `updateService()` never mapped `EnableECSManagedTags`,
 * `PropagateTags`, `LoadBalancers`, or `ServiceRegistries` into
 * `UpdateServiceCommand`, so a template change to any of them was a silent
 * drop: `cdkd diff` detected it, deploy went green, state.json recorded the
 * NEW value, but AWS kept the OLD value.
 *
 * CRITICAL — this Service MUST stay on cdkd's SDK provider path (NOT Cloud
 * Control). The sibling `ecs-fargate` fixture's Service routes via CC-API
 * because it sets `ServiceConnectConfiguration` + `VolumeConfigurations`,
 * both cdkd silent-drops that flip the resource to the #614 CC-fallback
 * routing — CC forwards the full property map so it never exercises the SDK
 * updateService() code path the #975 fix touches. This fixture therefore
 * uses a plain Fargate Service with NONE of those silent-drop properties, so
 * it stays SDK-routed and the update actually goes through updateService().
 *
 * Cost: desiredCount is 0 (no task ever launches; only control-plane
 * resources exist), so the fixture is cheap.
 */
export class EcsServiceUpdatePropsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    // Minimal VPC (1 AZ, no NAT gateway to minimize cost).
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

    // Plain ECS Cluster — NO defaultCloudMapNamespace / Service Connect, so
    // the Service below does not gain a silent-drop property that would flip
    // it to the Cloud Control routing.
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: 'cdkd-ecs-svc-update-props-test',
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    const containerLogGroup = new logs.LogGroup(this, 'AppContainerLogGroup', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_DAY,
    });

    taskDefinition.addContainer('AppContainer', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/amazonlinux/amazonlinux:latest'),
      memoryLimitMiB: 512,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: containerLogGroup,
        streamPrefix: 'cdkd-ecs-svc-update-props',
      }),
      command: ['echo', 'hello'],
    });

    // Plain Fargate Service (desiredCount: 0). NO serviceConnectConfiguration,
    // NO addVolume — stays SDK-routed.
    //
    // Phase 1 (base):   EnableECSManagedTags: false, PropagateTags: NONE (CDK
    //                   renders nothing for NONE, so the property is absent).
    // Phase 2 (update): enableECSManagedTags: true, propagateTags:
    //                   TASK_DEFINITION. verify.sh asserts both reach AWS via
    //                   describe-services.
    const service = new ecs.FargateService(this, 'Svc', {
      cluster,
      taskDefinition,
      desiredCount: 0,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      enableECSManagedTags: isUpdate ? true : false,
      propagateTags: isUpdate ? ecs.PropagatedTagSource.TASK_DEFINITION : ecs.PropagatedTagSource.NONE,
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: cluster.clusterName,
      description: 'ECS Cluster name',
    });

    new cdk.CfnOutput(this, 'ServiceName', {
      // Fn::GetAtt(Svc, 'Name') — exercises the service Name attribute
      // round-trip AND gives verify.sh the real (cdkd-generated) service name.
      value: service.serviceName,
      description: 'ECS Fargate Service name',
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID',
    });
  }
}
