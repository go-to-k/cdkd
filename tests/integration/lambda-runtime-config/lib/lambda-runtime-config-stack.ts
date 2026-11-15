import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * `AWS::Lambda::Function` `RuntimeConfig` on the SDK route (issue #6352).
 *
 *   covers: AWS::Lambda::Function
 *
 * The customer-managed runtime it names has no CloudFormation type, so
 * verify.sh creates it (runtime, version `v1` from an ECR image, aliases `a`
 * and `b`) before the first deploy and passes its ARN in. aws-cdk-lib's
 * `CfnFunction` does not model the property yet, hence the override.
 *
 * - default: Runtime `custom`, RuntimeConfig alias `a`.
 * - `CDKD_TEST_UPDATE=alias`: alias `b`, an in-place change.
 * - `CDKD_TEST_REMOVAL=true`: Runtime `nodejs22.x` and no RuntimeConfig, the
 *   only removal AWS accepts (a `custom` function without one is refused).
 */
export interface LambdaRuntimeConfigStackProps extends cdk.StackProps {
  readonly runtimeArn: string;
}

export class LambdaRuntimeConfigStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LambdaRuntimeConfigStackProps) {
    super(scope, id, props);

    const removal = process.env['CDKD_TEST_REMOVAL'] === 'true';
    const modes = (process.env['CDKD_TEST_UPDATE'] ?? '').split(',');
    const alias = modes.includes('alias') ? 'b' : 'a';

    const fn = new lambda.Function(this, 'Fn', {
      functionName: `${this.stackName}-fn`,
      runtime: removal
        ? lambda.Runtime.NODEJS_22_X
        : new lambda.Runtime('custom', lambda.RuntimeFamily.OTHER),
      handler: 'index.handler',
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset('lambda-code'),
    });
    if (!removal) {
      (fn.node.defaultChild as lambda.CfnFunction).addPropertyOverride('RuntimeConfig', {
        RuntimeArn: props.runtimeArn,
        RuntimeAlias: alias,
      });
    }
  }
}
