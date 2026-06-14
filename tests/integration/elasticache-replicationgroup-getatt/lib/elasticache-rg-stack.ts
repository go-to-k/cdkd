import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Failure-seeking fixture for the CC-API attribute-enrichment gap on
 * `AWS::ElastiCache::ReplicationGroup`.
 *
 * ElastiCache ReplicationGroup has NO SDK provider, so it always routes through
 * Cloud Control. Pre-fix, `Fn::GetAtt(<RG>, 'PrimaryEndPoint.Address')` fell
 * through the intrinsic resolver's `constructAttribute` to the physicalId (the
 * replication-group id) instead of the real Redis hostname — so an SSM
 * Parameter (or a client connection string) built from it pointed at garbage.
 *
 * This stack deploys a cluster-mode-disabled Redis ReplicationGroup and stores
 * its `PrimaryEndPoint.Address` (capital-P EndPoint — the CFn attribute casing)
 * and `PrimaryEndPoint.Port` into SSM Parameters via Fn::GetAtt. verify.sh then
 * asserts the stored value is the real `*.cache.amazonaws.com` hostname, NOT
 * the replication-group id.
 *
 * Cheap: a single cache.t3.micro node, VPC with `natGateways: 0`.
 */
export class ElastiCacheRgStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const sg = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc,
      description: 'cdkd elasticache-replicationgroup-getatt fixture SG',
      allowAllOutbound: true,
    });

    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'SubnetGroup', {
      description: 'cdkd elasticache-rg fixture subnet group',
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
    });

    // L1 CfnReplicationGroup (cluster-mode disabled): a single primary node, no
    // replicas, to keep deploy fast + cheap. ReplicationGroup has no core L2.
    const rg = new elasticache.CfnReplicationGroup(this, 'Redis', {
      replicationGroupDescription: 'cdkd elasticache-rg getatt fixture',
      engine: 'redis',
      cacheNodeType: 'cache.t3.micro',
      numCacheClusters: 1,
      automaticFailoverEnabled: false,
      cacheSubnetGroupName: subnetGroup.ref,
      securityGroupIds: [sg.securityGroupId],
    });
    rg.addDependency(subnetGroup);

    // The LOAD-BEARING assertions: these SSM Parameters' Value is a
    // Fn::GetAtt against the RG's computed endpoint attributes. Pre-fix these
    // resolved to the RG id (garbage); post-fix they hold the real hostname/port.
    new ssm.CfnParameter(this, 'PrimaryAddressParam', {
      name: '/cdkd-integ/elasticache-rg/primary-endpoint-address',
      type: 'String',
      value: rg.attrPrimaryEndPointAddress,
    });
    new ssm.CfnParameter(this, 'PrimaryPortParam', {
      name: '/cdkd-integ/elasticache-rg/primary-endpoint-port',
      type: 'String',
      value: rg.attrPrimaryEndPointPort,
    });

    new cdk.CfnOutput(this, 'ReplicationGroupId', { value: rg.ref });
  }
}
