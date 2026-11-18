import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import type { Construct } from 'constructs';

/**
 * An L1 ECS cluster whose capacity providers and `containerInsights` setting
 * change in the same update (issue #6562).
 *
 * `PutClusterCapacityProviders` leaves the cluster's attachments
 * `UPDATE_IN_PROGRESS` for a few seconds, and ECS refuses the `UpdateCluster`
 * cdkd sends for the settings meanwhile. cdkd now waits for the attachments
 * between the two calls, and sends the Put only when the providers changed.
 *
 * Three shapes, selected per phase by verify.sh:
 *   - base (no env):                  [FARGATE], containerInsights disabled
 *   - CDKD_TEST_UPDATE=true:          [FARGATE, FARGATE_SPOT], enabled
 *   - ... plus CDKD_TEST_SETTINGS_ONLY=true: the same providers, enhanced
 *   - CDKD_TEST_NO_PROVIDERS=true:    neither property declared, disabled;
 *     CloudFormation clears both lists then, and so must cdkd
 *
 * covers: AWS::ECS::Cluster
 */
export class EcsClusterCapacitySettingsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const updating = process.env.CDKD_TEST_UPDATE === 'true';
    const settingsOnly = updating && process.env.CDKD_TEST_SETTINGS_ONLY === 'true';

    const noProviders = process.env.CDKD_TEST_NO_PROVIDERS === 'true';
    const insights = noProviders
      ? 'disabled'
      : settingsOnly
        ? 'enhanced'
        : updating
          ? 'enabled'
          : 'disabled';

    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      ...(!noProviders && {
        capacityProviders: updating ? ['FARGATE', 'FARGATE_SPOT'] : ['FARGATE'],
        defaultCapacityProviderStrategy: updating
          ? [
              { capacityProvider: 'FARGATE', weight: 1, base: 1 },
              { capacityProvider: 'FARGATE_SPOT', weight: 2 },
            ]
          : [{ capacityProvider: 'FARGATE', weight: 1 }],
      }),
      clusterSettings: [{ name: 'containerInsights', value: insights }],
    });
    cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.ref });
  }
}
