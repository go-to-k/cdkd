import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2_integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Fixture stack for `cdkd local start-api` integ test.
 *
 * No AWS deploy required — the integ exercises the synthesized cdk.out
 * locally against Docker + RIE.
 *
 * Routes (asserted by verify.sh):
 *   - HTTP API:    GET /items, GET /items/{id}, POST /items
 *     (with `CorsConfiguration` enabling `*` origin so verify.sh can
 *     curl an OPTIONS preflight and assert the canonical response —
 *     PR 8c, issue #235)
 *   - REST v1:     ANY /v1/{proxy+} (stage 'prod' with `Variables`
 *     so the integ can assert `event.stageVariables.STAGE === 'prod'`)
 *   - Function URL on a separate Lambda: ANY /{proxy+}
 *
 * verify.sh boots the server, asserts the route table, curls each
 * route (including an OPTIONS preflight against `/items`), and shuts
 * down cleanly without orphan containers.
 */
export class LocalStartApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const itemsHandler = new lambda.Function(this, 'ItemsHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-items')),
      timeout: cdk.Duration.seconds(10),
    });

    // HTTP API v2 with three routes against ItemsHandler. PR 8c adds
    // CorsConfiguration so the integ can exercise OPTIONS preflight
    // interception.
    const httpApi = new apigwv2.HttpApi(this, 'MyHttpApi', {
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'X-Demo-Header'],
        maxAge: cdk.Duration.seconds(300),
      },
    });
    const itemsIntegration = new apigwv2_integrations.HttpLambdaIntegration(
      'ItemsIntegration',
      itemsHandler
    );
    httpApi.addRoutes({
      path: '/items',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: itemsIntegration,
    });
    httpApi.addRoutes({
      path: '/items/{id}',
      methods: [apigwv2.HttpMethod.GET],
      integration: itemsIntegration,
    });

    // REST v1 with a single greedy proxy route on stage 'prod'. PR 8c
    // attaches Variables to the Stage so the integ can assert
    // `event.stageVariables.STAGE === 'prod'`.
    const restHandler = new lambda.Function(this, 'RestHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-rest')),
      timeout: cdk.Duration.seconds(10),
    });
    const restApi = new apigw.RestApi(this, 'MyRestApi', {
      deployOptions: {
        stageName: 'prod',
        variables: { STAGE: 'prod', LOG_LEVEL: 'info' },
      },
    });
    const v1 = restApi.root.addResource('v1');
    const proxy = v1.addResource('{proxy+}');
    proxy.addMethod('ANY', new apigw.LambdaIntegration(restHandler, { proxy: true }));

    // Function URL on a separate Lambda.
    const urlHandler = new lambda.Function(this, 'UrlHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-url')),
      timeout: cdk.Duration.seconds(10),
    });
    urlHandler.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
  }
}
