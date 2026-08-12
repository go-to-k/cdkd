import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

/**
 * Import leg for issue 1652 — kept in its own stack because it is the ONLY
 * one deployed by the UPSTREAM `cdk deploy` before cdkd adopts it.
 *
 * `s3deploy.BucketDeployment` is the canonical shape of the bug: its
 * `Source.asset()` bind calls `asset.grantRead(handlerRole)`, so the
 * synthesized template carries BOTH
 *
 *   - a `Custom::CDKBucketDeployment` whose `SourceBucketNames` is the asset
 *     bucket, and
 *   - an `AWS::IAM::Policy` on the handler role whose `Resource` is the asset
 *     bucket ARN (rendered as an `Fn::Join` over `cdk-<qualifier>-assets-`
 *     plus the AccountId / Region pseudo-parameters).
 *
 * `IAMPolicyProvider.import()` returns only a physical id — it never reads
 * the live policy document — so nothing pulls the AWS-side value into state.
 * Before issue 1652 the import baked the REWRITTEN (cdkd) bucket into
 * `state.properties`, the deploy diff compared rewritten-against-rewritten,
 * classified NO_CHANGE, and the live grant kept naming the CDK bootstrap
 * bucket forever while the custom resource read from the cdkd bucket — a
 * runtime AccessDenied waiting to happen.
 *
 * Deliberately NO `autoDeleteObjects`: it would add a second custom resource,
 * a second role + policy and an `AWS::S3::BucketPolicy` to the import surface
 * without testing anything this fixture is about — and the second
 * `AWS::IAM::Policy` would break verify.sh's single-policy lookup, which is
 * how the fixture finds the grant under test.
 *
 * The consequence is that `verify.sh` MUST empty the bucket itself before the
 * destroy. cdkd deliberately does NOT auto-empty a non-empty bucket without
 * that opt-in — it surfaces AWS's not-empty error the way CloudFormation's
 * DELETE_FAILED does (the issue #1340 data guard,
 * `s3-bucket-provider.ts:3204`) — and `BucketDeployment` is precisely what
 * puts an object in here.
 */
export class AssetMigrationImportStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'SiteBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new s3deploy.BucketDeployment(this, 'DeployAssets', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../site'))],
      destinationBucket: bucket,
    });

    new cdk.CfnOutput(this, 'SiteBucketName', { value: bucket.bucketName });
  }
}
