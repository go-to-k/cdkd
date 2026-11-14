import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#6272: an SSM parameter WITHOUT `parameterName` read by a
 * function through `grantRead`.
 *
 * CDK builds an auto-named parameter's ARN as `arn:...:parameter/` + Ref,
 * assuming the slash-less name CloudFormation generates. cdkd generated
 * `/<name>`, so the grant named `parameter//<name>` and the function's
 * GetParameter was denied. The handler returns the error instead of throwing,
 * so verify.sh can tell AccessDenied from a read.
 *
 * go-to-k/cdkd#6274: verify.sh deploys this first with the last release that
 * still named it `/<name>`, then redeploys with this build, which re-spells
 * the record `<name>` and updates the grant and PARAM_NAME to match.
 *
 * go-to-k/cdkd#6282: the same pair inside a nested stack. The redeploy changes
 * nothing in the nested template, so only the parent's one-time check of its
 * nested children runs the child's deploy that re-spells it.
 *
 * covers: AWS::SSM::Parameter
 * covers: AWS::Lambda::Function
 * covers: AWS::IAM::Role
 * covers: AWS::IAM::Policy
 * covers: AWS::CloudFormation::Stack
 */
const HANDLER = [
  "const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');",
  'exports.handler = async () => {',
  '  try {',
  '    const r = await new SSMClient({}).send(new GetParameterCommand({ Name: process.env.PARAM_NAME }));',
  '    return { ok: r.Parameter.Value };',
  '  } catch (e) {',
  '    return { err: e.name, msg: e.message };',
  '  }',
  '};',
].join('\n');

/** An auto-named parameter, and a function reading it through `grantRead`. */
function addReader(scope: Construct, value: string): { fn: lambda.Function; param: ssm.StringParameter } {
  const param = new ssm.StringParameter(scope, 'Param', { stringValue: value });
  const fn = new lambda.Function(scope, 'Reader', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline(HANDLER),
    environment: { PARAM_NAME: param.parameterName },
  });
  param.grantRead(fn);
  return { fn, param };
}

export class SsmGeneratedNameGrantStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const { fn, param } = addReader(this, 'cdkd-6272-value');
    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'ParameterName', { value: param.parameterName });

    // The nested pair reports through its own stack's outputs (the child
    // record), so the parent's template does not read the child.
    const nested = new cdk.NestedStack(this, 'Nested');
    const inner = addReader(nested, 'cdkd-6282-value');
    new cdk.CfnOutput(nested, 'FunctionName', { value: inner.fn.functionName });
    new cdk.CfnOutput(nested, 'ParameterName', { value: inner.param.parameterName });
  }
}
