import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';

/** The cluster's fixed identifier, which verify.sh's cleanup addresses. */
export const CLUSTER_ID = 'cdkd-integ-multiaz-5639';

/**
 * go-to-k/cdkd#5639: a Multi-AZ DB cluster (non-Aurora `postgres`), whose
 * `DBClusterInstanceClass`, `AllocatedStorage` and `Iops` were SDK-unwired
 * before #5639, so the cluster always went through Cloud Control.
 *
 * covers: AWS::RDS::DBCluster
 *
 * Phases (verify.sh):
 * - baseline: `db.c6gd.medium`, `io1` 100 GiB at 1000 IOPS.
 * - `CDKD_TEST_UPDATE=true`: `db.c6gd.large`, 120 GiB at 1200 IOPS, in place.
 * - `CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true`: the three properties are
 *   DROPPED, beside a changed `BackupRetentionPeriod` so the update still
 *   calls ModifyDBCluster; CloudFormation's handler sends nothing for a
 *   removed one, so the live values stay.
 *
 * L1 `CfnDBCluster`, so the template carries exactly these properties. The
 * master password is managed by RDS, which deletes its secret with the
 * cluster. `DeletionPolicy: Delete`, so the destroy takes no final snapshot.
 * Shape: 3 isolated subnets (a Multi-AZ DB cluster spans three zones), no NAT.
 */
export class RdsMultiAzClusterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // verify.sh's cleanup sweeps the VPC by this tag when a run is
    // interrupted before the state record names it.
    cdk.Tags.of(this).add('cdkd-integ-fixture', 'rds-multiaz-cluster');

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    const isRemoval = isUpdate && process.env.CDKD_TEST_REMOVAL === 'true';

    // Zones `db.c6gd.*` Multi-AZ DB clusters are orderable in (us-east-1e is
    // not one).
    const region = process.env.CDK_DEFAULT_REGION ?? 'us-east-1';
    const vpc = new ec2.Vpc(this, 'MultiAzVpc', {
      availabilityZones: [`${region}a`, `${region}b`, `${region}c`],
      natGateways: 0,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    const securityGroup = new ec2.SecurityGroup(this, 'ClusterSecurityGroup', {
      vpc,
      description: 'Security group for the Multi-AZ DB cluster integ',
      allowAllOutbound: true,
    });

    const subnetGroup = new rds.SubnetGroup(this, 'MultiAzSubnetGroup', {
      vpc,
      subnetGroupName: CLUSTER_ID,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      description: 'Subnet group for the Multi-AZ DB cluster integ',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const cluster = new rds.CfnDBCluster(this, 'MultiAzCluster', {
      dbClusterIdentifier: CLUSTER_ID,
      engine: 'postgres',
      masterUsername: 'postgres',
      manageMasterUserPassword: true,
      dbSubnetGroupName: subnetGroup.subnetGroupName,
      vpcSecurityGroupIds: [securityGroup.securityGroupId],
      storageType: 'io1',
      backupRetentionPeriod: isRemoval ? 2 : 1,
      ...(!isRemoval && {
        dbClusterInstanceClass: isUpdate ? 'db.c6gd.large' : 'db.c6gd.medium',
        allocatedStorage: isUpdate ? 120 : 100,
        iops: isUpdate ? 1200 : 1000,
      }),
    });
    cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
