import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * covers: AWS::ApiGateway::RestApi, AWS::SSM::Parameter
 *
 * State schema v16 -> v17 migration fixture (issue #6146).
 *
 * v17 is CONDITIONAL: a save writes it only for a state some record of which
 * carries `noEchoValueMacs` (a KMS MAC of a `NoEcho` value a write-only
 * property was sent), and 16 otherwise. The REST API's OpenAPI `Body` embeds
 * the `NoEcho` parameter `Token`, so it is such a property.
 *
 * - `CDKD_TEST_PARAM_VALUE` sets the SSM parameter's value: the ordinary
 *   change that makes a deploy write the state without touching the Body.
 * - `CDKD_TEST_BODY_VERSION` sets the Body's `info.version`, a part of the
 *   Body that is not masked: changing it puts the Body, which records its MAC.
 * - `CDKD_TEST_NOECHO_TOKEN` is the `NoEcho` value (constant within a run).
 */
export class SchemaV16ToV17MigrationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const token = new cdk.CfnParameter(this, 'Token', {
      type: 'String',
      noEcho: true,
      default: process.env['CDKD_TEST_NOECHO_TOKEN'] ?? 'cdkd-schema-v16-v17-unset',
    });
    token.overrideLogicalId('Token');

    const api = new apigw.CfnRestApi(this, 'Api', {
      name: `${this.stackName}-api`,
      body: {
        openapi: '3.0.1',
        info: {
          title: `${this.stackName}-api`,
          version: process.env['CDKD_TEST_BODY_VERSION'] ?? '1',
        },
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

    const param = new ssm.StringParameter(this, 'Param', {
      parameterName: '/cdkd-schema-v16-v17/value',
      stringValue: process.env['CDKD_TEST_PARAM_VALUE'] ?? 'one',
      simpleName: false,
    });
    (param.node.defaultChild as ssm.CfnParameter).overrideLogicalId('Param');
  }
}
