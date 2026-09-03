---
title: local start-api
description: "Serve synthesized API Gateway routes (REST v1, HTTP API, Function URL) as long-running local HTTP servers backed by a warm Lambda container pool."
---

# `local start-api` (long-running local API server)

`cdkd local start-api` stands up a long-running HTTP server that maps
synthesized API Gateway routes (REST v1, HTTP API, Function URL) to
local Lambda invocations against the AWS Lambda Runtime Interface
Emulator. Modeled on `sam local start-api` but reusing cdkd's
synthesis, asset, and route-discovery plumbing — no `template.yaml`
round-trip.

**Requires Docker.** As with `cdkd local invoke`, the first run pulls
the Lambda base image (~600MB once per machine). Pass `--no-pull` on
subsequent runs to skip the layer check.

```bash
cdkd local start-api                              # auto-allocate one port PER discovered API
cdkd local start-api --port 3000                  # first API → 3000, second API → 3001, ...
cdkd local start-api MyAdminApi                   # logical id (single-stack apps)
cdkd local start-api MyStack/MyAdminApi           # OR: CDK Construct path (prefix-matched)
cdkd local start-api --warm                       # pre-start one container per Lambda
```

### One server per API (v0.81+)

Every discovered API surface (`AWS::ApiGatewayV2::Api`,
`AWS::ApiGateway::RestApi`, `AWS::Lambda::Url`) gets its own HTTP
server on its own port. cdkd prints one `Server listening on
http://<host>:<port>  (<API> (<kind>))` line per server at startup,
and one route table per server underneath.

This is a deliberate departure from `sam local start-api`'s
single-server-per-template model: realistic CDK apps usually define
multiple APIs (admin + public, internal + external) with different
authorizer setups, different CORS configs, and overlapping paths.
Lumping them into one server forced an awkward "first-match-wins"
semantic that didn't mirror AWS Lambda's actual routing. Pre-v0.81
versions did this.

Port assignment:

| `--port` value | Per-API port allocation |
| --- | --- |
| `0` (default) | Every server auto-allocates its own port. |
| `3000` | First API → `3000`, second API → `3001`, third → `3002`, ... |

Pass an optional positional `<target>` to launch exactly one server
for the named API. The same target syntax `cdkd local invoke` /
`cdkd local run-task` use applies here — the whole `cdkd local *`
family addresses resources consistently:

1. **Bare logical id** — `MyHttpApi`. **Single-stack apps only**;
   in multi-stack apps cdkd rejects this form with the same
   disambiguation hint `local invoke` / `local run-task` produce.
   The id is the HTTP API / REST API logical id, or (for Function
   URLs) the backing Lambda's logical id.
2. **Stack-qualified logical id** — `MyStack:MyHttpApi`. Works in
   any app size; required when the same bare id exists in two stacks.
3. **CDK Construct path / display path** — `MyStack/MyHttpApi/Resource`.
   Exact match against the resource's `aws:cdk:path` metadata.
4. **CDK Construct path prefix** — `MyStack/MyHttpApi`. Matches when
   the input is a strict ancestor of the resource's `aws:cdk:path`
   (same prefix rule `cdkd orphan` uses): CDK's
   `new apigw2.HttpApi(stack, 'MyHttpApi')` synthesizes the L1 child
   at `MyStack/MyHttpApi/Resource`, so `cdkd local start-api MyStack/MyHttpApi`
   resolves cleanly without having to type the synthesized
   `/Resource` suffix.

For Function URLs, the path forms reference the **backing Lambda's**
`aws:cdk:path`, not the auto-generated URL resource — so
`cdkd local start-api MyStack/MyHandler` matches the Function URL
declared by `new lambda.Function(this, 'MyHandler').addFunctionUrl()`.

Routes from templates without `aws:cdk:path` metadata (hand-rolled
`cfn.Resource` defs, or older CDK that didn't emit the metadata)
still match by bare logical id (form 1) and by stack-qualified logical
id (form 2) — only the path forms (3, 4) need the metadata.

**Deprecated `--api <id>` alias.** Earlier versions used a `--api`
flag for the same purpose. The flag is still accepted in this release
(emitting a deprecation warn on use) and accepts the same four forms;
it will be removed in a future major release. Migrate scripts /
CI to the positional form. Passing both positional and `--api`
at once produces an error — they're mutually exclusive.

### Discovered routes

| Source | CFn types |
| --- | --- |
| HTTP API | `AWS::ApiGatewayV2::Api` (`ProtocolType: HTTP`), `AWS::ApiGatewayV2::Route`, `AWS::ApiGatewayV2::Integration` |
| REST v1 | `AWS::ApiGateway::RestApi`, `AWS::ApiGateway::Resource`, `AWS::ApiGateway::Method`, `AWS::ApiGateway::Stage` |
| Function URL | `AWS::Lambda::Url` |

Per-route classification (boot never aborts on per-integration
unsupportedness):

| Class | Trigger | Behavior |
| --- | --- | --- |
| Normal AWS_PROXY | AWS_PROXY integration with a resolvable Lambda Arn | Dispatched to the Lambda via the container pool. |
| Synthetic CORS preflight | REST v1 `HttpMethod: OPTIONS` + `Integration.Type: MOCK` + `IntegrationResponses[].ResponseParameters` carries literal `method.response.header.*` pairs (the shape CDK's `defaultCorsPreflightOptions` synthesizes) | Captured at boot. The HTTP server returns the captured status + headers directly on OPTIONS without invoking any Lambda. |
| Streaming Function URL | `AWS::Lambda::Url` with `InvokeMode: RESPONSE_STREAM` | Dispatched via the RIE streaming protocol: the request goes out with `Lambda-Runtime-Function-Response-Mode: streaming` and the response body's JSON prelude (`{statusCode, headers, cookies?}` + an 8-NULL-byte separator + raw body) is parsed; the body Readable is piped to the HTTP client with `Transfer-Encoding: chunked`. Note: AWS's local RIE buffers the response (verified empirically against `public.ecr.aws/lambda/nodejs:20`), so curl observes the chunks in one block locally even though cdkd's pipe / chunked-encoding machinery works correctly — real incremental delivery only manifests against the deployed Lambda runtime. |
| REST v1 non-AWS_PROXY | `Integration.Type` is one of `MOCK` (non-CORS-preflight), `HTTP_PROXY`, `HTTP`, or `AWS` (Lambda non-proxy). | Dispatched via the per-kind handler in `src/local/rest-v1-integrations.ts`. MOCK / HTTP / AWS apply VTL request + response templates via the hand-rolled engine at `src/local/vtl-engine.ts`. HTTP_PROXY forwards verbatim with `RequestParameters` mappings. AWS Lambda non-proxy uses the same container pool as AWS_PROXY but transforms event payload + response via VTL and routes errors through `IntegrationResponses[].SelectionPattern`. |
| Deferred-error unsupported | REST v1 AWS integration targeting a non-Lambda service (`:s3:path/...` / `:sqs:action/...` etc.); HTTP_PROXY / HTTP with a non-literal `Uri` (cdkd does not resolve Fn::Sub / Fn::Join in HTTP Uris); HTTP API v2 service integrations (`IntegrationSubtype` set); WebSocket APIs (`ProtocolType: WEBSOCKET`); Function URLs with an unrecognized `AuthType` (anything other than `'NONE'` / `'AWS_IAM'`); routes whose Lambda Arn intrinsic cannot be resolved against the same template (cross-stack / imported references) | Boot continues. The route appears in the route table tagged `[501 Not Implemented]` and a `[warn]` line per route is printed up front. When the route is hit at request time, the HTTP server returns HTTP 501 with `{"message": "Not Implemented", "reason": "<the discovery reason>"}` in the JSON body, without invoking any Lambda. |
| Hard error | Template-structural problems the discovery layer cannot generate a meaningful route from: missing `Integration` on a Method, non-Ref `RestApiId` / `ApiId`, malformed Route `Target`, ParentId chain failures, missing `PathPart`, unresolvable `TargetFunctionArn` on a Function URL | Boot aborts via `RouteDiscoveryError` with every offending route listed in a single message. |

The deferred-error class lets you run the supported subset of an API
locally even when the CDK app contains direct AWS-service integrations,
WebSocket routes, or other unimplemented shapes — only the unsupported
routes themselves return 501; everything else dispatches as normal.

### REST v1 non-AWS_PROXY integrations

`cdkd local start-api` emulates all four non-AWS_PROXY REST v1
integration types end-to-end:

| Type | Behavior | Notes |
| --- | --- | --- |
| `MOCK` | Renders `Integration.RequestTemplates['application/json']` (VTL) to extract `{"statusCode": N}`; matches against `IntegrationResponses[].StatusCode`; renders the picked entry's `ResponseTemplates[<content-type>]` (VTL) against an empty input context (`$inputRoot = null`). | When no request template is set, defaults to the entry with no `SelectionPattern`. `ResponseParameters` header literals (`'value'`) apply; mapping expressions (`integration.response.*` / `context.*`) are warn-and-skipped. |
| `HTTP_PROXY` | Forwards the HTTP request to `Integration.Uri` with `{paramName}` path-placeholder substitution. Honors `Integration.IntegrationHttpMethod`. Applies `Integration.RequestParameters` (header `'literal'` / `method.request.header.X` mappings; querystring / path mappings are recognized but logged-and-skipped — use `{param}` URI substitution instead). | Forwards the upstream body verbatim. `IntegrationResponses[].SelectionPattern` (regex against the upstream status as a string) drives the final HTTP status; `ResponseParameters` applies. |
| `HTTP` (non-proxy) | HTTP_PROXY + VTL on both directions: `RequestTemplates[<content-type>]` transforms the body before sending; `IntegrationResponses[].ResponseTemplates[<content-type>]` transforms the upstream body before returning. | Same `RequestParameters` semantics as HTTP_PROXY. |
| `AWS` (Lambda non-proxy) | VTL request template synthesizes the Lambda event payload (parsed as JSON when the rendered template is valid JSON, otherwise passed through as a string — matches AWS-deployed behavior). The Lambda runs in the same warm RIE container pool as AWS_PROXY. Error envelope (`{errorMessage, errorType?, stackTrace?}`) routes through `SelectionPattern` against `errorMessage`. Response template runs with `$inputRoot = <parsed Lambda return value>`. | Direct AWS-service integrations (`Type: 'AWS'` with `Uri` pointing at `:s3:path/...` / `:sqs:action/...` / etc.) are NOT emulated locally — they surface as deferred-501 unsupported routes. Deploy to AWS or pin a public HTTP_PROXY to a mock service. |

The VTL engine at [src/local/vtl-engine.ts](https://github.com/go-to-k/cdkd/blob/main/src/local/vtl-engine.ts)
implements a hand-rolled minimal subset of AWS API Gateway's VTL spec.
Supported features:

- Variable references: `$var`, `${var}`, `$obj.field.subField`
- Built-ins:
  - `$input.body` — raw request body
  - `$input.json('$.path')` — JSON-stringified slice (primitives JSON-quoted)
  - `$input.path('$.path')` — native value
  - `$input.params()` — `{header, querystring, path}` union
  - `$input.params('name')` — path > query > header precedence
  - `$input.params('header').<name>` / `.querystring` / `.path`
  - `$context.requestId` / `httpMethod` / `resourcePath` / `stage`
  - `$context.identity.sourceIp` / `userAgent`
  - `$util.escapeJavaScript(s)` / `base64Encode` / `base64Decode` / `urlEncode` / `urlDecode` / `parseJson`
- Directives: `#set($var = expr)`, `#if(cond)` / `#elseif` / `#else` / `#end`, `#foreach($x in $list)` / `#end`, `##` line comments
- Operators: `&&`, `||`, `!`, `==`, `!=`, `<`, `<=`, `>`, `>=`
- JSONPath subset: `$`, `$.field`, `$.field.sub`, `$.array[index]`, quoted-string bracket keys

**Intentionally NOT supported** (any usage surfaces `VtlEvaluationError`
with the offending construct named in the message — converted to
HTTP 502 + reason JSON body at request time):

- Velocity arithmetic operators (`+ - * /`) outside literal concat
- User-defined `#macro`
- `#parse` / `#include`
- Range operator (`[1..5]`)
- `$velocityCount` and other Velocity context built-ins
- JSONPath filter expressions (`$..items`, `$.items[?(@.x > 5)]`)

### Routing precedence

3 tiers per AWS docs: full match → greedy `{proxy+}` → `$default`.
Within "full match" tier, more literal segments win as a best-effort
tie-break (AWS does not formally specify multi-route precedence within
the same tier; cdkd uses literal-segment count as a heuristic).

### Flags

| Flag | Default | Notes |
| --- | --- | --- |
| `--port <port>` | auto-allocate | First API server's port (subsequent APIs get `port+1`, `port+2`, ...). Pass `0` (default) to auto-allocate each. The actual port assignment is printed at startup. |
| `--host <host>` | `127.0.0.1` | Bind address. |
| `--api <id>` | unset | **Deprecated** — use the positional `<target>` argument instead. Same accepted forms (bare logical id, stack-qualified, Construct path, ancestor prefix). Emits a deprecation warn on use. Mutually exclusive with the positional `<target>` — passing both produces an error. Will be removed in a future major release. |
| `--stack <name>` | single-stack auto-detect | Required when the app has multiple stacks AND no other selector identifies the target. In multi-stack apps the synth stack is picked from the first match of: (1) `--stack <name>`, (2) `--from-cfn-stack <explicit-name>`, (3) the positional target's stack-name prefix (e.g. `MyStack/MyApi` → `MyStack`). |
| `--warm` | off | Pre-start one container per discovered Lambda at server boot. Trades RAM for first-request latency. |
| `--per-lambda-concurrency <n>` | `2` | Pool size cap per Lambda. Max 4 in v1; above-cap values are clamped with a warn. |
| `--no-pull` | off | Skip `docker pull`. |
| `--container-host <host>` | `127.0.0.1` | IP the host uses to bind/probe the RIE port. Must be a numeric IP — `docker run -p <ip>:<port>:8080` rejects hostnames like `host.docker.internal`. |
| `--debug-port-base <port>` | unset | Allocate a contiguous `--inspect-brk` port range across Lambdas (one per Lambda). |
| `--env-vars <file>` | unset | SAM-shape JSON: `{"LogicalId":{"KEY":"VALUE"}, "Parameters":{...}}`. Same format as `cdkd local invoke` — the function-specific key may also be a **CDK display path** (`MyStack/MyHandler`). |
| `--assume-role <arn-or-pair>` | unset | Repeatable. Bare `<arn>` = global default; `<LogicalId>=<arn>` = per-Lambda override. Per-Lambda > global > (`--assume-role-auto` OR global default) > unset (developer creds passed through). |
| `--assume-role-auto` | off | Auto-resolve EACH routed Lambda's OWN execution role per-Lambda instead of a single global default: tries the synthesized template's literal-ARN `Properties.Role`, then a deployed-state lookup (pair with `--from-state` / `--from-cfn-stack`), then warns-and-passes-through dev creds on a miss. Slower boot (one STS call per Lambda) but the right shape when each Lambda's deployed role differs. **Mutually exclusive** with the global-default `--assume-role <arn>` form (errors at boot); **compatible** with per-Lambda `--assume-role <LogicalId>=<arn>` overrides (the map wins for named Lambdas, auto-resolve handles the rest). |
| `--layer-role-arn <arn>` | — | Role to `sts:AssumeRole` before calling `lambda:GetLayerVersion` on every literal-ARN entry in `Properties.Layers`. Use only when the developer's own credentials cannot read the layer — typically a cross-account layer. AWS-published public layers (e.g. Lambda Powertools) are readable from every account and need no role. No-op for stacks whose layers are all same-stack `AWS::Lambda::LayerVersion` references. |
| `--watch` | off | Hot reload: watch the CDK app **source tree** (the synth working directory, where `cdk.json` lives) and re-synth + re-discover routes on a source edit, mirroring `cdk watch`. `cdk.out` / `node_modules` / `.git` are excluded and `cdk.json`'s `watch.include` / `watch.exclude` are honored. 500ms debounce. Synth failures keep the previous version serving (warn-and-continue, never crashes the server). |
| `--stage <name>` | first attached | Select an API Gateway Stage by `StageName`. Drives `event.stageVariables` (REST v1 + HTTP API v2). When the override doesn't match any Stage on a given API, that API's routes get `stageVariables: null` and the CLI emits a warn line up front. |
| `--from-state` | off | Read cdkd S3 state for every routed stack and substitute `Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::Join` placeholders + AWS pseudo parameters (`${AWS::AccountId}` / `${AWS::Region}` / `${AWS::Partition}` / `${AWS::URLSuffix}`) in Lambda env vars with the deployed physical IDs / attributes. Off by default — keeps the pre-PR literal-only / warn-and-drop behavior. Mirrors `cdkd local invoke --from-state` and `cdkd local run-task --from-state`. Re-runs against fresh state on every hot-reload firing (`--watch`). State load failures degrade per-stack to warn-and-fall-back so a missing or unreadable state file never aborts the server. |
| `--from-cfn-stack [cfn-stack-name]` | off | Read a deployed CloudFormation stack via `DescribeStackResources` and substitute `Ref` / `Fn::ImportValue` in Lambda env vars with the deployed physical IDs / exports. Use for CDK apps deployed via the upstream CDK CLI (`cdk deploy`). **The bare form is the typical shape** — `cdkd local start-api MyStack/MyApi --from-cfn-stack` resolves to the routed stack's CDK name (`MyStack` here) per routed stack. Pass an explicit value (`--from-cfn-stack <name>`) only when the deployed CFn stack name differs from the CDK stack name (e.g. CDK's `stackName` prop was overridden); the explicit form is rejected when more than one stack is routed in one invocation. **Mutually exclusive with `--from-state`**. `Fn::GetAtt` in a consumer Lambda's own env vars is recovered from the deployed function config (`cdk-local@0.10.0`); other `Fn::GetAtt` sites still warn-and-drop. Same semantics as `cdkd local invoke --from-cfn-stack`. |
| `--state-bucket <bucket>` | auto | S3 bucket containing cdkd state. Falls back to `CDKD_STATE_BUCKET` env or `cdk.json context.cdkd.stateBucket`, then the default `cdkd-state-{accountId}`. Only used with `--from-state`. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. Only used with `--from-state`. |
| `--stack-region <region>` | auto | Region of the state record to read. Required for `--from-state` when the same stack name has state in multiple regions. Also drives the CFn client region for `--from-cfn-stack`. |
| `--mtls-truststore <path>` | unset | PEM-encoded CA bundle for client-certificate verification. When set, the server switches from HTTP to HTTPS and the TLS handshake rejects clients whose certificate doesn't chain to one of these CAs. Must be set together with `--mtls-cert` + `--mtls-key`; partial flag sets are rejected. See the "mTLS (mutual TLS)" section below for the openssl recipe + event-shape details. |
| `--mtls-cert <path>` | unset | PEM-encoded server certificate for mutual TLS. Self-signed is fine for local dev. Must be set together with `--mtls-truststore` + `--mtls-key`. |
| `--mtls-key <path>` | unset | PEM-encoded server private key matching `--mtls-cert`. Must be set together with `--mtls-truststore` + `--mtls-cert`. |

### Hot reload (`--watch`)

When `--watch` is set, cdkd installs a [chokidar](https://github.com/paulmillr/chokidar)-backed
file watcher over the CDK app's **source tree** (the synth working
directory, where `cdk.json` lives), excluding `cdk.out` / `node_modules`
/ `.git` and honoring `cdk.json`'s `watch.include` / `watch.exclude`
(mirroring `cdk watch`). A source edit triggers a debounced (500ms
window) reload:

1. Re-run `cdk synth` (skipped when `-a <dir>` was passed at server
   boot — the directory is treated as already-synthesized).
2. Re-run route discovery, stage resolution, and CORS-config
   extraction.
3. Build per-Lambda specs + a fresh container pool.
4. Atomically swap the server state. Routes added / removed / changed
   take effect on the next request.
5. Dispose the previous pool in the background — in-flight requests
   complete against the old containers; new requests hit the new
   pool.

Synth failures during reload do NOT crash the server. The previous
version keeps serving and the CLI emits a `[warn]` line naming the
failure. Reloads serialize, so a burst of file changes coalesces to
one synth.

### CORS preflight

cdkd's HTTP server intercepts OPTIONS preflight requests for HTTP API
v2 routes whose `AWS::ApiGatewayV2::Api` has a `CorsConfiguration`:

- Match `Origin` against `AllowOrigins` (literal entries or `*`).
- Match `Access-Control-Request-Method` against `AllowMethods`.
- Match each `Access-Control-Request-Headers` entry against
  `AllowHeaders` (case-insensitive).
- Respond `204 No Content` with the canonical `Access-Control-Allow-*`
  headers, plus `Access-Control-Max-Age` / `Access-Control-Expose-Headers`
  / `Access-Control-Allow-Credentials` when configured.
- Always set `Vary: Origin` so downstream caches (browser / CDN) do
  not share the response across origins (load-bearing whenever
  `Access-Control-Allow-Origin` was derived from the request — the
  wildcard echo, literal-origin echo, and `AllowCredentials` echo
  paths all qualify).

When `AllowCredentials: true` AND the origin matched via `*`, the
response echoes the request's literal `Origin` (browser fetch spec
disallows `*` + credentials).

`Access-Control-Request-Headers` lists are validated strictly: a
malformed entry (e.g. `"Content-Type,,Authorization"` — a trailing /
embedded empty entry) rejects the preflight rather than silently
skipping the empty entry. This matches AWS's stricter HTTP API
behavior on preflight headers.

When the user has registered an explicit OPTIONS method on a path
(an `AWS::ApiGatewayV2::Route` whose `RouteKey` is `OPTIONS /...`)
**on the same API as the matched route**, preflight interception is
skipped — the user's Lambda owns the OPTIONS surface. The same-API
filter is load-bearing in multi-API stacks: an explicit OPTIONS
route on Stack B's REST v1 API at the same path no longer suppresses
preflight on Stack A's HTTP API v2.

REST v1 (`AWS::ApiGateway::*`) CORS via Mock OPTIONS methods IS
intercepted when the synthesized template matches CDK's
`defaultCorsPreflightOptions` shape: `HttpMethod: 'OPTIONS'` +
`Integration.Type: 'MOCK'` + `IntegrationResponses[].ResponseParameters`
carrying literal `method.response.header.Access-Control-Allow-*` pairs.
The headers are extracted at boot (AWS's `"'value'"` single-quote
wrappers are stripped) and the HTTP server returns the captured
status and headers directly on OPTIONS requests — no Lambda
invocation, no VTL evaluation. The default status code is 204
(matches the CDK default);
intrinsic-valued (`Fn::Sub` / `Ref` etc.) `ResponseParameters` are
dropped silently because cdkd cannot evaluate VTL locally, and if the
drop leaves zero header literals the route falls back to the deferred-
error 501 class.

Other REST v1 MOCK shapes (non-OPTIONS methods, MOCK without literal
header parameters, MOCK with VTL `RequestTemplates` that produce custom
bodies) are dispatched via the full MOCK handler — see the
"REST v1 non-AWS_PROXY integrations" section above.

### Stage variables

`event.stageVariables` is populated from the selected Stage's
`Variables` (REST v1) / `StageVariables` (HTTP API v2) map.

- **Default**: the first Stage attached to each API in template
  order.
- **`--stage <name>`**: select a Stage by `StageName`. Applied per-API
  — a `--stage prod` override against an app with three APIs picks
  the matching Stage on each. APIs without a matching Stage get
  `stageVariables: null` and surface a warn line at startup. The
  resolved stage name is threaded into `event.requestContext.stage`
  for **both** REST v1 and HTTP API v2 routes. AWS supports named
  stages on HTTP API v2 (`CreateStage` accepts any name; `$default`
  is the auto-deploy default but not the only option), so a v2
  template that pins a named Stage gets that name surfaced through
  the integration event — matching what the deployed endpoint would
  emit. v2 APIs without a templated Stage continue to use
  `'$default'`.
- **Function URL** routes don't have a Stage — `stageVariables` stays
  `null` regardless of the flag.
- **Intrinsic-valued entries** (`Ref`, `Fn::GetAtt`, `Fn::Sub`) in
  the Stage's `Variables` map are dropped with a warn (mirrors
  PR 1's env-var policy — the local server has no deploy state to
  resolve them against).

### Container lifecycle

- One pool per Lambda. Each container's RIE port is bound to its own
  free host port (`pickFreePort`); the user-facing HTTP server stays on
  the single `--port`.
- `acquire()` returns the first idle container in the pool; lazy-grows
  up to `--per-lambda-concurrency` under a per-Lambda mutex. Above the
  cap, requests queue.
- `release()` returns the container to the pool and starts a 60s idle
  timer. Idle GC fires after 60s of inactivity per pool.
- Containers are named `cdkd-local-<logicalId>-<pid>-<rand>` so an
  external sweep can mop up orphans (`docker ps --filter
  name=cdkd-local-`).

### Lambda Layers in `local start-api`

`cdkd local start-api` resolves same-stack `AWS::Lambda::LayerVersion`
references the same way `cdkd local invoke` does — see the **Lambda
Layers** section under `local invoke` above for the full rules
(supported reference shapes, last-layer-wins on file collision, the
single merged `/opt` bind mount, hard-error cases). The merge happens
once per Lambda at server boot (not per request); the merged tmpdir
is removed by the graceful shutdown path. Single-layer Lambdas skip
the copy and bind-mount the layer's asset dir directly.

### Container Lambdas (`Code.ImageUri`) in `local start-api`

`cdkd local start-api` supports `lambda.DockerImageFunction` /
`Code.ImageUri` on the same terms as `cdkd local invoke` (see the
**Container Lambdas** section under `local invoke` above). At server
boot — and on every `--watch` reload — cdkd resolves each container
Lambda's image once: **local-build** from the `cdk.out` asset
manifest when the synthesizer produced a matching `dockerImages`
entry (then `docker build` runs against the recorded build context),
or **ECR-pull** fallback when no asset matches (same-account /
same-region only, cross-account / cross-region deferred to a
follow-up). The resulting deterministic
`cdkd-local-invoke-<hash>` tag goes into the warm container pool;
the pool runs `docker run` against it verbatim — no `/var/task`
bind-mount, no base-image pull, `ImageConfig.Command` /
`ImageConfig.EntryPoint` / `ImageConfig.WorkingDirectory` /
`--platform` (from `Architectures`) all threaded through. Container
Lambdas silently ignore `Properties.Layers` (matches AWS's
invoke-time behavior — layers are baked into the image at build
time on the IMAGE branch). Hot reload (`--watch`) detects
Dockerfile / build-context changes via the content-addressed image
tag: a real source edit flips the tag at the next reload's
`docker build`, the spec signature compares unequal, and the pool
entry tears down + restarts so the next request sees the new image.

### Graceful shutdown

`SIGINT` / `SIGTERM` / `uncaughtException` / `unhandledRejection` all
run the same dispose path: drain in-flight requests, tear down every
container (tolerating per-container removal failures — logged at warn,
loop continues). The verify-time `docker ps --filter` sweep is the
defense-in-depth backstop.

Double-`^C` bypasses dispose and exits immediately so the user can
escape a hung Docker daemon. The skipped containers are reported with
the `docker ps` cleanup command in the warning.

### `local start-api` exit codes

- `0` — server started cleanly and shut down on SIGTERM.
- `1` — startup failure (Docker missing, port bind failed, route
  discovery rejected) OR uncaught exception during the run.
- `130` — exited via SIGINT.

### `local start-api` authorizers

cdkd supports four authorizer kinds in front of any discovered route:

- **Lambda TOKEN** (REST v1) — `AWS::ApiGateway::Authorizer.Type: 'TOKEN'`.
  The header named in `IdentitySource` (default
  `method.request.header.Authorization`) is forwarded to the authorizer
  Lambda as `event.authorizationToken`. The Lambda's response must carry
  a `policyDocument` with at least one `{ Effect: 'Allow', Resource:
  <methodArn> }` statement; cdkd matches `Resource` against the
  request's methodArn (literal or `*`/`?` wildcard) on every request —
  cached verdicts get re-evaluated against the new methodArn so a
  narrow-Resource Allow doesn't leak across routes. Allow → context
  flat under `event.requestContext.authorizer`. Policy-deny → HTTP 403,
  missing identity header → HTTP 401 without invoking the Lambda.
- **Lambda REQUEST** — REST v1 (`Type: 'REQUEST'`) and HTTP v2
  (`AuthorizerType: 'REQUEST'`). The full request snapshot (headers,
  query string, path parameters) is passed to the authorizer Lambda.
  HTTP v2 also accepts the simple `{ isAuthorized, context }` response
  shape in addition to the IAM-policy shape. REST v1 missing-identity →
  HTTP 401 without invoking the Lambda; HTTP v2 falls through.
- **Cognito User Pool** (REST v1) — `Type: 'COGNITO_USER_POOLS'`. The
  Bearer token from `Authorization: Bearer <token>` is verified locally
  against the user pool's published JWKS. Allow → claims under
  `event.requestContext.authorizer.claims`. Deny → HTTP 403.
- **JWT** (HTTP v2) — `AuthorizerType: 'JWT'`. Same JWKS-based
  verification, with `aud` / `client_id` matched against the
  `JwtConfiguration.Audience` allowlist. Allow → claims under
  `event.requestContext.authorizer.jwt.claims`. Deny → HTTP 401.

Authorizer results are cached per `(authorizer, identity)` for the TTL
declared by the authorizer (REST v1: `AuthorizerResultTtlInSeconds`,
default 300s, max 3600s; HTTP v2: 0 by default = no cache; JWT: cached
for `min(remaining-exp, 300s)`).

**JWKS-fetch failure → pass-through.** When the JWKS endpoint is
unreachable at startup, cdkd warns and falls back to a pass-through
mode where every Bearer token is accepted as if valid (including
malformed / non-JWT garbage — a real JWT still gets its claims
surfaced into `event.requestContext.authorizer`, a malformed token
gets a synthetic `unknown` principal and an empty claims map):

```text
[warn] [cognito-jwt] JWKS unreachable at https://cognito-idp.us-east-1.amazonaws.com/us-east-1_xyz/.well-known/jwks.json: ...
        JWT validation will allow all tokens — local dev fallback. Configure
        network access to the JWKS URL to enable real signature verification.
```

The failure entry has a short TTL (~60s) so a transient blip doesn't
lock pass-through for the full 1hr success TTL — the next minute's
request retries the JWKS fetch. The pass-through warn line itself
fires at most once per JWKS URL per server lifecycle (the warn-set
is constructed once at server startup, not per request).

This is a deliberate dev-tool tradeoff: surprising deny is worse than
warn+allow when the developer is iterating on a function and the JWKS
URL is blocked by a corporate proxy. **Do NOT rely on this in any
shared environment** — the dev's machine accepts every token, including
forged ones.

`AWS_IAM` authorization is supported with **signature-verification-only**
semantics on BOTH REST v1 (`AuthorizationType: 'AWS_IAM'`) and Function
URLs (`AuthType: 'AWS_IAM'`) — see the next section. mTLS
authorizers and any non-TOKEN/REQUEST/COGNITO_USER_POOLS Type /
non-REQUEST/JWT AuthorizerType still hard-error at discovery with the
offending route's location named.

### `local start-api` AWS_IAM authorizer (REST v1 + Function URL, signature verification only)

Routes that declare REST v1 `AuthorizationType: 'AWS_IAM'` OR Function
URL `AuthType: 'AWS_IAM'` boot and serve requests; cdkd verifies the
inbound `Authorization: AWS4-HMAC-SHA256 ...` SigV4 signature against
the developer's **local** AWS credentials (the same default credential
chain every other cdkd command uses):

1. Parse the header into `(Credential, SignedHeaders, Signature)`.
2. Reconstruct the canonical request per the AWS SigV4 spec.
3. Derive the signing key from the local secret access key + the
   request's date / region / service scope.
4. Constant-time compare the recomputed signature with the header's.

Outcomes:

- **Valid signature with the dev's credentials** → request reaches the
  handler.
  - **REST v1**: the handler sees the access-key-id as
    `event.requestContext.authorizer.principalId` (flat v1 overlay).
  - **Function URL**: NO authorizer block is synthesized. The base v2
    event's `requestContext.authorizer` stays `null`. AWS-deployed
    Function URLs write principal context under
    `event.requestContext.authorizer.iam.{accessKey, accountId, callerId,
    userArn, ...}`, and cdkd has no local IAM data plane to populate
    that block (no STS GetCallerIdentity per request, no policy
    emulation). Emitting principalId under `.lambda` would mislead
    handlers that defensive-read `.iam`, so the deployed and local
    behavior diverge only by absence of identity context — never by
    location.
- **No / malformed `Authorization` header**, **signature mismatch
  under the dev's own credentials**, or any other rejection → 403
  matching the deployed response:
  - REST v1: 403 (`{"message":"Missing Authentication Token"}`) for
    missing-identity, 403 (`{"message":"Forbidden"}`) for policy-deny —
    matches AWS-deployed API Gateway REST v1 IAM rejection (lowercase
    `message`).
  - Function URL: 403 (`{"Message":"Forbidden"}`) for both deny kinds —
    matches Lambda's deployed Function URL IAM rejection (capital
    `Message`).
- **Different `Credential` access-key-id than the dev has** →
  warn-and-pass. The local server cannot reproduce a signing key it
  doesn't have, and refusing every foreign-identity request would
  defeat the dev-tool purpose. The warn fires at most once per foreign
  access-key-id per server lifecycle.

Pass `--strict-sigv4` to opt IN to fail-closed mode — every
unverifiable signature (foreign access-key-id, missing local AWS
credentials, etc.) is denied with the same 403 the deployed API
Gateway would return. Use this when you want local parity with the
deployed signature-enforcement boundary. The default (warn-and-pass)
matches cdk-local's `cdkl start-api`.

**What is NOT verified locally** (deliberately out of scope):

- IAM resource / action / condition policy evaluation. The local
  server has no IAM data plane. Signature-verified callers reach the
  handler under their own identity; downstream authorization is the
  dev's responsibility. Use the deployed API to test the full IAM
  policy surface.
- STS temporary credentials' session-token validation against AWS.
  We accept whatever session-token the request was signed with.

At startup cdkd emits a one-line warn naming every IAM-protected
route so the developer is aware of the signature-verification-only
boundary:

```text
[warn] 2 route(s) declare AuthorizationType: AWS_IAM — cdkd local start-api
       verifies SigV4 signatures against your local AWS credentials, but does NOT
       emulate IAM policy evaluation (resource / action / condition rules).
       Signature-verified callers reach the handler under their own identity;
       downstream authorization is the dev's responsibility.
[warn]   - MyStack/ProtectedMethod
[warn]   - MyStack/AnotherProtectedMethod
```

Tooling that signs requests works out of the box — common helpers
include `aws-sigv4-sdk` (AWS SDK v3 signer), `curl --aws-sigv4`,
Postman's AWS Signature auth, and the `awscurl` CLI.

### `local start-api` VPC-config Lambdas

Lambdas with `Properties.VpcConfig` set still run locally — cdkd does
NOT block these — but the local container does NOT get attached to the
deployed VPC's subnets. Calls from the handler to private RDS /
ElastiCache / VPC-only endpoints will fail. cdkd surfaces a one-line
warn at startup naming each affected Lambda:

```text
[warn] Lambda MyVpcLambda has VpcConfig — local container will reach external
        services via the host's network, NOT through the deployed VPC's
        NAT/private subnets. Calls to private RDS/ElastiCache will fail.
```

AWS SDK calls from the container still use the developer's shell
credentials (or `--assume-role`-issued temp creds) and reach the public
AWS endpoints; nothing about that path changes.

### `local start-api` mTLS (mutual TLS)

`cdkd local start-api` supports API Gateway custom-domain mutual TLS:
when all three `--mtls-truststore <path>` / `--mtls-cert <path>` /
`--mtls-key <path>` flags are set, the server switches from plain HTTP
to HTTPS and the TLS handshake itself enforces the client-certificate
trust check against the supplied CA bundle. Clients without a cert,
with a self-signed cert, or with a cert that doesn't chain to one of
the CAs in the trust store are rejected by Node's `tls` module BEFORE
the request reaches cdkd's per-request handler — no per-request code
path is needed.

The verified client certificate is surfaced on the Lambda event under:

- **REST v1**: `event.requestContext.identity.clientCert`
- **HTTP API v2**: `event.requestContext.authentication.clientCert`

Both shapes match AWS API Gateway's deployed-mTLS event shape:

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

mTLS runs ORTHOGONALLY to the existing TOKEN / REQUEST / COGNITO_USER_POOLS
/ JWT authorizers — the TLS handshake completes first (rejecting
unknown-CA clients), then the authorizer pipeline runs against the
already-authenticated client.

**Partial flag sets are rejected at CLI parse time** (the server never
boots in a half-configured state): if any of the three flags is set,
all three must be set. Leave all three unset for plain HTTP (the
pre-PR default).

#### Generating a local CA + server + client cert with openssl

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

#### mTLS scope

- The mTLS configuration is at the SERVER level (the equivalent of an
  API Gateway custom-domain `MutualTlsAuthentication.TruststoreUri`).
  cdkd does NOT parse the synth template's `AWS::ApiGateway::DomainName`
  / `AWS::ApiGatewayV2::DomainName` resources — the CLI flags are the
  authoritative source. If your CDK app declares mTLS on a DomainName,
  you can re-use the same CA bundle locally by pointing
  `--mtls-truststore` at the file you uploaded to the deployed
  truststore S3 location.
- The server cert and key are for the LOCAL server only (clients
  connect to `localhost`). Self-signed is the typical case.
- AWS-deployed mTLS uses `MutualTlsAuthentication.TruststoreVersion`
  for live trust-store updates; the local server reads the
  `--mtls-truststore` file once at boot. Restart `cdkd local start-api`
  to pick up a new CA bundle (the `--watch` reload pipeline does NOT
  re-read the mTLS materials).

### `local start-api` v1 scope (out of scope, deferred)

| Out of scope | Deferred to |
| --- | --- |
| AWS_IAM authorizer (REST v1 + Function URL) — IAM policy evaluation (resource/action/condition). Signature verification IS implemented on both surfaces (REST v1 and Function URL). | Out of scope (the local server has no IAM data plane) |
| REST v1 AWS integration with non-Lambda service backend (`:s3:path/...` / `:sqs:action/...` / `:dynamodb:action/...` / etc.) | Future work — requires per-service SDK clients, IAM credential threading, and a per-service compatibility matrix. v1 emulates Lambda non-proxy AWS integrations only. |
| VTL features outside the supported subset (arithmetic outside literal concat, `#macro` / `#parse` / `#include`, range operator, `$velocityCount`, JSONPath filter expressions) | Surface as `VtlEvaluationError` → HTTP 502 + reason body. Hand-roll the missing feature in `src/local/vtl-engine.ts` if a real workload needs it. |
| WebSocket APIs | Never (different protocol) |
| Throttling / quotas / usage plans / API keys | Never |
| Per-Lambda concurrency above 4 | Future work if a real workload needs it |

