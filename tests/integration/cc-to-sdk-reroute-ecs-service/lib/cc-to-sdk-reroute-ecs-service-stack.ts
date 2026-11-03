import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';

/**
 * `DeploymentConfiguration.MinimumHealthyPercent` per routing phase: a mutable
 * member `UpdateService` takes in place, read back by `describe-services`.
 * Consecutive deploys must differ, or the differ calls the service NO_CHANGE
 * and never provisions it, so it could not flip. verify.sh runs its
 * `cdkd diff` with `pinned`, because `seed` and `flip` declare one value.
 */
const MIN_HEALTHY_BY_PHASE: Record<string, number> = {
  base: 100,
  seed: 50,
  pinned: 100,
  flip: 50,
};

/**
 * Sticky-CC -> SDK flip arm for issue 5654: a service recorded
 * `provisionedBy: 'cc-api'` returns to its SDK provider without replacement,
 * and its recorded id moves to the SDK form.
 *
 * covers: AWS::ECS::Service
 *
 * The ids DIFFER between the layers: the schema's `primaryIdentifier` is
 * `[ServiceArn, Cluster]`, and Cloud Control's `Identifier` is
 * `<serviceArn>|<cluster>` (measured us-east-1, 2026-11-03), while
 * `ECSProvider.create` records the bare CreateService `serviceArn`. The
 * exemption entry's declared normalizer keeps the ARN part on the flip; this
 * fixture observes that the result is the live service's ARN and that the
 * service was updated in place (its AWS-minted `createdAt` survives).
 *
 * Cost: desiredCount 0, so no task ever launches; the VPC has one isolated
 * subnet and no NAT gateway.
 */
export class CcToSdkRerouteEcsServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env.CDKD_TEST_PHASE ?? 'base';
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });
    const group = new ec2.SecurityGroup(this, 'Group', { vpc, description: 'reroute service' });
    const cluster = new ecs.CfnCluster(this, 'Cluster');
    const taskDefinition = new ecs.CfnTaskDefinition(this, 'TaskDef', {
      requiresCompatibilities: ['FARGATE'],
      networkMode: 'awsvpc',
      cpu: '256',
      memory: '512',
      containerDefinitions: [
        {
          name: 'app',
          image: 'public.ecr.aws/amazonlinux/amazonlinux:latest',
          essential: true,
        },
      ],
    });

    const service = new ecs.CfnService(this, 'RerouteService', {
      cluster: cluster.ref,
      launchType: 'FARGATE',
      desiredCount: 0,
      taskDefinition: taskDefinition.ref,
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: 'DISABLED',
          subnets: [vpc.isolatedSubnets[0]!.subnetId],
          securityGroups: [group.securityGroupId],
        },
      },
      deploymentConfiguration: {
        maximumPercent: 200,
        minimumHealthyPercent: MIN_HEALTHY_BY_PHASE[phase] ?? 100,
      },
    });

    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.ref });
    new cdk.CfnOutput(this, 'ServiceRef', { value: service.ref });
    new cdk.CfnOutput(this, 'ServiceNameAttr', { value: service.attrName });
  }
}
