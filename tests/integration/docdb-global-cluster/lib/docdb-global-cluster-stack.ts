import * as cdk from 'aws-cdk-lib';
import * as docdb from 'aws-cdk-lib/aws-docdb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#5628: `AWS::DocDB::DBCluster` declaring `GlobalClusterIdentifier`,
 * on cdkd's SDK route. Two global clusters (`AWS::DocDB::GlobalCluster`, no SDK
 * provider, so Cloud Control), each created empty and joined by one cluster
 * through CreateDBCluster's `GlobalClusterIdentifier`, as its primary (a
 * same-region secondary is not possible):
 *
 * - `Cluster` in `Global` stays a member to the end, so the destroy detaches it.
 * - `ClusterB` in `Global2` is the removal subject.
 *
 * Modes (verify.sh sets them monotonically):
 * - CDKD_TEST_UPDATE=true: `BackupRetentionPeriod` 1 -> 2 on both, membership
 *   unchanged.
 * - CDKD_TEST_CHANGE=true: `Cluster` asks for `Global2` (refused).
 * - CDKD_TEST_REMOVAL=true: `ClusterB` drops `GlobalClusterIdentifier` (detached
 *   in place).
 * - CDKD_TEST_READD=true: `ClusterB` asks for `Global2` again (refused).
 *
 * No instances: the membership is the subject, and an instance-less cluster
 * keeps the run cheap. Fixed names so verify.sh can read them back.
 */
export class DocdbGlobalClusterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    const isChange = process.env.CDKD_TEST_CHANGE === 'true';
    const isRemoval = process.env.CDKD_TEST_REMOVAL === 'true';
    const isReadd = process.env.CDKD_TEST_READD === 'true';

    // 2 AZs, public subnets, no NAT: nothing connects to the clusters.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC }],
    });

    // Fixed name, so verify.sh's sweep can find it after a partial destroy.
    const subnetGroup = new docdb.CfnDBSubnetGroup(this, 'SubnetGroup', {
      dbSubnetGroupName: 'cdkd-integ-docdb-global-5628',
      dbSubnetGroupDescription: 'cdkd integ docdb global cluster subnet group',
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds,
    });
    subnetGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const globalCluster = (logicalId: string, name: string): docdb.CfnGlobalCluster => {
      const global = new docdb.CfnGlobalCluster(this, logicalId, {
        globalClusterIdentifier: name,
        engine: 'docdb',
        engineVersion: '5.0.0',
        deletionProtection: false,
      });
      global.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
      return global;
    };
    const global1 = globalCluster('Global', 'cdkd-integ-docdb-global-5628');
    const global2 = globalCluster('Global2', 'cdkd-integ-docdb-global2-5628');

    // MasterUsername: DocDB reserves `admin`; MasterUserPassword: 8-100 chars,
    // no `/`, `"`, `@` (the docdb-neptune fixture's literal).
    const cluster = (
      logicalId: string,
      name: string,
      globalClusterIdentifier: string | undefined
    ): docdb.CfnDBCluster => {
      const c = new docdb.CfnDBCluster(this, logicalId, {
        dbClusterIdentifier: name,
        engineVersion: '5.0.0',
        masterUsername: 'cdkdadmin',
        masterUserPassword: 'TempPass1234!',
        dbSubnetGroupName: subnetGroup.ref,
        globalClusterIdentifier,
        backupRetentionPeriod: isUpdate ? 2 : 1,
        deletionProtection: false,
      });
      c.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
      return c;
    };
    const clusterA = cluster(
      'Cluster',
      'cdkd-integ-docdb-global-member-5628',
      isChange ? global2.ref : global1.ref
    );
    const clusterB = cluster(
      'ClusterB',
      'cdkd-integ-docdb-global-member-b-5628',
      isRemoval && !isReadd ? undefined : global2.ref
    );
    // A mode that drops or swaps the Ref drops the implicit dependency the
    // destroy order needs: keep each cluster deleted before both global clusters.
    for (const c of [clusterA, clusterB]) {
      c.addDependency(global1);
      c.addDependency(global2);
    }
  }
}
