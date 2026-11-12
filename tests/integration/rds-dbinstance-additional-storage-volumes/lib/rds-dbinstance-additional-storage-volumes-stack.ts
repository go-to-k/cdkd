import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';

/** The instance's fixed name, which verify.sh reads and sweeps by. */
export const INSTANCE_ID = 'cdkd-rds-volumes-integ';

type Volume = rds.CfnDBInstance.AdditionalStorageVolumeProperty;

const gp3 = (volumeName: string, allocatedStorage: string): Volume => ({
  volumeName,
  storageType: 'gp3',
  allocatedStorage,
});

/**
 * Per `CDKD_TEST_VOLUMES` phase, the declared volumes (the CloudFormation A/B
 * on go-to-k/cdkd#5640 used these same steps):
 *   - unset / `initial`: rdsdbdata2 and rdsdbdata3, 20 GiB each;
 *   - `grown`: rdsdbdata2 grown to 25 GiB, rdsdbdata3 unchanged, rdsdbdata4 added;
 *   - `removed`: rdsdbdata3 dropped from the list;
 *   - `none`: the property removed.
 */
const VOLUMES: Record<string, Volume[] | undefined> = {
  initial: [gp3('rdsdbdata2', '20'), gp3('rdsdbdata3', '20')],
  grown: [gp3('rdsdbdata2', '25'), gp3('rdsdbdata3', '20'), gp3('rdsdbdata4', '20')],
  removed: [gp3('rdsdbdata2', '25'), gp3('rdsdbdata4', '20')],
  none: undefined,
};

/**
 * go-to-k/cdkd#5640: `AdditionalStorageVolumes` on the SDK route for a
 * standalone DB instance.
 *
 * covers: AWS::RDS::DBInstance
 *
 * SQL Server Standard Edition (license-included, db.m6i.large, gp3 20 GiB):
 * measured in us-east-1 on 2026-11-11, SQL Server Express offers additional
 * storage volumes on no class, and Oracle SE2 only on 4xlarge+ BYOL classes,
 * so this is the smallest engine and class that takes them.
 *
 * L1 (`CfnDBInstance`), so the template carries exactly these properties: an
 * L2 default still unwired would route the instance to Cloud Control.
 */
export class RdsDbInstanceAdditionalStorageVolumesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env.CDKD_TEST_VOLUMES ?? 'initial';
    if (!(phase in VOLUMES)) {
      throw new Error(`CDKD_TEST_VOLUMES must be one of ${Object.keys(VOLUMES).join(', ')}`);
    }
    const volumes = VOLUMES[phase];

    const vpc = new ec2.Vpc(this, 'VolumesVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });
    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {
      vpc,
      description: 'Security group for the RDS DBInstance additional storage volumes integ',
      allowAllOutbound: true,
    });
    const subnetGroup = new rds.SubnetGroup(this, 'VolumesSubnetGroup', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      description: 'Subnet group for the additional storage volumes integ DBInstance',
    });
    subnetGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const instance = new rds.CfnDBInstance(this, 'SqlServerInstance', {
      dbInstanceIdentifier: INSTANCE_ID,
      dbInstanceClass: 'db.m6i.large',
      engine: 'sqlserver-se',
      licenseModel: 'license-included',
      storageType: 'gp3',
      allocatedStorage: '20',
      masterUsername: 'cdkdadmin',
      // No password literal: RDS manages the secret and deletes it with the
      // instance.
      manageMasterUserPassword: true,
      dbSubnetGroupName: subnetGroup.subnetGroupName,
      vpcSecurityGroups: [securityGroup.securityGroupId],
      publiclyAccessible: false,
      // No automated backups: none to take at create, none to delete after.
      backupRetentionPeriod: 0,
      ...(volumes !== undefined && { additionalStorageVolumes: volumes }),
    });
    // The L1's absent DeletionPolicy is Snapshot, which would leave a final
    // snapshot behind every run.
    instance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
