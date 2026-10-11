---
title: cdkd local start-api
description: "Serve the API Gateway REST, HTTP and WebSocket APIs and the Lambda Function URLs in your CDK app on localhost, backed by local Lambda containers."
---

# cdkd local start-api

`cdkd local start-api` serves the API Gateway APIs and Lambda Function URLs in
your CDK app on localhost. Each request runs the route's Lambda in a local
container. Use it to exercise a whole API, including routing, authorizers,
CORS and stage variables, against real handler code without deploying.

For a load balancer in front of ECS services, use
[`cdkd local start-alb`](local-start-alb.md).

## Serve an API

Given an HTTP API with one route in `MyStack`:

```ts
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';

const api = new apigwv2.HttpApi(this, 'MyPublicApi');
api.addRoutes({
  path: '/items',
  methods: [apigwv2.HttpMethod.GET],
  integration: new HttpLambdaIntegration('Items', itemsHandler),
});
```

start the server on a fixed port:

```bash
cdkd local start-api --port 3000
```

cdkd prints the routes it found and where it is listening:

```text
MyPublicApi (HTTP API)  (http://127.0.0.1:3000)
  GET  /items      to ItemsHandler  (HTTP API)

Server listening on http://127.0.0.1:3000  (MyPublicApi (HTTP API))
^C to stop and clean up containers.
```

Call it from another terminal:

```bash
curl http://127.0.0.1:3000/items
```

The first request to a route starts its container, so it is slower than the
ones after it. More invocations:

```bash
cdkd local start-api                            # every API, ports chosen for you
cdkd local start-api MyStack/MyAdminApi         # only this API
cdkd local start-api --warm --watch             # start containers up front, reload on source edits
cdkd local start-api --from-state --stage prod  # deployed values, the prod stage's variables
cdkd local start-api --env-vars overrides.json  # point variables at local endpoints
```

Docker is required. See [Local Execution](local-emulation.md#requirements).

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[target]` | every API found | Serve only this API. See [Target resolution](#target-resolution). |
| `--port <port>` | `0` (auto) | Port for the first server. Later servers take `port+1`, `port+2`, and so on. |
| `--host <host>` | `127.0.0.1` | Address the servers bind to. This is the address you connect to. |
| `--stack <name>` | the only stack | Stack to serve, when neither the target nor `--from-cfn-stack` names one. |
| `--stage <name>` | first Stage of each API | API Gateway Stage to take stage variables from. See [Stage variables](#stage-variables). |
| `--warm` | off | Start one container per Lambda at boot, so the first request is fast. |
| `--per-lambda-concurrency <n>` | `2` | Most containers per Lambda. Values above `4` are lowered to `4` with a warning. |
| `--watch` | off | Re-synthesize and reload routes when the app source changes. See [`--watch`](#watch). |
| `--debug-port-base <port>` | — | Give each Lambda a Node debugger port. See [`--debug-port-base`](#debug-port-base). |
| `--assume-role <arn-or-pair>` | — | Run handlers under an execution role. See [`--assume-role` and `--assume-role-auto`](#assume-role-and-assume-role-auto). |
| `--assume-role-auto` | off | Run each Lambda under its own execution role. |
| `--layer-role-arn <arn>` | — | Role to assume before downloading a layer named by ARN. |
| `--mtls-truststore <path>` | — | PEM CA bundle. Turns on HTTPS with client-certificate checks. See [Mutual TLS](#mutual-tls). |
| `--mtls-cert <path>` | — | PEM server certificate. Required with the other two `--mtls-*` flags. |
| `--mtls-key <path>` | — | PEM server private key. Required with the other two `--mtls-*` flags. |
| `--strict-sigv4` | off | Deny an `AWS_IAM` request whose signature cannot be verified. See [`--strict-sigv4`](#strict-sigv4). |
| `--api <id>` | — | Deprecated alias for `[target]`. Warns, and cannot be combined with it. |

It also accepts every [common flag](local-emulation.md#common-flags).
`--container-host` is the IP the Lambda containers' ports bind to, which is
separate from `--host`. `--no-pull` skips pulling the Lambda base image.

## Target resolution

With no target, every API in the app is served. A target serves exactly one.

| Form | Example | Notes |
| --- | --- | --- |
| Bare logical ID | `MyHttpApi` | Single-stack apps only. |
| Stack-qualified logical ID | `MyStack:MyHttpApi` | Works in any app. Required when two stacks share a logical ID. |
| CDK construct path | `MyStack/MyHttpApi/Resource` | Exact match on the resource's construct path. |
| Construct path prefix | `MyStack/MyHttpApi` | Matches the resource below it, so `/Resource` can be left off. |

For a Function URL, name the Lambda behind it. `cdkd local start-api
MyStack/MyHandler` serves the URL created by
`new lambda.Function(this, 'MyHandler').addFunctionUrl()`.

A path form also selects the stack, so `--stack` is not needed with it. A
stack inside a CDK `Stage` is reached as `MyStage/MyStack/MyHttpApi`.

A template with no construct-path metadata, such as one built from hand-written
`CfnResource` definitions, matches by the two logical-ID forms only.

## Servers and ports

Each API gets its own server on its own port: every HTTP API, REST API,
WebSocket API and Function URL.

| `--port` | Ports used |
| --- | --- |
| `0` (default) | Each server picks a free port. |
| `3000` | First API on `3000`, second on `3001`, third on `3002`, and so on. |

```text
Server listening on http://127.0.0.1:3000  (MyPublicApi (HTTP API))
Server listening on http://127.0.0.1:3001  (MyAdminApi (REST API))
Server listening on ws://127.0.0.1:3002/prod  (MyChatApi (WebSocket API))
```

`sam local start-api` serves every API from one port. cdkd does not, because
two APIs in one app often have overlapping paths and different authorizers.

Changed in v0.81: earlier releases served every API from one port.

## Which routes are served

Routes are read from these resource types:

| API kind | CloudFormation types |
| --- | --- |
| HTTP API | `AWS::ApiGatewayV2::Api` (`ProtocolType: HTTP`), `AWS::ApiGatewayV2::Route`, `AWS::ApiGatewayV2::Integration` |
| REST v1 | `AWS::ApiGateway::RestApi`, `AWS::ApiGateway::Resource`, `AWS::ApiGateway::Method`, `AWS::ApiGateway::Stage` |
| WebSocket API | `AWS::ApiGatewayV2::Api` (`ProtocolType: WEBSOCKET`), `AWS::ApiGatewayV2::Route`, `AWS::ApiGatewayV2::Integration` |
| Function URL | `AWS::Lambda::Url` |

One unsupported route does not stop the server. Each route is handled by its
kind:

| Route | What the server does |
| --- | --- |
| `AWS_PROXY` integration with a Lambda in the same template | Invokes the Lambda. |
| REST v1 `OPTIONS` method with a `MOCK` integration and literal CORS headers | Answers the preflight itself. See [CORS preflight](#cors-preflight). |
| Function URL with `InvokeMode: RESPONSE_STREAM` | Invokes the Lambda in streaming mode. See [Streaming Function URLs](#streaming-function-urls). |
| REST v1 `MOCK`, `HTTP_PROXY`, `HTTP` or `AWS` integration | Emulates the integration. See [REST v1 integration types](#rest-v1-integration-types). |
| An integration cdkd does not emulate | Returns HTTP 501. The route table shows `[501 Not Implemented]` and a warning names the route at boot. |
| A route the template does not fully define | Boot fails, listing every such route in one message. |

### Routes that return 501

- A REST v1 `AWS` integration that targets a service other than Lambda
  (`:s3:path/...`, `:sqs:action/...`, `:dynamodb:action/...`).
- An `HTTP_PROXY` or `HTTP` integration whose `Uri` is not a literal string.
  Intrinsics in an integration URI are not resolved.
- An HTTP API service integration (one that sets `IntegrationSubtype`).
- A Function URL with an `AuthType` other than `NONE` or `AWS_IAM`.
- A route whose Lambda cannot be found in the same template, such as a
  cross-stack or imported function.

The 501 body gives the reason:

```json
{ "message": "Not Implemented", "reason": "<the discovery reason>" }
```

### Templates that stop the server from booting

A Method with no `Integration`, a `RestApiId` or `ApiId` that is not a `Ref`, a
malformed Route `Target`, a broken `ParentId` chain, a missing `PathPart`, an
unresolvable `TargetFunctionArn` on a Function URL, or an authorizer of an
unsupported type.

### Routing precedence

A request is matched in the order AWS documents:

1. An exact match on the path.
2. A greedy `{proxy+}` match.
3. `$default`.

Among exact matches, the route with more literal path segments wins.

### Streaming Function URLs

A Function URL with `InvokeMode: RESPONSE_STREAM` is invoked in streaming mode
and its body is sent to the client with `Transfer-Encoding: chunked`.

The local emulator buffers the handler's response, so `curl` receives the
whole body at once. Incremental delivery is visible only against the deployed
function.

## REST v1 integration types

| Type | What the server does |
| --- | --- |
| `MOCK` | Answers from the templates alone. No upstream call. |
| `HTTP_PROXY` | Forwards the request to `Integration.Uri` with the body unchanged. |
| `HTTP` | As `HTTP_PROXY`, with VTL templates applied to the request and the response. |
| `AWS` (Lambda) | Builds the Lambda event from a VTL template and transforms the return value. |

### `MOCK`

The request template (`RequestTemplates['application/json']`) is rendered to
get `{"statusCode": N}`. That status selects the `IntegrationResponses` entry,
whose response template is rendered as the body. With no request template, the
entry with no `SelectionPattern` is used.

Literal `ResponseParameters` headers are applied. Mapping expressions
(`integration.response.*`, `context.*`) are skipped with a warning.

### `HTTP_PROXY` and `HTTP`

The request goes to `Integration.Uri`, with `{param}` placeholders filled from
the path and the method taken from `IntegrationHttpMethod`. The upstream
status, matched as a string against each `SelectionPattern`, selects the
response.

| `RequestParameters` mapping | Supported |
| --- | --- |
| A header from `'literal'` or `method.request.header.X` | Yes |
| A querystring or path mapping | No. Use `{param}` in the URI. |

`HTTP` also renders `RequestTemplates[<content-type>]` over the outgoing body
and `ResponseTemplates[<content-type>]` over the upstream body.

An integration URI that points at the EC2 instance metadata service, loopback,
a link-local address or a private (RFC 1918) range gets a warning at boot, once
per URI. The request is not blocked.

### `AWS` (Lambda non-proxy)

The request template builds the event. It is parsed as JSON when the rendered
text is valid JSON, and passed as a string otherwise.

A Lambda error (`{errorMessage, errorType?, stackTrace?}`) selects the
response by matching `SelectionPattern` against `errorMessage`. The response
template runs with `$inputRoot` set to the Lambda's return value.

### VTL support

cdkd implements part of API Gateway's VTL:

| Area | Supported |
| --- | --- |
| Variables | `$var`, `${var}`, `$obj.field.subField` |
| Request input | `$input.body`, `$input.json('$.path')`, `$input.path('$.path')`, `$input.params()`, `$input.params('name')`, `$input.params('header').<name>` (also `.querystring`, `.path`) |
| Context | `$context.requestId`, `httpMethod`, `resourcePath`, `stage`, `$context.identity.sourceIp`, `userAgent` |
| Utilities | `$util.escapeJavaScript`, `base64Encode`, `base64Decode`, `urlEncode`, `urlDecode`, `parseJson` |
| Directives | `#set`, `#if` / `#elseif` / `#else` / `#end`, `#foreach` / `#end`, `##` comments |
| Operators | `&&`, `\|\|`, `!`, `==`, `!=`, `<`, `<=`, `>`, `>=` |
| JSONPath | `$`, `$.field`, `$.field.sub`, `$.array[index]`, quoted bracket keys |

`$input.params('name')` looks in the path, then the query string, then the
headers.

Anything else returns HTTP 502 with the offending construct named in the body.
That includes arithmetic outside literal concatenation, `#macro`, `#parse`,
`#include`, the range operator (`[1..5]`), `$velocityCount` and other Velocity
built-ins, and JSONPath filters (`$..items`, `$.items[?(@.x > 5)]`).

## WebSocket APIs

A WebSocket API gets its own server at `ws://<host>:<port>/<stage>` (`wss://`
under mutual TLS). The stage is the API's `AWS::ApiGatewayV2::Stage`, or
`local` when the template declares none.

```bash
npx wscat -c ws://127.0.0.1:3002/prod
```

Connecting invokes the `$connect` route's Lambda. Each message is routed by the
API's `RouteSelectionExpression`, and closing the socket invokes
`$disconnect`. Only `$request.body.<key>` expressions are supported, optionally
nested (`$request.body.action.version`).

A handler's `PostToConnection` calls reach the local server. cdkd sets
`AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI` in every WebSocket Lambda to
`http://host.docker.internal:<port>/<stage>`, and supplies placeholder
credentials and a region when none are set, so the SDK client can be created.
This needs Docker 20.10 or newer; an older daemon fails at boot with a message
saying so.

| Situation | Result |
| --- | --- |
| Any route sets `AuthorizationType` other than `NONE` | The API is not served, with a warning. WebSocket authorizers are not emulated. |
| No route has a Lambda cdkd can resolve | The API is not served, with a warning. |
| The API is malformed | Reported with a warning. Other APIs still boot. |
| `--watch` reload | WebSocket servers are not reloaded. Restart the command. |
| Shutdown | Every open socket receives close code 1001. |

## CORS preflight

### HTTP API

For an HTTP API with a `CorsConfiguration`, the server answers `OPTIONS`
preflights itself:

| Request header | Checked against |
| --- | --- |
| `Origin` | `AllowOrigins` (literal entries or `*`) |
| `Access-Control-Request-Method` | `AllowMethods` |
| Each `Access-Control-Request-Headers` entry | `AllowHeaders`, case-insensitively |

A match returns `204 No Content` with the `Access-Control-Allow-*` headers,
plus `Max-Age`, `Expose-Headers` and `Allow-Credentials` when configured.
`Vary: Origin` is always set.

- With `AllowCredentials: true` and a `*` match, the response echoes the
  request's `Origin`, because browsers reject `*` with credentials.
- A malformed header list such as `Content-Type,,Authorization` rejects the
  preflight.
- If the same API declares its own `OPTIONS` route, the server does not
  intercept and your Lambda answers. An `OPTIONS` route on a different API
  does not affect this one.

### REST v1

The preflight CDK's `defaultCorsPreflightOptions` generates is recognized: an
`OPTIONS` method with a `MOCK` integration whose `ResponseParameters` carry
literal `method.response.header.Access-Control-Allow-*` values. The server
returns those headers and the captured status (`204` by default) without
invoking a Lambda.

Intrinsic-valued header parameters are dropped. If none are left, the route
returns 501. Any other `MOCK` shape goes through the
[`MOCK` handler](#mock).

## Stage variables

`event.stageVariables` comes from the selected Stage's `Variables` (REST v1)
or `StageVariables` (HTTP API), and the stage name is set on
`event.requestContext.stage`.

| Situation | Result |
| --- | --- |
| No `--stage` | The first Stage attached to each API, in template order. |
| `--stage <name>` | The Stage with that `StageName`, looked up on each API. |
| `--stage <name>` matches nothing on an API | That API's routes get `stageVariables: null`, with a warning at startup. |
| HTTP API with no Stage in the template | `requestContext.stage` is `$default`. |
| Function URL | `stageVariables` is always `null`. |

Intrinsic-valued stage variables (`Ref`, `Fn::GetAtt`, `Fn::Sub`) are dropped
with a warning.

## Authorizers

| Kind | Declared as | Identity read from |
| --- | --- | --- |
| Lambda TOKEN (REST v1) | `AWS::ApiGateway::Authorizer` with `Type: 'TOKEN'` | The header named by `IdentitySource`, `Authorization` by default, passed as `event.authorizationToken`. |
| Lambda REQUEST | `Type: 'REQUEST'` (REST v1) or `AuthorizerType: 'REQUEST'` (HTTP API) | The whole request: headers, query string, path parameters. |
| Cognito User Pool (REST v1) | `Type: 'COGNITO_USER_POOLS'` | `Authorization: Bearer <token>`, verified against the pool's JWKS. |
| JWT (HTTP API) | `AuthorizerType: 'JWT'` | `Authorization: Bearer <token>`, verified against the issuer's JWKS, with `aud` / `client_id` checked against `JwtConfiguration.Audience`. |

| Kind | On allow | On deny |
| --- | --- | --- |
| Lambda TOKEN (REST v1) | Context under `event.requestContext.authorizer`. | 403 on a policy deny. 401, without invoking the Lambda, when the header is missing. |
| Lambda REQUEST | Context under `event.requestContext.authorizer`. | REST v1 returns 401 without invoking the Lambda when identity is missing. HTTP API falls through. |
| Cognito User Pool (REST v1) | Claims under `event.requestContext.authorizer.claims`. | 403. |
| JWT (HTTP API) | Claims under `event.requestContext.authorizer.jwt.claims`. | 401. |

Any other authorizer type stops the server at boot, naming the route.

A TOKEN authorizer must return a `policyDocument` with at least one
`{ Effect: 'Allow', Resource: <methodArn> }` statement. `Resource` is matched
against each request's method ARN, literally or with `*` / `?` wildcards. A
cached verdict is checked again against each new method ARN, so an Allow for
one route does not carry over to another.

A REQUEST authorizer on an HTTP API may return either a `policyDocument` or
the simple format `{ "isAuthorized": true, "context": { ... } }`.

### Result caching

| Authorizer | Cached for |
| --- | --- |
| REST v1 | `AuthorizerResultTtlInSeconds`: default 300s, maximum 3600s |
| HTTP API Lambda | Not cached by default |
| JWT | The token's remaining lifetime, at most 300s |

### When the JWKS endpoint is unreachable

> [!WARNING]
> If cdkd cannot fetch the JWKS, it accepts every Bearer token, forged ones
> included. Do not expose the server to anyone else while this warning is
> showing.

```text
[warn] [cognito-jwt] JWKS unreachable at https://cognito-idp.us-east-1.amazonaws.com/us-east-1_xyz/.well-known/jwks.json: ...
        JWT validation will allow all tokens — local dev fallback. Configure
        network access to the JWKS URL to enable real signature verification.
```

A real JWT still has its claims passed to the handler. A malformed token gets
the principal `unknown` and no claims. cdkd retries the fetch about a minute
later and warns again each time it fails.

## AWS_IAM authorization

Routes with REST v1 `AuthorizationType: 'AWS_IAM'` or Function URL
`AuthType: 'AWS_IAM'` are served. cdkd checks the request's SigV4 signature
against your local AWS credentials.

> [!IMPORTANT]
> Only the signature is checked. IAM policies are not evaluated, so any caller
> with a valid signature reaches the handler. Test resource, action and
> condition rules against the deployed API.

```bash
curl --aws-sigv4 "aws:amz:us-east-1:execute-api" \
  --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  http://127.0.0.1:3000/protected
```

Any SigV4 client works: the AWS SDK signer, `curl --aws-sigv4`, Postman's AWS
Signature auth, `awscurl`. At startup cdkd lists the protected routes:

```text
[warn] 2 route(s) declare AuthorizationType: AWS_IAM — cdkd local start-api
       verifies SigV4 signatures against your local AWS credentials, but does NOT
       emulate IAM policy evaluation (resource / action / condition rules).
       Signature-verified callers reach the handler under their own identity;
       downstream authorization is the dev's responsibility.
[warn]   - MyStack/ProtectedMethod
[warn]   - MyStack/AnotherProtectedMethod
```

### Verification outcomes

| Request | REST v1 | Function URL |
| --- | --- | --- |
| Valid signature under your credentials | Reaches the handler. The access key ID is `event.requestContext.authorizer.principalId`. | Reaches the handler. `requestContext.authorizer` is `null`. |
| Missing or malformed `Authorization` header | 403 `{"message":"Missing Authentication Token"}` | 403 `{"Message":"Forbidden"}` |
| Signature does not match | 403 `{"message":"Forbidden"}` | 403 `{"Message":"Forbidden"}` |
| Signed with an access key you do not hold | Passed through with a warning, once per key per run | Passed through with a warning, once per key per run |

The bodies match the deployed services, including the capital `M` on Function
URLs.

A deployed Function URL puts the caller's identity under
`event.requestContext.authorizer.iam`. Locally that block is absent, so a
handler that reads `.iam` sees no identity.

A session token is not validated. Whatever token the request was signed with
is accepted.

### `--strict-sigv4`

cdkd cannot verify a signature made with a key it does not hold, so by default
it lets such a request through with a warning. `--strict-sigv4` denies it with
the 403 the deployed API would return. It also denies every signed request
when you have no local AWS credentials.

## Mutual TLS

Pass all three `--mtls-*` flags to serve HTTPS and require a client
certificate that chains to your CA bundle. A client with no certificate, or one
that does not chain to it, is rejected during the TLS handshake. Passing only
some of the three flags is an error.

::: steps
1. Create a local CA

   ```bash
   openssl req -x509 -newkey rsa:2048 -nodes \
     -keyout ca-key.pem -out ca.pem \
     -subj "/CN=cdkd-local-ca" -days 365
   ```

2. Create a server certificate signed by it

   ```bash
   openssl req -newkey rsa:2048 -nodes \
     -keyout server-key.pem -out server-csr.pem \
     -subj "/CN=localhost"
   openssl x509 -req -in server-csr.pem \
     -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
     -out server-cert.pem -days 365
   ```

3. Create a client certificate signed by it

   ```bash
   openssl req -newkey rsa:2048 -nodes \
     -keyout client-key.pem -out client-csr.pem \
     -subj "/CN=client"
   openssl x509 -req -in client-csr.pem \
     -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
     -out client-cert.pem -days 365
   ```

4. Start the server

   ```bash
   cdkd local start-api --port 3000 \
     --mtls-truststore ca.pem \
     --mtls-cert server-cert.pem \
     --mtls-key server-key.pem
   ```

5. Call it with the client certificate

   ```bash
   curl --cacert ca.pem \
     --cert client-cert.pem --key client-key.pem \
     https://localhost:3000/items
   ```
:::

The handler receives the verified certificate at
`event.requestContext.identity.clientCert` (REST v1) or
`event.requestContext.authentication.clientCert` (HTTP API):

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

- Authorizers still run, after the handshake.
- cdkd does not read mTLS settings from `AWS::ApiGateway::DomainName` or
  `AWS::ApiGatewayV2::DomainName`. The flags are the only configuration. To
  match a deployed domain, pass the CA bundle you uploaded to its trust store.
- The trust store is read once at boot. Restart to pick up a new bundle.

## Environment variables and credentials

Lambda environment variables are resolved as
[Where values come from](local-emulation.md#where-values-come-from) describes,
for every stack being served. Three things are specific to this command:

- `{{resolve:...}}` references are resolved once, at server boot.
- Under `--from-state`, cross-stack references (`Fn::ImportValue`,
  `Fn::GetStackOutput`) are dropped. With `--watch`, state is read again on
  every reload.
- Under `--from-cfn-stack`, `Ref` and `Fn::ImportValue` are resolved, and a
  Lambda's own `Fn::GetAtt` variables are read back from the deployed
  function's configuration. `Fn::GetAtt` elsewhere is dropped with a warning.

```bash
cdkd local start-api MyStack/MyApi --from-cfn-stack   # stack deployed with the AWS CDK CLI
```

### `--assume-role` and `--assume-role-auto`

By default the containers get your own credentials. These flags pass
temporary credentials for an execution role instead:

| Flag | Effect |
| --- | --- |
| `--assume-role <arn>` | One role for every Lambda. |
| `--assume-role <LogicalId>=<arn>` | A role for one Lambda. Repeatable. |
| `--assume-role-auto` | Each Lambda's own execution role. |

When more than one applies to a Lambda, the per-Lambda pair wins.
`--assume-role-auto` cannot be combined with the single-ARN form, and can be
combined with per-Lambda pairs.

An ARN must be a well-formed role ARN
(`arn:<partition>:iam::<account>:role/<name>`, at most 2048 characters) or the
command fails at boot.

`--assume-role-auto` looks for each Lambda's role in this order:

1. A literal ARN in the template's `Role` property.
2. The deployed stack, when `--from-state` or `--from-cfn-stack` is set.
3. Neither found: your credentials are used, with a warning.

A role that is found but is not a well-formed ARN stops startup, naming the
Lambda. Boot makes one STS call per Lambda, so it is slower.

## Lambda code, layers and images

Functions run as they do under [`cdkd local invoke`](local-invoke.md), which
documents the supported runtimes, layer resolution and image resolution.
What differs here:

| Topic | On `start-api` |
| --- | --- |
| Layers | Merged once per Lambda at boot. `--layer-role-arn` applies to layers named by ARN. |
| Container-image Lambdas | Resolved once at boot and on each `--watch` reload: built from the cloud assembly's Docker asset, or pulled from ECR. |
| ECR pull across accounts | Works only when your own credentials can read the repository. There is no `--ecr-role-arn` here; [`cdkd local invoke`](local-invoke.md#container-image-lambdas) has one. |
| `--watch` and images | An edit to the Dockerfile or build context produces a new image on the next reload. |
| Architecture and `/tmp` size | Applied to every container, as on `local invoke`. |

## VPC-config Lambdas

A Lambda with `VpcConfig` runs locally, but its container is not attached to
the VPC. Calls to a private RDS instance, an ElastiCache cluster or a VPC-only
endpoint fail. Each such Lambda gets a warning at startup:

```text
[warn] Lambda MyVpcLambda has VpcConfig — local container will reach external
        services via the host's network, NOT through the deployed VPC's
        NAT/private subnets. Calls to private RDS/ElastiCache will fail.
```

Calls to public AWS endpoints work as usual. To reach a private resource, open
a tunnel on your machine and point the handler at it through
[`host.docker.internal`](local-emulation.md#reaching-a-server-on-the-host).

## `--debug-port-base`

`--debug-port-base <port>` gives each Lambda its own Node debugger port,
counting up from `<port>` in discovery order.

```bash
cdkd local start-api MyStack/MyPublicApi --debug-port-base 9229 --warm
```

- Every Lambda in the run takes a port, authorizer and WebSocket Lambdas
  included.
- A Node handler waits until a debugger attaches, so a request hangs until you
  connect. Other runtimes are unaffected.
- The assignment is not printed. Serve one API at a time and count from the
  base.
- Without `--warm`, a port is not open until the first request starts the
  container.

## `--watch`

`--watch` watches the CDK app's source directory (where `cdk.json` is) and
reloads 500 ms after an edit. `cdk.out`, `node_modules` and `.git` are ignored,
and `watch.include` / `watch.exclude` in `cdk.json` are honoured.

A reload re-synthesizes the app, rediscovers the routes and swaps in new
containers. Requests in flight finish on the old containers and new requests
use the new ones.

| Situation | Result |
| --- | --- |
| Synthesis fails | The previous version keeps serving, with a warning. |
| Several files change at once | One reload. |
| `-a <dir>` named a synthesized assembly | The synthesis step is skipped. |
| WebSocket servers, mTLS files | Not reloaded. Restart the command. |

## Containers and shutdown

| Behaviour | Detail |
| --- | --- |
| Pool | Each Lambda has its own containers, at most `--per-lambda-concurrency`. Beyond that, requests queue. |
| Idle | A container unused for 60 seconds is removed. |
| Names | `cdkd-local-<logicalId>-<pid>-<random>` |

{kbd:ctrl+c} or `SIGTERM` waits for requests in flight, closes the servers and
removes every container and temporary directory. A container that is still
starting is waited for up to 20 seconds, then removed by name with a warning.

A second {kbd:ctrl+c} exits immediately. The warning names the containers
left behind and, with `--profile`, a temporary credentials file to delete. See
[Stopping a server](local-emulation.md#stopping-a-server).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Shut down cleanly on `SIGTERM`. |
| `1` | Startup failed (Docker missing or too old, port in use, a template the server cannot route), or an uncaught error during the run. |
| `130` | Stopped with {kbd:ctrl+c}, including the immediate second one. |

The full cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

## Limitations

| Not emulated | Result |
| --- | --- |
| IAM policy evaluation | Any correctly signed request reaches the handler. |
| REST v1 `AWS` integrations to services other than Lambda | 501. |
| HTTP API service integrations (`IntegrationSubtype`) | 501. |
| Intrinsics in an `HTTP` / `HTTP_PROXY` integration `Uri` | 501. |
| VTL outside the [supported subset](#vtl-support) | 502 naming the construct. |
| WebSocket authorizers | An API with a non-`NONE` `AuthorizationType` is not served. |
| WebSocket route selection by header, context or array index | Rejected. Only `$request.body.<key>` is supported. |
| Throttling, quotas, usage plans and API keys | Ignored. |
| More than 4 containers per Lambda | `--per-lambda-concurrency` is capped at 4. |

## Related

- [Local Execution](local-emulation.md): choosing a command, value
  resolution, and the flags every command shares
- [`cdkd local invoke`](local-invoke.md): run one of these Lambdas once, with
  the runtime, layer and image details
- [`cdkd local start-alb`](local-start-alb.md): a local Application Load
  Balancer in front of ECS services and Lambdas
- [`cdkd local start-cloudfront`](local-start-cloudfront.md): a local
  CloudFront distribution
- [CLI Reference](cli-reference.md): every command and the full exit-code
  table
