import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

/**
 * Integ probe for the "add a Global Secondary Index" in-place UPDATE path.
 *
 * Phase 1 (no env): a PAY_PER_REQUEST table with only the partition key `pk`.
 * Phase 2 (CDKD_TEST_UPDATE=true): the same table gains a GSI `gsi1` on a new
 * attribute `gsipk`. Adding the GSI grows AttributeDefinitions — which cdkd
 * used to misclassify as an immutable-property change and try to REPLACE the
 * table (CreateTable on the same name -> "Table already exists" -> deploy
 * fails). The fix routes it through UpdateTable's GlobalSecondaryIndexUpdates,
 * so the table is updated in place and keeps its identity.
 *
 * A fixed physical TableName is set so verify.sh can assert the table is the
 * SAME table across the update (CreationDateTime unchanged), proving no
 * replacement happened.
 */
export class DynamodbGsiUpdateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'GsiTable', {
      tableName: 'cdkd-gsi-update-test-table',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    if (process.env.CDKD_TEST_UPDATE === 'true') {
      table.addGlobalSecondaryIndex({
        indexName: 'gsi1',
        partitionKey: { name: 'gsipk', type: dynamodb.AttributeType.STRING },
      });
    }
  }
}
