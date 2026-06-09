import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';

/**
 * RDS security-cluster integ fixture for the issue #609 silent-drop
 * backfill of the managed-secret + Enhanced-Monitoring + IAM-auth
 * security properties on BOTH AWS::RDS::DBCluster and AWS::RDS::DBInstance.
 *
 * DBInstance (standalone Postgres) props exercised:
 *   KmsKeyId / MasterUserSecret / ManageMasterUserPassword /
 *   MonitoringRoleArn / MonitoringInterval / EnableIAMDatabaseAuthentication
 *
 * DBCluster (Aurora PostgreSQL Serverless v2) props exercised:
 *   MasterUserSecret / ManageMasterUserPassword / MonitoringRoleArn /
 *   MonitoringInterval / EnableIAMDatabaseAuthentication / PubliclyAccessible
 *
 * Implementation note: the fixture uses Cfn<Type> L1 directly (NOT the
 * `rds.DatabaseInstance` / `rds.DatabaseCluster` L2). The L2s emit CDK
 * defaults (BackupRetentionPeriod / CopyTagsToSnapshot / StorageType /
 * EnableCloudwatchLogsExports etc.) that are still in the #609 silent-drop
 * list for these types, and per cdkd's routing rule (any unhandled
 * top-level prop → auto-route the whole resource via Cloud Control), even
 * a single one of those defaults flips the resource off the SDK provider —
 * defeating the integ's purpose (verifying the SDK code path's silent-drop
 * is closed). The L1 lets us assert exactly which CFn properties reach AWS
 * AND keep `provisionedBy=sdk` on both resources as a routing guard.
 *
 * Cost-minimizing shape: db.t3.micro standalone Postgres + a single Aurora
 * Serverless v2 cluster (0.5-1 ACU, NO cluster instance — the cluster-level
 * create accepts and reflects every security prop without paying for a
 * provisioned instance). KMS keys are the account-default AWS-managed
 * aliases (`aws/rds` for storage, `aws/secretsmanager` for the managed
 * secret) so no customer-managed key is created. Enhanced Monitoring uses
 * one shared IAM role with the AWS-managed AmazonRDSEnhancedMonitoringRole
 * policy.
 */
export class RdsSecurityBackfillStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'SecurityVpc', {
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

    const securityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description: 'Security group for the RDS security-backfill integ',
      allowAllOutbound: true,
    });

    // RDS needs a DBSubnetGroup spanning >= 2 AZs. The subnet-group code
    // path has its own dedicated SDK provider and is unaffected by the
    // DBInstance / DBCluster routing concern, so the L2 helper is fine here.
    const subnetGroup = new rds.SubnetGroup(this, 'SecuritySubnetGroup', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      description: 'Subnet group for the security-backfill integ',
    });

    // Enhanced Monitoring role: RDS assumes monitoring.rds.amazonaws.com and
    // needs the AWS-managed AmazonRDSEnhancedMonitoringRole policy. Shared by
    // the standalone instance and the Aurora cluster.
    const monitoringRole = new iam.Role(this, 'MonitoringRole', {
      assumedBy: new iam.ServicePrincipal('monitoring.rds.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonRDSEnhancedMonitoringRole'),
      ],
    });

    // --- Standalone Postgres DBInstance (DBInstance security props) ------
    new rds.CfnDBInstance(this, 'SecurityInstance', {
      dbInstanceClass: 'db.t3.micro',
      engine: 'postgres',
      allocatedStorage: '20',
      masterUsername: 'postgres',
      // ManageMasterUserPassword (Secrets-Manager-managed master password) is
      // mutually exclusive with MasterUserPassword — set neither password.
      manageMasterUserPassword: true,
      // MasterUserSecret { KmsKeyId } → SDK MasterUserSecretKmsKeyId. The
      // account-default AWS-managed Secrets Manager key (no CMK created).
      masterUserSecret: { kmsKeyId: 'alias/aws/secretsmanager' },
      // Storage-encryption with the account-default AWS-managed RDS key.
      storageEncrypted: true,
      kmsKeyId: 'alias/aws/rds',
      // Enhanced Monitoring (60s interval) via the shared role.
      monitoringInterval: 60,
      monitoringRoleArn: monitoringRole.roleArn,
      enableIamDatabaseAuthentication: true,
      dbSubnetGroupName: subnetGroup.subnetGroupName,
      vpcSecurityGroups: [securityGroup.securityGroupId],
      publiclyAccessible: false,
    });

    // --- Aurora PostgreSQL Serverless v2 cluster (DBCluster props) -------
    // No cluster instance: cluster-level create validates and reflects every
    // security prop, and skipping the instance keeps the fixture cheap.
    new rds.CfnDBCluster(this, 'SecurityCluster', {
      engine: 'aurora-postgresql',
      masterUsername: 'postgres',
      manageMasterUserPassword: true,
      masterUserSecret: { kmsKeyId: 'alias/aws/secretsmanager' },
      monitoringInterval: 60,
      monitoringRoleArn: monitoringRole.roleArn,
      enableIamDatabaseAuthentication: true,
      // PubliclyAccessible is a valid CreateDBCluster field (create-only on the
      // cluster). With a non-default DBSubnetGroup the AWS default is false;
      // set it explicitly so a silent-drop would surface as a differing read.
      publiclyAccessible: false,
      dbSubnetGroupName: subnetGroup.subnetGroupName,
      vpcSecurityGroupIds: [securityGroup.securityGroupId],
      serverlessV2ScalingConfiguration: {
        minCapacity: 0.5,
        maxCapacity: 1,
      },
    });
  }
}
