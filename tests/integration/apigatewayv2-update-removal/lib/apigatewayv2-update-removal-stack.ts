import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as iam from 'aws-cdk-lib/aws-iam';
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
 * Issue #609 also rides this fixture: the `::Integration` silent-drop backfill
 * adds ten properties whose delivery is asserted here on CREATE and on UPDATE.
 *
 * Phase 1 sets one-or-more removable fields on each of the five resources.
 * Phase 2 (CDKD_TEST_UPDATE=true) removes them and the verify script asserts
 * AWS kept what CloudFormation keeps (#5004) and reset CorsConfiguration and
 * ClearAuthorizer's IdentitySource (CloudFormation clears it, #1160 A/B).
 * Phase 2b (CDKD_TEST_REMOVAL=true) also removes the WebSocket MOCK
 * integration's and `$default` route's #609 fields (CloudFormation keeps them,
 * #1160 A/B) and changes only the service integration's Description. Phase 2c
 * (CDKD_TEST_SUBTYPE_REMOVED=true) removes its IntegrationSubtype, which
 * CloudFormation fails, so cdkd must refuse the deploy.
 */
export class ApiGatewayV2UpdateRemovalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Phase 2b (issue #609): the members whose removal needs a dedicated
    // Delete* API rather than an omitted UpdateStage / UpdateRoute member.
    // Phase 2c (issue #1160): the template drops the service integration's
    // IntegrationSubtype, which CloudFormation fails, so cdkd must refuse it.
    // It builds on phase 2b and changes nothing else.
    const subtypeRemoved = process.env.CDKD_TEST_SUBTYPE_REMOVED === 'true';
    const removal = process.env.CDKD_TEST_REMOVAL === 'true' || subtypeRemoved;
    // Removal BUILDS ON the update phase rather than reverting to the
    // baseline: phase 2b must keep everything phase 2 already removed removed,
    // and keep its updated values, so the only delta it introduces is the
    // delete-API-only members below.
    const update = process.env.CDKD_TEST_UPDATE === 'true' || removal;

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
      // Issue #5390: Tags is a MAP on this type. Phase 2 changes k1's value and
      // drops k2; CloudFormation re-tags k1 and untags k2 (real A/B).
      tags: update ? { k1: 'v1x' } : { k1: 'v1', k2: 'v2' },
      // Removed on UPDATE: CorsConfiguration is RESET (CloudFormation resets it);
      // Description / DisableExecuteApiEndpoint / IpAddressType are RETAINED
      // (CloudFormation keeps them, #5004).
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
      // Issue #609: ResponseParameters CHANGES VALUE on update rather than
      // being removed — the backfill wires delivery, and absent-field removal
      // for this group is left to the #1160 umbrella because each field needs
      // its own live CFn A/B first.
      //
      // TlsConfig is deliberately NOT set on THIS integration — it lives on
      // the issue #1602 integration below, so one resource carries both of
      // that issue's shapes. This one contributes the OTHER half of the #1602
      // fix: its unquoted numeric `Source` (see the comment below) is what
      // binds the CFn-arm mirror, since AWS returns the value as a string and
      // a read side that re-emitted AWS's string would report permanent
      // phantom drift against the properties-fallback baseline. verify.sh
      // strips this resource's observedProperties too and asserts drift is
      // clean.
      //
      // ResponseParameters is the one property whose CFn shape (a per-status
      // list of {Destination, Source}) differs from the SDK's (a flat map), so
      // this is the assertion that proves the fold reaches AWS — forwarding
      // the CFn shape verbatim delivers an empty map with a green deploy.
      responseParameters: {
        '404': {
          ResponseParameters: [
            { Destination: 'append:header.x-cdkd-resp', Source: update ? 'updated' : 'before' },
            // UNQUOTED on purpose: CFn types ResponseParameters as free-form
            // `object` and coerces scalars, so a numeric Source is a legal
            // template — and `overwrite:statuscode` is exactly the destination
            // whose value an author writes as a number. cdkd must coerce it;
            // the first draft skipped non-strings and would have dropped this
            // pair with a green deploy.
            { Destination: 'overwrite:statuscode', Source: update ? 403 : 404 },
          ],
        },
      },
      // Removed on UPDATE, RETAINED by CloudFormation (#5004): Description / RequestParameters.
      ...(update
        ? {}
        : {
            description: 'before removal',
            requestParameters: { 'append:header.x-cdkd': 'y' },
          }),
    });

    // ── Integration (AWS_PROXY service integration) ─────────────────
    // The only shape that can carry IntegrationSubtype + CredentialsArn: an
    // HTTP API service integration invoking EventBridge under an assumed role.
    const eventsRole = new iam.Role(this, 'EventsRole', {
      roleName: `${this.stackName}-events`,
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      inlinePolicies: {
        putEvents: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({ actions: ['events:PutEvents'], resources: ['*'] }),
          ],
        }),
      },
    });
    new apigwv2.CfnIntegration(this, 'EventsIntegration', {
      apiId: api.ref,
      integrationType: 'AWS_PROXY',
      // Issue #609: IntegrationSubtype + CredentialsArn. Issue #1160: phase 2c
      // REMOVES the subtype, which CloudFormation fails (real A/B), so cdkd
      // must refuse that deploy before any call.
      ...(subtypeRemoved ? {} : { integrationSubtype: 'EventBridge-PutEvents' }),
      credentialsArn: eventsRole.roleArn,
      payloadFormatVersion: '1.0',
      requestParameters: {
        Source: 'cdkd.integ',
        DetailType: update ? 'updated' : 'before',
        Detail: '$request.body',
      },
      // Issue #1160: phase 2b changes ONLY the Description. AWS re-validates
      // the EventBridge operation's required parameter mapping on every
      // UpdateIntegration, so cdkd must send the unchanged RequestParameters
      // beside the subtype or AWS rejects the call.
      ...(removal ? { description: 'description-only change' } : {}),
    });

    // ── The issue #1602 integration ─────────────────────────────────
    // Carries BOTH shapes the issue is about, so ONE resource covers both:
    //
    // (a) `TlsConfig` on a PUBLIC integration. Direct A/B against the API
    //     (2026-08-11, us-east-1): AWS SILENTLY IGNORES the field on a
    //     ConnectionType-INTERNET integration — it is absent from both the
    //     CreateIntegration echo and the GetIntegration read-back — because
    //     it is only meaningful for a PRIVATE (VPC-Link) integration. The
    //     template declares it ON PURPOSE so verify.sh can assert AWS has
    //     nothing to read back, and that `cdkd drift` is clean anyway.
    //
    // (b) `ResponseParameters` in the ALREADY-FLAT SDK spelling
    //     (`{"<status>": {"<Destination>": "<Source>"}}`) that a hand-written
    //     L1 may borrow instead of the CFn list-of-pairs;
    //     `toSdkResponseParameters` deliberately passes it through. Before
    //     #1602 the read side always rebuilt the CFn list shape, so a
    //     flat-spelled baseline could never compare equal to the read-back.
    //
    // Both phantom drifts fire on the `properties`-fallback drift baseline
    // (state written before observed-capture, capture disabled, or a failed
    // capture) — the observed baseline never carries them — so verify.sh
    // drops THIS resource's `observedProperties` before each drift run. That
    // is why the two shapes ride one dedicated resource rather than the main
    // integration: they must be the ONLY thing that resource can drift on.
    //
    // Values stay STRINGS on purpose: a flat block passes through verbatim,
    // so this arm never exercises the CFn-side scalar coercion the main
    // integration covers. It rides its own API because `int_id_by_type`
    // requires exactly one integration per (api, type) pair, and the main
    // API's HTTP_PROXY slot is taken.
    const flatApi = new apigwv2.CfnApi(this, 'FlatApi', {
      name: `${this.stackName}-flat`,
      protocolType: 'HTTP',
    });
    new apigwv2.CfnIntegration(this, 'FlatIntegration', {
      apiId: flatApi.ref,
      integrationType: 'HTTP_PROXY',
      integrationMethod: 'GET',
      integrationUri: 'https://example.com',
      payloadFormatVersion: '1.0',
      // Constant across phases: presence, not value, is what matters here.
      tlsConfig: { serverNameToVerify: 'backend.example.com' },
      responseParameters: {
        '404': {
          'append:header.x-cdkd-flat': update ? 'flat-updated' : 'flat-before',
          'overwrite:statuscode': update ? '204' : '200',
        },
      },
    });

    // ── Authorizer (REQUEST) ────────────────────────────────────────
    const authorizer = new apigwv2.CfnAuthorizer(this, 'Authorizer', {
      apiId: api.ref,
      name: `${this.stackName}-auth`,
      authorizerType: 'REQUEST',
      authorizerUri,
      identitySource: ['$request.header.Authorization'],
      authorizerPayloadFormatVersion: '1.0',
      // Removed on UPDATE, RETAINED by CloudFormation (#5004): AuthorizerResultTtlInSeconds.
      ...(update ? {} : { authorizerResultTtlInSeconds: 300 }),
    });

    // ── Authorizer (REQUEST, caching OFF) ───────────────────────────
    // Issue #1160: CloudFormation CLEARS a removed IdentitySource (real A/B),
    // and AWS allows that only with caching off (TTL 0) — the authorizer above
    // keeps TTL 300, so this one carries the removal. Removed in phase 2.
    new apigwv2.CfnAuthorizer(this, 'ClearAuthorizer', {
      apiId: api.ref,
      name: `${this.stackName}-clear-auth`,
      authorizerType: 'REQUEST',
      authorizerUri,
      authorizerPayloadFormatVersion: '2.0',
      authorizerResultTtlInSeconds: 0,
      ...(update ? {} : { identitySource: ['$request.header.Authorization'] }),
    });

    // ── Route ───────────────────────────────────────────────────────
    new apigwv2.CfnRoute(this, 'Route', {
      apiId: api.ref,
      routeKey: 'GET /probe',
      target: `integrations/${integration.ref}`,
      authorizationType: 'CUSTOM',
      authorizerId: authorizer.ref,
      // Removed on UPDATE, RETAINED by CloudFormation (#5004): OperationName.
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

    // ── WebSocket MOCK Integration ──────────────────────────────────
    // Issue #609: RequestTemplates / TemplateSelectionExpression /
    // PassthroughBehavior / ContentHandlingStrategy are all MOCK-integration
    // properties, and a MOCK integration needs a WebSocket API — which is
    // exactly why the WsRoute comment above said these were unreachable while
    // they were still silent-drop. The integration carries no route: this
    // fixture exercises the CONFIG path, and an unattached integration is a
    // legal AWS resource.
    //
    // NOT covered here: ConnectionId, which requires a live VPC Link (VPC +
    // subnets + SG, minutes per run) for a plain pass-through field. It is
    // pinned by the unit tests instead.
    // Issue #1160: phase 2b REMOVES all four; CloudFormation KEEPS each live
    // value (real A/B), so they must survive at their phase 2 values.
    new apigwv2.CfnIntegration(this, 'WsMockIntegration', {
      apiId: wsApi.ref,
      integrationType: 'MOCK',
      ...(removal
        ? {}
        : {
            requestTemplates: {
              $default: update ? '{"statusCode":202}' : '{"statusCode":200}',
            },
            templateSelectionExpression: '\\$default',
            passthroughBehavior: update ? 'NEVER' : 'WHEN_NO_MATCH',
            contentHandlingStrategy: update ? 'CONVERT_TO_BINARY' : 'CONVERT_TO_TEXT',
          }),
    });

    // TWO routes, because AWS scopes the properties differently: it rejects
    // RequestParameters anywhere but `$connect` ("Request parameters are only
    // supported for the $connect route in WEBSOCKET APIs" — hit live on the
    // first run of this fixture), while the selection expressions belong on a
    // body-carrying route.
    new apigwv2.CfnRoute(this, 'WsConnectRoute', {
      apiId: wsApi.ref,
      routeKey: '$connect',
      // Issue #5548: ApiKeyRequired is REMOVED on update, beside the
      // RequestParameters change; CloudFormation KEEPS it (real A/B), so it
      // must stay true. RequestParameters changes value (UpdateRoute merges
      // the map and AWS documents no whole-block reset).
      ...(removal
        ? {}
        : update
          ? { requestParameters: { 'route.request.header.X-Cdkd': { Required: false } } }
          : {
              apiKeyRequired: true,
              requestParameters: { 'route.request.header.X-Cdkd': { Required: true } },
            }),
    });

    new apigwv2.CfnRoute(this, 'WsDefaultRoute', {
      apiId: wsApi.ref,
      routeKey: '$default',
      // Issue #609: both expressions change value on update. Issue #1160:
      // phase 2b REMOVES both; CloudFormation KEEPS them (real A/B).
      ...(removal
        ? {}
        : {
            modelSelectionExpression: update
              ? '$request.body.updatedAction'
              : '$request.body.action',
            routeResponseSelectionExpression: '$default',
          }),
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
      // Issue #609: AccessLogSettings + RouteSettings CHANGE on update and are
      // REMOVED in phase 2b. UpdateStage merges both, so only their dedicated
      // Delete* APIs can clear them (live-probed 2026-08-11) — omitting the
      // member is the silent no-op the #1160 umbrella tracks.
      ...(removal
        ? {}
        : {
            accessLogSettings: {
              destinationArn: wsAccessLogs.logGroupArn,
              format: update
                ? '$context.requestId $context.status $context.routeKey'
                : '$context.requestId $context.status',
            },
          }),
      // PascalCase on purpose: `CfnStage.routeSettings` is typed `any`, so CDK
      // passes this object through VERBATIM rather than converting it. CFn (and
      // the SDK) spell the members `ThrottlingBurstLimit` etc., so camelCase
      // keys here would be dropped by the serializer with a green deploy — the
      // silent-drop class this backfill closes, one level down.
      // Phase 2b drops ONLY the `$connect` key: the `$default` sibling must
      // survive, so a blanket wipe cannot pass the removal assertions.
      routeSettings: {
        $default: {
          ThrottlingBurstLimit: update ? 20 : 10,
          ThrottlingRateLimit: update ? 15 : 5,
          DetailedMetricsEnabled: true,
        },
        ...(removal ? {} : { $connect: { ThrottlingBurstLimit: 4, ThrottlingRateLimit: 2 } }),
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
      // Removed on UPDATE, RETAINED by CloudFormation (#5004): StageVariables.
      // Removed on UPDATE, UNTAGGED by CloudFormation (#5390 A/B): the whole
      // map-shaped Tags block.
      ...(update ? {} : { stageVariables: { foo: 'bar' }, tags: { k1: 'v1', k2: 'v2' } }),
    });

    new cdk.CfnOutput(this, 'ApiId', { value: api.ref });
    new cdk.CfnOutput(this, 'WsApiId', { value: wsApi.ref });
    new cdk.CfnOutput(this, 'AuthorizerId', { value: authorizer.ref });
  }
}
