import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Nested-map-key removal.
 *
 * A Lambda's `Environment.Variables` is a nested map. Removing a key from it must
 * reach AWS (UpdateFunctionConfiguration replaces the whole env map). cdkd
 * previously compared the nested map asymmetrically (only the new-side keys), so
 * a removed key compared equal (NO_CHANGE) and never re-provisioned -> the
 * dropped env var stayed live on the function. This fixture removes one env var
 * on UPDATE and asserts it is gone from AWS.
 *
 *   covers: AWS::Lambda::Function
 *
 * Phase 1 sets {KEEP, TOREMOVE}; Phase 2 (CDKD_TEST_UPDATE=true) sets {KEEP}.
 */
export class LambdaEnvRemovalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const env: Record<string, string> = { KEEP: 'yes' };
    if (process.env.CDKD_TEST_UPDATE !== 'true') {
      env.TOREMOVE = 'bye';
    }

    new lambda.Function(this, 'Fn', {
      functionName: `${this.stackName}-fn`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
      environment: env,
    });
  }
}
