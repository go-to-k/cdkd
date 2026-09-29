import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as neptune from 'aws-cdk-lib/aws-neptune';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/**
 * Snapshot-capable resources whose Cloud Control delete handler may take a
 * final snapshot of its own (issue #4029; verify.sh records what each did),
 * each routed through Cloud Control and each declaring `DeletionPolicy: Delete`:
 *
 *   - An Aurora PostgreSQL `AWS::RDS::DBCluster` that is a member of an
 *     `AWS::RDS::GlobalCluster` (`GlobalClusterIdentifier` is a silent drop for
 *     cdkd's SDK provider, so the cluster is Cloud Control-routed). cdkd must
 *     detach it from the global cluster and delete it without a snapshot.
 *   - An `AWS::Neptune::DBCluster` (`CopyTagsToSnapshot` routes it through
 *     Cloud Control).
 *   - A Redis `AWS::ElastiCache::CacheCluster` (moved onto Cloud Control by
 *     verify.sh's `--recreate-via-cc-api` phase).
 *
 * No DB instances: a cluster needs none to exist, delete or be snapshotted,
 * and each would add ten minutes to every run.
 *
 * covers: AWS::RDS::GlobalCluster
 * covers: AWS::RDS::DBCluster
 * covers: AWS::Neptune::DBCluster
 * covers: AWS::ElastiCache::CacheCluster
 */
export class CcFinalSnapshotHandlersStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });
    const subnetIds = vpc.isolatedSubnets.map((s) => s.subnetId);
    const securityGroup = new ec2.SecurityGroup(this, 'Sg', {
      vpc,
      description: 'cdkd cc-final-snapshot-handlers',
      allowAllOutbound: true,
    });

    // --- Aurora global-cluster member ------------------------------------
    const global = new rds.CfnGlobalCluster(this, 'Global', {
      globalClusterIdentifier: 'cdkd-ccfs-global',
      engine: 'aurora-postgresql',
      engineVersion: '16.13',
      deletionProtection: false,
    });
    global.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const auroraSubnets = new rds.CfnDBSubnetGroup(this, 'AuroraSubnets', {
      dbSubnetGroupDescription: 'cdkd cc-final-snapshot-handlers Aurora',
      subnetIds,
    });
    auroraSubnets.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // A generated password read through a dynamic reference: no credential
    // literal in the repository.
    const masterSecret = new secretsmanager.Secret(this, 'AuroraMaster', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'postgres' }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const member = new rds.CfnDBCluster(this, 'AuroraMember', {
      dbClusterIdentifier: 'cdkd-ccfs-aurora',
      engine: 'aurora-postgresql',
      engineVersion: '16.13',
      globalClusterIdentifier: global.ref,
      masterUsername: 'postgres',
      masterUserPassword: masterSecret.secretValueFromJson('password').unsafeUnwrap(),
      dbSubnetGroupName: auroraSubnets.ref,
      vpcSecurityGroupIds: [securityGroup.securityGroupId],
      serverlessV2ScalingConfiguration: { minCapacity: 0.5, maxCapacity: 1 },
      deletionProtection: false,
    });
    member.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // --- Neptune ---------------------------------------------------------
    const neptuneSubnets = new neptune.CfnDBSubnetGroup(this, 'NeptuneSubnets', {
      dbSubnetGroupDescription: 'cdkd cc-final-snapshot-handlers Neptune',
      subnetIds,
    });
    neptuneSubnets.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const neptuneCluster = new neptune.CfnDBCluster(this, 'NeptuneCluster', {
      dbClusterIdentifier: 'cdkd-ccfs-neptune',
      copyTagsToSnapshot: true,
      dbSubnetGroupName: neptuneSubnets.ref,
      vpcSecurityGroupIds: [securityGroup.securityGroupId],
      deletionProtection: false,
    });
    neptuneCluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // --- ElastiCache -----------------------------------------------------
    const cacheSubnets = new elasticache.CfnSubnetGroup(this, 'CacheSubnets', {
      description: 'cdkd cc-final-snapshot-handlers ElastiCache',
      subnetIds,
    });
    cacheSubnets.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const cache = new elasticache.CfnCacheCluster(this, 'Cache', {
      clusterName: 'cdkd-ccfs-cache',
      engine: 'redis',
      cacheNodeType: 'cache.t3.micro',
      numCacheNodes: 1,
      cacheSubnetGroupName: cacheSubnets.ref,
      vpcSecurityGroupIds: [securityGroup.securityGroupId],
      // `--recreate-via-cc-api` acts only on a resource whose properties
      // change, so the phase that moves the cache onto Cloud Control adds a
      // tag (CDKD_TEST_UPDATE=true).
      ...(process.env.CDKD_TEST_UPDATE === 'true'
        ? { tags: [{ key: 'cdkd-phase', value: 'cloud-control' }] }
        : {}),
    });
    cache.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
