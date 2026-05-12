# cdkd (CDK Direct)

Drop-in CDK CLI for existing CDK apps — faster deploys via AWS SDK instead of CloudFormation, with local emulation for Lambda, API Gateway, and ECS.

- **Drop-in CDK compatible** — your existing CDK app code runs as-is.
- **Up to 15x faster deploys than the AWS CDK CLI (CloudFormation)**
- **Run AWS resources locally without deploying** — invoke Lambdas, run ECS tasks, and serve API Gateway routes from Docker.

![cdkd demo](https://github.com/user-attachments/assets/0128730d-186d-4bd3-abea-aabc80ba4dd5)

> **⚠️ WARNING: NOT PRODUCTION READY**
>
> An experimental project exploring direct SDK provisioning as an alternative to the AWS CDK CLI — **NOT a replacement** and **NOT suitable for production use**. Features are incomplete, APIs may change without notice, and bugs may affect your AWS infrastructure. Use at your own risk in development / testing environments only.

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
- **Local execution without deploying** (`cdkd local invoke` / `cdkd local start-api` / `cdkd local run-task`): run any Lambda — stand up every API Gateway route as a local HTTP server — or start every container in an `AWS::ECS::TaskDefinition` on a per-task docker network with the AWS-published metadata-endpoints sidecar. SAM-compatible mental model but reuses cdkd's synthesis / asset / route-discovery (no `template.yaml` round-trip). All AWS Lambda runtimes (Node.js / Python / Ruby / Java / .NET / `provided.*`) and one server per discovered API (HTTP API v2 / REST v1 / Function URL) with their own port / authorizers / CORS configs. `local run-task` is Phase 1 (single task, DependsOn ordering, IAM task-role via AssumeRole) — ECS Services / ALB routing / Service Connect are Phase 2 / Phase 3 follow-ups. `cdkd local run-task --from-state` substitutes intrinsic-valued container `Environment[].Value` (`Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::Join`) and `Secrets[].ValueFrom` against the deployed cdkd state — `table.tableName` / `ecs.Secret.fromSecretsManager(secret)` / `ecs.Secret.fromSsmParameter(param)` Just Work locally instead of silently dropping.

> **Note**: Resource types not covered by either SDK Providers or Cloud Control API cannot be deployed with cdkd. If you encounter an unsupported resource type, deployment will fail with a clear error message.

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
- **`cdkd local ...` subcommands** (`local invoke`, `local start-api`)
  run synthesized Lambda functions locally inside Docker containers that
  bundle the AWS Lambda Runtime Interface Emulator (RIE). `local invoke`
  runs a single Lambda once; `local start-api` stands up a long-running
  HTTP server that maps API Gateway / HTTP API / Function URL routes to
  local Lambda invocations. No AWS API calls, no state bucket needed.

Options like `--app`, `--state-bucket`, and `--context` can be omitted if configured via `cdk.json` or environment variables (`CDKD_APP`, `CDKD_STATE_BUCKET`).

```bash
# Bootstrap (create S3 bucket for state)
cdkd bootstrap \
  --state-bucket my-cdkd-state \
  --region us-east-1

# Synthesize only
cdkd synth --app "npx ts-node app.ts"

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
  --app "npx ts-node app.ts" \
  --state-bucket my-cdkd-state \
  --verbose

# Show diff (what would change)
cdkd diff MyStack

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

# List resources of a single stack from state
cdkd state resources MyStack          # aligned columns: LogicalID, Type, PhysicalID
cdkd state resources MyStack --long   # per-resource block with dependencies and attributes
cdkd state resources MyStack --json   # full JSON array

# Show full state record for a stack (metadata, outputs, all resources incl. properties)
cdkd state show MyStack
cdkd state show MyStack --json        # raw {state, lock} JSON

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

## Importing existing resources

`cdkd import` adopts AWS resources that are already deployed (via
`cdk deploy`, manual creation, or another tool) into cdkd state so the
next `cdkd deploy` updates them in-place instead of CREATEing duplicates.

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
stack over to CloudFormation via a CFn `ChangeSetType=IMPORT` changeset.
AWS resources are unchanged across the migration; cdkd state for the
exported stack is deleted on success. From then on the stack is managed
by `cdk deploy` / `aws cloudformation`.

```bash
cdkd export MyStack                           # confirmation prompt; CFn stack name = cdkd stack name
cdkd export MyStack --cfn-stack-name MyStack-CFn
cdkd export MyStack --dry-run                 # print the import plan, do not call CFn
cdkd export MyStack --template path.json      # skip synth, use a pre-rendered JSON template
```

MVP scope: JSON templates only (CDK-generated). The command refuses to
proceed if any resource is not CFn-importable (Lambda-backed Custom
Resources, nested `AWS::CloudFormation::Stack` references); destroy or
accept abandoning those resources first.

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

## Stack-name prefix on physical names

cdkd prepends the **stack name** to physical names you declare in CDK
code: `new iam.Role(this, 'CRRole', { roleName: 'my-role' })` in stack
`MyStack` is created in AWS as `MyStack-my-role`. The prefix protects
cross-stack uniqueness (two stacks declaring `roleName: 'my-role'`
otherwise collide on a single AWS account). Pre-PR this behavior was
**inconsistent**: only IAM Role / User / Group / InstanceProfile and
ELBv2 LoadBalancer / TargetGroup actually got the prefix; Lambda, S3,
SNS, SQS, DynamoDB, etc. used the user's declared name as-is.

`cdkd deploy --no-prefix-user-supplied-names` opts in to skipping
the prefix on user-declared physical names, making cdkd consistent
across all resource types. Off by default for backward compatibility.

| | Default (no flag) | `--no-prefix-user-supplied-names` |
| --- | --- | --- |
| `new iam.Role({ roleName: 'my-role' })` | `MyStack-my-role` | `my-role` |
| `new s3.Bucket({ bucketName: 'my-bucket' })` | `my-bucket` (already no prefix — Pattern A) | `my-bucket` (unchanged) |
| `new iam.Role(...)` (no `roleName`) | `MyStack-CRRole-<hash>` (auto-generated, prefix kept for uniqueness) | `MyStack-CRRole-<hash>` (unchanged) |

Resolution chain (highest wins): `--no-prefix-user-supplied-names`
CLI flag → `CDKD_NO_PREFIX_USER_SUPPLIED_NAMES=true` env var →
`cdk.json` `context.cdkd.noPrefixUserSuppliedNames: true` → default
`false`.

Affects `cdkd deploy` only. Already-deployed stacks deployed under
the legacy prefixed-name scheme keep working — the flag only controls
what AWS resource cdkd creates on **future** deploys. Switching the
flag mid-flight on an existing stack would propose REPLACEMENT on
every Pattern B resource (the existing AWS resource has the prefixed
name; the new template intent has the un-prefixed name).

Surfaced by [PR #285 `cdkd export`](https://github.com/go-to-k/cdkd/pull/285)
where the CFn IMPORT changeset's identifier check would fail on a
synth `RoleName: 'my-role'` vs the AWS-deployed `MyStack-my-role`;
the export command currently overlays `ResourceIdentifier` onto
`Properties` to bridge the gap. A future major-version PR will flip
the default of `--no-prefix-user-supplied-names` to `true`, after
which the overlay can be dropped.

## `--remove-protection`: one-shot bypass for protected resources

CDK's `new Stack(app, 'X', { terminationProtection: true })` is honored
by `cdkd destroy` (refused before any per-resource delete). The
state-only path `cdkd state destroy` does NOT honor it — that's the
explicit "I know what I'm doing, ignore CDK guards" escape hatch.

For resource-level protection (`DeletionProtection` etc.), the standard
workflow is edit CDK → redeploy → destroy. `--remove-protection` is the
one-shot bypass:

`cdkd destroy --remove-protection` and `cdkd state destroy
--remove-protection` flip every protection flag off in-place
before each provider's delete API call so the destroy proceeds
without an intermediate edit / redeploy. The flag covers both
stack-level `terminationProtection` (the bypass logs a WARN line
naming the stack) and resource-level protection on the following
types:

| Resource type | Protection field |
| --- | --- |
| `AWS::Logs::LogGroup` | `DeletionProtectionEnabled` |
| `AWS::RDS::DBInstance` | `DeletionProtection` |
| `AWS::RDS::DBCluster` | `DeletionProtection` |
| `AWS::DocDB::DBCluster` | `DeletionProtection` (DocDB DBInstance has no `DeletionProtection` field, so per-instance bypass is a no-op) |
| `AWS::Neptune::DBCluster` | `DeletionProtection` |
| `AWS::Neptune::DBInstance` | `DeletionProtection` |
| `AWS::DynamoDB::Table` | `DeletionProtectionEnabled` |
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

## `local invoke`: run Lambda functions locally

`cdkd local invoke <target>` runs a Lambda function from a CDK app on the
developer's machine, inside a Docker container that bundles the AWS
Lambda Runtime Interface Emulator (RIE). Modeled on `sam local invoke`
but reusing cdkd's synthesis / asset / construct-path plumbing — no
`template.yaml` to maintain, no `cdk synth | sam ...` round-trip.

Requires Docker. Supports every current AWS Lambda runtime
(`nodejs18.x` / `nodejs20.x` / `nodejs22.x` / `nodejs24.x` / `python3.11` /
`python3.12` / `python3.13` / `python3.14` / `ruby3.2` / `ruby3.3` /
`java8.al2` / `java11` / `java17` / `java21` / `dotnet6` / `dotnet8` /
`provided.al2` / `provided.al2023`). The deprecated `go1.x` runtime is
rejected with a migration pointer to `provided.al2023`. Java, .NET, and
`provided.*` Lambdas are **asset-backed only** — the Handler shape names
a compiled artifact (`package.Class::method` for Java's JVM class;
`Assembly::Namespace.Class::Method` for .NET's CLR assembly; an
arbitrary `bootstrap` binary for the OS-only `provided.*` runtimes), so
use `lambda.Code.fromAsset(<dir>)` with a directory containing the
compiled output (`.class` hierarchy / `.jar` / `.dll` / native binary);
inline `Code.ZipFile` is rejected with a clear routing message.

**Container Lambdas** — `lambda.DockerImageFunction(...)` /
`Code.ImageUri` is supported alongside ZIP Lambdas. cdkd reads the
function's local `Dockerfile` from `cdk.out` and runs `docker build`
locally before invoking. When no asset matches (typically: invoking a
stack deployed elsewhere), cdkd falls back to `docker pull` from
ECR — same-account / same-region only in v1; cross-account /
cross-region is not yet supported. `Architectures: [x86_64]` /
`[arm64]` are honored via `--platform` so an arm64 host running an
x86_64 Lambda doesn't hit emulation.

```bash
# Invoke by CDK display path (single-stack apps may omit the prefix)
cdkd local invoke MyStack/MyApi/Handler
cdkd local invoke MyStack:MyApiHandler1234ABCD       # logical-id form

# Pass an event payload
cdkd local invoke MyStack/Handler --event events/get.json
echo '{"path":"/"}' | cdkd local invoke MyStack/Handler --event-stdin

# Override env vars (SAM-compatible shape: {"LogicalId":{"KEY":"VALUE"}}
# plus an optional top-level "Parameters" block applied to every invoke)
cdkd local invoke MyStack/Handler --env-vars env.json

# Skip docker pull when iterating
cdkd local invoke MyStack/Handler --no-pull

# Skip the local docker build for container Lambdas (Code.ImageUri).
# Reuses the deterministic cdkd-local-invoke-<hash> tag from a prior
# build. Errors clearly when the tag is missing.
cdkd local invoke MyStack/ContainerHandler --no-build

# Run with the deployed function's narrow execution role (otherwise the
# developer's shell credentials are forwarded — SAM-compatible default)
cdkd local invoke MyStack/Handler --assume-role arn:aws:iam::123456789012:role/MyApi-handler-role

# Attach a Node debugger
cdkd local invoke MyStack/Handler --debug-port 9229

# After `cdkd deploy`, recover intrinsic-valued env vars (Ref / Fn::GetAtt
# / Fn::Sub) from cdkd's S3 state instead of dropping them. Off by default
# — keeps the local-only / unscoped flow safe; opt in when you want the
# handler to see the deployed physical IDs (S3 bucket names, DDB table
# names, IAM role ARNs, ...). Disambiguate with `--stack-region <region>`
# when the same stack name has state in multiple regions.
cdkd local invoke MyStack/Handler --from-state
```

**Lambda Layers** — same-stack
`AWS::Lambda::LayerVersion` references in `Properties.Layers` are
resolved automatically and bind-mounted at `/opt` (read-only) inside
the container. Each layer's unzipped asset directory under `cdk.out/`
becomes one `-v <layerAssetPath>:/opt:ro` mount; multiple layers
stack via Docker overlay layering, and AWS's "last layer wins on
file collision" rule is preserved by keeping the template's input
order. Cross-stack / cross-account / cross-region layer ARNs (literal
ARN strings in `Properties.Layers`) are out of scope for v1 — cdkd
hard-errors with a clear pointer at the offending entry. Container
Lambdas (`Code.ImageUri`) silently ignore `Layers` (matches AWS:
container images bake layers at build time).

See [docs/cli-reference.md](docs/cli-reference.md#local-invoke-run-lambda-functions-locally)
for the full surface, target-resolution rules, and v1 scope notes.

## `local start-api`: long-running local API server

`cdkd local start-api` stands up a long-running local HTTP server that
maps the synthesized API Gateway routes (REST v1, HTTP API, Function
URL) to local Lambda invocations against the same RIE-backed Docker
containers `cdkd local invoke` uses. Modeled on `sam local start-api`
but reusing cdkd's synthesis / route-discovery plumbing.

```bash
# Auto-allocate one port PER discovered API (printed at startup)
cdkd local start-api

# Pin the FIRST server to port 3000; subsequent APIs get 3001, 3002, ...
cdkd local start-api --port 3000

# Restrict to a single API by its CDK logical id (HTTP API / REST API logical
# id, or the backing Lambda's logical id for Function URLs)
cdkd local start-api --api MyAdminApi

# Pre-warm one container per Lambda at server boot — eliminates first-request cold start
cdkd local start-api --warm

# Override env vars per-Lambda (SAM-shape file)
cdkd local start-api --env-vars env.json

# Pin the deployed execution role per Lambda (or globally with a bare ARN)
cdkd local start-api --assume-role MyApiHandler=arn:aws:iam::123:role/handler-role

# Hot reload — re-synth + re-discover routes when cdk.out/ or asset dirs change
cdkd local start-api --watch

# Select a specific API Gateway Stage (default: the first attached)
cdkd local start-api --stage prod
```

**One server per API** (since v0.81): every discovered API surface gets its
own HTTP server on its own port, so authorizers, CORS configs, and stage
variables stay scoped to the owning API and never bleed across APIs that
happen to share a path. `cdkd local start-api` prints one
`Server listening on http://<host>:<port>  (<API> (<kind>))` line per
server at startup; pass `--api <id>` to launch only one of them.

Scope: REST v1 + HTTP API + Function URL with AWS_PROXY integrations.
Authorizers (Lambda TOKEN/REQUEST + Cognito User Pool + HTTP v2 JWT),
VPC-config Lambda warnings, CORS preflight, hot reload, and stage
variables are supported. WebSocket APIs are not.

**Authorizers**: `Authorization: Bearer <token>`-protected
routes are gated on the authorizer Lambda's response (TOKEN / REQUEST
authorizers, IAM-policy or HTTP v2 simple shape) or on a JWKS-based JWT
verification (Cognito User Pool authorizers, HTTP v2 JWT authorizers).
When the JWKS endpoint is unreachable from the dev machine, cdkd falls
back to **pass-through mode** (every JWT accepted, with a warn line at
startup) — local-dev-only fallback so a corporate proxy doesn't block
iteration. **Do NOT rely on this in any shared environment.**

**VPC-config Lambdas**: handlers with `Properties.VpcConfig`
still run locally, but the local container is NOT attached to the
deployed VPC's subnets — calls to private RDS / ElastiCache will fail.
cdkd warns at startup naming each affected Lambda; AWS SDK calls still
reach public AWS endpoints via the dev's network as usual.

**Hot reload (`--watch`)**: re-runs the synth → discover → spec-build
pipeline whenever `cdk.out/` or any of the routed Lambdas' asset
directories change. Routes added / removed / changed swap in
atomically without restarting the HTTP server; in-flight requests
complete against the old container pool while the new pool warms.
Synth failures are non-fatal — the previous version keeps serving and
a warn line names the failure. Off by default; pass `--watch` to
enable.

**CORS preflight**: HTTP API v2 OPTIONS preflight requests are
intercepted when the API has a `CorsConfiguration` block. The server
matches the request's `Origin` / `Access-Control-Request-Method` /
`Access-Control-Request-Headers` against the configured allowlist and
returns a `204 No Content` with the canonical `Access-Control-Allow-*`
headers. Preflight handling is skipped when the user has registered
an explicit OPTIONS method (their Lambda owns it). REST v1 CORS (Mock
OPTIONS method) is not auto-handled and stays out of scope; use the
deployed API for that case.

**Stage variables**: `event.stageVariables` is populated from the
selected Stage's `Variables` (REST v1) / `StageVariables` (HTTP API
v2) map. Default selection is the first Stage attached to each API;
pass `--stage <name>` to pick a Stage by `StageName`. Function URL
routes don't have a Stage — `event.stageVariables` stays `null`.

See [docs/cli-reference.md](docs/cli-reference.md#local-start-api-long-running-local-api-server)
for the full route-discovery rules, container-pool semantics, exit
codes, and per-authorizer-kind detection / response-shape details.

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

After deployment, outputs are resolved and saved to the S3 state file:

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
