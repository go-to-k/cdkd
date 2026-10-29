import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

/**
 * State schema v14 -> v15 migration fixture (issue #5498).
 *
 * v15 records `ResourceState.unsettledItems`: the item names (here a DynamoDB
 * index) a failed update's ACCEPTED calls added, so the next deploy removes
 * the one the template no longer names.
 *
 * Every input is an ENVIRONMENT variable verify.sh sets, read at synth time,
 * so the released and the local binary synthesize the same template:
 *
 *   CDKD_V15_TABLE  the per-run table name
 *   CDKD_V15_EDIT   `base` (no index) or `gsi` (adds `gsi2`)
 *
 * Resources: one PAY_PER_REQUEST table, `Table`.
 */
export class SchemaV14ToV15MigrationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const tableName = process.env.CDKD_V15_TABLE ?? 'cdkd-schema-v15-unset';
    const edit = process.env.CDKD_V15_EDIT ?? 'base';

    const table = new dynamodb.Table(this, 'Table', {
      tableName,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    (table.node.defaultChild as dynamodb.CfnTable).overrideLogicalId('Table');
    cdk.Tags.of(table).add('cdkd-integ', 'schema-v14-to-v15');
    if (edit === 'gsi') {
      table.addGlobalSecondaryIndex({
        indexName: 'gsi2',
        partitionKey: { name: 'g2pk', type: dynamodb.AttributeType.STRING },
      });
    }
  }
}
