import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * S3 asset-publishing fixture stack.
 *
 * Exercises cdkd's asset layer (`FileAssetPublisher`) end-to-end during a
 * real `cdkd deploy`. Two distinct asset paths are covered:
 *
 *   1. Lambda code from a LOCAL DIRECTORY (`lambda.Code.fromAsset('../lambda')`).
 *      The directory holds several files (handler + a vendored helper module
 *      + a few padding modules) so the synthesized asset is a real multi-file
 *      ZIP — not inline `Code.fromInline` — forcing cdkd to zip the directory
 *      and upload it to the CDK bootstrap asset bucket, then wire the Lambda's
 *      `Code.S3Bucket` / `Code.S3Key` to the uploaded object. This is the path
 *      most existing lambda fixtures skip (they use inline / single-file code,
 *      or never assert the upload itself).
 *
 *   2. A GENERIC `s3_assets.Asset` (`../asset-data`, a small config dir) that
 *      is NOT Lambda code. cdkd must zip + upload it to the same bootstrap
 *      bucket, and its resolved `s3ObjectKey` / `s3BucketName` are threaded
 *      into the Lambda as env vars. At runtime the Lambda downloads that
 *      object via the SDK and returns its parsed contents — proving the
 *      generic-asset upload reached AWS AND that the intrinsic-resolved
 *      bucket/key references were wired correctly through cdkd's deploy.
 *
 * No VPC — kept cheap (just a Lambda + IAM role + 2 asset uploads).
 */
export class S3AssetDeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // A generic (non-Lambda-code) S3 asset. cdkd zips ../asset-data and
    // uploads it to the bootstrap asset bucket; the Lambda reads it back.
    const configAsset = new s3assets.Asset(this, 'ConfigAsset', {
      path: path.join(__dirname, '../asset-data'),
    });

    // Lambda whose code comes from a LOCAL multi-file directory asset.
    const fn = new lambda.Function(this, 'AssetHandler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        // Resolved at deploy time by cdkd's intrinsic resolver from the
        // generic asset's CFn parameters / Fn::Sub-backed attributes.
        CONFIG_BUCKET: configAsset.s3BucketName,
        CONFIG_KEY: configAsset.s3ObjectKey,
      },
    });

    // The Lambda needs read access to the generic asset object.
    configAsset.grantRead(fn);

    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
    });
    new cdk.CfnOutput(this, 'ConfigBucket', {
      value: configAsset.s3BucketName,
    });
    new cdk.CfnOutput(this, 'ConfigKey', {
      value: configAsset.s3ObjectKey,
    });
  }
}
