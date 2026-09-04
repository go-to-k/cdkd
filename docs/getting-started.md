---
title: Getting Started
description: Install cdkd, bootstrap your AWS account, and run your first direct deploy of an existing CDK app.
---

# Getting Started

cdkd works with your existing CDK app as-is — install it, run `cdkd bootstrap` once per AWS account, and replace `cdk deploy` with `cdkd deploy`.

## Installation

```bash
npm i -g @go-to-k/cdkd           # latest release
npm i -g @go-to-k/cdkd@<version> # pin to a specific version
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

## Prerequisites

- **Node.js** >= 20.0.0
- **AWS credentials with admin-equivalent permissions** for the resources being deployed. cdkd does NOT route through CloudFormation, so CDK CLI's `cdk-hnb659fds-deploy-role-*` is NOT sufficient — see [`--role-arn`](cli-reference.md).

AWS CDK's `cdk bootstrap` is not required. Instead, run `cdkd bootstrap` once per
account: it creates the S3 state bucket (`cdkd-state-{accountId}`) that cdkd uses
to track deployed resources, plus cdkd-owned asset storage (by default a
`cdkd-assets-{accountId}-{region}` bucket + a
`cdkd-container-assets-{accountId}-{region}` ECR repo; custom names via
`--asset-bucket` / `--container-repo`, skip with `--no-assets`; see
[`cdkd bootstrap`](cli-bootstrap.md#cdkd-bootstrap)). Per-region asset
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
`cdk bootstrap`: see [`cdkd bootstrap`](cli-bootstrap.md#cdkd-bootstrap).

## Usage

cdkd has three command families:

- **Top-level commands** — most (`cdkd deploy` / `destroy` / `diff` /
  `synth` / `list` / `import` / `export` / `migrate` / `orphan` /
  `scrub` / `publish-assets`) require a CDK app — they synthesize a template to
  learn what they're operating on. A few operate on the state bucket /
  AWS directly and need no app: `cdkd bootstrap`, `cdkd drift`,
  `cdkd rollback`, `cdkd events`, `cdkd gc`, `cdkd force-unlock`. See
  [CLI Reference](cli-reference.md).
- **`cdkd state ...` subcommands** (`state info` / `list` / `resources`
  / `show` / `orphan` / `destroy` / `migrate` / `refresh-observed`)
  operate on the S3 state bucket only and do NOT need the CDK app —
  use them to inspect / clean up state when the source is gone or
  you don't want to synth. `cdkd state destroy` is the CDK-app-free
  counterpart of `cdkd destroy`. See [`cdkd state`](cli-state.md).
- **`cdkd local ...` subcommands** (`local invoke` / `start-api` /
  `run-task` / `start-service` / `start-alb` / `start-cloudfront` /
  `invoke-agentcore` / `start-agentcore`) run synthesized workloads
  locally, most of them in Docker containers — no AWS deploy needed.
  Modeled on
  `sam local *` but reads CDK state directly via `--from-state`
  (cdkd-managed) or `--from-cfn-stack` (CFn-managed). See
  [Local Execution](local-emulation.md).

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

# Deployment history — CloudFormation DescribeStackEvents equivalent (no synth)
cdkd events MyStack                 # list past deploy / destroy runs, newest first
cdkd events MyStack --run <runId>   # one run's full event stream

# State secret hygiene — clean + audit. Keeps cdkd state free of sensitive
# plaintext: a resolved secret dynamic reference is stored as its
# {{resolve:...}} expression. No deploy, no AWS mutation.
cdkd scrub MyStack                  # clean existing state in place
cdkd scrub MyStack --dry-run        # audit only, report what would change
cdkd scrub MyStack --dry-run --fail # standing CI gate: exit 1 if plaintext remains

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

See the **[CLI reference](cli-reference.md)** for the full flag
matrix (`--concurrency`, `--no-aggressive-vpc-parallel`,
`--allow-unsupported-properties`, `--role-arn`, etc.), per-command details
including the synth-driven per-resource `cdkd orphan <constructPath>`
variant, and stage / wildcard pattern matching.

## Next steps

- [Using with AI Agents](ai-agents.md) — install the cdkd skill so Claude Code and other agents deploy with cdkd.
- [Wait modes](wait-modes.md) — `--no-wait` / default / `--full-wait`: choose what "done" means per resource type.
- [Use in CI: per-PR environments](ci-per-pr.md) — one ephemeral stack per pull request, deployed and destroyed by workflow.
- [CLI reference](cli-reference.md) — every command and flag in detail.
