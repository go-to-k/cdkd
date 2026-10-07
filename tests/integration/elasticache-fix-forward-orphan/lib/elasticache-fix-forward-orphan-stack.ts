import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';

/**
 * go-to-k/cdkd#4606, the ElastiCache arm: a fix-forward deploy deletes the
 * cache cluster a failed CREATE left in AWS when the journal carries its
 * identity token (`<ARN>@<CacheClusterCreateTime ms>`), and keeps it, with a
 * warning, when it does not.
 *
 * - The baseline holds only an isolated three-AZ VPC and a cache subnet group.
 * - `ORPHAN_ARM` adds `OrphanCache` (the deletion arm): `inject` names it
 *   `<stack>-orphan`, `fixed` keeps the logical id under `<stack>-orphan-b`.
 * - `KEPT_ARM` adds `KeptCache` (the fail-safe arm) the same way, under
 *   `<stack>-kept` / `<stack>-kept-b`.
 *
 * verify.sh deploys each `inject` template as a role that may create a cache
 * cluster but not delete one, and denies it DescribeCacheClusters (after the
 * cluster showed its creation time for the deletion arm, from the start for
 * the fail-safe arm), so each CREATE fails after AWS made the cluster. A step
 * never drops an arm's token once set: a later deploy without it would delete
 * that arm's cluster.
 *
 * Every property set on the clusters is one the ElastiCache SDK provider
 * handles, so both stay on the SDK route (`provisionedBy: sdk`), where
 * `isSameResource` and `resourceIdentity` live. Memcached on cache.t4g.micro:
 * the cheapest node, and the fastest create and delete.
 */
export class ElastiCacheFixForwardOrphanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'elasticache-fix-forward-orphan');

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 3,
      natGateways: 0,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'SubnetGroup', {
      description: 'Subnet group for the elasticache-fix-forward-orphan fixture',
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
    });
    subnetGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const prefix = this.stackName.toLowerCase();
    const arm = (logicalId: string, name: string, mode: string | undefined): void => {
      if (mode !== 'inject' && mode !== 'fixed') return;
      const cluster = new elasticache.CfnCacheCluster(this, logicalId, {
        clusterName: `${prefix}-${name}${mode === 'fixed' ? '-b' : ''}`,
        engine: 'memcached',
        cacheNodeType: 'cache.t4g.micro',
        numCacheNodes: 1,
        cacheSubnetGroupName: subnetGroup.ref,
      });
      cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    };
    arm('OrphanCache', 'orphan', process.env.ORPHAN_ARM);
    arm('KeptCache', 'kept', process.env.KEPT_ARM);
  }
}
