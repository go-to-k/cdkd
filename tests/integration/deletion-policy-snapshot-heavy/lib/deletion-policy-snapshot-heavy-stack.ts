import * as cdk from 'aws-cdk-lib';
import * as redshift from 'aws-cdk-lib/aws-redshift';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import { Construct } from 'constructs';

/**
 * DeletionPolicy: Snapshot heavy fixture (issue #1353) — the two
 * CFn-documented Snapshot-capable types that need cdkd's pre-delete
 * snapshot machinery on top of #1352's EBS coverage:
 *
 *   - `AWS::Redshift::Cluster` (single-node ra3.large — the cheapest
 *     ORDERABLE Redshift shape): destroy must run `CreateClusterSnapshot` +
 *     wait to `available` before the CC-routed delete.
 *   - `AWS::ElastiCache::ReplicationGroup` (1-node Redis on cache.t3.micro):
 *     destroy must run the ElastiCache `CreateSnapshot` (replication-group
 *     form) + wait before the CC-routed delete.
 *
 * The Redshift master password is provided per-run via
 * `CDKD_TEST_RS_PASSWORD` (a throwaway credential for a cluster that lives
 * ~20 minutes; never committed).
 */
export class DeletionPolicySnapshotHeavyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const password = process.env.CDKD_TEST_RS_PASSWORD;
    if (!password) {
      throw new Error('CDKD_TEST_RS_PASSWORD env var is required (set by verify.sh)');
    }

    const cluster = new redshift.CfnCluster(this, 'Warehouse', {
      // Explicit id on purpose. Without one the identifier comes from Cloud
      // Control's auto-naming, whose random suffix intermittently violates
      // Redshift's rules ("The parameter ClusterIdentifier is not a valid
      // identifier", seen live 2026-08-03 on one run while an earlier run of
      // the same fixture happened to get a valid one). A fixed id also makes
      // the generated final-snapshot name deterministic.
      clusterIdentifier: 'cdkd-integ-dps-heavy-rs',
      clusterType: 'single-node',
      // Smallest node type AWS still lets you ORDER: dc2.large is retired for
      // new clusters ("Invalid node type: dc2.large", seen live 2026-08-03).
      // Confirm with `aws redshift describe-orderable-cluster-options` before
      // changing this.
      nodeType: 'ra3.large',
      dbName: 'cdkdinteg',
      masterUsername: 'cdkdadmin',
      masterUserPassword: password,
      publiclyAccessible: false,
      // The CFn property default is `false`, which makes the delete handler
      // take its OWN final snapshot (and demand an identifier). This fixture
      // exercises CDKD's `DeletionPolicy: Snapshot` snapshot, so opt the
      // CFn-level one out — otherwise the run produces two snapshots and the
      // delete's outcome depends on the handler's identifier generation.
      skipFinalClusterSnapshot: true,
      tags: [{ key: 'cdkd-integ', value: 'deletion-policy-snapshot-heavy-redshift' }],
    });
    cluster.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.SNAPSHOT;
    new cdk.CfnOutput(this, 'ClusterId', { value: cluster.ref });

    const group = new elasticache.CfnReplicationGroup(this, 'Cache', {
      // Explicit id for the same reason as the cluster above.
      replicationGroupId: 'cdkd-integ-dps-heavy-rg',
      replicationGroupDescription: 'cdkd deletion-policy-snapshot-heavy integ (issue #1353)',
      engine: 'redis',
      cacheNodeType: 'cache.t3.micro',
      numCacheClusters: 1,
      automaticFailoverEnabled: false,
      tags: [{ key: 'cdkd-integ', value: 'deletion-policy-snapshot-heavy-redis' }],
    });
    group.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.SNAPSHOT;
    new cdk.CfnOutput(this, 'ReplicationGroupId', { value: group.ref });
  }
}
