import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Cloud Control API greenfield fallback integ fixture (issue #614).
 *
 * The HTTP API below uses the top-level CFn property `Body` (an inline
 * OpenAPI spec) which cdkd's ApiGatewayV2 SDK Provider does not wire to
 * AWS (silent-drop). Pre-#614, this would either be silently dropped
 * (pre-PR #608) or rejected at deploy-time pre-flight (post-PR #608).
 * Post-#614, the resource is auto-routed via Cloud Control API which
 * forwards the full property map to AWS — closing the silent-drop bug by
 * default.
 *
 * WHY THIS PROPERTY, and why its predecessors kept dying (issue #2473):
 * the trigger has to be a property the #609 backfill campaign will not
 * close, or the fixture reds on correct behavior the day the property is
 * SDK-wired. That has now happened three times — LoggingConfig →
 * RecursiveLoop (#718) → RuntimeManagementConfig (#1621), each
 * backfilled within weeks of the fixture pinning it. `Body`'s silent-drop
 * rationale is ARCHITECTURAL, not backlog position: "OpenAPI/Swagger
 * inline spec; routed through ImportApi, not the field-by-field
 * CreateApi path" — cdkd's provider deliberately models routes and
 * integrations as explicit resources, so wiring `Body` would mean
 * adopting the ImportApi code path, a settled design decision rather
 * than a missing call. (The one entry with an even stronger rationale,
 * Lambda's `PublishToLatestPublished` — "no AWS SDK equivalent" — was
 * tried first and AWS itself rejects it outside Managed Instance
 * functions, so it cannot ride a cheap fixture.) Should `Body` ever be
 * SDK-wired anyway, verify.sh's step-0 guard reds with a message naming
 * this selection rule instead of a misleading deploy-time assertion.
 *
 * The fixture's verify.sh asserts:
 *   (0) `Body` is still a silent-drop for AWS::ApiGatewayV2::Api in
 *       property-coverage.generated.ts (self-diagnosing guard)
 *   (a) state.resources.SilentDropApi.provisionedBy === 'cc-api'
 *   (b) the spec reached AWS: the route declared ONLY inside `Body`
 *       exists on the live API (`aws apigatewayv2 get-routes`)
 *   (c) `cdkd destroy` cleans up via the CC delete path
 */
export class CcApiFallbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Standalone IAM Role kept on the SDK Provider path so the integ
    // exercises the heterogeneous-state case (some siblings SDK, some
    // CC) from #614 §2. Not referenced by the API on purpose — it exists
    // for the routing assertion only.
    new iam.Role(this, 'FnRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole'
        ),
      ],
    });

    // HTTP API declared ENTIRELY through the inline OpenAPI `Body`
    // (silent-drop in cdkd's SDK Provider — see the class docstring).
    // With #614, this resource is auto-routed via Cloud Control API,
    // which imports the spec; the `GET /cdkd-2473-probe` route below
    // exists nowhere else in the template, so its presence on the live
    // API proves `Body` was forwarded rather than dropped.
    new apigwv2.CfnApi(this, 'SilentDropApi', {
      body: {
        openapi: '3.0.1',
        info: { title: 'cdkd-cc-api-fallback-probe', version: '1.0' },
        paths: {
          '/cdkd-2473-probe': {
            get: {
              responses: { '200': { description: 'ok' } },
              // HTTP APIs accept only HTTP_PROXY / AWS_PROXY integrations
              // (MOCK is REST-only), so proxy to a public host — the
              // route is never invoked; only its EXISTENCE is asserted.
              'x-amazon-apigateway-integration': {
                type: 'http_proxy',
                httpMethod: 'GET',
                uri: 'https://example.com',
                payloadFormatVersion: '1.0',
              },
            },
          },
        },
      },
    });
  }
}
