import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

/**
 * Issue #6977: renaming a Lambda function that has a `currentVersion` and an
 * alias.
 *
 * - default: function `<stack>-fn-v1`, its `currentVersion`, alias `live`.
 * - `CDKD_TEST_UPDATE=true`: the function is renamed `<stack>-fn-v2`. That
 *   replaces the function and the alias, and the version's logical id (a
 *   hash that covers the function name) changes, so the old version is a
 *   resource REMOVED from the template while the old alias, deleted in the
 *   cleanup phase, still points at it. Lambda refuses to delete a version an
 *   alias references, so the old alias must go first, as CloudFormation's
 *   cleanup phase does.
 *
 * The function names are fixed so `verify.sh` can probe and clean them up.
 */
export class ReplacedUserOfRemovedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const renamed = process.env.CDKD_TEST_UPDATE === 'true';

    const fn = new lambda.Function(this, 'Fn', {
      functionName: `${this.stackName}-fn-${renamed ? 'v2' : 'v1'}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => "ok";'),
    });
    new lambda.Alias(this, 'Live', { aliasName: 'live', version: fn.currentVersion });
  }
}
