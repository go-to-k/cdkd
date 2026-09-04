---
title: cdkd local invoke-agentcore
description: "Invoke a Bedrock AgentCore Runtime once in a local container over HTTP, MCP, A2A, AG-UI, or a bidirectional WebSocket."
---

# cdkd local invoke-agentcore

`cdkd local invoke-agentcore [target]` runs one Bedrock AgentCore Runtime from
your CDK app in a local Docker container and invokes it once over whichever
AgentCore protocol the runtime declares. Reach for it to exercise an agent
against a real request payload before deploying — the agent's outbound calls to
managed AWS services still reach real AWS. To drive the same agent repeatedly
from a client rather than firing one payload, use
[`cdkd local start-agentcore`](local-start-agentcore.md), which keeps the
container warm.

```bash
cdkd local invoke-agentcore MyStack/MyAgent -e prompt.json     # one-shot POST /invocations
cdkd local invoke-agentcore                                     # pick a runtime interactively (TTY)
cdkd local invoke-agentcore MyStack/MyAgent --from-state        # resolve env intrinsics from cdkd state
cdkd local invoke-agentcore MyStack/MyAgent --ws -e first.json  # bidirectional /ws session
cdkd local invoke-agentcore MyStack/MyAgent --watch --ws        # re-synth + reload on source edits
cdkd local invoke-agentcore MyStack/MyAgent 2> progress.log | tail -1  # payload is the LAST stdout line
```

Docker is required, and the container is pulled or built on the first run.
Both the container artifact (`fromContainerAsset` / `fromEcr`) and the
`CodeConfiguration` managed-runtime artifact (`fromCodeAsset`, built from
source) are supported.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[target]` | interactive picker | CDK display path or stack-qualified logical ID of the AgentCore Runtime. See [Target resolution](#target-resolution). |
| `-e`, `--event <file>` | `{}` | JSON request body file. Its meaning depends on the protocol — see [Protocols](#protocols). |
| `--event-stdin` | off | Read the request JSON from stdin. Mutually exclusive with `--event`. |
| `--env-vars <file>` | — | JSON env-var overrides, SAM-compatible shape. See [Local Execution](local-emulation.md#common-flags). |
| `--session-id <id>` | random UUID | Value of the AgentCore runtime session-id header. |
| `--ws` | off | Stream over the agent's bidirectional `/ws` endpoint instead of `POST /invocations`. HTTP / AG-UI only. See [`--ws`: bidirectional WebSocket streaming](#ws-bidirectional-websocket-streaming). |
| `--watch` | off | Re-synth and reload the container on CDK source edits. HTTP / AG-UI only. See [`--watch`: reload on source edits](#watch-reload-on-source-edits). |
| `--bearer-token <jwt>` | — | Bearer JWT presented when the runtime declares a `customJwtAuthorizer`. See [Inbound authentication](#inbound-authentication). |
| `--no-verify-auth` | off | Skip inbound JWT verification even when the runtime declares a `customJwtAuthorizer`. A `--bearer-token`, if given, is still forwarded. |
| `--sigv4` | off | Sign the `/invocations` POST with AWS SigV4 (service `bedrock-agentcore`). Mutually exclusive with `--bearer-token`. See [Inbound authentication](#inbound-authentication). |
| `--platform <platform>` | `linux/arm64` | `docker --platform` for the agent container. One of `linux/amd64`, `linux/arm64`. AgentCore's deployed architecture is arm64. |
| `--no-pull` | off | Skip `docker pull`. No-op on the local-build path. See [Local Execution](local-emulation.md#common-flags). |
| `--no-build` | off | Skip `docker build` on the local-asset path and reuse the previously built tag. No-op on the ECR / registry pull paths. |
| `--container-host <host>` | `127.0.0.1` | Host IP to bind the agent port to. See [Local Execution](local-emulation.md#common-flags). |
| `--timeout <ms>` | `120000` | Per-request timeout, applied to `POST /invocations`, `POST /mcp`, and the `/ws` open-to-close window. Raise it for long agent calls. |
| `--assume-role [arn]` | off | Run the agent under the runtime's execution role instead of your shell credentials. See [Credentials and role assumption](#credentials-and-role-assumption). |
| `--ecr-role-arn <arn>` | — | Role to assume before authenticating to ECR, for cross-account or centralized registries. Same-account, same-region pulls need no role. |
| `--from-state` | off | Substitute `Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::ImportValue` in env vars from cdkd's S3 state. Mutually exclusive with `--from-cfn-stack`. See [Environment variables](#environment-variables). |
| `--from-cfn-stack [cfn-stack-name]` | off | Substitute `Ref` / `Fn::ImportValue` in env vars from a deployed CloudFormation stack, for apps deployed via the upstream CDK CLI. Mutually exclusive with `--from-state`. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding cdkd state. Used only with `--from-state`. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. Used only with `--from-state`. |
| `--stack-region <region>` | auto | Region of the state record to read, and the CFn client region for `--from-cfn-stack`. See [Local Execution](local-emulation.md#common-flags). |
| `-a`, `--app <command>` | `cdk.json` / `CDKD_APP` | CDK app command, or a pre-synthesized cloud-assembly directory. |
| `--output <path>` | `cdk.out` | Output directory for synthesis. |
| `-c`, `--context <key=value...>` | — | Set CDK context values. Repeatable. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for cdkd's own AWS API calls (state reads, STS, ECR). Distinct from `--assume-role`, which targets the agent's credentials. |
| `-y`, `--yes` | off | Answer interactive prompts with the recommended response. |
| `--verbose` | off | Verbose logging (on stderr). |

## Target resolution

The optional `[target]` takes the same two forms
[`cdkd local invoke`](local-invoke.md#target-resolution) accepts:

- **CDK display path** — `MyStack/MyAgent`.
- **Stack-qualified logical ID** — `MyStack:MyAgentRuntime1234`.

Single-stack apps may omit the stack prefix. Omitting the target entirely in an
interactive terminal opens a picker over every AgentCore Runtime discovered in
the app; with no TTY, the command errors and tells you to name one.

## Protocols

The runtime's `Protocol` property decides which client cdkd uses and which
container port it publishes.

| `Protocol` | Container port | What cdkd sends | `--event` default |
| --- | --- | --- | --- |
| `HTTP` (default) | 8080 | `POST /invocations`, after `GET /ping` reports ready. | `{}` as the request body |
| `MCP` | 8000 (`/mcp`) | Session handshake (`initialize` → `notifications/initialized`), then one JSON-RPC request. | `tools/list` |
| `A2A` | 9000 (`POST /`) | One JSON-RPC round-trip. | `agent/getCard` |
| `AGUI` | 8080 | Routed through the same `/invocations` + `/ws` client path as `HTTP` — the AG-UI wire is SSE and WebSocket. | `{}` as the request body |

For `MCP` and `A2A`, `--event` is the JSON-RPC request itself: it must be a JSON
object carrying a string `method`, plus an optional `params`. An empty object
falls back to the protocol's default method above; anything else fails fast,
before any Docker work.

An `HTTP` / `AGUI` response that arrives as an SSE stream is printed
incrementally as it arrives; a non-streamed response is printed as one final
line.

## `--ws`: bidirectional WebSocket streaming

`--ws` opens the HTTP-protocol agent's bidirectional `/ws` endpoint on the same
port 8080 container, instead of `POST /invocations`. The `--event` body is sent
as the first frame, and every received frame is printed to stdout until the
agent closes the stream.

The two halves of interactive behaviour read **different streams**:

| Stream | Condition | Effect |
| --- | --- | --- |
| stdin | TTY | A REPL: each typed line is sent as a follow-up text frame until Ctrl-D or the agent closes. |
| stdin | piped / redirected / CI | Wire-faithful one-shot — only the `--event` frame is sent. Force this in a terminal with `--ws </dev/null`. |
| stdout | TTY | The `> ` prompt is written between frames. |
| stdout | redirected / piped | No prompt; the frame stream stays raw, so `--ws > frames.txt` and `--ws \| tail -1` mean what they look like. |

`--ws` is ignored with a warning on `MCP` and `A2A` runtimes, which have no
WebSocket surface.

## `--watch`: reload on source edits

`--watch` watches the CDK app's **source tree** — the synth working directory,
where `cdk.json` lives — honoring `cdk.json`'s `watch.include` /
`watch.exclude` and excluding `cdk.out`, `node_modules` and `.git`. On a source
edit it re-synths and reloads the agent container, mirroring `cdk watch`.

A per-firing classifier picks the reload primitive:

| Edit | Primitive |
| --- | --- |
| An interpreted-language source edit inside a `CodeConfiguration` (`fromCodeAsset`) source tree — no Dockerfile, dependency-manifest or compiled-source change, and no asset-hash change that matters | **Soft reload**: `docker cp` the freshly synthed source into the running container's WORKDIR, then `docker restart`. No `docker build`, no container swap — the container ID and host port are preserved. |
| A Dockerfile, compiled-source, asset-hash-changed or ambiguous edit; a `fromS3` or non-CDK-asset runtime; any classifier-context failure | **Full rebuild**: tear the container down (SIGTERM, then `docker rm -f`), re-resolve the image through the same build pipeline the cold boot runs, and start a fresh container. |

`--watch` applies to both the `--ws` session path and the default one-shot
`POST /invocations`, where the reload re-runs the single shot. On `--ws`, the
active socket is closed cleanly on each firing, so the next session reconnects
to the rebuilt or soft-reloaded container.

Reloads are chain-serialized — no two run in parallel — and a reload-callback
failure exits the watch loop cleanly rather than blocking on a stale port, since
the previous container may already be torn down. `^C` tears the container down
and exits.

For `MCP` and `A2A` runtimes `--watch` is a no-op warning and the single shot
proceeds: those protocols run once and exit, with no reconnect surface for a
watch loop to drive.

## Inbound authentication

A runtime with no `customJwtAuthorizer` is invoked unauthenticated by default.
`--sigv4` opts in to signing the `/invocations` POST with AWS SigV4 (service
`bedrock-agentcore`) using the resolved credentials, matching the cloud default
for such a runtime.

When the runtime **does** declare a `customJwtAuthorizer`:

| Flags | Behaviour |
| --- | --- |
| `--bearer-token <jwt>` | The token is verified against the runtime's OIDC discovery URL **before the container starts** — signature, `iss`, `aud`, `exp`, plus `allowedClients`, `allowedScopes` and `customClaims` — then forwarded on `/invocations` as `Authorization: Bearer <jwt>`. A rejected token errors before any Docker work. |
| neither flag | The command errors: the runtime requires an inbound JWT. Pass `--bearer-token`, or `--no-verify-auth`. |
| `--no-verify-auth` | Verification is skipped with a warning. A `--bearer-token`, if present, is still forwarded. |
| `--sigv4` | Ignored with a warning — the JWT path takes precedence. |

`--sigv4` and `--bearer-token` together are rejected: pick one inbound auth.
`--sigv4` is also ignored, with a warning, on the `MCP`, `A2A` and `--ws` paths,
because it signs the HTTP `/invocations` request only.

On `MCP` and `A2A` runtimes cdkd POSTs to the local container's `/mcp` or `/`
directly, speaking vanilla JSON-RPC. An inbound JWT is an AgentCore
managed-plane concern that the cloud front door layers on top, so
`--bearer-token` is **not** applied on those paths; cdkd logs a line saying so.

## Credentials and role assumption

By default the container receives your own AWS credentials, so the agent's
outbound AWS calls reach real AWS as you.

| Form | Behaviour |
| --- | --- |
| `--assume-role <arn>` | Assumes the explicit ARN and forwards the STS-issued temporary credentials to the container. |
| `--assume-role` (bare) | Uses the runtime's own `RoleArn` when the template carries it as a literal ARN, or resolves it from the loaded stack state. When neither can supply one, cdkd warns and falls back to your shell credentials. |
| flag omitted | Your shell credentials are forwarded unchanged. |

`--ecr-role-arn <arn>` is separate: it is the cross-account image-pull escape
hatch, assumed before `ecr:GetAuthorizationToken` and the pull.

## Environment variables

The runtime's env vars are substituted the same way
[`cdkd local invoke`](local-invoke.md#environment-variables) substitutes a
Lambda's. Without a state source, intrinsic-valued entries are warned and
dropped; `--from-state` reads cdkd's S3 state for the target stack, and
`--from-cfn-stack [name]` reads a deployed CloudFormation stack via
`ListStackResources` for apps deployed through the upstream CDK CLI. The
two flags are mutually exclusive, and `--env-vars` overrides win over both.

A state source also feeds image resolution: a same-stack ECR repository
referenced from the runtime's `ContainerUri` is reduced to the deployed image
URI before the container is resolved.

## `CodeConfiguration` builds

A `fromCodeAsset` / `fromS3` source build matches the AWS managed runtime: it
runs the bundle **as-is** and does **not** install your dependencies — no `pip
install` from `requirements.txt` / `pyproject.toml`, no `npm install`. The
deployed runtime resolves dependencies that were vendored into the bundle at
deploy time, for example arm64 wheels installed with `uv pip install --target`.

So a bundle that declares a dependency manifest without vendored dependencies
fails locally with `ModuleNotFoundError` exactly as it fails deployed, instead
of passing locally only because of a local install. cdkd emits a warning naming
the vendoring recipe. Vendor your dependencies into the bundle — a successful
deploy already requires it.

Container artifacts (`fromContainerAsset` / `fromEcr`) are unaffected. The same
build behaviour applies to
[`cdkd local start-agentcore`](local-start-agentcore.md).

## Output streams

Everything cdkd's own logger prints goes to **stderr**; stdout carries the
agent's response. Stdout is not payload-only — the container's own stdout and
the shared container-build logger also reach it — so the response is the **last
line** on stdout rather than the only one:

```bash
cdkd local invoke-agentcore MyStack/Agent 2> progress.log | tail -1
```

The full account of what reaches stdout is in [`cdkd local
invoke`](local-invoke.md#output-streams), which shares the same reservation.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The agent answered and the response was printed. |
| `1` | The agent answered with an error, or cdkd could not get as far as an answer. |
| `130` | `^C` (SIGINT). The container is stopped and removed before the process exits. |

Exit `1` covers both an unhappy answer and a failure to reach one:

| Cause | Detail |
| --- | --- |
| Agent error response | `POST /invocations` returned HTTP 400 or above, or an MCP / A2A response carried a JSON-RPC error. |
| Readiness timeout | The container did not answer `GET /ping` within `--timeout`. |
| Target not resolved | No matching runtime, or an ambiguous display path. |
| Container not started | Docker unavailable, or the image pull or build failed. |
| Malformed `--event` | The payload is not a valid JSON-RPC request for an `MCP` or `A2A` runtime. |
| Inbound auth refused | A `customJwtAuthorizer` runtime with no token, or a token the authorizer rejected. |
| Contradictory flags | `--sigv4` with `--bearer-token`, or `--from-state` with `--from-cfn-stack`. |

The full cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

## Limitations

- `--ws` and `--watch` apply only to the `HTTP` and `AGUI` protocols. On `MCP`
  and `A2A` they are ignored with a warning, and the single shot proceeds.
- `--sigv4` signs `POST /invocations` only — not `/mcp`, not `POST /` for A2A,
  and not the `/ws` handshake.
- An inbound JWT is not enforced on the `MCP` and `A2A` paths, because cdkd
  talks to the container directly rather than through the AgentCore front door.
- A `CodeConfiguration` build installs no dependencies. See
  [`CodeConfiguration` builds](#codeconfiguration-builds).
- One invocation per run. To keep a warm container across many requests, use
  [`cdkd local start-agentcore`](local-start-agentcore.md).

## Related

- [`cdkd local start-agentcore`](local-start-agentcore.md) — the long-running counterpart, serving a warm container across all four protocols
- [`cdkd local invoke`](local-invoke.md) — the same one-shot shape for a Lambda function, and the full output-stream and env-var reference
- [Local Execution](local-emulation.md) — every `cdkd local` subcommand, the Docker requirement, and the flags they share
- [CLI Reference](cli-reference.md) — every command and the full exit-code table
