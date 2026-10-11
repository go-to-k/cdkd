---
title: cdkd local start-service
description: "Run ECS services from your CDK app on local Docker: DesiredCount replicas each, restarted when they exit, discoverable by each other, and reloaded on source edits."
---

# cdkd local start-service

`cdkd local start-service <target>...` runs the ECS services in your CDK app
as local Docker containers and keeps them running until you press
{kbd:ctrl+c}. Each service gets as many copies of its task (replicas) as it
asks for, a replica that crashes is started again, and services named together
can call each other by name.

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

run one replica of it:

```bash
cdkd local start-service MyStack/Orders --max-tasks 1
```

cdkd builds the image, starts the replica and prints a `Service(s) running:`
banner with its endpoints. Container output follows, each line prefixed
`[svc=<service> r=<replica-index> c=<container>]`. From another terminal:

```bash
curl http://127.0.0.1:8080/
```

`--max-tasks 1` is what makes the `curl` work. Without it the service runs two
replicas, and cdkd publishes a port on your machine only for a service with
one replica. [Reaching a service from the host](#reaching-a-service-from-the-host)
explains why.

More invocations:

```bash
# two services that discover each other
cdkd local start-service MyStack/Orders MyStack/Frontend

# pick services from a list
cdkd local start-service

# publish on another port
cdkd local start-service MyStack/Orders --max-tasks 1 --host-port 8080=9090

# deployed values and secrets
cdkd local start-service MyStack/Orders --from-state

# reload on source edits
cdkd local start-service MyStack/Orders --watch
cdkd local start-service MyStack/Orders --from-cfn-stack \

  # real config, locally built image
  --image-override MyStack/Orders=./orders/Dockerfile
```

Docker is required. [Local Execution](local-emulation.md) lists the
requirements.

## Options

### Replicas, ports and logs

| Flag | Default | Description |
| --- | --- | --- |
| `[targets...]` | picker | The `AWS::ECS::Service` resources to run. |
| `--max-tasks <n>` | `3` | Most replicas per service. Between `1` and `83`. |
| `--restart-policy <policy>` | `on-failure` | `on-failure`, `always` or `none`. |
| `--host-port <containerPort=hostPort...>` | same port | Publish a container port on another host port. Repeatable. |
| `--watch` | off | Reload replicas when the source changes. |
| `--shadow-ready-timeout <ms>` | `60000` | How long a `--watch` rebuild waits for the new replica. |
| `--no-logs` | off | Do not stream container output. |
| `--cluster <name>` | `cdkd-local` | Cluster name the replicas report, and the prefix of Docker names. |
| `--assume-role [arn]` | off | Give the containers the task role's credentials, or those of the ARN you pass. |
| `--platform <platform>` | from the task definition | Force `linux/amd64` or `linux/arm64`. |

`--shadow-ready-timeout` can also be set with the
`CDKD_SHADOW_READY_TIMEOUT_MS` environment variable. With `--no-logs`,
`docker logs -f <id>` still shows a container's output. The default platform
comes from the task definition's `RuntimePlatform.CpuArchitecture`.
`--assume-task-role` is a deprecated alias of `--assume-role`.

### Images

| Flag | Default | Description |
| --- | --- | --- |
| `--no-pull` | off | Skip `docker pull` for every image. |
| `--no-build` | off | Reuse the image built last time for a CDK asset. |
| `--ecr-role-arn <arn>` | — | Role to assume before authenticating to ECR. |
| `--image-override <service=dockerfile or dockerfile...>` | — | Build a service's image from a local Dockerfile. |
| `--image-build-arg <KEY=VAL...>` | — | `docker build --build-arg` for override builds. |
| `--image-build-secret <id=src...>` | — | `docker build --secret` for override builds. |
| `--image-target <stage or svc=stage...>` | — | `docker build --target` for override builds. |
| `--no-interactive-overrides` | off | Do not prompt for Dockerfiles at startup. |
| `--strict-overrides` | off | Refuse to start while a service still runs a deployed image. |

`--no-pull` also covers the metadata sidecar, the helper container described
under [Networking and service discovery](#networking-and-service-discovery).
`--no-build` reports an error when the image is not in the local registry.
`--ecr-role-arn` is for a registry in another account. The override flags are
explained in
[Image overrides for local ECS services](local-start-service-image-overrides.md).

### Flags shared with other commands

The command also accepts every common flag listed in
[Local Execution](local-emulation.md), such as `--from-state`,
`--from-cfn-stack`, `--env-vars` and `--profile`. Two of them behave in a way
specific to this command: the `--env-vars` file is keyed by container name,
and the credentials of `--profile` are passed to the containers.

> [!WARNING]
> Do not pass `--role-arn` here without selecting a profile. `--role-arn` is
> the role cdkd assumes for its own AWS calls, and on this command cdkd also
> uses it to fetch the ECS task secrets that are injected into your
> containers. cdkd warns at startup when this applies. See the `--role-arn`
> section of the [CLI Reference](cli-reference.md).

## Target resolution

A target names one `AWS::ECS::Service`. You can write it as a CDK display path
(`MyStack/Orders`), as a stack-qualified logical ID
(`MyStack:OrdersService1234`), or, in an app with one stack, as a bare name.
[Local Execution](local-emulation.md) describes the forms in full.

When you name no target in an interactive terminal, cdkd lists the app's
services and you choose from the list. In a non-interactive shell, naming no
target is an error.

The service must point at a task definition in the same stack, which is what
CDK synthesizes for `taskDefinition: taskDef`.

### Targets cdkd rejects

- **A path that matches several services.** The error lists the matches. Use a
  longer path or the `Stack:LogicalId` form.
- **A task definition.** The error points at
  [`cdkd local run-task`](local-run-task.md), which runs a task definition
  once.
- **Any other resource type.** The error names the type.
- **A service whose task definition is in another stack**, or is imported with
  `Fn::ImportValue`.

## Replicas and restart policy

Each service runs `DesiredCount` replicas, up to the limit set by
`--max-tasks`. The limit defaults to 3 so that a service sized for production
does not start dozens of containers on your machine. When the limit lowers the
count, cdkd prints a warning with both numbers.

A replica is restarted when its essential container exits. An essential
container is one the task definition marks as required: on ECS, the whole task
stops when it stops. `--restart-policy` chooses when the restart happens:

| `--restart-policy` | When an essential container exits |
| --- | --- |
| `on-failure` (default) | Restart if the exit code is not zero. |
| `always` | Restart. |
| `none` | Leave the replica down. |

Under `none`, cdkd prints a warning that names the replica and its exit code,
and the service keeps running with fewer replicas.

A replica that keeps crashing is not restarted in a tight loop. cdkd waits 1
second before the first restart, then 2, 4, 8 and 16 seconds, and 30 seconds
before every restart after that.

## Networking and service discovery

All replicas of all the services you name join one Docker network, so they can
reach each other by container IP or by name.

```bash
cdkd local start-service MyStack/Orders MyStack/Frontend
```

### Service Connect and Cloud Map

When you name two or more services, each one is reachable by the names in its
`ServiceConnectConfiguration`. Given this configuration on `Orders`:

```ts
serviceConnectConfiguration: {
  namespace: 'cdkd.local',
  services: [
    {
      portMappingName: 'http',
      discoveryName: 'orders',
      dnsName: 'api',
      port: 8080,
    },
  ],
},
```

the `Frontend` containers can reach `Orders` under three kinds of name:

- the discovery name, `orders`,
- the discovery name qualified by the namespace, `orders.cdkd.local`,
- every client alias, here `api`.

The `Namespace` must be a literal string such as `cdkd.local`. cdkd rejects a
namespace given as an intrinsic function or taken from another stack.

Only the names are provided. Service Connect on AWS also routes traffic
through an Envoy proxy that retries and load-balances; see
[Limitations](#limitations).

### The network and its helper container

The network is named `<cluster>-svc-<random>` and uses the subnet
`169.254.171.0/24`. One extra container, the metadata sidecar, runs at
`169.254.171.2`. It serves the ECS task metadata endpoint, which is how code
in a container asks ECS about its own task.

Each replica reports the cluster name
`<cluster>-svc-<service-logical-id>-r<index>`. The same name identifies the
replica in `docker ps`.

### Edge cases

- **`awsvpc` network mode.** On AWS each task has its own network interface
  and VPC IP, and security groups filter its traffic. Locally the task joins
  the shared Docker network instead, and cdkd says so in a warning at startup.
  Each container has an IP assigned by Docker, which the metadata endpoint
  reports. Security groups are not enforced.
- **A network left by an interrupted run.** If an earlier run was killed
  before it cleaned up, its network still holds the subnet, and creating a new
  one would fail with `Pool overlaps with other one on this address space`.
  Before creating the network, cdkd therefore removes any `<cluster>-svc-*`
  network that has nothing attached but its sidecar.

## Reaching a service from the host

A service with one replica is reachable from your machine. cdkd publishes each
port in the container's `PortMappings` on the same host port, so a container
listening on 8080 answers at `http://127.0.0.1:8080/`. The address is the one
`--container-host` sets, a common flag that defaults to `127.0.0.1`.

`--host-port <containerPort>=<hostPort>` publishes a container port on a
different host port:

```bash
cdkd local start-service MyStack/Web --max-tasks 1 --host-port 80=8080
curl http://127.0.0.1:8080/
```

A service with more than one replica publishes no host port, because several
replicas cannot share one. You can still reach a replica in three ways:

- from another container on the shared network, by container IP or name,
- with `docker exec` into the replica,
- through [`cdkd local start-alb`](local-start-alb.md), which spreads requests
  across the replicas as the deployed load balancer does.

### Container ports below 1024

Publishing a port below 1024 needs root, and Docker Desktop on macOS refuses
it. cdkd publishes such a container port on a free high port instead and names
that port in a warning. Pass `--host-port`, as in the example above, to choose
the port yourself.

## Image overrides

`--image-override` builds a service's image from a local Dockerfile, in place
of the image the service names. You need it when the service uses an image
that is already in a registry (`ContainerImage.fromEcrRepository` or
`fromRegistry`): cdkd pulls that image, so edits to your working copy would
never reach the container.

```bash
cdkd local start-service MyStack/Orders --from-cfn-stack \
  --image-override MyStack/Orders=./orders/Dockerfile
```

[Image overrides for local ECS services](local-start-service-image-overrides.md)
covers the two forms of the flag, build arguments and secrets, and what
happens to a service left without an override.

## `--watch`: hot reload on source changes

`--watch` keeps the services up to date with your source. When a file in the
CDK app changes, cdkd synthesizes the app again and reloads the replicas one
at a time, so the other services never see a refused connection.

```bash
cdkd local start-service MyStack/Orders MyStack/Frontend --watch
```

cdkd reloads a replica in one of two ways, depending on what you edited:

- **Source of an interpreted-language handler** (Node, Python, Ruby, shell).
  cdkd copies the new source into each replica and restarts the container. The
  replica keeps its IP and its host port.
- **Anything else**: a Dockerfile, a dependency manifest, TypeScript or
  compiled-language source, or an edit cdkd cannot classify. cdkd rebuilds the
  image and starts a new replica beside the old one. It waits until the new
  replica's port accepts a connection, then switches traffic to it and removes
  the old one.

Changes under `cdk.out`, `node_modules` and `.git` are ignored. The
`watch.include` and `watch.exclude` settings in `cdk.json` are honoured.

### When a reload fails

A failed reload never takes down what is running.

- **Synthesis fails.** cdkd prints a warning and the previous version keeps
  serving.
- **A target no longer resolves to a service.** cdkd prints a warning and that
  service's replicas keep serving.
- **An `--image-override` build fails.** cdkd prints a warning and keeps the
  previous image.
- **The new replica does not accept a connection in time.** The log names the
  probe that timed out. The limit is `--shadow-ready-timeout`, 60 seconds by
  default. Raise it for applications that start slowly, such as JVM apps.

A change to `DesiredCount` or `--max-tasks` is not applied by a reload. The
replicas move to the new image, but their number stays the same until you
restart the command.

## Stopping

{kbd:ctrl+c} or `SIGTERM` removes every replica, then the temporary credential
files, and finally the shared network and the sidecar.

A second {kbd:ctrl+c} exits at once with code `130` and skips the cleanup, so
containers can be left behind. [Local Execution](local-emulation.md) shows how
to find and remove them.

## Limitations

These parts of ECS are not emulated:

| Not emulated | What to do |
| --- | --- |
| A load balancer in front of the replicas | Use [`cdkd local start-alb`](local-start-alb.md). |
| Service Connect's Envoy proxy: L7 routing, retries, circuit breaking, mTLS | None. Only the names are provided. |
| `DeploymentConfiguration` percentages | None. `--watch` rolls one replica at a time. |
| `HealthCheckGracePeriodSeconds`, and restarts on a failed health check | None. Only an exit triggers a restart. |
| Auto Scaling | Set the count with `DesiredCount` and `--max-tasks`. |
| Security groups and per-task network interfaces under `awsvpc` | Check them against a real deploy. |
| A Service Connect `Namespace` that is not a literal string | Use a literal namespace name. |
| A task definition in another stack | Reference one in the same stack. |
| `Fn::GetAtt` in container environment variables under `--from-cfn-stack` | Use `--from-state`. |

In the last case cdkd drops the variable and prints a warning.

Each replica is run the way [`cdkd local run-task`](local-run-task.md) runs a
task. That page's rules for images, secrets, secret names, volumes and the
order containers start in apply here too.

With finch on macOS or Windows, cdkd refuses to start a task that has a
`Secrets` entry, because finch would expose the secret's value. cdkd makes
that check for each service when its first replica starts.
[Local Execution](local-emulation.md) explains the refusal and the ways
around it.

## Exit codes

| Code | Meaning |
| --- | --- |
| `1` | An error, or a cancelled picker. |
| `130` | Stopped by {kbd:ctrl+c} or `SIGTERM`. |

There is no exit `0`. Once the services are up, the command runs until it
receives a signal. These are the causes of exit `1`:

| Cause | When |
| --- | --- |
| Docker unavailable | The daemon is not running, or `docker` is not on `PATH`. |
| No target resolved | Nothing matched, or no target was named in a non-interactive shell. |
| Wrong resource type | The target is a task definition or another non-service resource. |
| Unsupported task definition | It is in another stack, or imported. |
| `--max-tasks` out of range | Outside `1`-`83`. |
| Network creation failed | Usually a leftover network is holding the subnet. |
| `--strict-overrides` refused the start | A service still uses an image from a registry. |
| Conflicting state flags | `--from-state` together with `--from-cfn-stack`. |

An explicit `--from-cfn-stack <name>` when the targets span several stacks is
also a conflict.

The [CLI Reference](cli-reference.md) has the exit-code table for every
command.

## Related

- [Image overrides for local ECS services](local-start-service-image-overrides.md):
  run a locally built image against the deployed stack's configuration
- [`cdkd local run-task`](local-run-task.md): run one task once, and the
  image, secret, volume and ordering rules each replica follows
- [`cdkd local start-alb`](local-start-alb.md): a local load balancer in front
  of these services
- [Local Execution](local-emulation.md): choosing a command, value
  resolution, and the flags every command shares
- [CLI Reference](cli-reference.md): every command and the full exit-code
  table
