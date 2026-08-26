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
 * Control). Since the #609 Service-property backfill the `AWS::ECS::Service`
 * silent-drop set is EMPTY, so every Service (including the sibling
 * `ecs-fargate` fixture's, which sets ServiceConnectConfiguration +
 * VolumeConfigurations) is SDK-routed; verify.sh still guards
 * `provisionedBy != cc-api` so a future silent-drop regression can't flip the
 * route back and make the test pass for the wrong reason.
 *
 * The #609 additions exercised live here (cheap, control-plane only):
 * - AvailabilityZoneRebalancing: ENABLED — read back via describe-services.
 * - DeploymentController: { Type: ECS } explicit — CreateService must accept
 *   the member; describe-services may legitimately omit it for the default
 *   ECS controller (SDK API doc), so the strong assert is on the deploy-time
 *   observedProperties (the reader's {Type: ECS} fallback).
 * - Monitoring: default 60s resolution — DescribeServices has no read-back
 *   for it, so the live proof is ACCEPTANCE (a mis-flipped required member
 *   like `metricNames` would fail CreateService); values are pinned by
 *   tests/unit/provisioning/ecs-service-config-props.test.ts.
 * - ForceNewDeployment: the nonce is bumped in the `force-nonce` phase (2b)
 *   and verify.sh asserts a fresh rollout (deployments[0].id changed).
 *
 * NOT exercised live (unit-pinned in ecs-service-config-props.test.ts —
 * see the README "Not exercised live" section for the recorded rationale):
 * PlacementStrategies (needs EC2 launch type), VpcLatticeConfigurations
 * (needs VPC Lattice plumbing), DeploymentController CODE_DEPLOY (needs
 * CodeDeploy plumbing), Role (needs a classic ELB setup), Monitoring
 * read-back (no DescribeServices member).
 *
 * Cost: desiredCount is 0 (no task ever launches; only control-plane
 * resources exist), so the fixture is cheap.
 */
export class EcsServiceUpdatePropsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Mode list: '' (phase 1) | 'true' (phase 2) | 'true,force-nonce'
    // (phase 2b — same template as phase 2 EXCEPT the ForceNewDeployment
    // nonce) | 'true,cb-rollback' (phase 2c — same template as phase 2 EXCEPT
    // DeploymentCircuitBreaker.Rollback flipped back on, issue #1861).
    // `includes('true')` keeps the phase-2 shape monotonic across
    // the later mode list (the #1543 mode-gated-resource rule).
    const updateMode = process.env.CDKD_TEST_UPDATE ?? '';
    const isUpdate = updateMode.includes('true');
    const isForceNonce = updateMode.includes('force-nonce');
    const isCircuitBreakerRollbackFlip = updateMode.includes('cb-rollback');

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

    // issue #1173: RestartPolicy is a ContainerDefinition sub-field that
    // convertContainerDefinitions never mapped, so it was silently dropped on
    // RegisterTaskDefinition. It is Fargate-compatible (platform 1.4.0+), so it
    // registers on this task def. Injected via the L1 escape hatch (PascalCase)
    // so the wire shape is exactly what a hand-written template emits; verify.sh
    // reads it back via describe-task-definition AND asserts the deploy-time
    // observedProperties captured it in CFn PascalCase.
    const cfnTaskDef = taskDefinition.node.defaultChild as ecs.CfnTaskDefinition;
    cfnTaskDef.addPropertyOverride('ContainerDefinitions.0.RestartPolicy', {
      Enabled: true,
      RestartAttemptPeriod: 60,
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

    // issue #609 backfill — present in EVERY phase (unchanged across the
    // update deploys, so the change-gated update path must NOT re-send them;
    // only the ForceNewDeployment nonce changes, in phase 2b):
    //   - AvailabilityZoneRebalancing: readable via describe-services.
    //   - DeploymentController {Type: ECS}: explicit default-controller form;
    //     the strong assert is on observedProperties (see verify.sh).
    //   - Monitoring: 60s = the AWS default resolution (no detailed-monitoring
    //     cost); acceptance-only live proof (no DescribeServices read-back).
    //   - ForceNewDeployment: nonce-only object; phase 2b bumps the nonce and
    //     verify.sh asserts a fresh rollout appeared.
    // All injected via addPropertyOverride so the wire shape is exactly what a
    // hand-written template emits, independent of the installed aws-cdk-lib's
    // L1 typings.
    cfnService.addPropertyOverride('AvailabilityZoneRebalancing', 'ENABLED');
    cfnService.addPropertyOverride('DeploymentController', { Type: 'ECS' });
    cfnService.addPropertyOverride('Monitoring', {
      MetricConfigurations: [
        { MetricNames: ['CPUUtilization', 'MemoryUtilization'], ResolutionSeconds: 60 },
      ],
    });
    cfnService.addPropertyOverride('ForceNewDeployment', {
      ForceNewDeploymentNonce: isForceNonce ? 'cdkd-nonce-2' : 'cdkd-nonce-1',
    });

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
        // The two OPTIONAL members are declared here with NON-DEFAULT values
        // on purpose (issue #1861): phase 2 DROPS them, and the removal reset
        // is only observable if the baseline differs from what AWS would
        // default to. AWS's defaults are `true` / `{BOUNDED_PERCENT, 50}`, so
        // `false` / `{COUNT, 7}` makes the phase-2 assertion discriminating
        // instead of vacuous.
        DeploymentCircuitBreaker: {
          Enable: true,
          Rollback: true,
          ResetOnHealthyTask: false,
          ThresholdConfiguration: { Type: 'COUNT', Value: 7 },
        },
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
      // Issue #1861: the block STAYS declared while its two OPTIONAL members
      // are dropped, and `Rollback` flips in the same call so the update
      // demonstrably applies. `UpdateService` alone RETAINS the phase-1
      // values; CloudFormation applies the removal and resets them to AWS's
      // defaults, and cdkd must now do the same.
      //
      // Phase 2c (`cb-rollback`) flips `Rollback` back ON and changes nothing
      // else. By then the two optional members have been NEVER-DECLARED for a
      // whole deploy (phase 2 dropped them, so cdkd's state records them
      // absent) and verify.sh has set them OUT OF BAND — so this is the
      // never-declared arm: a change INSIDE the block that must NOT disturb a
      // member no template declares. That arm is what discriminates the
      // removal rule from "re-serialize the struct whenever its declared
      // content changed", and it is the one polarity a removal-keyed fix can
      // get wrong by clobbering a value CloudFormation preserves.
      cfnService.addPropertyOverride('DeploymentConfiguration', {
        MaximumPercent: 175,
        MinimumHealthyPercent: 25,
        DeploymentCircuitBreaker: {
          Enable: true,
          Rollback: isCircuitBreakerRollbackFlip,
        },
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
