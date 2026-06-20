import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';

/**
 * Lambda `logRetention` stack.
 *
 * `logRetention` is a very common (if now-deprecated) Lambda prop. CDK
 * synthesizes a Custom::LogRetention custom resource — a Provider-framework
 * singleton Lambda that CREATES the function's log group and sets its retention
 * via a control-plane call. The interesting, previously-untested divergence
 * point is the UPDATE path: changing the retention on redeploy must be an
 * in-place control-plane update, not a replacement.
 *
 * The existing `cache-streaming` fixture sets `logRetention` but has no
 * verify.sh, so the retention value is never asserted and the UPDATE path is
 * never exercised. This fixture closes both gaps.
 *
 * Set CDKD_TEST_UPDATE=true to flip retention 7 -> 14 days for the UPDATE phase.
 *
 * covers: Custom::LogRetention
 */
export class LambdaLogRetentionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const retention =
      process.env.CDKD_TEST_UPDATE === 'true'
        ? logs.RetentionDays.TWO_WEEKS
        : logs.RetentionDays.ONE_WEEK;

    const fn = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      logRetention: retention,
      code: lambda.Code.fromInline("exports.handler = async () => 'ok';"),
    });

    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
  }
}
