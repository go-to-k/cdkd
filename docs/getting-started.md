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

The installed binary is `cdkd`. Running it requires:

- **Node.js** >= 20.0.0
- **AWS credentials with admin-equivalent permissions** for the resources being
  deployed. cdkd does NOT route through CloudFormation, so CDK CLI's
  `cdk-hnb659fds-deploy-role-*` is NOT sufficient — see
  [`--role-arn`](cli-reference.md#role-arn).

## Quick Start

```bash
# One-time per AWS account: create the S3 state bucket + asset storage
cdkd bootstrap

# List the stacks in the CDK app
cdkd list

# Preview, then deploy
cdkd diff
cdkd deploy

# Tear down
cdkd destroy
```

## Bootstrapping

AWS CDK's `cdk bootstrap` is not required. Instead, run `cdkd bootstrap` once per
account: it creates the S3 state bucket (`cdkd-state-{accountId}`) that cdkd uses
to track deployed resources, plus cdkd-owned asset storage (by default a
`cdkd-assets-{accountId}-{region}` bucket + a
`cdkd-container-assets-{accountId}-{region}` ECR repo; custom names via
`--asset-bucket` / `--container-repo`, skip with `--no-assets`). Per-region asset
storage is added automatically on the first `cdkd deploy` into each region.

[`cdkd bootstrap`](cli-bootstrap.md) covers existing setups,
legacy-mode opt-outs, and how this relates to `cdk bootstrap`. If you
bootstrapped under an earlier cdkd, see
[Upgrading from an earlier cdkd version](#upgrading-from-an-earlier-cdkd-version).

## Commands by task

Two conventions apply throughout:

- Options like `--app`, `--state-bucket`, and `--context` can be omitted if
  configured via `cdk.json` or environment variables (`CDKD_APP`,
  `CDKD_STATE_BUCKET`).
- Commands that delete AWS resources, or that adopt / release them, ask for
  confirmation first: `destroy`, `orphan`, `import`, `export`, `rollback`,
  `gc`, `drift --accept` / `--revert`, `events prune`, `bootstrap --destroy`,
  and the writing `cdkd state` subcommands. `cdkd deploy` prompts too, but only
  when it is about to create asset storage in a new region or replace a
  resource. `-y` / `--yes` answers the prompt and is accepted by every command,
  so the examples below leave it out — pass it in CI, where an unanswered
  prompt is a hard error, not a hang.

### Deploy

```bash
cdkd list                           # the stacks in the CDK app
cdkd synth                          # synthesize the CloudFormation template only
cdkd deploy                         # single-stack auto-detected
cdkd deploy MyStack                 # by name (or 'MyStage/Api' display path)
cdkd deploy --all
cdkd deploy --dry-run               # show the changes without applying them
cdkd deploy --no-rollback           # Terraform-style: keep partial state on failure
cdkd deploy --no-wait               # skip multi-minute waits (RDS / ElastiCache / NAT)
cdkd deploy --full-wait             # also wait where the default does not (ECS steady state, CloudFront Deployed)
cdkd publish-assets                 # synth + upload assets only, no deploy (typical CI split)

cdkd events MyStack                 # past deploy / destroy runs, newest first
cdkd events MyStack --run <runId>   # one run's full event stream
```

`--no-wait` / default / `--full-wait` are explained per resource type in
[Wait Modes](wait-modes.md). `cdkd events` is cdkd's `DescribeStackEvents`
equivalent — it replays what a past run did, and reads the state bucket, so it
works without the CDK app.

### Check for differences

Two comparisons, against two different references:

- `cdkd diff` — synthesized template vs cdkd state: what the **next deploy**
  would change. Needs the CDK app.
- `cdkd drift` — cdkd state vs **live AWS**: what changed outside cdkd. Reads
  the state bucket only, so it needs no CDK app, and it can push either side
  onto the other.

`cdkd deploy --dry-run` runs the first comparison from inside the deploy path
and prints create / update / delete counts; reach for `cdkd diff` when you want
to read what actually changed.

```bash
cdkd diff MyStack
cdkd diff MyStack --fail            # exit 1 on any change (CI gate)

cdkd drift MyStack                  # exit 1 if drift
cdkd drift MyStack --accept         # state ← AWS
cdkd drift MyStack --revert         # AWS ← state
```

### Recover a failed or interrupted deploy

```bash
cdkd rollback MyStack               # revert a failed --no-rollback / interrupted deploy
cdkd force-unlock MyStack           # clear a lock left by a force-quit or cancelled CI job
```

A lock expires on its own 30 minutes after its owner stops renewing it, so
[`cdkd force-unlock`](cli-force-unlock.md) is for when you would rather not wait
— or when the lock object itself is unreadable.

### Tear down

`destroy` deletes the AWS resources **and** the state record; `orphan` deletes
**only** the state record, leaving the AWS resources in place — see
[Orphan vs Destroy](orphan-vs-destroy.md).

```bash
cdkd destroy MyStack
cdkd destroy --all
cdkd orphan MyStack/MyBucket        # drop a resource — or everything under an L2
                                    # path — from state; the AWS resources stay
```

### Reclaim asset storage

```bash
cdkd gc --dry-run                   # report what would go, without deleting
cdkd gc                             # one region's unreferenced cdkd-owned assets
                                    # (S3 + ECR), plus abandoned custom-resource
                                    # response placeholders (account-wide)
```

### Move between cdkd and CloudFormation

```bash
# A CDK app previously deployed with `cdk deploy`: adopt its resources into
# cdkd state AND retire the CloudFormation stack (AWS resources are untouched).
cdkd import MyStack --migrate-from-cloudformation

# Adopt without retiring anything — resources created by hand, by another
# tool, or by a cdkd deploy whose state file was lost. Physical ids are
# resolved from the template and, if a same-named CFn stack exists, from it.
cdkd import MyStack
cdkd import MyStack --resource MyBucket=my-bucket-name   # only MyBucket, explicit id

# The reverse direction: hand a cdkd-managed stack back to CloudFormation.
cdkd export MyStack
```

See [Importing Existing Resources](import.md) and
[Exporting to CloudFormation](export.md) for the full flows, including the
recursive nested-stack walk.

### Work on state without the CDK app

```bash
cdkd state info                     # bucket name, region, schema version
cdkd state list                     # one row per (stackName, region)
cdkd state list --tree              # parent → child nested-stack tree
cdkd state show MyStack             # full state record
cdkd state resources MyStack        # logical id / type / physical id
cdkd state destroy MyStack          # delete AWS resources + state, no CDK app
cdkd state orphan MyStack           # remove the state record only (AWS resources stay)
```

### Keep secrets out of state

`cdkd scrub` audits and cleans state so a resolved secret dynamic reference is
stored as its `{{resolve:...}}` expression. No deploy, no AWS mutation — but it
does need the CDK app, because only the template still carries the unresolved
expression.

```bash
cdkd scrub MyStack                  # clean existing state in place
cdkd scrub MyStack --dry-run        # audit only, report what would change
cdkd scrub MyStack --dry-run --fail # standing CI gate: exit 1 if plaintext remains
```

See the **[CLI Reference](cli-reference.md)** for the full flag
matrix (`--concurrency`, `--no-aggressive-vpc-parallel`,
`--allow-unsupported-properties`, `--role-arn`, etc.), per-command details
including the synth-driven per-resource `cdkd orphan <constructPath>`
variant, and stage / wildcard pattern matching.

## Which commands need the CDK app

Most top-level commands synthesize a template to learn what they are operating
on. The rest read the S3 state bucket or AWS directly, so they still work when
the source is gone or you don't want to synth.

| Family | Needs the CDK app | Commands |
| --- | --- | --- |
| Top-level | Yes | `deploy`, `destroy`, `diff`, `synth`, `list`, `import`, `export`, `orphan`, `scrub`, `publish-assets` |
| Top-level | No | `bootstrap`, `drift`, `rollback`, `events`, `gc`, `force-unlock` |
| [`cdkd state ...`](cli-state.md) | No | `info`, `list`, `resources`, `show`, `orphan`, `destroy`, `migrate` (consolidate a legacy region-suffixed state bucket), `refresh-observed` |
| [`cdkd local ...`](local-emulation.md) | Yes — synth only, nothing is deployed | `invoke`, `start-api`, `run-task`, `start-service`, `start-alb`, `start-cloudfront`, `invoke-agentcore`, `start-agentcore` |

Two entries in the first row are softer than the rest: `cdkd destroy`
synthesizes when an app is configured but otherwise selects stacks straight
from the state record (only display-path patterns actually need the app), and
`cdkd export` skips synth entirely when handed a `--template`. `cdkd state
destroy` is the always-app-free counterpart of `cdkd destroy`. The `local`
commands are modeled on `sam local *`, and resolve env vars and resource
references from a deployed stack via `--from-state` (cdkd-managed) or
`--from-cfn-stack` (CFn-managed).

## Upgrading from an earlier cdkd version

**No breaking change, no manual step: just deploy.** The first `cdkd deploy` into
each region auto-creates the cdkd-owned asset storage (interactive runs are asked
once per region, `--yes` / CI runs create it automatically) and shows a one-time
in-place UPDATE repointing asset references at it — content identical, no
replacement. Downgrading is safe too: an older binary ignores the per-region
marker that records the opt-in.

A state bucket created by an earlier cdkd keeps its legacy region-suffixed name
(`cdkd-state-{accountId}-{region}`) and is still picked up automatically, with a
deprecation warning; `cdkd state migrate` consolidates it into the region-free
`cdkd-state-{accountId}`. Explicit pre-provisioning is
`cdkd bootstrap --region <r>`.

## Next steps

- [Core Concepts](concepts.md) — the deploy pipeline, S3 state, and how cdkd decides what to change.
- [Use with AI Coding Agents](ai-agents.md) — install the cdkd skill so Claude Code and other agents deploy with cdkd.
- [Wait Modes](wait-modes.md) — `--no-wait` / default / `--full-wait`: choose what "done" means per resource type.
- [Per-PR Environments in CI](ci-per-pr.md) — one ephemeral stack per pull request, deployed and destroyed by workflow.
- [CLI Reference](cli-reference.md) — every command and flag in detail.
