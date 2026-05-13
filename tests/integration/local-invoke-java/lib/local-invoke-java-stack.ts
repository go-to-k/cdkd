import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for `cdkd local invoke` Java integ test (issue #248,
 * Java sub-PR).
 *
 * Two Lambdas:
 *   - `EchoHandler` — asset-backed Java 17 function that echoes its
 *     event plus the value of an env var. The asset directory must
 *     contain a compiled `Handler.class` before synth; `verify.sh`
 *     compiles it inside a Docker JDK container before invoking
 *     `cdkd synth` so the host doesn't need a JDK installed.
 *   - `InlineHandler` — `CfnFunction` with `Code: { ZipFile: ... }` and
 *     `runtime: java17`. cdkd's local invoke must reject this with the
 *     "use Code.fromAsset" message — Java's Handler shape names a
 *     compiled class, which can't be expressed as a single source file.
 *     Built via the L1 escape hatch because `lambda.Code.fromInline`
 *     already refuses Java at synth time (CDK-side guard).
 *
 * No AWS deploy required — the integ runs against the synthesized
 * cdk.out only, mirroring `tests/integration/local-invoke-python/` and
 * `tests/integration/local-invoke-ruby/`.
 */
export class LocalInvokeJavaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Java cold start on a fresh JVM is materially slower than Node /
    // Python / Ruby. Bump the function timeout AND the memory size so
    // the local container has enough headroom for class loading.
    new lambda.Function(this, 'EchoHandler', {
      runtime: lambda.Runtime.JAVA_17,
      handler: 'Handler::handleRequest',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
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
      runtime: 'java17',
      handler: 'Handler::handleRequest',
      role: inlineRole.roleArn,
      // The body is intentionally a no-op — cdkd local invoke must
      // reject this BEFORE attempting any container work.
      code: {
        zipFile: '// Java does not actually accept inline source.',
      },
      timeout: 30,
      memorySize: 512,
    });
  }
}
