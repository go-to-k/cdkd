---
title: cdkd local start-api
description: "Serve the API Gateway REST, HTTP and WebSocket APIs and the Lambda Function URLs in your CDK app on localhost, backed by local Lambda containers."
---

# cdkd local start-api

`cdkd local start-api` serves the API Gateway APIs and Lambda Function URLs in
your CDK app on localhost. Each request runs the route's Lambda function in a
local container. Use it to try a whole API against your real handler code,
including routing, authorizers, CORS and stage variables, without deploying.

For a load balancer in front of ECS services, use
[`cdkd local start-alb`](local-start-alb.md).

## Serve an API

Suppose `MyStack` has an HTTP API with one route:

```ts
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import {
  HttpLambdaIntegration,
} from 'aws-cdk-lib/aws-apigatewayv2-integrations';

const api = new apigwv2.HttpApi(this, 'MyPublicApi');
api.addRoutes({
  path: '/items',
  methods: [apigwv2.HttpMethod.GET],
  integration: new HttpLambdaIntegration('Items', itemsHandler),
});
```

With Docker running, start the server on a fixed port from the directory that
holds your `cdk.json`:

```bash
cdkd local start-api --port 3000
```

cdkd prints the routes it found and the address it is listening on:

```text
MyPublicApi (HTTP API)  (http://127.0.0.1:3000)
  GET  /items      to ItemsHandler  (HTTP API)

Server listening on http://127.0.0.1:3000  (MyPublicApi (HTTP API))
^C to stop and clean up containers.
```

Call the route from another terminal:

```bash
curl http://127.0.0.1:3000/items
```

The first request to a route starts that route's container, so it is slower
than the requests after it. Press {kbd:ctrl+c} to stop the server and remove
the containers.

More invocations:

```bash
# every API, ports chosen for you
cdkd local start-api

# only this API
cdkd local start-api MyStack/MyAdminApi

# start containers up front, reload on source edits
cdkd local start-api --warm --watch

# deployed values, the prod stage's variables
cdkd local start-api --from-state --stage prod

# point variables at local endpoints
cdkd local start-api --env-vars overrides.json
```

Docker is required. See [Local Execution](local-emulation.md#requirements).

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[target]` | every API found | Serve only this API. See [Target resolution](#target-resolution). |
| `--port <port>` | `0` (auto) | Port for the first server. Later servers take `port+1`, `port+2`, and so on. |
| `--host <host>` | `127.0.0.1` | Address the servers bind to. This is the address you connect to. |
| `--stack <name>` | the only stack | Stack to serve, when neither the target nor `--from-cfn-stack` names one. |
| `--stage <name>` | first Stage of each API | API Gateway Stage to take stage variables from. See [Stage variables](local-start-api-routing.md#stage-variables). |
| `--warm` | off | Start one container per Lambda at boot, so the first request is fast. |
| `--per-lambda-concurrency <n>` | `2` | Most containers per Lambda. Values above `4` are lowered to `4` with a warning. |
| `--watch` | off | Re-synthesize and reload routes when the app source changes. See [`--watch`](local-start-api-containers.md#watch). |
| `--debug-port-base <port>` | — | Give each Lambda a Node debugger port. See [`--debug-port-base`](local-start-api-containers.md#debug-port-base). |
| `--assume-role <arn-or-pair>` | — | Run handlers under an execution role. See [`--assume-role` and `--assume-role-auto`](#assume-role-and-assume-role-auto). |
| `--assume-role-auto` | off | Run each Lambda under its own execution role. |
| `--layer-role-arn <arn>` | — | Role to assume before downloading a layer named by ARN. |
| `--mtls-truststore <path>` | — | PEM CA bundle. Turns on HTTPS with client-certificate checks. See [Mutual TLS](local-start-api-mtls.md). |
| `--mtls-cert <path>` | — | PEM server certificate. Required with the other two `--mtls-*` flags. |
| `--mtls-key <path>` | — | PEM server private key. Required with the other two `--mtls-*` flags. |
| `--strict-sigv4` | off | Deny an `AWS_IAM` request whose signature cannot be verified. See [`--strict-sigv4`](local-start-api-authorizers.md#strict-sigv4). |
| `--api <id>` | — | Deprecated alias for `[target]`. Warns, and cannot be combined with it. |

The command also accepts every [common flag](local-emulation.md#common-flags).
Two of them need a word here:

- `--container-host` is the IP that the Lambda containers' ports bind to. It
  is separate from `--host`, which is the address the API servers bind to.
- `--no-pull` skips pulling the Lambda base image.

## Target resolution

With no target, cdkd serves every API in the app. A target selects exactly
one API. You can write it in four ways:

```bash
# bare logical ID
cdkd local start-api MyHttpApi

# stack name, a colon, the logical ID
cdkd local start-api MyStack:MyHttpApi

# construct path prefix
cdkd local start-api MyStack/MyHttpApi

# full construct path
cdkd local start-api MyStack/MyHttpApi/Resource
```

- The bare logical ID works only in a single-stack app.
- The stack-qualified logical ID works in any app. You need it when two
  stacks share a logical ID.
- A construct path prefix matches the resource below it, so you can leave off
  `/Resource`.
- A full construct path must match the resource's construct path exactly.

A path form also selects the stack, so you do not need `--stack` with it. A
stack inside a CDK `Stage` is reached as `MyStage/MyStack/MyHttpApi`.

To serve a Function URL, name the Lambda behind it. For a URL created by
`new lambda.Function(this, 'MyHandler').addFunctionUrl()`, run
`cdkd local start-api MyStack/MyHandler`.

### Edge case: a template without construct paths

A template built from hand-written `CfnResource` definitions can lack
construct-path metadata. Its APIs match by the two logical-ID forms only.

## Servers and ports

Each API gets its own server on its own port. That applies to every HTTP API,
REST API, WebSocket API and Function URL.

```bash
cdkd local start-api --port 3000
```

```text
Server listening on http://127.0.0.1:3000  (MyPublicApi (HTTP API))
Server listening on http://127.0.0.1:3001  (MyAdminApi (REST API))
Server listening on ws://127.0.0.1:3002/prod  (MyChatApi (WebSocket API))
```

With `--port 3000`, the first API takes `3000`, the second `3001`, the third
`3002`, and so on. With the default `--port 0`, each server picks a free port,
and the startup lines tell you which.

`sam local start-api` serves every API from one port. cdkd uses one port per
API because two APIs in one app often have overlapping paths and different
authorizers.

Changed in v0.81: earlier releases served every API from one port.

## Which routes are served

cdkd serves a route whose integration is a Lambda function in the same
template, and it emulates the other REST v1 integration types. A route it
cannot serve returns HTTP 501, and the rest of the API keeps working.

Routes are read from these resource types:

| API kind | CloudFormation types |
| --- | --- |
| HTTP API | `AWS::ApiGatewayV2::Api` (`ProtocolType: HTTP`), `AWS::ApiGatewayV2::Route`, `AWS::ApiGatewayV2::Integration` |
| REST v1 | `AWS::ApiGateway::RestApi`, `AWS::ApiGateway::Resource`, `AWS::ApiGateway::Method`, `AWS::ApiGateway::Stage` |
| WebSocket API | `AWS::ApiGatewayV2::Api` (`ProtocolType: WEBSOCKET`), `AWS::ApiGatewayV2::Route`, `AWS::ApiGatewayV2::Integration` |
| Function URL | `AWS::Lambda::Url` |

What the server does with a route depends on the route's integration:

| Route | What the server does |
| --- | --- |
| `AWS_PROXY` integration with a Lambda in the same template | Invokes the Lambda. |
| REST v1 `OPTIONS` method with a `MOCK` integration and literal CORS headers | Answers the preflight itself. See [CORS preflight](local-start-api-routing.md#cors-preflight). |
| Function URL with `InvokeMode: RESPONSE_STREAM` | Invokes the Lambda in streaming mode. See [Streaming Function URLs](local-start-api-routing.md#streaming-function-urls). |
| REST v1 `MOCK`, `HTTP_PROXY`, `HTTP` or `AWS` integration | Emulates the integration. See [REST v1 integrations](local-start-api-rest-integrations.md). |
| An integration cdkd does not emulate | Returns HTTP 501. |
| A route the template does not fully define | Boot fails. |

A route with an integration cdkd does not emulate stays in the route table,
marked `[501 Not Implemented]`, and a warning names it at boot. When the
template leaves a route incompletely defined, the server does not start, and
the error lists every such route in one message.
[Routing and request handling](local-start-api-routing.md#routes-that-return-501)
lists both sets of routes.

WebSocket APIs have their own rules; see
[WebSocket APIs](local-start-api-websocket.md).

## AWS_IAM authorization

cdkd serves a route that sets `AuthorizationType: 'AWS_IAM'` (REST v1) or
`AuthType: 'AWS_IAM'` (Function URL). For each request it checks that the
SigV4 signature was made with your local AWS credentials.

> [!IMPORTANT]
> Only the signature is checked. IAM policies are not evaluated, so any caller
> with a valid signature reaches the handler. Test resource, action and
> condition rules against the deployed API.

Sign the request with the same credentials cdkd is running with:

```bash
curl --aws-sigv4 "aws:amz:us-east-1:execute-api" \
  --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  http://127.0.0.1:3000/protected
```

Any SigV4 client works: the AWS SDK signer, `curl --aws-sigv4`, Postman's AWS
Signature auth, `awscurl`.

At startup cdkd lists the routes this applies to:

```text
[warn] 2 route(s) declare AuthorizationType: AWS_IAM — cdkd local start-api
       verifies SigV4 signatures against your local AWS credentials, but does NOT
       emulate IAM policy evaluation (resource / action / condition rules).
       Signature-verified callers reach the handler under their own identity;
       downstream authorization is the dev's responsibility.
[warn]   - MyStack/ProtectedMethod
[warn]   - MyStack/AnotherProtectedMethod
```

A request then has one of three outcomes:

- A valid signature made with your credentials reaches the handler.
- A missing `Authorization` header, or a signature that does not match, gets
  HTTP 403.
- A signature made with an access key you do not hold cannot be verified.
  cdkd lets the request through with a warning. Pass `--strict-sigv4` to deny
  it with a 403.

[Authorizers](local-start-api-authorizers.md#aws-iam-verification-outcomes)
has the exact response bodies and what the handler's event contains.

## Environment variables and credentials

Lambda environment variables are resolved the same way as on every local
command, for every stack being served. With no flag, literals are passed
through and references to other resources are dropped with a warning.
[Where values come from](local-emulation.md#where-values-come-from) explains
the flags that fill them in.

```bash
# stack deployed with cdkd deploy
cdkd local start-api MyStack/MyApi --from-state

# stack deployed with the AWS CDK CLI
cdkd local start-api MyStack/MyApi --from-cfn-stack

# values from a file
cdkd local start-api --env-vars overrides.json
```

Three things are specific to this command:

- `{{resolve:...}}` references are resolved once, when the server boots.
- Under `--from-state`, cross-stack references (`Fn::ImportValue`,
  `Fn::GetStackOutput`) are dropped. With `--watch`, state is read again on
  every reload.
- Under `--from-cfn-stack`, `Ref` and `Fn::ImportValue` are resolved. A
  Lambda's own `Fn::GetAtt` variables are read back from the deployed
  function's configuration. `Fn::GetAtt` elsewhere is dropped with a warning.

### `--assume-role` and `--assume-role-auto`

By default the containers get your own AWS credentials. These flags give them
temporary credentials for an execution role, so that a missing IAM permission
shows up locally:

```bash
# One role for every Lambda
cdkd local start-api --assume-role arn:aws:iam::123456789012:role/ApiRole

# A role for one Lambda, as <LogicalId>=<arn>; repeatable
cdkd local start-api \
  --assume-role ItemsHandler1234ABCD=arn:aws:iam::123456789012:role/ItemsRole

# Each Lambda's own execution role
cdkd local start-api --from-state --assume-role-auto
```

When more than one form applies to a Lambda, the per-Lambda pair wins. You
can combine `--assume-role-auto` with per-Lambda pairs. You cannot combine it
with the single-ARN form.

An ARN must be a well-formed role ARN
(`arn:<partition>:iam::<account>:role/<name>`, at most 2048 characters).
Otherwise the command fails at boot.

`--assume-role-auto` looks for each Lambda's role in this order:

1. A literal ARN in the template's `Role` property.
2. The deployed stack, when `--from-state` or `--from-cfn-stack` is set.
3. If neither gives a role, the Lambda runs with your credentials and cdkd
   prints a warning.

If the role cdkd finds is not a well-formed ARN, startup stops with an error
naming the Lambda. `--assume-role-auto` makes one STS call per Lambda at boot,
so the server takes longer to start.

### Lambda code, layers and images

Functions run as they do under [`cdkd local invoke`](local-invoke.md), which
documents the supported runtimes, layers and container images.
[Containers, reloading and debugging](local-start-api-containers.md#lambda-code-layers-and-images)
says when `start-api` does that work.

## VPC-config Lambdas

A Lambda with `VpcConfig` runs locally, but its container is not attached to
the VPC. Calls from the handler to a private RDS instance, an ElastiCache
cluster or a VPC-only endpoint therefore fail. Calls to public AWS endpoints
work as usual.

cdkd prints a warning at startup for each such Lambda:

```text
[warn] Lambda MyVpcLambda has VpcConfig — local container will reach external
        services via the host's network, NOT through the deployed VPC's
        NAT/private subnets. Calls to private RDS/ElastiCache will fail.
```

To reach a private resource, open a tunnel to it on your machine. Then point
the handler at the tunnel through
[`host.docker.internal`](local-emulation.md#reaching-a-server-on-the-host),
using an `--env-vars` file.

## Stopping the server

{kbd:ctrl+c} or `SIGTERM` waits for requests in flight, closes the servers,
and removes every container and temporary directory. A second {kbd:ctrl+c}
exits immediately and can leave containers behind; see
[Stopping a server](local-emulation.md#stopping-a-server).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Shut down cleanly on `SIGTERM`. |
| `1` | Startup failed (Docker missing or too old, port in use, a template the server cannot route), or an uncaught error during the run. |
| `130` | Stopped with {kbd:ctrl+c}, including the immediate second one. |

The full cross-command table is in [Exit codes](cli-reference-exit-codes.md).

## Limitations

| Not emulated | Result |
| --- | --- |
| IAM policy evaluation | Any correctly signed request reaches the handler. |
| REST v1 `AWS` integrations to services other than Lambda | 501. |
| HTTP API service integrations (`IntegrationSubtype`) | 501. |
| Intrinsics in an `HTTP` / `HTTP_PROXY` integration `Uri` | 501. |
| VTL outside the [supported subset](local-start-api-rest-integrations.md#vtl-support) | 502 naming the construct. |
| WebSocket authorizers | An API with a non-`NONE` `AuthorizationType` is not served. |
| WebSocket route selection by header, context or array index | Rejected. Only `$request.body.<key>` is supported. |
| Throttling, quotas, usage plans and API keys | Ignored. |
| More than 4 containers per Lambda | `--per-lambda-concurrency` is capped at 4. |

## In this section

- [Routing and request handling](local-start-api-routing.md): routes that
  return 501, which route a request matches, stage variables, CORS preflight
  and streaming Function URLs
- [Containers, reloading and debugging](local-start-api-containers.md):
  `--watch`, `--debug-port-base`, the container pool and shutdown
- [Authorizers](local-start-api-authorizers.md): Lambda, Cognito and JWT
  authorizers, and the details of `AWS_IAM` signature checks
- [Mutual TLS](local-start-api-mtls.md): serve HTTPS and require a client
  certificate
- [WebSocket APIs](local-start-api-websocket.md): connect to a WebSocket API
  and post messages back to a connection
- [REST v1 integrations](local-start-api-rest-integrations.md): `MOCK`,
  `HTTP_PROXY`, `HTTP` and non-proxy Lambda integrations, and the supported
  VTL

## Related

- [Local Execution](local-emulation.md): choosing a command, value
  resolution, and the flags every command shares
- [`cdkd local invoke`](local-invoke.md): run one of these Lambdas once, with
  the runtime, layer and image details
- [`cdkd local start-alb`](local-start-alb.md): a local Application Load
  Balancer in front of ECS services and Lambdas
- [`cdkd local start-cloudfront`](local-start-cloudfront.md): a local
  CloudFront distribution
- [CLI Reference](cli-reference.md): every cdkd command
