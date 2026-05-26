# cdkd (CDK Direct)

Drop-in CDK CLI for existing CDK apps — faster deploys via AWS SDK instead of CloudFormation, plus local emulation for Lambda, API Gateway, and ECS.

- **Drop-in CDK compatible** — your existing CDK app code runs as-is.
- **Up to 15x faster deploys than the AWS CDK CLI (CloudFormation)**
- **Local dev for any CDK app** — invoke Lambdas, serve API Gateway routes, run ECS tasks/services directly from your CDK code. Works against both `cdkd deploy`-managed AND `cdk deploy`-managed (CloudFormation) stacks via `--from-state` / `--from-cfn-stack` — no migration, no `cdk synth → sam local` round-trip.

![cdk deploy vs cdkd deploy — side-by-side, 35s recording, real AWS deploy. cdkd finishes while cdk is still creating its CloudFormation changeset.](assets/cdk-vs-cdkd.gif)

**cdkd complements the AWS CDK CLI rather than replacing it.** Use cdkd in dev/test for rapid iteration and SAM-style local execution; use the AWS CDK CLI in production for full CloudFormation tooling. Install cdkd alongside an existing `cdk deploy` workflow — no migration needed, `cdkd local *` reads deployed state directly via `--from-cfn-stack`. Bidirectional migration is also supported — [import](#importing-existing-resources) into cdkd or [export](#exporting-a-stack-back-to-cloudformation) back to CloudFormation when ready.

> [!IMPORTANT]
> cdkd is for dev/test workflows only — early in development, not yet production-ready.

## Benchmark

**cdkd deploys up to 15x faster than AWS CDK (CloudFormation)** on SDK-Provider-handled stacks; the per-stack speedup widens with size and parallelism, and drops to ~1.5-3x on stacks dominated by Cloud Control API fallback resources.

Numbers below are deploy-phase only (CDK app synthesis is identical between cdkd and AWS CDK — both run the same user code through `aws-cdk-lib`'s synthesizer — so synth time is excluded from the speedup calculation).

### SDK Provider path — **5.5x faster** (17.0s vs 94.4s)

Stack: S3 Bucket, DynamoDB Table, SQS Queue, SNS Topic, SSM Parameter (5 independent resources, fully parallelized by cdkd's DAG scheduler).

| | AWS CDK (CFn) | cdkd | Speedup |
| --- | ---: | ---: | ---: |
| Deploy | **94.4s** | **17.0s** | **5.5x** |

### VPC + CloudFront + Lambda stack — **15x faster with `--no-wait`** (40s vs 599s)

Real-world stack: 1 VPC (2 AZs, NAT Gateway, public + private subnets) + Lambda Function (with `VpcConfig`) + Lambda Function URL (AWS_IAM) + CloudFront Distribution (OAC, caching disabled) + SQS Queue + EventSourceMapping + Consumer Lambda.

| | AWS CDK (CFn) | cdkd | cdkd `--no-wait` |
| --- | ---: | ---: | ---: |
| Deploy | **599s** | 197s (3.0x) | **40s (15.0x)** |

The 15x figure requires `cdkd deploy --no-wait`, which returns as soon as each Create call returns and lets AWS finish CloudFront's ~5min propagation + NAT Gateway stabilization in the background. cdkd's default scheduler already parallelizes `CloudFront::Distribution` / `Lambda::Url` / VPC Lambda with NAT Gateway propagation (pass `--no-aggressive-vpc-parallel` to opt out); on this stack the default gives ~3x. `--no-wait` adds the rest of the gap by skipping the propagation waits entirely.

### Cloud Control API fallback path — **1.6x faster** (40.9s vs 64.9s)

Stack: SSM Document × 3 + Athena WorkGroup × 2 (no SDK provider — CC API fallback).

| | AWS CDK (CFn) | cdkd | Speedup |
| --- | ---: | ---: | ---: |
| Deploy | **64.9s** | **40.9s** | **1.6x** |

Reproduce the first two with `./tests/benchmark/run-benchmark.sh all`. See [tests/benchmark/README.md](tests/benchmark/README.md) for details.

## Features

- **Synthesis orchestration**: CDK app subprocess execution, Cloud Assembly parsing, context provider loop
- **Asset handling**: Self-implemented asset publisher for S3 file assets (ZIP packaging) and Docker images (ECR)
- **Context resolution**: Self-implemented context provider loop for Vpc.fromLookup(), AZ, SSM, HostedZone, etc.
- **Hybrid provisioning**: SDK Providers for fast direct API calls, Cloud Control API fallback for broad resource coverage
- **Diff calculation**: Self-implemented resource/property-level diff between desired template and current state
- **S3-based state management**: No DynamoDB required, uses S3 conditional writes for locking
- **DAG-based parallelization**: Analyze `Ref`/`Fn::GetAtt` dependencies and execute in parallel
- **Rollback on failure**: When a deploy errors mid-stack, cdkd rolls back the resources it just created so the stack state stays consistent (CloudFormation parity — but cdkd does this without round-tripping through CFn). Pass `cdkd deploy --no-rollback` to skip rollback and keep the partial state for Terraform-style inspection / repair. See [Rollback behavior](#rollback-behavior).
- **`--no-wait` for async resources**: Skip the multi-minute wait on CloudFront / RDS / ElastiCache / NAT Gateway and return as soon as the create call returns (CloudFormation always blocks)
- **VPC route DependsOn relaxation (on by default)**: Drop CDK-injected defensive `DependsOn` edges from VPC Lambdas onto private-subnet routes so `CloudFront::Distribution` and `Lambda::Url` start their ~3-min propagation in parallel with NAT Gateway stabilization (~50% faster on VPC + Lambda + CloudFront stacks). Pass `--no-aggressive-vpc-parallel` to opt out.
- **Local execution** (`cdkd local invoke` / `start-api` / `run-task` / `start-service`): run Lambdas, API Gateway routes, ECS tasks and long-running ECS services from your CDK code via Docker. All AWS Lambda runtimes, container Lambdas, REST v1 / HTTP v2 / Function URL routes, Service Connect / Cloud Map. Works for both `cdkd deploy`-managed (`--from-state`) AND `cdk deploy`-managed (`--from-cfn-stack`) stacks. See [Local execution](#local-execution).
- **Bidirectional CloudFormation migration**: `cdkd import --migrate-from-cloudformation` adopts existing CFn stacks (including `cdk deploy`-managed) into cdkd state without re-creating resources; `cdkd export` hands a cdkd stack back to CloudFormation when production-ready. See [Importing](#importing-existing-resources) / [Exporting](#exporting-a-stack-back-to-cloudformation).

> **Note**: Resource types not covered by either SDK Providers or Cloud Control API cannot be deployed with cdkd. Deployment fails with a clear error message naming the type + a 1-click issue link.

## Prerequisites

- **Node.js** >= 20.0.0
- **AWS CDK Bootstrap**: You must run `cdk bootstrap` before using cdkd. cdkd uses CDK's bootstrap bucket (`cdk-hnb659fds-assets-*`) for asset uploads (Lambda code, Docker images). Custom bootstrap qualifiers are supported — CDK embeds the correct bucket/repo names in the asset manifest during synthesis.
- **AWS credentials with admin-equivalent permissions** for the resources being deployed. cdkd does NOT route through CloudFormation, so CDK CLI's `cdk-hnb659fds-deploy-role-*` is NOT sufficient — see [`--role-arn`](docs/cli-reference.md).

## Installation

```bash
npm i -g @go-to-k/cdkd          # latest release
npm i -g @go-to-k/cdkd@0.0.2    # pin to a specific version
```

The installed binary is `cdkd`.

## Quick Start

> **First-time setup**: cdkd requires a one-time `cdkd bootstrap` per AWS
> account before any other command will work — it creates the S3 state
> bucket (`cdkd-state-{accountId}`) that cdkd uses to track deployed
> resources. This is separate from `cdk bootstrap` (which sets up the
> CDK asset bucket / ECR repo and is also required — see
> [Prerequisites](#prerequisites)).

```bash
# Bootstrap (creates S3 state bucket — one-time setup, once per AWS account)
cdkd bootstrap

# List stacks in the CDK app
cdkd list

# Deploy your CDK app
cdkd deploy

# Check what would change
cdkd diff

# Tear down
cdkd destroy
```

That's it. cdkd reads `--app` from `cdk.json` and auto-resolves the state bucket from your AWS account ID (`cdkd-state-{accountId}`). If you bootstrapped under a previous cdkd version, the legacy region-suffixed name (`cdkd-state-{accountId}-{region}`) is still picked up automatically with a deprecation warning.

## Usage

cdkd has three command families:

- **Top-level commands** (`cdkd deploy` / `destroy` / `diff` / `synth` /
  `list` / `import` / `orphan` / `publish-assets`) require a CDK app —
  they synthesize a template to learn what they're operating on.
- **`cdkd state ...` subcommands** (`state info` / `list` / `resources`
  / `show` / `orphan` / `destroy` / `migrate` / `refresh-observed`)
  operate on the S3 state bucket only and do NOT need the CDK app —
  use them to inspect / clean up state when the source is gone or
  you don't want to synth. `cdkd state destroy` is the CDK-app-free
  counterpart of `cdkd destroy`.
- **`cdkd local ...` subcommands** (`local invoke`, `local start-api`,
  `local run-task`, `local start-service`) run synthesized workloads
  locally inside Docker containers. The Lambda variants (`local invoke` /
  `local start-api`) bundle the AWS Lambda Runtime Interface Emulator
  (RIE); `local invoke` runs a single Lambda once, and `local start-api`
  stands up a long-running HTTP server that maps API Gateway / HTTP API /
  Function URL routes to local Lambda invocations. `local run-task` is
  the ECS one-shot counterpart — it locates an
  `AWS::ECS::TaskDefinition` from the synthesized template and stands
  up every container in `dependsOn` order on a per-task docker network
  with the AWS-published metadata endpoints sidecar, so containers see
  `ECS_CONTAINER_METADATA_URI_V4` (and optionally task-role creds via
  `--assume-task-role`) just like they would on Fargate / ECS.
  `local start-service` is the long-running counterpart for
  `AWS::ECS::Service`: it discovers the service, chains into the same
  per-task machinery for each `DesiredCount` replica (clamped by
  `--max-tasks`), and keeps every replica running until `^C` — failed
  replicas restart per `--restart-policy on-failure|always|none`. It
  also accepts multiple service targets in one invocation
  (`cdkd local start-service Stack/Orders Stack/Frontend`); per-service
  `AWS::ServiceDiscovery::PrivateDnsNamespace` / `Service` +
  `ServiceConnectConfiguration` / `ServiceRegistries[]` blocks are
  parsed and each booted replica's container IP is published to a
  shared in-process Cloud Map registry, then injected into the next
  service's containers via docker `--add-host <fqdn>:<ip>` so
  `wget http://orders/` from inside the `frontend` container resolves
  via `/etc/hosts` to the orders replica (boot targets in
  producer-then-consumer order; see [docs/local-emulation.md](docs/local-emulation.md)
  for v1 limitations — first-wins for multi-replica routing, no SRV
  records, no Envoy L7). No AWS API calls beyond optional STS / Secrets
  resolution, no state bucket needed. Local load-balancer emulation and
  `--watch` hot-reload for `start-service` are deferred to follow-up
  PRs.

Options like `--app`, `--state-bucket`, and `--context` can be omitted if configured via `cdk.json` or environment variables (`CDKD_APP`, `CDKD_STATE_BUCKET`).

```bash
# Bootstrap (create S3 bucket for state)
cdkd bootstrap \
  --state-bucket my-cdkd-state \
  --region us-east-1

# Synthesize only
cdkd synth --app "node app.ts"

# List all stacks in the CDK app (alias: ls)
cdkd list
cdkd ls
cdkd list --long              # YAML records with id/name/environment
cdkd list --long --json       # same, but JSON
cdkd list --show-dependencies # id + dependency list per stack
cdkd list 'MyStage/*'         # filter by display path (CDK CLI parity)

# Deploy from a pre-synthesized cloud assembly directory
cdkd deploy --app cdk.out

# Deploy (single stack auto-detected, reads --app from cdk.json)
cdkd deploy

# Deploy specific stack(s)
cdkd deploy MyStack
cdkd deploy Stack1 Stack2

# Deploy all stacks
cdkd deploy --all

# Deploy with wildcard (matched against the physical CloudFormation stack name)
cdkd deploy 'My*'

# Deploy stacks under a CDK Stage using the hierarchical path (CDK CLI parity)
# Patterns containing '/' are routed to the CDK display path; both forms work:
cdkd deploy 'MyStage/*'        # all stacks under MyStage
cdkd deploy MyStage/Api        # specific stack by display path
cdkd deploy MyStage-Api        # same stack by physical CloudFormation name

# Deploy with context values
cdkd deploy -c env=staging -c featureFlag=true

# Deploy with explicit options
cdkd deploy MyStack \
  --app "node app.ts" \
  --state-bucket my-cdkd-state \
  --verbose

# Show diff (what would change)
cdkd diff MyStack
cdkd diff MyParent --recursive       # also diff every nested-stack child vs its own state (#555 A5)
cdkd diff MyParent --recursive --json  # nested {stack, changes, children: [...]} JSON
cdkd diff MyStack --fail             # exit 1 when any change is detected (CI gate; matches cdk diff --fail)

# Detect drift between cdkd state and AWS reality (state-only; no synth)
# Exits 0 with no drift, 1 when drift is detected, 2 on partial revert failure.
cdkd drift MyStack
cdkd drift --all --json

# Resolve drift: state ← AWS (catch up state with manual console changes)
cdkd drift MyStack --accept --yes

# Resolve drift: AWS ← state (push state values back into AWS via provider.update)
cdkd drift MyStack --revert --yes

# Refresh the deploy-time AWS snapshot used as drift baseline.
# Optional — `cdkd deploy` itself auto-refreshes on the first deploy after
# upgrading from a pre-v3 cdkd binary (= state schema `version: 2`), in
# parallel with the deploy at no critical-path cost. This command is the
# manual / non-deploy path: run it when you want the baseline refreshed
# without redeploying (e.g. for resources that won't change in any
# near-future deploy). Idempotent on the same v3 state — see "Drift
# detection" below for the full upgrade story.
cdkd state refresh-observed MyStack

# Dry run (plan only, no changes)
cdkd deploy --dry-run

# Deploy with no rollback on failure (Terraform-style)
cdkd deploy --no-rollback

# Deploy only the specified stack (skip dependency auto-inclusion)
cdkd deploy -e MyStack

# Skip the multi-minute wait on async resources (CloudFront, RDS, NAT GW, etc.)
cdkd deploy --no-wait

# Synth + build + publish assets only (no deploy) — typical CI split
cdkd publish-assets

# Destroy resources
cdkd destroy MyStack
cdkd destroy --all --force

# Force-unlock a stale lock from interrupted deploy
cdkd force-unlock MyStack

# Adopt already-deployed AWS resources into cdkd state.
# See docs/import.md for the full guide (auto / selective / hybrid modes,
# --resource overrides, --resource-mapping CDK CLI compatibility).
cdkd import MyStack --dry-run
cdkd import MyStack --yes

# Inspect state-bucket info on demand (bucket name, region, source, schema version, stack count).
# Routine commands (deploy / destroy / etc.) no longer print the bucket banner by default —
# pass --verbose to surface it in their debug logs, or use this subcommand for an explicit answer.
cdkd state info
cdkd state info --json        # JSON output for tooling
cdkd state info --state-bucket my-bucket  # explicit bucket; reports Source: --state-bucket flag

# List stacks registered in the cdkd state bucket
cdkd state list
cdkd state ls --long          # include resource count, last-modified, lock status
cdkd state list --json        # JSON output (alone, or combined with --long)
cdkd state list --tree        # parent → child stack tree (nested stacks; #555 A3)
cdkd state list --tree --json # tree as nested JSON

# List resources of a single stack from state
cdkd state resources MyStack          # aligned columns: LogicalID, Type, PhysicalID
cdkd state resources MyStack --long   # per-resource block with dependencies and attributes
cdkd state resources MyStack --json   # full JSON array

# Show full state record for a stack (metadata, outputs, all resources incl. properties)
cdkd state show MyStack
cdkd state show MyStack --json              # raw {state, lock} JSON
cdkd state show MyParent --show-nested      # recursively show every nested-stack child (#555 A4)
cdkd state show MyParent --show-nested --json  # tree as nested {state, lock, children: [...]} JSON

# Orphan one or more RESOURCES from cdkd's state (does NOT delete AWS resources).
# Per-resource, mirrors aws-cdk-cli's `cdk orphan --unstable=orphan`.
# Synth-driven — needs --app / cdk.json. Construct paths use CDK's L2-style form
# (`<StackName>/<Path/To/Construct>`); the synthesized `/Resource` suffix is
# matched implicitly. Passing an L2 wrapper that contains multiple CFn resources
# orphans every child under it (matches upstream's prefix-match semantics).
cdkd orphan MyStack/MyTable                    # confirmation prompt (y/N)
cdkd orphan MyStack/MyTable --yes
cdkd orphan MyStack/MyTable MyStack/MyBucket   # multiple resources, same stack
cdkd orphan MyStack/MyTable --dry-run          # print rewrite audit, no save
cdkd orphan MyStack/MyTable --force            # also fall back to cached
                                               # attributes when live fetch fails

# State-driven counterpart that orphans a WHOLE STACK's state record
# (no CDK app needed — works against the bucket).
cdkd state orphan MyStack             # confirmation prompt (y/N)
cdkd state orphan MyStack --yes       # skip confirmation
cdkd state orphan StackA StackB --force # also bypass the locked-stack refusal

# Destroy a stack's AWS resources AND remove its state record, without
# requiring the CDK app (no synth — works from any working directory).
cdkd state destroy MyStack            # per-stack confirmation prompt
cdkd state destroy MyStack OtherStack --yes
cdkd state destroy --all -y           # every stack in the bucket
cdkd state destroy MyStack --region us-east-1
```

## Compatibility

cdkd supports the standard CloudFormation surface — intrinsic functions,
pseudo parameters, parameters / conditions, cross-stack / cross-region
references, asset publishing, custom resources, and so on. See
**[docs/supported-features.md](docs/supported-features.md)** for the
full reference. For per-resource-type provisioning support (SDK Providers
vs Cloud Control API fallback), see
**[docs/supported-resources.md](docs/supported-resources.md)**.

**Property-level coverage is incremental.** SDK Providers wire most but not every CFn property of a supported type. cdkd fails fast at pre-flight when a template uses a not-yet-implemented property, with the property name + a 1-click issue link. `--allow-unsupported-properties <Type>:<Prop>,...` is the safety valve when this is too strict (e.g. mid-life update on an existing resource); avoid it on security-meaningful properties (encryption / IAM / TLS). See [docs/cli-reference.md](docs/cli-reference.md#--allow-unsupported-properties-deploy).

## Local execution

The `cdkd local` family runs AWS workloads on the developer's machine
via Docker — Lambda functions, API Gateway routes, ECS tasks, and
long-running ECS services — without an AWS deploy. Modeled on `sam local *` but reuses cdkd's
synthesis / asset / construct-path plumbing — no `template.yaml` to
maintain, no `cdk synth | sam ...` round-trip.

| Subcommand | Emulates |
| --- | --- |
| `cdkd local invoke <target>` | One-shot Lambda invoke via the AWS Lambda Runtime Interface Emulator (RIE) |
| `cdkd local start-api` | Long-running HTTP server for REST v1 / HTTP API / Function URL routes |
| `cdkd local run-task <target>` | ECS RunTask — every container in a task definition started on a per-task docker network |
| `cdkd local start-service <target>` | Long-running ECS Service emulator — `DesiredCount` replicas with restart-on-exit (no local load balancer in v1) |

Requires Docker. Pass `--from-state` (cdkd-deployed) or
`--from-cfn-stack` (cdk-deployed / CFn-managed) to substitute deployed
physical IDs into intrinsic-valued env vars / secrets / image URIs;
without either, intrinsic values are dropped with a per-key warning
(matches `sam local *`). The two flags are mutually exclusive.

### `local invoke`

```bash
cdkd local invoke MyStack/Handler                    # one-shot invoke
cdkd local invoke MyStack/Handler --event events/get.json
cdkd local invoke MyStack/Handler --from-state       # OR --from-cfn-stack
```

All AWS Lambda runtimes (Node.js / Python / Ruby / Java / .NET /
`provided.al2023`), ZIP and container Lambdas, same-stack Lambda Layers
bind-mounted at `/opt`.

### `local start-api`

```bash
cdkd local start-api                                 # one HTTP server per discovered API
cdkd local start-api MyStack/MyHttpApi --watch       # filter + hot reload
cdkd local start-api --from-state                    # OR --from-cfn-stack
```

REST v1 + HTTP API v2 + Function URL with all integration kinds
(AWS_PROXY / MOCK / HTTP_PROXY / HTTP / AWS Lambda non-proxy via
hand-rolled VTL), authorizers (Lambda / Cognito / HTTP v2 JWT /
REST v1 AWS_IAM SigV4), CORS, stage variables, `--watch` hot reload.

### `local run-task`

```bash
cdkd local run-task MyStack/MyService/TaskDef
cdkd local run-task MyTaskDef --from-state           # OR --from-cfn-stack
```

Every container in the task definition on a per-task docker network
with the AWS-published ECS metadata sidecar.

### `local start-service`

```bash
cdkd local start-service MyStack/Orders MyStack/Web  # multiple services in one invocation
cdkd local start-service MyStack/Orders --from-state # OR --from-cfn-stack
```

Long-running ECS Service emulator: `DesiredCount` replicas with
restart-on-exit, cross-service Service Connect / Cloud Map DNS
discovery (peer containers reach each other by `<discoveryName>.<namespace>`).
No local load-balancer in v1.

See **[docs/local-emulation.md](docs/local-emulation.md)** for the
full reference — runtimes, target resolution, every flag, integration
and authorizer detail, route precedence, container pool, networking,
`--from-cfn-stack` semantics, v1 scope.

## Importing existing resources

`cdkd import` adopts AWS resources that are already deployed (via
`cdk deploy`, manual creation, or another tool) into cdkd state so the
next `cdkd deploy` updates them in-place instead of CREATEing duplicates.

`cdkd import --migrate-from-cloudformation` extends this to migrate a
**whole CloudFormation stack** off CFn in a single command: cdkd reads
the source CFn stack's `(logicalId, physicalId)` mappings, adopts every
resource into cdkd state, then retires the source CFn stack (injects
`DeletionPolicy: Retain` + `UpdateReplacePolicy: Retain` on every
resource → `UpdateStack` → `DeleteStack`) so the AWS resources stay
intact but are no longer tracked by CFn. After the command finishes,
the stack is managed by `cdkd deploy`. This is the reverse direction
of `cdkd export` (see below).

```bash
# Adopt a whole stack previously deployed by cdk deploy (tag-based auto-lookup).
cdkd import MyStack --yes

# Adopt only specific resources (CDK CLI parity).
cdkd import MyStack --resource MyBucket=my-bucket-name

# Migrate off CloudFormation in one shot — adopt + retire the source CFn stack.
cdkd import MyStack --migrate-from-cloudformation --yes
```

See **[docs/import.md](docs/import.md)** for the full guide: three import
modes (auto / selective / hybrid), `--resource-mapping` CDK CLI
compatibility, CloudFormation migration flow, provider coverage, and the
parity matrix vs upstream `cdk import`.

## Exporting a stack back to CloudFormation

`cdkd export` is the mirror of `cdkd import`: it hands a cdkd-managed
stack back to CloudFormation via a CFn `ChangeSetType=IMPORT` changeset.
AWS resources are unchanged across the migration; cdkd state for the
exported stack is deleted on success. From then on the stack is managed
by `cdk deploy` / `aws cloudformation`. Accepts JSON and YAML templates
(shorthand intrinsics round-trip).

```bash
cdkd export MyStack                           # confirmation prompt; CFn stack name = cdkd stack name
cdkd export MyStack --cfn-stack-name MyStack-CFn
cdkd export MyStack --dry-run                 # print the import plan, do not call CFn
cdkd export MyStack --include-non-importable  # 2-phase: IMPORT importable + CFn-CREATE Custom Resources
cdkd export MyApp                             # nested-stack tree: leaf-first per-stack IMPORT loop
```

**Lambda-backed Custom Resources** (`Custom::*` /
`AWS::CloudFormation::CustomResource`) are NOT directly CFn-importable.
`--include-non-importable` opts into a 2-phase migration that re-CREATEs
them through CFn — the Custom Resource Lambda must be idempotent.
**Nested stacks** are supported via a leaf-first per-stack IMPORT loop
(AWS rejects `--include-nested-stacks` for IMPORT changesets).

See **[docs/import.md](docs/import.md)** for the full guide — Custom Resource
2-phase flow, nested-stack adoption mechanics (`--cfn-child-stack-name`
per-child overrides, AWS's "Nest an existing stack" pattern), and the
design rationale at [docs/design/464-nested-stacks-export-import.md](docs/design/464-nested-stacks-export-import.md).

## Drift detection

`cdkd drift` (state-driven; no synth) compares each managed resource
against AWS reality and reports divergence — including console-side
changes to keys you did NOT template (S3 public-access-block, IAM Role
tags, Lambda env keys, etc.).

```bash
cdkd drift                       # auto-detect single stack, exit 1 if drift
cdkd drift MyStack --json        # machine-readable, for CI gating
cdkd drift MyStack --accept --yes   # state ← AWS (catch up after a console edit)
cdkd drift MyStack --revert --yes   # AWS ← state (undo a console edit)
cdkd state refresh-observed MyStack # populate the drift baseline without redeploying
```

See **[docs/cli-reference.md `cdkd drift`](docs/cli-reference.md#cdkd-drift)**
for the full reference: `--no-capture-observed-state` deploy opt-out
(per-command vs per-project, mid-flight reversibility), v2→v3 state
upgrade flow, exit codes, and what changes when capture is off.

## Orphan vs destroy

`destroy` deletes the AWS resources **and** the state record;
`orphan` deletes **only** the state record (AWS resources stay
intact, just no longer tracked by cdkd). Mirrors aws-cdk-cli's
`cdk orphan`.

Two `orphan` variants at different granularities:

- `cdkd orphan <constructPath>...` — synth-driven, **per-resource**.
  Rewrites every sibling reference (Ref / Fn::GetAtt / Fn::Sub /
  dependencies) so the next deploy doesn't re-create the orphan.
- `cdkd state orphan <stack>...` — state-driven, **whole-stack**.
  Removes the entire state record. Works without the CDK app.

Both `cdkd destroy` (synth-driven) and `cdkd state destroy`
(state-driven, no synth) delete AWS resources + state.

## How it works

```
┌─────────────────┐
│  Your CDK App   │  (aws-cdk-lib)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ cdkd Synthesis  │  Subprocess + Cloud Assembly parser
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ CloudFormation  │
│   Template      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ cdkd Engine     │
│ - DAG Analysis  │  Dependency graph construction
│ - Diff Calc     │  Compare with existing resources
│ - Parallel Exec │  Event-driven dispatch
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌────────┐
│  SDK   │ │ Cloud  │
│Provider│ │Control │  Fallback for many
│        │ │  API   │  additional types
└────────┘ └────────┘
```

For a step-by-step walkthrough of the full `cdkd deploy` pipeline (CLI
parsing → synthesis → asset publishing → per-stack deploy), see
[docs/architecture.md](docs/architecture.md#5-end-to-end-pipeline-walkthrough-cdkd-deploy).

## `--no-wait`: skip async-resource waits

CloudFront / RDS / ElastiCache / NAT Gateway typically take 1–15
minutes to fully provision. By default cdkd waits (matching CFn).
`cdkd deploy --no-wait` returns as soon as the create call returns
and lets AWS finish in the background — handy for CI where nothing
in the deploy flow needs the resource fully active. **Deploy-only**:
`cdkd destroy` always waits (NAT in `deleting` state holds ENIs and
would `DependencyViolation` sibling deletes).

See [docs/cli-reference.md](docs/cli-reference.md#--no-wait-skip-async-resource-waits)
for per-resource caveats (NAT egress, RDS final-snapshot timing,
etc.).

## VPC route DependsOn relaxation (on by default)

CDK injects defensive `DependsOn` from VPC Lambdas onto private-subnet
routes. The dependency is real at runtime but NOT required at deploy
time. cdkd drops it by default so CloudFront + Lambda::Url propagation
runs in parallel with NAT stabilization (~50% faster on VPC+Lambda+CloudFront
stacks; bench-cdk-sample 398s → 181s). Pass
`cdkd deploy --no-aggressive-vpc-parallel` to opt out (e.g. when a
Custom Resource synchronously invokes a VPC Lambda outside cdkd's
Lambda-ServiceToken Active wait).

See [docs/cli-reference.md](docs/cli-reference.md) for the full
type-pair allowlist and trade-off notes.

## Rollback behavior

When a deploy fails mid-stack (e.g. a resource hits a validation error
or AWS rejects the request), cdkd by default **rolls back the
already-completed resources in the same deploy** so the stack state
stays consistent — every resource cdkd just created in this run is
deleted in reverse dependency order, the state record is updated to
match, and the CLI exits non-zero. Resources that existed before this
deploy are NOT touched.

Pass `cdkd deploy --no-rollback` to skip the rollback (Terraform-style:
the partial state is preserved so you can `cdkd state show <stack>`,
inspect what landed, fix the underlying issue, and re-run `cdkd deploy`
to continue from the half-deployed state). Recommended only when you
plan to manually inspect / repair; the default is safer for CI.

Mid-deploy state is also saved per-resource as work completes, so even
if cdkd itself crashes between the failure and the rollback, the state
file accurately reflects what's on AWS and a follow-up `cdkd destroy`
won't orphan anything.

## `--remove-protection`: one-shot bypass for protected resources

`cdkd destroy --remove-protection` (and `cdkd state destroy --remove-protection`)
flips every protection flag off in-place before each provider's delete
API call, so a destroy proceeds without an intermediate edit / redeploy.
Covers stack-level `terminationProtection` (logged as a WARN) AND
resource-level protection on these types:

| Resource type | Protection field |
| --- | --- |
| `AWS::Logs::LogGroup` | `DeletionProtectionEnabled` |
| `AWS::RDS::DBInstance` | `DeletionProtection` |
| `AWS::RDS::DBCluster` | `DeletionProtection` |
| `AWS::DocDB::DBCluster` | `DeletionProtection` (DocDB DBInstance has no `DeletionProtection` field, so per-instance bypass is a no-op) |
| `AWS::Neptune::DBCluster` | `DeletionProtection` |
| `AWS::Neptune::DBInstance` | `DeletionProtection` |
| `AWS::DynamoDB::Table` | `DeletionProtectionEnabled` |
| `AWS::DynamoDB::GlobalTable` | `DeletionProtectionEnabled` (CDK v2 `dynamodb.TableV2`) |
| `AWS::EC2::Instance` | `DisableApiTermination` |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` | attribute `deletion_protection.enabled` |
| `AWS::Cognito::UserPool` | `DeletionProtection` (`ACTIVE` / `INACTIVE`) |
| `AWS::AutoScaling::AutoScalingGroup` | `DeletionProtection` (`none` / `prevent-force-deletion` / `prevent-all-deletion`) — flag also sets `ForceDelete: true` so AWS terminates running instances as part of the delete |

A single `--remove-protection` covers every type listed above (no
per-type variant). The interactive confirm prompt switches to
`y/N` (requiring an explicit `y` for the destructive bypass);
`--yes` / `-y` / `-f` skips it.

Out of scope: types where AWS doesn't expose a synchronous "flip
protection off" API call (CloudFront Distributions, Lambda function
reserved concurrency, S3 bucket retention, etc.).

## `publish-assets`: synth + build + publish, no deploy

`cdkd publish-assets` runs the asset half of the deploy pipeline
only — synthesize, build Docker images, upload file assets to S3,
push images to ECR — and stops. No state writes, no provisioning.
Typical CI split where one runner builds + uploads assets and a
separate runner deploys.

```bash
cdkd publish-assets                  # all stacks (or auto-detect single stack)
cdkd publish-assets MyStack          # specific stack
cdkd publish-assets -a cdk.out       # skip synth, use pre-synthesized assembly
```

See [docs/cli-reference.md](docs/cli-reference.md#publish-assets-synth--build--publish-no-deploy)
for stack-selection rules and concurrency knobs.

## State Management

State is stored in S3 with optimistic locking via S3 Conditional Writes
(no DynamoDB required). Keys are scoped by `(stackName, region)` so the
same stack deployed to two regions has two independent state files.

| Setting | CLI | cdk.json | Env var | Default |
|---------|-----|----------|---------|---------|
| Bucket | `--state-bucket` | `context.cdkd.stateBucket` | `CDKD_STATE_BUCKET` | `cdkd-state-{accountId}` (legacy `cdkd-state-{accountId}-{region}` is still read with a deprecation warning — run `cdkd state migrate` to consolidate) |
| Prefix | `--state-prefix` | - | - | `cdkd` |

The state bucket is shared across all CDK apps in the same account by
default. To isolate apps, pass different `--state-prefix` values.
`cdkd destroy --all` only targets stacks from the current CDK app
(determined by synthesis), not all stacks in the bucket.

See **[docs/state-management.md](docs/state-management.md)** for the full
spec: S3 key layout, optimistic-locking mechanism (ETag-based), state
schema, legacy `version: 1` migration, bucket-name migration via
`cdkd state migrate`, and troubleshooting.

## Stack Outputs

CDK's `CfnOutput` constructs are resolved and stored in the state file:

```typescript
// In your CDK code
new cdk.CfnOutput(this, 'BucketArn', {
  value: bucket.bucketArn,  // Uses Fn::GetAtt internally
  description: 'ARN of the bucket',
});
```

After deployment, outputs are resolved and printed at the end of `cdkd deploy` (matching CDK CLI's format) and saved to the S3 state file:

```text
Deployment Summary:
  Stack: MyStack
  ...
  Duration: 21.25s

Outputs:
  MyStack.BucketArn = arn:aws:s3:::actual-bucket-name-xyz

✓ Deployment completed successfully
```

```json
{
  "outputs": {
    "BucketArn": "arn:aws:s3:::actual-bucket-name-xyz"
  }
}
```

**Key differences from CloudFormation**:

- CloudFormation: Outputs accessible via `aws cloudformation describe-stacks`
- cdkd: Outputs saved in S3 state file (e.g., `s3://bucket/cdkd/MyStack/us-east-1/state.json`)
- Both print outputs to stdout after a successful deploy
- Both resolve intrinsic functions (Ref, Fn::GetAtt, etc.) to actual values

## Exit codes

cdkd commands distinguish three outcomes via the process exit code so
CI / bench scripts can react without grepping log output:

| Exit | Meaning |
|------|---------|
| `0` | Success — command completed and no resources are in an error state |
| `1` | Command-level failure — auth error, bad arguments, synth crash, unhandled exception |
| `2` | **Partial failure** — work completed but one or more resources failed (state.json is preserved, re-running typically resolves it) |

Exit `2` is currently emitted by `cdkd destroy` and `cdkd state
destroy` when one or more per-resource deletes fail. The summary line
also switches from `✓ Stack X destroyed` to `⚠ Stack X partially
destroyed (...). State preserved — re-run 'cdkd destroy' / 'cdkd
state destroy' to clean up.` so the visual marker matches the exit
code.

## License

Apache 2.0
