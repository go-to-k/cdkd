import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';

/**
 * Issue #6363: a KeySchema change on an `AWS::DynamoDB::GlobalTable` is not a
 * create-only change in the schema (CloudFormation lists it as "Some
 * interruptions"), so it reaches the provider's immutable-property guard. That
 * guard advises `--replace --force-stateful-recreation`, and the fixture proves
 * the advice works.
 *
 * The table name is FIXED on purpose: a custom name makes the replacement
 * delete-first, the path the bug blocked.
 *
 * `CDKD_TEST_UPDATE=sk` adds a sort key. The verify script deploys it without
 * flags (refused), with `--replace` alone (refused by the stateful guard), and
 * with both flags (replaced).
 */
export class GlobalTableKeySchemaReplaceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const modes = (process.env.CDKD_TEST_UPDATE ?? '').split(',');

    new dynamodb.TableV2(this, 'Table', {
      tableName: 'CdkdGlobalTableKeySchemaReplace',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      ...(modes.includes('sk') && {
        sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      }),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
