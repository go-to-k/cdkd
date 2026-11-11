import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#5639: `AWS::RDS::DBCluster` restored to a point in time through
 * cdkd's SDK route (`SourceDBClusterIdentifier`, `RestoreToTime`,
 * `RestoreType`, `UseLatestRestorableTime`).
 *
 * - `Source` is an Aurora PostgreSQL Serverless v2 cluster with no instance
 *   (it restores in minutes) and master user `cdkdadmin`.
 * - CDKD_TEST_RESTORE=true adds `PitrCluster`, restored from `Source` at its
 *   latest restorable time; with CDKD_TEST_RESTORE_TIME set (verify.sh passes
 *   the source's latest restorable time), `TimeCluster` too, restored to that
 *   time. Each declares a MasterUsername the restore cannot set (each keeps
 *   the source's), members the restore call carries (Port, CopyTagsToSnapshot,
 *   the scaling block) and members only CloudFormation's follow-up
 *   ModifyDBCluster carries (a parameter group of the fixture's own, so the
 *   default a restore takes cannot pass for it, the retention, the backup
 *   window, the Data API flag). `TimeCluster` declares no retention: the
 *   follow-up sends 1, as CloudFormation's `ModelAdapter.setDefaults` fills it,
 *   where the source holds 3.
 * - CDKD_TEST_RESTORE=true also adds `IdCluster`, restored at the latest time
 *   from `Source` named by its resource id (`SourceDbClusterResourceId`), and,
 *   with CDKD_TEST_SNAPSHOT_ID set (verify.sh takes a manual snapshot of
 *   `Source`), `SnapCluster`, restored from that snapshot (`SnapshotIdentifier`).
 *   Each declares the same kinds of members as `PitrCluster`.
 * - CDKD_TEST_UPDATE=true: `PitrCluster`'s `BackupRetentionPeriod` 5 -> 6, in
 *   place.
 *
 * Fixed names so verify.sh can read them back.
 */
export class RdsPitrRestoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const isRestore = process.env.CDKD_TEST_RESTORE === 'true';
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    const restoreTime = process.env.CDKD_TEST_RESTORE_TIME;
    const snapshotId = process.env.CDKD_TEST_SNAPSHOT_ID;

    // 2 AZs, public subnets, no NAT: nothing connects to the clusters.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC }],
    });

    const subnetGroup = new rds.CfnDBSubnetGroup(this, 'SubnetGroup', {
      dbSubnetGroupName: 'cdkd-integ-rds-pitr-5639',
      dbSubnetGroupDescription: 'cdkd integ rds pitr restore subnet group',
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds,
    });
    subnetGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const source = new rds.CfnDBCluster(this, 'Source', {
      dbClusterIdentifier: 'cdkd-integ-rds-pitr-src-5639',
      engine: 'aurora-postgresql',
      engineVersion: '17.9',
      masterUsername: 'cdkdadmin',
      masterUserPassword: 'TempPass1234',
      dbSubnetGroupName: subnetGroup.ref,
      backupRetentionPeriod: 3,
      serverlessV2ScalingConfiguration: { minCapacity: 0.5, maxCapacity: 1 },
      deletionProtection: false,
    });
    source.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    if (!isRestore) return;

    const params = new rds.CfnDBClusterParameterGroup(this, 'ClusterParams', {
      dbClusterParameterGroupName: 'cdkd-integ-rds-pitr-5639',
      family: 'aurora-postgresql17',
      description: 'cdkd integ rds pitr restore cluster parameter group',
      parameters: { log_min_duration_statement: '1000' },
    });
    params.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const pitr = new rds.CfnDBCluster(this, 'PitrCluster', {
      dbClusterIdentifier: 'cdkd-integ-rds-pitr-latest-5639',
      engine: 'aurora-postgresql',
      sourceDbClusterIdentifier: source.ref,
      useLatestRestorableTime: true,
      restoreType: 'full-copy',
      // A restore keeps the source's user name; cdkd warns, as CloudFormation ignores it.
      masterUsername: 'otheradmin',
      dbSubnetGroupName: subnetGroup.ref,
      // On the restore call.
      port: 5434,
      copyTagsToSnapshot: true,
      serverlessV2ScalingConfiguration: { minCapacity: 0.5, maxCapacity: 1 },
      // On the follow-up ModifyDBCluster.
      dbClusterParameterGroupName: params.ref,
      backupRetentionPeriod: isUpdate ? 6 : 5,
      preferredBackupWindow: '05:00-05:30',
      // Declared so RDS's randomly assigned maintenance window can never
      // overlap the backup window, which fails the follow-up ModifyDBCluster.
      preferredMaintenanceWindow: 'sun:10:00-sun:10:30',
      enableHttpEndpoint: true,
      deletionProtection: false,
    });
    pitr.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // go-to-k/cdkd#5639: the source named by its resource id.
    const byId = new rds.CfnDBCluster(this, 'IdCluster', {
      dbClusterIdentifier: 'cdkd-integ-rds-pitr-id-5639',
      engine: 'aurora-postgresql',
      sourceDbClusterResourceId: source.attrDbClusterResourceId,
      useLatestRestorableTime: true,
      masterUsername: 'otheradmin',
      dbSubnetGroupName: subnetGroup.ref,
      port: 5436,
      serverlessV2ScalingConfiguration: { minCapacity: 0.5, maxCapacity: 1 },
      dbClusterParameterGroupName: params.ref,
      backupRetentionPeriod: 2,
      deletionProtection: false,
    });
    byId.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // go-to-k/cdkd#5639: a manual snapshot of the source, taken by verify.sh.
    if (snapshotId !== undefined && snapshotId !== '') {
      const snap = new rds.CfnDBCluster(this, 'SnapCluster', {
        dbClusterIdentifier: 'cdkd-integ-rds-pitr-snap-5639',
        engine: 'aurora-postgresql',
        engineVersion: '17.9',
        snapshotIdentifier: snapshotId,
        masterUsername: 'otheradmin',
        dbSubnetGroupName: subnetGroup.ref,
        // On the restore call.
        port: 5435,
        copyTagsToSnapshot: true,
        dbClusterParameterGroupName: params.ref,
        serverlessV2ScalingConfiguration: { minCapacity: 0.5, maxCapacity: 1 },
        // On the follow-up ModifyDBCluster only.
        backupRetentionPeriod: 4,
        preferredBackupWindow: '06:00-06:30',
        // See PitrCluster: keeps the assigned maintenance window off the backup window.
        preferredMaintenanceWindow: 'sun:10:00-sun:10:30',
        deletionProtection: false,
      });
      snap.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    }

    if (restoreTime === undefined || restoreTime === '') return;
    const timed = new rds.CfnDBCluster(this, 'TimeCluster', {
      dbClusterIdentifier: 'cdkd-integ-rds-pitr-time-5639',
      engine: 'aurora-postgresql',
      sourceDbClusterIdentifier: source.ref,
      restoreToTime: restoreTime,
      masterUsername: 'otheradmin',
      dbSubnetGroupName: subnetGroup.ref,
      serverlessV2ScalingConfiguration: { minCapacity: 0.5, maxCapacity: 1 },
      dbClusterParameterGroupName: params.ref,
      deletionProtection: false,
    });
    timed.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
