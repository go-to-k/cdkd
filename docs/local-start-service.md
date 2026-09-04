---
title: local start-service
description: "Run a long-running local ECS Service emulator — per-replica containers with restart-on-exit watching and zero-downtime hot reload."
---

# `local start-service` (run an ECS Service locally)

`cdkd local start-service <Stack/ServiceLogicalPath>` is the long-running
counterpart of `cdkd local run-task`. It locates an
`AWS::ECS::Service` in the synthesized template, chains into the
existing `run-task` machinery once per `DesiredCount` replica (clamped
by `--max-tasks`, default 3), and keeps every replica running until
`^C`. Failed replicas restart per `--restart-policy on-failure |
always | none` with exponential backoff (1s → 30s capped) so a
crash-looping container does not hammer docker.

Each replica gets its own per-task docker network on a UNIQUE
`169.254.<N>.0/24` subnet (170, 171, 172, ...; see
[src/local/ecs-network.ts](https://github.com/go-to-k/cdkd/blob/main/src/local/ecs-network.ts)
`buildEndpointSubnet`) so concurrent replicas don't collide on a
single /24 — the same metadata-endpoint sidecar starts at
`169.254.<N>.2` per replica and every container's
`ECS_CONTAINER_METADATA_URI_V4` is rewritten to point at its own
replica's sidecar.

> **Host-port publishing and multi-replica services.** A
> **single-replica** service publishes its container `PortMappings` to
> the host (`-p <container-host>:<hostPort>:<containerPort>`) so you can
> `curl localhost:<port>` from the host. A **multi-replica** service
> (effective replica count > 1 after the `--max-tasks` clamp) does NOT
> publish host ports: N replicas all map the same container port, so a
> fixed host-port publish would make the 2nd+ replica fail to boot with
> `Bind for 127.0.0.1:<port> failed: port is already allocated`. This
> matches production — real ECS Service Connect / `awsvpc` tasks have
> per-task ENIs and never share a host port. Peers still reach a
> multi-replica service by container IP / network alias on the shared
> docker network; to hit a specific replica from the host, `docker exec`
> into it or read its IP from `docker inspect`.

### `local start-service` target resolution

Same grammar as `local run-task`:

- `Stack/Service/...` (display path) or `Stack:LogicalId` (logical id).
- Single-stack apps may omit the stack prefix.
- The target MUST resolve to an `AWS::ECS::Service`; passing a bare
  TaskDefinition surfaces a clear "use cdkd local run-task" hint.

The Service's `TaskDefinition` property MUST be `{Ref:
'<TaskDefLogicalId>'}` referencing a same-stack
`AWS::ECS::TaskDefinition` (the standard CDK shape). Cross-stack
TaskDefinitions and `Fn::ImportValue` shapes are rejected with a clear
error.

### `local start-service` options

| Flag | Default | Behavior |
| --- | --- | --- |
| `--cluster <name>` | `cdkd-local` | Cluster name surfaced to `ECS_CONTAINER_METADATA_URI_V4` and used as the docker network prefix. Each replica's network appends `-svc-<service>-r<index>` so per-replica networks are easy to identify in `docker ps`. |
| `--max-tasks <n>` | `3` | Hard cap on local replica count regardless of template `DesiredCount`. Local dev machines should not run an unbounded number of containers; raise this for production-shape workloads only when warranted. |
| `--restart-policy <p>` | `on-failure` | Restart-on-exit behavior. `on-failure` restarts only on non-zero exit; `always` restarts on every exit (mirrors ECS Service deployment semantics more closely); `none` shuts the affected replica down and runs the service degraded. |
| `--env-vars <file>` | — | SAM-shape JSON env-var overrides; same format as `run-task`. |
| `--container-host <ip>` | `127.0.0.1` | Host IP to bind published container ports to. Must be a numeric IP. |
| `--assume-task-role [arn]` | unset | Assume the task definition's TaskRoleArn (or the supplied ARN) and forward STS-issued temp credentials via the metadata sidecar so every replica's containers run with the deployed task role. Same three-form grammar as `run-task`. |
| `--ecr-role-arn <arn>` | — | Role ARN to assume before ECR `docker pull` for cross-account / centralized registries. Same shape as `run-task`. |
| `--platform <p>` | inferred | Force `--platform linux/amd64` or `linux/arm64`. |
| `--no-pull` | off | Skip `docker pull` on every container image and the metadata sidecar. |
| `--from-state` | off | Read cdkd S3 state and substitute intrinsic-valued env / secret / role-ARN / volume entries against the deployed cdkd state. Same shape as `cdkd local run-task --from-state`. |
| `--from-cfn-stack [cfn-stack-name]` | off | Read a deployed CloudFormation stack via `DescribeStackResources` and substitute `Ref` / `Fn::ImportValue` in container env vars / secrets / image URIs with the deployed physical IDs / exports. Use for CDK apps deployed via the upstream CDK CLI (`cdk deploy`). Bare form uses the cdkd stack name (per target when multiple `<targets...>` are supplied). **Mutually exclusive with `--from-state`**. `Fn::GetAtt` is warn-and-dropped in v1, except a same-stack ECR repository's `Arn` / `RepositoryUri` in a container image URI (synthesized from the recovered physical name + pseudo parameters). Same shape as `cdkd local run-task --from-cfn-stack`. |
| `--stack-region <region>` | — | Region of the state record to read. Used with `--from-state` when the same stack name has state in multiple regions, and with `--from-cfn-stack` as the CFn client region. |
| `--host-port <containerPort=hostPort>` | host port == container port | Publish a container port on a specific host port (e.g. `80=8080`); repeatable. Use this on macOS to map a privileged container port (< 1024) to a non-privileged host port and avoid the Docker Desktop admin-password prompt. **Single-replica services only** — multi-replica services do not publish host ports. |
| `--watch` | off | Hot reload: re-synth + per-replica reload when the CDK source changes (`cdk.json watch.include` / `watch.exclude` honored; `cdk.out` / `node_modules` / `.git` always excluded). A per-firing classifier picks the per-replica primitive: source-only edits on interpreted-language handlers (Node / Python / Ruby / shell) take a bind-mount **FAST PATH** (`docker cp` the new source into each replica + `docker restart`; no `docker build`, sub-second). Dockerfile / dependency manifest / compiled-language source / ambiguous edits fall through to the rebuild rolling primitive — boot a shadow under a bumped generation suffix, wait for its container port to accept a TCP connection, atomically swap Service Connect / Cloud Map registrations, then retire the old container. Either path rolls one replica at a time, so peer services see zero connection refusals across the reload even on multi-replica services. Off by default; existing replica(s) keep serving when synth fails mid-reload. (cdk-local 0.69.0.) Source-only TypeScript edits classify as a **rebuild** (not soft-reload) so precompiled handler setups are not left stale (cdk-local 0.77). |
| `--image-override <target=ref>` | — | Pin or locally build a replica's container image instead of using the deployed registry tag. `<target>` is a service / container selector; `<ref>` is an image reference, a build directory, or a `Dockerfile` path (`~` is tilde-expanded). Repeatable. Compose with the per-service `--image-build-arg` / `--image-build-secret` / `--image-target` variants for local builds. On `--watch`, a covered override re-builds when its source changes. (cdk-local 0.77.) |
| `--shadow-ready-timeout <ms>` | `60000` | Per-invocation override of the shadow-replica TCP-ready probe budget used by the rebuild rolling primitive (and the initial boot). Raise it for slow-starting containers. Also settable via `CDKD_SHADOW_READY_TIMEOUT_MS`. (cdk-local 0.77.) |

Each replica's container stdout / stderr is streamed live to the host
terminal while the service runs (cdk-local 0.77).

### `local start-service` lifecycle

`^C` (SIGINT) and SIGTERM trigger a graceful shutdown across every
replica in parallel — each replica's docker containers + per-replica
network + metadata sidecar are torn down via the same
`cleanupEcsRun` path `run-task` uses. Double-`^C` bypasses cleanup and
exits 130 immediately so users have an escape hatch when docker
hangs.

### `local start-service` scope (deferred follow-ups)

| Deferred | Tracked in / Why |
| --- | --- |
| Local load-balancer emulator (listener + round-robin + target-group health check) | Follow-up — needs an HTTP/TCP proxy emulator. Today's start-service does NOT register replicas to a local listener; reach a single-replica service via its published container ports, or any replica via its docker network IP / alias (multi-replica services skip the host-port publish — see the host-port note above). |
| Envoy sidecar (L7 routing / retries / circuit breaking / mTLS) | Deferred follow-up — the Cloud Map DNS overlay covers ~80% of debugging use cases; the missing 20% requires the AWS-published Envoy image (~120MB / task). DNS-only mode is the default; an opt-in `--envoy` flag will ship with the sidecar. |
| Rolling deployment strategy (`DeploymentConfiguration.MaximumPercent` etc.) | Follow-up — meaningful only with the LB emulator. |
| `HealthCheckGracePeriodSeconds` runtime semantics | Field is parsed and surfaced on `ResolvedEcsService` but not yet acted on. Becomes load-bearing when the LB emulator ships (today's restart policy fires on essential-container exit code, not health-check failure). |

### `awsvpc` network mode

ECS Services on Fargate require `awsvpc`. cdkd maps `awsvpc` to a
per-task docker bridge network with a startup warn; security groups
are NOT enforced locally and per-task ENIs are not emulated. Full
rationale in the [awsvpc emulation design note](design/461-awsvpc-decision.md).

