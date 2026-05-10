import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Fixture stack for `cdkd local invoke` Python integ test (PR 4 of #224).
 *
 * Two Lambdas:
 *   - `EchoHandler` — asset-backed Python 3.12 function that echoes its
 *     event plus the value of an env var. Exercises the asset-path
 *     bind-mount code path AND the env-var resolution code path against
 *     the Python Lambda base image.
 *   - `InlineHandler` — `Code.fromInline` Python function. Exercises the
 *     inline-code materialization code path with the `.py` extension.
 *
 * No AWS deploy required — the integ runs against the synthesized
 * cdk.out only, mirroring `tests/integration/local-invoke/`.
 */
export class LocalInvokePythonStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.Function(this, 'EchoHandler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        GREETING: 'hello',
      },
      timeout: cdk.Duration.seconds(10),
    });

    new lambda.Function(this, 'InlineHandler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        [
          'def handler(event, context):',
          '    return {"inlineEcho": event}',
          '',
        ].join('\n')
      ),
      timeout: cdk.Duration.seconds(10),
    });
  }
}
