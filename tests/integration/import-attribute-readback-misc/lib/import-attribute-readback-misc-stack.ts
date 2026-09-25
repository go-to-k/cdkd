import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Integ probe for `cdkd import --migrate-from-cloudformation` recording the
 * attribute maps `create()` records (issue #3627), third batch. Before the fix
 * each resolved wrong after an import:
 *
 * - SSM Parameter `Type` / `Value` → the parameter NAME;
 * - IAM InstanceProfile / User / Group `Arn` under a non-`/` `Path` → a
 *   path-less ARN the resolver builds from the name, silently;
 * - AgentCore Evaluator `Status` / `CreatedAt` → the evaluator ARN.
 *
 * One SSM parameter per attribute carries the `Fn::GetAtt`.
 */
export class ImportAttributeReadbackMiscStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pin = (c: cdk.CfnResource, logicalId: string) => c.overrideLogicalId(logicalId);
    const param = (logicalId: string, value: string) => {
      const p = new ssm.StringParameter(this, logicalId, { stringValue: value });
      pin(p.node.defaultChild as cdk.CfnResource, logicalId);
    };

    const source = new ssm.CfnParameter(this, 'Source', {
      type: 'StringList',
      value: 'alpha,beta',
    });
    pin(source, 'Source');
    param('SourceTypeParam', source.attrType);
    param('SourceValueParam', source.attrValue);

    const role = new iam.Role(this, 'ProfileRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    const profile = new iam.CfnInstanceProfile(this, 'Profile', {
      path: '/cdkd-integ/',
      roles: [role.roleName],
    });
    pin(profile, 'Profile');
    param('ProfileArnParam', profile.attrArn);

    const user = new iam.CfnUser(this, 'User', { path: '/cdkd-integ/' });
    pin(user, 'User');
    param('UserArnParam', user.attrArn);

    const group = new iam.CfnGroup(this, 'Group', { path: '/cdkd-integ/' });
    pin(group, 'Group');
    param('GroupArnParam', group.attrArn);

    // The code-based evaluator from `agentcore-tools` (no Bedrock
    // model-access dependency).
    const evalFnRole = new iam.Role(this, 'EvalFnRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    const evalFn = new lambda.Function(this, 'EvalFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: evalFnRole,
      code: lambda.Code.fromInline(
        'exports.handler = async () => ({ score: 1, explanation: "cdkd integ evaluator" });'
      ),
    });
    const evaluator = new cdk.CfnResource(this, 'Evaluator', {
      type: 'AWS::BedrockAgentCore::Evaluator',
      properties: {
        EvaluatorName: 'cdkd_integ_import_readback_evaluator',
        Level: 'TRACE',
        EvaluatorConfig: {
          CodeBased: {
            LambdaConfig: { LambdaArn: evalFn.functionArn, LambdaTimeoutInSeconds: 60 },
          },
        },
      },
    });
    pin(evaluator, 'Evaluator');
    param('EvalStatusParam', evaluator.getAtt('Status').toString());
    param('EvalCreatedAtParam', evaluator.getAtt('CreatedAt').toString());
  }
}
