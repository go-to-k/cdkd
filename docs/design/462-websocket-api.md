# Design: WebSocket API support in `cdkd local start-api` (#462)

Status: Draft (design, no implementation)
Issue: [#462](https://github.com/go-to-k/cdkd/issues/462)
Wave: 4 (parallel to W4-2 / W4-3)

## 1. Goal & non-goals

### Goal

Make `AWS::ApiGatewayV2::Api` with `ProtocolType: 'WEBSOCKET'` invocable by `cdkd local start-api` instead of surfacing every route as `[501 Not Implemented]`. The full happy path:

- `wscat -c ws://127.0.0.1:<port>` upgrades and the `$connect` Lambda fires with a `requestContext.connectionId` derived locally.
- Subsequent client messages are routed by the API's `RouteSelectionExpression` (the canonical AWS pattern `$request.body.action`) to the matching `$default` / custom-key Lambda.
- Handler-side calls to `apigatewaymanagementapi:PostToConnection` push messages back to the local client.
- Connection close triggers the `$disconnect` Lambda.

### In scope (v1)

- `$connect` / `$disconnect` / `$default` predefined routes.
- Custom route keys via `RouteSelectionExpression` evaluation — `$request.body.action` shape only in v1 (covers >90% of real CDK chat / push apps).
- HTTP API v2-style Lambda event payload per the WebSocket integration spec (`requestContext.connectionId`, `requestContext.routeKey`, `requestContext.eventType`, `body`, `isBase64Encoded`).
- Local `apigatewaymanagementapi:PostToConnection` emulation via an env-var endpoint override.
- In-memory connection registry keyed by a locally-generated `connectionId` (UUID v4, no AWS-shape guarantee).

### Out of scope (deferred to follow-up issues)

- **WebSocket API authorizers** (Lambda + IAM + Cognito on `$connect`) — sibling sub-item like REST/HTTP authorizers (issue #234's WebSocket-equivalent follow-up). Will land in a `cdkd local start-api` PR8b-WebSocket-equivalent.
- **Connection-ID stability across server restarts** — every restart is a fresh registry; same ephemeral-pool semantics as RIE container restarts. AWS-side connection IDs are opaque and randomly-generated per connection, so the spec doesn't promise stability either.
- **Connection-level rate limits / message-size limits** — AWS enforces 32KB frame / 128KB message / 2hr idle disconnect; local enforces none. Add an opt-in `--ws-strict-limits` later if real workloads hit this.
- **`apigatewaymanagementapi:GetConnection` / `DeleteConnection`** — low-priority API surface; add incrementally once `PostToConnection` is solid.
- **`@request.header.*` / `@request.querystring.*` route-selection expressions** — non-body-driven selection; defer to a follow-up after observing how often real apps use it.

### Won't do

- Real AWS SigV4 verification on the local `apigatewaymanagementapi` shim — the shim accepts any signed request from a container on the cdkd network. This matches the pattern in `src/local/ecs-network.ts` (the metadata-endpoints sidecar also does not verify caller identity); local-dev is not a security boundary.

## 2. Protocol upgrade handling

Node's `http.Server` accepts the `Upgrade: websocket` handshake at the socket level (via the `upgrade` event), but does NOT speak the WebSocket frame protocol. We need a frame encoder / decoder. Three options were considered:

| Option | Cost | Tradeoff |
|---|---|---|
| **A. `ws` npm library + `node:http` upgrade handler** (RECOMMEND) | One dep (~1MB), `@types/ws` for TS | Battle-tested (Express, Socket.IO, Apollo all use it). Spec-compliant. Active maintenance. Minimal API surface (`WebSocketServer({ noServer: true }).handleUpgrade(req, socket, head, cb)`). |
| **B. Roll our own WebSocket frame parser on Node's raw upgrade socket** | ~500 LOC of frame masking / fragmentation / ping-pong code | Avoids the dep but adds permanent maintenance cost on a well-understood spec. Reject. |
| **C. Bundle an external WebSocket emulator binary** | Heavy install, separate process | Zero fit for cdkd's existing single-process architecture. Reject. |

**Decision: option A.** `ws` is the de-facto Node WebSocket library; it speaks RFC 6455 and handles ping / pong / close / fragmentation. cdkd already accepts dependencies of this size (`chokidar`, `yaml`, `archiver`).

### Integration with the existing `node:http` server

Each `cdkd local start-api` server already binds via `http.createServer(...)` (or `https.createServer(...)` in mTLS mode) — see `src/local/http-server.ts`. The same server can host WebSocket APIs by listening on the `upgrade` event AND keeping the existing `request` handler for HTTP-API / REST / Function URL routes. `ws` supports this via `noServer: true` mode:

```
server.on('upgrade', (req, socket, head) => {
  if (request-path matches a WebSocket API route) {
    wsServer.handleUpgrade(req, socket, head, (ws) => { ... });
  } else {
    socket.destroy();  // unknown upgrade target -> 404 equivalent
  }
});
```

No port reservation — the WebSocket listener shares the existing HTTP port per API. The `api-server-grouping.ts` module already produces one server per API surface; the WebSocket discriminator (`ProtocolType: WEBSOCKET`) just routes upgrade-event traffic instead of request-event traffic.

## 3. Connection registry

In-memory `Map<connectionId, ConnectionEntry>` for the server's lifetime. Ephemeral by design (matches `cdkd local start-api`'s "no persistence across runs" model).

```ts
interface ConnectionEntry {
  connectionId: string;          // UUID v4 generated at $connect
  socket: ws.WebSocket;          // for send / close
  connectedAt: number;           // for diagnostics / future TTL
  apiLogicalId: string;          // namespace so two APIs do not cross-talk
  stage: string;                 // for event.requestContext.stage
  // Future: identity (for authorizer context), domainName, queryParams
}
```

Lookup paths:

- **Outbound `PostToConnection`** (handler -> client) — `registry.get(connectionId).socket.send(payload)`.
- **`$disconnect` cleanup** — socket `close` event runs `registry.delete(connectionId)` AND fires the `$disconnect` Lambda.
- **Server shutdown** — close every entry's socket with code 1001 (going away).

Tradeoff vs persistent storage (DynamoDB / Redis / file): we are local-dev. AWS-deployed APIs typically persist `connectionId` server-side to broadcast to multiple clients, but a local server with one or two dev clients does not need recovery across restarts. The ephemeral choice keeps the design ~1 module + ~100 LOC.

### `connectionId` shape

UUID v4 (`randomUUID()` from `node:crypto`). AWS's connection IDs look like `Aabc=abcDEFGhi=` (base64-ish; opaque); we do not match this shape because user code MUST treat `connectionId` as opaque per AWS docs. Documented caveat: handler code that string-matches AWS-shaped IDs (e.g. assumes a specific length / charset) will misbehave locally — but this is an anti-pattern in user code, not a cdkd bug.

## 4. Route selection

The CDK pattern: `webSocketApi.routeSelectionExpression` defaults to `'$request.body.action'`. `AWS::ApiGatewayV2::Api.RouteSelectionExpression` (CFn property) carries this verbatim. `AWS::ApiGatewayV2::Route.RouteKey` is one of:

- `$connect` (fires when the upgrade handshake succeeds)
- `$disconnect` (fires when the socket closes)
- `$default` (fires for any message whose selection-expression value matches nothing)
- A custom string (matches when `RouteSelectionExpression` evaluates to it)

### Selection algorithm (v1)

For every incoming WebSocket frame after `$connect`:

1. Parse the frame body as JSON. Non-JSON frames fall through to `$default` (matches AWS docs: "If the message is not a valid JSON, the `$default` route is invoked").
2. Evaluate the API's `RouteSelectionExpression` against the parsed body. v1 supports only the canonical `$request.body.<key>` shape and `$request.body.<key>.<nested>` (1-2 levels of nested dot access). Other expression shapes (`$request.header.*`, `$context.*`) hard-error at boot via `RouteDiscoveryError` with a clear "unsupported in v1, please file a follow-up" message — same fail-fast pattern PR8c used for non-AWS_PROXY integrations.
3. Look up the resulting string in the route map. On match, invoke that route's target Lambda. On miss, invoke `$default` if registered. On no `$default` and no match, send the AWS-equivalent error frame (`{"message":"Internal server error","connectionId":"<id>","requestId":"<id>"}`) and KEEP the socket open (AWS behavior).

### Custom route map shape

Discovery produces (per WebSocket API):

```ts
interface WebSocketDiscoveredApi {
  apiLogicalId: string;
  apiStackName: string;
  routeSelectionExpression: string;       // '$request.body.action'
  routes: {
    routeKey: string;                     // '$connect' / '$disconnect' / '$default' / 'sendMessage'
    targetLambdaLogicalId: string;
  }[];
  stage: string;
}
```

## 5. Event shape construction

Lambda event payload for each WebSocket Lambda invocation. The AWS spec varies per event type:

### `$connect`

```json
{
  "headers": { "Sec-WebSocket-Protocol": "...", "Origin": "..." },
  "multiValueHeaders": { ... },
  "queryStringParameters": { ... },
  "multiValueQueryStringParameters": { ... },
  "requestContext": {
    "routeKey": "$connect",
    "eventType": "CONNECT",
    "connectionId": "<uuid>",
    "extendedRequestId": "<uuid>",
    "requestTime": "...",
    "requestTimeEpoch": <epoch-ms>,
    "messageDirection": "IN",
    "stage": "local",
    "connectedAt": <epoch-ms>,
    "requestId": "<uuid>",
    "domainName": "localhost",
    "apiId": "local",
    "identity": { "sourceIp": "127.0.0.1", "userAgent": "..." }
  },
  "isBase64Encoded": false,
  "body": ""
}
```

- **Allow / deny on `$connect`**: handler returns `{statusCode: 200, ...}` to allow the connection, anything else (or throws) to deny. We mirror this: a non-2xx statusCode from the `$connect` Lambda response means we send a close frame with code 1008 (policy violation) and never register the connection.

### `$disconnect`

Same shape as `$connect` plus `requestContext.eventType: "DISCONNECT"`, `requestContext.routeKey: "$disconnect"`, and `requestContext.disconnectStatusCode` / `disconnectReason` populated from the WebSocket close event. Lambda response is ignored (the socket is already closed).

### `$default` and custom routes (MESSAGE event)

```json
{
  "requestContext": {
    "routeKey": "sendMessage",     // or "$default"
    "eventType": "MESSAGE",
    "connectionId": "<uuid>",
    "messageId": "<uuid>",
    "messageDirection": "IN",
    "stage": "local",
    "requestTime": "...",
    "requestTimeEpoch": <epoch-ms>,
    "apiId": "local",
    "domainName": "localhost"
  },
  "body": "<raw frame body as string OR base64>",
  "isBase64Encoded": false
}
```

### Fields cdkd populates locally vs mocks

| Field | Source | Notes |
|---|---|---|
| `connectionId` | Generated UUID v4 at `$connect` | Opaque per AWS docs |
| `requestId` / `extendedRequestId` / `messageId` | Generated UUID per event | Opaque per AWS docs |
| `requestTime` / `connectedAt` / `requestTimeEpoch` | `Date.now()` | Matches PR8a HTTP pattern |
| `stage` | Stage Name from `AWS::ApiGatewayV2::Stage` | Falls back to `'local'` when no Stage exists |
| `apiId` | `'local'` | Same mock as PR8a's HTTP API event |
| `domainName` | `'localhost'` | Same mock as PR8a |
| `identity.sourceIp` | `req.socket.remoteAddress` | Real |
| `identity.userAgent` | Upgrade-request `User-Agent` header | Real |
| `headers` / `queryStringParameters` | Parsed from upgrade `req.url` / `req.headers` | Real, lowercased per PR8a convention |
| `authorizer` | `null` in v1 | Wired when WebSocket-authorizers ship |

## 6. `@connections` API emulation

The AWS `apigatewaymanagementapi` lets handlers push messages back to connected clients:

```
POST /@connections/<connectionId>      -> send message
GET  /@connections/<connectionId>      -> get connection metadata (out of scope v1)
DELETE /@connections/<connectionId>    -> force-disconnect (out of scope v1)
```

The endpoint URL pattern is `https://<api-id>.execute-api.<region>.amazonaws.com/<stage>`. Three intercept strategies were considered:

| Option | Mechanism | Tradeoff |
|---|---|---|
| **A. Env-var endpoint override + same-port HTTP route** (RECOMMEND) | Inject `AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI=http://<container-host>:<port>` into every container; mount a `POST /@connections/<connectionId>` route on the same `node:http` server | AWS SDK v3 honors `AWS_ENDPOINT_URL_*` env vars (verified — service-specific endpoint overrides). No TLS / cert work. Reuses pattern from `src/local/ecs-network.ts`'s metadata sidecar |
| **B. DNS hijack via per-task docker network** | Resolve `*.execute-api.<region>.amazonaws.com` to a local IP, terminate TLS with a self-signed cert | Invasive. Requires CA-trust manipulation in containers. Reject |
| **C. Require user code to set `endpoint` explicitly** | User adds `new ApiGatewayManagementApiClient({ endpoint: process.env.WS_MGMT_URL })` | Bad UX. User would have to remember to gate this per environment. Reject |

**Decision: option A.** Identical pattern to how `cdkd local run-task` injects `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` for IAM emulation. The endpoint override sidesteps the URL-hash signing problem (SDK signs against the override URL, not the synthetic AWS hostname, so SigV4 still validates locally if we ever decide to check it — but for v1 we skip verification entirely).

### Same-port vs separate-port

**Recommendation: same port** (the API server's port). The `@connections` API is a sibling concern of the API itself; mounting it on the same port keeps cdkd's port budget low and avoids requiring users to remember two URLs. Distinguishing inbound `@connections/<id>` POSTs from HTTP-API routes is trivial because:

- Path starts with `/@connections/` — a reserved AWS path that user routes cannot collide with (AWS reserves `$` and `@` for control planes).
- Method is always `POST` / `GET` / `DELETE` on this prefix.

The `node:http` request handler in `http-server.ts` gets a pre-pass: if `req.url` starts with `/@connections/`, route to the management-API handler; otherwise fall through to the existing API-Gateway pipeline. The pre-pass is gated by "this server has at least one WebSocket route" so non-WebSocket servers do not allocate the path.

### Implementation sketch (handler side)

```ts
// On POST /@connections/<connectionId>:
const id = parseConnectionId(req.url);
const entry = registry.get(id);
if (!entry) return res.writeHead(410).end();   // GoneException - AWS-correct
const body = await readRequestBody(req);
entry.socket.send(body);                       // body is the raw bytes per AWS spec
res.writeHead(200).end();
```

## 7. AWS SDK endpoint injection

Per option A above, every container started by `cdkd local start-api` for a WebSocket API's handler Lambda gets:

```
AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI=http://<container-host>:<port>
```

This env-var format is the SDK v3 canonical override (one env var per service). Limitations / corner cases:

- Older SDK v2 in handler code does NOT honor `AWS_ENDPOINT_URL_*`. cdkd documents this in the help text; v2 users must set the `endpoint` parameter on the client manually. The local server cannot intercept those calls.
- `<container-host>` is the same `--container-host` flag used by HTTP-API routes (default `127.0.0.1`). For containers reaching the host's server, this must resolve to the host. On Docker Desktop / Mac / Windows, `host.docker.internal` works but Docker rejects it in `-p` mappings (PR #261 trap); we use the actual container-host bridge IP, propagated via the existing `--container-host` flag.
- `<port>` is the HTTP server's port — same as the WebSocket port, since same-port mount.

No STS / signing concerns: the local management endpoint accepts the inbound request without verifying SigV4 (won't-do per §1). The SDK still signs the request because that's what SDK v3 does unconditionally, but cdkd ignores the signature.

## 8. Container pool integration

The existing `ContainerPool` (`src/local/container-pool.ts`) is per-Lambda. WebSocket routes still map 1:1 to Lambdas (`$connect` → Fn A, `$disconnect` → Fn B, `sendMessage` → Fn C, possibly with overlap). Each Lambda invocation is short and synchronous (handler runs once per message, returns), so the warm-pool model applies unchanged. Concurrency is per-Lambda (default 2, `--per-lambda-concurrency` up to 4) — same as HTTP-API.

WebSocket connections are long-lived (the SOCKET stays open) but Lambda invocations are NOT — every frame triggers a fresh `invokeRie()` against the pool. So the pool model is a perfect fit; we do not need to keep a container "pinned" to a connection.

**One change**: container env-var injection. The `ContainerSpec.env` map already supports per-Lambda env overrides (issued at `docker run`). Add the `AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI` entry at spec build time for every Lambda backing a WebSocket route. Non-WebSocket Lambdas do not receive it (so HTTP-API handlers do not get a confusing endpoint override they would never use).

## 9. Co-existence with REST v1 / HTTP API v2 / Function URL

The `api-server-grouping.ts` module groups routes by API surface and starts one HTTP server per group. WebSocket APIs become a fourth surface kind:

```ts
type ApiKind = 'http-api' | 'rest-v1' | 'function-url' | 'websocket'  // NEW
```

Each WebSocket API gets its own server (own port, own `ContainerPool`, own connection registry). The `node:http` server has the `upgrade` event wired ONLY when at least one route on that server is a WebSocket route; non-WebSocket servers keep the pre-PR shape exactly. This isolates blast radius — a WebSocket-specific bug cannot affect a sibling HTTP API on a different server.

The `groupRoutesByServer` helper gets a new branch that emits one group per WebSocket `AWS::ApiGatewayV2::Api`, keyed by `apiLogicalId`. The `--api <id>` filter (PR #261) extends naturally: a WebSocket API logical ID is a valid filter target.

The route-discovery layer (`src/local/route-discovery.ts`) replaces the current C13 short-circuit (`unsupported.reason = 'WebSocket APIs are not supported...'`) with a new `kind: 'websocket'` branch on `DiscoveredRoute` (or a sibling `DiscoveredWebSocketApi` type — see "Open question 4"). The deferred-error path stays for any future "can't emulate this WebSocket route" subset (e.g. routes with unsupported `RouteSelectionExpression` shapes).

## 10. Implementation file plan (no code in this PR)

New files:

- `src/local/websocket-server.ts` — wires the `ws` library to the `node:http` upgrade event, owns the connection registry, dispatches incoming frames through the route selector, invokes Lambdas via the existing `ContainerPool` / `RieClient`.
- `src/local/websocket-mgmt-api.ts` — `@connections/<connectionId>` HTTP handler. Pure-functional: takes the registry + request + response, writes the response.
- `src/local/websocket-route-discovery.ts` — walks the template for `AWS::ApiGatewayV2::Api` (WebSocket) + sibling `AWS::ApiGatewayV2::Route` + `AWS::ApiGatewayV2::Integration` (AWS_PROXY only in v1) + `AWS::ApiGatewayV2::Stage` to produce `WebSocketDiscoveredApi[]`. Reuses the shared `intrinsic-lambda-arn.ts` helper for `IntegrationUri` resolution.
- `src/local/websocket-event.ts` — pure-functional event-shape builders for CONNECT / DISCONNECT / MESSAGE events.

Modified files:

- `src/local/route-discovery.ts` — drop the C13 unsupported-route short-circuit; emit a separate `WebSocketDiscoveredApi[]` alongside the HTTP `DiscoveredRoute[]`.
- `src/local/http-server.ts` — wire the WebSocket upgrade handler when at least one WebSocket API is present on this server; add the `/@connections/` HTTP pre-pass.
- `src/local/api-server-grouping.ts` — new grouping branch for WebSocket APIs.
- `src/local/container-pool.ts` — accept per-Lambda env-var overlays at spec build time (probably already supported; verify).
- `src/cli/commands/local-start-api.ts` — boot WebSocket listeners automatically when discovery yields any WebSocket API; no new CLI flag in v1.
- [docs/changelog-cdkd.md](../changelog-cdkd.md) PR 8a entry — drop the "WebSocket APIs (ProtocolType: WEBSOCKET) — never" wording; add a new entry noting WebSocket support is shipped. (Per-PR changelog entries moved here from CLAUDE.md's "Recently Implemented" section.)

New dependency: `ws` + `@types/ws`.

## 11. Test strategy (design only; no tests in this PR)

- **Unit**: route-discovery extracts the right WebSocket route map; selection-expression evaluation handles `$request.body.action` shapes including missing-key / non-JSON-body fall-through to `$default`; event builders produce the correct CONNECT / DISCONNECT / MESSAGE shapes; `@connections` handler returns 410 on missing connectionId.
- **Real-Docker integ (no AWS deploy)** at `tests/integration/local-start-api-websocket/`: CDK fixture with a WebSocket API + 3 routes (`$connect` / `$disconnect` / `sendMessage`). `verify.sh` boots the server, opens `ws://` via a Node script using `ws` as a client, asserts the `$connect` Lambda CloudWatch-like log marker, sends a `{"action":"sendMessage","body":"hi"}` frame, asserts the `sendMessage` Lambda received it, the Lambda PostsToConnection back, asserts the test client received the echo, closes the socket, asserts `$disconnect` fires. Mirrors the structure of `tests/integration/local-start-api/`.
- **No real-AWS integ** — same rationale as PR8a / PR8b: local-only behavior, AWS-deployed WebSocket APIs are a separate concern.

## 12. Open design questions

1. **Selection-expression shapes beyond `$request.body.<key>`.** Should v1 also support `$request.body.<a>.<b>` nested access? Real CDK chat apps sometimes use this for protocol versioning (`$request.body.v1.action`). RECOMMENDATION: support 1-2 levels of nested dot access in v1 (cheap to add at the parser layer); reject deeper / array-index shapes with a clear error.

2. **Lambda response handling on `$default` / custom routes.** Should we send the Lambda's response BACK to the client as a frame? AWS-deployed WebSocket APIs do NOT — they invoke the handler and discard the response; handlers MUST use `PostToConnection` to reply. RECOMMENDATION: discard the Lambda response (match AWS exactly); a non-2xx `statusCode` triggers an AWS-equivalent error frame logged at warn but socket stays open.

3. **`$connect` allow-deny on response shape.** AWS docs say a non-2xx statusCode from `$connect` rejects the connection. Should we ALSO reject when the handler throws / times out / returns a malformed response? RECOMMENDATION: yes — match the deployed-AWS behavior where any handler error fails the upgrade (close code 1011, internal error).

4. **`DiscoveredRoute` vs new `DiscoveredWebSocketApi` type.** Two structural choices: (a) extend `DiscoveredRoute` with `kind: 'websocket'` and overload `method` / `pathPattern` semantically, or (b) introduce a sibling `DiscoveredWebSocketApi` type returned alongside `DiscoveredRoute[]`. RECOMMENDATION: (b) — the WebSocket model (routeKey-keyed, not method+path-keyed) is fundamentally different from HTTP routes; conflating them in `DiscoveredRoute` complicates every downstream consumer (route matcher, route table printer, authorizer attacher) for no benefit.

5. **Hot reload (`--watch`) behavior.** When the CDK code changes a WebSocket route, should we keep the existing connections open or force-disconnect? AWS-deployed APIs do not have this concern (deploy creates a new API version). RECOMMENDATION: keep connections open against the OLD route map for in-flight messages, swap to the new map atomically (same pattern as HTTP-API hot reload), and emit a warn line naming any route whose Lambda changed. Closing connections on every reload would defeat the hot-reload UX.

6. **CLI flag for the WebSocket port** (when not same-port). Recommended same-port mount makes this moot, but if review pushes for separate ports, we would need `--ws-port <n>` / auto-alloc semantics symmetric with the existing `--port` flag. RECOMMENDATION: stick with same-port; cross-reference §6.

7. **`messageId` shape**. AWS-deployed APIs return a message-id that handler code sometimes logs for tracing. cdkd generates UUID v4. Should we make this format-match the AWS shape (looks like `<8-char>=`)? RECOMMENDATION: no — opaque per AWS docs, user code must treat it as opaque, format-matching invites buggy assumptions.

8. **Connection registry visibility**. Should `cdkd local start-api` expose a debug HTTP endpoint like `/__cdkd_debug/connections` listing live connections + their stage / age? Useful for devs but adds API surface. RECOMMENDATION: defer; add only when a real workload requests it.

## 13. Acceptance criteria (mirrors issue)

- [ ] `RouteDiscoveryError` for WebSocket APIs is gone; routes surface as `kind: 'websocket'` (or sibling type per Q4).
- [ ] `$connect` / `$disconnect` / `$default` / custom routes invoke their target Lambda with AWS-spec event shape.
- [ ] `apigatewaymanagementapi:PostToConnection` from a handler reaches the local client.
- [ ] `wscat -c ws://127.0.0.1:<port>` works end-to-end against the new integ fixture.
- [ ] [docs/changelog-cdkd.md](../changelog-cdkd.md) PR 8a entry "WebSocket APIs — never" wording removed; new shipped-feature entry added.

## 14. Related

- Wave 4 of the `cdkd local start-api` series. Parallel to W4-2 / W4-3.
- Depends on: nothing (parallel safe).
- Source pointers: `src/local/route-discovery.ts:550-580` (current rejection site), `src/cli/commands/local-start-api.ts`, `src/local/ecs-network.ts` (sidecar-endpoint precedent), `src/local/api-server-grouping.ts` (one-server-per-API), `src/local/intrinsic-lambda-arn.ts` (shared Lambda Arn resolver).
- Memory rules: `feedback_default_on_unless_semantic_change.md`, `feedback_verify_cdk_synth_shape_before_resolver.md`, `feedback_integ_first_for_new_aws_protocol.md`.
