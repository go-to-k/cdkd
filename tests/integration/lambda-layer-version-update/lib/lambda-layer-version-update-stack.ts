import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Integ probe for the Lambda LayerVersion content-change REPLACEMENT path.
 *
 * Phase 1 (no env): a LayerVersion built from a tiny asset whose content
 * encodes `v1`, consumed by a function that exports the layer's version.
 * Phase 2 (CDKD_TEST_UPDATE=true): the SAME logical LayerVersion is rebuilt
 * from `v2` content. A Lambda LayerVersion is fully immutable on AWS (no
 * UpdateLayerVersion API), so in CloudFormation EVERY property is "Update
 * requires: Replacement" and `cdk deploy` transparently publishes a new
 * version + re-points the consuming function. cdkd used to misclassify the
 * content change as an in-place update and hard-fail in the provider's
 * update() (suggesting a non-existent `--replace` flag), leaving the change
 * undeployable. The fix adds a replacement rule so the diff drives a
 * DELETE + CREATE and promoteReplacementDependents re-points the function at
 * the new layer version ARN.
 *
 * A fixed physical LayerName / FunctionName is set so verify.sh can assert
 * the published version count goes 1 -> 2 and the function follows to :2.
 *
 * Issue #5300 arm: `Content.S3ObjectStorageMode` / `Code.S3ObjectStorageMode`
 * (`REFERENCE`) used to be dropped from the SDK request, so AWS applied its
 * default `COPY`. `RefLayer` and `RefFn` ask for REFERENCE. Lambda accepts
 * that only for an object in a VERSIONED bucket whose policy lets the Lambda
 * service principal read it, which neither cdkd's asset bucket nor the CDK
 * bootstrap bucket is, so verify.sh creates such a bucket, uploads the zips
 * and passes its name in `CDKD_TEST_REF_BUCKET`. `Layer` and `CopyFn` stay at
 * the default and are the negative controls. Phase 2 points both REFERENCE
 * resources at new objects, so the second deploy carries the mode over a
 * layer replacement and over UpdateFunctionCode too. Phase 2.5 (both env
 * flags set) drops RefFn's mode together with a code change.
 */
export class LambdaLayerVersionUpdateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Materialize the layer asset content on the fly so Phase 1 and Phase 2
    // produce different asset hashes (driving the replacement).
    const version = process.env.CDKD_TEST_UPDATE === 'true' ? 'v2' : 'v1';
    // One temp root per synth; the layer and function assets are siblings in
    // it, so neither asset directory contains the other.
    const assetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdkd-integ-layer-'));
    const layerDir = path.join(assetRoot, 'layer');
    fs.mkdirSync(path.join(layerDir, 'nodejs'), { recursive: true });
    fs.writeFileSync(
      path.join(layerDir, 'nodejs', 'shared.js'),
      `module.exports = { version: '${version}' };\n`
    );

    const layer = new lambda.LayerVersion(this, 'Layer', {
      layerVersionName: 'cdkd-layer-version-update-test',
      code: lambda.Code.fromAsset(layerDir),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'Fn', {
      functionName: 'cdkd-layer-version-update-test-fn',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      layers: [layer],
      code: lambda.Code.fromInline(
        "const s = require('/opt/nodejs/shared.js'); exports.handler = async () => ({ v: s.version });"
      ),
    });

    const refBucketName = process.env.CDKD_TEST_REF_BUCKET;
    if (!refBucketName) {
      throw new Error('CDKD_TEST_REF_BUCKET is required; verify.sh creates the bucket and sets it');
    }
    const refBucket = s3.Bucket.fromBucketName(this, 'RefBucket', refBucketName);
    const refLayer = new lambda.LayerVersion(this, 'RefLayer', {
      layerVersionName: 'cdkd-layer-version-update-test-ref',
      code: lambda.Code.fromBucket(refBucket, `layer-${version}.zip`),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    (refLayer.node.defaultChild as lambda.CfnLayerVersion).addPropertyOverride(
      'Content.S3ObjectStorageMode',
      'REFERENCE'
    );

    const fnDir = path.join(assetRoot, 'fn');
    fs.mkdirSync(fnDir);
    fs.writeFileSync(
      path.join(fnDir, 'index.js'),
      `exports.handler = async () => ({ v: '${version}' });\n`
    );
    // Phase 2.5 (CDKD_TEST_REMOVAL=true, on top of CDKD_TEST_UPDATE): RefFn
    // drops S3ObjectStorageMode together with a code change. CloudFormation
    // stores the new package as a COPY then (measured A/B, 2026-10-26).
    const refFnRemoval = process.env.CDKD_TEST_REMOVAL === 'true';
    const refFn = new lambda.Function(this, 'RefFn', {
      functionName: 'cdkd-layer-version-update-test-ref-fn',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromBucket(refBucket, refFnRemoval ? 'fn-v3.zip' : `fn-${version}.zip`),
    });
    if (!refFnRemoval) {
      (refFn.node.defaultChild as lambda.CfnFunction).addPropertyOverride(
        'Code.S3ObjectStorageMode',
        'REFERENCE'
      );
    }
    new lambda.Function(this, 'CopyFn', {
      functionName: 'cdkd-layer-version-update-test-copy-fn',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(fnDir),
    });

    new cdk.CfnOutput(this, 'FnName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'LayerArn', { value: layer.layerVersionArn });
  }
}
