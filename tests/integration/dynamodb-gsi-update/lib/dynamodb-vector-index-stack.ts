import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

/**
 * Integ probe for `AWS::DynamoDB::Table.VectorIndexes` (go-to-k/cdkd#2762).
 *
 * The property used to be absent from the SDK provider's handled set, so a
 * table declaring it was auto-routed to Cloud Control. It lives in its OWN
 * stack and table so its index builds neither wait on nor disturb the sibling
 * stacks' arms.
 *
 *   Phase V1 (no env):  `vec1` (3 dimensions, COSINE, KEYS_ONLY) is created
 *                       WITH the table, partitioned by `tenant` (HASH search
 *                       schema element, defined in AttributeDefinitions: AWS
 *                       checks its data type against the table's definition).
 *   Phase V3 (CDKD_TEST_UPDATE=true):
 *                       `vec1` is REMOVED and `vec2` (4 dimensions, EUCLIDEAN,
 *                       INCLUDE `title`) ADDED: one UpdateTable Delete, then
 *                       one Create, on the same table. Both read the same
 *                       `embedding` attribute, which AWS allows only at one
 *                       dimension count, so the Delete must settle first.
 *   Phase V3m (CDKD_TEST_VECTOR_MALFORMED=true, on top of the update):
 *                       the entry's `IndexName` is no string, which reads as
 *                       "no index declared": refused, `vec2` stays
 *                       (go-to-k/cdkd#5606). A MISSING one never reaches the
 *                       provider: the pre-flight required-member check refuses it.
 *   Phase V3w (CDKD_TEST_WARM_RAISE=true, on top of the update):
 *                       a table-level and a per-index WarmThroughput above the
 *                       12000/4000 AWS holds. Billed pre-warming, per run
 *                       (go-to-k/cdkd#5606).
 *
 * L1 overrides rather than an L2 prop: aws-cdk-lib's `Table` has no vector
 * index API, and the fixture does not pin a minimum aws-cdk-lib version.
 */
export class DynamodbVectorIndexStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'VectorTable', {
      tableName: 'cdkd-vector-index-test-table',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    table.addGlobalSecondaryIndex({
      indexName: 'warmGsi',
      partitionKey: { name: 'tenant', type: dynamodb.AttributeType.STRING },
    });

    const cfnTable = table.node.defaultChild as dynamodb.CfnTable;
    cfnTable.addPropertyOverride('AttributeDefinitions', [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'tenant', AttributeType: 'S' },
    ]);
    const searchSchema = [{ AttributeName: 'tenant', SearchSchemaElementType: 'HASH' }];
    cfnTable.addPropertyOverride(
      'VectorIndexes',
      process.env.CDKD_TEST_UPDATE === 'true'
        ? [
            {
              IndexName: process.env.CDKD_TEST_VECTOR_MALFORMED === 'true' ? 7 : 'vec2',
              VectorAttribute: { AttributeName: 'embedding' },
              Dimensions: 4,
              DistanceFunction: 'EUCLIDEAN',
              Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['title'] },
              SearchSchema: searchSchema,
            },
          ]
        : [
            {
              IndexName: 'vec1',
              VectorAttribute: { AttributeName: 'embedding' },
              Dimensions: 3,
              DistanceFunction: 'COSINE',
              Projection: { ProjectionType: 'KEYS_ONLY' },
              SearchSchema: searchSchema,
            },
          ]
    );
    if (process.env.CDKD_TEST_WARM_RAISE === 'true') {
      const raised = { ReadUnitsPerSecond: 14000, WriteUnitsPerSecond: 6000 };
      cfnTable.addPropertyOverride('WarmThroughput', raised);
      cfnTable.addPropertyOverride('GlobalSecondaryIndexes.0.WarmThroughput', raised);
    }
  }
}
