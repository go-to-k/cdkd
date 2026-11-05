import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';

/**
 * Real-AWS fixture for issues #5789 and #5790: `cdkd drift` on an
 * `AWS::DynamoDB::GlobalTable` whose record has no `observedProperties`, so
 * the comparison falls back to the template bag.
 *
 * covers: AWS::DynamoDB::GlobalTable
 *
 * One replica (the stack's region) keeps the run short. The replica declares
 * nothing but its region, and the table sits on the AWS managed key — the
 * top-level `SSESpecification` CDK's `TableEncryptionV2.awsManagedKey()`
 * renders (`SSEEnabled: true`, `SSEType: KMS`, no key). The read-back writes
 * the replica's class, deletion protection, contributor insights, point-in-
 * time recovery, tags and key ARN regardless, so every one of them is a
 * member the template bag never declared.
 */
export class GlobalTableTemplateBaselineDriftStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new ddb.CfnGlobalTable(this, 'BaselineTable', {
      tableName: `${this.stackName}-table`,
      billingMode: 'PAY_PER_REQUEST',
      attributeDefinitions: [{ attributeName: 'pk', attributeType: 'S' }],
      keySchema: [{ attributeName: 'pk', keyType: 'HASH' }],
      sseSpecification: { sseEnabled: true, sseType: 'KMS' },
      replicas: [{ region: this.region }],
    });
    table.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'TableName', { value: table.ref });
  }
}
