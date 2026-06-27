import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Lambda `reservedConcurrentExecutions` (applied via the separate
 * PutFunctionConcurrency API — easy to silent-drop) plus a Function URL.
 * Confirmed CLEAN by a /hunt-bugs sweep; this fixture is the regression guard.
 */
const RESERVED = 5;

export class LambdaReservedConcurrencyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const fn = new lambda.Function(this, 'Fn', {
      functionName: `${this.stackName}-fn`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(10),
      reservedConcurrentExecutions: RESERVED,
      code: lambda.Code.fromInline('exports.handler=async()=>({statusCode:200,body:"ok"});'),
    });
    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    new cdk.CfnOutput(this, 'Url', { value: url.url });
  }
}
