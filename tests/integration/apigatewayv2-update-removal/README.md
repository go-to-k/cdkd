# apigatewayv2-update-removal

Real-AWS integ for the **ApiGatewayV2 update-field removal reset** fix
(issue [#1160](https://github.com/go-to-k/cdkd/issues/1160), apigatewayv2 batch).

Every `AWS::ApiGatewayV2::*` `Update*` API merges (an absent field = "no
change"), so a field dropped from the template must be sent with an explicit
reset value or AWS silently keeps the old one. This fixture deploys a single
HTTP API (Api + Stage + Integration + Route + REQUEST Authorizer, plus the
backing Lambda for the authorizer URI) with removable fields set, then
re-deploys under `CDKD_TEST_UPDATE=true` with those fields removed and asserts
AWS reverted each to its CloudFormation default:

| Resource | Removed field | Expected reset |
|---|---|---|
| Api | Description | empty |
| Api | CorsConfiguration | gone (via `DeleteCorsConfiguration`) |
| Api | DisableExecuteApiEndpoint | `false` |
| Api | IpAddressType | `ipv4` |
| Integration | Description | empty |
| Integration | RequestParameters | empty (per-key clear) |
| Authorizer | AuthorizerResultTtlInSeconds | `0` |
| Route | OperationName | empty |
| Stage | StageVariables | empty (per-key clear) |

Run: `/run-integ apigatewayv2-update-removal` (deploy -> UPDATE -> destroy +
orphan check). AutoDeploy-removal and the Authorizer string-field resets are
covered by the unit tests in
`tests/unit/provisioning/apigatewayv2-provider-roundtrip.test.ts`.

## Issue #609 coverage (Stage / Route config properties)

The fixture also carries a **WebSocket** API, because all five backfilled
`AWS::ApiGatewayV2::Route` properties are documented WebSocket-only — an HTTP
API cannot exercise them. Two WS routes are needed, not one: AWS rejects
`RequestParameters` anywhere but `$connect`, while the selection expressions
belong on a body-carrying route.

| Property | Where it is exercised |
| --- | --- |
| `Route.ApiKeyRequired` | WS `$connect`; removed in phase 2, must reset to `false` |
| `Route.RequestParameters` | WS `$connect`; value change in phase 2, REMOVED in phase 2b (needs `DeleteRouteRequestParameter`) |
| `Route.ModelSelectionExpression` | WS `$default`; value change |
| `Route.RouteResponseSelectionExpression` | WS `$default` |
| `Stage.AccessLogSettings` | WS stage, against a real log group; format changes in phase 2, REMOVED in phase 2b (needs `DeleteAccessLogSettings`) |
| `Stage.RouteSettings` | WS stage; throttle values change in phase 2, the `$connect` key is dropped in phase 2b while `$default` is retained |

Phase 2b (`CDKD_TEST_REMOVAL=true`) exists because `UpdateStage` / `UpdateRoute`
MERGE: live-probed 2026-08-11, a stage keeps its `AccessLogSettings` through an
update that omits the member, so only the dedicated `Delete*` APIs clear these.
It builds on the update phase rather than reverting to the baseline, so the only
delta it introduces is the removal itself.

`RouteSettings` members are written in **PascalCase** in the stack on purpose:
`CfnStage.routeSettings` is typed `any`, so CDK passes the map through
verbatim and a camelCase key would be dropped by the SDK serializer with a
perfectly green deploy.

**Not exercised live**, covered by unit tests instead:

- `Stage.ClientCertificateId` — needs a WebSocket client certificate resource
- `Stage.DeploymentId` — meaningful only with `AutoDeploy` off, and
  `AWS::ApiGatewayV2::Deployment` is not a registered cdkd type
- `Route.RequestModels` — needs `AWS::ApiGatewayV2::Model`, also unregistered
