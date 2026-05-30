import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';

/**
 * Standalone (non-Aurora) RDS DBInstance integ fixture for the issue
 * #609 silent-drop backfill of 8 DBInstance siblings of DBCluster:
 *
 *   AllocatedStorage / DeletionProtection / EngineVersion /
 *   MasterUsername / MasterUserPassword / Port / StorageEncrypted /
 *   VPCSecurityGroups
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
 * Minimum-cost shape: db.t3.micro / 20 GiB gp2 / 2 isolated subnets /
 * no NAT.
 */
export class RdsDbInstanceBackfillStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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

    // CfnDBInstance L1 — emits EXACTLY the properties listed below, with
    // no L2-injected defaults that would trip the silent-drop routing.
    // Each prop the #609 backfill closes is set explicitly so verify.sh
    // can prove it reached AWS:
    //   * AllocatedStorage: '20' (CFn string-typed) — AWS-required for
    //     standalone Postgres.
    //   * DeletionProtection: false — explicit user opt-out. Pre-#609
    //     this would have defaulted to false too, so it is the weakest
    //     signal of the 5 readable props — kept for completeness.
    //   * EngineVersion: '17.4' — pinned so verify.sh can assert the
    //     literal string. A silent-drop would have AWS pick the default
    //     for the engine family.
    //   * MasterUsername: 'postgres' — AWS-required; silent-drop would
    //     fail the create outright.
    //   * MasterUserPassword: literal — paired with MasterUsername.
    //     verify.sh can't read it back (RDS never returns passwords);
    //     the integ relies on the create-call succeeding as the implicit
    //     "MasterUserPassword reached AWS" signal.
    //   * Port: 5433 — non-default (Postgres default is 5432); a silent
    //     drop would leave AWS at 5432.
    //   * StorageEncrypted: true — non-default (RDS defaults to false
    //     for db.t3.micro Postgres); silent-drop → AWS-side false.
    //   * VPCSecurityGroups: explicit SG — silent-drop would have AWS
    //     assign the default VPC SG instead, which has a different id.
    new rds.CfnDBInstance(this, 'BackfillInstance', {
      dbInstanceClass: 'db.t3.micro',
      engine: 'postgres',
      allocatedStorage: '20',
      masterUsername: 'postgres',
      masterUserPassword: 'CdkdIntegSecret123!',
      port: '5433',
      engineVersion: '17.4',
      deletionProtection: false,
      storageEncrypted: true,
      vpcSecurityGroups: [securityGroup.securityGroupId],
      dbSubnetGroupName: subnetGroup.subnetGroupName,
      publiclyAccessible: false,
    });
  }
}
