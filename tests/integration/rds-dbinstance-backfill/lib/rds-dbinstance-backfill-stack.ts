import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';

/**
 * Standalone (non-Aurora) RDS DBInstance integ fixture for the issue
 * #609 silent-drop backfill of DBInstance siblings of DBCluster.
 *
 * Original (#738) properties:
 *   AllocatedStorage / DeletionProtection / EngineVersion /
 *   MasterUsername / Port / StorageEncrypted / VPCSecurityGroups
 *
 * Folded-in security properties (this fixture absorbs the former
 * standalone `rds-security-backfill` fixture per the "do not proliferate
 * per-property integ fixtures" directive):
 *   KmsKeyId / MasterUserSecret / ManageMasterUserPassword /
 *   MonitoringRoleArn / MonitoringInterval / EnableIAMDatabaseAuthentication
 *
 * Note the credentials shape changed when folding in the security props:
 * the original fixture used a literal MasterUserPassword, but
 * ManageMasterUserPassword (Secrets-Manager-managed master password) is
 * mutually exclusive with an explicit MasterUserPassword. This fixture now
 * sets ManageMasterUserPassword + MasterUserSecret { KmsKeyId } and sets NO
 * MasterUserPassword — so the "MasterUserPassword reached AWS" signal from
 * #738 is replaced by the populated MasterUserSecret read-back.
 *
 * A standalone Postgres instance (NOT a cluster member) is required —
 * Aurora ClusterInstance inherits these props from the cluster and
 * does not exercise the DBInstance write path.
 *
 * Implementation note: the fixture uses CfnDBInstance L1 directly (NOT
 * `rds.DatabaseInstance` L2). The L2 emits CDK defaults like
 * `BackupRetentionPeriod` / `CopyTagsToSnapshot` / `StorageType` that
 * are still in the #609 silent-drop list for DBInstance, and per cdkd's
 * routing rule (any unhandled top-level prop → auto-route via Cloud
 * Control), even a single one of those defaults flips the entire
 * resource off the SDK provider — defeating the integ's whole purpose
 * (verifying that the SDK code path's silent-drop is closed). The L1
 * lets us assert exactly which CFn properties reach the template.
 *
 * go-to-k/cdkd#2762 storage / backup / maintenance / certificate /
 * Performance Insights props, each set to a non-default value so a silent drop
 * reads back differently:
 *   StorageType gp3 + Iops + StorageThroughput (above the gp3 baseline, which
 *   needs >= 400 GiB on Postgres) / MaxAllocatedStorage / BackupRetentionPeriod /
 *   PreferredBackupWindow / PreferredMaintenanceWindow / AutoMinorVersionUpgrade /
 *   CopyTagsToSnapshot / CACertificateIdentifier / EnablePerformanceInsights +
 *   PerformanceInsightsRetentionPeriod.
 * Not set here, unit-tested only: MultiAZ (a standby doubles the create and
 * delete time and rides the same update path as AutoMinorVersionUpgrade),
 * OptionGroupName (a custom group is held by the #4030 final snapshot, so the
 * destroy could not delete it) and PerformanceInsightsKMSKeyId (only the
 * account's default key would keep the fixture self-contained, and that is
 * what AWS picks anyway).
 *
 * Shape: db.t3.micro / 400 GiB gp3 / 2 isolated subnets / no NAT.
 */
export class RdsDbInstanceBackfillStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // #5004 removal UPDATE phase: CDKD_TEST_UPDATE=true DROPS
    // DeletionProtection + EnableIAMDatabaseAuthentication + MonitoringInterval
    // from the DBInstance below so cdkd's ModifyDBInstance sees ABSENT fields
    // (removal), not a value change; CloudFormation keeps all three. It also
    // drops VPCSecurityGroups, which CloudFormation resets to the VPC's
    // `default` security group (#5542).
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const vpc = new ec2.Vpc(this, 'BackfillVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {
      vpc,
      description: 'Security group for the standalone RDS DBInstance backfill integ',
      allowAllOutbound: true,
    });

    // RDS needs a DBSubnetGroup spanning >= 2 AZs. Use CDK's L2 helper for
    // this (the subnet-group code path is unaffected by the DBInstance
    // routing concern; it has its own dedicated SDK provider).
    const subnetGroup = new rds.SubnetGroup(this, 'BackfillSubnetGroup', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      description: 'Subnet group for the backfill integ DBInstance',
    });

    // Enhanced Monitoring role: RDS assumes monitoring.rds.amazonaws.com and
    // needs the AWS-managed AmazonRDSEnhancedMonitoringRole policy. Required
    // by the MonitoringRoleArn / MonitoringInterval security props below.
    const monitoringRole = new iam.Role(this, 'MonitoringRole', {
      assumedBy: new iam.ServicePrincipal('monitoring.rds.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonRDSEnhancedMonitoringRole'),
      ],
    });

    // CfnDBInstance L1 — emits EXACTLY the properties listed below, with
    // no L2-injected defaults that would trip the silent-drop routing.
    // Each prop the #609 backfill closes is set explicitly so verify.sh
    // can prove it reached AWS:
    //   * AllocatedStorage: '400' (CFn string-typed) — AWS-required for
    //     standalone Postgres.
    //   * DeletionProtection: true in phase 1 — the strong #1160 signal:
    //     phase 2 (CDKD_TEST_UPDATE=true) DROPS the property; CloudFormation
    //     keeps `true` (#5004), so verify.sh asserts it is still true and
    //     the destroy passes --remove-protection.
    //   * EngineVersion: '17.6' — pinned so verify.sh can assert the
    //     literal string. A silent-drop would have AWS pick the default
    //     for the engine family.
    //   * MasterUsername: 'postgres' — AWS-required; silent-drop would
    //     fail the create outright.
    //   * Port: 5433 — non-default (Postgres default is 5432); a silent
    //     drop would leave AWS at 5432.
    //   * StorageEncrypted: true — non-default (RDS defaults to false
    //     for db.t3.micro Postgres); silent-drop → AWS-side false.
    //   * VPCSecurityGroups: explicit SG — silent-drop would have AWS
    //     assign the default VPC SG instead, which has a different id.
    //     DROPPED in phase 2: verify.sh asserts the instance then sits on
    //     the VPC's default SG only, as CloudFormation does (#5542).
    // Folded-in #609 security props:
    //   * ManageMasterUserPassword: true — Secrets-Manager-managed master
    //     password. Mutually exclusive with MasterUserPassword, so NO
    //     literal password is set; AWS provisions + rotates the secret.
    //   * MasterUserSecret { KmsKeyId } → SDK MasterUserSecretKmsKeyId.
    //     The account-default AWS-managed Secrets Manager key (no CMK).
    //   * KmsKeyId: 'alias/aws/rds' — storage-encryption key paired with
    //     StorageEncrypted=true; AWS resolves it to a key ARN on read-back.
    //   * MonitoringInterval: 60 — Enhanced Monitoring seconds (AWS default
    //     0); silent-drop would leave AWS at 0.
    //   * MonitoringRoleArn: the shared monitoring role; silent-drop would
    //     fail Enhanced Monitoring activation.
    //   * EnableIAMDatabaseAuthentication: true — AWS surfaces as
    //     IAMDatabaseAuthenticationEnabled; silent-drop → false. Also a
    //     #1160 removable field: DROPPED in phase 2 alongside
    //     DeletionProtection; verify.sh asserts it is KEPT (#5004).
    new rds.CfnDBInstance(this, 'BackfillInstance', {
      dbInstanceClass: 'db.t3.micro',
      engine: 'postgres',
      masterUsername: 'postgres',
      // ManageMasterUserPassword is mutually exclusive with
      // MasterUserPassword — set neither password literal.
      manageMasterUserPassword: true,
      masterUserSecret: { kmsKeyId: 'alias/aws/secretsmanager' },
      // Companion change (#5004): the port moves 5433 -> 5434 in phase 2 (an
      // immediately-applied ModifyDBInstance, ApplyImmediately=true), so
      // verify.sh can prove ModifyDBInstance fired in the removal deploy
      // before it asserts the three dropped fields were KEPT.
      port: isUpdate ? '5434' : '5433',
      engineVersion: '17.6',
      ...(isUpdate ? {} : { deletionProtection: true }),
      storageEncrypted: true,
      kmsKeyId: 'alias/aws/rds',
      ...(isUpdate ? {} : { monitoringInterval: 60 }),
      monitoringRoleArn: monitoringRole.roleArn,
      ...(isUpdate ? {} : { enableIamDatabaseAuthentication: true }),
      ...(isUpdate ? {} : { vpcSecurityGroups: [securityGroup.securityGroupId] }),
      dbSubnetGroupName: subnetGroup.subnetGroupName,
      publiclyAccessible: false,
      // go-to-k/cdkd#2762. Phase 2 CHANGES BackupRetentionPeriod,
      // PreferredMaintenanceWindow and PerformanceInsightsRetentionPeriod (sent
      // by ModifyDBInstance), DROPS AutoMinorVersionUpgrade (CloudFormation keeps
      // it: its handler sends diff(previous, desired), nothing for a removal) and
      // DROPS MaxAllocatedStorage (CloudFormation turns storage autoscaling off,
      // setting the maximum to the allocated storage). The storage itself stays
      // unchanged: a storage change starts an hours-long storage optimization.
      storageType: 'gp3',
      allocatedStorage: '400',
      iops: 13000,
      storageThroughput: 600,
      ...(isUpdate ? {} : { maxAllocatedStorage: 500 }),
      backupRetentionPeriod: isUpdate ? 5 : 3,
      preferredBackupWindow: '03:00-03:30',
      preferredMaintenanceWindow: isUpdate ? 'mon:05:00-mon:05:30' : 'sun:05:00-sun:05:30',
      ...(isUpdate ? {} : { autoMinorVersionUpgrade: false }),
      copyTagsToSnapshot: true,
      caCertificateIdentifier: 'rds-ca-rsa4096-g1',
      enablePerformanceInsights: true,
      // 31 is not the default (7), so a dropped create value reads back 7.
      performanceInsightsRetentionPeriod: isUpdate ? 7 : 31,
    });
  }
}
