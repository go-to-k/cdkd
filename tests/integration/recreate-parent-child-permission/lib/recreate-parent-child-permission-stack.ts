import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Integ fixture for issue #4411: a sub-resource AWS stores INSIDE a parent is
 * re-created when the deploy destroys the parent and re-creates it under the
 * same physical id.
 *
 * The parent is a Lambda function with a FIXED name, so a
 * `--recreate-via-cc-api` of it is delete-first and the new function holds the
 * old id. Its `AWS::Lambda::Permission` is a statement of the function's
 * resource-based policy and is deleted with the function, while its
 * `FunctionName` resolves exactly as recorded: before the fix the deploy
 * skipped it as unchanged and the new function had no policy at all.
 *
 * covers: AWS::Lambda::Function
 * covers: AWS::Lambda::Permission
 */
export class RecreateParentChildPermissionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const role = new iam.CfnRole(this, 'FnRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
    });

    const fn = new lambda.CfnFunction(this, 'ParentFn', {
      functionName: `${this.stackName}-fn`,
      runtime: 'python3.12',
      handler: 'index.handler',
      role: role.attrArn,
      code: { zipFile: 'def handler(event, context):\n    return "ok"\n' },
    });

    new lambda.CfnPermission(this, 'ChildPermission', {
      action: 'lambda:InvokeFunction',
      functionName: fn.ref,
      principal: 'sns.amazonaws.com',
      sourceAccount: this.account,
    });
  }
}
