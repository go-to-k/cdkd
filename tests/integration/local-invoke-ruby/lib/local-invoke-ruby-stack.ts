import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Every Lambda here declares the HOST's architecture (issue #2287; the rule
 * and its fence are in `.claude/rules/testing.md`). A `lambda.Function`
 * with no `architecture` is `X86_64`, so on an arm64 host its container
 * runs under CPU emulation, where the Go RIE inside the base image faults.
 * The asset is portable bytecode and the base image is multi-arch, so the
 * host-derived form is native on both. The inline-rejection `CfnFunction`
 * never starts a container, but carries the same declaration so the fence
 * has one rule.
 */
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

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
      architecture: HOST_ARCHITECTURE,
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
      architectures: [HOST_ARCHITECTURE.name],
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
