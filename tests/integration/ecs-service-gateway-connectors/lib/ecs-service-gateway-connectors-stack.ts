import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * AWS::ECS::Service `GatewayConnectors` on cdkd's SDK route (issue #5634).
 *
 * covers: AWS::ECS::Service
 * covers: AWS::ECS::Gateway
 * covers: AWS::ECS::GatewayClusterAssociations
 *
 * Before #5634 the property sat in the coverage map's SDK-unwired set, so a
 * Service declaring it routed WHOLE through Cloud Control (sticky
 * `provisionedBy: cc-api`). verify.sh guards `provisionedBy != cc-api` and
 * reads the value back from the service REVISION (DescribeServices has no
 * `gatewayConnectors` member):
 *
 * - phase 0 (`CDKD_INTEG_PHASE=0`): only the gateway's infrastructure role
 *   and its role-independent prerequisites, ahead of the gateway, because of
 *   go-to-k/cdkd#5661 (see the comment above the `isPhase0` return).
 * - phase 1 (`CDKD_TEST_UPDATE` unset): the gateway, the association and
 *   CreateService with a full connector.
 * - phase 2 (`true`): a CHANGED connector reaches UpdateService.
 * - phase 3 (`true,remove`): the property is DROPPED. A CloudFormation A/B
 *   (recorded on the issue) showed CloudFormation KEEPS the live connector,
 *   so cdkd must send nothing and the phase-2 connector must survive.
 * - phase 4 (`true,remove,clear`): a DECLARED empty list, the form that
 *   clears the connector under CloudFormation, must clear it here too.
 *
 * A connector needs an `AWS::ECS::Gateway` (a host-shared ALB, so two AZs)
 * associated with the cluster, and a NAMED container port. The installed
 * aws-cdk-lib has no L1 for either gateway type nor a `gatewayConnectors`
 * member on CfnService, so all three are written as raw CFn. Neither gateway
 * type has an SDK provider, so cdkd provisions both through Cloud Control.
 *
 * Cost: desiredCount 0, so no task runs; the gateway's ALB runs for the
 * length of the test.
 */
export class EcsServiceGatewayConnectorsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const updateMode = process.env.CDKD_TEST_UPDATE ?? '';
    // verify.sh's per-run nonce. Its teardown sweep deletes a fixed-name
    // cluster or gateway ONLY when it carries this run's tag, so a same-named
    // resource another run (or anyone) owns is never touched.
    const runId = process.env.CDKD_INTEG_RUN_ID ?? 'unset';
    const runTag = { Key: 'cdkd-integ-run-id', Value: runId };
    const isUpdate = updateMode.includes('true');
    const isRemove = updateMode.includes('remove');
    const isClear = updateMode.includes('clear');
    const isPhase0 = process.env.CDKD_INTEG_PHASE === '0';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    const infraRole = new iam.Role(this, 'GatewayInfraRole', {
      assumedBy: new iam.ServicePrincipal('ecs.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonECSInfrastructureRoleForGatewayHostSharedALB'),
      ],
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: 'cdkd-ecs-svc-gw-connectors',
    });
    cdk.Tags.of(cluster).add(runTag.Key, runTag.Value);

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
    });
    taskDefinition.addContainer('App', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:latest'),
      portMappings: [{ containerPort: 80, name: 'web', appProtocol: ecs.AppProtocol.http }],
    });

    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });

    // go-to-k/cdkd#5661: an AWS::ECS::Gateway created in the SAME deploy as
    // its infrastructure role is rejected while the role propagates ("Could
    // not assume the infrastructure role", then "AWS was not able to validate
    // the provided access credentials"), and cdkd does not yet ride that out.
    // Phase 0 (`CDKD_INTEG_PHASE=0`) therefore deploys only the role and
    // everything the gateway needs that does not depend on it (VPC, cluster,
    // task definition); verify.sh waits before phase 1 adds the gateway, the
    // association and the service. Every later phase keeps all of them.
    if (isPhase0) return;

    // The gateway API accepts only HTTPS on 443 today ("Only HTTPS on port
    // 443 is currently supported"), with no certificate to supply.
    const gateway = new cdk.CfnResource(this, 'Gateway', {
      type: 'AWS::ECS::Gateway',
      properties: {
        GatewayName: 'cdkd-ecs-svc-gw-connectors',
        InfrastructureRoleArn: infraRole.roleArn,
        // The API default is TRUE, which refuses the destroy (CloudFormation's
        // delete fails the same way: "Gateway has deletion protection enabled").
        DeletionProtection: false,
        Tags: [runTag],
        Configuration: {
          HostSharedAlb: {
            NetworkConfiguration: {
              Subnets: vpc.publicSubnets.map((s) => s.subnetId),
            },
            Scheme: 'internet-facing',
            Protocol: 'HTTPS',
            Port: 443,
          },
        },
      },
    });
    // The role's managed policy must be attached before the gateway builds
    // its ALB with it, and an internet-facing ALB needs the internet gateway
    // attached and routed first (and torn down only after it is gone, on
    // destroy). The VPC-level `internetConnectivityEstablished` names only the
    // InternetGateway, so depend on each public subnet's, which carries its
    // default route and, through it, the gateway attachment.
    gateway.node.addDependency(infraRole);
    for (const subnet of vpc.publicSubnets) {
      gateway.node.addDependency(subnet.internetConnectivityEstablished);
    }

    const association = new cdk.CfnResource(this, 'GatewayClusterAssociation', {
      type: 'AWS::ECS::GatewayClusterAssociations',
      properties: {
        Gateway: gateway.getAtt('Arn').toString(),
        Cluster: cluster.clusterName,
      },
    });

    const service = new ecs.FargateService(this, 'Svc', {
      cluster,
      taskDefinition,
      desiredCount: 0,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    service.node.addDependency(association);

    const cfnService = service.node.defaultChild as ecs.CfnService;
    // All three nested blocks (PortName, HealthCheck, Filters), so a dropped
    // block shows; the wire spelling of every member is unit-pinned.
    // Phase 2 changes ONLY the filters: ECS refuses a HealthCheck change
    // under the ROLLING deployment strategy ("Target group properties cannot
    // be changed with ROLLING deployment strategy"), CloudFormation included.
    if (!isRemove) {
      cfnService.addPropertyOverride('GatewayConnectors', [
        {
          PortName: 'web',
          HealthCheck: { HealthCheckPath: '/health', HealthyThresholdCount: 3 },
          Filters: { AccessTypes: isUpdate ? ['PUBLIC', 'PRIVATE'] : ['PUBLIC'] },
        },
      ]);
    }
    // Phase 3 declares no GatewayConnectors at all: the removal arm.
    if (isClear) {
      cfnService.addPropertyOverride('GatewayConnectors', []);
    }

    new cdk.CfnOutput(this, 'ServiceName', { value: service.serviceName });
  }
}
