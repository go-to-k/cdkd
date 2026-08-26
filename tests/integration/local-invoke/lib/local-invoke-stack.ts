import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run this fixture's Lambdas at the HOST's CPU architecture.
 *
 * cdk-local pins `docker --platform` to each function's declared
 * `Architectures` (`pullImage` / `architectureToPlatform`), which is the
 * correct behavior: a `provided.*` bootstrap compiled for one arch must get
 * the matching base image. But a function that declares no `architecture`
 * defaults to `X86_64`, so on an arm64 host every container in this fixture
 * ran `linux/amd64` under CPU emulation -- and the Go RIE inside
 * `public.ecr.aws/lambda/nodejs:20` faults there, at a different assertion on
 * every run. Measured 2026-08-27 on arm64: `fatal error: qemu: uncaught target
 * signal 11 (Segmentation fault)`, then `RIE invoke failed for
 * ItemsHandlerFB09CCF4 ... timed out after 60000ms`.
 *
 * Root cause and fix pattern: go-to-k/cdk-local#560 / go-to-k/cdk-local#567.
 *
 * The base image is multi-arch -- `docker manifest inspect
 * public.ecr.aws/lambda/nodejs:20` lists both `arm64`/v8 and `amd64` -- so
 * declaring the host arch makes the container native on an Apple Silicon dev
 * host AND on an x86_64 CI runner, rather than trading one host's emulation
 * for the other's. Hardcoding either value would just move the emulation:
 * `ARM_64` would make CI emulate, and `X86_64` is the default that caused this
 * in the first place. Nothing in verify.sh asserts the architecture, so this
 * costs no coverage.
 *
 * Caveat: `process.arch` is the architecture of the Node process running this
 * CDK app, NOT the Docker daemon's. A Rosetta-emulated Node, or a
 * `DOCKER_HOST` / `docker context` aimed at a foreign-arch daemon, can still
 * declare the non-native arch. Neither is the ordinary local case, and
 * cdk-local's emulation warning still fires when it happens.
 *
 * Keep this on every function in this fixture: a new handler that omits it
 * silently reintroduces the arm64-only flake, and it passes on CI (amd64,
 * where the default IS the host arch). The fence lives in
 * `tests/unit/scripts/integ-fixture-host-architecture.test.ts`. The other 16
 * `local-*` fixtures are still unfixed -- go-to-k/cdkd#2287.
 */
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

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
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        GREETING: 'hello',
      },
      timeout: cdk.Duration.seconds(10),
    });

    new lambda.Function(this, 'InlineHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        `exports.handler = async (event) => ({ inlineEcho: event });`
      ),
      timeout: cdk.Duration.seconds(10),
    });
  }
}
