import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for `cdkd local invoke` container-Lambda integ test (PR 5).
 *
 * Main Lambda — `EchoHandler` — built from a local Dockerfile in
 * `docker/`. The Dockerfile starts FROM the AWS Lambda Node.js base image
 * (which bundles RIE), copies a tiny `app.js` into `${LAMBDA_TASK_ROOT}`,
 * and uses CMD `["app.handler"]` so the image's default entrypoint
 * (`/lambda-entrypoint.sh`) routes to RIE on :8080.
 *
 * No AWS deploy required. The integ exercises:
 *   1. Local-build path: `cdkd local invoke` finds the asset via the cdk.out
 *      asset manifest, calls `docker build`, then runs the resulting image.
 *   2. `--event` payload pass-through.
 *   3. `--env-vars` SAM-shape override.
 *   4. `NonAwsBaseHandler` (#6018): an image on a non-AWS base with no RIE;
 *      cdkd mounts one and runs the image ENTRYPOINT + CMD under it.
 */
export class LocalInvokeContainerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.DockerImageFunction(this, 'EchoHandler', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../docker'), {
        // Obviously fake. `verify.sh` asserts a `--verbose` build log masks
        // it (go-to-k/cdkd#4967): a real app passes an `NPM_TOKEN` here.
        buildArgs: { CDKD_SENTINEL_ARG: 'FAKE-SENTINEL-NOT-A-SECRET-7f1e' },
      }),
      environment: {
        GREETING: 'hello',
      },
      timeout: cdk.Duration.seconds(10),
    });

    // go-to-k/cdkd#6018: a function on a NON-AWS base image, which ships no
    // Runtime Interface Emulator. cdkd must mount one and hand it the image's
    // own ENTRYPOINT + CMD. Built for the HOST's architecture (the base image
    // is multi-arch), so neither the function nor the mounted RIE runs under
    // emulation.
    new lambda.DockerImageFunction(this, 'NonAwsBaseHandler', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../docker-non-aws')),
      architecture: process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64,
      environment: {
        GREETING: 'from-non-aws-base',
      },
      timeout: cdk.Duration.seconds(10),
    });
  }
}
