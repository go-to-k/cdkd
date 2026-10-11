---
title: cdkd local run-task
description: "Run one ECS task definition from your CDK app on local Docker, with its secrets resolved, its containers started in DependsOn order and the ECS metadata endpoint available."
---

# cdkd local run-task

`cdkd local run-task <target>` starts every container of one ECS task
definition on your Docker host and streams their logs. It exits when the
task's essential container exits, with that container's exit code. It is the
ECS counterpart of [`cdkd local invoke`](local-invoke.md).

For a service that stays up and restarts its replicas, use
[`cdkd local start-service`](local-start-service.md).

## Run a task

Suppose `MyStack` has this task definition. Its image is built from a
`Dockerfile` in `app/`, and the server in it listens on port 8080:

```ts
import * as ecs from 'aws-cdk-lib/aws-ecs';

const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef');
taskDef.addContainer('web', {
  image: ecs.ContainerImage.fromAsset('app'),
  portMappings: [{ containerPort: 8080 }],
  environment: { LOG_LEVEL: 'debug' },
});
```

With Docker running, run the task by its construct path:

```bash
cdkd local run-task MyStack/TaskDef
```

cdkd builds the image, starts the container and streams its output with a
`[web]` prefix. It also publishes the container port on your machine, so you
can call the server from another terminal:

```bash
curl http://127.0.0.1:8080/
```

The command returns when the essential container exits. Press {kbd:ctrl+c} to
stop the task earlier; cdkd then removes its containers and network.

More invocations:

```bash
# override container variables
cdkd local run-task MyStack/TaskDef --env-vars overrides.json

# deployed values and secrets
cdkd local run-task MyStack/TaskDef --from-state

# containers run as the task role
cdkd local run-task MyStack/Worker --assume-task-role

# start and return; you clean up
cdkd local run-task MyStack/Worker --detach

# keep stopped containers to inspect
cdkd local run-task MyStack/Worker --keep-running
```

Docker is required. The first run also pulls the ECS metadata sidecar image,
`amazon/amazon-ecs-local-container-endpoints:latest-amd64`.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `<target>` | — | The `AWS::ECS::TaskDefinition` to run. Required. |
| `--assume-task-role [arn]` | off | Give the containers the task role's credentials, or those of the ARN you pass. See [AWS credentials in containers](#aws-credentials-in-containers). |
| `--detach` | off | Start the containers and exit. No log streaming and no teardown. |
| `--keep-running` | off | Leave the containers in place when the task exits. The network and sidecar are still removed. |
| `--cluster <name>` | `cdkd-local` | Cluster name the metadata endpoint reports, and the prefix of the Docker network name. |
| `--platform <platform>` | from `RuntimePlatform.CpuArchitecture` | Force `linux/amd64` or `linux/arm64`. |
| `--no-pull` | off | Skip `docker pull` for every container image and the sidecar. |
| `--ecr-role-arn <arn>` | — | Role to assume before authenticating to ECR, for another account's registry. No effect with `--no-pull`. |

The command also accepts every
[common flag](local-emulation.md#common-flags). Three of them behave in a
way specific to this command:

- `--env-vars` is keyed by container name.
- `--container-host` is the IP that published ports bind to.
- `--profile` credentials are passed to the containers.

This command spells the role flag `--assume-task-role` only. `start-service`
and `start-alb` also accept `--assume-role`.

## Target resolution

`<target>` names the task definition. You can write it in three ways:

```bash
# CDK display path
cdkd local run-task MyStack/MyService/TaskDef

# stack name, a colon, the logical ID
cdkd local run-task MyStack:MyServiceTaskDefXYZ1234

# bare name, single-stack app only
cdkd local run-task TaskDef
```

A path prefix is enough: `MyStack/MyService/TaskDef` finds the resource at
`MyStack/MyService/TaskDef/Resource`. See
[Naming the target](local-emulation.md#naming-the-target).

## Networking

Each run creates one Docker network for the task. The task's containers and
the ECS metadata sidecar join it, and the containers' ports are published on
your machine.

```text diagram=local-run-task-network
              Your machine
          127.0.0.1:<hostPort>
            │              │   published ports
            ▼              ▼
   ┌────────────────┐  ┌────────────────┐
   │ Task container │  │ Sibling        │   each reachable by its
   │                │  │ container      │   container name
   └───────┬────────┘  └───────┬────────┘
           │ metadata,         │
           ▼ credentials       ▼
   ┌─────────────────────────────────────┐
   │ ECS metadata sidecar  169.254.170.2 │
   └─────────────────────────────────────┘
   network cdkd-local-task-<random>, subnet 169.254.170.0/24
```

Inside the network:

- **Container to container.** Each container reaches the others by their
  `ContainerDefinitions[].Name`.
- **Task metadata.** Every container has
  `ECS_CONTAINER_METADATA_URI_V4=http://169.254.170.2/v4/<container-name>`
  set, as on ECS.
- **Credentials.** With `--assume-task-role`, every container also has
  `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/role/<task-role-arn>` set.
- **Your machine.** A container reaches it as
  [`host.docker.internal`](local-emulation.md#reaching-a-server-on-the-host),
  where the Docker daemon supports that name.

The network is named `cdkd-local-task-<random>`, or
`<cluster>-task-<random>` when you pass `--cluster`. Its subnet is always
`169.254.170.0/24`.

### Reaching a container from the host

cdkd publishes every `PortMappings` entry on `--container-host`, which is
`127.0.0.1` by default. The host port is the entry's `HostPort` when it has
one, and the container port otherwise. A task with container port `8080`
therefore answers at `127.0.0.1:8080` once its container is up.

### Networking edge cases

**Two tasks at once.** The subnet is fixed, so only one `run-task` can run at
a time. A second one fails at `docker network create` with a message naming
the subnet in use. `start-service` shares one network across all the services
in a run, so it is not affected.

**`awsvpc` network mode.** The task gets a Docker bridge network, and cdkd
prints a warning. There is no network interface per task, and security groups
are not enforced.

**A host port below 1024.** `docker run` fails, because publishing a port
below 1024 needs root and Docker Desktop on macOS refuses it. This command
has no flag to move the port. Run the server on an unprivileged port, or use
[`cdkd local start-service`](local-start-service.md), which remaps privileged
ports and accepts `--host-port`.

## AWS credentials in containers

Containers get their AWS credentials from the metadata sidecar, as tasks do
on ECS. Which credentials the sidecar hands out depends on the flags:

```bash
# your default credential chain
cdkd local run-task MyStack/Worker

# the task definition's TaskRoleArn
cdkd local run-task MyStack/Worker --assume-task-role
cdkd local run-task MyStack/Worker \
  --assume-task-role arn:aws:iam::123456789012:role/WorkerRole

# the dev profile's credentials
cdkd local run-task MyStack/Worker --profile dev
```

- With no flag, the containers get whatever the default credential chain
  resolves on your machine.
- `--assume-task-role` assumes the role once at startup and gives the
  containers its temporary credentials. Use it to see IAM errors locally.
- `--profile <name>` gives the containers the profile's credentials. They
  come from the sidecar, and also from a read-only credentials file mounted
  in every container, where they are stored under `[<name>]`.

When you pass both, `--assume-task-role` wins over `--profile`.

### Credential edge cases

**A `TaskRoleArn` cdkd cannot resolve.** The bare `--assume-task-role` needs
a `TaskRoleArn` that is a literal ARN or a reference to an `AWS::IAM::Role`
in the same stack. cdkd turns the reference into
`arn:aws:iam::<account>:role/<RoleLogicalId>`, using your account ID. For any
other shape the command stops with an error telling you to pass the ARN.

**The `--profile` credentials file.** cdkd writes the file to a temporary
directory with mode `0600` and removes it when the run ends. Under `--detach`
the file stays, because the containers still mount it. cdkd prints its path
so that you can delete it once the containers are gone.

## Images

cdkd gets each container's image in one of three ways, depending on where
the image lives:

| Image | How cdkd gets it |
| --- | --- |
| A public image (`public.ecr.aws/...`, `docker.io/...`, `nginx:latest`) | `docker pull`, skipped by `--no-pull`. |
| A private ECR image | `docker login` to that registry, then `docker pull`. |
| A CDK asset (`ContainerImage.fromAsset`, `DockerImageAsset`) | `docker build` from the cloud assembly, tagged `cdkd-local-run-task-<asset-hash>`. |

An ECR pull from another region works without extra flags. A pull from
another account uses your own credentials, which works when the repository
policy grants you access. When it does not, pass `--ecr-role-arn <arn>` to
assume a role in the target account.

An image from `ContainerImage.fromEcrRepository(repo)`, where `repo` is in
the same stack, needs `--from-state` or `--from-cfn-stack` so that cdkd can
find the deployed repository's name.
[Images in cdkd local run-task](local-run-task-images.md) covers that case,
which registry hosts count as ECR, and how an asset image is recognized.

## Environment variables and secrets

In a CDK app, a container's `Environment` values and `Secrets` are usually
references: `table.tableName` is a `Ref`, and
`ecs.Secret.fromSecretsManager(secret)` is a `Ref` to the secret's ARN.
Without a state flag cdkd cannot resolve them, so the container sees an empty
variable or a missing secret. Pass the flag that matches how the stack was
deployed:

```bash
# deployed with cdkd deploy
cdkd local run-task MyStack/TaskDef --from-state

# deployed with the AWS CDK CLI
cdkd local run-task MyStack/TaskDef --from-cfn-stack
```

[Where values come from](local-emulation.md#where-values-come-from) explains
the flags. On this command they resolve the following:

| Reference | Result |
| --- | --- |
| `Ref`, `Fn::Sub`, `Fn::Join`, pseudo parameters | Resolved under either flag. |
| `Fn::GetAtt` | Resolved under `--from-state`. Dropped with a warning under `--from-cfn-stack`. |
| `Fn::ImportValue`, `Fn::GetStackOutput` | Resolved from the active state source. With neither flag, a warning names both. |
| `{{resolve:...}}` in `Environment` | Looked up before any container starts. |
| `{{resolve:...}}` in `Command`, `EntryPoint` or a health-check command | Refused. Move it to `Environment` or `Secrets`. |

When cdkd cannot resolve a value, it drops the value, prints a warning that
names it, and continues the run.

### Secrets

Once the references are resolved, cdkd fetches each `Secrets` entry from
Secrets Manager or SSM at startup and sets it as an environment variable in
the container. A secret that cannot be fetched stops the run, with an error
naming the container and the secret.

[Secrets in cdkd local run-task](local-run-task-secrets.md) lists the
`ValueFrom` forms cdkd accepts and the secret names it refuses to forward.

## Container start ordering

cdkd starts containers in `DependsOn` order. Containers with no dependency
between them start in template order. A dependency cycle is an error that
names the cycle.

Before cdkd starts a container, it waits for each of the container's
dependencies to reach the declared `Condition`:

| `Condition` | cdkd waits until the dependency |
| --- | --- |
| `START` | Has been started. |
| `COMPLETE` | Has exited, with any code. |
| `SUCCESS` | Has exited `0`. A non-zero exit is an error naming both containers. |
| `HEALTHY` | Reports `healthy` from its health check. Polled every second, for at most five minutes. |

## Volumes

cdkd maps each `Volumes[]` entry of the task definition to a Docker mount:

| `Volumes[]` entry | Locally |
| --- | --- |
| `Host: { SourcePath: '/some/path' }` | A bind mount of that host path. |
| `Host` with no `SourcePath` | An anonymous Docker volume, empty for each run. |
| `DockerVolumeConfiguration` | A Docker volume created with its `Driver` and `DriverOpts`. |
| `EFSVolumeConfiguration` | Error. |
| `FSxWindowsFileServerVolumeConfiguration` | Error. |

Three details:

- You create the host path of a bind mount yourself. cdkd warns when it is
  missing.
- A `DockerVolumeConfiguration` volume scoped to the `task` is removed when
  the task exits.
- In place of an EFS volume, bind-mount a local directory at the same
  container path.

A `SourcePath` that is an `Fn::Sub` or `Fn::Join` is resolved like an
environment value.

## Lifecycle and teardown

One container drives the task: the first container marked essential. When no
container sets `essential: false`, that is the first container in the
template. The task ends when that container exits:

1. The essential container exits.
2. cdkd stops the other containers, giving them a ten-second grace period,
   and removes them.
3. cdkd removes the sidecar and the network.
4. cdkd exits with the essential container's exit code.

{kbd:ctrl+c} runs the same teardown, including for anything still being
created. A second {kbd:ctrl+c} exits `130` at once and skips the remaining
cleanup. See [Stopping a server](local-emulation.md#stopping-a-server).

### `--detach` and `--keep-running`

Two flags change the teardown.

`--detach` makes cdkd exit as soon as the containers are started. Nothing is
torn down. cdkd prints the network name, and you find the containers with
`docker ps --filter network=<name>` and remove them yourself.

`--keep-running` skips step 2: the other containers are neither stopped nor
removed, so you can `docker exec` into them. The network and the sidecar are
still removed.

## Limitations

| Not emulated | What to do |
| --- | --- |
| `AWS::ECS::Service`, `DesiredCount`, `LaunchType` | Use [`cdkd local start-service`](local-start-service.md). |
| Load-balancer target groups and listener rules | Use [`cdkd local start-alb`](local-start-alb.md). |
| Service Connect and Cloud Map discovery | Use [`cdkd local start-service`](local-start-service.md) with several services. |
| Auto Scaling and deployment strategy | Not meaningful for one local task. |
| Fargate and EC2 launch-type differences (PID namespace, `awsvpc`-only rules, the ephemeral-storage cap) | Local Docker cannot enforce them. |
| A network interface per task and security groups under `awsvpc` | Check security-group behaviour against a real deploy. |
| EFS and FSx volumes | Bind-mount a local directory at the same container path. |
| ECS Exec | Use `docker exec`. |
| The `awslogs` log driver | Not needed. Output is already streamed to your terminal. |
| The X-Ray sidecar's AWS-API mocking | Run the daemon yourself. |
| App Mesh and Envoy | Not meaningful locally. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The essential container exited `0`, or `--detach` started the containers and returned. |
| `1` | The essential container exited `1`, or cdkd failed: Docker unavailable, target not found, network creation failed, a secret could not be fetched, an unsupported volume type. |
| `130` | {kbd:ctrl+c}. |
| `N` | Any other code the essential container exited with. |

Exit code `1` can mean either a container failure or a cdkd failure. Read the
error line to tell them apart. The full cross-command table is in
[Exit codes](cli-reference-exit-codes.md).

## In this section

- [Images in cdkd local run-task](local-run-task-images.md): images that
  reference the stack, which registry hosts are treated as ECR, and which
  images are built as CDK assets
- [Secrets in cdkd local run-task](local-run-task-secrets.md): the
  `ValueFrom` forms, how a secret reaches the container, and the secret names
  that are not forwarded

## Related

- [`cdkd local start-service`](local-start-service.md): keep `DesiredCount`
  replicas of an ECS service running
- [`cdkd local start-alb`](local-start-alb.md): put a local load balancer in
  front of those services
- [`cdkd local invoke`](local-invoke.md): the Lambda equivalent
- [Local Execution](local-emulation.md): choosing a command, value
  resolution, and the flags every command shares
- [CLI Reference](cli-reference.md): every cdkd command
