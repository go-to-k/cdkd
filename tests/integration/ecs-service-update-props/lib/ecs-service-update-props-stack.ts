import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';

/**
 * ECS Fargate Service create/UPDATE-props example stack (issues #975 / #1160 /
 * #1165).
 *
 * Exercises the SDK-routed `ECSProvider.createService()` / `updateService()`
 * path. Before the #975 fix, `updateService()` never mapped
 * `EnableECSManagedTags`, `PropagateTags`, `LoadBalancers`, or
 * `ServiceRegistries` into `UpdateServiceCommand`, so a template change to any
 * of them was a silent drop: `cdkd diff` detected it, deploy went green,
 * state.json recorded the NEW value, but AWS kept the OLD value. Issue #1165
 * adds a custom `DeploymentConfiguration` (a CFn PascalCase nested object) that
 * before the fix was passed raw into the SDK's camelCase input slot and
 * silently dropped on create AND update.
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

    // issue #1165: RuntimePlatform (Graviton/ARM64) + EphemeralStorage are
    // nested CFn PascalCase objects on the TaskDefinition that ECSProvider
    // passed RAW into the SDK's camelCase RegisterTaskDefinition slots, so a
    // custom CpuArchitecture / SizeInGiB was silently dropped (task registered
    // as the default X86_64 / default ephemeral storage). verify.sh reads them
    // back via describe-task-definition.
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      ephemeralStorageGiB: 30,
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
      // issue #1165: LinuxParameters is a nested CFn PascalCase object on the
      // container definition that ECSProvider passed raw into the SDK's
      // camelCase `linuxParameters` slot, silently dropping it. `initProcessEnabled`
      // is Fargate-compatible; verify.sh reads it back via describe-task-definition.
      linuxParameters: new ecs.LinuxParameters(this, 'LinuxParams', {
        initProcessEnabled: true,
      }),
    });

    // Plain Fargate Service (desiredCount: 0). NO serviceConnectConfiguration,
    // NO addVolume — stays SDK-routed.
    //
    // Two directions are exercised across the phases:
    //
    // #975 (add-on-update): EnableECSManagedTags / PropagateTags
    //   Phase 1 (base):   EnableECSManagedTags: false, PropagateTags: NONE (CDK
    //                     renders nothing for NONE, so the property is absent).
    //   Phase 2 (update): enableECSManagedTags: true, propagateTags:
    //                     TASK_DEFINITION -> verify.sh asserts both reach AWS.
    //
    // #1160 (reset-on-removal): PlatformVersion / HealthCheckGracePeriodSeconds
    //   are SET in phase 1 and DROPPED in phase 2. Under UpdateService merge
    //   semantics an absent input field means "no change", so without the #1160
    //   fix AWS would keep the phase-1 values. verify.sh asserts they reset to
    //   their CloudFormation defaults (LATEST / 0). Injected via the L1 escape
    //   hatch so the phase-2 template genuinely omits them.
    const service = new ecs.FargateService(this, 'Svc', {
      cluster,
      taskDefinition,
      desiredCount: 0,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      enableECSManagedTags: isUpdate ? true : false,
      propagateTags: isUpdate ? ecs.PropagatedTagSource.TASK_DEFINITION : ecs.PropagatedTagSource.NONE,
    });

    const cfnService = service.node.defaultChild as ecs.CfnService;

    // issue #1165 (nested-object casing): a custom `DeploymentConfiguration`
    // (a CFn PascalCase nested object) must reach AWS. Before the fix
    // ECSProvider passed the block RAW into the SDK's camelCase
    // `deploymentConfiguration` slot, so the SDK read absent keys and silently
    // dropped the whole value on create AND update -> AWS applied the defaults
    // (maximumPercent 200, minimumHealthyPercent 100, circuit breaker off).
    // Injected via the L1 escape hatch (PascalCase) so the wire shape is
    // exactly what a hand-written template / CDK L2 emits. Phase 1 sets one
    // custom shape (create path); phase 2 CHANGES it (update SET path).
    if (!isUpdate) {
      cfnService.addPropertyOverride('PlatformVersion', '1.4.0');
      cfnService.addPropertyOverride('HealthCheckGracePeriodSeconds', 30);
      cfnService.addPropertyOverride('DeploymentConfiguration', {
        MaximumPercent: 150,
        MinimumHealthyPercent: 50,
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      });
    } else {
      // Phase 2: genuinely REMOVE the fields so cdkd's UpdateService sees an
      // ABSENT field (removal), not a value change. PlatformVersion /
      // HealthCheckGracePeriodSeconds are not emitted by L2 without an explicit
      // prop, so these deletion overrides drop the phase-1 values cleanly.
      cfnService.addPropertyDeletionOverride('PlatformVersion');
      cfnService.addPropertyDeletionOverride('HealthCheckGracePeriodSeconds');
      // Change the DeploymentConfiguration to a different custom shape so the
      // update SET path is exercised (issue #1165).
      cfnService.addPropertyOverride('DeploymentConfiguration', {
        MaximumPercent: 175,
        MinimumHealthyPercent: 25,
        DeploymentCircuitBreaker: { Enable: true, Rollback: false },
      });
    }

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
