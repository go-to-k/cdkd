---
title: cdkd local start-agentcore
description: "Keep a Bedrock AgentCore Runtime from your CDK app running in a local container and serve its HTTP, MCP, A2A or AG-UI endpoints on a local port, with hot reload."
---

# cdkd local start-agentcore

`cdkd local start-agentcore [target]` starts a Bedrock AgentCore Runtime
container once, keeps it running, and serves the runtime's endpoints on a
local port until you press {kbd:ctrl+c}. Use it when a client, such as a
browser, an MCP host or a test suite, sends the agent many requests.

To send one request and exit, use
[`cdkd local invoke-agentcore`](local-invoke-agentcore.md). That page also
explains what the two commands share: how the agent's image is built, the four
protocols, and the credentials the agent runs with.

## Serve an agent

Given a runtime in `MyStack`, built from a `Dockerfile` in `agent/`:

```ts
import * as path from 'node:path';
import {
  AgentRuntimeArtifact,
  Runtime,
} from 'aws-cdk-lib/aws-bedrockagentcore';

new Runtime(this, 'MyAgent', {
  agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(
    path.join(__dirname, '../agent')
  ),
});
```

serve it on a fixed port:

```bash
cdkd local start-agentcore MyStack/MyAgent --port 8080
```

cdkd builds the image, starts the container, waits for it to report ready and
prints where it is listening. Call it from another terminal:

```bash
curl -X POST http://127.0.0.1:8080/invocations -d '{"prompt":"hello"}'
curl http://127.0.0.1:8080/ping            # readiness; never authenticated
```

More invocations:

```bash
# pick a runtime from a list
cdkd local start-agentcore

# a port chosen for you
cdkd local start-agentcore MyStack/MyAgent

# default token for a JWT-authorizer runtime
cdkd local start-agentcore MyStack/MyAgent --bearer-token "$JWT"

# sign forwarded requests
cdkd local start-agentcore MyStack/MyAgent --sigv4

# deployed values, reload on edits
cdkd local start-agentcore MyStack/MyAgent --from-state --watch
```

Docker is required. [Local Execution](local-emulation.md) lists the
requirements.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[target]` | picker | The runtime to serve. |
| `--port <n>` | `0` (auto) | Port clients connect to. |
| `--host <ip>` | `127.0.0.1` | Address the local server binds to. |
| `--session-id <id>` | new UUID per request | One AgentCore session ID for every request. |
| `--bearer-token <jwt>` | — | Token for a request with no `Authorization` header. |
| `--no-verify-auth` | off | Skip JWT verification. |
| `--sigv4` | off | Sign each forwarded request with AWS SigV4. |
| `--timeout <ms>` | `120000` | How long the container has to become ready. |
| `--watch` | off | Reload the container when the source changes. |
| `--platform <platform>` | `linux/arm64` | `linux/amd64` or `linux/arm64`. |
| `--assume-role [arn]` | off | Run the agent under the runtime's execution role. |
| `--no-assume-role` | — | Explicitly keep your own credentials. |
| `--no-pull` | off | Skip `docker pull`. |
| `--no-build` | off | Reuse the image built last time. |
| `--ecr-role-arn <arn>` | — | Role to assume before pulling from ECR. |

Notes on these flags:

- The HTTP endpoints and the `/ws` WebSocket share the one `--port`.
- `--session-id` also applies to every `/ws` connection.
- The container is ready when it answers `GET /ping`. `--timeout` is the time
  it has to do so.
- `--sigv4` cannot be combined with `--bearer-token`.
- `--assume-role` with no value uses the runtime's literal `RoleArn`. Without
  the flag, the agent container gets your own credentials.
- The default platform is arm64 because deployed AgentCore runtimes are
  arm64.
- `--no-pull` has no effect when the image is built locally, and `--no-build`
  has none when the image is pulled.
- `--ecr-role-arn` is for an image in another account's ECR registry.

The command also accepts every common flag listed in
[Local Execution](local-emulation.md). Two of them behave in a way specific to
this command: the `--env-vars` file is keyed by the runtime's logical ID or
display path, and `--container-host` sets the IP the agent container's port
binds to.

> [!WARNING]
> Do not pass `--role-arn` here without the `--profile` flag. `--role-arn` is
> the role cdkd assumes for its own AWS calls. On this command the role's
> credentials also reach the agent container, so your code runs as that role.
> An exported `AWS_PROFILE` does not prevent this. cdkd warns at startup when
> this applies. See the `--role-arn` section of the
> [CLI Reference](cli-reference.md).

## Target resolution

The target names one AgentCore Runtime. You can write it as a CDK display path
(`MyStack/MyAgent`) or as a stack-qualified logical ID (`MyStack:MyAgent`),
and an app with one stack may omit the stack.
[Local Execution](local-emulation.md) describes the forms in full.

When you name no target in an interactive terminal, cdkd lists the runtimes in
the app and you choose one.

## Protocols and endpoints

The local server exposes the endpoints of the runtime's protocol, all on the
one `--port`. A client talks to it the way it would talk to the agent
container.

| Protocol | Local endpoints |
| --- | --- |
| HTTP, AGUI | `POST /invocations`, `GET /ping`, and the `/ws` WebSocket |
| MCP | `POST /mcp` |
| A2A | `POST /` |

The server passes each request to the container and each response back,
including a response that is a server-sent event stream. On the way in, it
adds the AgentCore session ID header. The container ports behind each protocol
are listed under
[Protocols](local-invoke-agentcore.md#protocols) on the `invoke-agentcore`
page.

At startup cdkd prints two lines with the address it bound. For an HTTP or
AGUI runtime they begin:

```text
Server listening on ws://<host>:<port>
HTTP contract served on http://<host>:<port>
```

For an MCP or A2A runtime, the first line gives an `http://` address, and the
second starts with the protocol's name in place of `HTTP`.

A request to a path the runtime does not serve gets a `404` that lists the
paths it does serve.

### The `/ws` bridge

An HTTP or AGUI runtime also gets a `/ws` WebSocket endpoint on the same port.
The server bridges it: for each client that connects to `/ws`, it opens its
own connection to the container. On that connection it adds the session-ID
header and, for a runtime with a JWT authorizer, the `Authorization` header.

The bridge is what lets a browser hold a WebSocket session with the agent,
because a browser's `WebSocket` cannot set those headers itself.

MCP and A2A runtimes have no `/ws`.

## Inbound authentication

The local server can make the check a deployed runtime makes on its callers.
Which check applies depends on whether the runtime declares a
`customJwtAuthorizer`; [Inbound authentication](local-invoke-agentcore.md#inbound-authentication)
on the `invoke-agentcore` page introduces the two kinds. When the runtime
declares one, it always takes precedence.

`GET /ping` is never authenticated.

### `customJwtAuthorizer` runtimes

The server verifies the `Authorization` header of every request, as the
deployed runtime does on every invocation. Send the token with each request:

```bash
curl -X POST http://127.0.0.1:8080/invocations \
  -H "Authorization: Bearer $JWT" -d '{"prompt":"hello"}'
```

| Request | Result |
| --- | --- |
| Token that verifies | Forwarded to the container |
| Token that fails verification | `403` |
| No token, and no `--bearer-token` | `401` |

A token fails verification when its signature, issuer, expiry, audience or
scope check fails.

Two flags change this:

- `--bearer-token <jwt>` supplies a default token. The server uses it for a
  request that carries no token, and verifies it like any other. cdkd also
  verifies it against the runtime's OIDC discovery URL before the container
  starts, and a rejected token stops the startup.
- `--no-verify-auth` forwards every request without verification. A
  `--bearer-token` is still added.

> [!WARNING]
> When the OIDC discovery URL is unreachable or malformed, requests are
> accepted without verification, so that offline work is not blocked.

### Runtimes with no `customJwtAuthorizer`

By default the server forwards requests unauthenticated. `--sigv4` makes it
sign each forwarded request with SigV4 for the `bedrock-agentcore` service, so
the container sees the `Authorization` and `X-Amz-*` headers it would receive
when deployed.

On a runtime that declares a `customJwtAuthorizer`, `--sigv4` is ignored with
a warning.

## State sources

`--from-state` and `--from-cfn-stack` replace the references in the runtime's
container image and environment variables with values from the deployed
stack. The references are the intrinsic functions `Ref`, `Fn::GetAtt`,
`Fn::Sub`, `Fn::ImportValue` and `Fn::GetStackOutput`.

```bash
cdkd local start-agentcore MyStack/MyAgent --from-state
```

[Local Execution](local-emulation.md) explains both flags.

## `--watch`: reload the warm container in place

`--watch` synthesizes the app again when your CDK source changes and replaces
only the container. The local server and its port stay up, so a connected
client keeps its address.

```bash
cdkd local start-agentcore MyStack/MyAgent --port 8080 --watch
```

cdkd reloads in one of two ways:

- **Copy and restart**, for source the running container can take as it is.
  cdkd copies the new source in and restarts the container, which keeps its ID
  and its host port.
- **Rebuild**, for anything that needs a new image. cdkd starts a new
  container and points the server at it.

[Which edits need a rebuild](local-invoke-agentcore.md#which-edits-need-a-rebuild)
on the `invoke-agentcore` page lists exactly which edits fall on each side.
Either way, requests resume once the container reports ready, which it must do
within `--timeout`.

Changes under `cdk.out`, `node_modules` and `.git` are ignored. The
`watch.include` and `watch.exclude` settings in `cdk.json` are honoured.

## Building and stopping

cdkd builds or pulls the agent's image as `invoke-agentcore` does;
[Artifacts](local-invoke-agentcore.md#artifacts) on that page describes both
kinds of runtime. A source-code runtime (`CodeConfiguration`) runs your bundle
as it is and installs no dependencies, so they must already be in the bundle.

{kbd:ctrl+c} or `SIGTERM` removes the container and exits.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Stopped by `SIGTERM`. |
| `1` | An error. |
| `130` | Stopped by {kbd:ctrl+c}, or the picker was cancelled. |

An error here is a runtime that does not exist, a synthesis failure, an image
that would not build or pull, a container that was not ready within
`--timeout`, or a `--bearer-token` rejected at startup.

The [CLI Reference](cli-reference.md) has the exit-code table for every
command.

## Related

- [`cdkd local invoke-agentcore`](local-invoke-agentcore.md): send one request
  and exit; also documents artifacts, protocols and the `--watch` rules
- [`cdkd local invoke`](local-invoke.md): run a Lambda function once
- [Local Execution](local-emulation.md): choosing a command, value
  resolution, and the flags every command shares
- [CLI Reference](cli-reference.md): every command and the full exit-code
  table
