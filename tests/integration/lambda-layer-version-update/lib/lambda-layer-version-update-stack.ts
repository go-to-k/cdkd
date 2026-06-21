import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
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
 */
export class LambdaLayerVersionUpdateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Materialize the layer asset content on the fly so Phase 1 and Phase 2
    // produce different asset hashes (driving the replacement).
    const version = process.env.CDKD_TEST_UPDATE === 'true' ? 'v2' : 'v1';
    const layerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdkd-integ-layer-'));
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

    new cdk.CfnOutput(this, 'FnName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'LayerArn', { value: layer.layerVersionArn });
  }
}
