---
title: WebSocket APIs in cdkd local start-api
description: "Connect to a WebSocket API served by cdkd local start-api, see which Lambda each message reaches, and post messages back to a connection from a handler."
---

# WebSocket APIs in cdkd local start-api

[`cdkd local start-api`](local-start-api.md) serves each WebSocket API in your
app on its own port, at `ws://<host>:<port>/<stage>`. Connecting, sending a
message and disconnecting each invoke the Lambda of the matching route, as
they do on API Gateway.

## Connect to the API

Start the server and read the WebSocket address from the startup lines:

```bash
cdkd local start-api --port 3000
```

```text
Server listening on ws://127.0.0.1:3002/prod  (MyChatApi (WebSocket API))
```

Connect with any WebSocket client:

```bash
npx wscat -c ws://127.0.0.1:3002/prod
```

The `<stage>` in the address is the name of the API's
`AWS::ApiGatewayV2::Stage`. When the template declares no stage, it is
`local`. Under [mutual TLS](local-start-api-mtls.md) the address starts with
`wss://`.

## Which Lambda a message reaches

| Event | Route invoked |
| --- | --- |
| A client connects | `$connect` |
| A client sends a message | The route chosen by the API's `RouteSelectionExpression` |
| A client closes the socket | `$disconnect` |

cdkd supports a `RouteSelectionExpression` of the form `$request.body.<key>`,
and the key may be nested, as in `$request.body.action.version`. With
`$request.body.action`, the message `{"action": "sendMessage"}` reaches the
`sendMessage` route. A message that is not JSON, that lacks the key, or
whose value names no route goes to the `$default` route.

An expression that selects by header, by context or by array index is
rejected.

## Posting back to a connection

A handler sends a message to a connected client by calling
`PostToConnection` on the API Gateway Management API. Locally that call
reaches the cdkd server.

cdkd arranges this by setting one environment variable in every WebSocket
Lambda:

```text
AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI=http://host.docker.internal:<port>/<stage>
```

When the container has no AWS credentials or region set, cdkd also supplies
placeholder credentials and a region, so that the SDK client can be created.

This needs Docker 20.10 or newer. On an older daemon the command fails at
boot with a message saying so.

## Edge cases

**A route uses an authorizer.** cdkd does not emulate WebSocket authorizers.
When any route of the API sets an `AuthorizationType` other than `NONE`, the
API is not served, and a warning says so.

**No route has a Lambda cdkd can resolve.** The API is not served, and a
warning says so.

**The API is malformed.** cdkd reports it with a warning. The other APIs in
the app still boot.

**`--watch` is on.** WebSocket servers are not reloaded. Restart the command
to pick up a change.

**The server shuts down.** Every open socket receives close code 1001.

## Related

- [`cdkd local start-api`](local-start-api.md): the worked example, the
  options and how ports are assigned
- [Local Execution](local-emulation.md#reaching-a-server-on-the-host): how a
  container reaches `host.docker.internal`
