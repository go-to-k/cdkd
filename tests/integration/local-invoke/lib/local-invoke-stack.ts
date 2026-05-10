import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Fixture stack for `cdkd local invoke` integ test.
 *
 * Two Lambdas:
 *   - `EchoHandler` — asset-backed Node.js function that echoes its event
 *     plus the value of an env var. Exercises the asset-path bind-mount
 *     code path AND the env-var resolution code path.
 *   - `InlineHandler` — `Code.ZipFile` inline function. Exercises the
 *     inline-code materialization code path.
 *
 * No AWS deploy required — the integ runs against the synthesized
 * cdk.out only.
 */
export class LocalInvokeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.Function(this, 'EchoHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        GREETING: 'hello',
      },
      timeout: cdk.Duration.seconds(10),
    });

    new lambda.Function(this, 'InlineHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        `exports.handler = async (event) => ({ inlineEcho: event });`
      ),
      timeout: cdk.Duration.seconds(10),
    });
  }
}
