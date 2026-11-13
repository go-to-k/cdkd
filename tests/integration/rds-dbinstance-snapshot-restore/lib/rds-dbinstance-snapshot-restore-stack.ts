import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#5640: `AWS::RDS::DBInstance` restored from a snapshot through
 * cdkd's SDK route (`DBSnapshotIdentifier`, `DBClusterSnapshotIdentifier`),
 * and to a point in time (`UseLatestRestorableTime`).
 *
 * - `Source` is a PostgreSQL `db.t3.micro` instance with a database `appdb`,
 *   master user `cdkdadmin` (password managed in Secrets Manager by RDS) and
 *   one day of automated backups (a point-in-time restore reads them).
 *   `SourceCluster` is a Multi-AZ DB
 *   cluster (PostgreSQL, `db.c6gd.medium`, io1 100 GiB at 1000 IOPS, the
 *   `rds-multiaz-cluster` fixture's measured shape) with master user
 *   `postgres` and retention 1. verify.sh takes a manual snapshot of each (a
 *   template cannot make one).
 * - CDKD_TEST_SNAPSHOT_ID set adds `SnapInstance`, restored from the DB
 *   snapshot, and CDKD_TEST_CLUSTER_SNAPSHOT_ID set adds `ClusterSnapInstance`,
 *   restored from the cluster snapshot. Neither declares an engine (cdkd reads
 *   the snapshot's, as CloudFormation's handler does) nor a database name.
 *   Each declares members only the restore call carries (Port,
 *   CopyTagsToSnapshot) and members only CloudFormation's follow-up
 *   ModifyDBInstance carries (the retention, the backup window). `SnapInstance`
 *   also declares a MasterUsername the restore cannot set (cdkd warns).
 * - CDKD_TEST_PITR=true adds `PitrInstance`, restored from `Source` to its
 *   latest restorable time (`SourceDBInstanceIdentifier` +
 *   `UseLatestRestorableTime: true`), declaring no engine. It declares a
 *   member only the restore call carries (Port, MaxAllocatedStorage) and
 *   members only the follow-up carries (the retention, the backup window).
 *   CDKD_TEST_PITR_RESTORE_TIME adds that `RestoreTime` to it (an update
 *   cdkd refuses).
 * - CDKD_TEST_CLUSTER_REPLICA=true adds `ClusterReplicaInstance`, a DB
 *   instance read replica of `SourceCluster` (`SourceDBClusterIdentifier`),
 *   declaring no engine. RDS wants the cluster's allocated storage (100 GiB)
 *   on it; gp3 keeps it cheap. Its maintenance window rides only the
 *   follow-up ModifyDBInstance.
 * - CDKD_TEST_UPDATE=true: `SnapInstance`'s `BackupRetentionPeriod` 3 -> 4
 *   and `PitrInstance`'s 2 -> 3, in place, and `ClusterReplicaInstance` drops
 *   its source (cdkd promotes it to a standalone instance).
 *
 * Fixed names so verify.sh can read them back and sweep them.
 */
export class RdsDbInstanceSnapshotRestoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    const snapshotId = process.env.CDKD_TEST_SNAPSHOT_ID;
    const clusterSnapshotId = process.env.CDKD_TEST_CLUSTER_SNAPSHOT_ID;
    const pointInTime = process.env.CDKD_TEST_PITR === 'true';
    const restoreTime = process.env.CDKD_TEST_PITR_RESTORE_TIME;
    const clusterReplica = process.env.CDKD_TEST_CLUSTER_REPLICA === 'true';

    cdk.Tags.of(this).add('cdkd-integ-fixture', 'rds-dbinstance-snapshot-restore');

    // Three AZs (a Multi-AZ DB cluster needs them), isolated subnets, no NAT:
    // nothing connects to the databases.
    const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';
    const vpc = new ec2.Vpc(this, 'Vpc', {
      availabilityZones: [`${region}a`, `${region}b`, `${region}c`],
      natGateways: 0,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    const subnetGroup = new rds.CfnDBSubnetGroup(this, 'SubnetGroup', {
      dbSubnetGroupName: 'cdkd-integ-rds-inst-snap-5640',
      dbSubnetGroupDescription: 'cdkd integ rds instance snapshot restore subnet group',
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });
    subnetGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const source = new rds.CfnDBInstance(this, 'Source', {
      dbInstanceIdentifier: 'cdkd-integ-rds-inst-src-5640',
      engine: 'postgres',
      dbInstanceClass: 'db.t3.micro',
      allocatedStorage: '20',
      storageType: 'gp2',
      dbName: 'appdb',
      masterUsername: 'cdkdadmin',
      manageMasterUserPassword: true,
      dbSubnetGroupName: subnetGroup.ref,
      backupRetentionPeriod: 1,
      // Declared so the maintenance window never overlaps the backup window.
      preferredBackupWindow: '04:00-04:30',
      preferredMaintenanceWindow: 'sun:10:00-sun:10:30',
      publiclyAccessible: false,
      deletionProtection: false,
    });
    source.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const sourceCluster = new rds.CfnDBCluster(this, 'SourceCluster', {
      dbClusterIdentifier: 'cdkd-integ-rds-maz-src-5640',
      engine: 'postgres',
      masterUsername: 'postgres',
      manageMasterUserPassword: true,
      dbSubnetGroupName: subnetGroup.ref,
      dbClusterInstanceClass: 'db.c6gd.medium',
      storageType: 'io1',
      allocatedStorage: 100,
      iops: 1000,
      backupRetentionPeriod: 1,
      deletionProtection: false,
    });
    sourceCluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    if (snapshotId !== undefined && snapshotId !== '') {
      const restored = new rds.CfnDBInstance(this, 'SnapInstance', {
        dbInstanceIdentifier: 'cdkd-integ-rds-inst-restored-5640',
        dbSnapshotIdentifier: snapshotId,
        dbInstanceClass: 'db.t3.micro',
        // A restore keeps the snapshot's user name; cdkd warns, as CloudFormation ignores it.
        masterUsername: 'otheradmin',
        dbSubnetGroupName: subnetGroup.ref,
        // On the restore call.
        port: '5434',
        copyTagsToSnapshot: true,
        // On the follow-up ModifyDBInstance only.
        backupRetentionPeriod: isUpdate ? 4 : 3,
        preferredBackupWindow: '05:00-05:30',
        // Declared so RDS's randomly assigned maintenance window can never
        // overlap the backup window, which fails the follow-up.
        preferredMaintenanceWindow: 'sun:10:00-sun:10:30',
        publiclyAccessible: false,
        deletionProtection: false,
      });
      restored.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    }

    if (clusterSnapshotId !== undefined && clusterSnapshotId !== '') {
      const fromCluster = new rds.CfnDBInstance(this, 'ClusterSnapInstance', {
        dbInstanceIdentifier: 'cdkd-integ-rds-inst-from-maz-5640',
        dbClusterSnapshotIdentifier: clusterSnapshotId,
        dbInstanceClass: 'db.t3.micro',
        dbSubnetGroupName: subnetGroup.ref,
        // On the restore call.
        port: '5435',
        // On the follow-up ModifyDBInstance only.
        backupRetentionPeriod: 2,
        preferredBackupWindow: '06:00-06:30',
        preferredMaintenanceWindow: 'sun:10:00-sun:10:30',
        publiclyAccessible: false,
        deletionProtection: false,
      });
      fromCluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    }

    if (pointInTime) {
      const restoredToTime = new rds.CfnDBInstance(this, 'PitrInstance', {
        dbInstanceIdentifier: 'cdkd-integ-rds-inst-pitr-5640',
        // With a point-in-time key, the restore's source, not a replica's.
        sourceDbInstanceIdentifier: source.ref,
        useLatestRestorableTime: true,
        ...(restoreTime !== undefined && restoreTime !== '' && { restoreTime }),
        dbInstanceClass: 'db.t3.micro',
        dbSubnetGroupName: subnetGroup.ref,
        // On the restore call.
        port: '5436',
        maxAllocatedStorage: 40,
        // On the follow-up ModifyDBInstance only.
        backupRetentionPeriod: isUpdate ? 3 : 2,
        preferredBackupWindow: '07:00-07:30',
        preferredMaintenanceWindow: 'sun:10:00-sun:10:30',
        publiclyAccessible: false,
        deletionProtection: false,
      });
      restoredToTime.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    }

    if (clusterReplica) {
      const replica = new rds.CfnDBInstance(this, 'ClusterReplicaInstance', {
        dbInstanceIdentifier: 'cdkd-integ-rds-inst-maz-rr-5640',
        // A read replica of the Multi-AZ DB cluster; removed on update (a promotion).
        ...(!isUpdate && { sourceDbClusterIdentifier: sourceCluster.ref }),
        dbInstanceClass: 'db.t3.micro',
        dbSubnetGroupName: subnetGroup.ref,
        // RDS creates the replica with the cluster's allocated storage.
        allocatedStorage: '100',
        storageType: 'gp3',
        // On the follow-up ModifyDBInstance only.
        preferredMaintenanceWindow: 'sun:11:00-sun:11:30',
        publiclyAccessible: false,
        deletionProtection: false,
      });
      replica.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    }
  }
}
