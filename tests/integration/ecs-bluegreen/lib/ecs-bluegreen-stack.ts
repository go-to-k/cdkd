import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * ECS Service blue/green `LoadBalancers[].AdvancedConfiguration` example
 * stack (issue #1480, follow-up to the #1473 silent-drop fix).
 *
 * Exercises the SDK-routed `ECSProvider.createService()` path with the
 * built-in ECS blue/green deployment shape: `DeploymentConfiguration.Strategy:
 * BLUE_GREEN` plus a `LoadBalancers[0].AdvancedConfiguration` block
 * (AlternateTargetGroupArn / ProductionListenerRule / TestListenerRule /
 * RoleArn). Before #1473, `convertLoadBalancers` dropped the whole
 * `AdvancedConfiguration` block on CreateService / UpdateService; the unit
 * tests pin the SDK input shape, and this fixture proves the block reaches
 * real AWS (verify.sh reads it back via `describe-services`).
 *
 * CRITICAL — this Service MUST stay on cdkd's SDK provider path (NOT Cloud
 * Control): no ServiceConnectConfiguration / VolumeConfigurations (the #614
 * silent-drop routing flips). LoadBalancers + DeploymentConfiguration are
 * handledProperties, so the service stays SDK-routed.
 *
 * Wiring the blue/green shape needs real ALB plumbing:
 *  - an internal ALB with a listener whose default action is a fixed 404,
 *  - a PRODUCTION listener rule forwarding to the blue target group,
 *  - a TEST listener rule forwarding to the green (alternate) target group,
 *  - an ECS infrastructure role trusted by ecs.amazonaws.com carrying the
 *    AWS-managed AmazonECSInfrastructureRolePolicyForLoadBalancers policy
 *    (ECS assumes it to shift the listener rules between target groups).
 *
 * Cost: desiredCount is 0 (no task ever launches; only control-plane
 * resources + an idle internal ALB exist for the few minutes of the run).
 */
export class EcsBluegreenStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ALB requires subnets in two AZs; keep them public (no NAT) for cost.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: 'cdkd-ecs-bluegreen-test',
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
    });
    taskDefinition.addContainer('App', {
      // Never pulled (desiredCount 0); public ECR keeps it pullable without
      // Docker Hub auth if a task ever does start.
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/nginx:alpine'),
      memoryLimitMiB: 512,
      portMappings: [{ containerPort: 80 }],
    });

    // Internal ALB — never exposed publicly; exists only so the listener
    // rules the AdvancedConfiguration block references are real.
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const blueTg = new elbv2.ApplicationTargetGroup(this, 'BlueTg', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
    });
    const greenTg = new elbv2.ApplicationTargetGroup(this, 'GreenTg', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
    });

    const listener = alb.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'no rule matched',
      }),
    });

    // Production traffic rule -> blue TG; test traffic rule -> green TG.
    // ECS's blue/green machinery shifts these between the two target groups.
    const prodRule = new elbv2.ApplicationListenerRule(this, 'ProdRule', {
      listener,
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/*'])],
      action: elbv2.ListenerAction.forward([blueTg]),
    });
    const testRule = new elbv2.ApplicationListenerRule(this, 'TestRule', {
      listener,
      priority: 5,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/cdkd-test/*'])],
      action: elbv2.ListenerAction.forward([greenTg]),
    });

    // The ECS infrastructure role blue/green assumes to modify the listener
    // rules. The AWS-managed policy is the documented pairing.
    const infraRole = new iam.Role(this, 'EcsInfraRole', {
      assumedBy: new iam.ServicePrincipal('ecs.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'AmazonECSInfrastructureRolePolicyForLoadBalancers'
        ),
      ],
    });

    // Plain L2 service with NO load balancer attach — the LoadBalancers block
    // (incl. AdvancedConfiguration, which the L2 does not model) is injected
    // whole via the L1 escape hatch so the wire shape is exactly what a
    // hand-written template emits.
    const service = new ecs.FargateService(this, 'Svc', {
      cluster,
      taskDefinition,
      desiredCount: 0,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const cfnService = service.node.defaultChild as ecs.CfnService;
    cfnService.addPropertyOverride('DeploymentConfiguration', {
      Strategy: 'BLUE_GREEN',
      BakeTimeInMinutes: 0,
      MaximumPercent: 200,
      MinimumHealthyPercent: 100,
    });
    cfnService.addPropertyOverride('LoadBalancers', [
      {
        ContainerName: 'App',
        ContainerPort: 80,
        TargetGroupArn: blueTg.targetGroupArn,
        AdvancedConfiguration: {
          AlternateTargetGroupArn: greenTg.targetGroupArn,
          ProductionListenerRule: prodRule.listenerRuleArn,
          TestListenerRule: testRule.listenerRuleArn,
          RoleArn: infraRole.roleArn,
        },
      },
    ]);
    // The listener rules / role only enter the template through the property
    // override above, which CDK cannot trace — make the edges explicit so
    // cdkd's DAG creates them before (and deletes them after) the service.
    service.node.addDependency(prodRule, testRule, infraRole);

    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'ServiceName', { value: service.serviceName });
    new cdk.CfnOutput(this, 'GreenTgArn', { value: greenTg.targetGroupArn });
    new cdk.CfnOutput(this, 'ProdRuleArn', { value: prodRule.listenerRuleArn });
    new cdk.CfnOutput(this, 'TestRuleArn', { value: testRule.listenerRuleArn });
    new cdk.CfnOutput(this, 'InfraRoleArn', { value: infraRole.roleArn });
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
  }
}
