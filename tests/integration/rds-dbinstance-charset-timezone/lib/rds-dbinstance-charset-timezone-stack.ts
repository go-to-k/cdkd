import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';

/** The instances' fixed names, which verify.sh reads and sweeps by. */
export const ORACLE_INSTANCE_ID = 'cdkd-rds-charset-integ';
export const SQLSERVER_INSTANCE_ID = 'cdkd-rds-timezone-integ';

/**
 * go-to-k/cdkd#5640: `CharacterSetName`, `NcharCharacterSetName` and
 * `Timezone` on the SDK route for a standalone DB instance. All three are
 * create-only.
 *
 * covers: AWS::RDS::DBInstance
 *
 * Two instances, created in parallel:
 *   - Oracle SE2 (license-included, db.t3.small) with `WE8ISO8859P1` and the
 *     NCHAR set `UTF8`; the engine's defaults are `AL32UTF8` / `AL16UTF16`
 *     (describe-db-engine-versions --list-supported-character-sets,
 *     us-east-1, 2026-11-11), so neither value is one RDS would pick itself.
 *   - SQL Server Express (license-included, db.t3.micro) with the time zone
 *     `Tokyo Standard Time` (listed by --list-supported-timezones; the
 *     default is UTC).
 *
 * `CDKD_TEST_TIMEZONE=changed` declares another time zone: a create-only
 * change of a stateful resource, which the deploy refuses without
 * `--force-stateful-recreation`.
 *
 * L1 (`CfnDBInstance`), so the template carries exactly these properties: an
 * L2 default still unwired would route the instance to Cloud Control.
 */
export class RdsDbInstanceCharsetTimezoneStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const timezone =
      process.env.CDKD_TEST_TIMEZONE === 'changed' ? 'UTC' : 'Tokyo Standard Time';

    const vpc = new ec2.Vpc(this, 'CharsetVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });
    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {
      vpc,
      description: 'Security group for the RDS DBInstance charset and time zone integ',
      allowAllOutbound: true,
    });
    const subnetGroup = new rds.SubnetGroup(this, 'CharsetSubnetGroup', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      description: 'Subnet group for the charset and time zone integ DBInstances',
    });
    subnetGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const common = {
      licenseModel: 'license-included',
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
    };

    const oracle = new rds.CfnDBInstance(this, 'OracleInstance', {
      ...common,
      dbInstanceIdentifier: ORACLE_INSTANCE_ID,
      dbInstanceClass: 'db.t3.small',
      engine: 'oracle-se2',
      characterSetName: 'WE8ISO8859P1',
      ncharCharacterSetName: 'UTF8',
    });
    const sqlServer = new rds.CfnDBInstance(this, 'SqlServerInstance', {
      ...common,
      dbInstanceIdentifier: SQLSERVER_INSTANCE_ID,
      dbInstanceClass: 'db.t3.micro',
      engine: 'sqlserver-ex',
      timezone,
    });
    // The L1's absent DeletionPolicy is Snapshot, which would leave a final
    // snapshot behind every run.
    oracle.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    sqlServer.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
