import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as rds from 'aws-cdk-lib/aws-rds';

/**
 * RDS DBCluster with `WithExpressConfiguration` (go-to-k/cdkd#5984).
 *
 * RDS itself creates the writer instance (`<clusterId>-instance-1`,
 * db.serverless); the template declares no DBInstance. No VPC: express
 * configuration picks the networking. It forces port 5432 and IAM auth, and
 * rejects ManageMasterUserPassword and a non-5432 Port, so none is declared.
 *
 * `CDKD_TEST_UPDATE=true` raises BackupRetentionPeriod 1 -> 7 (an in-place
 * ModifyDBCluster). `CDKD_TEST_RUN_ID` tags the cluster so verify.sh's cleanup
 * can find it when no state record names it.
 *
 * covers: AWS::RDS::DBCluster
 */
export class RdsExpressClusterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const runId = process.env.CDKD_TEST_RUN_ID;
    const cluster = new rds.CfnDBCluster(this, 'ExpressCluster', {
      engine: 'aurora-postgresql',
      backupRetentionPeriod: process.env.CDKD_TEST_UPDATE === 'true' ? 7 : 1,
      tags: runId ? [{ key: 'cdkd-integ-run', value: runId }] : undefined,
    });
    // aws-cdk-lib (2.275.0) has no L1 prop for it yet.
    cluster.addPropertyOverride('WithExpressConfiguration', true);
    cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'ClusterEndpoint', { value: cluster.attrEndpointAddress });
    new cdk.CfnOutput(this, 'ClusterResourceId', { value: cluster.attrDbClusterResourceId });
  }
}
