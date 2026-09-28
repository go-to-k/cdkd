import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';

/**
 * Failure-seeking integ for go-to-k/cdkd#3952: a resource whose delete
 * ADDRESSES it through a recorded property that cdkd redacted.
 *
 * covers: AWS::ApiGatewayV2::Api
 * covers: AWS::ApiGatewayV2::Stage
 * covers: AWS::CloudFormation::CustomResource
 * covers: AWS::Lambda::Function
 *
 * Shape under test:
 *
 *   HttpApi (AWS::ApiGatewayV2::Api)
 *      |
 *      +--> ApiEcho (custom resource; its handler answers `NoEcho: true` and
 *      |              echoes the ApiId it was given into `Data.ApiId`)
 *      |
 *      +--> EchoedStage (AWS::ApiGatewayV2::Stage, ApiId =
 *                        Fn::GetAtt(ApiEcho, 'ApiId'))
 *
 * `ApiId` resolves to a `NoEcho` value, so it becomes a mask-only redaction
 * needle in the stage's record (issue #2274) and the stage's recorded `ApiId`
 * is `***`. Before #3952 the delete sent `DeleteStage(apiId: '***')`, AWS
 * answered NotFoundException, and the provider read that as "already deleted":
 * the record was dropped and the destroy exited 0 while the stage was live.
 *
 * `EchoedStage` exists only while `CDKD_TEST_UPDATE` names `redacted-stage`.
 * The final clean deploy / destroy omits it and starts from an orphaned,
 * empty stack, so omitting it drops nothing.
 */
export class RedactedDeleteAddressStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const withStage = (process.env.CDKD_TEST_UPDATE ?? '').split(',').includes('redacted-stage');

    const api = new apigwv2.CfnApi(this, 'HttpApi', {
      name: `${id}-api`,
      protocolType: 'HTTP',
    });

    // SIMPLE-HANDLER response shape (no `Status`), which cdkd re-synthesizes an
    // envelope for and must copy `NoEcho` across explicitly.
    const handler = new lambda.Function(this, 'EchoHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  console.log('CR event:', JSON.stringify(event));
  if (event.RequestType === 'Delete') {
    return { Status: 'SUCCESS', PhysicalResourceId: event.PhysicalResourceId || 'api-echo' };
  }
  return {
    PhysicalResourceId: 'api-echo',
    Data: { ApiId: (event.ResourceProperties || {}).ApiId },
    NoEcho: true,
  };
};
`),
    });

    const echo = new cdk.CustomResource(this, 'ApiEcho', {
      serviceToken: handler.functionArn,
      resourceType: 'Custom::CdkdApiIdEcho',
      properties: { ApiId: api.ref },
    });

    // allow-mode-gated-drop: every later deploy starts from an orphaned, empty stack, so omitting it drops nothing.
    if (withStage) {
      new apigwv2.CfnStage(this, 'EchoedStage', {
        apiId: echo.getAttString('ApiId'),
        stageName: 'echoed',
      });
    }
  }
}
