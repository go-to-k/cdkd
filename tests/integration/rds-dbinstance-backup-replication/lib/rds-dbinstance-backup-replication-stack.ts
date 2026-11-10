import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';

/** The instance's fixed name, which verify.sh reads and sweeps by. */
export const INSTANCE_ID = 'cdkd-rds-bkrepl-integ';

/**
 * go-to-k/cdkd#5640: `AutomaticBackupReplicationRegion` and
 * `AutomaticBackupReplicationRetentionPeriod` on the SDK route for a
 * standalone DB instance.
 *
 * covers: AWS::RDS::DBInstance
 *
 * The destination region is `CDKD_TEST_BR_DEST` (verify.sh picks one other
 * than the stack's). The instance is NOT storage-encrypted: an encrypted
 * source needs a KMS key in the destination region, which a single-region
 * stack cannot own, so `AutomaticBackupReplicationKmsKeyId` is unit-tested
 * only.
 *
 * Phases (`CDKD_TEST_BR`):
 *   (unset)    replication to the destination at create, retention 2.
 *   retention  retention 3: CloudFormation stops and starts it again.
 *   removed    both dropped: the replication is stopped.
 *
 * L1 (`CfnDBInstance`), so the template carries exactly these properties: an
 * L2 default still unwired would route the instance to Cloud Control.
 */
export class RdsDbInstanceBackupReplicationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env.CDKD_TEST_BR ?? '';
    const destination = process.env.CDKD_TEST_BR_DEST ?? 'us-west-2';

    const vpc = new ec2.Vpc(this, 'BackupReplicationVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });
    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {
      vpc,
      description: 'Security group for the RDS DBInstance backup replication integ',
      allowAllOutbound: true,
    });
    const subnetGroup = new rds.SubnetGroup(this, 'BackupReplicationSubnetGroup', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      description: 'Subnet group for the backup replication integ DBInstance',
    });
    subnetGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const instance = new rds.CfnDBInstance(this, 'BackupReplicationInstance', {
      dbInstanceIdentifier: INSTANCE_ID,
      dbInstanceClass: 'db.t4g.micro',
      engine: 'postgres',
      allocatedStorage: '20',
      masterUsername: 'cdkdadmin',
      // No password literal: RDS manages the secret and deletes it with the
      // instance.
      manageMasterUserPassword: true,
      dbSubnetGroupName: subnetGroup.subnetGroupName,
      vpcSecurityGroups: [securityGroup.securityGroupId],
      publiclyAccessible: false,
      storageEncrypted: false,
      // A replication needs automated backups on the source.
      backupRetentionPeriod: 1,
      ...(phase !== 'removed' && {
        automaticBackupReplicationRegion: destination,
        automaticBackupReplicationRetentionPeriod: phase === 'retention' ? 3 : 2,
      }),
    });
    // The L1's absent DeletionPolicy is Snapshot, which would leave a final
    // snapshot behind every run.
    instance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
