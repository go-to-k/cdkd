---
title: local run-task
description: "Run one ECS task definition locally on a Docker network with the ECS metadata sidecar, secrets resolution, and DependsOn container ordering."
---

# `local run-task` (run an ECS task definition locally)

`cdkd local run-task <Stack/TaskDefinitionPath>` is the ECS counterpart
of `cdkd local invoke`. It takes an `AWS::ECS::TaskDefinition` defined
in a CDK app and starts every container on the developer's Docker host
— no AWS deploy needed.

Implementation Phase 1: synchronous run of one task, stream every
container's stdout/stderr with a `[<name>]` prefix, propagate the
essential container's exit code. Phase 2 (`cdkd local start-service` —
ECS Service replicas + restart policy) and Phase 3 (Service Connect /
Cloud Map cross-service discovery via `--add-host` DNS overlay) are
implemented; ALB-emulated path/host-based routing remains deferred.

**Requires Docker.** The first run pulls the AWS-published
`amazon/amazon-ecs-local-container-endpoints:latest-amd64` sidecar (a
small Go binary maintained by awslabs) plus each container's image.

### `local run-task` target resolution

Same target-syntax rules as `cdkd local invoke`:

- CDK display path (`MyStack/MyService/TaskDef`) — preferred
- Stack-qualified logical id (`MyStack:MyServiceTaskDefXYZ1234`)
- Single-stack apps may omit the stack prefix (`MyTaskDef`)

Path matching is prefix-based: an L2 path like `MyStack/MyService/TaskDef`
resolves to the synthesized L1 child (`MyStack/MyService/TaskDef/Resource`).

### `local run-task` options

| Flag | Default | Behavior |
| --- | --- | --- |
| `--cluster <name>` | `cdkd-local` | Surfaced as `ECS_CONTAINER_METADATA_URI_V4`'s `Cluster` field and used as the docker network prefix (`<name>-task-<rand>`). |
| `--env-vars <file>` | unset | SAM-shape JSON overlay. Top-level keys are container names; `Parameters` is a global overlay. Same shape as `cdkd local invoke --env-vars`. |
| `--container-host <ip>` | `127.0.0.1` | Bind IP for `PortMappings` published ports. Must be a numeric IP — Docker rejects hostnames in `-p <ip>:<port>:<port>`. |
| `--assume-task-role [<arn>]` | unset (host creds pass through) | Bare flag uses the task definition's `TaskRoleArn`. Resolves a flat-string ARN directly; for `{Ref: <Role>}` / `{Fn::GetAtt: [<Role>, 'Arn']}` against a same-stack `AWS::IAM::Role`, cdkd substitutes the caller's account id (via STS `GetCallerIdentity`) into `arn:aws:iam::<account>:role/<RoleLogicalId>`. Pass an explicit ARN to override. Either way, `sts:AssumeRole` runs once at startup; the resulting creds are exposed via the local metadata sidecar at `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`. |
| `--from-state` | off | Load cdkd S3 state for the target stack and substitute deployed values into (a) `Fn::Sub` / `Fn::GetAtt` ECR image URIs that reference a same-stack `AWS::ECR::Repository`, AND (b) intrinsic-valued `ContainerDefinitions[].Environment[].Value` + `Secrets[].ValueFrom` entries (`Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::Join`). Without this flag, env / secret intrinsics are dropped with a per-key warning (matching `cdkd local invoke --from-state` semantics). See "ECR image resolution" and "Env / Secrets substitution" below. Off by default. The stack must have been deployed via `cdkd deploy` first. |
| `--from-cfn-stack [cfn-stack-name]` | off | Read a deployed CloudFormation stack via `DescribeStackResources` and substitute `Ref` / `Fn::ImportValue` in container env vars / secrets / image URIs with the deployed physical IDs / exports. Use for CDK apps deployed via the upstream CDK CLI (`cdk deploy`). Bare form uses the cdkd stack name; pass an explicit value when the CFn stack name differs. **Mutually exclusive with `--from-state`**. `Fn::GetAtt` is warn-and-dropped in v1 (CFn `DescribeStackResources` does not return per-attribute values), except a same-stack ECR repository's `Arn` / `RepositoryUri` in a container image URI, which is synthesized from the recovered physical name + pseudo parameters. |
| `--stack-region <region>` | unset | Region of the state record to read. Used with `--from-state` when the same stack name has state in multiple regions, and with `--from-cfn-stack` as the CFn client region. |
| `--no-pull` | off | Skip `docker pull` for every container image and the metadata sidecar. |
| `--ecr-role-arn <arn>` | — | Role ARN to assume before authenticating against ECR for cross-account / centralized registry pulls. Issues `sts:AssumeRole` via the default credential chain and uses the resulting temp creds for `ecr:GetAuthorizationToken` + `docker pull` on every container whose `Image` resolves to an ECR registry host — the plain `<acct>.dkr.ecr.<region>.<urlSuffix>/...`, its FIPS sibling `<acct>.dkr.ecr-fips.<region>.<urlSuffix>/...`, or the dual-stack `<acct>.dkr-ecr[-fips].<region>.on.aws/...` (the partition suffix is derived from the region, so the partitions `derivePartitionAndUrlSuffix` knows — commercial, `aws-cn`, `aws-us-gov`, `aws-iso`, `aws-iso-b`, `aws-iso-e`, `aws-iso-f`, `aws-eusc` — are matched too). Required when the caller's identity does not already have cross-account access to the target repository. Same-account / same-region pulls do not need this flag. No-op when `--no-pull` is set. |
| `--platform <platform>` | inferred from `RuntimePlatform.CpuArchitecture` | `linux/amd64` or `linux/arm64`. Threaded into every container's `docker run --platform`. |
| `--keep-running` | off | Don't `docker rm -f` user containers on task exit (network + sidecar are still torn down). Use when you want to `docker exec` into a stopped container for post-mortems. |
| `--detach` | off | Start the containers and return without streaming logs or auto-tearing them down. Useful in CI smoke tests; caller manages container lifecycle. |

Plus the standard shared options: `-a/--app`, `-c/--context`, `--profile`,
`--role-arn`, `--region`, `--verbose`, `--output`.

### Networking model

For every task invocation cdkd:

1. Creates a fresh docker network `cdkd-local-task-<random>` (or
   `--cluster <name>-task-<random>`) with subnet `169.254.170.0/24`.
2. Starts the AWS-published
   `amazon/amazon-ecs-local-container-endpoints:latest-amd64` sidecar
   on the network at the well-known IP `169.254.170.2`.
3. Starts every user container on the same network with
   `--network-alias <container-name>` so siblings resolve each other by
   their CFn `ContainerDefinitions[].Name`.
4. Injects per-container env vars: `ECS_CONTAINER_METADATA_URI_V4=http://169.254.170.2/v4/<container-name>`
   and (when `--assume-task-role` is set) `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/role/<task-role-arn>`.

`awsvpc` network mode is mapped to `bridge` locally with a warn line —
docker cannot emulate ENI-per-task. AWS SDK calls from inside the
container still reach public AWS endpoints via the developer network.

### ECR image resolution

`ContainerDefinitions[].Image` is parsed in three tiers:

1. **Public images** — `public.ecr.aws/...`, `docker.io/...`, `nginx:latest`, etc. → plain `docker pull` (subject to `--no-pull`).
2. **Direct ECR URIs** — `<account>.dkr.ecr.<region>.<urlSuffix>/<repo>:<tag>` and the other served registry-host forms listed below (flat string, no intrinsics) → `pullEcrImage` (STS check + ECR auth + `docker pull`). The host suffix is matched against the one the URI's region actually uses — one suffix per region prefix: commercial and `us-gov-*` → `amazonaws.com`, `cn-*` → `amazonaws.com.cn`, `us-iso-*` → `c2s.ic.gov`, `us-isob-*` → `sc2s.sgov.gov`, `eu-isoe-*` → `cloud.adc-e.uk`, `us-isof-*` → `csp.hci.ic.gov`, `eusc-*` → `amazonaws.eu`. A look-alike host whose suffix does not belong to that region is deliberately NOT treated as ECR. The FIPS (`<account>.dkr.ecr-fips.<region>.<urlSuffix>`) and dual-stack (`<account>.dkr-ecr.<region>.on.aws`, `<account>.dkr-ecr-fips.<region>.on.aws`) registry endpoints are RECOGNIZED as ECR (the grammar is unified with `cdkd gc`'s — previously only the plain form matched here, so a genuine FIPS or dual-stack registry classified as a public image: anonymous pull, no `docker login`). The dual-stack forms carry the fixed `on.aws` suffix instead of the region's partition suffix, and a form spelled with the other's suffix is refused. **Recognition is not yet a working pull for those three forms**: `ecrLogin` authenticates against the PLAIN host (`<account>.dkr.ecr.<region>.<urlSuffix>`, which is what `GetAuthorizationToken` reports) while the pull targets the host the template names, and docker's credential store is keyed on the hostname verbatim — so the pull fails with `no basic auth credentials`. This is a known limitation; today only the plain form (in any casing) is end-to-end pull-capable. The case fold is unaffected, since an upper-cased plain host is reconciled to the same lower-case spelling on both sides. Every segment is matched case-INSENSITIVELY, since DNS is; docker accepts an upper-cased registry host but requires a lower-case repository path, and cdkd folds only the host. Cross-account / cross-region supported: cdkd builds the ECR client for the URI's region and (when `--ecr-role-arn <arn>` is passed) issues `sts:AssumeRole` to gain credentials in the target account. Without `--ecr-role-arn`, cdkd falls through to the caller's credentials (succeeds when an IAM resource policy grants the caller direct cross-account access).
3. **CDK-asset images** (`ContainerImage.fromAsset` / `DockerImageAsset`) → `cdk.out/<stack>.assets.json` lookup → `docker build` via the shared `src/assets/docker-build.ts` helper, tagged `cdkd-local-run-task-<asset-hash>`. An image URI is recognized as a CDK asset when it embeds a container-assets ECR repo — either the CDK-bootstrap repo `cdk-<qualifier>-container-assets-<acct>-<region>` (any qualifier, not only the `hnb659fds` default) or the cdkd-owned repo `cdkd-container-assets-<acct>-<region>` that `cdkd deploy` publishes into once a bootstrap marker exists; a migrated stack's rewritten template / `--from-state` state carries the latter, so both classify identically. Custom-named cdkd asset repos (`cdkd bootstrap --container-repo <name>`) are recognized too under `--from-state`: when a container's Image is an ECR-hosted URI whose repo component does not match the conventional shapes (recognized here by a THIRD, narrower host test than tier 2's — a literal `.dkr.ecr.` substring, so today it sees only the plain lower-case form and neither the FIPS / dual-stack endpoints nor a mixed-case host — a known limitation. A miss is a slow path, not a wrong pull: the image falls through to the tier-2 ECR-pull route), cdkd lazily reads the region's bootstrap marker from the state bucket and classifies the image as a CDK asset when its repo component equals the marker's `containerRepo` (best-effort — a missing/unreadable marker falls back to the prefix match, and without `--from-state` no marker read happens, so the image routes through the ECR-pull tier instead: correct, just slower).

For `Fn::Sub` / `Fn::GetAtt` shapes pointing at AWS pseudo parameters or a same-stack ECR repository (the typical `ContainerImage.fromEcrRepository(repo)` synthesis), two additional resolution tiers fire **before** the URI is fed to tier 2:

- **Tier 1 — AWS pseudo-parameter substitution (no state needed)**: `${AWS::AccountId}` → STS `GetCallerIdentity` (lazy, cached for the run); `${AWS::Region}` → `--region` / `AWS_REGION` / `AWS_DEFAULT_REGION`; `${AWS::Partition}` → derived from region (`cn-*` → `aws-cn`, `us-gov-*` → `aws-us-gov`, `us-iso-*` → `aws-iso`, `us-isob-*` → `aws-iso-b`, `us-isof-*` → `aws-iso-f`, `eu-isoe-*` → `aws-iso-e`, `eusc-*` → `aws-eusc`, else `aws`); `${AWS::URLSuffix}` → matches partition. Substituted URI then routes through tier 2.
- **Tier 2 — same-stack ECR Repository reference (state needed)**: when the `Fn::Sub` body contains `${<LogicalId>}` against an `AWS::ECR::Repository`, or when the template uses `Fn::GetAtt: [<Repo>, 'RepositoryUri']`, cdkd needs the deployed physical repo name. Pass `--from-state` (the stack must have been deployed via `cdkd deploy`); cdkd loads state, substitutes the physical name, then routes through tier 2. Without `--from-state` the error message points back at this flag as the resolution path.

### Env / Secrets substitution (`--from-state`)

`ContainerDefinitions[].Environment[].Value` and `Secrets[].ValueFrom`
entries are commonly intrinsic-valued in real-world CDK ECS apps —
`table.tableName` synthesizes as `Ref`, `table.tableArn` as
`Fn::GetAtt`, `ecs.Secret.fromSecretsManager(secret)` as `Ref` against
the secret (returns the deployed ARN), `ecs.Secret.fromSsmParameter(p)`
as `Fn::Join` over pseudo parameters + a `Ref` to the parameter, etc.
Without `--from-state` these intrinsics are silently dropped (matching
`cdkd local invoke` v1 semantics) and the developer sees an empty env
var or a missing secret.

`cdkd local run-task --from-state` substitutes every intrinsic-valued
entry against cdkd's deployed S3 state plus AWS pseudo parameters:

| Intrinsic | Source |
| --- | --- |
| `Ref: <LogicalId>` | `state.resources[<LogicalId>].physicalId` |
| `Fn::GetAtt: [<LogicalId>, <Attr>]` | `state.resources[<LogicalId>].attributes[<Attr>]` |
| `Fn::Sub: '...${X}...${AWS::Region}...'` | recursive substitution against state + pseudo parameters |
| `Fn::Join: [<delim>, [<elements>]]` | recursive substitution of every element, then `Array.join` |
| `Ref: AWS::AccountId` / `AWS::Region` / `AWS::Partition` / `AWS::URLSuffix` | STS `GetCallerIdentity` (lazy, cached) + the resolved region + region-derived partition / URL suffix |

Per-key best-effort: when a substitution can't be produced (state
missing for a referenced logical ID, attribute not captured at deploy
time, unsupported intrinsic), the env / secret entry is dropped and a
per-key warning surfaces on the task's warnings line — the run-task
invocation never aborts. State-load failures (no record, multi-region
ambiguity without `--stack-region`, bucket resolution error) also
degrade to warn-and-fall-back rather than hard-fail.

Resolved `Secrets[].ValueFrom` strings then flow into the standard
SecretsManager / SSM resolver below.

### Secrets / SSM parameter resolution

`ContainerDefinitions[].Secrets[].ValueFrom` entries are resolved once at
startup via the AWS SDK (after any `--from-state` intrinsic substitution
above). Three accepted shapes:

| `valueFrom` | API |
| --- | --- |
| `arn:aws:secretsmanager:<region>:<account>:secret:<name>` | `SecretsManagerClient.GetSecretValue` |
| `arn:aws:secretsmanager:<region>:<account>:secret:<name>:<json-key>::` | `GetSecretValue`, then JSON.parse + extract `json-key` |
| `arn:aws:ssm:<region>:<account>:parameter/<name>` | `SSMClient.GetParameter({ WithDecryption: true })` |

Resolution failures (NotFound / AccessDenied / network error / invalid
ARN) hard-fail with the offending container + secret name. The user
fixes their AWS creds / IAM policy and re-runs. (Mirrors the
`cdkd local invoke --from-state` philosophy: explicit failure beats
silently-empty.)

**Secret names that are refused.** When a secret's name is accepted, its VALUE
reaches the container through the `docker run` spawn environment (a value-less
`-e KEY` flag, so the plaintext never appears on the argv / `/proc/<pid>/cmdline`).
The NAME decides whether the secret is forwarded at all: two name shapes are
**not passed to the container** — no `-e` flag and no spawn-env entry, so the
value reaches neither the argv nor the spawn environment:

- **A name that collides with a variable the docker CLI itself reads** —
  matched case-insensitively (Windows env lookups are). This is a fixed exact
  denylist (connection / TLS / behaviour, `PATH` / `PATHEXT` / `HOME` /
  `USERPROFILE`, the loader / trust / runtime vars, the ssh exec-helper set,
  and the AWS credential-helper vars `docker-credential-ecr-login` reads) plus
  the `LD_` / `DYLD_` / `AWS_ENDPOINT_URL_` prefix families; the authoritative
  list is `DOCKER_CLIENT_ENV_KEYS` / `DOCKER_CLIENT_ENV_PREFIXES` in
  [src/utils/docker-cmd.ts](https://github.com/go-to-k/cdkd/blob/main/src/utils/docker-cmd.ts). Forwarding such a name
  would let a template-controlled secret NAME redirect the docker client itself
  (e.g. a secret named `DOCKER_HOST` pointing the client at a different daemon).
- **A malformed name** — empty, or containing `=` / NUL. A name containing `=`
  is the dangerous case: the OS parses the environ entry's name as everything
  before the first `=`, so a secret named `PATH=/tmp/evil:` would be parsed as
  `PATH` — a different variable than the collision check saw. An empty or
  NUL-bearing name simply cannot form a valid environment variable.

Each refusal is reported with a `warn` identifying the dropped secret(s) so the
drop is never silent; rename the secret if the container needs the value.

### Container start ordering — `DependsOn`

| Condition | What cdkd waits for |
| --- | --- |
| `START` | Dependency's `docker run` has returned. |
| `COMPLETE` | Dependency's container has exited (any code). |
| `SUCCESS` | Dependency's container has exited with exit code 0. |
| `HEALTHY` | Dependency's `HEALTHCHECK` reports `healthy` (polled every 1s, capped at 5 min). |

Cyclic dependencies → hard-error at discovery with the offending cycle
named. Topological sort decides the start order; siblings with no
dependsOn relation start in template order.

### Volumes

| `Volumes[]` shape | Local realization |
| --- | --- |
| `Host: { SourcePath: '/some/path' }` | `docker run -v /some/path:<containerPath>` bind mount (caller's responsibility that the host path exists; a missing path emits a warn) |
| `Host` (no `SourcePath`) | Docker anonymous volume — empty per-task scratch |
| `DockerVolumeConfiguration: { Scope: 'task' \| 'shared', Driver, DriverOpts }` | `docker volume create --driver <driver> --opt ...` per task; per-task scope is torn down at exit |
| `EFSVolumeConfiguration` | **Hard-error**. Bind-mount a local directory at the same `containerPath` instead. |
| `FSxWindowsFileServerVolumeConfiguration` | **Hard-error**. |

### Lifecycle + teardown

1. The first `essential: true` container (defaults to `containers[0]`
   when no container declares `essential: false`) drives the task.
2. When the essential container exits, cdkd `docker stop`s every other
   container with a 10s grace then `docker rm -f`.
3. The metadata sidecar is `docker rm -f`'d and the docker network is
   removed.
4. cdkd exits with the essential container's exit code.

`^C` triggers the same teardown. Double-`^C` exits 130 immediately
(skipping container cleanup — same pattern as `cdkd local start-api`).

`--detach` skips steps 1, 2, and 4. The sidecar and user containers
stay running for the caller to manage. cdkd prints the network name on
exit so you can `docker ps --filter network=<name>` to inspect.

`--keep-running` skips step 2 only. The network + sidecar are still
torn down. Use to `docker exec` into a stopped container post-mortem.

### `local run-task` exit codes

- `0` — essential container exited 0.
- N (non-zero) — essential container exited N (cdkd propagates the code).
- Various cdkd-side error codes (Docker missing, target not found,
  network creation failed, secret resolution failed, ...) follow the
  global handler's defaults (typically 1).

### `local run-task` Phase 1 scope (out of scope, deferred)

| Out of scope | Why |
| --- | --- |
| `AWS::ECS::Service` / `DesiredCount` / `LaunchType` | Use `cdkd local start-service` instead |
| ALB / NLB target group registration / listener rules | Deferred follow-up — needs an HTTP proxy emulator |
| Service Connect / Cloud Map | Implemented for `cdkd local start-service` via `--add-host` DNS overlay. `cdkd local run-task` is single-task by design; cross-service discovery is meaningful only with multiple long-running services, so it stays out of scope here. |
| Auto Scaling / Deployment Strategy | Not meaningful locally |
| Fargate vs EC2 launch-type differences (PID namespace, `awsvpc`-only, ephemeral storage cap) | Local Docker can't enforce these |
| EFS / FSx volumes | Need real AWS NFS / SMB; hard-error with a routing hint |
| ECS Exec | Use `docker exec` directly |
| CloudWatch Logs auto-shipping (`logConfiguration.LogDriver: 'awslogs'`) | stdout/stderr already streamed; skip the driver |
| X-Ray sidecar's AWS-API mocking | Run the daemon explicitly if you need it |
| AWS App Mesh / Envoy fidelity | Not meaningful locally |
| awsvpc / ENI complete fidelity | Map to docker bridge with a warn |

