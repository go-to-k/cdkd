import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2int from 'aws-cdk-lib/aws-apigatewayv2-integrations';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for the `cdkd local start-api` container-Lambda integ
 * test (closes #453).
 *
 * HTTP API v2 whose GET / route is backed by a
 * `lambda.DockerImageFunction` built from a local Dockerfile under
 * `docker/`. The Dockerfile starts FROM the AWS Lambda Node.js base
 * image (which bundles RIE) and copies a tiny `app.js` into
 * `${LAMBDA_TASK_ROOT}` with `CMD ["app.handler"]` — same shape as the
 * `local-invoke-container` fixture, exercised here through the
 * `cdkd local start-api` HTTP server instead of a one-shot invoke.
 *
 * No AWS deploy required. The integ exercises end-to-end:
 *   1. `cdkd local start-api` discovers the HTTP API v2 route + the
 *      backing container Lambda.
 *   2. The container-pool's IMAGE branch (PR closing #453) runs
 *      `docker build` against the asset entry, NO bind-mount at
 *      /var/task, `--platform linux/amd64` threaded through.
 *   3. A `curl http://127.0.0.1:<port>/` against the HTTP server
 *      reaches the container Lambda via RIE and the JSON response
 *      includes the `fromContainer: true` marker the app.js emits.
 *   4. GET /non-aws (#6018) reaches a function on a non-AWS base image with
 *      no RIE of its own, through the RIE cdkd mounts.
 */
export class LocalStartApiContainerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const fn = new lambda.DockerImageFunction(this, 'EchoHandler', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../docker')),
      environment: {
        GREETING: 'hello',
      },
      timeout: cdk.Duration.seconds(10),
    });

    const api = new apigwv2.HttpApi(this, 'Api');
    api.addRoutes({
      path: '/',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2int.HttpLambdaIntegration('EchoIntegration', fn),
    });

    // go-to-k/cdkd#6018: a function on a NON-AWS base image (no Runtime
    // Interface Emulator of its own) behind GET /non-aws. Built for the
    // HOST's architecture so nothing runs under emulation.
    const nonAws = new lambda.DockerImageFunction(this, 'NonAwsBaseHandler', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../docker-non-aws')),
      architecture: process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64,
      environment: {
        GREETING: 'from-non-aws-base',
      },
      timeout: cdk.Duration.seconds(10),
    });
    api.addRoutes({
      path: '/non-aws',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2int.HttpLambdaIntegration('NonAwsIntegration', nonAws),
    });
  }
}
