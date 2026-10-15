---
title: cdkd local invoke-agentcore
description: "Run a Bedrock AgentCore Runtime from your CDK app in a local container and send it one request over HTTP, MCP, A2A, AG-UI or a WebSocket."
---

# cdkd local invoke-agentcore

`cdkd local invoke-agentcore [target]` runs one Bedrock AgentCore Runtime from
your CDK app in a local container, sends it one request, and prints the
response. Only the agent runs locally: when its code calls an AWS service,
such as a Bedrock model, the call goes to real AWS.

To send many requests to the same agent from a client, use
[`cdkd local start-agentcore`](local-start-agentcore.md), which keeps the
container running.

## Invoke an agent

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
  environmentVariables: { GREETING: 'hello' },
});
```

write a request body and invoke the runtime:

```bash
echo '{"prompt": "hello"}' > prompt.json
cdkd local invoke-agentcore MyStack/MyAgent --event prompt.json
```

cdkd builds the image and starts the container. It waits until the agent
answers `GET /ping` as ready, then sends the file as the body of
`POST /invocations`. Progress and the agent's log lines go to stderr, and
stdout carries the agent's response alone:

```bash
cdkd local invoke-agentcore MyStack/MyAgent -e prompt.json 2> progress.log
```

More invocations:

```bash
# pick a runtime from a list
cdkd local invoke-agentcore

# use the deployed stack's values
cdkd local invoke-agentcore MyStack/MyAgent --from-state

# a WebSocket session
cdkd local invoke-agentcore MyStack/MyAgent --ws -e first.json

# reload on source edits
cdkd local invoke-agentcore MyStack/MyAgent --watch --ws

# a runtime with a JWT authorizer
cdkd local invoke-agentcore MyStack/MyAgent --bearer-token "$JWT" -e prompt.json
```

Docker is required. [Local Execution](local-emulation.md) lists the
requirements.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[target]` | picker | The AgentCore Runtime to invoke. |
| `-e`, `--event <file>` | `{}` | JSON file holding the request. |
| `--event-stdin` | off | Read the request JSON from stdin. |
| `--session-id <id>` | random UUID | Value of the AgentCore session-id header. |
| `--ws` | off | Use the agent's `/ws` WebSocket endpoint. |
| `--watch` | off | Reload the container on source edits. |
| `--bearer-token <jwt>` | — | JWT to present to a runtime with a JWT authorizer. |
| `--no-verify-auth` | off | Skip JWT verification. |
| `--sigv4` | off | Sign `POST /invocations` with AWS SigV4. |
| `--timeout <ms>` | `120000` | Per-request timeout. |
| `--platform <platform>` | `linux/arm64` | `linux/amd64` or `linux/arm64`. |
| `--assume-role [arn]` | off | Run the agent under the runtime's execution role. |
| `--no-assume-role` | — | Explicitly keep your own credentials. |
| `--no-pull` | off | Skip `docker pull`. |
| `--no-build` | off | Reuse the image built last time. |
| `--ecr-role-arn <arn>` | — | Role to assume before pulling from ECR. |

Notes on these flags:

- `--event-stdin` cannot be combined with `--event`, and `--sigv4` cannot be
  combined with `--bearer-token`.
- `--timeout` applies to one `POST /invocations`, to one `POST /mcp`, and to
  a whole `/ws` session.
- The default platform is arm64 because deployed AgentCore runtimes are
  arm64.
- `--no-pull` has no effect when the image is built locally, and `--no-build`
  has none when the image is pulled.
- `--ecr-role-arn` is for an image in another account's ECR registry.

The command also accepts every common flag listed in
[Local Execution](local-emulation.md). Two of them behave in a way specific to
this command: the `--env-vars` file is keyed by the runtime's logical ID or
display path, and `--container-host` sets the IP the agent's port binds to.

## Target resolution

The target names one AgentCore Runtime. You can write it as a CDK display path
(`MyStack/MyAgent`) or as a stack-qualified logical ID
(`MyStack:MyAgentRuntime1234`), and an app with one stack may omit the stack.
[Local Execution](local-emulation.md) describes the forms in full.

When you name no target in an interactive terminal, cdkd lists every AgentCore
Runtime in the app and you choose one. In a non-interactive shell, naming no
target is an error that tells you to name one.

## Protocols

An AgentCore Runtime speaks one of four protocols, set by its `Protocol`
property. cdkd reads that property and sends the request the protocol expects,
so the same command works for all four.

| `Protocol` | What cdkd sends | With no `--event` | Container port |
| --- | --- | --- | --- |
| `HTTP` (default) | `POST /invocations` | Body `{}` | 8080 |
| `AGUI` | `POST /invocations` | Body `{}` | 8080 |
| `MCP` | One JSON-RPC request to `/mcp` | `tools/list` | 8000 |
| `A2A` | One JSON-RPC request to `POST /` | `agent/getCard` | 9000 |

For `HTTP` and `AGUI`, the event file is the request body. cdkd sends it once
`GET /ping` reports the agent ready. An `AGUI` runtime uses the same
`/invocations` and `/ws` paths as an `HTTP` one.

For `MCP` and `A2A`, the event file is the JSON-RPC request itself: an object
with a string `method` and, optionally, `params`. For `MCP`, cdkd performs the
session handshake first. This calls one MCP tool:

```bash
echo '{"method": "tools/call",
  "params": {"name": "search", "arguments": {"q": "cdkd"}}}' \
  | cdkd local invoke-agentcore MyStack/McpAgent --event-stdin
```

An event that is not a JSON-RPC request is rejected before cdkd does any
Docker work.

When the agent answers with a server-sent event stream, cdkd prints the events
as they arrive. Any other response is printed as one line.

## `--ws`: bidirectional WebSocket streaming

`--ws` opens the agent's `/ws` WebSocket endpoint in place of sending
`POST /invocations`. Use it for an agent that streams in both directions.

```bash
cdkd local invoke-agentcore MyStack/MyAgent --ws -e first.json
```

cdkd sends the `--event` body as the first frame and prints every frame it
receives to stdout, until the agent closes the stream. In a terminal the
session is interactive: cdkd prints a `> ` prompt between frames, and each
line you type is sent as a frame. Press {kbd:ctrl+d} to end the session.

### In a script

When stdin is piped or redirected, cdkd sends only the `--event` frame. To get
that behaviour in a terminal, redirect stdin yourself with `--ws </dev/null`.

When stdout is piped or redirected, cdkd prints no prompt and writes only the
frames, so `--ws > frames.txt` captures exactly what the agent sent.

### Protocols without `/ws`

`--ws` applies to `HTTP` and `AGUI` runtimes. On an `MCP` or `A2A` runtime it
is ignored with a warning.

## Inbound authentication

Inbound authentication is the check a deployed runtime makes on whoever calls
it. A deployed runtime uses one of two checks. By default it requires requests
signed with AWS SigV4. A runtime that declares a `customJwtAuthorizer`
requires a JWT from your identity provider instead. Locally, cdkd acts as the
caller, and these flags make it authenticate the way a real caller would.

Authentication applies to `POST /invocations`. The other modes are covered
under [When an authentication flag is ignored](#when-an-authentication-flag-is-ignored).

### A runtime with no authorizer

By default cdkd sends the request unauthenticated. Pass `--sigv4` to sign it
as a caller of the deployed runtime would:

```bash
cdkd local invoke-agentcore MyStack/MyAgent --sigv4 -e prompt.json
```

cdkd then signs `POST /invocations` with SigV4 for the `bedrock-agentcore`
service.

### A runtime with a JWT authorizer

Pass the token with `--bearer-token`:

```bash
cdkd local invoke-agentcore MyStack/MyAgent --bearer-token "$JWT" -e prompt.json
```

Before it starts the container, cdkd verifies the token against the runtime's
OIDC discovery URL. It checks the signature, the `iss`, `aud` and `exp`
claims, and the authorizer's `allowedClients`, `allowedScopes` and
`customClaims`. A token that passes is sent to the agent as
`Authorization: Bearer <jwt>`. A token that fails is an error, reported before
cdkd does any Docker work.

Invoking such a runtime with no token is an error too. If you have no token to
hand, `--no-verify-auth` skips the verification with a warning. A
`--bearer-token` given together with it is still sent to the agent.

### When an authentication flag is ignored

- **`--sigv4` on a runtime with a JWT authorizer.** The flag is ignored with a
  warning.
- **`--sigv4` on an `MCP` or `A2A` runtime, or with `--ws`.** The flag is
  ignored with a warning.
- **`--bearer-token` on an `MCP` or `A2A` runtime.** The token is not applied,
  because cdkd talks to the container directly on those protocols. A log line
  says so.

### Whose credentials sign a `--sigv4` request

A signature identifies the caller, so cdkd signs as you. It uses the first of
these that is present: the `--assume-role` role, then `--profile`, then the
credentials in your shell.

The `--role-arn` role is never used to sign. That role is the identity for
cdkd's own AWS calls, not yours. This matters in one case: you pass
`--role-arn`, and your own credentials come from IAM Identity Center, an EC2
instance role or an ECS container role. cdkd then has nothing of yours to sign
with and refuses `--sigv4`. Any one of these fixes it:

- pass `--profile <name>`,
- pass `--assume-role <arn>`,
- export `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` before running cdkd.

## Credentials and role assumption

By default the agent container gets your own AWS credentials, so the agent
calls AWS as you. `--assume-role` runs the agent under a role instead. Use it
to find out whether the runtime's execution role has the permissions the agent
needs, which your own credentials would hide.

```bash
cdkd local invoke-agentcore MyStack/MyAgent --assume-role -e prompt.json
```

- **`--assume-role` with no value** uses the runtime's own `RoleArn`. cdkd
  takes it from the template when it is a literal ARN there, and otherwise
  from the deployed stack's values, if a state flag loaded them (see
  [Environment variables](#environment-variables)). If it finds neither, it
  prints a warning and uses your credentials.
- **`--assume-role <arn>`** assumes the role you name. The value must be a
  well-formed role ARN, `arn:<partition>:iam::<account>:role/<name>`, of at
  most 2048 characters.
- **`--no-assume-role`** states explicitly that your credentials are used,
  which is also what happens when you omit both flags.

## Environment variables

The container receives the environment variables the runtime declares, such as
`GREETING` in the example above. A variable whose value refers to another
resource needs a deployed stack to resolve it, which is what the state flags,
`--from-state` and `--from-cfn-stack`, provide.
[Local Execution](local-emulation.md) explains where values come from. The rules are the same ones
[`cdkd local invoke`](local-invoke.md) applies to a Lambda function.

A state flag also resolves the image. When the runtime's `ContainerUri`
refers to an ECR repository in the same stack, cdkd uses the deployed image
URI.

With finch on macOS or Windows, cdkd refuses an invoke whose environment holds
a decrypted SecureString parameter, before the container starts.
[Local Execution](local-emulation.md) explains the refusal and the ways around
it.

## Artifacts

A runtime's code reaches AgentCore either as a container image or as a bundle
of source code. cdkd runs both.

| Artifact | CDK | How it runs |
| --- | --- | --- |
| Container image | `AgentRuntimeArtifact.fromAsset`, `fromEcrRepository`, `fromImageUri` | Built from the Docker asset, or pulled |
| Source code | `AgentRuntimeArtifact.fromCodeAsset`, `fromS3` | Built from source for the declared runtime |

### `CodeConfiguration` builds

A source-code runtime, which the template expresses as `CodeConfiguration`,
runs your bundle exactly as it is. The AWS managed runtime does the same.
Neither one runs `pip install` or `npm install`, so the dependencies must
already be inside the bundle. For a Python agent, that means arm64 wheels
installed into the bundle directory, for example with
`uv pip install --target`.

A bundle that declares dependencies without including them fails locally with
`ModuleNotFoundError`, as it would when deployed. cdkd prints a warning with
the steps to include them.

## `--watch`: reload on source edits

`--watch` keeps the command running. After each edit to your source, cdkd
synthesizes the app again, reloads the agent container and sends the request
again, so you see the new response without retyping the command.

```bash
cdkd local invoke-agentcore MyStack/MyAgent --watch -e prompt.json
```

cdkd watches the directory that holds `cdk.json`. Changes under `cdk.out`,
`node_modules` and `.git` are ignored, and the `watch.include` and
`watch.exclude` settings in `cdk.json` are honoured.

With `--ws`, a reload closes the open socket cleanly, and the next session
connects to the reloaded container.

### Which edits need a rebuild

cdkd reloads in one of two ways:

- **Copy and restart.** cdkd copies the new source into the running container
  and restarts it. The container keeps its ID and its host port. This applies
  when the edit is to interpreted-language source inside a `fromCodeAsset`
  source directory, and touches no Dockerfile, dependency manifest or compiled
  source.
- **Rebuild.** cdkd removes the container, rebuilds the image and starts a
  new container. This applies to everything else: a Dockerfile, compiled
  source, a `fromS3` runtime, or an edit cdkd cannot classify.

### Edge cases

- **An `MCP` or `A2A` runtime.** `--watch` is ignored with a warning, and the
  single request proceeds.
- **A reload fails.** The watch loop exits.
- **{kbd:ctrl+c} during a rebuild.** cdkd removes the container, including one
  that the rebuild is still starting.

## Output streams

stdout carries the agent's response. cdkd's own log lines and the agent
container's output go to stderr.

When cdkd builds the agent's image, the build's progress lines go to stderr
too, unless `CDKL_LOG_LEVEL` or `CDKL_LOG_STREAM` is exported, in which case
the bundled engine prints them on stdout ahead of the response.

```bash
cdkd local invoke-agentcore MyStack/MyAgent 2> progress.log
```

`progress.log` then holds cdkd's log lines and whatever the agent printed.
[`cdkd local invoke`](local-invoke.md) describes the same streams in more
detail.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The agent answered and the response was printed. |
| `1` | The agent answered with an error, or cdkd could not get an answer. |
| `130` | {kbd:ctrl+c}. The container is removed first. |

An error answer from the agent is a non-zero exit here, which differs from
[`cdkd local invoke`](local-invoke.md). These are the causes of exit `1`:

| Cause | Detail |
| --- | --- |
| Agent error response | HTTP 400 or above, or a JSON-RPC error from `MCP` / `A2A`. |
| Readiness timeout | No ready answer to `GET /ping` within `--timeout`. |
| Target not resolved | No matching runtime, or an ambiguous display path. |
| Container not started | Docker unavailable, or the image pull or build failed. |
| Malformed `--event` | Not a JSON-RPC request, on an `MCP` or `A2A` runtime. |
| Inbound auth refused | A JWT-authorizer runtime with no token, or a rejected token. |
| Contradictory flags | `--sigv4` with `--bearer-token`, or `--from-state` with `--from-cfn-stack`. |

The [CLI Reference](cli-reference.md) has the exit-code table for every
command.

## Related

- [`cdkd local start-agentcore`](local-start-agentcore.md): keep the agent
  running and call it from a client
- [`cdkd local invoke`](local-invoke.md): the same one-shot shape for a Lambda
  function
- [Local Execution](local-emulation.md): choosing a command, value
  resolution, and the flags every command shares
- [CLI Reference](cli-reference.md): every command and the full exit-code
  table
