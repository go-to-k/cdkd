import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

/**
 * Integ probe for the PER-INDEX `ContributorInsightsSpecification`
 * (`GlobalSecondaryIndexes[].ContributorInsightsSpecification`, issue #1782).
 *
 * The block is not a member of the SDK's `GlobalSecondaryIndex`, so cdkd used
 * to drop it on the wire (deploy green, feature OFF) and could not read it
 * back for drift. It lives in its OWN stack and table so its phases neither
 * wait on nor disturb the sibling stack's GSI-add / index-busy-destroy arms.
 *
 * Both indexes are created WITH the table and never change shape, so no phase
 * pays an index build: every transition below is a Contributor Insights
 * toggle on an index that already exists.
 *
 *   Phase A (no env):   giA declares `{Enabled: true}`; giB declares nothing
 *                       (the negative control — it must stay off).
 *   Phase B (CDKD_TEST_UPDATE=true):
 *                       giA's block is REMOVED (must turn OFF — the removal
 *                       arm), giB gains `{Enabled: true, Mode:
 *                       'THROTTLED_KEYS'}` (the enable-on-update arm, with a
 *                       Mode AWS's default cannot produce).
 *
 * Set via addPropertyOverride rather than an L2 prop so the fixture does not
 * pin a minimum aws-cdk-lib version.
 */
export class DynamodbGsiInsightsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'InsightsTable', {
      tableName: 'cdkd-gsi-insights-test-table',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    table.addGlobalSecondaryIndex({
      indexName: 'giA',
      partitionKey: { name: 'apk', type: dynamodb.AttributeType.STRING },
    });
    table.addGlobalSecondaryIndex({
      indexName: 'giB',
      partitionKey: { name: 'bpk', type: dynamodb.AttributeType.STRING },
    });

    const cfnTable = table.node.defaultChild as dynamodb.CfnTable;
    if (process.env.CDKD_TEST_UPDATE === 'true') {
      cfnTable.addPropertyOverride('GlobalSecondaryIndexes.1.ContributorInsightsSpecification', {
        Enabled: true,
        Mode: 'THROTTLED_KEYS',
      });
    } else {
      cfnTable.addPropertyOverride('GlobalSecondaryIndexes.0.ContributorInsightsSpecification', {
        Enabled: true,
      });
    }
  }
}
