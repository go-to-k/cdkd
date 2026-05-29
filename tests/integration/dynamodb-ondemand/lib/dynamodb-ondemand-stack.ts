import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

/**
 * DynamoDB OnDemandThroughput backfill integ fixture (issue #609).
 *
 * A single PAY_PER_REQUEST (on-demand) DynamoDB table with on-demand
 * capacity caps. The CDK L2 `maxReadRequestUnits` / `maxWriteRequestUnits`
 * props synthesize to the top-level CFn property
 * `OnDemandThroughput.MaxReadRequestUnits` /
 * `OnDemandThroughput.MaxWriteRequestUnits`.
 *
 * Pre-#609 backfill, `OnDemandThroughput` was a silent-drop in cdkd's
 * `DynamoDBTableProvider` (the value never reached AWS). This slice wires
 * it onto CreateTable / UpdateTable.
 *
 * The fixture's verify.sh asserts that after `cdkd deploy` the caps reach
 * AWS (verified via `aws dynamodb describe-table --query
 * 'Table.OnDemandThroughput'`), and that `cdkd destroy` cleans up.
 */
export class DynamodbOndemandStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new dynamodb.Table(this, 'OndemandTable', {
      tableName: 'cdkd-ondemand-test-table',
      partitionKey: {
        name: 'id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // These synthesize to OnDemandThroughput.MaxReadRequestUnits /
      // MaxWriteRequestUnits — the property this fixture exercises.
      maxReadRequestUnits: 10,
      maxWriteRequestUnits: 5,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
