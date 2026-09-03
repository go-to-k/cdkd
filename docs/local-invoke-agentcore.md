---
title: local invoke-agentcore
description: "Invoke a Bedrock AgentCore Runtime once in a local container over HTTP, MCP, A2A, or WebSocket."
---

# `local invoke-agentcore` (run Bedrock AgentCore Runtime locally)

`cdkd local invoke-agentcore <target>` runs one Bedrock AgentCore Runtime container locally and invokes it once over the AgentCore protocol declared by the target. Supports the container artifact (`fromContainerAsset` / `fromEcr`) and the `CodeConfiguration` managed-runtime artifact (`fromCodeAsset`, built from source) on the HTTP, MCP, A2A, and AGUI protocols, plus a bidirectional `--ws` mode for streaming. Models cdk-local's `cdkl invoke-agentcore`, ported into cdkd's command tree as a shim over `cdk-local/internal`.

> **`CodeConfiguration` builds run the bundle as-is (no dependency install).** The `fromCodeAsset` / `fromS3` source build matches the AWS managed runtime: it does **not** `pip install` (`requirements.txt` / `pyproject.toml`) or `npm install` your dependencies — the deployed runtime resolves deps vendored into the bundle at deploy time (e.g. arm64 wheels via `uv pip install --target`). So a bundle that declares a dependency manifest **without vendored deps** now fails locally with `ModuleNotFoundError` the same way it fails deployed (instead of passing locally only because of a local install), and cdkd emits a warning with the vendoring recipe. Vendor your deps into the bundle — which a successful deploy already requires. Container artifacts (`fromContainerAsset` / `fromEcr`) are unaffected. Inherited from cdk-local; applies to `start-agentcore` too (same `buildAgentCoreCodeImage` build).

### Target resolution

Same shape as `cdkd local invoke`: accepts a CDK display path (`MyStack/MyAgent`) or stack-qualified logical ID (`MyStack:MyAgentRuntime1234`). Single-stack apps may omit the stack prefix. When the target is omitted in an interactive terminal, an interactive picker prompts from the discovered list (no TTY -> command's required-arg error).

### Supported protocols

| `Protocol` (CFn) | What runs | Container ports | cdkd dispatch |
| --- | --- | --- | --- |
| `HTTP` (default) | `POST /invocations` (single response or SSE stream) + `GET /ping` | 8080 | `POST /invocations` with `--event` body. SSE stream prints incrementally; non-stream prints `tail -1`. |
| `MCP` | Model Context Protocol streamable HTTP | 8000 | Session handshake (`initialize` -> `notifications/initialized`) + one JSON-RPC request: defaults to `tools/list` when `--event` is omitted; otherwise `--event` is the JSON-RPC request body. |
| `A2A` | Agent-to-Agent JSON-RPC at `POST /` | 9000 | Defaults to `agent/getAgentCard` when `--event` is omitted; otherwise `--event` is the JSON-RPC request body. |
| `AGUI` | AGUI JSON-RPC streaming | 8800 | Streams the agent's response frames. |
| `--ws` (HTTP only) | Bidirectional `/ws` WebSocket on the HTTP container | 8080 | First frame = `--event` body. Auto-enters a REPL when **stdin** is a TTY — each typed stdin line is a follow-up frame until Ctrl-D / close; piped / non-TTY stdin stays one-shot (only the `--event` frame is sent). The `> ` prompt additionally requires **stdout** to be a TTY, so a redirected stdout keeps the raw frame stream. |

### Inbound JWT auth (`customJwtAuthorizer`)

When the runtime declares an inbound `customJwtAuthorizer`, `--jwt <token>` verifies the supplied Bearer JWT against the runtime's OIDC discovery URL before the container starts, then forwards it on `/invocations` as `Authorization: Bearer <jwt>`. Verification covers `iss` / `aud` / `exp` / signature + allowedScopes + customClaims. Without `--jwt`, the local invoke proceeds without authorization (mirrors `cdkl`).

### State-source flags

Same shape as `cdkd local invoke`. Use `--from-state` to substitute Ref / Fn::GetAtt / Fn::Sub / Fn::ImportValue in env vars from cdkd's S3 state for the target stack (after a prior `cdkd deploy`). Use `--from-cfn-stack [name]` to read a deployed CFn stack via `DescribeStackResources` (for CDK apps deployed via the upstream CDK CLI). Mutually exclusive.

### Credentials + role-assumption

Same shape as `cdkd local invoke`. The container receives the developer's AWS credentials by default (so the agent's outbound AWS calls reach real AWS as the developer); `--assume-role <arn>` (or bare `--assume-role` to auto-resolve from state) assumes the runtime's deployed `RoleArn` first so the agent runs with the narrow function role. `--ecr-role-arn <arn>` is the cross-account ECR image-pull escape hatch.

### Options

- `--event <file>` / `--event-stdin` — request body / stdin source.
- `--env-vars <file>` — SAM-shape env-var overrides.
- `--platform <linux/amd64|linux/arm64>` — defaults to `linux/arm64` (AgentCore's required arch).
- `--container-host <host>` — host to bind the container ports to (default `127.0.0.1`).
- `--session-id <id>` — value of the AgentCore session-id header (auto-generated when omitted).
- `--jwt <bearer-token>` — verified + forwarded when the runtime declares `customJwtAuthorizer`.
- `--timeout <ms>` — per-request timeout (default 120000 / 120s).
- `--ws` — bidirectional `/ws` WebSocket mode (HTTP protocol only). Auto-detects a TTY, and the two halves read DIFFERENT streams. Whether the REPL runs depends on **stdin**: an interactive terminal enters a multi-turn REPL (each stdin line is sent as a follow-up frame until Ctrl-D / agent close), while piped / redirected / CI stdin stays a wire-faithful one-shot (force one-shot in a TTY with `--ws </dev/null`). Whether the `> ` prompt is written depends on **stdout**, because that is the payload stream: with stdout redirected the frames stay raw and unprompted even from a terminal, so `--ws > frames.txt` and `--ws | tail -1` mean what they look like.
- `--watch` — re-synth + reload the agent container on CDK source edits. See [Hot reload (`--watch`)](#hot-reload---watch) below. Off by default. Supported on the HTTP / AGUI protocols; a no-op WARN for MCP / A2A (their single shot runs once and exits).
- `--sigv4` — sign `/invocations` with SigV4 (for SigV4-protected runtimes).
- `--from-state` / `--from-cfn-stack [name]` / `--state-bucket` / `--state-prefix` / `--stack-region` — state-source flags.
- `--assume-role [arn]` / `--no-assume-role` / `--ecr-role-arn <arn>` — role-assumption flags.
- `--no-pull` / `--no-build` — pull / build skip.

### Hot reload (`--watch`)

When `--watch` is set, cdkd watches the CDK app **source tree** (the synth working directory, where `cdk.json` lives), honoring `cdk.json`'s `watch.include` / `watch.exclude` and excluding `cdk.out` / `node_modules` / `.git`. On a source edit it re-synths and reloads the agent container, mirroring `cdk watch`.

A per-firing classifier picks the reload primitive:

- **Soft-reload FAST PATH** — an interpreted-language source edit inside a `CodeConfiguration` (`fromCodeAsset`) source tree (no Dockerfile / dependency-manifest / compiled-source change, asset hash unchanged in a way that matters) takes a `docker cp` of the freshly-synthed source into the running container's WORKDIR + `docker restart`. No `docker build`, no container swap — the container ID + host port are preserved.
- **Full rebuild** — a Dockerfile / compiled-source / asset-hash-changed / ambiguous edit (or a `fromS3` / non-CDK-asset runtime, or any classifier-context failure) tears down the container (SIGTERM + `docker rm -f`), re-resolves the image (re-running the same image-build pipeline the cold boot runs), and starts a fresh container.

`--watch` applies to BOTH the `--ws` session path AND the default one-shot `POST /invocations` (the reload re-runs the single shot). On `--ws`, the active socket is closed cleanly on each reload firing so the next session reconnects to the rebuilt / soft-reloaded container. For **MCP / A2A** runtimes `--watch` is a no-op WARN and the single shot proceeds (those protocols run once and exit with no reconnect surface). Reloads are chain-serialized (no two reloads run in parallel); a reload-callback failure exits the watch loop cleanly (the previous container may already be torn down, so it does not block on a stale port). `^C` (SIGINT) tears down the container and exits.

### Implementation notes

cdkd consumes cdk-local's AgentCore implementation verbatim via shim files (`src/local/agentcore-*.ts`). The actual runtime resolver, code-image builder, S3 bundle downloader, protocol clients (HTTP / MCP / A2A / WebSocket), and SigV4 signer all live in cdk-local (`@cdk-local/internal`); cdkd's command file ports the CLI surface + state-source integration only, mirroring the established pattern from `cdkd local invoke` / `start-api` / `run-task` / `start-service`.

