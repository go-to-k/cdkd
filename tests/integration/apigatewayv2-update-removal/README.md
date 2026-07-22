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
