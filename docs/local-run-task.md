---
title: cdkd local run-task
description: "Run one ECS task definition from your CDK app on local Docker, with its secrets resolved, its containers started in DependsOn order and the ECS metadata endpoint available."
---

# cdkd local run-task

`cdkd local run-task <target>` starts every container of one ECS task
definition on your Docker host, streams their logs, and exits with the
essential container's exit code. It is the ECS counterpart of
[`cdkd local invoke`](local-invoke.md).

For a service that stays up and restarts its replicas, use
[`cdkd local start-service`](local-start-service.md).

## Run a task

Given this task definition in `MyStack`, built from a `Dockerfile` in `app/`
whose server listens on port 8080:

```ts
import * as ecs from 'aws-cdk-lib/aws-ecs';

const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef');
taskDef.addContainer('web', {
  image: ecs.ContainerImage.fromAsset('app'),
  portMappings: [{ containerPort: 8080 }],
  environment: { LOG_LEVEL: 'debug' },
});
```

run it by its construct path:

```bash
cdkd local run-task MyStack/TaskDef
```

cdkd builds the image, starts the container and streams its output with a
`[web]` prefix. The container port is published on your machine, so from
another terminal:

```bash
curl http://127.0.0.1:8080/
```

The command returns when the essential container exits. {kbd:ctrl+c} stops the
task and removes its containers and network.

More invocations:

```bash
cdkd local run-task MyStack/TaskDef --env-vars overrides.json   # override container variables
cdkd local run-task MyStack/TaskDef --from-state                # deployed values and secrets
cdkd local run-task MyStack/Worker --assume-task-role           # containers run as the task role
cdkd local run-task MyStack/Worker --detach                     # start and return; you clean up
cdkd local run-task MyStack/Worker --keep-running               # keep stopped containers to inspect
```

Docker is required. The first run also pulls the ECS metadata sidecar,
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

It also accepts every [common flag](local-emulation.md#common-flags). On this
command `--env-vars` is keyed by container name, `--container-host` is the IP
published ports bind to, and `--profile` credentials are passed to the
containers.

This command spells the role flag `--assume-task-role` only. `start-service`
and `start-alb` also accept `--assume-role`.

## Target resolution

| Form | Example |
| --- | --- |
| CDK display path | `MyStack/MyService/TaskDef` |
| Stack-qualified logical ID | `MyStack:MyServiceTaskDefXYZ1234` |
| Bare name, single-stack apps only | `TaskDef` |

A path prefix is enough: `MyStack/MyService/TaskDef` finds the resource at
`MyStack/MyService/TaskDef/Resource`. See
[Naming the target](local-emulation.md#naming-the-target).

## Networking

Each run creates one Docker network for the task:

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

| What | Detail |
| --- | --- |
| Network | `cdkd-local-task-<random>`, or `<--cluster>-task-<random>`, on subnet `169.254.170.0/24`. |
| Between containers | Each container is reachable by its `ContainerDefinitions[].Name`. |
| Metadata | `ECS_CONTAINER_METADATA_URI_V4=http://169.254.170.2/v4/<container-name>` is set in every container. |
| Credentials | With `--assume-task-role`, `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/role/<task-role-arn>` is also set. |
| Your machine | Reachable as [`host.docker.internal`](local-emulation.md#reaching-a-server-on-the-host) where the daemon supports it. |

The subnet is fixed, so only one `run-task` can run at a time. A second one
fails at `docker network create` with a message naming the subnet in use.
`start-service` shares one network across all the services in a run and is
not affected.

`awsvpc` network mode becomes a Docker bridge network, with a warning. There is
no network interface per task and security groups are not enforced.

### Reaching a container from the host

Every `PortMappings` entry is published on `--container-host` (`127.0.0.1` by
default), on the entry's `HostPort` when it has one and on the container port
otherwise. A task with container port `8080` answers at `127.0.0.1:8080` once
its container is up.

A host port below 1024 fails at `docker run`: publishing there needs root, and
Docker Desktop on macOS refuses it. This command has no flag to move the port.
Run the server on an unprivileged port, or use
[`cdkd local start-service`](local-start-service.md), which remaps privileged
ports and accepts `--host-port`.

## AWS credentials in containers

Containers get their credentials from the metadata sidecar, as tasks do on
ECS.

| You pass | The containers get |
| --- | --- |
| Nothing | Whatever the default credential chain resolves on your machine. |
| `--assume-task-role` | Temporary credentials for the task definition's `TaskRoleArn`, assumed once at startup. |
| `--assume-task-role <arn>` | Temporary credentials for that role. |
| `--profile <p>` | The profile's credentials, from the sidecar and from a read-only credentials file mounted in every container under `[<p>]`. |

`--assume-task-role` wins over `--profile`.

The bare form needs a `TaskRoleArn` it can resolve: a literal ARN, or a
reference to an `AWS::IAM::Role` in the same stack, which cdkd turns into
`arn:aws:iam::<account>:role/<RoleLogicalId>` using your account ID. Otherwise
it is an error telling you to pass the ARN.

The `--profile` credentials file is in a temporary directory, mode `0600`, and
is removed when the run ends. Under `--detach` it stays, because the
containers still mount it. cdkd prints its path so you can delete it when the
containers are gone.

## Images

Each container's `Image` is fetched according to where it lives:

| Image | How cdkd gets it |
| --- | --- |
| A public image (`public.ecr.aws/...`, `docker.io/...`, `nginx:latest`) | `docker pull`, skipped by `--no-pull`. |
| A private ECR image | `docker login` to that registry, then `docker pull`. |
| A CDK asset (`ContainerImage.fromAsset`, `DockerImageAsset`) | `docker build` from the cloud assembly, tagged `cdkd-local-run-task-<asset-hash>`. |

ECR pulls work across regions. Across accounts, cdkd uses your own
credentials, which works when the repository policy grants you access;
otherwise pass `--ecr-role-arn <arn>` to assume a role in the target account.

### Images that reference the stack

`ContainerImage.fromEcrRepository(repo)` synthesizes an `Fn::Sub` or
`Fn::GetAtt`, which cdkd resolves before fetching the image:

| Part of the image URI | Resolved from | Needs a state flag |
| --- | --- | --- |
| `${AWS::AccountId}`, `${AWS::Region}`, `${AWS::Partition}`, `${AWS::URLSuffix}` | STS and the region | No |
| A same-stack `AWS::ECR::Repository` (`${<LogicalId>}`, or `Fn::GetAtt` of `Arn` \| `RepositoryUri`) | The deployed repository name | Yes: `--from-state` or `--from-cfn-stack` |

Without a state flag, a same-stack repository reference fails with an error
naming the two flags. The stack must have been deployed first.

### Which registry hosts are treated as ECR

cdkd logs in to the exact host the image names, so FIPS, dual-stack and
cross-account images authenticate on their own endpoint.

| Host shape | Recognized |
| --- | --- |
| `<account>.dkr.ecr.<region>.<urlSuffix>` | Yes |
| `<account>.dkr.ecr-fips.<region>.<urlSuffix>` | In commercial and GovCloud regions |
| `<account>.dkr-ecr[-fips].<region>.on.aws` (dual-stack) | In commercial and GovCloud regions |
| A host whose suffix belongs to another region's partition | No |
| A region prefix cdkd does not know yet | No. The image is pulled anonymously, and a debug line says the host looked like ECR. |

Letter case in the host is ignored. A non-ASCII character in the host is
refused.

The partition and URL suffix come from the region. The same mapping fills
`${AWS::Partition}` and `${AWS::URLSuffix}` everywhere cdkd substitutes them.

| Region prefix | Partition | URL suffix |
| --- | --- | --- |
| `us-gov-*` | `aws-us-gov` | `amazonaws.com` |
| `cn-*` | `aws-cn` | `amazonaws.com.cn` |
| `us-iso-*` | `aws-iso` | `c2s.ic.gov` |
| `us-isob-*` | `aws-iso-b` | `sc2s.sgov.gov` |
| `eu-isoe-*` | `aws-iso-e` | `cloud.adc-e.uk` |
| `us-isof-*` | `aws-iso-f` | `csp.hci.ic.gov` |
| `eusc-*` | `aws-eusc` | `amazonaws.eu` |
| everything else | `aws` | `amazonaws.com` |

### Which images are built as CDK assets

An image is built locally when its URI names a container-assets repository:

| Repository | Recognized |
| --- | --- |
| `cdk-<qualifier>-container-assets-<acct>-<region>`, any qualifier | Always |
| `cdkd-container-assets-<acct>-<region>` | Always |
| A custom name from `cdkd bootstrap --container-repo <name>` | Under `--from-state`, when the region's bootstrap marker can be read |

An asset image that is not recognized is pulled from ECR instead, which is
slower and otherwise the same.

## Environment variables and secrets

Container `Environment` values and `Secrets[].ValueFrom` are usually
references in a CDK app: `table.tableName` is a `Ref`, and
`ecs.Secret.fromSecretsManager(secret)` is a `Ref` to the secret's ARN. They
are resolved as
[Where values come from](local-emulation.md#where-values-come-from) describes.
Without a state flag the container sees an empty variable or a missing secret.

```bash
cdkd local run-task MyStack/TaskDef --from-state       # deployed with cdkd deploy
cdkd local run-task MyStack/TaskDef --from-cfn-stack   # deployed with the AWS CDK CLI
```

| Reference | Result |
| --- | --- |
| `Ref`, `Fn::Sub`, `Fn::Join`, pseudo parameters | Resolved under either flag. |
| `Fn::GetAtt` | Resolved under `--from-state`. Dropped with a warning under `--from-cfn-stack`. |
| `Fn::ImportValue`, `Fn::GetStackOutput` | Resolved from the active state source. With neither flag, a warning names both. |
| `{{resolve:...}}` in `Environment` | Looked up before any container starts. |
| `{{resolve:...}}` in `Command`, `EntryPoint` or a health-check command | Refused. Move it to `Environment` or `Secrets`. |

A value that cannot be resolved is dropped, a warning names it, and the run
continues.

### Secrets Manager and SSM secrets

After substitution, each `Secrets[].ValueFrom` is fetched once at startup:

| `ValueFrom` | Call |
| --- | --- |
| `arn:aws:secretsmanager:<region>:<account>:secret:<name>` | `GetSecretValue` |
| `arn:aws:secretsmanager:<region>:<account>:secret:<name>:<json-key>::` | `GetSecretValue`, then the `<json-key>` field of the JSON value |
| `arn:aws:ssm:<region>:<account>:parameter/<name>` | `GetParameter` with decryption |

A secret that cannot be fetched stops the run, with an error naming the
container and the secret. Fix the credentials or the IAM policy and run again.

The value is passed to `docker run` through its environment, so it does not
appear on a command line. The exception is
[finch on macOS and Windows](local-emulation.md#finch-on-macos-and-windows),
where a task with secrets is refused.

### Secret names that are not forwarded

A secret is dropped, with a warning naming it, when its name would affect the
container client itself. Rename the secret if the container needs it.

- A name that is empty or contains `=` or NUL.
- A name, in any letter case, that the container client (Docker, podman,
  nerdctl, finch) or one of its credential helpers reads:

| Family | Examples |
| --- | --- |
| Docker connection, TLS and behaviour settings | `DOCKER_HOST`, `DOCKER_CONFIG`, `DOCKER_TLS_VERIFY` |
| Process, loader and trust variables | `PATH`, `HOME`, `GCONV_PATH`, `SSL_CERT_FILE`; the `LD_` / `DYLD_` prefixes |
| SSH helper variables | `SSH_AUTH_SOCK`, `SSH_ASKPASS` |
| AWS variables `docker-credential-ecr-login` reads | `AWS_PROFILE`, `AWS_ECR_CACHE_DIR`; the `AWS_ENDPOINT_URL_` prefix |
| gcloud variables `docker-credential-gcloud` reads | `GCE_METADATA_HOST`; the `CLOUDSDK_` prefix, except `CLOUDSDK_AUTH_ACCESS_TOKEN`, which is forwarded |
| Interpreter variables of a credential helper written in a scripting language | `SHELLOPTS`, `PS4`, `PYTHONPATH`, `PYTHONWARNINGS`, `BROWSER`, `REQUESTS_CA_BUNDLE`, `NODE_OPTIONS`, `RUBYOPT`, `PERL5OPT`, `OPENSSL_CONF`; the `BASH_FUNC_` prefix |
| podman connection and config files | `CONTAINER_HOST`, `CONTAINERS_CONF`, `REGISTRY_AUTH_FILE` |
| nerdctl connection, config and CNI | `CONTAINERD_ADDRESS`, `NERDCTL_TOML`, `CNI_PATH` |
| finch's Lima layer | `SSH` |
| Base directories the above fall back to | `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`; on Windows `APPDATA`, `PROGRAMDATA`, `PROGRAMFILES`, `LOCALAPPDATA` |

Forwarding such a name would let a template redirect the client. A secret
named `DOCKER_HOST`, for example, would point it at another daemon.

## Container start ordering

Containers start in `DependsOn` order. Containers with no dependency between
them start in template order. A dependency cycle is an error naming the cycle.

| `Condition` | cdkd waits until the dependency |
| --- | --- |
| `START` | Has been started. |
| `COMPLETE` | Has exited, with any code. |
| `SUCCESS` | Has exited `0`. A non-zero exit is an error naming both containers. |
| `HEALTHY` | Reports `healthy` from its health check. Polled every second, for at most five minutes. |

## Volumes

| `Volumes[]` entry | Locally |
| --- | --- |
| `Host: { SourcePath: '/some/path' }` | A bind mount of that host path. You create the path; a missing one warns. |
| `Host` with no `SourcePath` | An anonymous Docker volume, empty for each run. |
| `DockerVolumeConfiguration` | A Docker volume created with its `Driver` and `DriverOpts`. A `task`-scoped one is removed on exit. |
| `EFSVolumeConfiguration` | Error. Bind-mount a local directory at the same container path. |
| `FSxWindowsFileServerVolumeConfiguration` | Error. |

A `SourcePath` that is an `Fn::Sub` or `Fn::Join` is resolved like an
environment value.

## Lifecycle and teardown

The first container marked essential drives the task. When no container sets
`essential: false`, that is the first container in the template.

1. The essential container exits.
2. The other containers are stopped with a ten-second grace period, then
   removed.
3. The sidecar and the network are removed.
4. cdkd exits with the essential container's exit code.

| Flag | Changes |
| --- | --- |
| `--detach` | cdkd exits once the containers are started and prints the network name. Find them with `docker ps --filter network=<name>`. Nothing is torn down. |
| `--keep-running` | The other containers are not stopped or removed in step 2, so you can `docker exec` into them. The network and sidecar are still removed. |

{kbd:ctrl+c} runs the same teardown, including anything still being created.
A second {kbd:ctrl+c} exits `130` at once and skips the remaining cleanup. See
[Stopping a server](local-emulation.md#stopping-a-server).

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

`1` can mean either a container failure or a cdkd failure. Read the error line
to tell them apart. The full cross-command table is in the
[CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd local start-service`](local-start-service.md): keep `DesiredCount`
  replicas of an ECS service running
- [`cdkd local start-alb`](local-start-alb.md): put a local load balancer in
  front of those services
- [`cdkd local invoke`](local-invoke.md): the Lambda equivalent
- [Local Execution](local-emulation.md): choosing a command, value
  resolution, and the flags every command shares
- [CLI Reference](cli-reference.md): every command and the full exit-code
  table
