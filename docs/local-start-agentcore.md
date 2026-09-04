---
title: cdkd local start-agentcore
description: "Keep a Bedrock AgentCore Runtime container warm and serve all four protocols locally, with hot reload and a browser-friendly WebSocket front-door."
---

# cdkd local start-agentcore

`cdkd local start-agentcore [target]` boots an `AWS::BedrockAgentCore::Runtime`
container **once**, keeps it warm, and serves the runtime's native protocol
contract on a local port so a client can hit it repeatedly. It is the
long-running counterpart of the single-shot
[`cdkd local invoke-agentcore`](local-invoke-agentcore.md) — reach for it when
you are driving an agent from a client (a browser, an MCP host, a test suite)
rather than firing one payload. Runs until `^C`. Docker is required.

```bash
cdkd local start-agentcore MyStack/MyAgent                       # serve on an OS-assigned port
cdkd local start-agentcore                                       # pick a runtime interactively (TTY)
cdkd local start-agentcore MyStack/MyAgent --port 8080           # pin the host port
cdkd local start-agentcore MyStack/MyAgent --bearer-token "$JWT" # default token for a customJwtAuthorizer runtime
cdkd local start-agentcore MyStack/MyAgent --sigv4               # sign forwarded requests for a SigV4 runtime
cdkd local start-agentcore MyStack/MyAgent --from-state --watch  # bind cdkd state, reload the container on edits
```

## Options

`-a, --app`, `--env-vars`, `--no-pull`, `--from-state`, `--stack-region` and
`--container-host` behave as they do on every `cdkd local` subcommand; see
[Local Execution](local-emulation.md#common-flags).

| Flag | Default | Description |
| --- | --- | --- |
| `[target]` | interactive picker | The runtime to serve, as a CDK display path (`MyStack/MyAgent`) or a stack-qualified logical ID. Omit in a TTY to pick from a list. |
| `--port <n>` | `0` (OS-assigned) | Host port the client connects to. The HTTP contract and the `/ws` bridge share it. |
| `--host <ip>` | `127.0.0.1` | Host the local server binds to. |
| `--session-id <id>` | fresh UUID per request | Pin one AgentCore session id across every forwarded request and `/ws` connection. |
| `--bearer-token <jwt>` | — | Bearer JWT used when an inbound request carries no `Authorization` of its own. Verified against the runtime's OIDC discovery URL before the container starts. |
| `--no-verify-auth` | off | Skip inbound JWT verification even when the runtime declares a `customJwtAuthorizer`. A `--bearer-token`, if given, is still forwarded. |
| `--sigv4` | off | Sign each forwarded request with AWS SigV4 (service `bedrock-agentcore`). Mutually exclusive with `--bearer-token`. |
| `--timeout <ms>` | `120000` | How long the container has to answer `GET /ping` and become ready. |
| `--platform <platform>` | `linux/arm64` | `docker --platform` for the agent container. Only `linux/amd64` and `linux/arm64` are accepted. |
| `--watch` | off | Re-synth and reload the warm container in place on a CDK source change, keeping the local server up. |
| `--no-pull` | off | Skip `docker pull` and use the cached image. No-op on the local-build path. |
| `--no-build` | off | Skip `docker build` on the local-asset path and reuse the previously built tag. No-op on the ECR / registry pull paths. |
| `--assume-role [arn]` | off | Assume the runtime's execution role — bare form uses its literal `RoleArn` — and forward temporary credentials into the container. Omit the flag to keep your own shell credentials in the container. |
| `--ecr-role-arn <arn>` | — | Role to assume before authenticating against ECR, for cross-account or centralized registries. |
| `--from-state` | off | Resolve intrinsics in the runtime's container image and environment variables from cdkd's S3 state. Mutually exclusive with `--from-cfn-stack`. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding cdkd state. Only meaningful with `--from-state`. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. Only meaningful with `--from-state`. |
| `--from-cfn-stack [name]` | off | Resolve the same values from a deployed CloudFormation stack, for apps deployed with the CDK CLI. Bare form uses the resolved stack name. |
| `--stack-region <region>` | — | Region of the state record to read, and the CloudFormation client region under `--from-cfn-stack`. |
| `--env-vars <file>` | — | SAM-shaped JSON env-var overrides for the agent container. |
| `--container-host <host>` | `127.0.0.1` | Host IP the agent container's port binds to. Must be a numeric IP. |
| `-a`, `--app <command>` | `cdk.json` / `CDKD_APP` | CDK app command, or a path to a pre-synthesized cloud assembly. |
| `--output <path>` | `cdk.out` | Output directory for synthesis. |
| `-c`, `--context <key=value>` | — | Context value passed to synthesis. Repeatable. |
| `--region <region>` | `AWS_REGION` / stack / profile | AWS region for SDK calls. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `-y`, `--yes` | off | Answer interactive prompts with the recommended response. |
| `--verbose` | off | Verbose logging. |

## Target resolution

The target names one AgentCore Runtime, as a CDK display path
(`MyStack/MyAgent`) or a stack-qualified logical ID (`MyStack:MyAgent`).
Single-stack apps may omit the stack prefix. Omitting the target in a TTY opens
an interactive picker over the runtimes discovered in the synthesized app — the
same resolution [`cdkd local invoke-agentcore`](local-invoke-agentcore.md) uses.

## Protocols and endpoints

The runtime's declared protocol decides what the local server exposes and which
container port it talks to. All of it is served on the single `--port`.

| Protocol | Local endpoints | Container port |
| --- | --- | --- |
| HTTP / AGUI | `POST /invocations`, `GET /ping`, and the bidirectional `/ws` WebSocket endpoint | `8080` |
| MCP | `POST /mcp` | `8000` |
| A2A | `POST /` | `9000` |

The ready banner names what was bound. An HTTP / AGUI runtime prints both a
`Server listening on ws://...` line and an
`HTTP contract served on http://... — POST .../invocations, GET .../ping` line;
MCP and A2A print a `Server listening on http://...` line plus a
`<PROTOCOL> contract served on http://...` line. A request to an unserved path
gets a `404` that names the routes this runtime does serve.

```bash
curl -X POST http://127.0.0.1:8080/invocations -d '{"prompt":"hello"}'  # HTTP / AGUI
curl http://127.0.0.1:8080/ping                                          # readiness, never authenticated
```

Requests and responses are piped through to the warm container, including an SSE
stream, with the AgentCore session id injected on the way. `GET /ping` is served
unauthenticated on every protocol.

### The `/ws` bridge

HTTP and AGUI runtimes also get a `/ws` endpoint on the same host port. Each
client connection opens its own upgrade to the container, and the bridge injects
the AgentCore session-id header — and, under a `customJwtAuthorizer`, the
`Authorization` header — on that upgrade. That is what makes a header-less
client work: a browser's `WebSocket` cannot set custom upgrade headers, so it
could not otherwise hold an interactive multi-frame session against the runtime.

MCP and A2A runtimes have no `/ws` bridge.

## Inbound authentication

Which of the two gates applies is decided by the runtime, not by the flags: a
declared `customJwtAuthorizer` always wins.

| Runtime declares | Gate | Flag to reach for |
| --- | --- | --- |
| `customJwtAuthorizer` | Per-request JWT verification on the local server | `--bearer-token`, or `--no-verify-auth` to disable |
| No `customJwtAuthorizer` | Nothing by default; `--sigv4` signs each forwarded request | `--sigv4` |

### `customJwtAuthorizer` runtimes

The local server verifies each contract request's `Authorization` **per
request**, matching what the cloud runtime does on every `InvokeAgentRuntime`:

| Inbound request | Result |
| --- | --- |
| Carries an `Authorization` header that verifies | Forwarded to the container |
| Carries an `Authorization` header that fails signature / issuer / expiry / audience / scope checks | `403` |
| Carries no `Authorization`, and `--bearer-token` was given | The supplied token is used, then verified |
| Carries no `Authorization`, and no `--bearer-token` | `401` |
| Any of the above, under `--no-verify-auth` | Forwarded; a `--bearer-token` is still injected |

The container boots without a token being required up front, so `--bearer-token`
is a default rather than a prerequisite. An unreachable or malformed discovery
URL falls back to accepting the request, so offline work is not blocked.

### SigV4 runtimes

`--sigv4` signs each forwarded request with AWS SigV4 for the
`bedrock-agentcore` service, so the warm container sees the same `Authorization`
and `X-Amz-*` headers it would receive in the cloud. It is mutually exclusive
with `--bearer-token`, and it is ignored — with a warning — when the runtime
declares a `customJwtAuthorizer`.

## State sources

`--from-state` (after a `cdkd deploy`) and `--from-cfn-stack [name]` (for a
stack deployed with the CDK CLI) substitute `Ref`, `Fn::GetAtt`, `Fn::Sub`,
`Fn::ImportValue` and `Fn::GetStackOutput` intrinsics in the runtime's container
image and environment variables. The two are mutually exclusive. `--state-bucket`
and `--state-prefix` scope the cdkd state read; `--stack-region` picks the region
of the record, and doubles as the CloudFormation client region under
`--from-cfn-stack`.

## `--watch`: reload the warm container in place

`--watch` re-synthesizes on a CDK source change and rotates only the container —
the local server, its port and its bindings stay up. `cdk.json`'s
`watch.include` / `watch.exclude` are honored, and `cdk.out`, `node_modules` and
`.git` are always excluded.

Each firing is classified to pick the primitive:

| Change | Primitive |
| --- | --- |
| Source-only edits an existing container can absorb | Soft reload: the new source is copied in and the container is restarted. |
| Anything requiring a new image | Rebuild: a fresh container boots and the server is re-pointed at it. |

Either way the new container is re-probed for readiness under `--timeout` before
traffic resumes.

## Lifecycle

The container is started once and kept warm for the life of the command.
Contract requests are proxied to it, and each `/ws` client opens its own upgrade
with the session id — and any `Authorization` — injected.

`^C` (SIGINT) and SIGTERM tear the container down and exit, leaving no
`cdkd-local-agentcore-*` container behind.

## Limitations

- MCP and A2A runtimes serve request/response only; there is no `/ws` bridge for
  them.
- `--sigv4` and `--bearer-token` cannot be combined, and `--sigv4` has no effect
  on a runtime that declares a `customJwtAuthorizer`.
- `--platform` accepts only `linux/amd64` and `linux/arm64`. The default is
  `linux/arm64` because the cloud AgentCore Runtime requires it.
- Inbound JWT verification falls back to accepting the request when the OIDC
  discovery URL is unreachable or malformed.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Shut down on SIGTERM. |
| `1` | Hard error — no such runtime, synthesis failure, an image that would not build or pull, a container that never became ready within `--timeout`, or a `--bearer-token` rejected at boot. |
| `130` | Shut down on `^C` (SIGINT), or the interactive picker was cancelled. |

The full cross-command table is in the
[CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd local invoke-agentcore`](local-invoke-agentcore.md) — the one-shot twin
  of this command, for firing a single payload at a runtime
- [`cdkd local invoke`](local-invoke.md) — one-shot Lambda invoke via the RIE
  container
- [Local Execution](local-emulation.md) — every `cdkd local` subcommand, Docker
  requirements, and the flags they share
