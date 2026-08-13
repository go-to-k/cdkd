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
      // Issue #1768: a declared WarmThroughput BELOW what AWS already holds.
      // DynamoDB reports a 12000/4000 floor for every table (measured
      // us-east-1, 2026-08-13) and refuses any UpdateTable that lowers it, so
      // this value can never be applied. Declaring it here is what drives
      // cdkd's decrease guard on a real deploy: pre-fix the doomed UpdateTable
      // went out and the deploy FAILED with `decreasing WarmThroughput is not
      // supported`; post-fix it is skipped with a warning and the rest of the
      // update still applies. Deliberately a DECREASE rather than an increase —
      // raising warm throughput is a billed pre-warming request, and the skip
      // path is what needs covering.
      //
      // Set via addPropertyOverride rather than an L2 prop so the fixture does
      // not pin a minimum aws-cdk-lib version for a one-line probe.
      (table.node.defaultChild as dynamodb.CfnTable).addPropertyOverride('WarmThroughput', {
        ReadUnitsPerSecond: 6000,
        WriteUnitsPerSecond: 2000,
      });
      // Issue #1768, the EMIT half: a PER-INDEX WarmThroughput that cdkd must
      // actually SEND. `applyGsiUpdates` used to drop it from both of its arms,
      // so this rides the `Create` action the GSI add already issues — no extra
      // AWS call, only the value on an op that happens anyway.
      //
      // 12001/4000 is the SMALLEST raise AWS accepts above the floor it reports
      // for every table (12000/4000): measured us-east-1 2026-08-13, a `Create`
      // action carrying `{ReadUnitsPerSecond: 12001, WriteUnitsPerSecond: 4000}`
      // is accepted, and the index reports 12001 back. Only the READ member is
      // raised, and only on this ONE index, to keep the charge minimal.
      //
      // COST, stated so it is not "optimized" away as an oversight: this arm
      // incurs a small per-run DynamoDB pre-warming charge (+1 read unit above
      // the default, one index). It is deliberate and signed off by the
      // maintainer — the emit path has no other live coverage, and a decrease
      // (the arm above) exercises only the SKIP.
      //
      // Deliberately +1 rather than a round number: it can only come from this
      // declaration. An index created with no WarmThroughput reports exactly
      // 12000/4000, so the assertion in verify.sh fails the moment the emit
      // stops happening.
      (table.node.defaultChild as dynamodb.CfnTable).addPropertyOverride(
        'GlobalSecondaryIndexes.0.WarmThroughput',
        { ReadUnitsPerSecond: 12001, WriteUnitsPerSecond: 4000 }
      );
    }
  }
}
