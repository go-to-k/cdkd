import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import type { Construct } from 'constructs';

/**
 * covers: AWS::ApiGateway::RestApi
 *
 * go-to-k/cdkd#6146: an OpenAPI `Body` embedding a `NoEcho` parameter's value
 * (`Token`, set per phase through `CDKD_TEST_NOECHO_MAC_TOKEN`). `Body` is
 * write-only, so cdkd decides whether to put it again from the KMS MAC of the
 * value it last sent. `CDKD_TEST_UPDATE=true` changes the API's
 * `Description` only: the ordinary second difference that makes the deploy
 * update the API while the `Body` stays unchanged.
 *
 * No Deployment / Stage: a put in `overwrite` mode is observed by the resource
 * `verify.sh` adds out of band, which only a put deletes.
 */
export class NoechoRestapiBodyMacStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const token = new cdk.CfnParameter(this, 'Token', {
      type: 'String',
      noEcho: true,
      default: process.env['CDKD_TEST_NOECHO_MAC_TOKEN'] ?? 'cdkd-noecho-mac-unset',
    });
    token.overrideLogicalId('Token');
    const api = new apigw.CfnRestApi(this, 'Api', {
      name: `${this.stackName}-api`,
      description: process.env['CDKD_TEST_UPDATE'] === 'true' ? 'phase-2' : 'phase-1',
      body: {
        openapi: '3.0.1',
        info: { title: `${this.stackName}-api`, version: '1' },
        paths: {
          '/spec': {
            get: {
              summary: token.valueAsString,
              responses: { '200': { description: 'ok' } },
              'x-amazon-apigateway-integration': {
                type: 'mock',
                requestTemplates: { 'application/json': '{"statusCode": 200}' },
                responses: { default: { statusCode: '200' } },
              },
            },
          },
        },
      },
    });
    api.overrideLogicalId('Api');
    new cdk.CfnOutput(this, 'ApiId', { value: api.ref });
  }
}
