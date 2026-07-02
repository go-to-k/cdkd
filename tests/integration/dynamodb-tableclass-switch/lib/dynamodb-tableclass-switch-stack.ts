import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

// cdkd DynamoDB TableClass-switch integ probe.
//
// Phase 1 (base): TableClass STANDARD.
// Phase 2 (CDKD_TEST_UPDATE=true): TableClass STANDARD_INFREQUENT_ACCESS.
//
// CFn applies a TableClass change in place via UpdateTable ("Update requires:
// No interruption"). cdkd's dynamodb-table-provider.update() previously had no
// TableClass branch, so the switch was silently dropped: the deploy reported
// success while AWS kept the old class (and the next diff saw no change since
// state recorded the new class, so it could never self-heal). The fix wires
// TableClass into the UpdateTable branch; this fixture proves the switch
// actually reaches AWS.
//
// AWS allows at most two table-class switches per table per 30-day window —
// each run creates a fresh auto-named table and performs exactly one switch,
// so the limit is never hit across runs.
export class DynamodbTableclassSwitchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const toInfrequentAccess = process.env.CDKD_TEST_UPDATE === 'true';

    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      tableClass: toInfrequentAccess
        ? dynamodb.TableClass.STANDARD_INFREQUENT_ACCESS
        : dynamodb.TableClass.STANDARD,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
