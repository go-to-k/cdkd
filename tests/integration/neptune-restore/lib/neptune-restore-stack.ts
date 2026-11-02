import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as neptune from 'aws-cdk-lib/aws-neptune';

/**
 * go-to-k/cdkd#5638: `AWS::Neptune::DBCluster` restored through the SDK
 * provider, from a cluster snapshot and to a point in time.
 *
 * - The baseline holds an isolated VPC, a DB subnet group, `SourceCluster` and
 *   its instance: a copy-on-write restore refuses a source with no healthy
 *   instance. The source's windows, retention and port are values no default
 *   produces, so a restored cluster shows which side each value came from.
 * - `RESTORE_SNAPSHOT_ID` and `RESTORE_TO_TIME` come from verify.sh, which
 *   takes the snapshot between the two deploys under a run-unique name. Set,
 *   they add one cluster per restore shape, none with an instance.
 *
 * Every property set here is one the SDK provider handles, so all stay on the
 * SDK route (`provisionedBy: sdk`); verify.sh asserts that.
 */
export class NeptuneRestoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'neptune-restore');

    const vpc = new ec2.Vpc(this, 'Vpc', {
      // Three AZs: db.t3.medium is orderable in us-east-1a/b/c.
      maxAzs: 3,
      natGateways: 0,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    const subnetGroup = new neptune.CfnDBSubnetGroup(this, 'SubnetGroup', {
      dbSubnetGroupDescription: 'Subnet group for the neptune-restore fixture',
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
    });
    subnetGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const prefix = this.stackName.toLowerCase();
    const source = `${prefix}-source`;

    const sourceCluster = new neptune.CfnDBCluster(this, 'SourceCluster', {
      dbClusterIdentifier: source,
      dbSubnetGroupName: subnetGroup.ref,
      dbPort: 8183,
      backupRetentionPeriod: 7,
      preferredBackupWindow: '07:11-07:41',
      preferredMaintenanceWindow: 'sat:03:11-sat:03:41',
      deletionProtection: false,
    });
    sourceCluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const sourceInstance = new neptune.CfnDBInstance(this, 'SourceInstance', {
      dbInstanceIdentifier: `${prefix}-source-db`,
      dbClusterIdentifier: sourceCluster.ref,
      dbInstanceClass: 'db.t3.medium',
    });
    sourceInstance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const snapshotId = process.env.RESTORE_SNAPSHOT_ID;
    const restoreToTime = process.env.RESTORE_TO_TIME;
    if (!snapshotId || !restoreToTime) return;

    const restored = (
      logicalId: string,
      properties: neptune.CfnDBClusterProps
    ): neptune.CfnDBCluster => {
      const cluster = new neptune.CfnDBCluster(this, logicalId, {
        dbSubnetGroupName: subnetGroup.ref,
        deletionProtection: false,
        ...properties,
      });
      cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
      cluster.addResourceDependency(sourceInstance);
      return cluster;
    };

    restored('FromSnapshot', {
      dbClusterIdentifier: `${prefix}-from-snapshot`,
      snapshotIdentifier: snapshotId,
      backupRetentionPeriod: 5,
      preferredBackupWindow: '05:11-05:41',
      iamAuthEnabled: true,
      copyTagsToSnapshot: true,
    });
    restored('BareSnapshot', {
      dbClusterIdentifier: `${prefix}-bare-snapshot`,
      snapshotIdentifier: snapshotId,
      storageEncrypted: true,
    });
    const latestClone = restored('LatestClone', {
      dbClusterIdentifier: `${prefix}-latest-clone`,
      sourceDbClusterIdentifier: source,
      useLatestRestorableTime: true,
      restoreType: 'copy-on-write',
      backupRetentionPeriod: 3,
      copyTagsToSnapshot: true,
      // Overlaps the maintenance window it inherits: AWS refuses this one key,
      // which CloudFormation never sends, and the deploy goes on.
      preferredBackupWindow: '03:20-03:50',
    });
    if (process.env.RESTORE_UPDATE === 'true') {
      cdk.Tags.of(latestClone).add('restore-update', 'applied');
    }
    restored('ToTime', {
      dbClusterIdentifier: `${prefix}-to-time`,
      sourceDbClusterIdentifier: source,
      restoreToTime,
      restoreType: 'full-copy',
      // verify.sh's ordinary update: a restored cluster takes one in place.
      ...(process.env.RESTORE_UPDATE === 'true' && { backupRetentionPeriod: 9 }),
    });
  }
}
