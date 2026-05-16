import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Verifies cdkd's `DeletionPolicy: Retain` skip-on-destroy behavior.
 *
 * Two SSM Parameters with explicit physical names (so the assert step
 * can look them up post-destroy without going through cdkd state):
 *
 *   - RetainParam: `RemovalPolicy.RETAIN` → CDK synth emits
 *     `DeletionPolicy: Retain` + `UpdateReplacePolicy: Retain`. cdkd
 *     destroy must SKIP this resource and leave it on AWS.
 *   - DestroyParam: `RemovalPolicy.DESTROY` (default for SSM, but
 *     explicit for clarity) → cdkd destroy issues the actual delete.
 *
 * verify.sh deploys, destroys via `cdkd destroy --force`, and asserts
 * RetainParam still exists in SSM while DestroyParam is gone. The
 * verify trap manually deletes RetainParam at the end so the test
 * leaves AWS clean.
 *
 * The fixture is intentionally minimal (no VPC, no Lambda, no Custom
 * Resources) so the assertion isolates the Retain-skip behavior from
 * any other destroy-path code (no Cascade, no implicit-delete deps).
 */
export class DeletionPolicyRetainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // covers: AWS::SSM::Parameter
    const retainParam = new ssm.StringParameter(this, 'RetainParam', {
      parameterName: '/cdkd-integ/deletion-policy-retain/retain',
      stringValue: 'this-parameter-must-survive-cdkd-destroy',
      description: 'Carries RemovalPolicy.RETAIN; cdkd destroy must skip it.',
    });
    retainParam.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    const destroyParam = new ssm.StringParameter(this, 'DestroyParam', {
      parameterName: '/cdkd-integ/deletion-policy-retain/destroy',
      stringValue: 'this-parameter-must-be-deleted-on-cdkd-destroy',
      description: 'Carries RemovalPolicy.DESTROY; cdkd destroy must delete it.',
    });
    destroyParam.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'RetainParamName', {
      value: retainParam.parameterName,
      description: 'SSM parameter name for the Retain-policy resource (for verify.sh assertions).',
    });
    new cdk.CfnOutput(this, 'DestroyParamName', {
      value: destroyParam.parameterName,
      description: 'SSM parameter name for the Destroy-policy resource (for verify.sh assertions).',
    });
  }
}
