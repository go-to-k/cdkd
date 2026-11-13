import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as sqs from 'aws-cdk-lib/aws-sqs';
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
 * go-to-k/cdkd#6209: the `Body` also reads a resource attribute (the queue's
 * `Fn::GetAtt` Arn), as a Lambda integration's URI does. A MAC match settles
 * such a `Body` only when the attribute is resolved and equal to the one the
 * last put was made with.
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
    const queue = new sqs.Queue(this, 'Queue', {
      // Unique per run (verify.sh): SQS refuses a name deleted < 60 s ago.
      queueName: process.env['CDKD_TEST_NOECHO_MAC_QUEUE'] ?? `${this.stackName}-q`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    (queue.node.defaultChild as sqs.CfnQueue).overrideLogicalId('Queue');
    const api = new apigw.CfnRestApi(this, 'Api', {
      name: `${this.stackName}-api`,
      description: process.env['CDKD_TEST_UPDATE'] === 'true' ? 'phase-2' : 'phase-1',
      body: {
        openapi: '3.0.1',
        info: { title: `${this.stackName}-api`, version: '1' },
        paths: {
          '/spec': {
            get: {
              // The NoEcho value and the GetAtt share one masked leaf, so
              // the recorded Body cannot show the Arn moving: only the
              // input fingerprints can (verify.sh phase 4).
              summary: cdk.Fn.join('|', [token.valueAsString, queue.queueArn]),
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
