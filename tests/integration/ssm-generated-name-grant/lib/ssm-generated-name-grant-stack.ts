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
 * covers: AWS::SSM::Parameter
 * covers: AWS::Lambda::Function
 * covers: AWS::IAM::Role
 * covers: AWS::IAM::Policy
 */
export class SsmGeneratedNameGrantStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const param = new ssm.StringParameter(this, 'Param', {
      stringValue: 'cdkd-6272-value',
    });

    const fn = new lambda.Function(this, 'Reader', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        [
          "const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');",
          'exports.handler = async () => {',
          '  try {',
          '    const r = await new SSMClient({}).send(new GetParameterCommand({ Name: process.env.PARAM_NAME }));',
          '    return { ok: r.Parameter.Value };',
          '  } catch (e) {',
          '    return { err: e.name, msg: e.message };',
          '  }',
          '};',
        ].join('\n')
      ),
      environment: { PARAM_NAME: param.parameterName },
    });
    param.grantRead(fn);

    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'ParameterName', { value: param.parameterName });
  }
}
