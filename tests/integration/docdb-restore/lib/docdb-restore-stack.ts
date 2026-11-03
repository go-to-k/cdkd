import * as cdk from 'aws-cdk-lib';
import * as docdb from 'aws-cdk-lib/aws-docdb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#5628: `AWS::DocDB::DBCluster` restored through cdkd's SDK route.
 *
 * - `Source` is an ordinary cluster on port 27018. verify.sh snapshots it
 *   between phases (CloudFormation has no DocDB snapshot type).
 * - CDKD_TEST_RESTORE=true adds `SnapCluster`, restored from that snapshot,
 *   and `PitrCluster`, restored from `Source` at its latest restorable time;
 *   with CDKD_TEST_RESTORE_TIME set (verify.sh passes the source's latest
 *   restorable time), `TimeCluster` too, restored to that time. Each declares
 *   values a restore call has no member for, which the provider's follow-up
 *   ModifyDBCluster sends (a parameter group of the fixture's own, so the
 *   default a restore takes cannot pass for it), and a MasterUsername the
 *   restore cannot set (each keeps the source's).
 * - CDKD_TEST_UPDATE=true: `PitrCluster`'s `RestoreType` changes (in place,
 *   nothing sent for it, as CloudFormation) beside `BackupRetentionPeriod` 5 -> 6.
 *
 * No instances: the restore path is the subject, and an instance-less cluster
 * restores in minutes. So `RestoreType: copy-on-write`, which needs a source
 * instance, is never restored here; phase 4 only changes it in place. Fixed names so verify.sh can read them back.
 */
export const SNAPSHOT_ID = 'cdkd-integ-docdb-restore-5628';

export class DocdbRestoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const isRestore = process.env.CDKD_TEST_RESTORE === 'true';
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    const restoreTime = process.env.CDKD_TEST_RESTORE_TIME;

    // 2 AZs, public subnets, no NAT: nothing connects to the clusters.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC }],
    });

    const subnetGroup = new docdb.CfnDBSubnetGroup(this, 'SubnetGroup', {
      dbSubnetGroupName: 'cdkd-integ-docdb-restore-5628',
      dbSubnetGroupDescription: 'cdkd integ docdb restore subnet group',
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds,
    });
    subnetGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // MasterUsername: DocDB reserves `admin`; MasterUserPassword: 8-100 chars,
    // no `/`, `"`, `@` (the docdb-neptune fixture's literal).
    const source = new docdb.CfnDBCluster(this, 'Source', {
      dbClusterIdentifier: 'cdkd-integ-docdb-restore-src-5628',
      engineVersion: '5.0.0',
      masterUsername: 'cdkdadmin',
      masterUserPassword: 'TempPass1234!',
      port: 27018,
      dbSubnetGroupName: subnetGroup.ref,
      backupRetentionPeriod: 1,
      deletionProtection: false,
    });
    source.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    if (!isRestore) return;

    const params = new docdb.CfnDBClusterParameterGroup(this, 'ClusterParams', {
      name: 'cdkd-integ-docdb-restore-5628',
      family: 'docdb5.0',
      description: 'cdkd integ docdb restore cluster parameter group',
      parameters: { tls: 'enabled' },
    });
    params.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const snap = new docdb.CfnDBCluster(this, 'SnapCluster', {
      dbClusterIdentifier: 'cdkd-integ-docdb-restore-snap-5628',
      snapshotIdentifier: SNAPSHOT_ID,
      engineVersion: '5.0.0',
      // A restore keeps the source's user name; cdkd warns, as CloudFormation ignores it.
      masterUsername: 'otheradmin',
      // Dropped by CloudFormation's restore; cdkd's follow-up sends it.
      masterUserPassword: 'TempPass5678!',
      dbSubnetGroupName: subnetGroup.ref,
      // CloudFormation's own follow-up ModifyDBCluster after a snapshot restore.
      dbClusterParameterGroupName: params.ref,
      backupRetentionPeriod: 3,
      preferredBackupWindow: '05:00-05:30',
      preferredMaintenanceWindow: 'sun:06:00-sun:06:30',
      copyTagsToSnapshot: true,
      deletionProtection: false,
    });
    snap.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    snap.addDependency(source);

    const pitr = new docdb.CfnDBCluster(this, 'PitrCluster', {
      dbClusterIdentifier: 'cdkd-integ-docdb-restore-pitr-5628',
      sourceDbClusterIdentifier: source.ref,
      useLatestRestorableTime: true,
      // copy-on-write needs a source with an instance; this change is in place.
      restoreType: isUpdate ? 'copy-on-write' : 'full-copy',
      masterUsername: 'otheradmin',
      dbSubnetGroupName: subnetGroup.ref,
      // Dropped by CloudFormation's point-in-time restore; cdkd's follow-up sends them.
      backupRetentionPeriod: isUpdate ? 6 : 5,
      preferredBackupWindow: '05:00-05:30',
      preferredMaintenanceWindow: 'sun:06:00-sun:06:30',
      // No restore member in this SDK: cdkd's follow-up sends it.
      dbClusterParameterGroupName: params.ref,
      deletionProtection: false,
    });
    pitr.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    if (restoreTime === undefined || restoreTime === '') return;
    const timed = new docdb.CfnDBCluster(this, 'TimeCluster', {
      dbClusterIdentifier: 'cdkd-integ-docdb-restore-time-5628',
      sourceDbClusterIdentifier: source.ref,
      restoreToTime: restoreTime,
      restoreType: 'full-copy',
      masterUsername: 'otheradmin',
      dbSubnetGroupName: subnetGroup.ref,
      backupRetentionPeriod: 4,
      dbClusterParameterGroupName: params.ref,
      deletionProtection: false,
    });
    timed.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
