import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';

/**
 * Integ probe for `AWS::ApiGateway::GatewayResponse` — the classic "CORS
 * headers on 4XX/5XX" pattern everyone adds when a browser hits a
 * missing-auth error and reports a CORS failure instead of the real error.
 *
 * Phase 1 (no env): REST API + Mock GET / + a DEFAULT_4XX gateway response
 * with a wildcard Access-Control-Allow-Origin and a custom error template.
 * Phase 2 (CDKD_TEST_UPDATE=true): the origin header value changes and a
 * DEFAULT_5XX gateway response is added. Changing the API config rotates the
 * CDK `Deployment` logical-id hash, so this also exercises the
 * new-Deployment + Stage-repoint + old-Deployment-delete dance.
 *
 * `cloudWatchRole: false` keeps the fixture free of the account-level
 * `AWS::ApiGateway::Account` + Retain'd CloudWatch role (which would survive
 * destroy by design and count as an orphan in the integ sweep).
 *
 * covers: AWS::ApiGateway::RestApi
 * covers: AWS::ApiGateway::Deployment
 * covers: AWS::ApiGateway::Stage
 * covers: AWS::ApiGateway::Method
 * covers: AWS::ApiGateway::GatewayResponse
 * Confirmed CLEAN by a /hunt-bugs sweep (2026-07-17); this fixture is the
 * regression guard.
 */
export class ApigwGatewayResponseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const update = process.env.CDKD_TEST_UPDATE === 'true';

    const api = new apigw.RestApi(this, 'Api', {
      restApiName: 'cdkd-integ-gwresponse',
      deployOptions: { stageName: 'prod' },
      cloudWatchRole: false,
    });
    api.root.addMethod(
      'GET',
      new apigw.MockIntegration({
        integrationResponses: [
          { statusCode: '200', responseTemplates: { 'application/json': '{"ok":true}' } },
        ],
        requestTemplates: { 'application/json': '{"statusCode": 200}' },
      }),
      { methodResponses: [{ statusCode: '200' }] }
    );

    const origin = update ? "'https://app.example.com'" : "'*'";
    new apigw.GatewayResponse(this, 'Default4xx', {
      restApi: api,
      type: apigw.ResponseType.DEFAULT_4XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': "'Authorization,Content-Type'",
      },
      templates: {
        'application/json':
          '{"message":$context.error.messageString,"type":"$context.error.responseType"}',
      },
    });

    if (update) {
      new apigw.GatewayResponse(this, 'Default5xx', {
        restApi: api,
        type: apigw.ResponseType.DEFAULT_5XX,
        responseHeaders: { 'Access-Control-Allow-Origin': origin },
      });
    }

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
  }
}
