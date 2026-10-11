---
title: cdkd local start-service
description: "Run ECS services from your CDK app on local Docker: DesiredCount replicas each, restarted when they exit, discoverable by each other, and reloaded on source edits."
---

# cdkd local start-service

`cdkd local start-service <target>...` boots the replicas of one or more ECS
services and keeps them running, restarting a replica when its essential
container exits, until you press {kbd:ctrl+c}. Services named together can
discover each other through Service Connect and Cloud Map names.

For one task that runs once and exits, use
[`cdkd local run-task`](local-run-task.md). For a load balancer in front of
the services, use [`cdkd local start-alb`](local-start-alb.md).

## Run a service

Given this service in `MyStack`, whose container listens on port 8080:

```ts
import * as ecs from 'aws-cdk-lib/aws-ecs';

const taskDef = new ecs.FargateTaskDefinition(this, 'OrdersTask');
taskDef.addContainer('web', {
  image: ecs.ContainerImage.fromAsset('orders'),
  portMappings: [{ containerPort: 8080 }],
});

new ecs.FargateService(this, 'Orders', {
  cluster,
  taskDefinition: taskDef,
  desiredCount: 2,
});
```

run one replica, so its port is published on your machine:

```bash
cdkd local start-service MyStack/Orders --max-tasks 1
```

cdkd builds the image, boots the replica and prints a `Service(s) running:`
banner with its endpoints. Container output follows, prefixed
`[svc=<service> r=<replica-index> c=<container>]`. From another terminal:

```bash
curl http://127.0.0.1:8080/
```

Without `--max-tasks 1` the service runs two replicas and publishes no host
port; see [Reaching a service from the host](#reaching-a-service-from-the-host).

More invocations:

```bash
cdkd local start-service MyStack/Orders MyStack/Frontend      # two services that discover each other
cdkd local start-service                                      # pick services from a list
cdkd local start-service MyStack/Orders --max-tasks 1 --host-port 8080=9090   # publish on another port
cdkd local start-service MyStack/Orders --from-state          # deployed values and secrets
cdkd local start-service MyStack/Orders --watch               # reload on source edits
cdkd local start-service MyStack/Orders --from-cfn-stack \
  --image-override MyStack/Orders=./orders/Dockerfile         # real config, locally built image
```

Docker is required. See [Local Execution](local-emulation.md#requirements).

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[targets...]` | picker | The `AWS::ECS::Service` resources to run. Omit in an interactive terminal to choose from a list. |
| `--max-tasks <n>` | `3` | Most replicas per service, applied over `DesiredCount`. Between `1` and `83`. |
| `--restart-policy <policy>` | `on-failure` | What to do when an essential container exits: `on-failure`, `always` or `none`. |
| `--host-port <containerPort=hostPort...>` | host port = container port | Publish a container port on another host port. Repeatable. Single-replica services only. |
| `--watch` | off | Re-synthesize and reload replicas when the source changes. See [`--watch`](#watch-hot-reload-on-source-changes). |
| `--shadow-ready-timeout <ms>` | `60000` | How long a `--watch` rebuild waits for the new replica to accept a connection. Also set by `CDKD_SHADOW_READY_TIMEOUT_MS`. |
| `--no-logs` | off | Do not stream container output. `docker logs -f <id>` still works. |
| `--cluster <name>` | `cdkd-local` | Cluster name the metadata endpoint reports, and the prefix of network and replica names. |
| `--assume-role [arn]` | off | Give the containers the task role's credentials, or those of the ARN you pass. `--assume-task-role` is a deprecated alias. |
| `--platform <platform>` | from `RuntimePlatform.CpuArchitecture` | Force `linux/amd64` or `linux/arm64`. |
| `--no-pull` | off | Skip `docker pull` for every container image and the metadata sidecar. |
| `--no-build` | off | Reuse the previously built image for a CDK asset. Errors when it is not in the local registry. |
| `--ecr-role-arn <arn>` | — | Role to assume before authenticating to ECR, for another account's registry. |
| `--image-override <service=dockerfile or dockerfile...>` | — | Build a service's image locally. See [Image overrides](#image-overrides). |
| `--image-build-arg <KEY=VAL...>` | — | `docker build --build-arg` for override builds. Repeatable. |
| `--image-build-secret <id=src...>` | — | `docker build --secret id=<id>,src=<src>` for override builds. Repeatable. |
| `--image-target <stage or svc=stage...>` | — | `docker build --target` for override builds. Repeatable. |
| `--no-interactive-overrides` | off | Do not prompt for Dockerfiles at boot. |
| `--strict-overrides` | off | Fail at boot when a service still uses a deployed-registry image. |

It also accepts every [common flag](local-emulation.md#common-flags). On this
command `--env-vars` is keyed by container name and `--profile` credentials are
passed to the containers.

> [!WARNING]
> Do not pass `--role-arn` here without selecting a profile. The role is also
> used to fetch the ECS task secrets that are injected into your containers.
> cdkd warns at startup when this applies. See the `--role-arn` section of the
> [CLI Reference](cli-reference.md).

## Target resolution

Each target is a CDK display path (`MyStack/Orders`), a stack-qualified
logical ID (`MyStack:OrdersService1234`), or a bare name in a single-stack
app. See [Naming the target](local-emulation.md#naming-the-target).

With no target, an interactive terminal shows the app's services to choose
from. A non-interactive shell reports an error instead.

| What you named | Result |
| --- | --- |
| One `AWS::ECS::Service` | Booted. |
| A path matching several services | Error listing the matches. Use a longer path or the `Stack:LogicalId` form. |
| An `AWS::ECS::TaskDefinition` | Error pointing at [`cdkd local run-task`](local-run-task.md). |
| Any other resource type | Error naming the type. |

The service's `TaskDefinition` must be a `Ref` to a task definition in the
same stack, which is what CDK synthesizes. A cross-stack or `Fn::ImportValue`
task definition is rejected.

## Replicas and restart policy

Each service runs the lesser of its `DesiredCount` and `--max-tasks`. When the
cap applies, a warning gives both numbers.

| `--restart-policy` | When an essential container exits |
| --- | --- |
| `on-failure` (default) | The replica restarts if the exit code is not zero. |
| `always` | The replica restarts. |
| `none` | The replica stays down, with a warning naming it and the exit code. |

Restarts wait 1s, 2s, 4s, 8s, 16s, then 30s between attempts.

## Networking and service discovery

All replicas of all named services join one Docker network,
`<cluster>-svc-<random>`, on subnet `169.254.171.0/24`, with the ECS metadata
sidecar at `169.254.171.2`. Replicas reach each other by container IP or
network alias.

Each replica reports the cluster name
`<cluster>-svc-<service-logical-id>-r<index>`, which also identifies it in
`docker ps`.

Before creating the network, cdkd removes any `<cluster>-svc-*` network a
previous interrupted run left behind with nothing attached but its sidecar. A
leftover network would otherwise hold the subnet and fail the run with `Pool
overlaps with other one on this address space`.

### Service Connect and Cloud Map

With two or more targets, each service is reachable by the names in its
`ServiceConnectConfiguration`: the discovery name, the discovery name
qualified by the namespace, and every client alias.

```bash
cdkd local start-service MyStack/Orders MyStack/Frontend
```

The `Namespace` must be a literal string such as `cdkd.local`. An intrinsic or
cross-stack namespace is rejected.

### `awsvpc` network mode

`awsvpc` becomes the shared Docker bridge network, with a warning at startup.

| On AWS | Locally |
| --- | --- |
| Each task has its own network interface and VPC IP | Each container has a Docker-assigned IP, and the metadata endpoint reports it. |
| Security groups filter traffic | Not enforced. |

## Reaching a service from the host

| Replicas running | Host access |
| --- | --- |
| 1 | The container's `PortMappings` are published on `--container-host`. `--host-port <containerPort>=<hostPort>` changes the host port. |
| More than 1 | No host port is published. Reach a replica by container IP or alias on the shared network, or `docker exec` into it. |

Several replicas cannot share one host port, so cdkd publishes none.

A container port below 1024 cannot be published without root, and Docker
Desktop on macOS refuses it. cdkd publishes it on a free high port instead and
names that port in a warning. `--host-port` picks the port yourself:

```bash
cdkd local start-service MyStack/Web --max-tasks 1 --host-port 80=8080
curl http://127.0.0.1:8080/
```

For round-robin across replicas, put
[`cdkd local start-alb`](local-start-alb.md) in front.

## Image overrides

`--image-override` builds a service's image from a local Dockerfile instead of
pulling the image the deployed service uses. Combine it with
`--from-cfn-stack` or `--from-state` to run your working copy against the
stack's real configuration.

| Form | Effect |
| --- | --- |
| `--image-override <service>=<dockerfile>` | Uses that Dockerfile for that service. Naming a service twice is an error. |
| `--image-override <dockerfile>` | Opens a picker over the services not yet covered, so one Dockerfile can serve several. |

The build flags take a global value or a service-scoped one. The scoped value
wins for its service.

| Flag | Global | Scoped to one service |
| --- | --- | --- |
| `--image-build-arg` | `KEY=VAL` | `<service>:KEY=VAL` |
| `--image-build-secret` | `id=src` | `<service>:id=src` |
| `--image-target` | `<stage>` | `<service>=<stage>` |

`--image-build-secret` supports `RUN --mount=type=secret,id=<id>` for private
registries and npm tokens. A relative `src` is resolved against the working
directory, and `~` is expanded.

At boot, each service still using a deployed-registry image gets a warning and,
in a terminal, a prompt for a Dockerfile. `--no-interactive-overrides` turns
the prompts off. `--strict-overrides` fails the boot instead of continuing.

## `--watch`: hot reload on source changes

`--watch` re-synthesizes when the CDK source changes and reloads one replica
at a time, so other services see no refused connections. `cdk.out`,
`node_modules` and `.git` are ignored, and `watch.include` / `watch.exclude`
in `cdk.json` are honoured.

| Edit | Reload |
| --- | --- |
| Source of an interpreted-language handler (Node, Python, Ruby, shell) | The new source is copied into each replica and the container restarted. Its IP and host port do not change. |
| A Dockerfile, a dependency manifest, TypeScript or compiled-language source, or anything unclear | The image is rebuilt. A new replica boots, cdkd waits for its port to accept a connection, then swaps it in and removes the old one. |

A failed reload leaves the running replicas serving:

| Failure | Result |
| --- | --- |
| Synthesis fails | Warning. The previous version keeps serving. |
| A target no longer resolves to a service | Warning. Its replicas keep serving. |
| An `--image-override` build fails | Warning. The previous image is kept. |
| The new replica does not accept a connection within `--shadow-ready-timeout` | The log names the probe that timed out. Raise the timeout for slow starters such as JVM apps. |
| `DesiredCount` or `--max-tasks` changed | Replicas move to the new image but the count does not change. Restart to apply it. |

## Stopping

{kbd:ctrl+c} or `SIGTERM` removes every replica, the temporary credential
files, and finally the shared network and sidecar. A second {kbd:ctrl+c}
exits `130` at once without cleanup; see
[Stopping a server](local-emulation.md#stopping-a-server).

## Limitations

| Not emulated | What to do |
| --- | --- |
| A load balancer with round-robin and target-group health checks | Use [`cdkd local start-alb`](local-start-alb.md). |
| Envoy behaviour under Service Connect: L7 routing, retries, circuit breaking, mTLS | Only name-based discovery is provided. |
| `DeploymentConfiguration` percentages | `--watch` always rolls one replica at a time. |
| `HealthCheckGracePeriodSeconds`, and restarts on a failed health check | A replica restarts on its essential container's exit code only. |
| Auto Scaling | Set the count with `DesiredCount` and `--max-tasks`. |
| Security groups and per-task network interfaces under `awsvpc` | Check them against a real deploy. |
| An intrinsic or cross-stack Service Connect `Namespace` | Use a literal namespace name. |
| A cross-stack or `Fn::ImportValue` `TaskDefinition` | Reference a task definition in the same stack. |
| `Fn::GetAtt` in container environment variables under `--from-cfn-stack` | Dropped with a warning. Use `--from-state`. |

Each replica is run the way [`cdkd local run-task`](local-run-task.md) runs a
task, so its rules for images, secrets, secret names, volumes and container
start ordering apply here. The
[finch on macOS and Windows](local-emulation.md#finch-on-macos-and-windows)
refusal is checked for each service when its first replica boots.

## Exit codes

| Code | Meaning |
| --- | --- |
| `1` | An error, or a cancelled picker. |
| `130` | Stopped by {kbd:ctrl+c} or `SIGTERM`. |

There is no exit `0`: once the services are up, the command runs until it is
signalled. Causes of exit `1`:

| Cause | When |
| --- | --- |
| Docker unavailable | The daemon is not running, or `docker` is not on `PATH`. |
| No target resolved | Nothing matched, or no target was named in a non-interactive shell. |
| Wrong resource type | The target is a task definition or another non-service resource. |
| Unsupported `TaskDefinition` reference | The service points at a cross-stack or imported task definition. |
| `--max-tasks` out of range | Outside `1`-`83`. |
| Network creation failed | Usually a network left by an interrupted run is holding the subnet. |
| `--strict-overrides` with an uncovered service | A service still uses a deployed-registry image. |
| Conflicting state flags | `--from-state` with `--from-cfn-stack`, or an explicit `--from-cfn-stack <name>` across several stacks. |

The full cross-command table is in the
[CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd local run-task`](local-run-task.md): run one task once, and the
  image, secret, volume and ordering rules each replica follows
- [`cdkd local start-alb`](local-start-alb.md): a local load balancer in front
  of these services
- [Local Execution](local-emulation.md): choosing a command, value
  resolution, and the flags every command shares
- [CLI Reference](cli-reference.md): every command and the full exit-code
  table
