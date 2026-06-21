import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';

/**
 * Regression fixture for the DynamoDB SSESpecification field-name bug. CDK's
 * TableEncryption.AWS_MANAGED synthesizes SSESpecification: { SSEEnabled: true }
 * (CFn casing). The SDK CreateTable field is `Enabled`, so passing the CFn shape
 * verbatim silently created an AWS-owned-encrypted table (no SSEDescription)
 * instead of the requested AWS-managed KMS encryption. verify.sh asserts
 * describe-table SSEDescription.Status=ENABLED + SSEType=KMS.
 *
 * covers: AWS::DynamoDB::Table
 */
export class DynamodbSseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    new ddb.Table(this, 'Table', {
      tableName: 'cdkd-dynamodb-sse-table',
      partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      encryption: ddb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
