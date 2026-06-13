import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';

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

    // PIN the build platform AND the Lambda architecture to ARM_64, and keep
    // them MATCHING. This is load-bearing, not cosmetic:
    //
    //   - A default `DockerImageFunction` synthesizes NO `source.platform` in
    //     the asset manifest and NO `Architectures` on the Lambda template (so
    //     the function defaults to x86_64). cdkd honors `source.platform` when
    //     the manifest carries it, but when it is ABSENT cdkd builds the image
    //     for the HOST architecture. On an arm64 host (Apple Silicon) that
    //     produces an arm64 image pushed to an x86_64 Lambda, which fails at
    //     invoke with `Runtime.InvalidEntrypoint: ProcessSpawnFailed` — the
    //     exact cross-arch trap CDK CLI users hit on Mac.
    //   - Pinning `platform: LINUX_ARM64` makes CDK emit `source.platform:
    //     "linux/arm64"` so cdkd builds the correct arch regardless of host,
    //     and `architecture: ARM_64` emits `Architectures: ["arm64"]` so the
    //     pushed image arch matches the Lambda runtime arch. ARM_64 (over
    //     AMD64) avoids buildx/qemu cross-emulation on this arm64 dev/CI host.
    //
    // The `public.ecr.aws/lambda/nodejs:20` base image is multi-arch, so it
    // resolves to the arm64 variant cleanly.
    const fn = new lambda.DockerImageFunction(this, 'DockerHandler', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../docker'), {
        platform: ecr_assets.Platform.LINUX_ARM64,
      }),
      architecture: lambda.Architecture.ARM_64,
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
