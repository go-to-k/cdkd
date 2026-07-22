import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Whole-field removal reset (issue #1155).
 *
 * `UpdateFunctionConfiguration` treats an absent field as "no change", so a
 * template that drops a previously-set config field must send the CFn-default
 * reset value or AWS silently keeps the old one — while the deploy reports
 * success and state drops the field, baking in invisible drift. cdkd
 * previously passed Timeout / MemorySize / Description / Environment / Layers /
 * TracingConfig / EphemeralStorage straight through as `undefined` on update.
 * This fixture removes six of them on UPDATE and asserts AWS reverted each to
 * its CloudFormation default.
 *
 *   covers: AWS::Lambda::Function
 *
 * Phase 1 sets Timeout 30 / MemorySize 256 / Description / env {FOO} /
 * EphemeralStorage 1024 / Tracing ACTIVE; Phase 2 (CDKD_TEST_UPDATE=true)
 * sets none of them.
 */
export class LambdaConfigFieldRemovalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const update = process.env.CDKD_TEST_UPDATE === 'true';

    new lambda.Function(this, 'Fn', {
      functionName: `${this.stackName}-fn`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
      ...(update
        ? {}
        : {
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            description: 'before removal',
            environment: { FOO: 'bar' },
            ephemeralStorageSize: cdk.Size.mebibytes(1024),
            tracing: lambda.Tracing.ACTIVE,
          }),
    });
  }
}
