---
title: local start-alb
description: "Front local ECS and Lambda backing services with a local Application Load Balancer — path, host, header, weighted, redirect, and fixed-response routing."
---

# `local start-alb` (run an Application Load Balancer locally)

`cdkd local start-alb <Stack/Alb...>` is the long-running
local Application Load Balancer front-door. It names one or more
`AWS::ElasticLoadBalancingV2::LoadBalancer` resources from the
synthesized template, discovers the ECS / Lambda targets behind each
listener's `forward` action, boots every backing ECS service via the
same engine `local start-service` uses (replicas, restart-on-exit,
Service Connect / Cloud Map), and stands up a per-listener local
`node:http(s)` server that round-robins inbound requests across the
running replicas and applies the listener rules (path / host / header /
method / query-string / source-IP) against the backing targets. The
symmetric counterpart of `local start-api` for ALB-fronted workloads.

The command is a thin wrapper around the shared ECS service emulator
engine (`runEcsServiceEmulator`, shimmed from `cdk-local/internal`);
the per-listener front-door owns the routing + auth-guard logic, the
underlying engine owns the container boot + Cloud Map plumbing.

### `local start-alb` target resolution

- `Stack/Alb/...` (display path) or `Stack:LogicalId` (logical id).
- Single-stack apps may omit the stack prefix.
- The target MUST resolve to an
  `AWS::ElasticLoadBalancingV2::LoadBalancer`; passing a Listener or
  TargetGroup surfaces a clear error naming the available ALBs in the
  stack.
- Variadic: multiple ALB targets in one invocation share a single
  shared docker network + a single Cloud Map registry so ECS services
  registered to different ALBs still discover each other.

### `local start-alb` options

| Flag | Default | Behavior |
| --- | --- | --- |
| `--lb-port <listenerPort=hostPort>` | host port == listener port | Remap the local front-door host port for a specific listener port. Repeatable (`--lb-port 80=8080 --lb-port 443=8443`). Use this on macOS to remap a privileged listener port (< 1024) to a non-privileged host port. |
| `--tls` | off | Terminate TLS locally for cloud-HTTPS listeners. Default: a cloud-HTTPS listener is served over plain HTTP locally (`X-Forwarded-Proto: https` is preserved so the upstream app still sees the deployed listener protocol). Implied by `--tls-cert` / `--tls-key`. Use this when local-dev cookies need `Secure` / `SameSite=None`, when the upstream app inspects TLS metadata, or for mTLS / SNI testing — otherwise plain HTTP is friendlier (no self-signed cert warnings in curl / browser). |
| `--tls-cert <path>` | — | PEM-encoded server certificate for HTTPS front-door listeners. Implies `--tls`. Must be set together with `--tls-key`. Pass `--tls` alone (without `--tls-cert` / `--tls-key`) to auto-generate a self-signed cert cached under `$XDG_CACHE_HOME/cdk-local/alb-https/`. The deployed Listener Certificates are NOT fetched (ACM private keys are not retrievable). |
| `--tls-key <path>` | — | PEM-encoded server private key matching `--tls-cert`. Implies `--tls`. Must be set together. |
| `--no-verify-auth` | off | Disable local enforcement of `authenticate-cognito` / `authenticate-oidc` actions. Every request is served as if the auth check passed. |
| `--bearer-token <jwt>` | — | Default Bearer JWT injected as `Authorization: Bearer <jwt>` when the inbound request has none. Verified against the same JWKS / OIDC discovery URL the deployed ALB would (signature + iss + aud + exp). Cookie pass-through (`AWSELBAuthSessionCookie-*`) also works. |
| `--cluster <name>` | `cdkd-local` | Cluster name surfaced to `ECS_CONTAINER_METADATA_URI_V4` and used as the docker network prefix. Same shape as `local start-service`. |
| `--max-tasks <n>` | `3` | Per-service hard cap on local replica count regardless of template `DesiredCount`. Same shape as `local start-service`. |
| `--restart-policy <p>` | `on-failure` | Restart-on-exit behavior for backing ECS containers. Same three-state grammar as `local start-service`. |
| `--env-vars <file>` | — | SAM-shape JSON env-var overrides for backing containers; same format as `local run-task` / `local start-service`. |
| `--container-host <ip>` | `127.0.0.1` | Host IP to bind published container + front-door ports to. Must be a numeric IP. |
| `--assume-task-role [arn]` | unset | Assume each backing service's TaskRoleArn (or the supplied ARN). Same three-form grammar as `local start-service`. |
| `--ecr-role-arn <arn>` | — | Role ARN to assume before ECR `docker pull`. Same shape as `local start-service`. |
| `--platform <p>` | inferred | Force `--platform linux/amd64` or `linux/arm64`. |
| `--no-pull` | off | Skip `docker pull` on every container image and the metadata sidecar. |
| `--from-state` | off | Read cdkd's S3 state for the target stack and substitute `Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::ImportValue` / `Fn::GetStackOutput` intrinsics in the resolved backing services' container images, environment variables, secrets, role ARNs, and volumes. Mutually exclusive with `--from-cfn-stack`. Same shape as `local start-service --from-state`. |
| `--state-bucket <bucket>` | auto | S3 bucket containing cdkd state. Falls back to `CDKD_STATE_BUCKET` env or `cdk.json context.cdkd.stateBucket`, then the default `cdkd-state-{accountId}`. Only used with `--from-state`. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. Only used with `--from-state`. |
| `--from-cfn-stack [cfn-stack-name]` | off | Read a deployed CloudFormation stack via `DescribeStackResources` and substitute `Ref` / `Fn::ImportValue` intrinsics. For CDK apps deployed via the upstream CDK CLI (`cdk deploy`). Mutually exclusive with `--from-state`. Same shape as `local start-service --from-cfn-stack`. |
| `--stack-region <region>` | — | Region of the state record to read. Used with `--from-state` when the same stack name has state in multiple regions, and with `--from-cfn-stack` as the CFn client region. |
| `--watch` | off | Hot reload: re-synth + per-replica reload of every ECS service behind the ALB when the CDK source changes (`cdk.json watch.include` / `watch.exclude` honored; `cdk.out` / `node_modules` / `.git` always excluded). A per-firing classifier picks the per-replica primitive: source-only edits on interpreted-language handlers (Node / Python / Ruby / shell) take a bind-mount **FAST PATH** (`docker cp` + `docker restart`; no `docker build`, sub-second; the front-door pool entry is unchanged since the IP/port are preserved). Dockerfile / dependency manifest / compiled-language source / ambiguous edits fall through to the rebuild rolling primitive — boot a shadow, wait for TCP-ready, atomically register it in the front-door pool, drop the old entry. Either path rolls one replica at a time, so a continuous external request stream against the listener port sees zero connection refusals across the reload. The host front-door (TLS, JWKS cache, Lambda-target containers, listener sockets) stays up across the reload. Lambda target groups behind the ALB are a no-op on reload (the warm RIE container keeps its boot-time image). Off by default; existing replica(s) keep serving when synth fails mid-reload. (cdk-local 0.69.0.) |
| `--image-override <target=ref>` | — | Pin or locally build a backing service's container image instead of using the deployed registry tag. Same grammar + per-service `--image-build-arg` / `--image-build-secret` / `--image-target` variants as `local start-service`. (cdk-local 0.77.) |
| `--shadow-ready-timeout <ms>` | `60000` | Per-invocation override of the shadow-replica TCP-ready probe budget. Same shape as `local start-service`. (cdk-local 0.77.) |

When no listener rule matches an inbound request, the local front-door's
404 now explains which listener fields (path / host / header / method)
were evaluated, instead of a bare 404 (cdk-local 0.77).

### `local start-alb` listener / action support

The local front-door reads the synthesized template and emulates these
listener / action shapes:

- **Listener protocols:** HTTP and HTTPS. A cloud-HTTPS listener is
  served over plain HTTP locally by default — `X-Forwarded-Proto: https`
  is preserved so the upstream app still sees the deployed listener
  protocol. Pass `--tls` to terminate TLS locally (a self-signed cert is
  auto-generated and cached under `$XDG_CACHE_HOME/cdk-local/alb-https/`),
  or `--tls-cert` / `--tls-key` to supply your own cert (each flag
  implies `--tls`). Non-HTTP/HTTPS listeners (TCP / UDP / TLS / NLB) are
  skipped with a warn.
- **Rule conditions:** all six ALB fields — `path-pattern`,
  `host-header`, `http-header`, `http-request-method`,
  `query-string`, `source-ip`.
- **Default + rule actions:** `forward` (single target group, weighted
  forward across multiple target groups), `redirect`, `fixed-response`.
  `authenticate-cognito` + `authenticate-oidc` enforce a local Bearer-JWT
  check (or `AWSELBAuthSessionCookie` pass-through) against the same
  JWKS / OIDC discovery URL the deployed ALB would.
- **Target groups:** ECS (`AWS::ECS::Service.LoadBalancers[]` binding
  the TG to the container + port) and Lambda (TG `Targets[].Id` =
  `{Fn::GetAtt: [<FnLogicalId>, "Arn"]}`).

Unsupported listener / action / target shapes are skipped with a per-line
warn at boot; the front-door still serves what it can.

### `local start-alb` lifecycle

`^C` (SIGINT) and SIGTERM tear down the front-door servers first, then
every backing service's replicas + sidecar + shared network in parallel.
Double-`^C` bypasses cleanup and exits 130 immediately so users have an
escape hatch when docker hangs. The front-door servers always rebind
the requested host port on restart — there is no in-process state
across `^C`.

