---
title: cdkd local start-service
description: "Run a long-running local ECS Service emulator — per-replica containers with restart-on-exit watching and zero-downtime hot reload."
---

# cdkd local start-service

`cdkd local start-service <targets...>` is the long-running counterpart of
[`cdkd local run-task`](local-run-task.md). It finds one or more
`AWS::ECS::Service` resources in the synthesized template, boots `DesiredCount`
task replicas of each (capped by `--max-tasks`), and keeps them running —
restarting a replica when its essential container exits — until you press `^C`.
Name two or more services and they are booted into a shared Cloud Map / Service
Connect registry so they can discover each other.

```bash
cdkd local start-service MyStack/Orders                       # one service, DesiredCount replicas
cdkd local start-service MyStack/Orders MyStack/Frontend      # two services that discover each other
cdkd local start-service                                      # pick services interactively (TTY only)
cdkd local start-service MyStack/Orders --max-tasks 1 --host-port 80=8080   # one replica, so a host port can be published
cdkd local start-service MyStack/Orders --from-state          # resolve intrinsics from deployed state
cdkd local start-service MyStack/Orders --watch --image-override MyStack/Orders=./Dockerfile  # build locally, roll on edits
```

Docker is required — see [Local Execution](local-emulation.md#requirements).

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[targets...]` | interactive picker | One or more CDK display paths or stack-qualified logical ids of `AWS::ECS::Service` resources. Omit in a TTY to multi-select. |
| `--cluster <name>` | `cdkd-local` | Cluster name reported by the metadata endpoint, and the prefix of the shared Docker network and per-replica cluster names. |
| `--max-tasks <n>` | `3` | Hard cap on the local replica count, applied over the template's `DesiredCount`. Must be between `1` and `83` — the range of the per-replica link-local /24 subnet allocator. |
| `--restart-policy <policy>` | `on-failure` | How to react when a replica's essential container exits: `on-failure`, `always`, or `none`. |
| `--host-port <containerPort=hostPort...>` | host port equals container port | Publish a container port on a specific host port, e.g. `80=8080`. Repeatable. Single-replica services only. |
| `--no-logs` | off (logs stream) | Stop streaming each replica's container output to your terminal. `docker logs -f <id>` stays available. |
| `--watch` | off | Re-synthesize and reload replicas when the CDK source changes, one replica at a time. |
| `--shadow-ready-timeout <ms>` | `60000` | How long the `--watch` rebuild path waits for a shadow replica's port to accept a TCP connection. Also set by `CDKD_SHADOW_READY_TIMEOUT_MS`. |
| `--image-override <service=dockerfile or dockerfile...>` | — | Replace a service's image with a local `docker build`. Repeatable; a bare Dockerfile opens a picker over the uncovered pinned targets. |
| `--image-build-arg <KEY=VAL...>` | — | A `docker build --build-arg` pair for every override build. Repeatable. `<service>:KEY=VAL` scopes it to one service. |
| `--image-build-secret <id=src...>` | — | A `docker build --secret id=<id>,src=<src>` entry for every override build. Repeatable. `<service>:id=src` scopes it to one service. |
| `--image-target <stage or svc=stage...>` | — | A `docker build --target` stage for every override build. Repeatable. `<service>=<stage>` scopes it and beats the global value. |
| `--no-interactive-overrides` | off (prompts) | Suppress the boot prompt asking for a Dockerfile per pinned target, and the picker fired by a bare `--image-override`. |
| `--strict-overrides` | off | Fail at boot when any pinned target is still uncovered after `--image-override` and the boot prompt have resolved. |
| `--env-vars <file>` | — | SAM-shape JSON env-var overrides, keyed by container name — see [Local Execution](local-emulation.md#common-flags). |
| `--container-host <ip>` | `127.0.0.1` | Host IP that published container ports bind to. Must be numeric — see [Local Execution](local-emulation.md#common-flags). |
| `--assume-role [arn]` | off | Assume the task definition's `TaskRoleArn` (or the ARN you pass) and serve those credentials through the metadata sidecar. |
| `--assume-task-role [arn]` | off | Deprecated alias of `--assume-role` on this command. Both work here; note that `cdkd local run-task` accepts only `--assume-task-role`. |
| `--no-pull` | off | Skip `docker pull` for every container image and the metadata sidecar — see [Local Execution](local-emulation.md#common-flags). |
| `--no-build` | off | Skip `docker build` on the CDK-asset path and reuse the previously built tag. Errors when that tag is not in the local registry. |
| `--ecr-role-arn <arn>` | — | Role to assume before authenticating to ECR, for cross-account or centralized registries. |
| `--platform <platform>` | inferred from `RuntimePlatform.CpuArchitecture` | Force `docker run --platform`. Accepts `linux/amd64` or `linux/arm64`. |
| `--from-state` | off | Substitute deployed values from cdkd's S3 state into images, environment variables, secrets, role ARNs and volumes — see [Local Execution](local-emulation.md#common-flags). |
| `--from-cfn-stack [name]` | off | Substitute from a CloudFormation-deployed stack instead. Bare form uses the cdkd stack name. Mutually exclusive with `--from-state`. |
| `--stack-region <region>` | — | Region of the state record to read, and the CloudFormation client region for `--from-cfn-stack` — see [Local Execution](local-emulation.md#common-flags). |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json`, then `cdkd-state-{accountId}` | S3 bucket holding cdkd state, for `--from-state`. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `-a`, `--app <command>` | `cdk.json` / `CDKD_APP` | CDK app command, or a path to a pre-synthesized cloud assembly — see [Local Execution](local-emulation.md#common-flags). |
| `--output <path>` | `cdk.out` | Output directory for synthesis. |
| `-c`, `--context <key=value...>` | — | Set CDK context values. Repeatable. |
| `--region <region>` | `AWS_REGION`, the stack's region, then the profile's | AWS region for SDK calls. |
| `--profile <profile>` | — | AWS profile. Its credentials are forwarded to the sidecar and to the containers. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for cdkd's own AWS API calls. |
| `-y`, `--yes` | off | Answer interactive prompts with the recommended response. |
| `--verbose` | off | Verbose logging. |

**Spell the region lower-case.** This command does not fold an upper-cased
`--region` / `AWS_REGION` to its canonical spelling, and AWS rejects the raw
form at signature time (`SignatureDoesNotMatch`, `AuthorizationHeaderMalformed`).
See [`--region` / `AWS_REGION`](cli-reference.md#region-aws-region-every-command).

## Target resolution

Each `<target>` uses the same grammar as [`cdkd local run-task`](local-run-task.md#target-resolution):
a CDK display path (`MyStack/Orders`), a stack-qualified logical id
(`MyStack:MyServiceXYZ`), or — in a single-stack app — a bare name. Omit the
targets entirely in an interactive terminal and cdkd lists the app's ECS services
for you to multi-select; in a non-interactive shell, omitting them is an error
that names the flag forms instead.

A target must resolve to exactly one `AWS::ECS::Service`:

| What you named | Result |
| --- | --- |
| One `AWS::ECS::Service` | Booted. |
| A display path matching several services | Error listing the matches; refine the path or use the `Stack:LogicalId` form. |
| An `AWS::ECS::TaskDefinition` | Error pointing you at [`cdkd local run-task`](local-run-task.md) for one-shot tasks. |
| Any other resource type | Error naming the type found. |

The service's `TaskDefinition` property must be a `Ref` to a same-stack
`AWS::ECS::TaskDefinition` — the shape CDK synthesizes. A cross-stack task
definition or an `Fn::ImportValue` shape is rejected with an error naming the
unsupported reference.

`--from-cfn-stack <name>` with an explicit name cannot be combined with targets
that route to more than one stack: an explicit CloudFormation stack name applies
to one stack only and would silently mismap logical ids across siblings. Use the
bare `--from-cfn-stack`, so each stack uses its own name, or run one invocation
per stack.

## Replicas and restart policy

The number of replicas booted per service is the lesser of the template's
`DesiredCount` and `--max-tasks`. When the cap bites, a warning names the
template count, the cap, and the count actually running.

| `--restart-policy` | When an essential container exits |
| --- | --- |
| `on-failure` (default) | The replica is restarted only on a non-zero exit code. |
| `always` | The replica is restarted on every exit, whatever the code. |
| `none` | The replica stays down and the service runs degraded; a warning names the replica, the policy and the exit code. |

Restarts back off exponentially — 1s, 2s, 4s, 8s, 16s, then 30s for every
subsequent attempt — so a crash-looping container does not hammer Docker.

## Networking and service discovery

One invocation creates one shared Docker network, `<cluster>-svc-<random>`, on
subnet `169.254.171.0/24`, with the AWS-published metadata-endpoints sidecar at
`169.254.171.2`. Every replica of every named service joins it, so peers reach
each other by container IP or network alias with no extra choreography, and the
network is torn down once at the end of the run.

Each replica runs under its own cluster name,
`<cluster>-svc-<service-logical-id>-r<index>`, which is what the metadata
endpoint reports and what makes replicas easy to pick out of `docker ps`.

An interrupted run can leave its network behind, and the subnet is fixed, so
cdkd sweeps orphaned `<cluster>-svc-*` networks before creating the shared one —
otherwise the next run would fail on `Pool overlaps with other one on this
address space`. A network counts as orphaned when nothing but its own
`-metadata` sidecar is still attached, so a network still serving replicas is
never touched.

### Service Connect and Cloud Map

With two or more targets, every service is published into a shared Cloud Map /
Service Connect registry, and peers are wired up through a Docker `--add-host`
DNS overlay. Aliases come from `ServiceConnectConfiguration`: the discovery name,
the discovery name qualified by the namespace, and every client alias DNS name.
The `Namespace` must be a literal string such as `cdkd.local`; an intrinsic or
cross-stack namespace reference is rejected.

### `awsvpc` network mode

ECS Services on Fargate require `awsvpc`. cdkd maps it to a Docker bridge network
with a startup warning:

| Real `awsvpc` | Locally |
| --- | --- |
| One ENI per task, with a VPC IP | A Docker-assigned IP on the shared bridge network; the metadata endpoint still reports the container's own IP, so code reading the task IP works. |
| Security groups enforced on ingress and egress | Not enforced. Verify security-group behaviour against a real deploy. |
| Tasks never share a host port | Multi-replica services do not publish host ports either — see below. |

## Reaching a service from the host

| Effective replica count | Host access |
| --- | --- |
| 1 | The container's `PortMappings` are published as `-p <container-host>:<hostPort>:<containerPort>`, so `curl localhost:<port>` works. `--host-port <containerPort>=<hostPort>` remaps the host side. |
| More than 1 | No host ports are published. Reach a replica by its container IP or network alias on the shared network, or `docker exec` into it. |

Publishing a fixed host port from several replicas would make the second and
later replicas fail to boot with
`Bind for 127.0.0.1:<port> failed: port is already allocated`, and it would not
match production, where each task has its own ENI.

A privileged container port — anything the template would publish below 1024,
which a local publish cannot take without root and which macOS Docker Desktop
refuses outright — is auto-remapped to a free ephemeral port, with a warning
naming the port chosen. `--host-port <containerPort>=<hostPort>` pins that
choice instead of leaving it to the allocator.

## Image overrides

`--image-override` swaps a service's deployed-registry image for a local
`docker build`, so `--from-cfn-stack` can keep reading real AWS state while you
iterate on the application container.

| Form | Effect |
| --- | --- |
| `--image-override <service>=<dockerfile>` | Binds that Dockerfile to that service. Passing the same service twice is an error. |
| `--image-override <dockerfile>` | Opens a multi-select picker over the still-uncovered pinned targets, so one Dockerfile can cover several services. |

The two forms mix freely. `--image-build-arg`, `--image-build-secret` and
`--image-target` tune those builds; each accepts a global value and a
service-scoped form (`<service>:KEY=VAL`, `<service>:id=src`,
`<service>=<stage>`), with the service-scoped value winning for that service.
`--image-build-secret` enables the standard
`RUN --mount=type=secret,id=<id>` recipe for private registries and npm tokens,
and relative `src` paths are resolved against the working directory with `~`
expanded.

At boot, any target whose image is still pinned to a deployed registry produces a
warning. `--no-interactive-overrides` suppresses the prompts that would otherwise
ask you for a Dockerfile; `--strict-overrides` turns those leftover warnings into
a boot failure. The warnings fire either way.

## `--watch`: hot reload on source changes

`--watch` re-synthesizes and reloads replicas whenever the CDK source changes. It
honours `watch.include` and `watch.exclude` from `cdk.json`; `cdk.out`,
`node_modules` and `.git` are always excluded.

Each firing is classified, and the classification picks the per-replica
primitive:

| Change | Primitive |
| --- | --- |
| Source-only edits to an interpreted-language handler (Node, Python, Ruby, shell) | Fast path — `docker cp` the new source into each replica and `docker restart` it. No rebuild, and the container's IP and host port survive, so registrations stay valid. |
| Dockerfile, dependency-manifest, compiled-language source, TypeScript source, or an edit that cannot be classified | Rebuild — boot a shadow replica under a bumped generation suffix, wait for its port to accept a TCP connection, atomically swap the Cloud Map and front-door registrations, then retire the old container. |

Either path rolls one replica at a time, so peers see no connection refusals
across a reload even on a multi-replica service. TypeScript source edits take the
rebuild path deliberately, so a precompiled handler setup is never left stale.

Failures during a reload are non-fatal and leave the running replicas serving:

- Synthesis fails — a warning, and the previous version keeps serving.
- A target no longer resolves to a service — a warning, and its replicas keep serving.
- An `--image-override` rebuild fails — a warning, and the previous local image is kept.
- A shadow replica does not accept a connection within `--shadow-ready-timeout`
  (default 60000 ms) — the log names the probe that timed out. Raise the budget
  for slow starters such as JVM apps, heavy ORM initialization, or an
  `--inspect-brk` attach pause.
- The effective replica count changed mid-roll because you edited `DesiredCount`
  or `--max-tasks` — existing replicas move to the new image but the count is not
  scaled to match; a warning says so. Restart the command to apply the new count.

## Logs

Every booted replica streams its containers' stdout and stderr to your terminal,
prefixed `[svc=<service> r=<replica-index> c=<container>]` — the same shape
[`cdkd local run-task`](local-run-task.md) uses. Pass `--no-logs` when the
interleaved output of a multi-replica or multi-service run is unreadable;
`docker logs -f <id>` in another terminal still works.

## Lifecycle and teardown

The emulator boots every replica, prints an endpoint banner and then runs until
it is signalled. `^C` and `SIGTERM` both start the same graceful shutdown:

1. The file watcher is closed and any in-flight reload is drained.
2. Every replica is torn down in parallel — its containers removed, its
   registrations dropped.
3. Temporary credential files are deleted.
4. The shared network and its metadata sidecar are removed last.

A second `^C` exits `130` immediately without cleanup, so you have an escape
hatch when Docker hangs. Orphan containers may remain;
`docker ps --filter name=cdkd-local-` plus `docker rm -f` clears them.

## Limitations

| Not emulated | What to do instead |
| --- | --- |
| A load-balancer listener with round-robin and target-group health checks | `start-service` registers no local listener. Reach a single-replica service on its published ports, or use [`cdkd local start-alb`](local-start-alb.md) for a real local front door. |
| An Envoy sidecar — L7 routing, retries, circuit breaking, mTLS | The Cloud Map DNS overlay covers peer discovery; L7 behaviour is not reproduced. |
| Rolling deployment configuration (`DeploymentConfiguration.MaximumPercent` and siblings) | `--watch` rolls one replica at a time; the template's deployment percentages are not applied. |
| `HealthCheckGracePeriodSeconds` | Parsed but not acted on. The restart policy fires on an essential container's exit code, not on health-check failure. |
| Auto Scaling | Set the replica count with `DesiredCount` and `--max-tasks`. |
| Security groups and per-task ENIs under `awsvpc` | Not enforced locally; verify against a real deploy. |
| An intrinsic or cross-stack `ServiceConnectConfiguration.Namespace` | Use a literal namespace name. |
| A cross-stack or `Fn::ImportValue` `TaskDefinition` reference | Use the standard `Ref` to a same-stack task definition. |
| `Fn::GetAtt` in container environment variables under `--from-cfn-stack` | Dropped with a warning — `ListStackResources` returns no per-attribute values, and no ECS-side call recovers them from a deployed task or service. Use `--from-state` instead. |

Every limitation of the underlying task runner applies here too — volumes,
secret-name refusals and container start ordering all behave as described in
[`cdkd local run-task`](local-run-task.md).

## Exit codes

| Code | Meaning |
| --- | --- |
| `1` | Hard error, or a cancelled interactive picker. |
| `130` | Shut down by `^C` or `SIGTERM`. The first signal tears every replica down and then exits; a second exits immediately with no cleanup. |

The refusals behind exit `1`:

| Refusal | When |
| --- | --- |
| Docker unavailable | The daemon is not running, or `docker` is not on `PATH`. |
| No target resolved | Nothing matched, or the terminal is non-interactive and no target was named. |
| Wrong resource type | The target is a `TaskDefinition`, or any type other than `AWS::ECS::Service`. |
| Unsupported `TaskDefinition` reference | The service points at a cross-stack or `Fn::ImportValue` task definition. |
| `--max-tasks` out of range | Outside `1`-`83`. |
| Shared network creation failed | Usually a leaked network from an interrupted run holding the subnet. |
| `--strict-overrides` with an uncovered target | A registry-pinned target had no `--image-override` and no prompt answer. |
| Conflicting state-source flags | `--from-state` with `--from-cfn-stack`, or an explicit `--from-cfn-stack <name>` across several stacks. |

The emulator runs until it is signalled, so there is no exit-`0` path once the
services are up. The full cross-command table is in the
[CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd local run-task`](local-run-task.md) — the one-shot counterpart, and the source of the networking, secrets, volume and ordering behaviour each replica inherits
- [`cdkd local start-alb`](local-start-alb.md) — put a local Application Load Balancer in front of these services for path, host, header and weighted routing
- [Local Execution](local-emulation.md) — the subcommand index, Docker requirements, and the flags common to every `cdkd local` command
- [CLI Reference](cli-reference.md) — every cdkd command, the output-stream contract, and the full exit-code table
