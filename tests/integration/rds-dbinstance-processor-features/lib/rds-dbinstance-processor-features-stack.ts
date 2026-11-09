import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';

/** The instance's fixed name, which verify.sh reads and sweeps by. */
export const INSTANCE_ID = 'cdkd-rds-procfeat-integ';

/**
 * go-to-k/cdkd#5640: `ProcessorFeatures` and `UseDefaultProcessorFeatures` on
 * the SDK route for a standalone DB instance.
 *
 * covers: AWS::RDS::DBInstance
 *
 * Among the cheaper engines in us-east-1 only SQL Server Web
 * (license-included) offers processor features (PostgreSQL, MySQL and SQL
 * Server Express list none; Oracle SE2 only under BYOL), and SQL Server
 * refuses fewer than 4 vCPUs ("Your request creates 1 vCPUs while SQL Server
 * requires a minimum of 4 vCPUs"). Every class up to 2xlarge defaults to 4
 * vCPUs or fewer, so no non-default setting is valid there. On db.m7i.4xlarge
 * `coreCount` allows 1-8, default 8, and `threadsPerCore` allows only 1, so
 * the custom value under test is `coreCount: 4` (4 vCPUs), which AWS never
 * picks by itself.
 *
 * Phases (`CDKD_TEST_PROCESSOR`):
 *   (unset)      `coreCount: 4` at create.
 *   removed      the list dropped, beside a `CopyTagsToSnapshot` change that
 *                proves the ModifyDBInstance went out: CloudFormation sends no
 *                processor member for a removal, so the instance keeps 4.
 *   use-default  `UseDefaultProcessorFeatures: true`: the class default (8).
 *   reapply      the list again with `UseDefaultProcessorFeatures: false`:
 *                ModifyDBInstance carries both, back to 4.
 *
 * L1 (`CfnDBInstance`), so the template carries exactly these properties: an
 * L2 default still unwired would route the instance to Cloud Control.
 */
export class RdsDbInstanceProcessorFeaturesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env.CDKD_TEST_PROCESSOR ?? '';

    const vpc = new ec2.Vpc(this, 'ProcessorVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });
    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {
      vpc,
      description: 'Security group for the RDS DBInstance processor features integ',
      allowAllOutbound: true,
    });
    const subnetGroup = new rds.SubnetGroup(this, 'ProcessorSubnetGroup', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      description: 'Subnet group for the processor features integ DBInstance',
    });
    subnetGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const customFeatures = [
      { name: 'coreCount', value: '4' },
      { name: 'threadsPerCore', value: '1' },
    ];

    const instance = new rds.CfnDBInstance(this, 'ProcessorInstance', {
      dbInstanceIdentifier: INSTANCE_ID,
      dbInstanceClass: 'db.m7i.4xlarge',
      engine: 'sqlserver-web',
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
      // The companion change of the `removed` phase.
      copyTagsToSnapshot: phase !== '',
      ...(phase === '' && { processorFeatures: customFeatures }),
      ...(phase === 'use-default' && { useDefaultProcessorFeatures: true }),
      ...(phase === 'reapply' && {
        processorFeatures: customFeatures,
        useDefaultProcessorFeatures: false,
      }),
    });
    // The L1's absent DeletionPolicy is Snapshot, which would leave a final
    // snapshot behind every run.
    instance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
