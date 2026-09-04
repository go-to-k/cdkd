---
title: cdkd local start-alb
description: "Front local ECS and Lambda backing services with a local Application Load Balancer — path, host, header, weighted, redirect, and fixed-response routing."
---

# cdkd local start-alb

`cdkd local start-alb [targets...]` stands up a local Application Load Balancer
in front of the ECS services and Lambda functions its listeners point at. It
boots every backing ECS service, opens one local HTTP(S) server per listener
port, and applies that listener's rules — path, host, header, method,
query-string and source-IP — against the running replicas. Reach for it when a
routing rule, a weighted split or an auth action needs to be exercised without
a deploy. Docker is required.

Reach for [`cdkd local start-api`](local-start-api.md) instead when the front
door you want to exercise is API Gateway. An ALB answers from running ECS
replicas, Lambda target groups, redirects and fixed responses; API Gateway
answers from Lambdas, HTTP upstreams and response templates.

```bash
cdkd local start-alb MyStack/MyAlb                             # serve one ALB on its listener ports
cdkd local start-alb                                           # pick the load balancers interactively (TTY)
cdkd local start-alb MyStack/PublicAlb MyStack/InternalAlb     # two ALBs sharing one network + registry
cdkd local start-alb MyStack/MyAlb --lb-port 80=8080           # remap a privileged listener port
cdkd local start-alb MyStack/MyAlb --tls --bearer-token "$JWT" # terminate TLS locally, inject a default token
cdkd local start-alb MyStack/MyAlb --from-state --watch        # bind deployed state, hot-reload on source edits
```

## Options

`-a, --app`, `--env-vars`, `--no-pull`, `--from-state`, `--stack-region` and
`--container-host` behave as they do on every `cdkd local` subcommand; see
[Local Execution](local-emulation.md#common-flags).

### Front door

| Flag | Default | Description |
| --- | --- | --- |
| `[targets...]` | interactive picker | One or more load balancers, as a CDK display path (`MyStack/MyAlb`) or a stack-qualified logical ID. Variadic; omit in a TTY to multi-select. |
| `--lb-port <listenerPort=hostPort>` | host port == listener port | Bind the front door for one listener on a different host port. Repeatable. |
| `--tls` | off | Terminate TLS locally for cloud-HTTPS listeners instead of serving them over plain HTTP. |
| `--tls-cert <path>` | — | PEM server certificate for the HTTPS front door. Implies `--tls`; must be paired with `--tls-key`. |
| `--tls-key <path>` | — | PEM private key matching `--tls-cert`. Implies `--tls`; must be paired with it. |
| `--bearer-token <jwt>` | — | Bearer JWT the front door injects as `Authorization` when an inbound request carries none. |
| `--no-verify-auth` | off | Serve every request as if the `authenticate-cognito` / `authenticate-oidc` check passed. |

### Backing services

| Flag | Default | Description |
| --- | --- | --- |
| `--cluster <name>` | `cdkd-local` | Cluster name surfaced in `ECS_CONTAINER_METADATA_URI_V4`, and the prefix of the docker network. |
| `--max-tasks <n>` | `3` | Hard cap on local replicas per service, overriding the template's `DesiredCount`. Cannot exceed 83. |
| `--restart-policy <policy>` | `on-failure` | What happens when an essential container exits: `on-failure`, `always`, or `none` (run degraded). |
| `--no-logs` | off | Stop streaming each replica's container output to the terminal. |
| `--assume-role [arn]` | off | Assume the task definition's `TaskRoleArn` (or an explicit ARN) and forward temporary credentials through the metadata sidecar. |
| `--assume-task-role [arn]` | off | Deprecated alias of `--assume-role` on this command. Both forms work here; note that `cdkd local run-task` accepts only `--assume-task-role`. |
| `--ecr-role-arn <arn>` | — | Role to assume before authenticating against ECR, for cross-account or centralized registries. |
| `--platform <platform>` | task `RuntimePlatform` | Force `linux/amd64` or `linux/arm64` for every container. |

### Container images

| Flag | Default | Description |
| --- | --- | --- |
| `--no-pull` | off | Skip `docker pull` for every container image and the metadata sidecar. |
| `--no-build` | off | Skip `docker build` on the local CDK-asset path and reuse the previously built tag. Errors when that tag is missing. |
| `--image-override <service=dockerfile>` | — | Build a service's image locally from the named Dockerfile instead of pulling its deployed registry tag. Repeatable; a bare `<dockerfile>` opens a picker. |
| `--image-build-arg <KEY=VAL>` | — | `docker build --build-arg` pair applied to every `--image-override` build. Repeatable. |
| `--image-build-secret <id=src>` | — | `docker build --secret id=<id>,src=<src>` entry applied to every `--image-override` build, for `RUN --mount=type=secret`. Repeatable. |
| `--image-target <stage>` | — | Multi-stage build stage for `--image-override` builds (docker's `--target`). `<service>=<stage>` scopes it to one service; a bare `<stage>` applies globally. |
| `--no-interactive-overrides` | off | Suppress the boot prompt that asks for a Dockerfile per pinned target, and the `--image-override <dockerfile>` picker. |
| `--strict-overrides` | off | Fail at boot when any registry-pinned target is still uncovered after overrides and prompts resolve. |

### Hot reload

| Flag | Default | Description |
| --- | --- | --- |
| `--watch` | off | Re-synth and roll every backing ECS service when the CDK source changes. |
| `--shadow-ready-timeout <ms>` | `60000` | How long a shadow replica has to accept a TCP connection before the roll gives up. Also read from `CDKD_SHADOW_READY_TIMEOUT_MS`; the flag wins. |

### State sources

| Flag | Default | Description |
| --- | --- | --- |
| `--from-state` | off | Resolve intrinsics in the backing services from cdkd's S3 state. Mutually exclusive with `--from-cfn-stack`. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding cdkd state. Only meaningful with `--from-state`. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. Only meaningful with `--from-state`. |
| `--from-cfn-stack [name]` | off | Resolve intrinsics from a deployed CloudFormation stack, for apps deployed with the CDK CLI. Bare form uses the cdkd stack name. |
| `--stack-region <region>` | — | Region of the state record to read, and the CloudFormation client region under `--from-cfn-stack`. |

### Shared

| Flag | Default | Description |
| --- | --- | --- |
| `-a`, `--app <command>` | `cdk.json` / `CDKD_APP` | CDK app command, or a path to a pre-synthesized cloud assembly. |
| `--output <path>` | `cdk.out` | Output directory for synthesis. |
| `-c`, `--context <key=value>` | — | Context value passed to synthesis. Repeatable. |
| `--env-vars <file>` | — | SAM-shaped JSON env-var overrides for backing containers. |
| `--container-host <ip>` | `127.0.0.1` | Host IP the published container and front-door ports bind to. Must be a numeric IP. |
| `--region <region>` | `AWS_REGION` / stack / profile | AWS region for SDK calls. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `-y`, `--yes` | off | Answer interactive prompts with the recommended response. |
| `--verbose` | off | Verbose logging. |

**Spell the region lower-case.** This command does not fold an upper-cased
`--region` / `AWS_REGION` to its canonical spelling, and AWS rejects the raw
form at signature time (`SignatureDoesNotMatch`, `AuthorizationHeaderMalformed`).
See [`--region` / `AWS_REGION`](cli-reference.md#region-aws-region-every-command).

## Target resolution

Each target names an `AWS::ElasticLoadBalancingV2::LoadBalancer`:

- A CDK display path (`MyStack/MyAlb`), or a stack-qualified logical ID
  (`MyStack:MyAlb`). Single-stack apps may omit the stack prefix.
- Omit the targets entirely in an interactive terminal to multi-select from a
  list of the app's load balancers.
- Naming a Listener or a TargetGroup is an error, and the message lists the
  load balancers available in the stack.

Passing several load balancers in one invocation puts them on a single shared
docker network with one Cloud Map registry, so ECS services registered behind
different load balancers still discover each other.

## Listener and action support

The front door reads the synthesized template and serves these shapes. Anything
outside them is skipped with a warning at boot, and the rest of the load
balancer still serves.

| Shape | Supported |
| --- | --- |
| Listener protocols | `HTTP` and `HTTPS`. `TCP` / `UDP` / `TLS` (NLB-style) listeners are skipped. |
| Rule conditions | All six ALB fields: `path-pattern`, `host-header`, `http-header`, `http-request-method`, `query-string`, `source-ip`. |
| Actions | `forward` (single target group and weighted across several), `redirect`, `fixed-response`. |
| Auth actions | `authenticate-cognito` and `authenticate-oidc`, enforced as a local Bearer-JWT check. |
| Target groups | ECS services (bound through `AWS::ECS::Service.LoadBalancers[]`) and Lambda functions (a target group whose `Targets[].Id` is the function's ARN). |

Requests forwarded to a backing replica carry the ALB forwarding headers: the
client IP appended to any existing `X-Forwarded-For` chain, plus
`X-Forwarded-Proto` and `X-Forwarded-Port` for the listener. When no rule
matches and the listener has no locally servable default action, the 404 names
the request fields that were evaluated rather than returning a bare status.

WebSocket upgrades go through the same rule matching and auth gates. An ECS
forward target gets a raw TCP bridge to the picked replica; `redirect` and
`fixed-response` actions answer over the upgrade socket; a Lambda target group
answers `502`, because Lambda target groups do not carry WebSocket traffic.

### TLS termination

A cloud-HTTPS listener is served over **plain HTTP** locally by default, with
`X-Forwarded-Proto: https` preserved so the upstream app still sees the deployed
listener protocol. That is the friendlier default — no self-signed certificate
warnings in `curl` or a browser.

| Invocation | Front door |
| --- | --- |
| (no TLS flag) | Plain HTTP, `X-Forwarded-Proto: https` preserved. |
| `--tls` | Real HTTPS with a self-signed certificate, generated on first use and cached under `$XDG_CACHE_HOME/cdk-local/alb-https/` (`~/.cache/cdk-local/alb-https/` by default). Requires `openssl` on `PATH`. |
| `--tls-cert` + `--tls-key` | Real HTTPS with your own PEM pair. Each flag implies `--tls`. |

Reach for `--tls` when local-dev cookies need `Secure` / `SameSite=None`, when
the app inspects TLS metadata, or for mTLS / SNI testing. The auto-generated
certificate lists only `DNS:localhost,IP:127.0.0.1` as SubjectAltName, so a
client validating a non-loopback `--container-host` fails the SAN check — supply
`--tls-cert` / `--tls-key` with a matching SAN for that case.

### Authentication actions

An `authenticate-cognito` or `authenticate-oidc` action makes the front door
verify a Bearer JWT against the same JWKS / OIDC discovery URL the deployed load
balancer would use, checking signature, issuer, audience and expiry. An
`AWSELBAuthSessionCookie-*` cookie also passes the guard.

- `--bearer-token <jwt>` supplies the token the front door slots in when the
  inbound request has no `Authorization` header of its own. A caller that
  presents its own token is verified on that token.
- `--no-verify-auth` disables the guard entirely, for local work where minting a
  token is not worth it.

An authenticate action with no locally servable terminal action behind it is
skipped with a warning.

## `--watch`: hot reload without dropping connections

`--watch` re-synthesizes and reloads the backing services whenever the CDK
source changes. `cdk.json`'s `watch.include` / `watch.exclude` are honored, and
`cdk.out`, `node_modules` and `.git` are always excluded.

Each firing is classified per target, which picks the per-replica primitive:

| Change | Primitive |
| --- | --- |
| Source-only edits to an interpreted-language handler (Node, Python, Ruby, shell) | Fast path: the new source is copied into each replica and the container is restarted. No rebuild; the front-door pool entry is unchanged because the IP and port are preserved. |
| Dockerfile, dependency manifest, compiled-language source, or an ambiguous edit | Rebuild: cdkd boots a shadow replica, probes its port for TCP readiness, swaps it into the front-door pool atomically, then drops the old replica. |

Both paths roll one replica at a time, so a continuous request stream against a
listener port sees no connection refusals across the reload. The host front door
— TLS, the JWKS cache, Lambda target containers and the listener sockets — stays
up throughout. When synthesis fails mid-reload the existing replicas keep
serving and a warning is printed.

## Lifecycle

`^C` (SIGINT) and SIGTERM tear the front-door servers down first, then every
backing service's replicas, sidecar and shared network in parallel. A second
signal skips cleanup and exits immediately, which is the escape hatch when
docker itself is wedged — orphan containers may remain, and
`docker ps --filter name=cdkd-local-` finds them.

Nothing persists in process across a restart: the front-door servers rebind the
requested host ports each time.

## Limitations

- A listener protocol, action type or target shape outside the tables above is
  skipped with a per-line warning at boot; the load balancer serves what is left.
- A listener's ACM `Certificates[]` are not fetched — ACM private keys are not
  retrievable — so local HTTPS always uses a generated or supplied certificate.
- Lambda target groups are a no-op on a `--watch` reload: the warm container
  keeps the image it booted with.
- `--watch` rolls the existing replicas onto the new image but does not scale the
  replica count up or down when `DesiredCount` or the `--max-tasks` clamp changes
  mid-run. A warning names it; restart to pick up the new count.
- `--max-tasks` cannot exceed 83, the range of the per-replica link-local subnet
  allocator.
- Under `--from-cfn-stack`, an `Fn::GetAtt` in a container's `Environment[].Value`
  is dropped with a warning: CloudFormation's resource listing does not return
  per-attribute values, and no ECS-side call recovers them from a deployed task.

## Exit codes

| Code | Meaning |
| --- | --- |
| `1` | Hard error — bad target, synthesis failure, docker or AWS failure, a boot refused by `--strict-overrides`, or a cancelled interactive picker. |
| `130` | Shut down on `^C` / SIGTERM, or on a second signal with cleanup skipped. |

The front door runs until it is signalled, so a successful session ends at `130`
rather than `0`. The full cross-command table is in the
[CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd local start-service`](local-start-service.md) — the ECS service emulator
  that runs the backends this command fronts
- [`cdkd local start-api`](local-start-api.md) — the API Gateway counterpart of
  this front door
- [`cdkd local run-task`](local-run-task.md) — the rules every backing container
  follows for secrets, volumes and `DependsOn` start ordering
- [`cdkd local invoke`](local-invoke.md) — one-shot Lambda invoke, the same RIE
  container a Lambda target group uses
- [Local Execution](local-emulation.md) — every `cdkd local` subcommand, Docker
  requirements, and the flags they share
- [CLI Reference](cli-reference.md) — every cdkd command, the output-stream
  contract, and the full exit-code table
