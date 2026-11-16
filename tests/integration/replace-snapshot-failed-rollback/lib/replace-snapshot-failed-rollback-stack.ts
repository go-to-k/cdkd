import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#6445 case 3: a create-first replacement under
 * `UpdateReplacePolicy: Snapshot` deletes the old resource in the deploy's
 * cleanup phase, and that deferred delete takes the final snapshot. A deploy
 * failing after the replacement never reaches the cleanup phase, so its
 * rollback re-adopts the old instance whole and no final snapshot is taken.
 *
 * - `Db` is a standalone RDS instance (the smallest class, 20 GiB gp2, no
 *   automated backups) whose `DBInstanceIdentifier` (create-only) is
 *   `cdkd-rsfr-db-${DB_SUFFIX ?? 'a'}`, so `DB_SUFFIX=b` replaces it, the new
 *   instance first. `UpdateReplacePolicy: Snapshot` (an atomic final snapshot:
 *   the delete call takes it) and `DeletionPolicy: Delete`, so a destroy takes
 *   none.
 * - `BREAK=true` adds `BadQueue`, an `AWS::SQS::Queue` with an out-of-range
 *   `MessageRetentionPeriod` that depends on `Db`, so it fails after the
 *   replacement.
 *
 * L1 resources on the SDK route; the RDS-managed master password lives in a
 * secret RDS deletes with the instance. Two isolated subnets, no NAT.
 *
 * covers: AWS::RDS::DBInstance, AWS::RDS::DBSubnetGroup, AWS::SQS::Queue
 */
export class ReplaceSnapshotFailedRollbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd-integ-fixture', 'replace-snapshot-failed-rollback');

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    const subnetGroup = new rds.CfnDBSubnetGroup(this, 'SubnetGroup', {
      dbSubnetGroupName: 'cdkd-rsfr-subnets',
      dbSubnetGroupDescription: 'cdkd integ replace-snapshot-failed-rollback subnet group',
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });
    subnetGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const db = new rds.CfnDBInstance(this, 'Db', {
      dbInstanceIdentifier: `cdkd-rsfr-db-${process.env.DB_SUFFIX ?? 'a'}`,
      engine: 'postgres',
      dbInstanceClass: 'db.t3.micro',
      allocatedStorage: '20',
      storageType: 'gp2',
      masterUsername: 'cdkdadmin',
      manageMasterUserPassword: true,
      dbSubnetGroupName: subnetGroup.ref,
      backupRetentionPeriod: 0,
      publiclyAccessible: false,
      deletionProtection: false,
    });
    db.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.DELETE;
    db.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.SNAPSHOT;

    if (process.env.BREAK === 'true') {
      // MessageRetentionPeriod must be 60..1209600; AWS rejects 1.
      const badQueue = new sqs.CfnQueue(this, 'BadQueue', { messageRetentionPeriod: 1 });
      badQueue.addDependency(db);
    }
  }
}
