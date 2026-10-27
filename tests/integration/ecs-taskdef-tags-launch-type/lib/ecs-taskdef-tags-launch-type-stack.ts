import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';

/**
 * ECS TaskDefinition Tags update + Service LaunchType change (issue #5392).
 *
 * covers: AWS::ECS::Cluster
 * covers: AWS::ECS::TaskDefinition
 * covers: AWS::ECS::Service
 *
 * Two update paths, each measured against CloudFormation first:
 *
 * - TaskDefinition `Tags` is the one property the registry schema leaves
 *   updatable; CloudFormation tags the SAME revision in place. Before the fix
 *   every TaskDefinition update threw, so a tags-only change failed the deploy.
 * - Service `LaunchType` has no `UpdateService` member. CloudFormation REPLACES
 *   the service on a set or changed value, and on a removal updates in place
 *   keeping the live launch type. Before the fix cdkd recorded the new value
 *   while AWS kept the old one.
 *
 * Mode list (`CDKD_TEST_UPDATE`): '' (phase 1) | 'true' (phase 2: tags
 * v1 -> v2 with one key removed, LaunchType EC2 -> EXTERNAL) | 'true,rm-lt'
 * (phase 3: LaunchType removed). `includes` keeps the shape monotonic.
 *
 * Bridge networking and a desired count of 0: no VPC, no instance, no task
 * ever runs, so only control-plane resources exist.
 */
export class EcsTaskdefTagsLaunchTypeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const mode = process.env.CDKD_TEST_UPDATE ?? '';
    const isUpdate = mode.includes('true');
    const isLaunchTypeRemoved = mode.includes('rm-lt');

    const cluster = new ecs.CfnCluster(this, 'Cluster');

    const taskDefinition = new ecs.CfnTaskDefinition(this, 'TaskDef', {
      requiresCompatibilities: ['EC2', 'EXTERNAL'],
      networkMode: 'bridge',
      containerDefinitions: [
        {
          name: 'app',
          image: 'public.ecr.aws/docker/library/busybox:latest',
          memory: 64,
          essential: true,
          command: ['sleep', '3600'],
        },
      ],
      tags: isUpdate
        ? [{ key: 'cdkd-5392', value: 'v2' }]
        : [
            { key: 'cdkd-5392', value: 'v1' },
            { key: 'cdkd-5392-gone', value: 'x' },
          ],
    });

    const service = new ecs.CfnService(this, 'Svc', {
      cluster: cluster.ref,
      taskDefinition: taskDefinition.ref,
      desiredCount: 0,
      ...(!isLaunchTypeRemoved && { launchType: isUpdate ? 'EXTERNAL' : 'EC2' }),
    });

    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.ref });
    new cdk.CfnOutput(this, 'TaskDefArn', { value: taskDefinition.ref });
    new cdk.CfnOutput(this, 'ServiceArn', { value: service.ref });
  }
}
