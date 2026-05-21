import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for the BuildKit-Dockerfile regression integ test.
 *
 * `BuildkitHandler` is built from a Dockerfile that uses **BuildKit-only**
 * features (heredocs via `RUN <<EOF`, `RUN --mount=type=cache`, etc.) AND
 * declares `# syntax=docker/dockerfile:1`. Before this PR, cdkd ran
 * `docker build` via `execFile` with a 50 MB `maxBuffer` cap, and the
 * Dockerfile frontend pull + BuildKit progress output for the heredoc /
 * --mount=type=cache features ran past that cap on some hosts — silently
 * killing the build with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. CDK CLI
 * worked fine on the same Dockerfile because it uses streaming `spawn`
 * without a maxBuffer ceiling.
 *
 * Post-PR, cdkd routes the build through `runDockerStreaming` (spawn-based)
 * and sets `BUILDX_NO_DEFAULT_ATTESTATIONS=1` to match CDK CLI.
 */
export class LocalInvokeBuildkitStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.DockerImageFunction(this, 'BuildkitHandler', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../docker')),
      environment: {
        GREETING: 'hello-buildkit',
      },
      timeout: cdk.Duration.seconds(10),
    });
  }
}
