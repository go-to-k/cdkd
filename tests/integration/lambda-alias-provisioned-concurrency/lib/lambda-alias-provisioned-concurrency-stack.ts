import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Lambda Version + Alias with provisioned concurrency on the alias. The Version
 * is immutable (replaced on a code change) and
 * `Alias.ProvisionedConcurrencyConfig` is applied via the separate
 * PutProvisionedConcurrencyConfig API. Confirmed CLEAN by a /hunt-bugs sweep;
 * this fixture is the regression guard.
 */
export class LambdaAliasProvisionedConcurrencyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const fn = new lambda.Function(this, 'Fn', {
      functionName: `${this.stackName}-fn`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler=async()=>({msg:"v1"});'),
    });
    const version = fn.currentVersion;
    new lambda.Alias(this, 'Alias', {
      aliasName: 'live',
      version,
      provisionedConcurrentExecutions: 1,
    });
  }
}
