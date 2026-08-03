import * as cdk from 'aws-cdk-lib';
import * as redshift from 'aws-cdk-lib/aws-redshift';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import { Construct } from 'constructs';

/**
 * DeletionPolicy: Snapshot heavy fixture (issue #1353) — the two
 * CFn-documented Snapshot-capable types that need cdkd's pre-delete
 * snapshot machinery on top of #1352's EBS coverage:
 *
 *   - `AWS::Redshift::Cluster` (single-node dc2.large — the cheapest
 *     Redshift shape): destroy must run `CreateClusterSnapshot` + wait to
 *     `available` before the CC-routed delete.
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
      clusterType: 'single-node',
      nodeType: 'dc2.large',
      dbName: 'cdkdinteg',
      masterUsername: 'cdkdadmin',
      masterUserPassword: password,
      publiclyAccessible: false,
      tags: [{ key: 'cdkd-integ', value: 'deletion-policy-snapshot-heavy-redshift' }],
    });
    cluster.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.SNAPSHOT;
    new cdk.CfnOutput(this, 'ClusterId', { value: cluster.ref });

    const group = new elasticache.CfnReplicationGroup(this, 'Cache', {
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
