import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';

/**
 * go-to-k/cdkd#4606, the RDS arm: a fix-forward deploy deletes the DB cluster
 * and DB instance a failed CREATE left in AWS.
 *
 * - The baseline holds only an isolated VPC and a DB subnet group.
 * - `WITH_ORPHANS=true` adds `OrphanCluster` (an Aurora PostgreSQL cluster
 *   with no instance) and `OrphanInstance` (a standalone PostgreSQL instance).
 *   verify.sh deploys that template as a role that may create them but not
 *   describe them (nor delete the cluster), so each CREATE fails after AWS
 *   made the resource: the journal records both as proven orphans.
 * - `ORPHAN_FIX_FORWARD=true` keeps both logical ids under other identifiers
 *   (`-b`), so the fix-forward deploy creates two new resources and must
 *   delete the earlier two, proven different by their live resource ids.
 *
 * - go-to-k/cdkd#4692: `WITH_ORPHANS=true` alone also adds `HeldCluster`
 *   (`<prefix>-held-cluster`), made and journaled the same way. The
 *   fix-forward template drops it and declares `AdoptedCluster` naming the
 *   SAME cluster in mixed case (`<StackName>-Held-Cluster`), which verify.sh
 *   adopts with `cdkd import` before the fix-forward deploy. The deploy must
 *   keep that cluster: a record holds it, in another case.
 *
 * Every property set on the two is one the RDS SDK provider handles, so both
 * stay on the SDK route (`provisionedBy: sdk`), where `isSameResource` lives.
 * The master password is a literal: no instance is reachable (isolated
 * subnets, no public access), and verify.sh sweeps the state prefix's object
 * versions, since the journal's `attemptedProperties` carry it.
 */
export class RdsFixForwardOrphanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'rds-fix-forward-orphan');

    const vpc = new ec2.Vpc(this, 'Vpc', {
      // Three AZs, and db.t3.micro below: db.t4g.micro gp2 CREATEs failed
      // "no Availability Zones with sufficient capacity" across two and three AZs.
      maxAzs: 3,
      natGateways: 0,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    const subnetGroup = new rds.SubnetGroup(this, 'SubnetGroup', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      description: 'Subnet group for the rds-fix-forward-orphan fixture',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    if (process.env.WITH_ORPHANS !== 'true') return;

    const suffix = process.env.ORPHAN_FIX_FORWARD === 'true' ? '-b' : '';
    const prefix = this.stackName.toLowerCase();

    const cluster = new rds.CfnDBCluster(this, 'OrphanCluster', {
      dbClusterIdentifier: `${prefix}-orphan-cluster${suffix}`,
      engine: 'aurora-postgresql',
      masterUsername: 'cdkdadmin',
      masterUserPassword: 'CdkdIntegNotASecret4606',
      dbSubnetGroupName: subnetGroup.subnetGroupName,
      deletionProtection: false,
    });
    cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const instance = new rds.CfnDBInstance(this, 'OrphanInstance', {
      dbInstanceIdentifier: `${prefix}-orphan-db${suffix}`,
      engine: 'postgres',
      dbInstanceClass: 'db.t3.micro',
      allocatedStorage: '20',
      masterUsername: 'cdkdadmin',
      masterUserPassword: 'CdkdIntegNotASecret4606',
      dbSubnetGroupName: subnetGroup.subnetGroupName,
      publiclyAccessible: false,
      deletionProtection: false,
    });
    instance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // go-to-k/cdkd#4692: one cluster, two spellings of its identifier. RDS
    // stores it lower-cased and matches it in any case.
    const fixForward = process.env.ORPHAN_FIX_FORWARD === 'true';
    const held = new rds.CfnDBCluster(this, fixForward ? 'AdoptedCluster' : 'HeldCluster', {
      dbClusterIdentifier: fixForward ? `${this.stackName}-Held-Cluster` : `${prefix}-held-cluster`,
      engine: 'aurora-postgresql',
      masterUsername: 'cdkdadmin',
      masterUserPassword: 'CdkdIntegNotASecret4606',
      dbSubnetGroupName: subnetGroup.subnetGroupName,
      deletionProtection: false,
    });
    held.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
