import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * NodejsFunction (esbuild-bundled TypeScript Lambda) stack.
 *
 * `NodejsFunction` is one of the most common ways to ship a Lambda in CDK: it
 * runs esbuild at synth time to bundle a TS entry into a single JS file, then
 * cdkd must publish that bundled asset to the bootstrap bucket and wire the
 * function's Code.S3Bucket / Code.S3Key. No existing fixture covers it (others
 * use inline code or `Code.fromAsset` on a pre-built directory). verify.sh
 * invokes the function and asserts the bundled handler actually ran.
 *
 * covers: AWS::Lambda::Function
 */
export class NodejsFunctionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const fn = new NodejsFunction(this, 'Fn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      bundling: { minify: false },
    });

    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
  }
}
