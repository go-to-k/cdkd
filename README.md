# cdkd (CDK Direct)

[![npm version](https://img.shields.io/npm/v/@go-to-k/cdkd.svg)](https://www.npmjs.com/package/@go-to-k/cdkd)
[![Downloads](https://img.shields.io/npm/dw/@go-to-k/cdkd.svg)](https://www.npmjs.com/package/@go-to-k/cdkd)
[![License: Apache-2.0](https://img.shields.io/npm/l/@go-to-k/cdkd.svg)](./LICENSE)

Drop-in CDK CLI for existing CDK apps — up to 15x faster deploys via direct AWS SDK calls instead of CloudFormation.

- **Drop-in CDK compatible**: your existing CDK app code runs as-is.
- **Up to 15x faster deploys**: direct SDK calls, aggressive parallelization, and `--no-wait` to skip slow stabilization waits.

![cdk deploy vs cdkd deploy — side-by-side, 35s recording, real AWS deploy. cdkd finishes while cdk is still creating its CloudFormation changeset.](assets/cdk-vs-cdkd.gif)

**cdkd complements the AWS CDK CLI rather than replacing it.** Use cdkd in dev/test for rapid iteration and local execution; use the AWS CDK CLI in production for full CloudFormation tooling. Install cdkd alongside an existing `cdk deploy` workflow: no migration needed. Bidirectional migration is also supported: [import](#importing-existing-resources) into cdkd or [export](#exporting-a-stack-back-to-cloudformation) back to CloudFormation when ready.

**A natural fit for AI-driven development.** AI coding agents iterate in tight spin-up / tear-down loops — and cdkd keeps each turn short, with fast deploys and an equally fast `cdkd destroy` that deletes via direct SDK calls instead of polling a CloudFormation stack-delete.

> [!IMPORTANT]
> cdkd is for dev/test workflows only — early in development, not yet production-ready.

## Benchmark

**cdkd deploys up to 15x faster than AWS CDK (CloudFormation)** on SDK-Provider-handled stacks; the per-stack speedup widens with size and parallelism, and drops to ~1.5-3x on stacks dominated by Cloud Control API fallback resources.

Numbers below are deploy-phase only (CDK app synthesis is identical between cdkd and AWS CDK — both run the same user code through `aws-cdk-lib`'s synthesizer — so synth time is excluded from the speedup calculation).

### vs CloudFormation Express mode — faster than CloudFormation's own fast-deploy option

CloudFormation's [Express mode](https://aws.amazon.com/about-aws/whats-new/2026/06/aws-cloudformation-cdk/) is a fast-deploy option that skips resource stabilization waits, similar in spirit to cdkd's `--no-wait`. Even so, cdkd is faster than Express on nearly every stack, and with `--no-wait` it pulls dramatically ahead on stacks dominated by async resources.

| Stack | Normal (CFn) | Express | cdkd | cdkd `--no-wait` |
| --- | ---: | ---: | ---: | ---: |
| VPC + Lambda + SQS + CloudFront | 562 | 366 | 197 | **40** |
| DynamoDB | 34 | 34 | 19 | 15 |
| DynamoDB + KMS | 71 | 55 | 27 | 27 |
| EC2 | 44 | 31 | 27 | 26 |
| Lambda | 55 | 34 | 23 | 22 |
| S3 | 39 | 22 | 23 | 24 |
| SQS | 83 | 22 | **9** | 9 |
| SQS + CloudWatch | 87 | 44 | 30 | 31 |

Best of 3 runs, deploy-phase only, seconds, `us-west-2`. The `VPC + Lambda + SQS + CloudFront` stack is 1 VPC (2 AZs, NAT Gateway, public + private subnets) + VPC Lambda + Lambda Function URL + CloudFront Distribution + SQS + EventSourceMapping + Consumer Lambda.

- **~1.5–2x faster than Express on most stacks** — e.g. SQS finishes in 9s vs Express's 22s (~2.4x).
- **Async-heavy stacks are where the gap explodes.** On the VPC + CloudFront stack, `cdkd --no-wait` finishes in 40s vs Express's 366s (~9x) — cdkd returns as soon as each create call returns, leaving CloudFront propagation and NAT Gateway stabilization to complete in the background.
- **S3 is the one case where Express edges cdkd's default** (22s vs 23s). On a near-instant single-resource stack there is little left to parallelize, and `--no-wait` makes no difference there.

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
- **Local execution** (`cdkd local invoke` / `start-api` / `run-task` / `start-service` / `start-alb` / `start-cloudfront` / `invoke-agentcore` / `start-agentcore`): run Lambdas, API Gateway routes, ECS tasks, long-running ECS services, CloudFront distributions, and Bedrock AgentCore Runtimes from your CDK code. All AWS Lambda runtimes, container Lambdas, REST v1 / HTTP v2 / Function URL routes, Service Connect / Cloud Map, AgentCore HTTP / MCP / A2A / AGUI / WebSocket protocols (one-shot `invoke-agentcore` and long-running warm serve via `start-agentcore`, which serves the native contract — `POST /invocations` + `GET /ping`, MCP `/mcp`, A2A `/` — plus the `/ws` bridge for HTTP / AGUI). The Docker-backed commands work for both `cdkd deploy`-managed (`--from-state`) AND `cdk deploy`-managed (`--from-cfn-stack`) stacks; `start-cloudfront` serves the viewer-request -> S3 / Lambda Function URL origin -> viewer-response pipeline (CloudFront-Functions + S3-only distributions run in-process with no Docker). See [Local execution](#local-execution).
- **Bidirectional CloudFormation migration**: `cdkd import --migrate-from-cloudformation` adopts existing CFn stacks (including `cdk deploy`-managed) into cdkd state without re-creating resources; `cdkd export` hands a cdkd stack back to CloudFormation when production-ready. See [Importing](#importing-existing-resources) / [Exporting](#exporting-a-stack-back-to-cloudformation).

> **Note**: Resource types not covered by either SDK Providers or Cloud Control API cannot be deployed with cdkd. Deployment fails with a clear error message naming the type + a 1-click issue link.

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
│ Asset Build &   │  S3 ZIP upload / ECR image build & push
│   Publish       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ cdkd Engine     │
│ - DAG Analysis  │  Dependency graph construction
│ - Diff Calc     │  Compare with existing resources
│ - Parallel Exec │  Dispatch on deps complete (no level barrier)
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

## Prerequisites

- **Node.js** >= 20.0.0
- **AWS credentials with admin-equivalent permissions** for the resources being deployed. cdkd does NOT route through CloudFormation, so CDK CLI's `cdk-hnb659fds-deploy-role-*` is NOT sufficient — see [`--role-arn`](docs/cli-reference.md).

AWS CDK's `cdk bootstrap` is not required. Instead, run `cdkd bootstrap` once per
account: it creates everything cdkd needs, and per-region asset storage is added
automatically on the first `cdkd deploy` into each region. Existing setups,
legacy-mode opt-outs, and how this relates to `cdk bootstrap`: see
[Upgrading from an earlier cdkd version](#upgrading-from-an-earlier-cdkd-version).

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
> resources, plus cdkd-owned asset storage for the region
> (by default a `cdkd-assets-{accountId}-{region}` bucket +
> `cdkd-container-assets-{accountId}-{region}` ECR repo — custom names via
> `--asset-bucket` / `--container-repo`, skip with `--no-assets`; see
> [`cdkd bootstrap`](docs/cli-reference.md#cdkd-bootstrap)).
> This replaces `cdk bootstrap`, which cdkd does not require — see
> [Prerequisites](#prerequisites).

```bash
# Bootstrap (creates S3 state bucket + asset storage — one-time setup per AWS account)
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

### Upgrading from an earlier cdkd version

**No breaking change, no manual step: just deploy.** The first `cdkd deploy` into
each region auto-creates the cdkd-owned asset storage (interactive runs are asked
once per region, `--yes` / CI runs create it automatically) and shows a one-time
in-place UPDATE repointing asset references — content identical, no replacement.
Downgrading is safe too (older binaries ignore the marker). Explicit pre-provisioning
(`cdkd bootstrap --region <r>`), legacy-mode opt-outs, and how this relates to
`cdk bootstrap`: see [`cdkd bootstrap`](docs/cli-reference.md#cdkd-bootstrap).

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
- **`cdkd local ...` subcommands** (`local invoke` / `start-api` /
  `run-task` / `start-service`) run synthesized workloads locally
  inside Docker containers — no AWS deploy needed. Modeled on
  `sam local *` but reads CDK state directly via `--from-state`
  (cdkd-managed) or `--from-cfn-stack` (CFn-managed). See
  [Local execution](#local-execution).

Options like `--app`, `--state-bucket`, and `--context` can be omitted if configured via `cdk.json` or environment variables (`CDKD_APP`, `CDKD_STATE_BUCKET`).

```bash
# Synth + deploy
cdkd synth
cdkd deploy                         # single-stack auto-detected
cdkd deploy MyStack                 # by name (or 'MyStage/Api' display path)
cdkd deploy --all
cdkd deploy --dry-run               # plan only, no changes
cdkd deploy --no-rollback           # Terraform-style: keep partial state on failure
cdkd deploy --no-wait               # skip multi-minute waits (CloudFront / RDS / NAT)

# Inspect what would change
cdkd diff MyStack
cdkd diff MyStack --fail            # exit 1 on any change (CI gate)

# Drift detection — compare state vs AWS reality (no synth)
cdkd drift MyStack                  # exit 1 if drift
cdkd drift MyStack --accept --yes   # state ← AWS
cdkd drift MyStack --revert --yes   # AWS ← state

# Asset / destroy / unlock
cdkd publish-assets                 # synth + upload only (typical CI split)
cdkd destroy MyStack
cdkd orphan MyStack/MyBucket        # drop one resource from state (AWS resource stays)
cdkd force-unlock MyStack           # clear stale lock from an interrupted deploy
cdkd gc --dry-run                   # reclaim unreferenced cdkd-owned assets (S3 + ECR)

# Migrate between cdkd and CloudFormation
cdkd import MyStack --yes           # adopt existing AWS resources into cdkd state
cdkd export MyStack                 # hand a cdkd-managed stack back to CloudFormation

# State-bucket-only commands (no CDK app needed)
cdkd state info                     # bucket name, region, schema version
cdkd state list                     # one row per (stackName, region)
cdkd state list --tree              # parent → child nested-stack tree
cdkd state show MyStack             # full state record
cdkd state resources MyStack        # logical id / type / physical id
cdkd state destroy MyStack          # delete AWS resources + state, no CDK app
cdkd state orphan MyStack           # remove state record only (AWS resources stay)
```

See **[docs/cli-reference.md](docs/cli-reference.md)** for the full flag
matrix (`--concurrency`, `--no-aggressive-vpc-parallel`,
`--allow-unsupported-properties`, `--role-arn`, etc.), per-command details
including the synth-driven per-resource `cdkd orphan <constructPath>`
variant, and stage / wildcard pattern matching.

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
| `cdkd local invoke-agentcore <target>` | One-shot Bedrock AgentCore Runtime invoke (HTTP `/invocations` / MCP `/mcp` / A2A `/a2a` / AGUI / WebSocket `--ws`) |
| `cdkd local start-agentcore [target]` | Long-running serve of a Bedrock AgentCore Runtime against a warm container (all four protocols): HTTP / AGUI serve `POST /invocations` + `GET /ping` plus the `/ws` bridge (injects the session-id / Authorization a header-less browser client cannot set); MCP serves `/mcp`, A2A serves `/`. `--sigv4` / `--watch` supported |
| `cdkd local start-alb <targets...>` | Long-running local ALB front-door (HTTP + HTTPS listeners, path / host / header / weighted / redirect / fixed-response routing, authenticate-cognito / authenticate-oidc) for ECS / Lambda backing services |
| `cdkd local start-cloudfront [target]` | Long-running local CloudFront distribution — viewer-request -> S3 / Lambda Function URL origin -> viewer-response pipeline, CloudFront Functions run in-process (Function URL origins use Docker/RIE) |

The Docker-backed commands above require Docker. Pass `--from-state`
(cdkd-deployed) or `--from-cfn-stack` (cdk-deployed / CFn-managed) to
substitute deployed physical IDs into intrinsic-valued env vars /
secrets / image URIs; without either, intrinsic values are dropped with
a per-key warning (matches `sam local *`). The two flags are mutually
exclusive. `start-cloudfront` carries both `--from-state` and
`--from-cfn-stack` too (since cdk-local 0.128.0 / issue #766); a
CloudFront-Functions + S3-origin distribution still serves entirely
in-process (no Docker), while a Lambda Function URL origin runs via the
RIE container.

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

# Typical shape — the bare `--from-cfn-stack` flag auto-resolves to the
# routed stack's name (here `MyStack`). Pass an explicit value only when
# the deployed CFn stack name differs from the CDK stack name.
cdkd local start-api MyStack/MyHttpApi --from-cfn-stack
```

REST v1 + HTTP API v2 + Function URL with all integration kinds
(AWS_PROXY / MOCK / HTTP_PROXY / HTTP / AWS Lambda non-proxy via
hand-rolled VTL), authorizers (Lambda / Cognito / HTTP v2 JWT /
AWS_IAM SigV4 on REST v1 + Function URL), CORS, stage variables,
`--watch` hot reload.

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
cdkd local start-service MyStack/Web --watch         # hot reload (sub-second on interpreted handlers)
```

Long-running ECS Service emulator: `DesiredCount` replicas with
restart-on-exit, cross-service Service Connect / Cloud Map DNS
discovery (peer containers reach each other by `<discoveryName>.<namespace>`).
No local load-balancer in v1. `--watch` re-synths on every CDK source edit
and reloads one replica at a time — source-only edits on
interpreted-language handlers (Node / Python / Ruby / shell) take a
bind-mount fast path (`docker cp` + `docker restart`; no rebuild);
Dockerfile / dependency manifest / compiled-language source edits fall
through to a full rebuild + shadow boot + atomic swap.

### `local start-alb`

```bash
cdkd local start-alb MyStack/MyAlb --lb-port 80=8080 # remap privileged listener port
cdkd local start-alb MyStack/MyAlb --from-state      # OR --from-cfn-stack
cdkd local start-alb MyStack/MyAlb --watch           # hot reload (sub-second on interpreted handlers)
```

Long-running local ALB front-door: names an `AWS::ElasticLoadBalancingV2::LoadBalancer`,
boots every ECS service behind its listeners, and stands up a local
HTTP / HTTPS front-door on each listener port that round-robins across
the running replicas and routes its listener rules across the backing
services. Forward / redirect / fixed-response actions; ECS or Lambda
targets; authenticate-cognito / authenticate-oidc via a local Bearer-JWT
check. `--watch` reloads one backing-replica at a time across edits —
interpreted-handler source edits go through the bind-mount fast path
(no rebuild); Dockerfile / dependency / compiled-source edits fall
through to a rebuild + atomic front-door pool swap.

### `local start-cloudfront`

```bash
cdkd local start-cloudfront                          # interactive picker
cdkd local start-cloudfront MyStack/MyDistribution   # name the distribution
cdkd local start-cloudfront MyStack/MyDistribution --watch   # re-synth + swap on edit
cdkd local start-cloudfront MyStack/MyDistribution --tls      # real HTTPS termination
```

Serves a CloudFront distribution's **viewer-request -> S3 origin ->
viewer-response** pipeline locally so a routing-function change is
verifiable in seconds instead of a deploy round-trip. The distribution's
`AWS::CloudFront::Function`s (URL rewrites, trailing-slash normalization,
SPA fallback, header tweaks) run in-process in a `node:vm` sandbox; the
S3 origin content is the `BucketDeployment` source asset resolved out of
the cloud assembly, served with `DefaultRootObject` and
`CustomErrorResponses`. Path patterns route across the default + ordered
cache behaviors. Pure-local: no Docker, no AWS call — `--watch` is just
re-synth + an in-memory routing-model swap. S3 origins only (custom /
Lambda@Edge origins are warn-and-skip); `--origin <id>=<dir>` points an
origin at a local directory when `BucketDeployment` resolution can't.

See **[docs/local-emulation.md](docs/local-emulation.md)** for the
full reference — runtimes, target resolution, every flag, integration
and authorizer detail, route precedence, container pool, networking,
`--from-cfn-stack` semantics, v1 scope.

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
# Adopt a whole stack, resolving each resource from its template name property.
# NOTE: the aws:cdk:path tag fallback does not match on real AWS (see #1128), so
# resources whose physical name CloudFormation generated come back "not found".
# To adopt a cdk deploy-managed stack, prefer --migrate-from-cloudformation below.
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

## Compatibility

cdkd supports the standard CloudFormation surface — intrinsic functions,
pseudo parameters, parameters / conditions, cross-stack / cross-region
references, asset publishing, custom resources, and so on. See
**[docs/supported-features.md](docs/supported-features.md)** for the
full reference. For per-resource-type provisioning support (SDK Providers
vs Cloud Control API fallback), see
**[docs/supported-resources.md](docs/supported-resources.md)**.

**Property-level coverage is incremental.** SDK Providers wire most but not every CFn property of a supported type. cdkd fails fast at pre-flight when a template uses a not-yet-implemented property, with the property name + a 1-click issue link. `--allow-unsupported-properties <Type>:<Prop>,...` is the safety valve when this is too strict (e.g. mid-life update on an existing resource); avoid it on security-meaningful properties (encryption / IAM / TLS). See [docs/cli-reference.md](docs/cli-reference.md#--allow-unsupported-properties-deploy).

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

## Deployment events (`cdkd events`)

Every `cdkd deploy` / `cdkd destroy` run records a structured event
stream to S3 — cdkd's local equivalent of CloudFormation's
`DescribeStackEvents`. Read it back with `cdkd events <stack>`:

```bash
cdkd events MyStack                 # list runs, newest first
cdkd events MyStack --run <runId>   # one run's full event stream
cdkd events MyStack --format json   # machine-readable (AI-agent hand-off)
cdkd events prune MyStack --all     # purge event history (reclaim S3 space)
cdkd destroy MyStack --purge-events # destroy + purge events in one command
```

Events are persisted as JSONL under a `deployments/` key family separate
from `state.json` (no state schema bump), so a destroyed stack's failure
history stays readable. Recording is best-effort and never blocks the
run; events carry error + metadata only (never resource properties). The
store self-bounds to the last 20 runs, `cdkd events prune` purges old
history on demand (`--keep N` / `--older-than <dur>` / `--all`), and
`cdkd destroy --purge-events` deletes a stack's history right after a clean
destroy so the bucket returns fully empty. See
**[docs/deployment-events.md](docs/deployment-events.md)** for the full
reference.

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
