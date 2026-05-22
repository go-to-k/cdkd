import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2_integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigwv2_authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
 *   - HTTP API:    GET /protected (authorizer-gated, PR 8b)
 *   - REST v1:     ANY /v1/{proxy+} (stage 'prod' with `Variables`
 *     so the integ can assert `event.stageVariables.STAGE === 'prod'`)
 *     plus `defaultCorsPreflightOptions` so CDK auto-emits OPTIONS
 *     Methods backed by MOCK integrations on every resource — exercises
 *     the REST v1 MOCK CORS preflight subset (verify.sh asserts a 204
 *     response with the canonical CORS headers, no Lambda invoke).
 *   - REST v1:     GET /v1/unsupported (HTTP_PROXY integration to a
 *     public URL) — exercises the deferred-error class. cdkd boots
 *     successfully with a [warn] line; verify.sh asserts the route
 *     returns 501 + `reason` body without invoking any Lambda.
 *   - REST v1:     GET /v1/cross-stack-auth (CUSTOM authorizer whose
 *     AuthorizerUri is overridden via `addPropertyOverride` to a
 *     cross-stack-shape `Fn::Sub: '${ImportedAuthFn.Arn}'` that cdkd
 *     cannot resolve locally) — exercises the authorizer-Lambda-Arn
 *     deferred-501 path added in issue #431. cdkd boots successfully
 *     with the authorizer-attach failure deferred to request time;
 *     verify.sh asserts the route returns 501 + `reason` body.
 *   - Function URL on a separate Lambda: ANY /{proxy+}
 *
 * PR 8b extension: a Lambda REQUEST authorizer guards `/protected`. The
 * authorizer Allow's the request iff `Authorization: Bearer let-me-in`
 * is present; otherwise it Deny's. verify.sh asserts both directions.
 *
 * verify.sh boots the server, asserts the route table, curls each
 * route (including an OPTIONS preflight against `/items` and
 * authorizer-gated `/protected`), and shuts down cleanly without
 * orphan containers.
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

    // Authorizer-protected route (PR 8b) — Lambda REQUEST authorizer.
    const authorizerHandler = new lambda.Function(this, 'AuthorizerHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-authorizer')),
      timeout: cdk.Duration.seconds(10),
    });
    const protectedHandler = new lambda.Function(this, 'ProtectedHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-protected')),
      timeout: cdk.Duration.seconds(10),
    });
    const authorizer = new apigwv2_authorizers.HttpLambdaAuthorizer(
      'IntegLambdaAuthorizer',
      authorizerHandler,
      {
        authorizerName: 'IntegAuth',
        identitySource: ['$request.header.Authorization'],
        responseTypes: [apigwv2_authorizers.HttpLambdaResponseType.IAM],
        resultsCacheTtl: cdk.Duration.seconds(0),
      }
    );
    httpApi.addRoutes({
      path: '/protected',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2_integrations.HttpLambdaIntegration(
        'ProtectedIntegration',
        protectedHandler
      ),
      authorizer,
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
      // CDK auto-emits OPTIONS Methods backed by MOCK integrations on
      // every resource. Their `IntegrationResponses[0].ResponseParameters`
      // are literal `method.response.header.Access-Control-Allow-*` pairs
      // — exactly the shape `cdkd local start-api` extracts and serves
      // directly as a 204 preflight (no Lambda invoke).
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'X-Demo-Header'],
      },
    });
    const v1 = restApi.root.addResource('v1');
    const proxy = v1.addResource('{proxy+}');
    proxy.addMethod('ANY', new apigw.LambdaIntegration(restHandler, { proxy: true }));

    // Deferred-error class: HTTP_PROXY integration (REST v1). cdkd cannot
    // emulate non-AWS_PROXY REST v1 integrations, so this route becomes
    // an `unsupported` route at discovery — boot proceeds, HTTP 501 fires
    // at request time. verify.sh asserts both behaviors.
    const unsupported = v1.addResource('unsupported');
    unsupported.addMethod(
      'GET',
      new apigw.HttpIntegration('https://example.com/never-actually-hit', {
        httpMethod: 'GET',
        proxy: true,
      })
    );

    // Authorizer Lambda Arn unresolvable (issue #431): build a CUSTOM
    // REQUEST authorizer pointing at a same-stack Lambda, then override
    // its synthesized `AuthorizerUri` to a cross-stack-shape
    // `Fn::Sub: '${ImportedAuthFn.Arn}'` that cdkd cannot resolve
    // locally. cdkd's authorizer-resolver hits the unresolvable Arn,
    // flips the route to deferred-error unsupported, boot continues,
    // HTTP 501 + reason at request time. The L1 override pattern lets
    // us fixture this without spinning up a separate stack.
    const crossStackAuthHandler = new lambda.Function(this, 'CrossStackAuthFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      // Reuse the existing lambda-authorizer asset — never actually
      // invoked locally because the route 501s before the authorizer
      // pass.
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-authorizer')),
      timeout: cdk.Duration.seconds(10),
    });
    const crossStackAuth = new apigw.RequestAuthorizer(this, 'CrossStackAuth', {
      handler: crossStackAuthHandler,
      identitySources: [apigw.IdentitySource.header('Authorization')],
      resultsCacheTtl: cdk.Duration.seconds(0),
    });
    // Override the synthesized AuthorizerUri to an unresolvable shape.
    (crossStackAuth.node.defaultChild as apigw.CfnAuthorizer).addPropertyOverride(
      'AuthorizerUri',
      { 'Fn::Sub': '${ImportedAuthFn.Arn}' }
    );
    const crossStackAuthRoute = v1.addResource('cross-stack-auth');
    crossStackAuthRoute.addMethod(
      'GET',
      new apigw.LambdaIntegration(restHandler, { proxy: true }),
      { authorizer: crossStackAuth, authorizationType: apigw.AuthorizationType.CUSTOM }
    );

    // Function URL on a separate Lambda.
    const urlHandler = new lambda.Function(this, 'UrlHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-url')),
      timeout: cdk.Duration.seconds(10),
    });
    urlHandler.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    // Streaming Function URL — exercises the RESPONSE_STREAM invoke mode
    // path added in #467. cdkd's local server detects InvokeMode and
    // routes the request through invokeRieStreaming(), parses the JSON
    // prelude carrying status + headers, and pipes the body chunks to
    // the HTTP client with `Transfer-Encoding: chunked`. The handler
    // uses `awslambda.streamifyResponse` + `awslambda.HttpResponseStream`
    // — the documented Node 20 streaming Lambda entrypoint.
    const streamUrlHandler = new lambda.Function(this, 'StreamUrlHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-stream-url')),
      timeout: cdk.Duration.seconds(30),
    });
    streamUrlHandler.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });
  }
}
