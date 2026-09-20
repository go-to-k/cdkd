import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Issue #2854 — a template parameter bound to its placeholder `Default` while
 * the DEPLOYED value was a secret reference.
 *
 * `cdkd import` takes no parameter values, so every parameter below is recorded
 * at its `Default`. verify.sh deploys this app through upstream `cdk deploy`
 * with `--parameters DbPassword='{{resolve:secretsmanager:...}}'` (and the same
 * for `ApiToken`), so the SSM parameters AWS holds carry the DECRYPTED secret
 * while no template `cdkd import` reads spells a reference anywhere. Before the
 * fix the readback was persisted as `observedProperties`, in the clear.
 *
 * Shape:
 *  - ROOT: `DbPassword` (NoEcho — `DescribeStacks` answers `****`), `ApiToken`
 *    (NOT NoEcho — the parameter whose `DescribeStacks` SHAPE verify.sh
 *    classifies and prints, never its value) and `Stage`, deployed AT its
 *    `Default`: the negative control that must KEEP its baseline.
 *  - CHILD (nested stack): `ChildPw` (NoEcho) and `ChildToken`, both supplied
 *    by the parent as the literal reference — the issue's headline shape:
 *    `Parent Stack.Properties.Parameters: { ChildPw: '{{resolve:...}}' }`.
 *
 * `ssm.CfnParameter` (L1) rather than `StringParameter`: the value must be a
 * bare `{Ref: <Parameter>}`, and the logical ids are pinned for verify.sh.
 *
 * REDEPLOY ARM (issue #3462): `SecretEnvFn` carries `DbPassword` in an
 * environment variable, and `CDKD_TEST_UPDATE=true` changes ONLY its inline
 * code. cdkd's Lambda provider sends `UpdateFunctionCode` alone for that, so
 * the variable AWS holds stays the DECRYPTED value through the `cdkd deploy`
 * that follows the import — the one shape where a post-UPDATE readback,
 * positioned against the placeholder `Default`, would persist the secret. An
 * SSM parameter cannot carry this arm: its update always rewrites `Value`, which
 * overwrites the secret with the placeholder and leaves nothing to leak.
 *
 * The secret itself is created by verify.sh BEFORE the deploy, under the fixed
 * name below, because the reference has to be spelled at synth time.
 */
export const SECRET_NAME = 'cdkd-integ-2854-deployed-parameter';
export const SECRET_REFERENCE = `{{resolve:secretsmanager:${SECRET_NAME}:SecretString:pw}}`;

class ChildStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: cdk.NestedStackProps) {
    super(scope, id, props);
    const childPw = new cdk.CfnParameter(this, 'ChildPw', {
      type: 'String',
      default: 'CHANGEME-child',
      noEcho: true,
    });
    const childToken = new cdk.CfnParameter(this, 'ChildToken', {
      type: 'String',
      default: 'CHANGEME-child-token',
    });
    new ssm.CfnParameter(this, 'ChildPwParam', {
      type: 'String',
      value: childPw.valueAsString,
    }).overrideLogicalId('ChildPwParam');
    new ssm.CfnParameter(this, 'ChildTokenParam', {
      type: 'String',
      value: childToken.valueAsString,
    }).overrideLogicalId('ChildTokenParam');
  }
}

export class ImportDeployedParameterSecretStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const dbPassword = new cdk.CfnParameter(this, 'DbPassword', {
      type: 'String',
      default: 'CHANGEME-root',
      noEcho: true,
    });
    const apiToken = new cdk.CfnParameter(this, 'ApiToken', {
      type: 'String',
      default: 'CHANGEME-root-token',
    });
    const stage = new cdk.CfnParameter(this, 'Stage', { type: 'String', default: 'dev' });

    new ssm.CfnParameter(this, 'RootPwParam', {
      type: 'String',
      value: dbPassword.valueAsString,
    }).overrideLogicalId('RootPwParam');
    new ssm.CfnParameter(this, 'RootTokenParam', {
      type: 'String',
      value: apiToken.valueAsString,
    }).overrideLogicalId('RootTokenParam');
    new ssm.CfnParameter(this, 'RootStageParam', {
      type: 'String',
      value: cdk.Fn.join('-', ['stage', stage.valueAsString]),
    }).overrideLogicalId('RootStageParam');

    const fnRole = new iam.CfnRole(this, 'SecretEnvFnRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
    });
    const codeRevision = process.env.CDKD_TEST_UPDATE === 'true' ? 'after' : 'before';
    new lambda.CfnFunction(this, 'SecretEnvFn', {
      runtime: 'nodejs22.x',
      handler: 'index.handler',
      role: fnRole.attrArn,
      code: { zipFile: `exports.handler = async () => '${codeRevision}';` },
      environment: { variables: { DB_PASSWORD: dbPassword.valueAsString } },
    });

    const child = new ChildStack(this, 'Child', {
      parameters: { ChildPw: SECRET_REFERENCE, ChildToken: SECRET_REFERENCE },
    });
    if (child.nestedStackResource) {
      (child.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');
    }
  }
}
