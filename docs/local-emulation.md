---
title: Local Execution
description: "Run AWS workloads on your machine with cdkd local via Docker — invoke Lambda functions, serve API Gateway, and run ECS tasks with no AWS deploy."
---

# Local execution

`cdkd local *` runs AWS workloads on the developer's machine via Docker
— no AWS deploy, no `template.yaml` to maintain, no `cdk synth | sam ...`
round-trip. Reuses cdkd's synthesis / asset / construct-path plumbing
directly.

## Subcommands

| Subcommand | Emulates | Backed by |
| --- | --- | --- |
| [`cdkd local invoke <target>`](local-invoke.md) | One-shot Lambda invoke | AWS Lambda Runtime Interface Emulator (RIE) container |
| [`cdkd local start-api`](local-start-api.md) | Long-running API Gateway (REST v1 / HTTP API / Function URL) | RIE container pool + `node:http` listener (one server per discovered API) |
| [`cdkd local run-task <target>`](local-run-task.md) | ECS `RunTask` for one task | docker network + ECS metadata sidecar (`amazon/amazon-ecs-local-container-endpoints`) |
| [`cdkd local start-service <target>`](local-start-service.md) | Long-running ECS `Service` emulator | `run-task` machinery per replica + per-replica docker subnet allocator + restart-on-exit watcher |
| [`cdkd local invoke-agentcore <target>`](local-invoke-agentcore.md) | One-shot Bedrock AgentCore Runtime invoke | AgentCore container on port 8080 (HTTP `/invocations` / MCP `/mcp` / A2A `/a2a` / WebSocket `/ws`) |
| [`cdkd local start-agentcore [target]`](local-start-agentcore.md) | Long-running serve of a Bedrock AgentCore Runtime against a warm container (all four protocols) | AgentCore container on port 8080 (shimmed from cdk-local), booted once + kept warm. HTTP / AGUI: host `node:http` server proxies `POST /invocations` + `GET /ping` and fronts the bidirectional `/ws` endpoint (injects the session-id / Authorization a header-less browser client cannot set), both on one port. MCP serves `POST /mcp`; A2A serves `POST /` (no `/ws`) |
| [`cdkd local start-alb <targets...>`](local-start-alb.md) | Long-running local ALB front-door for ECS / Lambda backing services | shared ECS service emulator engine (shimmed from cdk-local) + per-listener `node:http(s)` front-door with path / host / header / weighted / redirect / fixed-response routing |
| [`cdkd local start-cloudfront [target]`](local-start-cloudfront.md) | Long-running local CloudFront distribution (viewer-request -> S3 / Lambda Function URL origin -> viewer-response) | in-process `node:http(s)` server (shimmed from cdk-local) — CloudFront Functions in a `node:vm` sandbox + S3 origin served from the `BucketDeployment` source asset; Lambda Function URL origins run locally via the RIE container (Docker) |

## Requirements

Most `cdkd local *` commands require Docker on the developer's machine.
The first run pulls the relevant base image (~600MB for the
language-specific Lambda images, ~50MB for `provided.*`, plus the ECS
metadata sidecar for `run-task`). Subsequent runs reuse the cached
image; pass `--no-pull` to skip the `docker pull` round-trip
altogether (per-command `--no-pull` semantics may differ — see each
section below). The exception is `local start-cloudfront` for a
CloudFront-Functions + S3-origin-only distribution, which serves
entirely in-process (CloudFront Functions in a `node:vm` sandbox, S3
origin from local files) and needs no Docker — but a distribution with
a Lambda Function URL origin runs that origin's backing Lambda locally
via the RIE container, so Docker is required in that case.

## Common flags

`-a, --app`, `--no-pull`, `--from-state` and `--stack-region` are accepted by
every `cdkd local` subcommand. `--env-vars` and `--container-host` are
accepted by all of them **except `start-cloudfront`**.

- `-a, --app <cmd-or-dir>` — CDK app command or pre-synthesized
  `cdk.out` directory. Defaults to synth-every-time; pass `-a cdk.out`
  to iterate faster.
- `--env-vars <file>` — SAM-compatible JSON override:
  `{"LogicalId":{"KEY":"VALUE"}, "Parameters":{...}}`. `null` clears a
  key. For Lambda (`local invoke` / `local start-api`) the function-specific
  key may also be a **CDK display path** (`MyStack/MyHandler` — the same
  form `cdkd local invoke <target>` accepts), matched against the
  resource's `Metadata['aws:cdk:path']`. Logical-ID and display-path
  entries coexist; if both list the same key, the later JSON entry wins
  (matches SAM's apply-in-order semantics).
- `--no-pull` — Skip `docker pull` (per-command semantics differ;
  consult each section).
- `--from-state` — Resolve intrinsic-valued properties against cdkd's
  deployed S3 state. Off by default; the target stack must have been
  deployed via `cdkd deploy` first.
- `--stack-region <region>` — Disambiguate when the same stack name
  has cdkd state in multiple regions (only with `--from-state`).
  Region CASE is not significant: the value is matched against the state
  record's own spelling case-insensitively, so `--stack-region US-EAST-1`
  reads the `us-east-1` record instead of silently falling back to no
  state. A record spelled exactly the way you TYPED the
  flag always wins, so with both `us-east-1` and `US-EAST-1` records
  present each flag spelling reads its own; that collision is reported at
  warn, naming the record read and which of the two rules chose it.
- `--container-host <ip>` — Bind IP for published ports (default
  `127.0.0.1`). Must be a numeric IP; Docker rejects hostnames in
  `-p <ip>:<port>:<port>`.

