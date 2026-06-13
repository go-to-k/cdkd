import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for the `docker-image-asset` integ test.
 *
 * Unlike the LOCAL-emulation container fixtures (`local-invoke-container`
 * etc.) which never touch AWS, this fixture exercises cdkd's deploy-time
 * Docker ASSET pipeline against real AWS:
 *
 *   1. cdkd's asset layer (`DockerAssetPublisher`) runs `docker build` on the
 *      local `docker/` Dockerfile, authenticates to ECR, and `docker push`es
 *      the resulting image to the CDK-managed asset ECR repository
 *      (`cdk-hnb659fds-container-assets-{account}-{region}`) during deploy.
 *   2. cdkd then creates an `AWS::Lambda::Function` with `PackageType=Image`
 *      pointing at the pushed image (`Code.ImageUri`).
 *
 * The single `lambda.DockerImageFunction` is the cheapest reliable way to
 * force the build+push path: no VPC / NAT, a trivial public Lambda Node.js
 * base image, and a tiny handler. The integ invokes the function to prove
 * the pushed image actually runs, then destroys and asserts the ECR repo's
 * image is gone (cdkd's ECR provider force-deletes repos containing images).
 */
export class DockerImageAssetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const fn = new lambda.DockerImageFunction(this, 'DockerHandler', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../docker')),
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        DEPLOYED_BY: 'cdkd',
      },
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
      description: 'Docker image Lambda function name',
    });
  }
}
