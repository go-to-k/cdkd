import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Integ probe for the IAM Role sibling-policy phantom-drift bug.
 *
 * CDK emits a construct's grants as a SEPARATE `AWS::IAM::Policy` resource
 * (the `Default Policy*`) attached to the role via `Roles: [role]`, NOT as an
 * inline `Policies` entry on the role itself. AWS implements that via
 * `iam:PutRolePolicy`, so the inline policy shows up in `ListRolePolicies`.
 *
 * Before the fix, the deploy-time `observedProperties` capture for the role
 * passed NO sibling context, so the `ListRolePolicies` read RACED the
 * sibling policy's `PutRolePolicy`. When the read landed after the write, the
 * sibling-managed `DefaultPolicy*` leaked into `observedProperties.Policies`.
 * A later `cdkd drift` (whose AWS-current side correctly filters
 * sibling-managed inline policies) then reported phantom drift on the role:
 *   `- Policies:[{...DefaultPolicy...}]  + Policies:[]`
 * This fires for essentially every Lambda / L2 construct that has a grant —
 * one of the most common CDK patterns.
 *
 * This fixture exercises both shapes the bug touches:
 *   - A Lambda whose grant emits a service-role `Default Policy` sibling.
 *   - A standalone `iam.Role` with `addToPolicy(...)` (also a sibling Policy)
 *     AND an explicitly-declared inline policy (so the role's own `Policies`
 *     are non-empty), to prove the filter excludes only the sibling-managed
 *     name and keeps the declared one.
 *
 * verify.sh deploys this, runs `cdkd drift`, and asserts NO drift on any
 * `AWS::IAM::Role`.
 */
export class IamRolePoliciesDriftCleanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const queue = new sqs.Queue(this, 'Queue', {
      queueName: 'cdkd-iam-drift-clean-test-queue',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Lambda with a grant -> its service role gets a `Default Policy` sibling
    // AWS::IAM::Policy (the canonical phantom-drift trigger).
    const fn = new lambda.Function(this, 'Fn', {
      functionName: 'cdkd-iam-drift-clean-test-fn',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'exports.handler = async () => ({ statusCode: 200, body: "ok" });'
      ),
    });
    queue.grantSendMessages(fn);

    // Standalone role with BOTH an explicitly-declared inline policy and an
    // addToPolicy()-emitted sibling Default Policy. The role's own `Policies`
    // is non-empty, so this proves the capture filter excludes only the
    // sibling-managed name (not the declared inline policy).
    const role = new iam.Role(this, 'WorkerRole', {
      roleName: 'cdkd-iam-drift-clean-test-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        DeclaredInline: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['sqs:GetQueueAttributes'],
              resources: [queue.queueArn],
            }),
          ],
        }),
      },
    });
    // This addToPolicy lands in a SEPARATE AWS::IAM::Policy (Default Policy).
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [queue.queueArn],
      })
    );

    new cdk.CfnOutput(this, 'FnName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'WorkerRoleName', { value: role.roleName });
  }
}
