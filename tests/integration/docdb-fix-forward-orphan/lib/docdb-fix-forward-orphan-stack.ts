import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as docdb from 'aws-cdk-lib/aws-docdb';

/**
 * go-to-k/cdkd#4606, the DocumentDB arm: a fix-forward deploy deletes the DB
 * cluster and DB instance a failed CREATE left in AWS.
 *
 * - The baseline holds an isolated VPC, a DocDB subnet group and `BaseCluster`,
 *   a cluster with no instance. A DocDB instance must join a cluster, and the
 *   orphan cluster's own CREATE fails, so the orphan instance joins this one.
 * - `WITH_ORPHANS=true` adds `OrphanCluster` (a cluster with no instance) and
 *   `OrphanInstance` (an instance in `BaseCluster`). verify.sh deploys that
 *   template as a role that may create them but not describe them (nor delete
 *   a cluster), so each CREATE fails after AWS made the resource: the journal
 *   records both as proven orphans.
 * - `ORPHAN_FIX_FORWARD=true` keeps both logical ids under other identifiers
 *   (`-b`), so the fix-forward deploy creates two new resources and must
 *   delete the earlier two, proven different by their live resource ids.
 *
 * Every property set on the clusters and the instance is one the DocDB SDK
 * provider handles (it has no Cloud Control route), so all stay on the SDK
 * route, where `isSameResource` lives. The master password is a literal: no
 * instance is reachable (isolated subnets), and verify.sh sweeps the state
 * prefix's object versions, since the journal's `attemptedProperties` carry it.
 */
export class DocdbFixForwardOrphanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'docdb-fix-forward-orphan');

    const vpc = new ec2.Vpc(this, 'Vpc', {
      // Three AZs: an instance class short of capacity in one AZ of a two-AZ
      // subnet group fails the CREATE "no Availability Zones with sufficient
      // capacity" (seen with RDS db.t4g.micro in rds-fix-forward-orphan).
      maxAzs: 3,
      natGateways: 0,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    const subnetGroup = new docdb.CfnDBSubnetGroup(this, 'SubnetGroup', {
      dbSubnetGroupDescription: 'Subnet group for the docdb-fix-forward-orphan fixture',
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
    });
    subnetGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const prefix = this.stackName.toLowerCase();

    const baseCluster = new docdb.CfnDBCluster(this, 'BaseCluster', {
      dbClusterIdentifier: `${prefix}-base-cluster`,
      masterUsername: 'cdkdadmin',
      masterUserPassword: 'CdkdIntegNotASecret4606',
      dbSubnetGroupName: subnetGroup.ref,
      // Explicit, so no default key brings KMS into the denied role's CREATE.
      storageEncrypted: false,
      deletionProtection: false,
    });
    baseCluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    if (process.env.WITH_ORPHANS !== 'true') return;

    const suffix = process.env.ORPHAN_FIX_FORWARD === 'true' ? '-b' : '';

    const cluster = new docdb.CfnDBCluster(this, 'OrphanCluster', {
      dbClusterIdentifier: `${prefix}-orphan-cluster${suffix}`,
      masterUsername: 'cdkdadmin',
      masterUserPassword: 'CdkdIntegNotASecret4606',
      dbSubnetGroupName: subnetGroup.ref,
      // Explicit, so no default key brings KMS into the denied role's CREATE.
      storageEncrypted: false,
      deletionProtection: false,
    });
    cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const instance = new docdb.CfnDBInstance(this, 'OrphanInstance', {
      dbInstanceIdentifier: `${prefix}-orphan-db${suffix}`,
      dbClusterIdentifier: baseCluster.ref,
      // The smallest DocDB class: orderable in us-east-1a-d and 1f for every
      // engine version (describe-orderable-db-instance-options), not in 1e.
      dbInstanceClass: 'db.t3.medium',
    });
    instance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
