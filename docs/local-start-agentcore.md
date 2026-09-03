---
title: local start-agentcore
description: "Keep a Bedrock AgentCore Runtime container warm and serve all four protocols locally, with hot reload and a browser-friendly WebSocket front-door."
---

# `local start-agentcore` (serve a Bedrock AgentCore Runtime locally)

`cdkd local start-agentcore [target]` is the long-running **serve**
counterpart of the single-shot `local invoke-agentcore`. It boots the
AgentCore Runtime container **once** (same image / env / credential
resolution as `invoke-agentcore`) and keeps it **warm**, serving the
runtime's native protocol contract so a client can hit it repeatedly:

- **HTTP / AGUI** runtimes serve `POST /invocations` + `GET /ping`
  (proxied to the warm container, with the session-id / boot-resolved
  `Authorization` injected and the request/response — including an SSE
  stream — piped through) **and** the bidirectional `/ws` WebSocket
  endpoint behind a host bridge that injects the AgentCore session-id
  (and, under a `customJwtAuthorizer`, the `Authorization` header) on the
  container upgrade — so a **header-less client** (e.g. a browser
  `WebSocket`, which cannot set custom upgrade headers) can hold an
  interactive multi-frame session. Both share the **same host port**; the
  ready banner prints both an `HTTP contract served on http://...` line
  and the `Server listening on ws://...` line.
- **MCP** runtimes serve `POST /mcp`; **A2A** runtimes serve `POST /`
  (these have no `/ws` bridge, and print a `Server listening on http://...`
  ready line plus a `<PROTOCOL> contract served on http://...` line).

Runs until `^C`. Models cdk-local's `cdkl start-agentcore`,
inherited into cdkd's command tree as a thin
pass-through to cdk-local's command factory. Requires Docker.

### `local start-agentcore` target resolution

Same shape as `local invoke-agentcore`: a CDK display path
(`MyStack/MyAgent`) or stack-qualified logical ID. Single-stack apps may
omit the stack prefix. Omit the target in a TTY for an interactive picker
over the discovered AgentCore Runtimes.

### `local start-agentcore` state-source flags

`start-agentcore` is one of the factory pass-throughs that bind deployed
state via the `extraStateProviders` seam: cdk-local's
start-agentcore factory accepts it, so cdkd threads its S3-backed
`--from-state` factory in and layers the cdkd-specific `--from-state` /
`--state-bucket` / `--state-prefix` flags on top of cdk-local's inherited
`--from-cfn-stack` / `--stack-region`. Use `--from-state` (after a prior
`cdkd deploy`) or `--from-cfn-stack [name]` (for a stack deployed via the
upstream CDK CLI) to substitute `Ref` / `Fn::GetAtt` / `Fn::Sub` /
`Fn::ImportValue` / `Fn::GetStackOutput` intrinsics in the runtime
container image + environment variables. Mutually exclusive. (`start-alb`,
`start-service`, and — as of cdk-local 0.128.0 — `start-cloudfront` thread
`--from-state` the same way.)

### `local start-agentcore` options

- `--port <n>` — serve bind port the client connects to (default
  `0` = OS-assigned). The HTTP contract and the `/ws` bridge share this
  one port; the ready banner prints the chosen
  `http://<host>:<port>` + `ws://<host>:<port>/ws`.
- `--host <ip>` — serve bind host (default `127.0.0.1`).
- `--session-id <id>` — pin one AgentCore session-id for every forwarded
  request / `/ws` connection (default: a fresh UUID each, so each is its
  own session).
- `--bearer-token <jwt>` — Bearer JWT presented under a
  `customJwtAuthorizer` (verified against the runtime's OIDC discovery URL
  before the container starts, then forwarded on every request and the
  container `/ws` upgrade). Now the **default-when-missing** fallback — the
  inbound JWT gate is per request, not boot-time (see below).
- `--no-verify-auth` — skip the inbound JWT verification (a `--bearer-token`,
  if given, is still forwarded).
- `--sigv4` — sign each forwarded request with AWS SigV4 (service
  `bedrock-agentcore`) when the runtime declares **no** `customJwtAuthorizer`,
  so the warm container sees the same `Authorization` / `X-Amz-*` headers
  the cloud receives. Mutually exclusive with `--bearer-token`; ignored
  (with a warning) when a `customJwtAuthorizer` is declared.
- `--watch` — re-synth + reload the warm container in place on a CDK
  source change, keeping the host serve up (only the container rotates; a
  per-firing classifier picks rebuild vs soft-reload, the same machinery
  as `invoke-agentcore --ws --watch`). Off by default.
- `--env-vars <file>` — SAM-shape env-var overrides.
- `--platform <linux/amd64|linux/arm64>` — defaults to `linux/arm64`
  (AgentCore's required arch).
- `--container-host <host>` — host to bind the container ports to.
- `--timeout <ms>` — per-request timeout.
- `--from-state` / `--from-cfn-stack [name]` / `--state-bucket` /
  `--state-prefix` / `--stack-region` — state-source flags (above).
- `--assume-role [arn]` / `--ecr-role-arn <arn>` — role-assumption +
  cross-account ECR image-pull flags.
- `--no-pull` / `--no-build` — pull / build skip.

### `local start-agentcore` inbound auth (`customJwtAuthorizer`)

When the runtime declares an inbound `customJwtAuthorizer`, the warm serve
verifies each contract request's `Authorization` **per request** (matching
the cloud): `401` when the header is missing, `403` when the token is
invalid, forwarded on a pass. `GET /ping` is unauthenticated. The
container boots without requiring a token up front; `--bearer-token` is the
default token used when a request arrives without its own `Authorization`.
For a SigV4-protected runtime (no `customJwtAuthorizer`) use `--sigv4`
instead to sign each forwarded request.

### `local start-agentcore` lifecycle

The container is started once and kept warm; HTTP / AGUI contract requests
are proxied to it and each `/ws` client opens its own container upgrade
with the session-id (and optional `Authorization`) injected. `^C`
(SIGTERM / SIGINT) tears the container down and exits — no
`cdkd-local-agentcore-*` container is left behind. The studio
`agentcore-ws` serve kind (cdk-local) spawns this command, but cdkd does
not embed cdk-local's `studio` command, so that surface is not exposed by
the cdkd CLI.
