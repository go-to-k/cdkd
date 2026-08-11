import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';

/**
 * ApiGatewayV2 update-field removal reset (issue #1160, apigatewayv2 batch).
 *
 * Every `AWS::ApiGatewayV2::*` `Update*` API MERGES (an absent field = "no
 * change"), so a template that DROPS a previously-set field must send an
 * explicit reset value or AWS silently keeps the old one — while cdkd reports
 * success and state drops the field, baking in invisible drift. cdkd
 * previously passed each optional field straight through as `undefined`.
 *
 *   covers: AWS::ApiGatewayV2::Api / ::Stage / ::Integration / ::Route /
 *           ::Authorizer (+ AWS::Lambda::Function for the REQUEST authorizer URI)
 *
 * Phase 1 sets one-or-more removable fields on each of the five resources.
 * Phase 2 (CDKD_TEST_UPDATE=true) removes them and the verify script asserts
 * AWS reverted each to its CloudFormation default (a pre-fix run keeps the old
 * value). Fields that are required per protocol/authorizer type (Name, Target,
 * PayloadFormatVersion, IdentitySource, ...) stay set in both phases.
 */
export class ApiGatewayV2UpdateRemovalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const update = process.env.CDKD_TEST_UPDATE === 'true';

    // Backing Lambda for the REQUEST authorizer's AuthorizerUri. It is never
    // invoked by this test (we only exercise the authorizer's create/update/
    // delete config path), so a trivial inline handler is enough.
    const authFn = new lambda.Function(this, 'AuthFn', {
      functionName: `${this.stackName}-authfn`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'exports.handler = async () => ({ isAuthorized: true });'
      ),
    });
    const authorizerUri = `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${authFn.functionArn}/invocations`;

    // ── Api (HTTP) ──────────────────────────────────────────────────
    const api = new apigwv2.CfnApi(this, 'Api', {
      name: `${this.stackName}-api`,
      protocolType: 'HTTP',
      // Removable on UPDATE: Description / CorsConfiguration /
      // DisableExecuteApiEndpoint / IpAddressType.
      ...(update
        ? {}
        : {
            description: 'before removal',
            corsConfiguration: {
              allowOrigins: ['https://example.com'],
              allowMethods: ['GET'],
            },
            disableExecuteApiEndpoint: true,
            ipAddressType: 'dualstack',
          }),
    });

    // ── Integration (HTTP_PROXY) ────────────────────────────────────
    const integration = new apigwv2.CfnIntegration(this, 'Integration', {
      apiId: api.ref,
      integrationType: 'HTTP_PROXY',
      integrationMethod: 'GET',
      integrationUri: 'https://example.com',
      payloadFormatVersion: '1.0',
      // Removable on UPDATE: Description / RequestParameters.
      ...(update
        ? {}
        : {
            description: 'before removal',
            requestParameters: { 'append:header.x-cdkd': 'y' },
          }),
    });

    // ── Authorizer (REQUEST) ────────────────────────────────────────
    const authorizer = new apigwv2.CfnAuthorizer(this, 'Authorizer', {
      apiId: api.ref,
      name: `${this.stackName}-auth`,
      authorizerType: 'REQUEST',
      authorizerUri,
      identitySource: ['$request.header.Authorization'],
      authorizerPayloadFormatVersion: '1.0',
      // Removable on UPDATE: AuthorizerResultTtlInSeconds (resets to 0).
      ...(update ? {} : { authorizerResultTtlInSeconds: 300 }),
    });

    // ── Route ───────────────────────────────────────────────────────
    new apigwv2.CfnRoute(this, 'Route', {
      apiId: api.ref,
      routeKey: 'GET /probe',
      target: `integrations/${integration.ref}`,
      authorizationType: 'CUSTOM',
      authorizerId: authorizer.ref,
      // Removable on UPDATE: OperationName (resets to '').
      ...(update ? {} : { operationName: 'probeOp' }),
    });

    // ── WebSocket API: the only place the issue #609 Route properties are
    //    usable ─────────────────────────────────────────────────────────
    // `ApiKeyRequired` / `ModelSelectionExpression` / `RequestParameters` /
    // `RouteResponseSelectionExpression` are all documented WebSocket-only, so
    // an HTTP API cannot exercise them. The route deliberately carries no
    // Target: this fixture tests the CONFIG path, and a MOCK integration would
    // need `RequestTemplates` / `TemplateSelectionExpression`, which are still
    // silent-drop on ::Integration and would be rejected by the pre-flight.
    const wsApi = new apigwv2.CfnApi(this, 'WsApi', {
      name: `${this.stackName}-ws`,
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
    });

    // TWO routes, because AWS scopes the properties differently: it rejects
    // RequestParameters anywhere but `$connect` ("Request parameters are only
    // supported for the $connect route in WEBSOCKET APIs" — hit live on the
    // first run of this fixture), while the selection expressions belong on a
    // body-carrying route.
    new apigwv2.CfnRoute(this, 'WsConnectRoute', {
      apiId: wsApi.ref,
      routeKey: '$connect',
      // Issue #609: ApiKeyRequired is REMOVED on update and must reset to the
      // CFn default; RequestParameters changes value (UpdateRoute merges the
      // map and AWS documents no whole-block reset).
      ...(update
        ? { requestParameters: { 'route.request.header.X-Cdkd': { Required: false } } }
        : {
            apiKeyRequired: true,
            requestParameters: { 'route.request.header.X-Cdkd': { Required: true } },
          }),
    });

    new apigwv2.CfnRoute(this, 'WsDefaultRoute', {
      apiId: wsApi.ref,
      routeKey: '$default',
      // Issue #609: both expressions change value on update.
      modelSelectionExpression: update ? '$request.body.updatedAction' : '$request.body.action',
      routeResponseSelectionExpression: '$default',
    });

    // Access logs for the WebSocket stage's AccessLogSettings.
    const wsAccessLogs = new logs.LogGroup(this, 'WsAccessLogs', {
      logGroupName: `/aws/apigatewayv2/${this.stackName}-ws`,
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new apigwv2.CfnStage(this, 'WsStage', {
      apiId: wsApi.ref,
      stageName: 'ws',
      // Issue #609: AccessLogSettings + RouteSettings, both changed (not
      // removed) on UPDATE — UpdateStage merges them and AWS documents no
      // whole-block reset, which is exactly what the provider's pass-through
      // records.
      accessLogSettings: {
        destinationArn: wsAccessLogs.logGroupArn,
        format: update
          ? '$context.requestId $context.status $context.routeKey'
          : '$context.requestId $context.status',
      },
      // PascalCase on purpose: `CfnStage.routeSettings` is typed `any`, so CDK
      // passes this object through VERBATIM rather than converting it. CFn (and
      // the SDK) spell the members `ThrottlingBurstLimit` etc., so camelCase
      // keys here would be dropped by the serializer with a green deploy — the
      // silent-drop class this backfill closes, one level down.
      routeSettings: {
        $default: {
          ThrottlingBurstLimit: update ? 20 : 10,
          ThrottlingRateLimit: update ? 15 : 5,
          DetailedMetricsEnabled: true,
        },
      },
    });

    // ── Stage ───────────────────────────────────────────────────────
    // AutoDeploy stays true across both phases ($default auto-deploy is
    // finicky to flip); the removal path exercised here is StageVariables
    // (per-key clear). AutoDeploy-removal reset is covered by the unit tests.
    new apigwv2.CfnStage(this, 'Stage', {
      apiId: api.ref,
      stageName: '$default',
      autoDeploy: true,
      // Removable on UPDATE: StageVariables (per-key clear).
      ...(update ? {} : { stageVariables: { foo: 'bar' } }),
    });

    new cdk.CfnOutput(this, 'ApiId', { value: api.ref });
    new cdk.CfnOutput(this, 'WsApiId', { value: wsApi.ref });
    new cdk.CfnOutput(this, 'AuthorizerId', { value: authorizer.ref });
  }
}
