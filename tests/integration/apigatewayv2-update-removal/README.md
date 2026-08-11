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

## Issue #609 coverage (Integration config properties)

The ten `AWS::ApiGatewayV2::Integration` properties are asserted on CREATE
(phase 1) and on UPDATE (phase 2). They **change value** across the phases
rather than being removed: the backfill wires delivery, and absent-field
removal for this group stays with the #1160 umbrella until each field has its
own live CloudFormation A/B — writing a guessed reset value over a live
integration would be strictly worse than the silent drop it replaces.

Three integrations are needed because the properties are scoped to different
integration types, which is also why `verify.sh` resolves integration ids by
`IntegrationType` instead of taking `Items[0]`.

| Property | Where it is exercised |
| --- | --- |
| `ResponseParameters` | HTTP API `HTTP_PROXY` integration; **CFn/SDK shape divergence** — see below |
| `IntegrationSubtype` | HTTP API `AWS_PROXY` service integration (`EventBridge-PutEvents`) |
| `CredentialsArn` | same; the integration's invocation role |
| `RequestTemplates` | WebSocket `MOCK` integration; template body changes in phase 2 |
| `TemplateSelectionExpression` | same |
| `PassthroughBehavior` | same; `WHEN_NO_MATCH` -> `NEVER` |
| `ContentHandlingStrategy` | same; `CONVERT_TO_TEXT` -> `CONVERT_TO_BINARY` |

The `overwrite:statuscode` `Source` is written **unquoted** (`404` / `403`) on
purpose: CFn types `ResponseParameters` as free-form `object` and coerces
scalars, so a numeric `Source` is a legal template — and this is the destination
whose value an author naturally writes as a number. The first draft of the
converter skipped non-strings and would have dropped the pair with a green
deploy.

`ConnectionType` is NOT in the table: the fixture never sets it (the API
defaults it to `INTERNET`), so nothing here would notice if it stopped being
delivered. It is pinned by the unit tests only.

`ResponseParameters` is the one property that is not a pass-through:
CloudFormation models it as `{"<status>": {ResponseParameters: [{Destination,
Source}]}}` while `CreateIntegration` / `UpdateIntegration` take the flattened
`{"<status>": {"<Destination>": "<Source>"}}`. Forwarding the CFn shape verbatim
hands the SDK serializer members it cannot model, so every response parameter
vanishes with a green deploy — the assertion reads the values back under their
`Destination` **keys**, which only passes if the fold reached AWS. The inverse
fold lives in `readCurrentState`, without which every `cdkd drift` run would
report permanent phantom drift on an untouched integration.

**Not exercised live**, covered by unit tests instead:

- `Integration.ConnectionId` — needs a live VPC Link (VPC + subnets + SG,
  minutes per run) for a plain pass-through string field

## Issue #1602 coverage (TlsConfig visibility + flat ResponseParameters)

Two pre-existing shapes that the #609 backfill made REACHABLE for the first
time. Both surface as `cdkd drift`, so the fixture's assertion for both is a
**clean `cdkd drift` run right after a deploy** (phase 1b) and again after the
update — a pre-fix binary reports drift on a stack nobody touched, and
`--revert` would then either re-push a value AWS discards or re-shape a block
forever.

| Shape | How it is exercised |
| --- | --- |
| `TlsConfig` on a PUBLIC integration | The HTTP_PROXY integration now DOES declare `TlsConfig`. `verify.sh` first asserts AWS read it back as absent (the issue's premise — if AWS ever starts honoring it, that assertion fails loudly and the scoping must be re-measured), then asserts drift stays clean. The provider declares the path drift-unknown only when `ConnectionType != VPC_LINK`, so a private integration keeps full coverage, and the discard is announced by a deploy-time warning rather than being silent. |
| flat-spelled `ResponseParameters` | A third API (`-flat`) carries an integration whose `ResponseParameters` uses the ALREADY-FLAT SDK spelling a hand-written L1 may borrow. Delivery is asserted on create and on update; `readCurrentState` now mirrors the DECLARED spelling per status code, so the baseline and the read-back compare equal. |

The flat API is separate because `int_id_by_type` requires exactly one
integration per `(api, IntegrationType)` pair and the main API's `HTTP_PROXY`
slot is taken. Its `Source` values stay strings on purpose — the flat branch is
a verbatim pass-through, so it never exercises the CFn-side scalar coercion the
main integration covers.
