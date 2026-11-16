import * as cdk from 'aws-cdk-lib';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#6395: a nested stack template's own `Transform` was never
 * expanded, so a `cdk.NestedStack` child was deployed raw.
 *
 * `NestedSamTransformStack`: the child declares the SAM transform and one
 * `AWS::Serverless::Function`, which the transform turns into a Lambda
 * function and its role. `CDKD_TEST_UPDATE=true` changes the function's
 * environment, an in-place update of the expanded function.
 *
 * `NestedHostedRotationStack`: the child holds a HostedRotation. Its
 * `AWS::SecretsManager-2024-09-16` transform expands the rotation into a
 * remote-TemplateURL grandchild, which cdkd refuses before anything is
 * created (#6385) instead of failing on the raw rotation mid-deploy.
 */
export class NestedSamTransformStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const child = new cdk.NestedStack(this, 'Child');
    child.templateOptions.transforms = ['AWS::Serverless-2016-10-31'];
    const fn = new cdk.CfnResource(child, 'Fn', {
      type: 'AWS::Serverless::Function',
      properties: {
        Runtime: 'nodejs22.x',
        Handler: 'index.handler',
        InlineCode: 'exports.handler = async () => ({ mark: process.env.MARK });',
        Environment: {
          Variables: { MARK: process.env.CDKD_TEST_UPDATE === 'true' ? 'v2' : 'v1' },
        },
      },
    });
    // A parent reference to a child token: CDK emits the child Output and the
    // parent's `Fn::GetAtt <row>.Outputs.<id>`.
    new cdk.CfnOutput(this, 'FunctionName', { value: fn.ref });
  }
}

export class NestedHostedRotationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const child = new cdk.NestedStack(this, 'Child');
    const secret = new sm.Secret(child, 'Secret', {
      secretName: `cdkd-integ-nested-transform-rot-${cdk.Aws.REGION}`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'u' }),
        generateStringKey: 'password',
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    secret.addRotationSchedule('Rotation', {
      hostedRotation: sm.HostedRotation.mysqlSingleUser(),
      rotateImmediatelyOnUpdate: false,
    });
  }
}
