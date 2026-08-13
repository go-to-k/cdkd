# cdkd (CDK Direct)

[![npm version](https://img.shields.io/npm/v/@go-to-k/cdkd.svg)](https://www.npmjs.com/package/@go-to-k/cdkd)
[![Downloads](https://img.shields.io/npm/dw/@go-to-k/cdkd.svg)](https://www.npmjs.com/package/@go-to-k/cdkd)
[![License: Apache-2.0](https://img.shields.io/npm/l/@go-to-k/cdkd.svg)](./LICENSE)

Drop-in CDK CLI for existing CDK apps — up to 15x faster deploys via direct AWS SDK calls instead of CloudFormation.

- **Drop-in CDK compatible**: your existing CDK app code runs as-is; just replace `cdk deploy` with `cdkd deploy`.
- **Up to 15x faster deploys**: direct SDK calls, aggressive parallelization, and `--no-wait` to skip slow stabilization waits; **faster than Terraform and CloudFormation Express mode** too (see [Benchmark](#benchmark)).

![cdk deploy vs cdkd deploy — side-by-side, 35s recording, real AWS deploy. cdkd finishes while cdk is still creating its CloudFormation changeset.](assets/cdk-vs-cdkd.gif)

**cdkd complements the AWS CDK CLI rather than replacing it.** Use cdkd in dev/test for rapid iteration; use the AWS CDK CLI in production for full CloudFormation tooling. Install cdkd alongside an existing `cdk deploy` workflow: no migration needed. You can also [import](#importing-existing-resources) existing stacks into cdkd or [export](#exporting-a-stack-back-to-cloudformation) back to CloudFormation anytime.

**A natural fit for AI-driven development.** AI coding agents iterate in tight spin-up / tear-down loops — and cdkd keeps each turn short, with fast deploys and an equally fast `cdkd destroy` that deletes via direct SDK calls instead of polling a CloudFormation stack-delete.

**Local execution from your deployed stack.** `cdkd local` runs your functions, APIs, and ECS tasks on your machine. It can resolve env vars, secrets, and resource references from your real deployed stack: no hand-written `.env` files, no hand-seeded test data (see [Local execution](#local-execution)).

> [!IMPORTANT]
> cdkd is for dev/test workflows only — early in development, not yet production-ready.

## Installation

```bash
npm i -g @go-to-k/cdkd          # latest release
npm i -g @go-to-k/cdkd@0.0.2    # pin to a specific version
```

The installed binary is `cdkd`.

## Quick Start

> **First-time setup**: run `cdkd bootstrap` once per AWS account before any
> other command; it replaces `cdk bootstrap`, which cdkd does not require
> (details in [Prerequisites](#prerequisites)).

```bash
# Bootstrap (creates S3 state bucket + asset storage — one-time setup per AWS account)
cdkd bootstrap

# List stacks in the CDK app
cdkd list

# Deploy your CDK app
cdkd deploy

# Deploy at maximum speed: skip slow stabilization waits
cdkd deploy --no-wait

# Check what would change
cdkd diff

# Tear down
cdkd destroy
```

## Use with AI Coding Agents

This repository ships a [`cdkd` skill](plugins/cdkd-skills/skills/cdkd/SKILL.md)
that teaches AI coding agents to use cdkd safely: install, AWS preflight
checks, preview and deployment, wait modes, verification, CloudFormation
migration boundaries, and destructive-operation safety.

### Claude Code

Install it as a plugin (one-time setup, available in every session) by
running these inside a Claude Code session:

```text
/plugin marketplace add go-to-k/cdkd
/plugin install cdkd-skills@cdkd
```

Then ask Claude to deploy a dev/test CDK stack with cdkd — the skill
triggers automatically — or invoke it directly with `/cdkd`.

### Other agents (Codex, Cursor, and more)

Any agent that supports the SKILL.md format can use the skill. Install it
with the [GitHub CLI](https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/)
(v2.90+) or [`npx skills`](https://github.com/vercel-labs/agent-skills):

```bash
gh skill install go-to-k/cdkd cdkd
# or
npx skills add go-to-k/cdkd --skill cdkd
```

### Contributors

To test the current checkout against another CDK project, clone this
repository and add it to a Claude Code session — the project-scoped
[`/use-cdkd`](.claude/skills/use-cdkd/SKILL.md) skill covers building and
linking the checkout:

```bash
claude --add-dir /path/to/cdkd
```

## Benchmark

**cdkd deploys up to 15x faster than AWS CDK (CloudFormation)** on SDK-Provider-handled stacks; the per-stack speedup widens with size and parallelism.

Numbers below are deploy-phase only (CDK app synthesis is identical between cdkd and AWS CDK — both run the same user code through `aws-cdk-lib`'s synthesizer — so synth time is excluded from the speedup calculation).

### vs CloudFormation Express mode: up to 9x faster

CloudFormation's [Express mode](https://aws.amazon.com/about-aws/whats-new/2026/06/aws-cloudformation-cdk/) is a fast-deploy option that skips resource stabilization waits, similar in spirit to cdkd's `--no-wait`. Even so, cdkd is faster than Express on nearly every stack, and with `--no-wait` it pulls dramatically ahead on stacks dominated by async resources.

| Stack | Normal (CFn) | Express | cdkd | cdkd `--no-wait` |
| --- | ---: | ---: | ---: | ---: |
| VPC + Lambda + SQS + CloudFront | 562 | 366 | 96 | **40** |
| DynamoDB | 34 | 34 | 19 | 15 |
| DynamoDB + KMS | 71 | 55 | 27 | 27 |
| EC2 | 44 | 31 | 27 | 26 |
| Lambda | 55 | 34 | 23 | 22 |
| S3 | 39 | 22 | 23 | 24 |
| SQS | 83 | 22 | **9** | 9 |
| SQS + CloudWatch | 87 | 44 | 30 | 31 |

Best of 3 runs, deploy-phase only, seconds, `us-west-2`. The `VPC + Lambda + SQS + CloudFront` stack is 1 VPC (2 AZs, NAT Gateway, public + private subnets) + VPC Lambda + Lambda Function URL + CloudFront Distribution + SQS + EventSourceMapping + Consumer Lambda. Its cdkd default cell was re-measured 2026-07-31 on cdkd 0.272.0 (96 / 107 / 115s, best of 3): since #1282 the default no longer waits for CloudFront `Deployed`, so NAT stabilization is the critical path. The other cells are from the original campaign.

- **~1.5–2x faster than Express on most stacks** — e.g. SQS finishes in 9s vs Express's 22s (~2.4x).
- **Async-heavy stacks are where the gap explodes.** On the VPC + CloudFront stack the cdkd default finishes in 96s vs Express's 366s (~3.8x) — since #1282 the default already leaves CloudFront propagation to complete in the background — and `--no-wait` (40s, ~9x) additionally skips the NAT stabilization wait.
- **S3 is the one case where Express edges cdkd's default** (22s vs 23s). On a near-instant single-resource stack there is little left to parallelize, and `--no-wait` makes no difference there.

### vs Terraform: cdkd deploys faster

We also raced cdkd against Terraform: the same logical stacks expressed both as CDK apps and as Terraform HCL, deployed against real AWS. **cdkd is clearly faster in four of six scenarios — 1.23x to 2.31x, with fully separated run distributions — and statistically tied in the rest.**

| Scenario | Stack | cdkd | Terraform | CloudFormation | cdkd `--no-wait` |
| --- | --- | ---: | ---: | ---: | ---: |
| wide | 48 independent resources (S3 / DynamoDB / SQS / SNS / SSM / Logs, 8 each) | **20.0** | 46.1 | 89.1 | 21.1 |
| serverless | Lambda ×3 + HTTP API + DynamoDB + SNS / SQS + EventBridge | **25.9** | 57.5 | 127.1 | 24.6 |
| ec2 | VPC + subnet + SG + IAM role + EC2 instance ×3 | **29.1** | 35.9 | 193.9 | 22.0 |
| webapp | VPC + NAT + subnets + DynamoDB + SQS + S3 + Lambda ×2 + HTTP API | 109.7 | 127.3 | 166.1 | 23.4 |
| ecs | VPC ×2 AZ + Fargate cluster / task / service + ALB | **162.8** | 209.5 | 276.7 | 34.5 |
| cloudfront — created (fire and forget) | S3 origin + CloudFront + OAC | 11.1 | 10.3 (`wait_for_deployment = false`) | no such mode | 10.4 |
| cloudfront — `Deployed` | S3 origin + CloudFront + OAC | 174.0 (`--full-wait`) | 166.4 | 232.3 | n/a |

Cold end-to-end wall clock including synth / plan, median of 7 runs, seconds, `us-east-1`; every run gets fresh resource names, so every run measures a first deploy. The cloudfront scenario is two rows because since #1282 the tools' DEFAULTS differ in what "done" means there — each row compares tools held to the same completion definition (cdkd's default is the fire-and-forget row; Terraform's default is the `Deployed` row), re-measured 2026-07-31 on cdkd 0.272.0.

- **The lead tracks how much of the wall clock is orchestration.** wide and serverless are almost pure orchestration and run ~2.2x faster; cloudfront is almost pure CDN propagation under the `Deployed` definition and pure API accept under fire-and-forget — a tie in both rows.
- **A win is claimed only where no cdkd run overlaps any Terraform run** — true of the four bolded rows. The ties disclose which way their medians lean, and the rule cuts both ways: webapp leans cdkd (by 17.6s), both cloudfront rows lean Terraform (by 0.8s and 7.6s) — in all three the run distributions overlap fully, so n=7 cannot separate them and neither side gets the row.
- **This is not cdkd waiting for less.** Held to the same completion definition — ECS `--full-wait` vs Terraform's `wait_for_steady_state=true` is 227.7 vs 282.7 (1.24x), and both cloudfront rows above are same-definition pairs by construction.

Distribution analysis, wait-skipping comparability (Terraform has no global `--no-wait` equivalent), and per-run data: [docs/benchmarks.md](docs/benchmarks.md) and [cdkd-bench-terraform](https://github.com/go-to-k/cdkd-bench-terraform).

### More benchmarks

The full benchmark suite lives in [docs/benchmarks.md](docs/benchmarks.md): the SDK Provider path (**5.5x**, 17.0s vs 94.4s), the VPC + CloudFront + Lambda stack behind the headline **15x** (40s vs 599s with `--no-wait`), the Cloud Control API fallback path (**1.6x**), and the Terraform comparison in full detail. Reproduction scripts: [tests/benchmark](tests/benchmark/README.md).

## Features

- **Synthesis orchestration**: CDK app subprocess execution, Cloud Assembly parsing, context provider loop
- **Asset handling**: Self-implemented asset publisher for S3 file assets (ZIP packaging) and Docker images (ECR)
- **Context resolution**: Self-implemented context provider loop for Vpc.fromLookup(), AZ, SSM, HostedZone, etc.
- **Hybrid provisioning**: SDK Providers for fast direct API calls, Cloud Control API fallback for broad resource coverage
- **Diff calculation**: Self-implemented resource/property-level diff between desired template and current state
- **S3-based state management**: No DynamoDB required, uses S3 conditional writes for locking
- **DAG-based parallelization**: Analyze `Ref`/`Fn::GetAtt` dependencies and execute in parallel
- **Rollback on failure**: When a deploy errors mid-stack, cdkd rolls back the resources it just created so the stack state stays consistent (CloudFormation parity — but cdkd does this without round-tripping through CFn). Pass `cdkd deploy --no-rollback` to skip rollback and keep the partial state for Terraform-style inspection / repair — then either fix forward with another `cdkd deploy`, revert with the standalone `cdkd rollback`, or `cdkd destroy` to clean up. See [Rollback behavior](#rollback-behavior).
- **`--no-wait` / `--full-wait` for async resources**: `--no-wait` skips the multi-minute wait on RDS / ElastiCache / NAT Gateway / EC2 Instance / ELBv2 LoadBalancer / Lambda MicroVM Image and returns as soon as the create call returns (CloudFormation always blocks); `--full-wait` goes the other way and waits where cdkd's default does not (ECS Service steady state; CloudFront Distribution `Deployed` — the default returns as soon as `CreateDistribution` is accepted, since nothing in-deploy needs the 3–15 min edge propagation)
- **VPC route DependsOn relaxation (on by default)**: Drop CDK-injected defensive `DependsOn` edges from VPC Lambdas onto private-subnet routes so `CloudFront::Distribution` and `Lambda::Url` start their ~3-min propagation in parallel with NAT Gateway stabilization (~50% faster on VPC + Lambda + CloudFront stacks). Pass `--no-aggressive-vpc-parallel` to opt out.
- **Local execution** (`cdkd local invoke` / `start-api` / `run-task` / `start-service` / `start-alb` / `start-cloudfront` / `invoke-agentcore` / `start-agentcore`): run Lambdas, API Gateway routes, ECS tasks, long-running ECS services, CloudFront distributions, and Bedrock AgentCore Runtimes from your CDK code. All AWS Lambda runtimes, container Lambdas, REST v1 / HTTP v2 / Function URL routes, Service Connect / Cloud Map, AgentCore HTTP / MCP / A2A / AGUI / WebSocket protocols (one-shot `invoke-agentcore` and long-running warm serve via `start-agentcore`, which serves the native contract — `POST /invocations` + `GET /ping`, MCP `/mcp`, A2A `/` — plus the `/ws` bridge for HTTP / AGUI). The Docker-backed commands work for both `cdkd deploy`-managed (`--from-state`) AND `cdk deploy`-managed (`--from-cfn-stack`) stacks; `start-cloudfront` serves the viewer-request -> S3 / Lambda Function URL origin -> viewer-response pipeline (CloudFront-Functions + S3-only distributions run in-process with no Docker). See [Local execution](#local-execution).
- **Bidirectional CloudFormation migration**: `cdkd import --migrate-from-cloudformation` adopts existing CFn stacks (including `cdk deploy`-managed) into cdkd state without re-creating resources; `cdkd export` hands a cdkd stack back to CloudFormation when production-ready. See [Importing](#importing-existing-resources) / [Exporting](#exporting-a-stack-back-to-cloudformation).
- **Mixed cdkd / CloudFormation estates**: a cdkd-deployed stack can reference a producer stack still managed by `cdk deploy` — `Fn::ImportValue` / `Fn::GetStackOutput` fall back to CloudFormation (`ListExports` / stack outputs) when the reference is not in cdkd state, so shared infrastructure stays on the CDK CLI while app stacks iterate on cdkd. See [Reference CloudFormation-managed stacks](#reference-cloudformation-managed-stacks-mixed-estates).

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
account: it creates the S3 state bucket (`cdkd-state-{accountId}`) that cdkd uses
to track deployed resources, plus cdkd-owned asset storage (by default a
`cdkd-assets-{accountId}-{region}` bucket + a
`cdkd-container-assets-{accountId}-{region}` ECR repo; custom names via
`--asset-bucket` / `--container-repo`, skip with `--no-assets`; see
[`cdkd bootstrap`](docs/cli-reference.md#cdkd-bootstrap)). Per-region asset
storage is added automatically on the first `cdkd deploy` into each region.
Existing setups, legacy-mode opt-outs, and how this relates to `cdk bootstrap`: see
[Upgrading from an earlier cdkd version](#upgrading-from-an-earlier-cdkd-version).

### Upgrading from an earlier cdkd version

**No breaking change, no manual step: just deploy.** The first `cdkd deploy` into
each region auto-creates the cdkd-owned asset storage (interactive runs are asked
once per region, `--yes` / CI runs create it automatically) and shows a one-time
in-place UPDATE repointing asset references — content identical, no replacement.
Downgrading is safe too (older binaries ignore the marker). If you bootstrapped
under a previous cdkd version, the legacy region-suffixed state bucket name
(`cdkd-state-{accountId}-{region}`) is still picked up automatically with a
deprecation warning. Explicit pre-provisioning
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
cdkd rollback MyStack               # revert a failed --no-rollback / interrupted deploy
cdkd deploy --no-wait               # skip multi-minute waits (RDS / ElastiCache / NAT)
cdkd deploy --full-wait             # also wait where cdkd's default does not (ECS steady state, CloudFront Deployed)

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
cdkd force-unlock MyStack           # clear stale lock from an interrupted deploy / cancelled CI job
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

## `--no-wait` / `--full-wait`: choose what "done" means

CloudFront / RDS / ElastiCache / NAT Gateway / EC2 Instance / ELBv2
LoadBalancer typically take 1–15 minutes to fully provision. Three
modes, least to most waiting:

- **`--no-wait`** returns as soon as the create call returns and lets
  AWS finish in the background.
- **default** waits where the wait is load-bearing (something the same
  deploy resolves or verifies needs the settled state, or the wait can
  surface a failure) — in practice, where CloudFormation and Terraform
  agree, with one measured exception: CloudFront Distribution returns
  as soon as `CreateDistribution` is accepted (nothing in-deploy needs
  the 3–15 min edge propagation, and the wait cannot detect a failure).
- **`--full-wait`** additionally waits everywhere CloudFormation does
  (today: ECS Service steady state, CloudFront Distribution
  `Deployed`).

Pick by whether anything downstream needs the resource to actually be
serving, not by where the deploy runs — cutting billed CI minutes is a
perfectly good reason to use `--no-wait` in CI, and a local smoke test
(or a pipeline that wants CloudFormation-parity completion as a standing
setting) is a good reason to use `--full-wait`. The two flags are
opposite ends of one axis and cannot be combined.

**Deploy-only**: `cdkd destroy` always waits (NAT in `deleting` state
holds ENIs and would `DependencyViolation` sibling deletes).

See [docs/cli-reference.md](docs/cli-reference.md#wait-semantics) for
the per-resource table (what each mode does, next to what
CloudFormation and Terraform do) and caveats (NAT egress, RDS
final-snapshot timing, etc.).

## Use in CI: per-PR environments

Deploy time is CI job time, and a PR environment redeploys on every
push — so cdkd's speedup compounds across a PR's lifetime. Because
cdkd needs **zero CDK code changes**, you can swap only the PR-environment
workflow to cdkd and keep production / staging on the CDK CLI; switching
back is a one-line workflow revert.

Run `cdkd bootstrap` once per AWS account beforehand (creates the state
bucket + asset storage; `cdk bootstrap` is not required).

**One stack per PR** — pass the PR number as CDK context and suffix the
stack name; cdkd state is keyed by (stack name, region) and locks are
per-stack, so PR environments deploy concurrently without contention:

```ts
const prNumber = app.node.tryGetContext('prNumber');
new WebAppStack(app, `WebApp${prNumber ? `-pr-${prNumber}` : ''}`);
```

**Credentials** — cdkd calls AWS APIs directly, so the deploying
identity needs permissions for every deployed resource (CDK's
`cdk-hnb659fds-*` roles do not work: they are designed for
CloudFormation delegation, and cdkd uses its own bootstrap storage).
Create a dedicated deploy role and switch into it with
[`--role-arn`](docs/cli-reference.md#--role-arn) (or the
`CDKD_ROLE_ARN` env var): the workflow's OIDC base role needs only
`sts:AssumeRole` on the deploy role, and the deploy role's trust policy
allows only that base role — the strong permissions live in exactly one
place, reachable through one path, and never sit on the CI runner
itself.

**Minimal GitHub Actions shape** (deploy on open/sync/reopen, destroy
on close):

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
permissions: { id-token: write, contents: read }
env:
  CDKD_ROLE_ARN: arn:aws:iam::123456789012:role/cdkd-deploy-role
jobs:
  deploy:
    if: github.event.action != 'closed'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions-base
          aws-region: us-east-1
      - run: npx cdkd deploy --yes -c prNumber=${{ github.event.pull_request.number }}
  destroy:
    if: github.event.action == 'closed'
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions-base
          aws-region: us-east-1
      - run: npx @go-to-k/cdkd state destroy WebApp-pr-${{ github.event.pull_request.number }} --yes
```

The destroy job has no checkout, `npm ci`, or synth —
[`cdkd state destroy`](#orphan-vs-destroy) deletes from the state
record alone, so it works even after the branch is gone.

If the environment contains protection-enabled resources (RDS /
DynamoDB deletion protection, EC2 termination protection, and more),
add [`--remove-protection`](#--remove-protection-one-shot-bypass-for-protected-resources)
to the destroy so the teardown completes in one pass — an ephemeral PR
environment has nothing worth protecting, and without the flag those
resources survive the job and linger until the next sweep.

**Housekeeping**:

- Pick the wait mode from what runs next (see the section above):
  review-only environments can use `--no-wait`; E2E tests after the
  deploy should keep the default, or `--full-wait` when they need ECS
  steady state / CloudFront propagation.
- A job cancelled mid-deploy (e.g. `concurrency.cancel-in-progress`)
  can leave a stack lock; it expires on its own TTL (30 minutes), or
  run `cdkd force-unlock <stack>` to clear it immediately.
- Sweep forgotten environments with `cdkd state list --json` on a
  schedule, and reclaim unreferenced assets with
  `cdkd gc --older-than 30d --dry-run` — `gc` aborts if any stack is
  locked, so schedule it outside deploy hours.
- To comment the environment URL on the PR, read stack outputs with
  `cdkd state show <stack> --json`.
- To gate a PR without deploying, `cdkd diff --fail` exits `1` when any
  change is detected (and `cdkd drift --json` machine-checks live
  divergence). See [Exit codes](#exit-codes) for per-command semantics.

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

### `cdkd rollback` — revert a failed deploy

After a `--no-rollback` failure (or a Ctrl+C-interrupted deploy, or an
automatic rollback that itself died partway), you have three options:
fix forward (`cdkd deploy` again), revert (`cdkd rollback`), or clean up
(`cdkd destroy`). The standalone `cdkd rollback` command is the "revert"
option — the cdkd equivalent of `cdk rollback` / CloudFormation
`RollbackStack`:

```bash
cdkd rollback MyStack          # revert MyStack to its pre-deploy state
cdkd rollback                  # single journaled stack (no arg)
cdkd rollback MyStack --force  # skip the confirmation prompt
```

It works from a **rollback journal** cdkd writes to
`s3://bucket/cdkd/{stack}/{region}/rollback-journal.json` (a sibling of
`state.json`) whenever a deploy ends without a completed rollback — the
journal records the exact operations that completed, so `cdkd rollback`
replays them in reverse (deleting created resources, restoring updated
ones) with no synth and no CDK app needed. It is **synth-free** on
purpose: a broken app is a common reason you want to roll back. The
journal is deleted automatically on the next successful deploy and by
`cdkd destroy`; after a clean automatic rollback it keeps only the
failed resource's record so `cdkd rollback --revert-failed` still works
in the default deploy flow.

Flags: `--force` (skip confirm), `--orphan <logicalId>` (repeatable —
leave the resource alone during replay, like `cdk rollback --orphan`),
`--revert-failed` (also attempt to revert the resource whose operation
FAILED mid-deploy — off by default because its remote state is unknown; its
delete honors `DeletionPolicy` the same way a completed CREATE's does),
`--stack-region <region>` (disambiguate a same-named stack across
regions), `--role-arn`, `--state-bucket`. A **replacement** is reverted
by reversing it: the old resource is re-created from its journaled
pre-deploy state and the new one deleted (for a stateful type the old
data is unrecoverable — warned loudly). Exit codes: `0` = fully clean
(journal deleted), `2` = partial (some ops failed / were skipped — the
journal is kept so you can re-run), `1` = hard error. See
[docs/cli-reference.md](docs/cli-reference.md#cdkd-rollback) for the
full reference and known limitations (a DELETE that already happened
cannot be restored).

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
# Adopt a whole stack: each resource is resolved from its template name property,
# then from a same-named CloudFormation stack (#1128). Use
# --migrate-from-cloudformation below when you also want that stack retired.
cdkd import MyStack --yes

# Adopt only specific resources (CDK CLI parity).
cdkd import MyStack --resource MyBucket=my-bucket-name

# Some types use a composite, `|`-delimited physical id — quote it.
# Full per-type table: docs/state-management.md#composite-pipe-delimited-physicalids
cdkd import MyStack --resource 'MyGlueTable=my_database|my_table'

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

## Reference CloudFormation-managed stacks (mixed estates)

You don't have to migrate a producer stack to reference it. When an
`Fn::ImportValue` / `Fn::GetStackOutput` reference is not found in cdkd
state, cdkd falls back to CloudFormation — `ListExports` for
`Fn::ImportValue` (CFn's own semantic for the intrinsic), the stack's
outputs via `DescribeStacks` for `Fn::GetStackOutput` — so a
cdkd-deployed stack can consume values from a stack still managed by
`cdk deploy` / raw CloudFormation, with zero changes on the producer
side.

This makes the recommended split work out of the box: shared
infrastructure (VPC, domains, IAM) stays on the CDK CLI, while dev/test
app stacks iterate via cdkd.

```typescript
// Producer: deployed with `cdk deploy` (stays CloudFormation-managed).
new cdk.CfnOutput(this, 'SharedVpcId', {
  value: vpc.vpcId,
  exportName: 'SharedVpcId',
});

// Consumer: deployed with `cdkd deploy`. Resolution order is cdkd state
// first, then CloudFormation — same syntax either way.
const vpcId = cdk.Fn.importValue('SharedVpcId');
```

How it behaves:

- **cdkd-first precedence.** The fallback fires only after cdkd state
  misses, so cdkd-to-cdkd references are untouched and a name collision
  resolves to the cdkd export.
- **Weak reference.** A CFn-sourced value is not recorded into cdkd
  state, and neither engine blocks deleting the CFn producer while cdkd
  consumers reference it (CloudFormation's export-in-use protection
  cannot see cdkd consumers). Check downstream consumers before deleting
  a producer.
- **IAM**: the deploying credentials need `cloudformation:ListExports` /
  `cloudformation:DescribeStacks` for the fallback. Without them, cdkd
  warns and fails with the ordinary not-found error.
- **Opt-out**: `--no-cfn-fallback` (on `deploy` / `diff`) pins
  cdkd-state-only resolution — minimal IAM, and an export-name typo
  fails fast instead of matching an unrelated CloudFormation export.
- This also works mid-migration: after `cdkd export` hands a producer
  back to CloudFormation, remaining cdkd consumers keep resolving its
  outputs through the fallback (no leaf-first ordering requirement).

See **[docs/cross-stack-references.md](docs/cross-stack-references.md)**
for the full design (resolution order, weak-vs-strong reference
semantics, cross-region / cross-account forms).

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

## `DeletionPolicy: Snapshot`: final snapshots on delete

Matching CloudFormation, cdkd creates a **final snapshot before deleting**
a resource whose `DeletionPolicy` is `Snapshot` (the CDK RDS L2 defaults
`removalPolicy` to `SNAPSHOT`) — and, on replacements, one whose
`UpdateReplacePolicy` is `Snapshot`: RDS DBInstance / DBCluster,
Neptune / DocDB clusters and ElastiCache CacheCluster delete via the API's
atomic final-snapshot parameter; EC2 Volumes, Redshift Clusters and
ElastiCache ReplicationGroups get a pre-delete snapshot waited to
completion. The full CFn-documented Snapshot-capable type list is covered.
Pass `--skip-final-snapshot` (on `deploy` / `destroy` / `state destroy` /
`rollback`) to delete without the snapshot (explicit data-loss opt-out for
dev/test stacks). Rolling a CREATE back is a delete too, so the policy
applies there as well — for a resource whose CREATE completed and, under
`--revert-failed`, for one whose CREATE failed after AWS provisioned it. See the "DeletionPolicy: Snapshot" section in
[docs/cli-reference.md](docs/cli-reference.md).

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
| `AWS::DSQL::Cluster` | `DeletionProtectionEnabled` (flipped via a Cloud Control `UpdateResource` patch before delete) |
| `AWS::NeptuneGraph::Graph` | `DeletionProtection` (same Cloud Control patch flip) |
| `AWS::SMSVOICE::ProtectConfiguration` | `DeletionProtectionEnabled` (same Cloud Control patch flip) |
| `AWS::VerifiedPermissions::PolicyStore` | `DeletionProtection` `{Mode}` (patched to `{Mode: DISABLED}`) |
| `AWS::EKS::Cluster` | `DeletionProtection` (same Cloud Control patch flip) |
| `AWS::RDS::GlobalCluster` | `DeletionProtection` (same Cloud Control patch flip) |
| `AWS::DocDB::GlobalCluster` | `DeletionProtection` (same Cloud Control patch flip) |

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
references, asset publishing, custom resources, and so on. Cross-stack
references also work against producer stacks still managed by
CloudFormation (see
["Reference CloudFormation-managed stacks"](#reference-cloudformation-managed-stacks-mixed-estates)
above). See
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

## License

Apache 2.0
