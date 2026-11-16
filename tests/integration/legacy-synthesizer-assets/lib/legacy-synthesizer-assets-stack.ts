import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A stack synthesized with `LegacyStackSynthesizer` (set in `bin/app.ts`)
 * carrying a directory asset (Lambda code) and a file asset
 * (`s3assets.Asset`) whose `s3ObjectUrl` reaches the Lambda's environment
 * (issue #6421). The synthesizer writes no asset manifest: each asset is an
 * `aws:cdk:asset` metadata entry, and the template declares
 * `AssetParameters<hash>S3Bucket…` / `…S3VersionKey…` / `…ArtifactHash…`
 * parameters with no default, which the deploying tool must supply.
 *
 * `CDKD_TEST_UPDATE=true` switches both assets to their v2 sources, so the
 * update phase publishes new objects under new keys and the Lambda must run
 * the new code and read the new file.
 *
 * covers: AWS::Lambda::Function
 */
export class LegacySynthesizerAssetsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const v = process.env.CDKD_TEST_UPDATE === 'true' ? 'v2' : 'v1';

    const data = new s3assets.Asset(this, 'Data', {
      path: path.join(__dirname, `../data/data-${v}.txt`),
    });

    const fn = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, `../lambda-${v}`)),
      timeout: cdk.Duration.seconds(30),
      environment: { DATA_URL: data.s3ObjectUrl },
    });
    data.grantRead(fn);

    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
  }
}
