import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Fixture stack for `cdkd local invoke` provided.* + go1.x integ test
 * (issue #248, final sub-PR).
 *
 * Four Lambdas:
 *   - `BootstrapHandler` — asset-backed `provided.al2023` function. The
 *     asset directory contains a statically-linked `bootstrap` binary
 *     compiled from `lambda/main.go` inside a Docker Go toolchain
 *     container; the OS-only Lambda runtime invokes it via the Lambda
 *     Runtime API. Architecture pinned to `x86_64` so the linux/amd64
 *     bootstrap built in CI matches the base image's default platform.
 *   - `ProvidedAl2023InlineHandler` — `CfnFunction` with `Code: { ZipFile }`
 *     and `runtime: provided.al2023`. cdkd's local invoke must reject
 *     with the "use Code.fromAsset" message — `provided.*` runtimes ship
 *     arbitrary native binaries that can't be expressed as inline source.
 *   - `ProvidedAl2InlineHandler` — same as above but `runtime: provided.al2`.
 *     Smoke-tests that both `provided.*` variants reject identically.
 *   - `Go1xHandler` — `CfnFunction` with `runtime: go1.x`. AWS Lambda
 *     deprecated this runtime on 2024-01-08 and removed its base image,
 *     so cdkd must reject with a migration pointer to provided.al2023.
 *     CfnFunction is the L1 escape hatch because `lambda.Runtime.GO_1_X`
 *     still exists in CDK but our CDK lib version may or may not refuse
 *     it at synth time depending on CDK release; we want the rejection
 *     to come from cdkd, not the construct.
 *
 * No AWS deploy required — the integ runs against the synthesized
 * cdk.out only, mirroring the other local-invoke fixtures.
 */
export class LocalInvokeProvidedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.Function(this, 'BootstrapHandler', {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.X86_64,
      // For `provided.*` runtimes the Lambda runtime invokes /var/task/bootstrap
      // regardless of the Handler value; CDK requires the field to be non-empty.
      handler: 'bootstrap',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/build')),
      environment: {
        GREETING: 'hello',
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });

    const inlineRole = new iam.Role(this, 'InlineHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    new lambda.CfnFunction(this, 'ProvidedAl2023InlineHandler', {
      runtime: 'provided.al2023',
      handler: 'bootstrap',
      role: inlineRole.roleArn,
      code: {
        zipFile: '// provided.* does not actually accept inline source.',
      },
      timeout: 30,
      memorySize: 128,
    });

    new lambda.CfnFunction(this, 'ProvidedAl2InlineHandler', {
      runtime: 'provided.al2',
      handler: 'bootstrap',
      role: inlineRole.roleArn,
      code: {
        zipFile: '// provided.* does not actually accept inline source.',
      },
      timeout: 30,
      memorySize: 128,
    });

    new lambda.CfnFunction(this, 'Go1xHandler', {
      runtime: 'go1.x',
      // Go 1.x's pre-OAL Handler was the compiled binary name on the
      // classpath. Doesn't matter for the integ — cdkd rejects with a
      // deprecation message before touching the asset.
      handler: 'main',
      role: inlineRole.roleArn,
      code: {
        zipFile: '// go1.x was deprecated on 2024-01-08; no longer invocable.',
      },
      timeout: 30,
      memorySize: 128,
    });
  }
}
