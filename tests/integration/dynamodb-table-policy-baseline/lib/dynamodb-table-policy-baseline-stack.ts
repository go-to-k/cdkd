import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/** covers: AWS::DynamoDB::Table */
export class DynamoDBTablePolicyBaselineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // go-to-k/cdkd#6604: the table declares a resource policy; the removal
    // phase (`CDKD_TEST_REMOVAL=true`) drops it, and the last phase declares it
    // again. GetResourcePolicy lags each write by seconds.
    const removed = process.env.CDKD_TEST_REMOVAL === 'true';
    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      ...(!removed && {
        resourcePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['dynamodb:GetItem'],
              principals: [new iam.AccountRootPrincipal()],
              resources: ['*'],
            }),
          ],
        }),
      }),
    });

    // go-to-k/cdkd#6609 slice E: a tag whose value a later phase changes
    // (`CDKD_TEST_TAG`). ListTagsOfResource lags a TagResource by seconds.
    cdk.Tags.of(table).add('Lag6609e', process.env.CDKD_TEST_TAG ?? 'v1');

    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'TableArn', { value: table.tableArn });
  }
}
