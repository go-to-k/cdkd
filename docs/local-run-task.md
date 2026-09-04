---
title: cdkd local run-task
description: "Run one ECS task definition locally on a Docker network with the ECS metadata sidecar, secrets resolution, and DependsOn container ordering."
---

# cdkd local run-task

`cdkd local run-task <target>` takes an `AWS::ECS::TaskDefinition` out of a CDK
app and starts every one of its containers on your Docker host — no AWS deploy
required. It is the ECS counterpart of [`cdkd local invoke`](local-invoke.md):
one synchronous task run, each container's stdout/stderr streamed with a
`[<name>]` prefix, and the essential container's exit code propagated to your
shell. For a service that stays up and restarts its replicas instead, use
[`cdkd local start-service`](local-start-service.md).

```bash
cdkd local run-task MyStack/MyService/TaskDef              # run one task definition
cdkd local run-task MyTaskDef --env-vars overrides.json    # SAM-shape env-var overrides
cdkd local run-task MyStack:MyTaskDefABC123 --from-state   # resolve intrinsics from deployed state
cdkd local run-task MyStack/Worker --assume-task-role      # containers run with the task role
cdkd local run-task MyStack/Worker --detach                # start and return; you own teardown
cdkd local run-task MyStack/Worker --keep-running          # leave stopped containers for a post-mortem
```

Docker is required. The first run pulls the AWS-published
`amazon/amazon-ecs-local-container-endpoints:latest-amd64` metadata sidecar
alongside each container image; see
[Local Execution](local-emulation.md#requirements).

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `<target>` | — | CDK display path or stack-qualified logical id of the `AWS::ECS::TaskDefinition` to run. Required. |
| `--cluster <name>` | `cdkd-local` | Cluster name reported by the metadata endpoint, and the prefix of the per-task Docker network name. |
| `--env-vars <file>` | — | SAM-shape JSON env-var overrides, keyed by container name — see [Local Execution](local-emulation.md#common-flags). |
| `--container-host <ip>` | `127.0.0.1` | Host IP that published container ports bind to. Must be numeric — see [Local Execution](local-emulation.md#common-flags). |
| `--assume-task-role [arn]` | off | Assume the task definition's `TaskRoleArn` (or the ARN you pass) and serve those credentials through the metadata sidecar. This command accepts only this spelling — its siblings also take `--assume-role`. |
| `--no-pull` | off | Skip `docker pull` for every container image and for the metadata sidecar — see [Local Execution](local-emulation.md#common-flags). |
| `--ecr-role-arn <arn>` | — | Role to assume before authenticating to ECR, for cross-account or centralized registries. No-op with `--no-pull`. |
| `--platform <platform>` | inferred from `RuntimePlatform.CpuArchitecture` | Force `docker run --platform`. Accepts `linux/amd64` or `linux/arm64`. |
| `--keep-running` | off | Leave the user containers in place when the task exits; the network and sidecar are still torn down. |
| `--detach` | off | Start the containers in the background and exit, skipping log streaming and automatic teardown. |
| `--from-state` | off | Substitute deployed values from cdkd's S3 state into image URIs, environment variables and secrets — see [Local Execution](local-emulation.md#common-flags). |
| `--from-cfn-stack [name]` | off | Substitute from a CloudFormation-deployed stack instead. Bare form uses the cdkd stack name. Mutually exclusive with `--from-state`. |
| `--stack-region <region>` | — | Region of the state record to read, and the CloudFormation client region for `--from-cfn-stack` — see [Local Execution](local-emulation.md#common-flags). |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json`, then `cdkd-state-{accountId}` | S3 bucket holding cdkd state, for `--from-state`. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `-a`, `--app <command>` | `cdk.json` / `CDKD_APP` | CDK app command, or a path to a pre-synthesized cloud assembly — see [Local Execution](local-emulation.md#common-flags). |
| `--output <path>` | `cdk.out` | Output directory for synthesis. |
| `-c`, `--context <key=value...>` | — | Set CDK context values. Repeatable. |
| `--profile <profile>` | — | AWS profile. Its credentials are forwarded to the sidecar and to the containers. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for cdkd's own AWS API calls. Needs admin-equivalent permissions. |
| `-y`, `--yes` | off | Answer interactive prompts with the recommended response. |
| `--verbose` | off | Verbose logging. |

The region used for AWS API calls and for pseudo-parameter substitution is taken
from `AWS_REGION`, then `AWS_DEFAULT_REGION`, then the synthesized stack's own
`env.region`. A deprecated `--region` flag still overrides all three; prefer the
environment variable or your AWS profile.

## Target resolution

`<target>` accepts the same forms as [`cdkd local invoke`](local-invoke.md):

| Form | Example |
| --- | --- |
| CDK display path (preferred) | `MyStack/MyService/TaskDef` |
| Stack-qualified logical id | `MyStack:MyServiceTaskDefXYZ1234` |
| Bare name, single-stack apps only | `MyTaskDef` |

Path matching is prefix-based, so an L2 path such as `MyStack/MyService/TaskDef`
resolves to the synthesized L1 child `MyStack/MyService/TaskDef/Resource`.

## Networking model

Each task run creates its own Docker network and sidecar:

1. A fresh network `cdkd-local-task-<random>` (or `<--cluster>-task-<random>`)
   with subnet `169.254.170.0/24`.
2. The AWS-published `amazon/amazon-ecs-local-container-endpoints:latest-amd64`
   sidecar on that network at the well-known address `169.254.170.2`.
3. Every user container on the same network with
   `--network-alias <container-name>`, so siblings resolve each other by their
   `ContainerDefinitions[].Name`.
4. Per-container environment:
   `ECS_CONTAINER_METADATA_URI_V4=http://169.254.170.2/v4/<container-name>`, plus
   `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/role/<task-role-arn>` when
   `--assume-task-role` is in play.

The subnet is fixed, so only one `cdkd local run-task` can be active at a time:
a second concurrent run fails on `docker network create` with a hint naming the
subnet already in use. [`cdkd local start-service`](local-start-service.md)
shares one network across every service in a run, and so is not affected.

Containers also get a `host.docker.internal` mapping where the Docker daemon
supports one, so a container can reach a server bound to your host (a local
endpoint, a tunnelled VPC resource). On a daemon that does not support it, no
mapping is added and the run continues.

`awsvpc` network mode is mapped to a Docker bridge network with a warning:
Docker cannot emulate an ENI per task, and security groups are not enforced
locally. AWS SDK calls from inside a container still reach the public AWS
endpoints over your own network.

### Reaching a container from the host

Every `ContainerDefinitions[].PortMappings` entry is published on the host, at
the entry's `HostPort` when the template names one and at the container port
otherwise, bound to `--container-host` (`127.0.0.1` by default), and on the
mapping's own protocol. A task declaring TCP container port `8080` is reachable
at `127.0.0.1:8080` as soon as its container starts.

A **privileged host port** — anything the mapping would publish below 1024 —
fails at `docker run`, because a local publish there needs root and macOS Docker
Desktop refuses it outright. This command has neither a remap nor a flag to move
it: run the container's service on an unprivileged port, or use
[`cdkd local start-service`](local-start-service.md), which auto-remaps a
privileged port and lets `--host-port <containerPort=hostPort>` pin the result.

## AWS credentials in containers

| Situation | What the containers see |
| --- | --- |
| Neither `--assume-task-role` nor `--profile` | The sidecar serves whatever the default credential chain resolves on the host. |
| `--assume-task-role` (bare) | `sts:AssumeRole` against the task definition's resolved `TaskRoleArn`, once at startup; the temporary credentials are served by the sidecar. |
| `--assume-task-role <arn>` | Same, against the ARN you supplied. |
| `--profile <p>` without an effective `--assume-task-role` | Resolved through the SDK chain, then both served by the sidecar and written into a read-only credentials file mounted into every container under `[<p>]`. |

`--assume-task-role` beats the profile file, which beats the plain sidecar
pass-through. Bare `--assume-task-role` resolves a flat-string `TaskRoleArn`
directly; for a `{Ref: <Role>}` or `{Fn::GetAtt: [<Role>, 'Arn']}` pointing at a
same-stack `AWS::IAM::Role`, cdkd fills the caller's account id (from STS
`GetCallerIdentity`) into `arn:aws:iam::<account>:role/<RoleLogicalId>`. When the
task definition has no resolvable `TaskRoleArn`, bare `--assume-task-role` is an
error that tells you to pass the ARN explicitly.

## ECR image resolution

`ContainerDefinitions[].Image` is classified into three tiers:

| Tier | Image shape | How cdkd gets it |
| --- | --- | --- |
| Public | `public.ecr.aws/...`, `docker.io/...`, `nginx:latest` | Plain `docker pull` (skipped by `--no-pull`). |
| ECR | A flat-string ECR registry URI | STS identity check, ECR auth, then `docker pull`. |
| CDK asset | An image published by `ContainerImage.fromAsset` / `DockerImageAsset` | `cdk.out/<stack>.assets.json` lookup, then `docker build`, tagged `cdkd-local-run-task-<asset-hash>`. |

### Which registry hosts count as ECR

**Only the plain `<account>.dkr.ecr.<region>.<urlSuffix>` host pulls end to
end.** A FIPS or dual-stack ECR host is recognized as ECR, but the pull fails
with `no basic auth credentials`: ECR's `GetAuthorizationToken` issues its
credential against the plain host, the pull targets the host the template names,
and Docker's credential store is keyed on the hostname verbatim. Point the
template at the plain host to run the task locally.

The rest of this section is the recognition rule behind that. A URI is treated
as ECR only when its host suffix is the one its own region actually uses; a
look-alike host carrying another region's suffix is deliberately not treated as
ECR. Three endpoint shapes are recognized — the plain
`<account>.dkr.ecr.<region>.<urlSuffix>`, its FIPS sibling
`<account>.dkr.ecr-fips.<region>.<urlSuffix>`, and the dual-stack
`<account>.dkr-ecr[-fips].<region>.on.aws`, whose fixed `on.aws` suffix replaces
the region's partition suffix. A host spelled with the other family's suffix is
refused. Host matching is case-insensitive, since DNS is;
Docker accepts an upper-cased registry host but requires a lower-case repository
path, so cdkd folds only the host.

The same region-to-partition mapping drives `${AWS::Partition}` and
`${AWS::URLSuffix}` wherever cdkd substitutes them.

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

Cross-account and cross-region pulls are supported: cdkd builds the ECR client
for the URI's own region, and with `--ecr-role-arn <arn>` issues `sts:AssumeRole`
to obtain credentials in the target account. Without the flag it falls through to
your own credentials, which succeeds when a repository policy grants you direct
cross-account access.

### Which images count as CDK assets

An image URI is treated as a CDK asset when it embeds a container-assets ECR
repository — either the CDK bootstrap repository
`cdk-<qualifier>-container-assets-<acct>-<region>` (any qualifier, not only the
`hnb659fds` default) or the cdkd-owned `cdkd-container-assets-<acct>-<region>`
that `cdkd deploy` publishes into once a bootstrap marker exists. A migrated
stack's rewritten template and its `--from-state` state carry the latter, so both
classify identically.

Custom-named cdkd asset repositories (`cdkd bootstrap --container-repo <name>`)
are recognized under `--from-state`: cdkd lazily reads the region's bootstrap
marker from the state bucket and treats the image as a CDK asset when its
repository component matches the marker's `containerRepo`. Two caveats:

- The lookup is best-effort. A missing or unreadable marker falls back to the
  conventional prefix match, and without `--from-state` no marker is read at all.
- The host test on this path is narrower than the one above — it looks for a
  literal `.dkr.ecr.` substring — so it sees only the plain lower-case form.

A miss here is a slow path, not a wrong pull: the image simply routes through the
ECR-pull tier instead.

### Intrinsic-valued image URIs

When `Image` is an `Fn::Sub` or `Fn::GetAtt` — the shape
`ContainerImage.fromEcrRepository(repo)` synthesizes — two substitution passes run
before the resulting URI is classified:

| Pass | Resolves | Needs state? |
| --- | --- | --- |
| Pseudo parameters | `${AWS::AccountId}` from STS `GetCallerIdentity` (lazy, cached for the run); `${AWS::Region}` from the resolved region; `${AWS::Partition}` and `${AWS::URLSuffix}` derived from it | No |
| Same-stack ECR repository | `${<LogicalId>}` against an `AWS::ECR::Repository`, and `Fn::GetAtt: [<Repo>, 'Arn' \| 'RepositoryUri']`, using the deployed physical repository name | Yes — `--from-state` or `--from-cfn-stack` |

`${AWS::Partition}` and `${AWS::URLSuffix}` come from the region, per the table
in [Which registry hosts count as ECR](#which-registry-hosts-count-as-ecr).
With neither state flag, a same-stack repository reference fails with an error
naming them as the way forward; the stack must have been deployed first.

Under `--from-cfn-stack`, an `Fn::GetAtt` in a container's `Environment[].Value`
is dropped with a warning — a stack's resource listing carries no per-attribute
values. Image URIs are not affected: the repository ARN and URI are rebuilt from
the recovered physical name plus the pseudo parameters, so no per-attribute
lookup is needed.

## Environment variables and secrets

`ContainerDefinitions[].Environment[].Value` and `Secrets[].ValueFrom` are
routinely intrinsic-valued in real CDK ECS apps: `table.tableName` synthesizes as
`Ref`, `table.tableArn` as `Fn::GetAtt`,
`ecs.Secret.fromSecretsManager(secret)` as a `Ref` returning the deployed ARN,
`ecs.Secret.fromSsmParameter(p)` as an `Fn::Join` over pseudo parameters and a
`Ref`. Without a state source those intrinsics are dropped and the container sees
an empty variable or a missing secret.

### Intrinsic substitution

`--from-state` substitutes every intrinsic-valued entry against cdkd's deployed
S3 state plus the AWS pseudo parameters:

| Intrinsic | Source |
| --- | --- |
| `Ref: <LogicalId>` | The resource's recorded physical id |
| `Fn::GetAtt: [<LogicalId>, <Attr>]` | The attribute captured for that resource at deploy time |
| `Fn::Sub: '...${X}...${AWS::Region}...'` | Recursive substitution against state plus pseudo parameters |
| `Fn::Join: [<delim>, [<elements>]]` | Recursive substitution of every element, then joined |
| `Ref: AWS::AccountId` / `AWS::Region` / `AWS::Partition` / `AWS::URLSuffix` | STS `GetCallerIdentity` (lazy, cached), the resolved region, and the region-derived partition and URL suffix |

Substitution is best-effort per key. When a value cannot be produced — no state
for the referenced logical id, an attribute that was not captured at deploy time,
an unsupported intrinsic — that one entry is dropped and a warning names it on the
task's warnings line; the run itself continues. State-load failures (no record,
multi-region ambiguity without `--stack-region`, a bucket that cannot be
resolved) degrade the same way rather than failing the run.

Cross-stack `Fn::ImportValue` and `Fn::GetStackOutput` in environment variables
and secrets are resolved from the active state source in a second pass. With
neither `--from-state` nor `--from-cfn-stack`, a warning names both flags as the
way to substitute them.

Resolved `Secrets[].ValueFrom` strings then flow into the resolver below.

### Secrets Manager and SSM resolution

Every `Secrets[].ValueFrom` entry is resolved once at startup, after any
intrinsic substitution. Three shapes are accepted:

| `ValueFrom` | Call |
| --- | --- |
| `arn:aws:secretsmanager:<region>:<account>:secret:<name>` | `GetSecretValue` |
| `arn:aws:secretsmanager:<region>:<account>:secret:<name>:<json-key>::` | `GetSecretValue`, then JSON-parse and extract `<json-key>` |
| `arn:aws:ssm:<region>:<account>:parameter/<name>` | `GetParameter` with decryption |

A resolution failure — not found, access denied, a network error, a malformed ARN
— is a hard error naming the offending container and secret. Explicit failure
beats a silently empty variable: fix the credentials or the IAM policy and re-run.

### Secret names that are not forwarded

An accepted secret's value reaches the container through the `docker run` spawn
environment as a value-less `-e KEY` flag, so the plaintext never appears in the
process arguments. The secret's **name** decides whether it is forwarded at all.
Two name shapes are dropped entirely — no `-e` flag and no spawn-environment
entry:

- **A name that collides with a variable the Docker CLI itself reads**, matched
  case-insensitively. The set covers connection and TLS settings, behaviour
  toggles, `PATH` / `PATHEXT` / `HOME` / `USERPROFILE`, the loader, trust and
  runtime variables, the SSH exec-helper variables, and the AWS credential-helper
  variables `docker-credential-ecr-login` reads, plus the `LD_`, `DYLD_` and
  `AWS_ENDPOINT_URL_` prefix families. Forwarding such a name would let a
  template-controlled secret name redirect the Docker client itself — a secret
  named `DOCKER_HOST` could point it at a different daemon.
- **A malformed name** — empty, or containing `=` or NUL. The `=` case is the
  dangerous one: the OS parses an environment entry's name as everything before
  the first `=`, so a secret named `PATH=/tmp/evil:` would land as `PATH`, a
  different variable than the collision check inspected.

Each refusal is reported as a warning naming the dropped secret, so the drop is
never silent. Rename the secret if the container needs its value.

## Container start ordering

Containers start in topological `DependsOn` order; siblings with no relation
start in template order. A cyclic `DependsOn` is a hard error at discovery that
names the cycle.

| Condition | What cdkd waits for |
| --- | --- |
| `START` | The dependency's `docker run` has returned. |
| `COMPLETE` | The dependency's container has exited, with any code. |
| `SUCCESS` | The dependency's container has exited `0`. A non-zero exit is an error naming both containers. |
| `HEALTHY` | The dependency's `HEALTHCHECK` reports `healthy`, polled once a second and capped at five minutes. |

## Volumes

| `Volumes[]` shape | Local realization |
| --- | --- |
| `Host: { SourcePath: '/some/path' }` | A `docker run -v /some/path:<containerPath>` bind mount. The host path is yours to create; a missing path warns. |
| `Host` with no `SourcePath` | A Docker anonymous volume — empty per-task scratch space. |
| `DockerVolumeConfiguration: { Scope, Driver, DriverOpts }` | `docker volume create --driver <driver> --opt ...` per task. A `task`-scoped volume is torn down on exit. |
| `EFSVolumeConfiguration` | Hard error. Bind-mount a local directory at the same container path instead. |
| `FSxWindowsFileServerVolumeConfiguration` | Hard error. |

`Host.SourcePath` may itself be an intrinsic (`Fn::Sub` / `Fn::Join`); it is
resolved through the same substitution passes as environment variables.

## Lifecycle and teardown

A normal run:

1. The first `essential: true` container drives the task. When no container
   declares `essential: false`, that is the first container in the template.
2. When the essential container exits, every other container is `docker stop`ped
   with a ten-second grace period, then `docker rm -f`ed.
3. The metadata sidecar is removed and the Docker network is deleted.
4. cdkd exits with the essential container's exit code.

`^C` runs the same teardown. A second `^C` exits `130` immediately, skipping
container cleanup.

| Flag | Steps skipped |
| --- | --- |
| `--detach` | 1, 2 and 4. The sidecar and user containers stay up for you to manage; cdkd prints the network name so you can `docker ps --filter network=<name>` to inspect it. |
| `--keep-running` | 2 only. The network and sidecar are still torn down, leaving the stopped containers for a `docker exec` post-mortem. |

## Limitations

| Not emulated | What to do instead |
| --- | --- |
| `AWS::ECS::Service`, `DesiredCount`, `LaunchType` | Use [`cdkd local start-service`](local-start-service.md). |
| Load-balancer target-group registration and listener rules | Use [`cdkd local start-alb`](local-start-alb.md) for a local front door. |
| Service Connect / Cloud Map discovery | `run-task` is single-task by design; cross-service discovery lives in [`cdkd local start-service`](local-start-service.md). |
| Auto Scaling and deployment strategy | Not meaningful for a single local task. |
| Fargate vs EC2 launch-type differences — PID namespace, `awsvpc`-only constraints, the ephemeral-storage cap | Local Docker cannot enforce them. |
| `awsvpc` ENI-per-task fidelity, including security groups | Mapped to a Docker bridge network with a warning. Verify security-group behaviour against a real deploy. |
| EFS and FSx volumes | Hard error; bind-mount a local directory at the same container path. |
| ECS Exec | Use `docker exec` directly. |
| CloudWatch Logs shipping via the `awslogs` log driver | stdout and stderr are already streamed, so the driver is skipped. |
| The X-Ray sidecar's AWS-API mocking | Run the daemon yourself if you need it. |
| App Mesh / Envoy fidelity | Not meaningful locally. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The essential container exited `0`, or `--detach` started the containers and returned. |
| `1` | Either the essential container exited `1`, or cdkd itself failed — Docker unavailable, target not found, network creation failed, secret resolution failed, an unsupported volume type. |
| `130` | `^C`. A first `^C` tears the task down and then exits; a second exits immediately without container cleanup. |
| `N` | Any other code the essential container exited with; cdkd propagates it verbatim. |

`1` is the one ambiguous code: it is both a container's own exit status and
cdkd's default for any failure of its own. Read the error line to tell them
apart.

The full cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd local start-service`](local-start-service.md) — the long-running counterpart, running `DesiredCount` replicas of an ECS Service
- [`cdkd local start-alb`](local-start-alb.md) — put a local Application Load Balancer in front of those services
- [`cdkd local invoke`](local-invoke.md) — the Lambda equivalent, sharing the target syntax and `--env-vars` shape
- [Local Execution](local-emulation.md) — the subcommand index, Docker requirements, and the flags common to every `cdkd local` command
- [CLI Reference](cli-reference.md) — every cdkd command, the output-stream contract, and the full exit-code table
