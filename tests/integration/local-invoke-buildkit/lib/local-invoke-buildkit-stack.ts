import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for the comprehensive BuildKit-Dockerfile regression integ.
 *
 * `BuildkitHandler` is built from a Dockerfile that exercises EVERY
 * BuildKit feature this PR newly forwards through cdkd's docker build
 * path: `# syntax=docker/dockerfile:1`, multi-stage with `--target`,
 * `ARG` via `--build-arg`, heredocs (`RUN <<EOF`), `RUN --mount=type=cache`,
 * AND `RUN --mount=type=secret` via `--secret`.
 *
 * Each feature bakes a verifiable artifact into the image so the integ's
 * runtime invocation proves the flag actually flowed through:
 *   - `buildArg`: echoes the `dockerBuildArgs.GREETING_BUILD_ARG` value
 *   - `secretSha`: echoes sha256 of the file `dockerBuildSecrets.mysecret` mounted
 *   - `multiStageTarget: 'final'`: only the `final` stage exposes `app.js`,
 *     so a non-target build (or build that picked the wrong stage) would
 *     fail to load the handler
 */
export class LocalInvokeBuildkitStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.DockerImageFunction(this, 'BuildkitHandler', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../docker'), {
        // Multi-stage Dockerfile — picks the `final` stage explicitly.
        target: 'final',
        // ARG threaded via `--build-arg` to confirm `dockerBuildArgs` flows
        // through cdkd unchanged (was pre-fix-supported, but verifying parity).
        buildArgs: {
          GREETING_BUILD_ARG: 'compiled-in-from-cdk',
        },
        // BuildKit `--secret` via cdkd's new `dockerBuildSecrets` forwarding.
        // The Dockerfile's `RUN --mount=type=secret,id=mysecret` reads the
        // file at /run/secrets/mysecret during build only.
        buildSecrets: {
          mysecret: cdk.DockerBuildSecret.fromSrc('secret.txt'),
        },
      }),
      environment: {
        GREETING: 'hello-buildkit',
      },
      timeout: cdk.Duration.seconds(10),
    });
  }
}
