import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as neptune from 'aws-cdk-lib/aws-neptune';

/**
 * go-to-k/cdkd#4606, the Neptune arm: a fix-forward deploy deletes the DB
 * cluster and DB instance a failed CREATE left in AWS.
 *
 * - The baseline holds an isolated VPC, a Neptune DB subnet group and
 *   `BaseCluster`, a cluster with no instance: every Neptune instance belongs
 *   to a cluster, and one created in the same deploy as its cluster would
 *   never be attempted once the cluster's CREATE fails.
 * - `WITH_ORPHANS=true` adds `OrphanCluster` (a cluster with no instance) and
 *   `OrphanInstance` (an instance in `BaseCluster`). verify.sh deploys that
 *   template as a role that may create them but not describe them, so each
 *   CREATE fails after AWS made the resource: the journal records both as
 *   proven orphans.
 * - `ORPHAN_FIX_FORWARD=true` keeps both logical ids under other identifiers
 *   (`-b`), so the fix-forward deploy creates two new resources and must
 *   delete the earlier two, proven different by their live resource ids.
 *
 * Every property set on the three is one the Neptune SDK provider handles,
 * so all stay on the SDK route (`provisionedBy: sdk`), where
 * `isSameResource` lives. Neptune takes no master password.
 */
export class NeptuneFixForwardOrphanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'neptune-fix-forward-orphan');

    const vpc = new ec2.Vpc(this, 'Vpc', {
      // Three AZs: db.t3.medium below is orderable in us-east-1a/b/c, and the
      // RDS arm's instance CREATEs failed for AZ capacity across two.
      maxAzs: 3,
      natGateways: 0,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    const subnetGroup = new neptune.CfnDBSubnetGroup(this, 'SubnetGroup', {
      dbSubnetGroupDescription: 'Subnet group for the neptune-fix-forward-orphan fixture',
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
    });
    subnetGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const prefix = this.stackName.toLowerCase();

    const baseCluster = new neptune.CfnDBCluster(this, 'BaseCluster', {
      dbClusterIdentifier: `${prefix}-base-cluster`,
      dbSubnetGroupName: subnetGroup.ref,
      deletionProtection: false,
    });
    baseCluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    if (process.env.WITH_ORPHANS !== 'true') return;

    const suffix = process.env.ORPHAN_FIX_FORWARD === 'true' ? '-b' : '';

    const cluster = new neptune.CfnDBCluster(this, 'OrphanCluster', {
      dbClusterIdentifier: `${prefix}-orphan-cluster${suffix}`,
      dbSubnetGroupName: subnetGroup.ref,
      deletionProtection: false,
    });
    cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const instance = new neptune.CfnDBInstance(this, 'OrphanInstance', {
      dbInstanceIdentifier: `${prefix}-orphan-db${suffix}`,
      // The cheapest class orderable for the default engine version in all
      // three of the VPC's AZs (db.t4g.medium is in two).
      dbInstanceClass: 'db.t3.medium',
      dbClusterIdentifier: baseCluster.ref,
    });
    instance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
