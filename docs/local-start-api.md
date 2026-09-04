---
title: cdkd local start-api
description: "Serve a CDK app's API Gateway routes — REST v1, HTTP API, WebSocket, Function URL — as long-running local HTTP servers backed by a warm Lambda container pool."
---

# cdkd local start-api

`cdkd local start-api` stands up long-running HTTP servers that map the API
Gateway routes in your synthesized CDK app to local Lambda invocations against
the AWS Lambda Runtime Interface Emulator. Reach for it when you want to
exercise a whole API — routing, authorizers, CORS, stage variables — against
real handler code without deploying to AWS. Each route resolves to a Lambda, an
HTTP upstream, or a response template; for a front door over running ECS
replicas, use [`cdkd local start-alb`](local-start-alb.md).

**Docker is required.** The first run pulls the Lambda base image (roughly
600 MB, once per machine); pass `--no-pull` on later runs to skip the layer
check.

```bash
cdkd local start-api                            # one server per discovered API, ports auto-allocated
cdkd local start-api --port 3000                # first API on 3000, second on 3001, ...
cdkd local start-api MyAdminApi                 # serve only the named API (single-stack apps)
cdkd local start-api MyStack/MyAdminApi         # ... or address it by CDK Construct path
cdkd local start-api --warm --watch             # pre-start containers, re-synth on source edits
cdkd local start-api --from-state --stage prod  # resolve env vars from deployed cdkd state
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[target]` | every discovered API | Serve only the named API. See [Target resolution](#target-resolution). |
| `--port <port>` | `0` (auto-allocate) | Port for the first server; later servers take `port+1`, `port+2`, and so on. |
| `--host <host>` | `127.0.0.1` | Bind address for every API server — the address **you** connect to. |
| `--stack <name>` | single-stack auto-detect | Stack to serve, when neither the target nor `--from-cfn-stack` identifies one. |
| `--warm` | off | Pre-start one container per routed Lambda at boot, trading RAM for first-request latency. |
| `--per-lambda-concurrency <n>` | `2` | Container-pool size cap per Lambda. Values above `4` are clamped to `4` with a warn. |
| `--no-pull` | off | Skip `docker pull` and use the cached base image — see [Local Execution](local-emulation.md#common-flags). |
| `--container-host <host>` | `127.0.0.1` | Numeric IP the Lambda **containers'** emulator ports bind to — not where you connect, which is `--host`. See [Local Execution](local-emulation.md#common-flags). |
| `--debug-port-base <port>` | — | Reserve a contiguous debugger port range, one port per routed Lambda. Every handler blocks until a debugger attaches. See [`--debug-port-base`](#debug-port-base). |
| `--env-vars <file>` | — | JSON env-var overrides in SAM's shape — see [Local Execution](local-emulation.md#common-flags). |
| `--assume-role <arn-or-pair>` | — | Assume an execution role and forward temporary credentials. See [`--assume-role` and `--assume-role-auto`](#assume-role-and-assume-role-auto). |
| `--assume-role-auto` | off | Resolve each routed Lambda's own execution role instead of one global default. |
| `--watch` | off | Re-synth and re-discover routes when the app source changes. See [`--watch`](#watch). |
| `--stage <name>` | first attached Stage | Select an API Gateway Stage by `StageName`, per API. See [Stage variables](#stage-variables). |
| `--api <id>` | — | Deprecated alias for the positional `[target]`; warns on use and cannot be combined with it. |
| `--layer-role-arn <arn>` | — | Role to assume before reading literal-ARN entries in `Properties.Layers`. See [Lambda layers](#lambda-layers). |
| `--from-state` | off | Substitute deployed physical ids from cdkd's S3 state into Lambda env vars. See [`--from-state`](#from-state). |
| `--from-cfn-stack [cfn-stack-name]` | off | Substitute deployed physical ids from a CloudFormation stack. See [`--from-cfn-stack`](#from-cfn-stack). |
| `--stack-region <region>` | — | Region of the state record to read, and the CloudFormation client region for `--from-cfn-stack` — see [Local Execution](local-emulation.md#common-flags). |
| `--mtls-truststore <path>` | — | PEM CA bundle that switches the server to HTTPS with client-certificate verification. See [Mutual TLS](#mutual-tls). |
| `--mtls-cert <path>` | — | PEM server certificate. Must be set together with the other two `--mtls-*` flags. |
| `--mtls-key <path>` | — | PEM server private key matching `--mtls-cert`. Must be set together with the other two `--mtls-*` flags. |
| `--strict-sigv4` | off | Deny requests whose `AWS_IAM` SigV4 signature cannot be verified. See [`--strict-sigv4`](#strict-sigv4). |
| `--verbose` | off | Verbose logging. |
| `--profile <profile>` | — | AWS profile for cdkd's own AWS calls and for the credentials handed to containers. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for cdkd's own AWS API calls, such as state and CloudFormation reads. |
| `-y`, `--yes` | off | Answer interactive prompts with the recommended response. |
| `-a`, `--app <command>` | `cdk.json` / `CDKD_APP` | CDK app command, or a pre-synthesized cloud assembly directory — see [Local Execution](local-emulation.md#common-flags). |
| `--output <path>` | `cdk.out` | Output directory for synthesis. |
| `-c`, `--context <key=value...>` | — | Set a CDK context value. Repeatable. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json`, then `cdkd-state-{accountId}` | S3 bucket holding cdkd state. Read only with `--from-state`. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. Read only with `--from-state`. |

The region used for AWS API calls is taken from `AWS_REGION`, then
`AWS_DEFAULT_REGION`, then the synthesized stack's own `env.region`. A
deprecated `--region` flag, hidden from `--help`, still overrides all three;
prefer the environment variable or your AWS profile.

## Target resolution

Passing a positional target launches exactly one server, for the named API.
The same target syntax works across `cdkd local invoke`, `cdkd local run-task`
and this command.

| Form | Example | Notes |
| --- | --- | --- |
| Bare logical id | `MyHttpApi` | Single-stack apps only; multi-stack apps are rejected with a disambiguation hint. |
| Stack-qualified logical id | `MyStack:MyHttpApi` | Works in any app; required when the same bare id exists in two stacks. |
| CDK Construct path | `MyStack/MyHttpApi/Resource` | Exact match against the resource's `aws:cdk:path` metadata. |
| Construct path prefix | `MyStack/MyHttpApi` | Matches when the input is a strict ancestor of the resource's `aws:cdk:path`. |

The logical id is the HTTP API's or REST API's own logical id. For Function
URLs it is the **backing Lambda's** logical id, and the path forms reference
the backing Lambda's `aws:cdk:path` rather than the auto-generated URL
resource — so `cdkd local start-api MyStack/MyHandler` matches the Function URL
declared by `new lambda.Function(this, 'MyHandler').addFunctionUrl()`.

The path prefix form exists because CDK synthesizes the L1 child one level
down: `new apigw2.HttpApi(stack, 'MyHttpApi')` lands at
`MyStack/MyHttpApi/Resource`, and `MyStack/MyHttpApi` resolves it without you
having to type the `/Resource` suffix.

Routes from templates with no `aws:cdk:path` metadata — hand-rolled `CfnResource`
definitions, for instance — still match by bare logical id and by
stack-qualified logical id. Only the two path forms need the metadata.

`--api <id>` is a deprecated alias accepting the same four forms. It warns on
use, cannot be combined with the positional target, and will be removed in a
future major release.

## Servers and ports

Every discovered API surface gets its own HTTP server on its own port:
`AWS::ApiGatewayV2::Api` (HTTP and WebSocket), `AWS::ApiGateway::RestApi`, and
`AWS::Lambda::Url`. cdkd prints one route table per server, then one listening
line per server:

```text
MyPublicApi (HTTP API)  (http://127.0.0.1:3000)
  GET  /items      -> ItemsHandler   (HTTP API)
  POST /admin      -> [501 Not Implemented]  (HTTP API)

Server listening on http://127.0.0.1:3000  (MyPublicApi (HTTP API))
Server listening on http://127.0.0.1:3001  (MyAdminApi (REST API))
Server listening on ws://127.0.0.1:3002/prod  (MyChatApi (WebSocket API))
^C to stop and clean up containers.
```

| `--port` value | Per-API port allocation |
| --- | --- |
| `0` (default) | Every server auto-allocates its own port. |
| `3000` | First API on `3000`, second on `3001`, third on `3002`, and so on. |

One server per API rather than one server per template is a deliberate
departure from `sam local start-api`. Real CDK apps usually define several APIs
— admin and public, internal and external — with different authorizer setups,
different CORS configuration and overlapping paths; serving them from a single
port forces a first-match-wins semantic that does not mirror AWS routing.

Changed in v0.81: earlier releases served every API from one port.

## Route discovery

### Sources

| Source | CloudFormation types |
| --- | --- |
| HTTP API | `AWS::ApiGatewayV2::Api` (`ProtocolType: HTTP`), `AWS::ApiGatewayV2::Route`, `AWS::ApiGatewayV2::Integration` |
| REST v1 | `AWS::ApiGateway::RestApi`, `AWS::ApiGateway::Resource`, `AWS::ApiGateway::Method`, `AWS::ApiGateway::Stage` |
| WebSocket API | `AWS::ApiGatewayV2::Api` (`ProtocolType: WEBSOCKET`), `AWS::ApiGatewayV2::Route`, `AWS::ApiGatewayV2::Integration` |
| Function URL | `AWS::Lambda::Url` |

### Per-route classification

Boot never aborts because one integration is unsupported. Each discovered route
lands in one of these classes:

| Class | Trigger | Behaviour |
| --- | --- | --- |
| AWS_PROXY | `AWS_PROXY` integration with a resolvable Lambda ARN | Dispatched to the Lambda through the container pool. |
| Synthetic CORS preflight | REST v1 `OPTIONS` method with a `MOCK` integration whose `IntegrationResponses[].ResponseParameters` carry literal `method.response.header.*` pairs | Captured at boot; the server answers `OPTIONS` with the captured status and headers, invoking no Lambda. |
| Streaming Function URL | `AWS::Lambda::Url` with `InvokeMode: RESPONSE_STREAM` | Dispatched over the emulator's streaming protocol and piped to the client with `Transfer-Encoding: chunked`. See [Streaming Function URLs](#streaming-function-urls). |
| REST v1 non-AWS_PROXY | `Integration.Type` is `MOCK` (not a CORS preflight), `HTTP_PROXY`, `HTTP`, or `AWS` | Dispatched by the matching per-kind handler. See [REST v1 integration types](#rest-v1-integration-types). |
| Unsupported integration | An integration shape cdkd does not emulate | Boot continues. The route is tagged `[501 Not Implemented]` in the route table, a warn line names it up front, and a request to it returns HTTP 501 without invoking any Lambda. |
| Hard error | A template-structural problem discovery cannot build a route from | Boot aborts, with every offending route listed in one message. |

A route lands in the unsupported class when it is:

- A REST v1 `AWS` integration targeting a non-Lambda service (`:s3:path/...`,
  `:sqs:action/...`, and so on).
- An `HTTP_PROXY` or `HTTP` integration whose `Uri` is not a literal — cdkd
  does not resolve `Fn::Sub` / `Fn::Join` inside integration URIs.
- An HTTP API v2 service integration (one that sets `IntegrationSubtype`).
- A Function URL with an `AuthType` other than `NONE` or `AWS_IAM`.
- A route whose Lambda ARN intrinsic cannot be resolved against the same
  template, such as a cross-stack or imported reference.

The 501 body names the reason:

```json
{ "message": "Not Implemented", "reason": "<the discovery reason>" }
```

Boot aborts only for structural problems: a Method with no `Integration`, a
non-`Ref` `RestApiId` / `ApiId`, a malformed Route `Target`, a broken
`ParentId` chain, a missing `PathPart`, or an unresolvable
`TargetFunctionArn` on a Function URL.

### Routing precedence

Matching runs in three tiers, following the AWS documented order:

1. Full match on the request path.
2. Greedy `{proxy+}` match.
3. `$default`.

Within the full-match tier, the route with more literal path segments wins.
AWS does not formally specify precedence between two routes in the same tier,
so cdkd uses literal-segment count as the tie-break.

### Streaming Function URLs

A Function URL with `InvokeMode: RESPONSE_STREAM` is invoked with
`Lambda-Runtime-Function-Response-Mode: streaming`. cdkd parses the response
body's JSON prelude (`{statusCode, headers, cookies?}`, an eight-NULL-byte
separator, then the raw body) and pipes the body to the HTTP client with
`Transfer-Encoding: chunked`.

The local emulator buffers the handler's response, so `curl` observes the whole
body in one block locally even though the chunked pipe works correctly.
Incremental delivery only shows up against the deployed Lambda runtime.

## REST v1 integration types

All four non-`AWS_PROXY` REST v1 integration types are emulated end to end.

| Type | One-line summary |
| --- | --- |
| `MOCK` | Answers from templates alone; no upstream call. |
| `HTTP_PROXY` | Forwards the request to `Integration.Uri`, body unchanged. |
| `HTTP` | `HTTP_PROXY` plus VTL in both directions. |
| `AWS` (Lambda non-proxy) | Builds the Lambda event from a VTL template and transforms the return value. |

### `MOCK`

Renders `Integration.RequestTemplates['application/json']` to extract
`{"statusCode": N}`, matches it against `IntegrationResponses[].StatusCode`,
then renders that entry's `ResponseTemplates[<content-type>]` against an empty
input context. With no request template, the entry carrying no
`SelectionPattern` is used. Literal `ResponseParameters` headers apply; mapping
expressions (`integration.response.*` / `context.*`) are skipped with a warn.

### `HTTP_PROXY`

Forwards the request to `Integration.Uri` with `{paramName}` path substitution,
honouring `Integration.IntegrationHttpMethod`. The body is forwarded verbatim.
`IntegrationResponses[].SelectionPattern` — a regex matched against the upstream
status as a string — drives the final status, and `ResponseParameters` applies.
Header mappings (`'literal'` / `method.request.header.X`) apply; querystring and
path mappings are recognized but skipped, so use `{param}` URI substitution
instead.

### `HTTP`

`HTTP_PROXY` plus VTL in both directions: `RequestTemplates[<content-type>]`
transforms the outgoing body, and
`IntegrationResponses[].ResponseTemplates[<content-type>]` transforms the
upstream body. `RequestParameters` behaves exactly as under `HTTP_PROXY`.

### `AWS` (Lambda non-proxy)

The VTL request template builds the Lambda event payload — parsed as JSON when
the rendered template is valid JSON, and otherwise passed through as a string,
matching deployed behaviour. The Lambda runs in the same warm container pool as
`AWS_PROXY`. The error envelope (`{errorMessage, errorType?, stackTrace?}`)
routes through `SelectionPattern` matched against `errorMessage`, and the
response template runs with `$inputRoot` bound to the parsed Lambda return
value.

`AWS` integrations pointing at a non-Lambda service are not emulated; they
surface as unsupported 501 routes. Deploy to AWS, or point an `HTTP_PROXY`
integration at a mock service.

### VTL support

cdkd implements a minimal subset of API Gateway's VTL:

- **Variable references** — `$var`, `${var}`, `$obj.field.subField`.
- **Request input** — `$input.body`, `$input.json('$.path')` (JSON-stringified
  slice, primitives JSON-quoted), `$input.path('$.path')` (native value),
  `$input.params()` (the `{header, querystring, path}` union),
  `$input.params('name')` (path, then query, then header), and
  `$input.params('header').<name>` / `.querystring` / `.path`.
- **Context** — `$context.requestId` / `httpMethod` / `resourcePath` / `stage`,
  and `$context.identity.sourceIp` / `userAgent`.
- **Utilities** — `$util.escapeJavaScript`, `base64Encode`, `base64Decode`,
  `urlEncode`, `urlDecode`, `parseJson`.
- **Directives** — `#set($var = expr)`, `#if` / `#elseif` / `#else` / `#end`,
  `#foreach($x in $list)` / `#end`, and `##` line comments.
- **Operators** — `&&`, `||`, `!`, `==`, `!=`, `<`, `<=`, `>`, `>=`.
- **JSONPath subset** — `$`, `$.field`, `$.field.sub`, `$.array[index]`, and
  quoted-string bracket keys.

Anything outside that subset raises a VTL evaluation error naming the offending
construct, which the server returns as HTTP 502 with the reason in the body.
See [Limitations](#limitations) for the list.

### Outbound integration URIs

`HTTP` and `HTTP_PROXY` integrations whose `Uri` points at a well-known
internal address — the EC2 instance metadata service, loopback, link-local, or
an RFC 1918 range — get a warn line at boot naming the destination, once per
URI. cdkd does not block the request; the warn is there so a mistyped or
malicious template URI is visible before it runs in CI.

## WebSocket APIs

An `AWS::ApiGatewayV2::Api` with `ProtocolType: WEBSOCKET` gets its own server,
listening on `ws://<host>:<port>/<stage>` (`wss://` under mutual TLS). The
stage comes from the API's `AWS::ApiGatewayV2::Stage`, falling back to `local`
when the template declares none.

The connection lifecycle mirrors the deployed one: the upgrade fires the
`$connect` route's Lambda, each subsequent client message is routed by the
API's `RouteSelectionExpression`, and the socket closing fires `$disconnect`.
Only `$request.body.<key>` selection expressions are supported, optionally
dot-nested (`$request.body.action.version`).

Handler-side `PostToConnection` calls work against the local server. cdkd
injects into every WebSocket Lambda's container:

- `AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI`, pointing at
  `http://host.docker.internal:<port>/<stage>` — the same shape the deployed
  endpoint has, so handlers that build the client explicitly from
  `domainName` + `stage` and handlers that let the SDK read the env var both
  work unchanged.
- Placeholder credentials and a region when neither is already set, because the
  SDK client refuses to instantiate without them. cdkd's local `@connections`
  handler does not verify signatures, so the values are opaque.
- A `host.docker.internal` host mapping, so the URL resolves on native Linux
  Docker as well as Docker Desktop.

That mapping needs Docker 20.10 or newer. When at least one WebSocket API will
attach, cdkd probes the Docker server version once at boot and fails with an
explicit message on an older daemon.

Two cases leave an API discovered but not served, each with a warn line naming
it: an API where any route sets `AuthorizationType` to something other than
`NONE` (WebSocket authorizers are not emulated, and admitting unauthenticated
clients would diverge from deployed behaviour), and an API with no
Lambda-backed routes cdkd can resolve. A malformed WebSocket API is reported
the same way and does not stop sibling APIs from booting.

`--watch` does not hot-reload WebSocket servers — restart the command to pick
up a route or Lambda change. On shutdown every live socket receives close
frame 1001 before the containers are torn down.

## CORS preflight

### HTTP API v2

For routes on an `AWS::ApiGatewayV2::Api` carrying a `CorsConfiguration`, the
server answers `OPTIONS` preflights itself:

- `Origin` is matched against `AllowOrigins` (literal entries or `*`).
- `Access-Control-Request-Method` is matched against `AllowMethods`.
- Each `Access-Control-Request-Headers` entry is matched against `AllowHeaders`,
  case-insensitively.
- A match returns `204 No Content` with the canonical `Access-Control-Allow-*`
  headers, plus `Access-Control-Max-Age`, `Access-Control-Expose-Headers` and
  `Access-Control-Allow-Credentials` when configured.
- `Vary: Origin` is always set, so browser and CDN caches never share a
  response across origins.

When `AllowCredentials: true` and the origin matched via `*`, the response
echoes the request's literal `Origin` — the browser fetch spec disallows `*`
together with credentials.

`Access-Control-Request-Headers` lists are validated strictly: a malformed entry
such as `Content-Type,,Authorization` rejects the preflight rather than
silently skipping the empty element, matching HTTP API's behaviour.

Interception is skipped when you have registered an explicit `OPTIONS` route
(an `AWS::ApiGatewayV2::Route` with a `RouteKey` of `OPTIONS /...`) **on the
same API** — your Lambda owns the `OPTIONS` surface. The same-API scoping
matters in multi-API apps: an explicit `OPTIONS` route on one stack's REST API
does not suppress preflight handling on another stack's HTTP API at the same
path.

### REST v1

REST v1 CORS via Mock `OPTIONS` methods is intercepted when the synthesized
template matches the shape CDK's `defaultCorsPreflightOptions` produces:
`HttpMethod: 'OPTIONS'`, `Integration.Type: 'MOCK'`, and
`IntegrationResponses[].ResponseParameters` carrying literal
`method.response.header.Access-Control-Allow-*` pairs.

The headers are extracted at boot, with AWS's `"'value'"` single-quote wrappers
stripped, and the server returns the captured status and headers directly on
`OPTIONS` — no Lambda invocation and no VTL evaluation. The default status is
`204`, matching CDK's default.

Intrinsic-valued `ResponseParameters` (`Fn::Sub`, `Ref`, and so on) are dropped,
because they cannot be evaluated locally. If the drop leaves no header literals
at all, the route falls back to the unsupported 501 class.

Other REST v1 `MOCK` shapes — non-`OPTIONS` methods, `MOCK` without literal
header parameters, `MOCK` with VTL request templates producing custom bodies —
go through the full MOCK handler described in
[REST v1 integration types](#rest-v1-integration-types).

## Stage variables

`event.stageVariables` is populated from the selected Stage's `Variables` map
(REST v1) or `StageVariables` map (HTTP API v2), and the resolved stage name is
threaded into `event.requestContext.stage`.

| Situation | Result |
| --- | --- |
| No `--stage` | The first Stage attached to each API, in template order. |
| `--stage <name>` | The Stage whose `StageName` matches, resolved per API — one override picks the matching Stage on each of several APIs. |
| `--stage <name>` with no match on an API | That API's routes get `stageVariables: null` and a warn line at startup. |
| API with no templated Stage (HTTP API v2) | `requestContext.stage` stays `$default`. |
| Function URL route | No Stage exists, so `stageVariables` stays `null` regardless of the flag. |

Intrinsic-valued entries (`Ref`, `Fn::GetAtt`, `Fn::Sub`) in a Stage's
`Variables` map are dropped with a warn — the local server has no deployed
state to resolve them against.

## Authorizers

Four authorizer kinds run in front of any discovered route.

| Kind | Declared as | Identity source |
| --- | --- | --- |
| Lambda TOKEN (REST v1) | `AWS::ApiGateway::Authorizer` with `Type: 'TOKEN'` | The header named by `IdentitySource`, defaulting to `method.request.header.Authorization`, forwarded as `event.authorizationToken`. |
| Lambda REQUEST | `Type: 'REQUEST'` (REST v1) or `AuthorizerType: 'REQUEST'` (HTTP v2) | The full request snapshot — headers, query string, path parameters. |
| Cognito User Pool (REST v1) | `Type: 'COGNITO_USER_POOLS'` | `Authorization: Bearer <token>`, verified against the pool's published JWKS. |
| JWT (HTTP v2) | `AuthorizerType: 'JWT'` | `Authorization: Bearer <token>`, verified against the issuer's JWKS, with `aud` / `client_id` matched against `JwtConfiguration.Audience`. |

What each one does with the verdict:

| Kind | On allow | On deny |
| --- | --- | --- |
| Lambda TOKEN (REST v1) | Context flattened under `event.requestContext.authorizer`. | HTTP 403 on a policy deny; HTTP 401 without invoking the Lambda when the identity header is missing. |
| Lambda REQUEST | Context under `event.requestContext.authorizer`. | REST v1 returns HTTP 401 without invoking the Lambda when identity is missing; HTTP v2 falls through. |
| Cognito User Pool (REST v1) | Claims under `event.requestContext.authorizer.claims`. | HTTP 403. |
| JWT (HTTP v2) | Claims under `event.requestContext.authorizer.jwt.claims`. | HTTP 401. |

A TOKEN authorizer's response must carry a `policyDocument` with at least one
`{ Effect: 'Allow', Resource: <methodArn> }` statement. cdkd matches `Resource`
against the request's method ARN — literally, or with `*` / `?` wildcards — on
every request, and re-evaluates cached verdicts against the new method ARN, so
a narrow-`Resource` Allow does not leak across routes.

A REQUEST authorizer on an HTTP API v2 route may answer in either shape: the
IAM-style `policyDocument`, or API Gateway's simple format
`{ "isAuthorized": true|false, "context": { ... } }`. cdkd reads the simple
format when `isAuthorized` is a boolean and falls back to the policy parse
otherwise.

Any other `Type` or `AuthorizerType` is a hard error at discovery, with the
offending route's location named.

### Result caching

Authorizer results are cached per authorizer and identity, for the TTL the
authorizer declares.

| Authorizer | Cache TTL |
| --- | --- |
| REST v1 | `AuthorizerResultTtlInSeconds`, default 300s, maximum 3600s |
| HTTP v2 | 0 by default, meaning no caching |
| JWT | `min(remaining exp, 300s)` |

### JWKS pass-through fallback

When the JWKS endpoint is unreachable, cdkd warns and falls back to accepting
every Bearer token as valid. A real JWT still gets its claims surfaced into
`event.requestContext.authorizer`; a malformed token gets a synthetic `unknown`
principal and an empty claims map.

```text
[warn] [cognito-jwt] JWKS unreachable at https://cognito-idp.us-east-1.amazonaws.com/us-east-1_xyz/.well-known/jwks.json: ...
        JWT validation will allow all tokens — local dev fallback. Configure
        network access to the JWKS URL to enable real signature verification.
```

The failure entry has a short TTL of about 60s, so a transient network blip does
not lock pass-through in for the full success TTL — the next minute's request
retries the fetch — and warns again when it fails again, so a proxy that stays
down keeps saying so rather than going quiet after the first request.

This is a deliberate trade for a dev tool: a surprising deny is worse than a
warn plus allow when you are iterating on a handler and a corporate proxy is
blocking the JWKS URL. **Do not rely on it in any shared environment** — the
machine running the server accepts every token, forged ones included.

## AWS_IAM authorization

Routes declaring REST v1 `AuthorizationType: 'AWS_IAM'` or Function URL
`AuthType: 'AWS_IAM'` boot and serve requests. cdkd verifies the inbound
`Authorization: AWS4-HMAC-SHA256 ...` signature against your **local** AWS
credentials, using the same credential chain every other cdkd command uses:

1. Parse the header into its `Credential`, `SignedHeaders` and `Signature` parts.
2. Reconstruct the canonical request per the SigV4 spec.
3. Derive the signing key from the local secret access key and the request's
   date, region and service scope.
4. Compare the recomputed signature with the header's in constant time.

Signature verification is the whole of it — **IAM policy evaluation is not
emulated**. At startup cdkd names every IAM-protected route so the boundary is
visible:

```text
[warn] 2 route(s) declare AuthorizationType: AWS_IAM — cdkd local start-api
       verifies SigV4 signatures against your local AWS credentials, but does NOT
       emulate IAM policy evaluation (resource / action / condition rules).
       Signature-verified callers reach the handler under their own identity;
       downstream authorization is the dev's responsibility.
[warn]   - MyStack/ProtectedMethod
[warn]   - MyStack/AnotherProtectedMethod
```

Tooling that signs requests works out of the box: the AWS SDK v3 signer,
`curl --aws-sigv4`, Postman's AWS Signature auth, and `awscurl`.

### Verification outcomes

| Outcome | REST v1 | Function URL |
| --- | --- | --- |
| Valid signature under your credentials | Request reaches the handler; the access key id appears as `event.requestContext.authorizer.principalId` | Request reaches the handler; `requestContext.authorizer` stays `null` |
| Missing or malformed `Authorization` header | HTTP 403 `{"message":"Missing Authentication Token"}` | HTTP 403 `{"Message":"Forbidden"}` |
| Signature mismatch under your own credentials | HTTP 403 `{"message":"Forbidden"}` | HTTP 403 `{"Message":"Forbidden"}` |
| `Credential` names an access key id you do not hold | Warn and pass through, once per access key id per server run | Warn and pass through, once per access key id per server run |

The response bodies match the deployed services, down to the lowercase
`message` on API Gateway REST v1 and the capitalized `Message` on Lambda
Function URLs.

For Function URLs no authorizer block is synthesized at all. AWS-deployed
Function URLs write principal context under
`event.requestContext.authorizer.iam.{accessKey, accountId, callerId, userArn, ...}`,
and cdkd has no local IAM data plane to fill it. Emitting a `principalId` under
`.lambda` would mislead handlers that defensively read `.iam`, so local and
deployed behaviour differ only by the absence of identity context, never by its
location.

The warn-and-pass default exists because the local server cannot reproduce a
signing key it does not hold, and refusing every foreign-identity request would
defeat the purpose of a dev tool.

### `--strict-sigv4`

Opts in to fail-closed mode. Every unverifiable signature — a foreign access
key id, or no local AWS credentials at all — is denied with the same 403 the
deployed API would return. Use it when you want local parity with the deployed
signature-enforcement boundary.

## Mutual TLS

Setting all three of `--mtls-truststore`, `--mtls-cert` and `--mtls-key`
switches the server from HTTP to HTTPS and makes the TLS handshake itself
enforce the client-certificate trust check against the supplied CA bundle.
Clients with no certificate, a self-signed certificate, or one that does not
chain to a CA in the trust store are rejected before the request reaches any
cdkd request handler.

Partial flag sets are rejected at parse time, so the server never boots half
configured: set all three, or none. mTLS runs orthogonally to the TOKEN,
REQUEST, Cognito and JWT authorizers — the handshake completes first, then the
authorizer pipeline runs against the already-authenticated client.

### Client certificate on the event

The verified client certificate is surfaced on the Lambda event under
`event.requestContext.identity.clientCert` (REST v1) or
`event.requestContext.authentication.clientCert` (HTTP API v2). Both match API
Gateway's deployed shape:

```json
{
  "clientCertPem": "-----BEGIN CERTIFICATE-----\n...",
  "subjectDN": "CN=client,O=example,C=US",
  "issuerDN": "CN=My CA,O=example,C=US",
  "serialNumber": "01:23:45:...",
  "validity": {
    "notBefore": "May 22 03:30:00 2026 GMT",
    "notAfter": "May 22 03:30:00 2027 GMT"
  }
}
```

### Generating a local CA and certificates

```bash
# 1. Create a local CA
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout ca-key.pem -out ca.pem \
  -subj "/CN=cdkd-local-ca" -days 365

# 2. Generate a server cert signed by the local CA
openssl req -newkey rsa:2048 -nodes \
  -keyout server-key.pem -out server-csr.pem \
  -subj "/CN=localhost"
openssl x509 -req -in server-csr.pem \
  -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
  -out server-cert.pem -days 365

# 3. Generate a client cert signed by the local CA
openssl req -newkey rsa:2048 -nodes \
  -keyout client-key.pem -out client-csr.pem \
  -subj "/CN=client"
openssl x509 -req -in client-csr.pem \
  -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
  -out client-cert.pem -days 365

# 4. Start the server with mTLS enabled
cdkd local start-api \
  --mtls-truststore ca.pem \
  --mtls-cert server-cert.pem \
  --mtls-key server-key.pem

# 5. curl the server with the client cert
curl --cacert ca.pem \
  --cert client-cert.pem --key client-key.pem \
  https://localhost:<port>/items
```

The server certificate and key are for the local server only, so a self-signed
pair is the normal case. The CLI flags are the authoritative configuration:
cdkd does not read `AWS::ApiGateway::DomainName` or
`AWS::ApiGatewayV2::DomainName` mTLS settings out of the template. If your CDK
app declares mTLS on a domain name, point `--mtls-truststore` at the same CA
bundle you uploaded to the deployed trust store.

## Environment variables and credentials

### `--env-vars`

A JSON file in SAM's shape:
`{"LogicalId": {"KEY": "VALUE"}, "Parameters": {...}}`. The function-specific
key may also be a CDK display path such as `MyStack/MyHandler`. The format is
shared with [`cdkd local invoke`](local-invoke.md); explicit overrides win over
values recovered from deployed state.

### `--from-state`

Reads cdkd's S3 state for every routed stack and substitutes `Ref`,
`Fn::GetAtt`, `Fn::Sub` and `Fn::Join` placeholders — plus the AWS pseudo
parameters `${AWS::AccountId}`, `${AWS::Region}`, `${AWS::Partition}` and
`${AWS::URLSuffix}` — in Lambda env vars with the deployed physical ids and
attributes. Turn it on for stacks already deployed with `cdkd deploy`.

Off by default, in which case unresolvable placeholders are dropped with a
warn. A state load failure degrades per stack to the same warn-and-fall-back
path, so a missing or unreadable state file never aborts the server. With
`--watch`, state is re-read on every reload.

Use `--stack-region` when the same stack name has state in more than one
region, and `--state-bucket` / `--state-prefix` when the state does not live at
the default location.

### `--from-cfn-stack`

Reads a deployed CloudFormation stack through `ListStackResources` and
substitutes `Ref` and `Fn::ImportValue` in Lambda env vars with the deployed
physical ids and exports. Use it for CDK apps deployed with the upstream CDK
CLI.

The bare form is the typical shape — `cdkd local start-api MyStack/MyApi
--from-cfn-stack` resolves to the routed stack's CDK name per routed stack.
Pass an explicit value only when the deployed CloudFormation stack name differs
from the CDK stack name, for instance because CDK's `stackName` prop was
overridden; the explicit form is rejected when more than one stack is routed in
one invocation.

`--from-cfn-stack` is mutually exclusive with `--from-state`.
`--stack-region` sets the CloudFormation client region. A consumer Lambda's own
`Fn::GetAtt` env vars are recovered from the deployed function configuration;
`Fn::GetAtt` at other sites is dropped with a warn.

### `--assume-role` and `--assume-role-auto`

By default the containers inherit your developer credentials. `--assume-role`
assumes an execution role instead and forwards the STS-issued temporary
credentials into the container, in two forms:

| Form | Effect |
| --- | --- |
| `--assume-role <arn>` | A single global default ARN used for every routed Lambda. |
| `--assume-role <LogicalId>=<arn>` | A per-Lambda override. Repeatable. |

`--assume-role-auto` resolves **each** routed Lambda's own execution role
instead of using one global default: it tries the synthesized template's
literal-ARN `Properties.Role`, then a deployed-state lookup (pair it with
`--from-state` or `--from-cfn-stack`), then warns and passes the developer
credentials through on a miss. Boot is slower — one STS call per Lambda — but
it is the right shape when each Lambda's deployed role differs.

`--assume-role-auto` is mutually exclusive with the global-default
`--assume-role <arn>` form and errors at boot. It is compatible with per-Lambda
`--assume-role <LogicalId>=<arn>` overrides: the map wins for the Lambdas it
names, auto-resolution handles the rest.

Precedence, highest first:

1. A per-Lambda `--assume-role <LogicalId>=<arn>` entry.
2. `--assume-role-auto`, or the global `--assume-role <arn>` default.
3. Unset — the developer's own credentials are passed through.

## Container lifecycle

- One container pool per Lambda. Each container's emulator port is bound to its
  own free host port; the user-facing HTTP server stays on its single port.
- Acquiring a container returns the first idle one in the pool, growing the pool
  lazily up to `--per-lambda-concurrency` under a per-Lambda mutex. Above the
  cap, requests queue.
- Releasing a container returns it to the pool and starts a 60-second idle
  timer; the pool's idle collector tears it down when it expires.
- Containers are named `cdkd-local-<logicalId>-<pid>-<random>`, so an external
  sweep can find strays with `docker ps --filter name=cdkd-local-`.

## Lambda layers

Same-stack `AWS::Lambda::LayerVersion` references resolve exactly as they do
for [`cdkd local invoke`](local-invoke.md), which documents the supported
reference shapes, the last-layer-wins rule on file collisions, the single
merged `/opt` bind mount, and the hard-error cases.

The merge happens once per Lambda at server boot rather than per request, and
the merged temporary directory is removed by the shutdown path. A single-layer
Lambda skips the copy and bind-mounts the layer's asset directory directly.

`--layer-role-arn` names a role to assume before calling
`lambda:GetLayerVersion` on literal-ARN entries in `Properties.Layers`. Use it
only when your own credentials cannot read the layer, which in practice means a
cross-account layer; AWS-published public layers such as Lambda Powertools are
readable from every account and need no role. It is a no-op for stacks whose
layers are all same-stack references.

## Container image Lambdas

`lambda.DockerImageFunction` and `Code.ImageUri` are supported. At server boot —
and on every `--watch` reload — cdkd resolves each container Lambda's image
once:

- **Local build**, from the `cdk.out` asset manifest when the synthesizer
  produced a matching `dockerImages` entry. `docker build` then runs against the
  recorded build context.
- **ECR pull**, when no asset matches. The ECR client is built for the image
  URI's own region, so cross-region works. Cross-account works only when the
  repository policy grants your identity directly: this command has no
  `--ecr-role-arn`, so to assume a role first use
  [`cdkd local invoke`](local-invoke.md#container-image-lambdas).

The resulting deterministic `cdkd-local-invoke-<hash>` tag goes into the warm
pool, which runs it verbatim: no `/var/task` bind mount, no base-image pull, and
`ImageConfig.Command`, `ImageConfig.EntryPoint`, `ImageConfig.WorkingDirectory`
and the `--platform` derived from `Architectures` all threaded through.

Container Lambdas ignore `Properties.Layers`, matching AWS — layers are baked
into the image at build time. `--watch` detects Dockerfile and build-context
changes through the content-addressed tag: a real source edit flips the tag at
the next reload's `docker build`, the pool entry tears down and restarts, and
the next request sees the new image.

## VPC-config Lambdas

A Lambda with `Properties.VpcConfig` set still runs locally — cdkd does not
block it — but the container is **not** attached to the deployed VPC's subnets.
Calls from the handler to a private RDS instance, ElastiCache cluster or
VPC-only endpoint will fail. Each affected Lambda gets a warn line at startup:

```text
[warn] Lambda MyVpcLambda has VpcConfig — local container will reach external
        services via the host's network, NOT through the deployed VPC's
        NAT/private subnets. Calls to private RDS/ElastiCache will fail.
```

AWS SDK calls from the container still use your shell credentials, or the
temporary credentials `--assume-role` issued, and reach the public AWS
endpoints; nothing about that path changes.

## `--debug-port-base`

`--debug-port-base <port>` allocates one debugger port per distinct Lambda —
`port`, `port+1`, `port+2`, in discovery order — and sets
`NODE_OPTIONS=--inspect-brk=0.0.0.0:<port>` on that Lambda's container.

Two things to know before reaching for it:

- The set is **every** Lambda the run touches, not just route handlers:
  authorizer Lambdas and WebSocket-route Lambdas take ports from the same range,
  in the same order.
- `--inspect-brk` **suspends the process until a debugger attaches**, so a
  request to a Node Lambda hangs until you connect to that Lambda's port.
  `NODE_OPTIONS` is inert on the other runtimes, which are unaffected.

Nothing prints the per-Lambda assignment, so debug one API at a time and count
from the base in discovery order. Containers start lazily unless you pass
`--warm`, so the port is not listening until the first request arrives.

## `--watch`

With `--watch`, cdkd watches the CDK app's **source tree** — the synth working
directory, where `cdk.json` lives — excluding `cdk.out`, `node_modules` and
`.git`, and honouring `cdk.json`'s `watch.include` / `watch.exclude`, the same
way `cdk watch` does. A source edit triggers a reload on a 500 ms debounce:

1. Re-run `cdk synth`. This step is skipped when `-a <dir>` named a
   pre-synthesized directory at boot.
2. Re-run route discovery, stage resolution and CORS-config extraction.
3. Build fresh per-Lambda specs and a fresh container pool.
4. Atomically swap the server state. Added, removed and changed routes take
   effect on the next request.
5. Dispose the previous pool in the background — in-flight requests finish
   against the old containers, new requests hit the new pool.

A synth failure during reload does not crash the server: the previous version
keeps serving and a warn line names the failure. Reloads serialize, so a burst
of file changes coalesces into one synth. WebSocket servers and the mTLS
materials are not reloaded; restart the command to pick those up.

## Graceful shutdown

`SIGINT`, `SIGTERM`, an uncaught exception and an unhandled rejection all run
the same dispose path: stop the watcher, drain in-flight requests, close every
server, dispose every container pool, and remove the temporary directories cdkd
materialized for inline code, merged layers and synthesized profile
credentials. A per-container removal failure is logged at warn and the loop
continues.

A second `Ctrl-C` bypasses dispose and exits immediately, so you can escape a
hung Docker daemon. The warning names the containers that were skipped along
with the `docker ps` command to clean them up.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The server shut down cleanly on `SIGTERM`. |
| `1` | Startup failure — Docker missing or too old, port bind failed, route discovery rejected the template — or an uncaught exception during the run. |
| `130` | Exited via `SIGINT` (`Ctrl-C`), including the immediate second-`Ctrl-C` exit. |

The full cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

## Limitations

- IAM resource, action and condition policy evaluation is not emulated. The
  local server has no IAM data plane, so signature-verified callers reach the
  handler under their own identity and downstream authorization is up to you.
  Use the deployed API to test the full IAM policy surface.
- STS temporary credentials' session tokens are not validated against AWS —
  whatever session token the request was signed with is accepted.
- REST v1 `AWS` integrations targeting a non-Lambda service (`:s3:path/...`,
  `:sqs:action/...`, `:dynamodb:action/...`) are not emulated; the route
  returns 501. Only Lambda non-proxy `AWS` integrations are supported.
- `HTTP` and `HTTP_PROXY` integrations need a literal `Uri`; intrinsics in the
  URI are not resolved.
- HTTP API v2 service integrations (those setting `IntegrationSubtype`) are not
  emulated.
- These VTL features raise an evaluation error, returned as HTTP 502 with the
  offending construct named: arithmetic operators outside literal concatenation,
  user-defined `#macro`, `#parse` / `#include`, the range operator (`[1..5]`),
  `$velocityCount` and other Velocity context built-ins, and JSONPath filter
  expressions (`$..items`, `$.items[?(@.x > 5)]`).
- WebSocket authorizers are not emulated; an API with a non-`NONE`
  `AuthorizationType` on any route accepts no upgrade requests.
- WebSocket `RouteSelectionExpression` support is limited to
  `$request.body.<key>` shapes. Header, context and array-index selections are
  rejected.
- WebSocket servers are not hot-reloaded by `--watch`; restart to pick up route
  or Lambda changes.
- The mTLS trust store is read once at boot. Restart the command to pick up a
  new CA bundle — the deployed `MutualTlsAuthentication.TruststoreVersion`
  live-update mechanism has no local equivalent.
- Container image Lambdas fall back to an ECR pull only within the same account
  and region.
- Throttling, quotas, usage plans and API keys are not emulated.
- Per-Lambda concurrency is capped at 4.

## Related

- [Local Execution](local-emulation.md) — the `cdkd local` family, Docker
  requirements, and the flags shared across every subcommand
- [`cdkd local invoke`](local-invoke.md) — one-shot Lambda invocation, layers,
  container images, and asset resolution
- [`cdkd local start-alb`](local-start-alb.md) — a local Application Load
  Balancer in front of ECS and Lambda backing services
- [`cdkd local start-cloudfront`](local-start-cloudfront.md) — a local
  CloudFront distribution over S3 origins, Lambda Function URLs and Lambda@Edge
- [`cdkd local run-task`](local-run-task.md) — run one ECS task definition
  locally
- [CLI Reference](cli-reference.md) — every command and the full exit-code table
