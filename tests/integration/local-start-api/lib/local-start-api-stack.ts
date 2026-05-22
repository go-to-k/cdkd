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
 *   - HTTP API:    POST /sqs (service integration: `SQS-SendMessage`),
 *                  POST /events (service integration: `EventBridge-PutEvents`),
 *                  POST /unknown-subtype (typo'd subtype → deferred-501).
 *                  Issue #458 — verify.sh asserts the dispatcher fires
 *                  against the real AWS SDK (not 501) on the first two,
 *                  and the classifier rejects the typo on the third.
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

    // Deferred-error class: REST v1 direct-AWS-service integration (closes
    // #512). Pre-PR #505 this route was an HTTP_PROXY which fell through
    // to deferred-501; post-#505 HTTP_PROXY is first-class so the route
    // started forwarding to example.com (404). Now we use an integration
    // with `Integration.Type: 'AWS'` and a non-Lambda service URI (S3) —
    // cdkd's REST v1 dispatcher detects the non-`:lambda:path/` marker
    // and surfaces deferred-501 ("non-Lambda service ... not emulated
    // locally in cdkd v1"). verify.sh asserts the 501 path.
    const unsupported = v1.addResource('unsupported');
    const unsupportedMethod = unsupported.addMethod('GET');
    // CDK's L2 `Integration` constructs don't expose `AWS` direct-service
    // type out of the box, so we use `addPropertyOverride` on the
    // synthesized Method's Integration sub-resource. This produces a CFn
    // `Integration: { Type: 'AWS', Uri: 'arn:aws:apigateway:...:s3:path/...' }`
    // shape cdkd's REST v1 classifier rejects with the non-Lambda hint.
    (unsupportedMethod.node.defaultChild as apigw.CfnMethod).addPropertyOverride('Integration', {
      Type: 'AWS',
      IntegrationHttpMethod: 'GET',
      Uri: {
        'Fn::Join': [
          ':',
          ['arn', 'aws', 'apigateway', { Ref: 'AWS::Region' }, 's3', 'path/example-bucket/key'],
        ],
      },
    });

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

    // HTTP API v2 service integrations (#458) — IntegrationSubtype wired
    // directly to an AWS SDK call, no Lambda backing the route. CDK
    // doesn't ship an L2 for this yet, so we use L1 `CfnIntegration` +
    // `CfnRoute`. The integ does NOT deploy anything; verify.sh asserts
    // (a) the route table shows the per-subtype label (proving classifier
    // routed the subtype to dispatch, not deferred-501), and (b) a curl
    // hit returns a 4xx from the SDK adapter (proving dispatch wired into
    // the real SDK — pre-#458 the route 501'd before any SDK call).
    const sqsSendIntegration = new apigwv2.CfnIntegration(this, 'SqsSendInteg', {
      apiId: httpApi.apiId,
      integrationType: 'AWS_PROXY',
      integrationSubtype: 'SQS-SendMessage',
      payloadFormatVersion: '1.0',
      // `CredentialsArn` is required on deployed AWS API Gateway for
      // service integrations; it's a no-op locally (the dispatcher uses
      // the dev's local AWS credential chain) but we set it to a
      // fixture-stable value so cdkd synth doesn't fail validation.
      credentialsArn: 'arn:aws:iam::123456789012:role/fixture-sqs-role',
      requestParameters: {
        QueueUrl: '$request.querystring.url',
        MessageBody: '$request.body.message',
      },
    });
    new apigwv2.CfnRoute(this, 'SqsSendRoute', {
      apiId: httpApi.apiId,
      routeKey: 'POST /sqs',
      target: cdk.Fn.join('/', ['integrations', sqsSendIntegration.ref]),
    });

    const eventBridgeIntegration = new apigwv2.CfnIntegration(this, 'EventBridgePutInteg', {
      apiId: httpApi.apiId,
      integrationType: 'AWS_PROXY',
      integrationSubtype: 'EventBridge-PutEvents',
      payloadFormatVersion: '1.0',
      credentialsArn: 'arn:aws:iam::123456789012:role/fixture-events-role',
      requestParameters: {
        Source: 'cdkd.local-start-api.integ',
        DetailType: '$request.querystring.type',
        Detail: '$request.body',
        // EventBusName intentionally omitted — falls back to 'default'
        // when the user does not template it.
      },
    });
    new apigwv2.CfnRoute(this, 'EventBridgePutRoute', {
      apiId: httpApi.apiId,
      routeKey: 'POST /events',
      target: cdk.Fn.join('/', ['integrations', eventBridgeIntegration.ref]),
    });

    // Unrecognized subtype path — exercises the classifier's fallback to
    // deferred-501 (preserves the safe surface for typo'd subtypes AND
    // for AWS-documented subtypes cdkd does not yet implement). Use an
    // obviously-bogus subtype name so the test is unambiguous about
    // exercising the unsupported path rather than asserting anything
    // about a real AWS service.
    const fakeSubtypeIntegration = new apigwv2.CfnIntegration(this, 'FakeSubtypeInteg', {
      apiId: httpApi.apiId,
      integrationType: 'AWS_PROXY',
      integrationSubtype: 'BogusService-NotASubtype',
      payloadFormatVersion: '1.0',
      credentialsArn: 'arn:aws:iam::123456789012:role/fixture-bogus-role',
      requestParameters: { Param: 'foo' },
    });
    new apigwv2.CfnRoute(this, 'FakeSubtypeRoute', {
      apiId: httpApi.apiId,
      routeKey: 'POST /unknown-subtype',
      target: cdk.Fn.join('/', ['integrations', fakeSubtypeIntegration.ref]),
    });

    // Issue #502: Lambda-authorizer-protected service-integration route.
    // Pre-PR cdkd dispatched the SDK call BEFORE the authorizer pass,
    // letting unauthenticated requests reach the SDK. Post-PR the
    // authorizer pass runs FIRST: missing Bearer → 401, valid Bearer →
    // SDK dispatches (returns 4xx from the missing queue, NOT 401).
    // Reuses `authorizer` (defined for /protected) so a single Lambda
    // gates both routes — the Allow condition is `Authorization:
    // Bearer let-me-in`.
    const sqsSendProtectedIntegration = new apigwv2.CfnIntegration(
      this,
      'SqsSendProtectedInteg',
      {
        apiId: httpApi.apiId,
        integrationType: 'AWS_PROXY',
        integrationSubtype: 'SQS-SendMessage',
        payloadFormatVersion: '1.0',
        credentialsArn: 'arn:aws:iam::123456789012:role/fixture-sqs-protected-role',
        requestParameters: {
          QueueUrl: '$request.querystring.url',
          MessageBody: '$request.body.message',
          // `$context.authorizer.X` reference proving the authorizer
          // context is plumbed into the parameter-mapping context (#502).
          // The SDK call will fail (missing queue) but the resolved
          // MessageAttributes value rides in on the request so verify.sh
          // can grep cdkd's log for the substituted value.
          MessageAttributes: cdk.Fn.sub(
            JSON.stringify({
              caller: {
                DataType: 'String',
                StringValue: '${context.authorizer.principalId}',
              },
            })
          ),
        },
      }
    );
    new apigwv2.CfnRoute(this, 'SqsSendProtectedRoute', {
      apiId: httpApi.apiId,
      routeKey: 'POST /protected-sqs',
      target: cdk.Fn.join('/', ['integrations', sqsSendProtectedIntegration.ref]),
      authorizationType: 'CUSTOM',
      authorizerId: authorizer.authorizerId,
    });

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
