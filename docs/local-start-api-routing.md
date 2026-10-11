---
title: Routing and request handling in cdkd local start-api
description: "Which routes cdkd local start-api answers with 501, how a request is matched to a route, where stage variables come from, and how CORS preflights and streaming Function URLs are handled."
---

# Routing and request handling in cdkd local start-api

[`cdkd local start-api`](local-start-api.md) reads the routes of each API from
the synthesized template and invokes the route's Lambda for each request. This
page covers what happens around that call: routes cdkd cannot serve, how a
request finds its route, and what the server answers by itself.

## Routes that return 501

A route with an integration cdkd does not emulate is still listed. The route
table shows it as `[501 Not Implemented]`, a warning names it at boot, and the
other routes keep working. A request to it gets HTTP 501 with the reason in
the body:

```json
{ "message": "Not Implemented", "reason": "<the discovery reason>" }
```

These routes return 501:

- A REST v1 `AWS` integration that targets a service other than Lambda
  (`:s3:path/...`, `:sqs:action/...`, `:dynamodb:action/...`).
- An `HTTP_PROXY` or `HTTP` integration whose `Uri` is not a literal string.
  cdkd does not resolve intrinsics in an integration URI.
- An HTTP API service integration, which is one that sets
  `IntegrationSubtype`.
- A Function URL with an `AuthType` other than `NONE` or `AWS_IAM`.
- A route whose Lambda cannot be found in the same template, such as a
  cross-stack or imported function.

## Templates that stop the server from booting

The server does not start when the template leaves a route incompletely
defined. The error lists every such route in one message. The causes are:

- a Method with no `Integration`,
- a `RestApiId` or `ApiId` that is not a `Ref`,
- a malformed Route `Target`,
- a broken `ParentId` chain,
- a missing `PathPart`,
- an unresolvable `TargetFunctionArn` on a Function URL,
- an authorizer of an unsupported type.

## Routing precedence

A request is matched to a route in the order AWS documents:

1. An exact match on the path.
2. A greedy `{proxy+}` match.
3. `$default`.

When several routes match exactly, the route with more literal path segments
wins.

## Stage variables

A handler reads stage variables from `event.stageVariables`. cdkd fills that
field from one API Gateway Stage in the template, and puts the stage's name in
`event.requestContext.stage`.

```bash
# the first Stage attached to each API, in template order
cdkd local start-api

# the Stage whose StageName is prod, looked up on each API
cdkd local start-api --stage prod
```

The variables come from the Stage's `Variables` property on a REST v1 API and
from `StageVariables` on an HTTP API.

### Edge cases

- **`--stage <name>` matches no Stage on an API.** That API's routes get
  `stageVariables: null`, and a warning says so at startup.
- **An HTTP API with no Stage in the template.** `requestContext.stage` is
  `$default`.
- **A Function URL.** `stageVariables` is always `null`.
- **A stage variable whose value is an intrinsic** (`Ref`, `Fn::GetAtt`,
  `Fn::Sub`). cdkd drops the variable with a warning.

## CORS preflight

A browser sends an `OPTIONS` preflight request before a cross-origin call.
The server answers the preflight itself, without invoking a Lambda, when the
API configures CORS in one of the two ways below.

### HTTP API

An HTTP API configures CORS with a `CorsConfiguration`:

```ts
new apigwv2.HttpApi(this, 'MyPublicApi', {
  corsPreflight: {
    allowOrigins: ['https://app.example.com'],
    allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST],
    allowHeaders: ['Content-Type', 'Authorization'],
  },
});
```

The server checks three headers of the preflight request:

| Request header | Checked against |
| --- | --- |
| `Origin` | `AllowOrigins` (literal entries or `*`) |
| `Access-Control-Request-Method` | `AllowMethods` |
| Each `Access-Control-Request-Headers` entry | `AllowHeaders`, case-insensitively |

When all three match, the response is `204 No Content` with the
`Access-Control-Allow-*` headers. `Max-Age`, `Expose-Headers` and
`Allow-Credentials` are added when the API configures them. `Vary: Origin` is
always set.

Three cases behave differently:

- **`AllowCredentials: true` with a `*` match.** The response echoes the
  request's `Origin`, because browsers reject `*` together with credentials.
- **A malformed header list**, such as `Content-Type,,Authorization`. The
  preflight is rejected.
- **The API declares its own `OPTIONS` route.** The server does not answer
  the preflight, and your Lambda does. An `OPTIONS` route on a different API
  has no effect on this one.

### REST v1

On a REST v1 API, cdkd recognizes the preflight method that CDK's
`defaultCorsPreflightOptions` generates. That method is an `OPTIONS` method
with a `MOCK` integration, whose `ResponseParameters` carry literal
`method.response.header.Access-Control-Allow-*` values.

The server returns those headers and the status captured from the template
(`204` by default).

Header parameters whose value is an intrinsic are dropped. If no header is
left, the route returns 501. A `MOCK` integration of any other shape is
handled as an ordinary
[`MOCK` integration](local-start-api-rest-integrations.md#mock).

## Streaming Function URLs

A Function URL with `InvokeMode: RESPONSE_STREAM` is invoked in streaming
mode, and the server sends its body to the client with
`Transfer-Encoding: chunked`.

The body still arrives in one piece. The local Lambda emulator buffers the
handler's response, so `curl` receives the whole body at once. You can see
incremental delivery only against the deployed function.

## Related

- [`cdkd local start-api`](local-start-api.md): the worked example, the
  options and which routes are served
- [REST v1 integrations](local-start-api-rest-integrations.md): the
  integration types cdkd emulates without a proxy Lambda
- [Authorizers](local-start-api-authorizers.md): what runs before the route's
  Lambda
