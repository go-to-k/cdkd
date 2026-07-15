import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import type { Construct } from 'constructs';

/**
 * Fixture for the issue #1002 PR 2 migration integ
 * (tests/integration/asset-migration/verify.sh).
 *
 * Covers every asset-reference shape the §6/§7 redirection must repoint:
 * - a Lambda ZIP asset (`Code.S3Bucket` / `Code.S3Key`) on the parent stack;
 * - an `s3_assets.Asset` whose S3 URL lands in a Lambda env var (`Fn::Sub`
 *   over the bootstrap bucket name — the runtime-read shape from design
 *   §1.2 that breaks immediately when `cdk gc` deletes the object);
 * - a nested stack child carrying its OWN Lambda ZIP asset (nested child
 *   templates are a separate parse path — design §7);
 * - (separate stack) a Docker image asset (`Code.ImageUri` → the
 *   cdkd-container-assets ECR repo).
 */
export class AssetMigrationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const dataAsset = new s3_assets.Asset(this, 'DataAsset', {
      path: 'lambda/data.json',
    });

    new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda'),
      environment: {
        // Renders as an Fn::Sub/Fn::Join over the bootstrap bucket name —
        // the rewrite must repoint it to the cdkd asset bucket.
        DATA_ASSET_URL: dataAsset.s3ObjectUrl,
      },
    });

    const child = new cdk.NestedStack(this, 'Child');
    new lambda.Function(child, 'ChildHandler', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('child-lambda'),
    });
  }
}

/**
 * Docker-image leg, kept in its own stack so verify.sh can skip it when the
 * runner has no Docker daemon. The image asset exercises the
 * `cdk-<qualifier>-container-assets-…` → `cdkd-container-assets-…`
 * redirection + `Code.ImageUri` rewrite end-to-end (Lambda pulls the image
 * from the cdkd-owned ECR repo at create time, so a broken redirect fails
 * loudly).
 */
export class AssetMigrationImageStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new lambda.DockerImageFunction(this, 'ImageHandler', {
      code: lambda.DockerImageCode.fromImageAsset('image'),
    });
  }
}
