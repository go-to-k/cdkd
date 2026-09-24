import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Integ probe for `cdkd import --migrate-from-cloudformation` recording the
 * `AWS::Lambda::Url` attributes (issue #3624).
 *
 * `LambdaUrlProvider.import()` used to return `attributes: {}`, and neither
 * `FunctionUrl` nor `FunctionArn` can be built from the physical id, so a
 * sibling's `Fn::GetAtt [<Url>, FunctionUrl]` stayed a raw intrinsic in its
 * imported record. The reporter's shape is a CloudFront `FunctionUrlOrigin`;
 * an SSM parameter carries the same `Fn::GetAtt` at a fraction of CloudFront's
 * deploy / delete time, and the resolver path is the same for any consumer.
 *
 * `UrlParam` reads `FunctionUrl` (the refused `*Url` shape), `ArnParam` reads
 * `FunctionArn` (the warn-and-return "Unknown attribute" shape).
 */
export class ImportLambdaUrlAttributesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline('def handler(event, context):\n    return {"statusCode": 200}\n'),
    });
    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    (url.node.defaultChild as cdk.CfnResource).overrideLogicalId('Url');

    const urlParam = new ssm.StringParameter(this, 'UrlParam', { stringValue: url.url });
    (urlParam.node.defaultChild as cdk.CfnResource).overrideLogicalId('UrlParam');
    const arnParam = new ssm.StringParameter(this, 'ArnParam', { stringValue: url.functionArn });
    (arnParam.node.defaultChild as cdk.CfnResource).overrideLogicalId('ArnParam');
  }
}
