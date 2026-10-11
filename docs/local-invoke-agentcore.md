---
title: cdkd local invoke-agentcore
description: "Run a Bedrock AgentCore Runtime from your CDK app in a local container and send it one request over HTTP, MCP, A2A, AG-UI or a WebSocket."
---

# cdkd local invoke-agentcore

`cdkd local invoke-agentcore [target]` runs one Bedrock AgentCore Runtime from
your CDK app in a local container, sends it one request over the protocol the
runtime declares, and prints the response. The agent's own calls to AWS
services still reach real AWS.

To send many requests to the same agent from a client, use
[`cdkd local start-agentcore`](local-start-agentcore.md), which keeps the
container running.

## Invoke an agent

Given a runtime in `MyStack`, built from a `Dockerfile` in `agent/`:

```ts
import * as path from 'node:path';
import { AgentRuntimeArtifact, Runtime } from 'aws-cdk-lib/aws-bedrockagentcore';

new Runtime(this, 'MyAgent', {
  agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '../agent')),
  environmentVariables: { GREETING: 'hello' },
});
```

write a request body and invoke the runtime:

```bash
echo '{"prompt": "hello"}' > prompt.json
cdkd local invoke-agentcore MyStack/MyAgent --event prompt.json
```

cdkd builds the image, starts the container, waits for `GET /ping` to report
ready, and sends `POST /invocations`. Progress and the agent's log lines go to
stderr. The agent's response is the last line on stdout:

```bash
cdkd local invoke-agentcore MyStack/MyAgent -e prompt.json 2> progress.log | tail -1
```

More invocations:

```bash
cdkd local invoke-agentcore                                     # pick a runtime from a list
cdkd local invoke-agentcore MyStack/MyAgent --from-state        # use the deployed stack's values
cdkd local invoke-agentcore MyStack/MyAgent --ws -e first.json  # a WebSocket session
cdkd local invoke-agentcore MyStack/MyAgent --watch --ws        # reload on source edits
cdkd local invoke-agentcore MyStack/MyAgent --bearer-token "$JWT" -e prompt.json  # a runtime with a JWT authorizer
```

Docker is required. See [Local Execution](local-emulation.md#requirements).

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[target]` | picker | The AgentCore Runtime to invoke. See [Target resolution](#target-resolution). |
| `-e`, `--event <file>` | `{}` | JSON request file. Its meaning depends on the protocol; see [Protocols](#protocols). |
| `--event-stdin` | off | Read the request JSON from stdin. Cannot be combined with `--event`. |
| `--session-id <id>` | random UUID | Value of the AgentCore session-id header. |
| `--ws` | off | Use the agent's `/ws` WebSocket endpoint. See [`--ws`](#ws-bidirectional-websocket-streaming). |
| `--watch` | off | Reload the container on source edits. See [`--watch`](#watch-reload-on-source-edits). |
| `--bearer-token <jwt>` | — | JWT to present to a runtime with a `customJwtAuthorizer`. See [Inbound authentication](#inbound-authentication). |
| `--no-verify-auth` | off | Skip JWT verification. A `--bearer-token` is still forwarded. |
| `--sigv4` | off | Sign `POST /invocations` with AWS SigV4. Cannot be combined with `--bearer-token`. |
| `--timeout <ms>` | `120000` | Per-request timeout, for `POST /invocations`, `POST /mcp` and a whole `/ws` session. |
| `--platform <platform>` | `linux/arm64` | `linux/amd64` or `linux/arm64`. Deployed AgentCore runtimes are arm64. |
| `--assume-role [arn]` | off | Run the agent under the runtime's execution role. See [Credentials and role assumption](#credentials-and-role-assumption). |
| `--no-assume-role` | — | Explicitly keep your own credentials. |
| `--no-pull` | off | Skip `docker pull`. No effect when the image is built locally. |
| `--no-build` | off | Reuse the previously built image. No effect when the image is pulled. |
| `--ecr-role-arn <arn>` | — | Role to assume before pulling from another account's ECR registry. |

It also accepts every [common flag](local-emulation.md#common-flags).
`--env-vars` is keyed by the runtime's logical ID or display path, and
`--container-host` is the IP the agent's port binds to.

## Target resolution

The target is a CDK display path (`MyStack/MyAgent`) or a stack-qualified
logical ID (`MyStack:MyAgentRuntime1234`). A single-stack app may omit the
stack. See [Naming the target](local-emulation.md#naming-the-target).

With no target, an interactive terminal shows every AgentCore Runtime in the
app to choose from. A non-interactive shell reports an error telling you to
name one.

## Artifacts

| Artifact | CDK | How it runs |
| --- | --- | --- |
| Container image | `AgentRuntimeArtifact.fromAsset`, `fromEcrRepository`, `fromImageUri` | Built from the Docker asset, or pulled. |
| Source code (`CodeConfiguration`) | `AgentRuntimeArtifact.fromCodeAsset`, `fromS3` | Built from source for the declared runtime. |

### `CodeConfiguration` builds

A source build runs your bundle as it is, like the AWS managed runtime. It
does not run `pip install` or `npm install`. Dependencies must already be in
the bundle, for example arm64 wheels installed with
`uv pip install --target`.

A bundle that declares dependencies without including them fails locally with
`ModuleNotFoundError`, as it would deployed, and cdkd prints a warning with
the steps to include them.

## Protocols

The runtime's `Protocol` property decides what cdkd sends and which container
port it uses.

| `Protocol` | Container port | What cdkd sends | With the default `--event` |
| --- | --- | --- | --- |
| `HTTP` (default) | 8080 | `POST /invocations`, once `GET /ping` reports ready | `{}` as the body |
| `MCP` | 8000 (`/mcp`) | The session handshake, then one JSON-RPC request | `tools/list` |
| `A2A` | 9000 (`POST /`) | One JSON-RPC request | `agent/getCard` |
| `AGUI` | 8080 | The same `/invocations` and `/ws` paths as `HTTP` | `{}` as the body |

For `MCP` and `A2A`, the event is the JSON-RPC request: an object with a
string `method` and optional `params`. Anything else is rejected before any
Docker work.

```bash
echo '{"method": "tools/call", "params": {"name": "search", "arguments": {"q": "cdkd"}}}' \
  | cdkd local invoke-agentcore MyStack/McpAgent --event-stdin
```

A response that arrives as a server-sent event stream is printed as it
arrives. Any other response is printed as one line.

## `--ws`: bidirectional WebSocket streaming

`--ws` opens the agent's `/ws` endpoint instead of sending
`POST /invocations`. The `--event` body is the first frame, and every frame
received is printed to stdout until the agent closes the stream.

| Stream | Is | Effect |
| --- | --- | --- |
| stdin | A terminal | Each line you type is sent as a frame, until {kbd:ctrl+d} or the agent closes. |
| stdin | Piped or redirected | Only the `--event` frame is sent. Force this in a terminal with `--ws </dev/null`. |
| stdout | A terminal | A `> ` prompt is printed between frames. |
| stdout | Piped or redirected | No prompt. Only frames are written, so `--ws > frames.txt` holds the frames. |

`--ws` applies to `HTTP` and `AGUI` runtimes. On `MCP` and `A2A` it is ignored
with a warning.

## `--watch`: reload on source edits

`--watch` watches the CDK app's source directory (where `cdk.json` is),
re-synthesizes on an edit and reloads the agent container. `cdk.out`,
`node_modules` and `.git` are ignored, and `watch.include` / `watch.exclude`
in `cdk.json` are honoured.

| Edit | Reload |
| --- | --- |
| Interpreted-language source inside a `fromCodeAsset` source directory, with no Dockerfile, dependency-manifest or compiled-source change | The new source is copied into the running container and the container restarted. Its ID and host port do not change. |
| Anything else: a Dockerfile, compiled source, a `fromS3` runtime, or an edit that cannot be classified | The container is removed, the image rebuilt, and a new container started. |

| Mode | After a reload |
| --- | --- |
| Default (`POST /invocations`) | The request is sent again. |
| `--ws` | The open socket is closed cleanly, and the next session connects to the reloaded container. |
| `MCP` or `A2A` runtime | `--watch` is ignored with a warning and the single request proceeds. |

If a reload fails, the watch loop exits. {kbd:ctrl+c} removes the container,
including one a rebuild is still starting.

## Inbound authentication

What applies depends on whether the runtime declares a `customJwtAuthorizer`.

| Runtime | Flags | Result |
| --- | --- | --- |
| No authorizer | None | Invoked unauthenticated. |
| No authorizer | `--sigv4` | `POST /invocations` is signed with SigV4 (service `bedrock-agentcore`), as the cloud does by default. |
| JWT authorizer | `--bearer-token <jwt>` | The token is verified, then sent as `Authorization: Bearer <jwt>`. A rejected token is an error before any Docker work. |
| JWT authorizer | None | Error. Pass `--bearer-token` or `--no-verify-auth`. |
| JWT authorizer | `--no-verify-auth` | Verification is skipped with a warning. A `--bearer-token` is still sent. |
| JWT authorizer | `--sigv4` | Ignored with a warning. |

The token is verified against the runtime's OIDC discovery URL before the
container starts: signature, `iss`, `aud`, `exp`, and the authorizer's
`allowedClients`, `allowedScopes` and `customClaims`.

Authentication applies to `POST /invocations` only:

- `--sigv4` is ignored, with a warning, on `MCP`, `A2A` and `--ws`.
- `--bearer-token` is not applied on `MCP` and `A2A`, where cdkd talks to the
  container directly. A log line says so.

### Whose credentials sign a `--sigv4` request

The signature identifies the caller, so cdkd signs as you: the `--assume-role`
role if given, then `--profile`, then your shell credentials. The `--role-arn`
role is never used; it is the identity for cdkd's own calls.

With `--role-arn`, if your own credentials come from IAM Identity Center, an
EC2 instance role or an ECS container role, `--sigv4` is refused, because
there is nothing of yours to sign with. Pass `--profile <name>` or
`--assume-role <arn>`, or export `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` before running cdkd.

## Credentials and role assumption

By default the container gets your own AWS credentials, so the agent calls AWS
as you.

| Form | Behaviour |
| --- | --- |
| `--assume-role <arn>` | Assumes that role. It must be a well-formed role ARN (`arn:<partition>:iam::<account>:role/<name>`, at most 2048 characters). |
| `--assume-role` | Uses the runtime's `RoleArn`: a literal ARN in the template, or the one in the loaded stack state. With neither, cdkd warns and uses your credentials. |
| Flag omitted | Your credentials are used. |
| `--no-assume-role` | Your credentials are used, stated explicitly. |

## Environment variables

The runtime's environment variables are resolved as
[Where values come from](local-emulation.md#where-values-come-from) describes,
the same way [`cdkd local invoke`](local-invoke.md#environment-variables)
resolves a Lambda's.

A state flag also resolves the image: a same-stack ECR repository referenced
from the runtime's `ContainerUri` becomes the deployed image URI.

Under [finch on macOS and Windows](local-emulation.md#finch-on-macos-and-windows),
an invoke whose environment holds a decrypted SecureString is refused before
the container starts.

## Output streams

stdout carries the agent's response. cdkd's own log lines and the agent
container's output go to stderr.

When cdkd builds the agent's image, build progress lines also reach stdout, so
take the last line:

```bash
cdkd local invoke-agentcore MyStack/MyAgent 2> progress.log | tail -1
```

`progress.log` then also holds whatever the agent printed.
[`cdkd local invoke`](local-invoke.md#output-streams) describes the same
streams in more detail.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The agent answered and the response was printed. |
| `1` | The agent answered with an error, or cdkd could not get an answer. |
| `130` | {kbd:ctrl+c}. The container is removed first. |

Unlike [`cdkd local invoke`](local-invoke.md#exit-codes), an error answer is a
non-zero exit here. Causes of exit `1`:

| Cause | Detail |
| --- | --- |
| Agent error response | `POST /invocations` returned HTTP 400 or above, or an MCP / A2A response carried a JSON-RPC error. |
| Readiness timeout | The container did not answer `GET /ping` within `--timeout`. |
| Target not resolved | No matching runtime, or an ambiguous display path. |
| Container not started | Docker unavailable, or the image pull or build failed. |
| Malformed `--event` | Not a valid JSON-RPC request, for an `MCP` or `A2A` runtime. |
| Inbound auth refused | A JWT-authorizer runtime with no token, or a rejected token. |
| Contradictory flags | `--sigv4` with `--bearer-token`, or `--from-state` with `--from-cfn-stack`. |

The full cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd local start-agentcore`](local-start-agentcore.md): keep the agent
  running and call it from a client
- [`cdkd local invoke`](local-invoke.md): the same one-shot shape for a Lambda
  function
- [Local Execution](local-emulation.md): choosing a command, value
  resolution, and the flags every command shares
- [CLI Reference](cli-reference.md): every command and the full exit-code
  table
