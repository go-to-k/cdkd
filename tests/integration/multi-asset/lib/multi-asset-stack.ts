import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Multi-asset stress fixture stack.
 *
 * Where `docker-image-asset` exercises the ECR build+push path in isolation
 * and `s3-asset-deploy` exercises the S3 zip/file path in isolation, THIS
 * fixture forces MANY assets of TWO kinds to publish concurrently in ONE
 * `cdkd deploy` — stressing the asset-publishing layer's concurrency and the
 * interleaving of the two publishers:
 *
 *   - 1 Docker image asset  -> `DockerAssetPublisher` (`docker build` +
 *     ECR auth + `docker push` to the CDK-managed container-assets repo).
 *   - 3 distinct multi-file directory assets (one per zip Lambda) ->
 *     `FileAssetPublisher` (zip + upload, content-addressed skip-if-exists),
 *     each a DISTINCT S3 object (distinct content -> distinct asset hash).
 *   - 1 generic `s3_assets.Asset` -> a 4th `FileAssetPublisher` S3 upload,
 *     wired into one zip Lambda via env (bucket/key intrinsic resolution).
 *
 * So a single deploy publishes 1 ECR image + 4 S3 objects, exercising
 * FileAssetPublisher + DockerAssetPublisher concurrency, ECR + S3 in one
 * run, and asset-ref intrinsics (the generic asset's resolved
 * `s3BucketName`/`s3ObjectKey`).
 *
 * Each Lambda returns a DISTINCT marker baked into ITS OWN asset directory.
 * The integ invokes every Lambda and asserts its expected marker — so a
 * cross-wired asset (e.g. the beta dir uploaded but the alpha Lambda pointed
 * at it) would return the WRONG marker and FAIL the test. That is the
 * load-bearing proof that each distinct asset uploaded AND each Lambda's
 * Code S3 ref was wired to the correct object.
 *
 * No VPC — kept cheap (4 Lambdas + roles + 5 asset publishes, 1 ECR + 4 S3).
 */
export class MultiAssetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---- Docker image asset (ECR build+push) -------------------------------
    // PIN the build platform AND the Lambda architecture to ARM_64, matching,
    // to avoid the cross-arch `Runtime.InvalidEntrypoint: ProcessSpawnFailed`
    // trap on Apple-Silicon hosts (see docker-image-asset fixture for the full
    // rationale): a default DockerImageFunction emits NO source.platform / NO
    // Architectures, so cdkd builds for the HOST arch and pushes an arm64 image
    // to an x86_64 Lambda. Pinning LINUX_ARM64 + ARM_64 keeps them matched on
    // any host. The `public.ecr.aws/lambda/nodejs:20` base image is multi-arch.
    const dockerFn = new lambda.DockerImageFunction(this, 'DockerHandler', {
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

    // ---- Generic s3_assets.Asset (a 4th S3 upload, read back at runtime) ----
    // Not Lambda code: cdkd zips ../asset-data and uploads it to the bootstrap
    // asset bucket; the ALPHA zip Lambda reads it back via the resolved
    // bucket/key env vars (asset-ref intrinsic resolution).
    const configAsset = new s3assets.Asset(this, 'ConfigAsset', {
      path: path.join(__dirname, '../asset-data'),
    });

    // ---- 3 distinct multi-file directory assets (zip Lambdas) --------------
    // Each Lambda's code comes from a DISTINCT local directory, so each is a
    // DISTINCT S3 object (distinct content -> distinct content-addressed hash).
    // The ALPHA Lambda additionally consumes the generic asset via env, so its
    // handler reads the config back; beta/gamma just return their own marker.
    const alphaFn = new lambda.Function(this, 'AlphaHandler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-alpha')),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        // Resolved at deploy time by cdkd's intrinsic resolver from the
        // generic asset's CFn parameters (Fn::Sub-backed bucket + literal key).
        CONFIG_BUCKET: configAsset.s3BucketName,
        CONFIG_KEY: configAsset.s3ObjectKey,
      },
    });
    configAsset.grantRead(alphaFn);

    const betaFn = new lambda.Function(this, 'BetaHandler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-beta')),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
    });

    const gammaFn = new lambda.Function(this, 'GammaHandler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-gamma')),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
    });

    new cdk.CfnOutput(this, 'DockerFunctionName', { value: dockerFn.functionName });
    new cdk.CfnOutput(this, 'AlphaFunctionName', { value: alphaFn.functionName });
    new cdk.CfnOutput(this, 'BetaFunctionName', { value: betaFn.functionName });
    new cdk.CfnOutput(this, 'GammaFunctionName', { value: gammaFn.functionName });
    new cdk.CfnOutput(this, 'ConfigBucket', { value: configAsset.s3BucketName });
    new cdk.CfnOutput(this, 'ConfigKey', { value: configAsset.s3ObjectKey });
  }
}
