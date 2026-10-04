import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for `cdkd local invoke --from-cfn-stack` (issue #606).
 *
 * One Lambda + one DynamoDB table. The Lambda's env has `TABLE_NAME`
 * set to `Ref: MyTable` (an intrinsic). Without `--from-cfn-stack` the
 * local invoke would drop it (same warn-and-drop semantics as the
 * `local-invoke-from-state` fixture). With `--from-cfn-stack`, after
 * the CDK app is deployed via the upstream `cdk deploy` (NOT cdkd),
 * the deployed table name is read from CloudFormation via
 * `DescribeStackResources` and substituted, so the Lambda echoes the
 * literal physical table name back.
 *
 * Table carries `removalPolicy: DESTROY` so the integ teardown is
 * fully self-contained on `cdk destroy`.
 */
export class LocalInvokeFromCfnStackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'MyTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new lambda.Function(this, 'EchoTableHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        // The whole point of the integ: this is an intrinsic-valued env
        // var. Without --from-cfn-stack it would be dropped (warn-and-drop).
        // With --from-cfn-stack, the deployed table name flows through.
        TABLE_NAME: table.tableName,
        // A literal env var to confirm --from-cfn-stack doesn't break
        // normal-case behavior on its way through.
        STATIC_VALUE: 'always-the-same',
      },
      timeout: cdk.Duration.seconds(10),
    });

    // Issue #3240: a role with NO permissions, assumable from this account,
    // passed as `--role-arn`. `--from-cfn-stack` must read the stack with the
    // CALLER's credentials, so the deployed table name still resolves; before
    // the fix the read ran as this role and failed with AccessDenied. The name
    // is CloudFormation-generated (unique per stack) and the role is deleted
    // with the stack (IAM roles default to DESTROY).
    const noPermissionRole = new iam.Role(this, 'NoPermissionRole', {
      assumedBy: new iam.AccountRootPrincipal(),
      description: 'cdkd integ local-invoke-from-cfn-stack: a --role-arn with no permissions',
    });
    new cdk.CfnOutput(this, 'NoPermissionRoleArn', { value: noPermissionRole.roleArn });
  }
}
