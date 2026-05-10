import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Fixture stack for `cdkd local invoke` container-Lambda integ test (PR 5).
 *
 * Single Lambda — `EchoHandler` — built from a local Dockerfile in
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
 */
export class LocalInvokeContainerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.DockerImageFunction(this, 'EchoHandler', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../docker')),
      environment: {
        GREETING: 'hello',
      },
      timeout: cdk.Duration.seconds(10),
    });
  }
}
