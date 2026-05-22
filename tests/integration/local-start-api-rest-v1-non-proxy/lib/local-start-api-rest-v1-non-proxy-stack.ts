import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for `cdkd local start-api` REST v1 non-AWS_PROXY
 * integrations (#457).
 *
 * Deploys NOTHING — the integ exercises `cdkd local start-api` end-to-
 * end against Docker + the AWS Lambda Node.js base image (which
 * bundles RIE). The test runner verifies that each non-AWS_PROXY
 * integration kind responds correctly when curl'd.
 *
 * Routes exercised:
 *
 *   - `GET /mock-200` — MOCK integration with a request template that
 *     selects `{"statusCode": 200}` and a response template that
 *     returns `{"source":"mock"}`. Asserts cdkd's MOCK dispatcher
 *     (VTL evaluation against an empty input) round-trips correctly.
 *
 *   - `GET /mock-404` — MOCK integration with a request template that
 *     drives the 404 IntegrationResponses[] entry. Asserts status-code
 *     selection on MOCK.
 *
 *   - `GET /http-proxy` — HTTP_PROXY to https://httpbin.org/get. Without
 *     network access in CI sandboxes this typically returns a 502; the
 *     integ tolerates either the upstream 200 response OR the 502.
 *
 *   - `POST /aws-lambda` — AWS (Lambda non-proxy) integration with VTL
 *     request templates that synthesize `{action, name}` from the
 *     request body, invoke the Lambda, and shape the response via VTL
 *     into `{"data": "Hello, <name>"}`. The integ asserts that the
 *     request-side AND response-side VTL both fired.
 */
export class LocalStartApiRestV1NonProxyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const handler = new lambda.Function(this, 'NonProxyHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-non-proxy')),
      timeout: cdk.Duration.seconds(10),
    });

    const api = new apigw.RestApi(this, 'RestApi', {
      restApiName: 'rest-v1-non-proxy-integ',
    });

    // MOCK 200 — request template selects statusCode 200, response
    // template returns a literal JSON payload.
    const mock200 = api.root.addResource('mock-200');
    mock200.addMethod(
      'GET',
      new apigw.MockIntegration({
        requestTemplates: {
          'application/json': '{"statusCode": 200}',
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: {
              'application/json': '{"source":"mock","statusCode":200}',
            },
          },
        ],
      }),
      {
        methodResponses: [{ statusCode: '200' }],
      }
    );

    // MOCK 404 — request template selects statusCode 404.
    const mock404 = api.root.addResource('mock-404');
    mock404.addMethod(
      'GET',
      new apigw.MockIntegration({
        requestTemplates: {
          'application/json': '{"statusCode": 404}',
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: {
              'application/json': '{"source":"mock","statusCode":200}',
            },
          },
          {
            statusCode: '404',
            responseTemplates: {
              'application/json': '{"source":"mock","statusCode":404,"error":"not found"}',
            },
          },
        ],
        passthroughBehavior: apigw.PassthroughBehavior.NEVER,
      }),
      {
        methodResponses: [{ statusCode: '200' }, { statusCode: '404' }],
      }
    );

    // HTTP_PROXY — public upstream. May 502 in network-isolated CI; the
    // integ tolerates either a connection error or a 200.
    const httpProxy = api.root.addResource('http-proxy');
    httpProxy.addMethod(
      'GET',
      new apigw.HttpIntegration('https://httpbin.org/get', {
        proxy: true,
        httpMethod: 'GET',
      })
    );

    // AWS Lambda non-proxy — request-side VTL synthesizes `{action, name}`
    // from the request body; response-side VTL wraps `$inputRoot.greeting`
    // into `{"data": <value>}`.
    const awsLambda = api.root.addResource('aws-lambda');
    awsLambda.addMethod(
      'POST',
      new apigw.LambdaIntegration(handler, {
        proxy: false,
        requestTemplates: {
          'application/json':
            '{"action": "$input.path(\'$.action\')", "name": "$input.path(\'$.name\')"}',
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: {
              'application/json': '{"data": $input.json("$.greeting")}',
            },
          },
        ],
      }),
      {
        methodResponses: [{ statusCode: '200' }],
      }
    );
  }
}
