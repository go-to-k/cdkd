import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';

/**
 * Two integ probes for #634 items 3 + 4 — both live in one app so the
 * verify.sh can deploy + destroy them in one AWS round-trip:
 *
 *   - {@link OverrideStack} (#634 item 3): the user passes
 *     `--allow-unsupported-properties AWS::ApiGatewayV2::Api:Body` at deploy
 *     time → cdkd's routing decision keeps the resource on SDK and accepts
 *     the silent drop (warn-logged). State stamps `provisionedBy: 'sdk'`;
 *     AWS does NOT receive `Body`, so the route declared only inside it does
 *     not exist on the live API.
 *
 *   - {@link UpdateTransitionStack} (#634 item 4): a fresh deploy WITHOUT
 *     `Body` lands the HTTP API on the SDK path (state stamps
 *     `provisionedBy: 'sdk'`). A subsequent deploy where the template is
 *     defined by `Body` instead (toggled via the
 *     `CDKD_INTEG_USE_SILENT_DROP=true` env var) re-routes through CC API
 *     mid-life — state flips to `provisionedBy: 'cc-api'` and the spec's route
 *     exists on AWS. The re-route is a REPLACEMENT (the SDK-minted API is
 *     deleted by the SDK provider, the new one created by Cloud Control), not
 *     an in-place update — see "WHY A REPLACEMENT" below. The in-place
 *     mid-life flip is `sdk-to-cc-autoroute`'s arm.
 *
 * WHY `AWS::ApiGatewayV2::Api.Body` (issue #2648). Both arms are ABOUT the
 * silent-drop auto-route, so they have to key on a silent drop — the one
 * case `docs/integ-fixture-conventions.md` ("Never seed a Cloud Control
 * route from an unhandled property") allows. This fixture keyed on Lambda's
 * `RuntimeManagementConfig` until #1621 wired it; the item-3 assertion then
 * failed on correct behaviour (live, 2026-09-17). Lambda's remaining silent
 * drops cannot carry a cheap fixture (`CapacityProviderConfig` /
 * `FunctionScalingConfig` need Lambda Managed Instances capacity;
 * `PublishToLatestPublished` is refused by AWS outside Managed Instance
 * functions). `Body`'s rationale is architectural rather than backlog
 * position — cdkd models routes as explicit resources instead of adopting
 * the ImportApi path — and it is the trigger `cc-api-fallback` settled on for
 * the same reason (its stack file carries the selection rule). verify.sh's
 * step 0 reds with an actionable line if `Body` is ever SDK-wired anyway.
 *
 * WHY A REPLACEMENT. AWS refuses `Body` next to the fields it would itself
 * derive from the spec: a Cloud Control write carrying `Body` together with
 * `Name` / `ProtocolType` fails with `Redundant fields [...] provided when
 * either Body or BodyS3Location is not empty` (measured us-east-1 2026-09-24,
 * on an in-place update of an SDK-minted API; the error also named
 * read-back fields the template never set, such as `routeSelectionExpression`,
 * so an in-place update cannot be made Body-only). A Body-defined
 * API therefore declares `Body` ALONE, and moving an API onto one drops
 * `ProtocolType`, a create-only property — which makes the move a
 * replacement. Its two halves route on their own records: the delete on the
 * old `'sdk'` record, the create on the Body template's Cloud Control route.
 *
 * The item-3 template carries `Name` + `ProtocolType` + `Body` — by the rule
 * above Cloud Control presumably refuses it on create too (measured only on
 * the update), while the SDK route deploys it
 * (its CreateApi needs the first two and drops the third). That is the
 * override's real use: a user keeping a Body-bearing API on the SDK provider
 * must give it the fields CreateApi needs.
 *
 * API names and the specs' `info.title` are the same string on purpose: an
 * imported spec names the API after its title, and verify.sh's teardown
 * sweeps by name.
 */

/** Route declared ONLY inside `Body` — its presence on AWS proves `Body` landed. */
const PROBE_PATH = '/cdkd-2648-probe';

function openApiBody(title: string): Record<string, unknown> {
  return {
    openapi: '3.0.1',
    info: { title, version: '1.0' },
    paths: {
      [PROBE_PATH]: {
        get: {
          responses: { '200': { description: 'ok' } },
          // HTTP APIs accept only HTTP_PROXY / AWS_PROXY integrations (MOCK is
          // REST-only), so proxy to a public host — the route is never
          // invoked; only its EXISTENCE is asserted.
          'x-amazon-apigateway-integration': {
            type: 'http_proxy',
            httpMethod: 'GET',
            uri: 'https://example.com',
            payloadFormatVersion: '1.0',
          },
        },
      },
    },
  };
}

/**
 * #634 item 3 — `--allow-unsupported-properties` override path.
 *
 * Template ALWAYS emits `Body`. The override is supplied at the cdkd CLI
 * level (verify.sh adds the flag to deploy), so the routing keeps SDK and
 * silent-drops the property — same code path as the
 * `provider-registry-cc-routing.test.ts` unit test but verified end-to-end
 * against real AWS. `Name` and `ProtocolType` are set explicitly because the
 * SDK provider's CreateApi needs them; with `Body` dropped, nothing else
 * would name the API.
 */
export class OverrideStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const name = 'cdkd-cc-api-override-probe';
    new apigwv2.CfnApi(this, 'OverrideProbe', {
      name,
      protocolType: 'HTTP',
      // Silent-drop on cdkd's SDK Provider — the verify.sh deploys with
      // `--allow-unsupported-properties AWS::ApiGatewayV2::Api:Body` so the
      // override path fires (SDK route + accept silent drop, warn log).
      body: openApiBody(name),
    });
  }
}

/**
 * #634 item 4 — mid-life SDK→CC re-route when a silent-drop property arrives
 * after the first deploy.
 *
 * `CDKD_INTEG_USE_SILENT_DROP=true` at synth time switches the API from a
 * field-by-field definition to a `Body`-only one. The verify.sh deploys twice:
 *   1. env var unset → `Name` + `ProtocolType` → SDK route, no route on AWS
 *   2. env var set → `Body` alone (see "WHY A REPLACEMENT") → the diff
 *      replaces the API, the create half routes to CC on `Body`, state flips
 *      from `'sdk'` to `'cc-api'`, and the spec's route lands on AWS
 */
export class UpdateTransitionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const includeSilentDrop = process.env['CDKD_INTEG_USE_SILENT_DROP'] === 'true';

    const name = 'cdkd-cc-api-transition-probe';
    new apigwv2.CfnApi(
      this,
      'TransitionProbe',
      // Toggle: stage 1 of the verify.sh synth is field-by-field; stage 2 is
      // the spec alone.
      includeSilentDrop ? { body: openApiBody(name) } : { name, protocolType: 'HTTP' }
    );
  }
}
