---
title: cdkd local start-agentcore
description: "Keep a Bedrock AgentCore Runtime from your CDK app running in a local container and serve its HTTP, MCP, A2A or AG-UI endpoints on a local port, with hot reload."
---

# cdkd local start-agentcore

`cdkd local start-agentcore [target]` starts a Bedrock AgentCore Runtime
container once, keeps it running, and serves the runtime's endpoints on a
local port until you press {kbd:ctrl+c}. Use it when a client (a browser, an
MCP host, a test suite) sends the agent many requests.

To send one request and exit, use
[`cdkd local invoke-agentcore`](local-invoke-agentcore.md).

## Serve an agent

Given a runtime in `MyStack`, built from a `Dockerfile` in `agent/`:

```ts
import * as path from 'node:path';
import { AgentRuntimeArtifact, Runtime } from 'aws-cdk-lib/aws-bedrockagentcore';

new Runtime(this, 'MyAgent', {
  agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '../agent')),
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
cdkd local start-agentcore                                       # pick a runtime from a list
cdkd local start-agentcore MyStack/MyAgent                       # a port chosen for you
cdkd local start-agentcore MyStack/MyAgent --bearer-token "$JWT" # default token for a JWT-authorizer runtime
cdkd local start-agentcore MyStack/MyAgent --sigv4               # sign forwarded requests
cdkd local start-agentcore MyStack/MyAgent --from-state --watch  # deployed values, reload on edits
```

Docker is required. See [Local Execution](local-emulation.md#requirements).

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[target]` | picker | The runtime to serve. Omit in an interactive terminal to choose from a list. |
| `--port <n>` | `0` (auto) | Port clients connect to. The HTTP endpoints and `/ws` share it. |
| `--host <ip>` | `127.0.0.1` | Address the local server binds to. |
| `--session-id <id>` | new UUID per request | Use one AgentCore session ID for every request and `/ws` connection. |
| `--bearer-token <jwt>` | — | Token used for a request that carries no `Authorization` header. |
| `--no-verify-auth` | off | Skip JWT verification. A `--bearer-token` is still forwarded. |
| `--sigv4` | off | Sign each forwarded request with AWS SigV4. Cannot be combined with `--bearer-token`. |
| `--timeout <ms>` | `120000` | How long the container has to answer `GET /ping` and become ready. |
| `--watch` | off | Reload the container when the source changes. The local server stays up. |
| `--platform <platform>` | `linux/arm64` | `linux/amd64` or `linux/arm64`. Deployed AgentCore runtimes are arm64. |
| `--assume-role [arn]` | off | Run the agent under the runtime's execution role. The bare form uses the runtime's literal `RoleArn`. |
| `--no-assume-role` | — | Explicitly keep your own credentials. |
| `--no-pull` | off | Skip `docker pull`. No effect when the image is built locally. |
| `--no-build` | off | Reuse the previously built image. No effect when the image is pulled. |
| `--ecr-role-arn <arn>` | — | Role to assume before pulling from another account's ECR registry. |

It also accepts every [common flag](local-emulation.md#common-flags).
`--env-vars` is keyed by the runtime's logical ID or display path, and
`--container-host` is the IP the agent container's port binds to.

> [!WARNING]
> Do not pass `--role-arn` here without the `--profile` flag. The role's
> credentials reach the agent container, so your code runs as that role. An
> exported `AWS_PROFILE` does not prevent this. cdkd warns at startup when
> this applies. See the `--role-arn` section of the
> [CLI Reference](cli-reference.md).

## Target resolution

The target is a CDK display path (`MyStack/MyAgent`) or a stack-qualified
logical ID (`MyStack:MyAgent`). A single-stack app may omit the stack. With no
target, an interactive terminal shows the runtimes in the app to choose from.
See [Naming the target](local-emulation.md#naming-the-target).

## Protocols and endpoints

The runtime's protocol decides which endpoints the local server exposes. All
of them are on the one `--port`.

| Protocol | Local endpoints | Container port |
| --- | --- | --- |
| HTTP, AGUI | `POST /invocations`, `GET /ping`, and the `/ws` WebSocket | `8080` |
| MCP | `POST /mcp` | `8000` |
| A2A | `POST /` | `9000` |

At startup cdkd prints what it bound:

| Protocol | Lines printed |
| --- | --- |
| HTTP, AGUI | `Server listening on ws://...` and `HTTP contract served on http://...` |
| MCP, A2A | `Server listening on http://...` and `<PROTOCOL> contract served on http://...` |

Requests and responses, including server-sent event streams, pass through to
the container with the AgentCore session ID added. `GET /ping` is never
authenticated. A request to a path the runtime does not serve gets a `404`
listing the paths it does serve.

### The `/ws` bridge

HTTP and AGUI runtimes also get `/ws` on the same port. Each client
connection opens its own connection to the container, and the bridge adds the
session-ID header and, for a JWT-authorizer runtime, the `Authorization`
header.

This is what lets a browser hold a WebSocket session with the agent: a
browser's `WebSocket` cannot set those headers itself.

MCP and A2A runtimes have no `/ws`.

## Inbound authentication

The runtime decides which check applies. A declared `customJwtAuthorizer`
always takes precedence.

| Runtime declares | Check | Flags |
| --- | --- | --- |
| `customJwtAuthorizer` | The local server verifies a JWT on each request | `--bearer-token`, `--no-verify-auth` |
| No `customJwtAuthorizer` | None by default | `--sigv4` to sign each forwarded request |

### `customJwtAuthorizer` runtimes

Each request's `Authorization` header is verified, as the cloud runtime does
on every invocation:

| Request | Result |
| --- | --- |
| Carries a token that verifies | Forwarded to the container |
| Carries a token that fails the signature, issuer, expiry, audience or scope check | `403` |
| Carries no token, and `--bearer-token` was given | That token is used, then verified |
| Carries no token, and no `--bearer-token` | `401` |
| Any of these under `--no-verify-auth` | Forwarded. A `--bearer-token` is still added. |

```bash
curl -X POST http://127.0.0.1:8080/invocations \
  -H "Authorization: Bearer $JWT" -d '{"prompt":"hello"}'
```

A `--bearer-token` is also verified against the runtime's OIDC discovery URL
before the container starts, and a rejected one stops startup.

> [!WARNING]
> When the OIDC discovery URL is unreachable or malformed, requests are
> accepted without verification, so that offline work is not blocked.

### Runtimes with no `customJwtAuthorizer`

`--sigv4` signs each forwarded request with SigV4 for the `bedrock-agentcore`
service, so the container sees the `Authorization` and `X-Amz-*` headers it
would receive in the cloud. On a runtime that declares a `customJwtAuthorizer`
it is ignored with a warning.

## State sources

`--from-state` and `--from-cfn-stack` resolve intrinsics (`Ref`, `Fn::GetAtt`,
`Fn::Sub`, `Fn::ImportValue`, `Fn::GetStackOutput`) in the runtime's container
image and environment variables. See
[Where values come from](local-emulation.md#where-values-come-from).

## `--watch`: reload the warm container in place

`--watch` re-synthesizes when the CDK source changes and replaces only the
container. The local server and its port stay up. `cdk.out`, `node_modules`
and `.git` are ignored, and `watch.include` / `watch.exclude` in `cdk.json`
are honoured.

| Edit | Reload |
| --- | --- |
| Source the running container can take as it is | The new source is copied in and the container restarted. Its ID and host port do not change. |
| Anything that needs a new image | A new container is started and the server is pointed at it. |

[`cdkd local invoke-agentcore`](local-invoke-agentcore.md#watch-reload-on-source-edits)
lists exactly which edits fall on each side. Either way, the container must
report ready within `--timeout` before requests resume.

## Building and stopping

The image is built or pulled as for
[`cdkd local invoke-agentcore`](local-invoke-agentcore.md#artifacts). A
source-code (`CodeConfiguration`) runtime runs your bundle as it is and
installs no dependencies.

{kbd:ctrl+c} or `SIGTERM` removes the container and exits.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Stopped by `SIGTERM`. |
| `1` | An error: no such runtime, synthesis failure, an image that would not build or pull, a container not ready within `--timeout`, or a `--bearer-token` rejected at boot. |
| `130` | Stopped by {kbd:ctrl+c}, or the picker was cancelled. |

The full cross-command table is in the
[CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd local invoke-agentcore`](local-invoke-agentcore.md): send one request
  and exit; also documents artifacts and the `--watch` rules
- [`cdkd local invoke`](local-invoke.md): run a Lambda function once
- [Local Execution](local-emulation.md): choosing a command, value
  resolution, and the flags every command shares
- [CLI Reference](cli-reference.md): every command and the full exit-code
  table
