import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for `cdkd local invoke` .NET integ test (issue #248,
 * .NET sub-PR).
 *
 * Two Lambdas:
 *   - `EchoHandler` — asset-backed .NET 8 function that echoes its
 *     event plus the value of an env var. The asset directory must
 *     contain the `dotnet publish` output (Function.dll + dependencies)
 *     before synth; `verify.sh` runs `dotnet publish` inside a Docker
 *     .NET SDK container before invoking `cdkd synth` so the host
 *     doesn't need a .NET SDK installed.
 *   - `InlineHandler` — `CfnFunction` with `Code: { ZipFile: ... }` and
 *     `runtime: dotnet8`. cdkd's local invoke must reject this with the
 *     "use Code.fromAsset" message — .NET's Handler shape names a
 *     compiled assembly (`Assembly::Namespace.Class::Method`), which
 *     can't be expressed as a single source file. Built via the L1
 *     escape hatch because `lambda.Code.fromInline` already refuses
 *     .NET at synth time (CDK-side guard).
 *
 * No AWS deploy required — the integ runs against the synthesized
 * cdk.out only, mirroring the Node / Python / Ruby / Java fixtures.
 */
export class LocalInvokeDotnetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // .NET cold start on a fresh CLR is materially slower than Node /
    // Python / Ruby. Bump the function timeout AND the memory size so
    // the local container has enough headroom for assembly loading.
    new lambda.Function(this, 'EchoHandler', {
      runtime: lambda.Runtime.DOTNET_8,
      handler: 'Function::Function.Handler::HandleRequest',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/publish')),
      environment: {
        GREETING: 'hello',
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
    });

    const inlineRole = new iam.Role(this, 'InlineHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    new lambda.CfnFunction(this, 'InlineHandler', {
      runtime: 'dotnet8',
      handler: 'Function::Function.Handler::HandleRequest',
      role: inlineRole.roleArn,
      // The body is intentionally a no-op — cdkd local invoke must
      // reject this BEFORE attempting any container work.
      code: {
        zipFile: '// .NET does not actually accept inline source.',
      },
      timeout: 30,
      memorySize: 512,
    });
  }
}
