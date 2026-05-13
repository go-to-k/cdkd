import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for `cdkd local invoke` Ruby integ test (issue #248).
 *
 * Two Lambdas:
 *   - `EchoHandler` — asset-backed Ruby 3.3 function that echoes its
 *     event plus the value of an env var. Exercises the asset-path
 *     bind-mount code path AND the env-var resolution code path against
 *     the Ruby Lambda base image.
 *   - `InlineHandler` — `CfnFunction` with `Code: { ZipFile: ... }`
 *     directly (the L2 `lambda.Code.fromInline` construct refuses Ruby
 *     at synth time even though AWS Lambda itself accepts it; using the
 *     L1 escape hatch bypasses the construct-side guard). Exercises
 *     cdkd's inline-code materializer with the `.rb` extension.
 *
 * No AWS deploy required — the integ runs against the synthesized
 * cdk.out only, mirroring `tests/integration/local-invoke-python/`.
 */
export class LocalInvokeRubyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.Function(this, 'EchoHandler', {
      runtime: lambda.Runtime.RUBY_3_3,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        GREETING: 'hello',
      },
      timeout: cdk.Duration.seconds(10),
    });

    const inlineRole = new iam.Role(this, 'InlineHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    new lambda.CfnFunction(this, 'InlineHandler', {
      runtime: 'ruby3.3',
      handler: 'index.handler',
      role: inlineRole.roleArn,
      code: {
        zipFile: [
          'def handler(event:, context:)',
          '  { "inlineEcho" => event }',
          'end',
          '',
        ].join('\n'),
      },
      timeout: 10,
    });
  }
}
