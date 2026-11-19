import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';

/**
 * Integ probe for go-to-k/cdkd#6610: the capacity providers an
 * `AWS::ECS::ClusterCapacityProviderAssociations` attaches to a cluster are
 * that resource's, not the cluster's. `DescribeClusters` reports them as the
 * cluster's `CapacityProviders` / `DefaultCapacityProviderStrategy`, so once
 * a cluster UPDATE re-captured its baseline with the association's providers,
 * a later change to the association read as cluster drift, and
 * `cdkd drift --revert` sent the stale list through
 * `PutClusterCapacityProviders`, detaching what the association attached.
 *
 * L1 constructs, so no VPC is created (the `ecs.Cluster` L2 makes one).
 * - Default: the cluster (tag `phase=1`) and an association attaching FARGATE.
 * - `CDKD_TEST_UPDATE=tag`: the cluster's tag changes, so the cluster is
 *   UPDATED while the association exists and its baseline records FARGATE.
 * - `spot`: the association also attaches FARGATE_SPOT; the cluster is
 *   unchanged.
 * - `noassoc`: the association is removed, and its delete detaches both.
 *
 * covers: AWS::ECS::Cluster
 * covers: AWS::ECS::ClusterCapacityProviderAssociations
 */
export class DriftEcsCapacityAssociationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const modes = (process.env.CDKD_TEST_UPDATE ?? '').split(',');
    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterSettings: [{ name: 'containerInsights', value: 'disabled' }],
      tags: [{ key: 'phase', value: modes.includes('tag') ? '2' : '1' }],
    });

    // allow-mode-gated-drop: the removal IS the arm (its delete detaches the providers, and the deploy must prune the cluster's baseline).
    if (!modes.includes('noassoc')) {
      new ecs.CfnClusterCapacityProviderAssociations(this, 'Association', {
        cluster: cluster.ref,
        capacityProviders: modes.includes('spot') ? ['FARGATE', 'FARGATE_SPOT'] : ['FARGATE'],
        defaultCapacityProviderStrategy: [{ capacityProvider: 'FARGATE', weight: 1, base: 0 }],
      });
    }

    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.ref });
  }
}
