import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';

/**
 * Issue #6367: a global table with one cross-region replica. The template
 * declares NO deletion protection. The verify script turns it on OUT OF BAND,
 * first on the local table and then on the replica, so the destroy prompt and
 * the state record cannot know about it. The destroy must then refuse before
 * dropping the replica.
 *
 * The replica region is passed in by the verify script (`REPLICA_REGION`), so
 * it can differ from the deploy region.
 */
export class GlobalTableDeleteProtectionPreflightStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const replicaRegion = process.env.REPLICA_REGION ?? 'us-west-2';

    new dynamodb.TableV2(this, 'Table', {
      tableName: 'CdkdGlobalTableDeleteProtectionPreflight',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      replicas: [{ region: replicaRegion }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
