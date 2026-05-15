import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';

/**
 * Real-AWS test fixture for cdkd's `AWS::DynamoDB::GlobalTable` SDK
 * Provider. Closes Issue #383.
 *
 * The user-reported bug: a `dynamodb.TableV2` construct WITHOUT an
 * explicit `tableName` synthesized as `AWS::DynamoDB::GlobalTable` and
 * fell through to Cloud Control API, which auto-generated random names
 * like `yq2phLewTEUtzr4sy2gYFRU4I-1OGJ0UFLOKOOV` instead of the cdkd
 * `${stackName}-X<hash>` shape.
 *
 * This fixture deploys a single-region TableV2 with:
 *   - partitionKey + sortKey (the user's reported shape)
 *   - PAY_PER_REQUEST billing (CDK's TableV2 default)
 *   - NO explicit `tableName` (the bug trigger)
 *   - RemovalPolicy.DESTROY so the destroy step cleans up
 *
 * verify.sh asserts the deployed table name starts with `${StackName}-`
 * (proving the SDK Provider name generator ran, not CC API's auto-gen).
 */
export class DynamoDBGlobalTableStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // The canonical user-reported scenario: TableV2 with no explicit
    // tableName. Pre-PR, cdkd fell through to CC API and AWS auto-
    // generated a random opaque name. Post-PR, cdkd's new SDK Provider
    // generates `${stackName}-<logicalId>-<hash>`.
    const historyTable = new ddb.TableV2(this, 'HistoryTable', {
      partitionKey: { name: 'sessionId', type: ddb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: ddb.AttributeType.STRING },
      billing: ddb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Surface the name + ARN as outputs so verify.sh can assert against
    // them without an extra DescribeTable call.
    new cdk.CfnOutput(this, 'TableName', {
      value: historyTable.tableName,
      description: 'AWS-side physical name of the deployed GlobalTable',
    });
    new cdk.CfnOutput(this, 'TableArn', {
      value: historyTable.tableArn,
      description: 'AWS-side ARN of the deployed GlobalTable',
    });
  }
}
