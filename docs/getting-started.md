---
title: Getting Started
description: Install cdkd, bootstrap your AWS account, and deploy an existing CDK app directly through AWS APIs.
---

# Getting Started

cdkd deploys the CDK app you already have. You install it, run `cdkd bootstrap`
once per AWS account, and use `cdkd deploy` where you used `cdk deploy`. Your
CDK code does not change.

This page takes an existing CDK app from install to a first deploy and a clean
teardown, then lists the commands you will reach for afterwards.

> [!IMPORTANT]
> cdkd is for dev and test environments. It is early in development and not
> yet production-ready. Keep deploying production with the AWS CDK CLI; the
> same CDK app serves both (see [Mixed Estates](mixed-estates.md)).

## Before you start

- **Node.js** >= 22.12.0
- **A CDK app**, the directory that holds your `cdk.json`. cdkd reads the same
  `cdk.json` the AWS CDK CLI does.
- **AWS credentials that can create the resources your stacks deploy.** cdkd
  calls each service's API directly, so it needs the actions you would use to
  create those resources by hand, plus a small set of its own for state and
  asset storage. [Permission errors](troubleshooting.md#access-denied-error)
  has a policy to start from.

`cdk bootstrap` is not required, and an account that already ran it is fine.

## Install

<pm>
npm i -g @go-to-k/cdkd
</pm>

The binary is `cdkd`. To pin a release, name it: `@go-to-k/cdkd@<version>`.

## Your first deploy

::: steps

1. Bootstrap the account

   Run this once per AWS account, from anywhere:

   ```bash
   cdkd bootstrap
   ```

   It creates the S3 bucket cdkd keeps its state in, `cdkd-state-{accountId}`,
   and storage for your app's assets: an S3 bucket
   `cdkd-assets-{accountId}-{region}` and an ECR repository
   `cdkd-container-assets-{accountId}-{region}`. Asset storage for further
   regions is created on the first deploy into each one.
   [`cdkd bootstrap`](cli-bootstrap.md) covers custom names and existing
   setups.

2. Preview what a deploy would do

   From your CDK app's directory:

   ```bash
   cdkd list     # the stacks in the app
   cdkd diff     # what the next deploy would create, change or delete
   ```

   On a stack cdkd has never deployed, `diff` shows every resource as a
   create.

3. Deploy

   ```bash
   cdkd deploy              # the app's only stack
   cdkd deploy MyStack      # one stack by name
   cdkd deploy --all        # every stack
   ```

   cdkd synthesizes the app, publishes its assets, and creates the resources
   in parallel through AWS APIs, starting each one as soon as the resources it
   depends on are done. If a resource fails, the resources this deploy already
   created are rolled back.

4. Change something and deploy again

   Edit your CDK code and run `cdkd deploy` again. Only the resources whose
   properties changed are touched. This is the loop cdkd is built to make
   short.

5. Tear down

   ```bash
   cdkd destroy MyStack
   ```

   This deletes the stack's AWS resources and its state record.

:::

Commands that delete, adopt or release AWS resources ask for confirmation
first. `-y` / `--yes` answers the prompt and every command accepts it. Pass it
in CI, where an unanswered prompt is an error.

## Make deploys faster

By default `cdkd deploy` waits until each resource is ready to use. Some
resources take minutes to get there after their create call has already
returned: CloudFront distributions, RDS instances, ElastiCache clusters, NAT
gateways.

```bash
cdkd deploy --no-wait
```

`--no-wait` returns as soon as each create call returns and lets AWS finish in
the background. It is where the largest speedups in the
[benchmarks](benchmarks.md) come from. [Wait Modes](wait-modes.md) lists what
each mode waits for, per resource type, and when `--no-wait` is the wrong
choice.

## What to run when

| You want to | Run | Read |
| --- | --- | --- |
| See what the next deploy would change | `cdkd diff MyStack` | [`cdkd diff`](cli-diff.md) |
| See what changed in AWS outside cdkd | `cdkd drift MyStack` | [Drift Detection](drift.md) |
| Keep what a failed deploy created, to inspect it | `cdkd deploy --no-rollback` | [Rollback](rollback.md) |
| Undo a failed or interrupted deploy | `cdkd rollback MyStack` | [Rollback](rollback.md) |
| Clear a lock left by a killed process | `cdkd force-unlock MyStack` | [`cdkd force-unlock`](cli-force-unlock.md) |
| Review what past deploys did | `cdkd events MyStack` | [Deployment Events](deployment-events.md) |
| Stop managing a resource without deleting it | `cdkd orphan MyStack/MyBucket` | [Orphan vs Destroy](orphan-vs-destroy.md) |
| Move a stack from CloudFormation to cdkd | `cdkd import MyStack --migrate-from-cloudformation` | [Importing Existing Resources](import.md) |
| Hand a stack back to CloudFormation | `cdkd export MyStack` | [Exporting to CloudFormation](export.md) |
| Upload assets without deploying | `cdkd publish-assets` | [`cdkd publish-assets`](cli-publish-assets.md) |
| Delete assets no stack references | `cdkd gc --dry-run`, then `cdkd gc` | [`cdkd gc`](cli-gc.md) |
| Run a function or API on your machine | `cdkd local invoke`, `cdkd local start-api` | [Local Execution](local-emulation.md) |
| Keep resolved secrets out of state | `cdkd scrub MyStack --dry-run`, then `cdkd scrub MyStack` | [`cdkd scrub`](cli-scrub.md) |
| Inspect or repair state without the CDK app | `cdkd state list`, `cdkd state show MyStack` | [`cdkd state`](cli-state.md) |
| Deploy through a dedicated IAM role | `cdkd deploy --role-arn <arn>` | [`--role-arn`](cli-reference.md#role-arn) |

`cdkd diff` and `cdkd drift` compare different things. `diff` compares your
synthesized template with cdkd's state, so it answers "what will my code
change". `drift` compares cdkd's state with live AWS, so it answers "what did
someone change behind my back".

The [CLI Reference](cli-reference.md) has every command and flag.

## Which commands need the CDK app

Most commands synthesize your app to learn what they are operating on. The
rest read the state bucket or AWS directly, so they work from any directory,
including after the source is gone.

| Family | Needs the CDK app | Commands |
| --- | --- | --- |
| Top-level | Yes | `deploy`, `destroy`, `diff`, `synth`, `list`, `import`, `export`, `orphan`, `scrub`, `publish-assets` |
| Top-level | No | `bootstrap`, `drift`, `rollback`, `events`, `gc`, `force-unlock` |
| [`cdkd state ...`](cli-state.md) | No | `info`, `list`, `resources`, `show`, `orphan`, `destroy`, `migrate`, `refresh-observed` |
| [`cdkd local ...`](local-emulation.md) | Yes, to synthesize; nothing is deployed | `invoke`, `start-api`, `run-task`, `start-service`, `start-alb`, `start-cloudfront`, `invoke-agentcore`, `start-agentcore` |

Two of the commands in the first row can do without the app. `cdkd destroy`
selects stacks from the state record when no app is configured, and
`cdkd export` skips synthesis when you pass `--template`.
`cdkd state destroy` never needs the app.

Options such as `--app` and `--state-bucket` can be left out when they are set
in `cdk.json` or the environment (`CDKD_APP`, `CDKD_STATE_BUCKET`).

## Upgrading from an earlier cdkd version

There is no manual step. Install the new version and deploy.

- **Asset storage.** The first deploy into each region creates cdkd's own
  asset storage if it is missing, asking once per region (or creating it
  without asking under `--yes`). That deploy shows a one-time in-place update
  that points asset references at the new storage. Content is identical and
  nothing is replaced. An older binary ignores the marker that records this,
  so downgrading is safe.
- **State bucket name.** A bucket created by an earlier version keeps its
  region-suffixed name, `cdkd-state-{accountId}-{region}`. cdkd still finds it
  and prints a deprecation warning. `cdkd state migrate` moves it to
  `cdkd-state-{accountId}`.

## Next steps

::: card-grid

::: card Core Concepts
What a deploy does, where state lives, and how cdkd decides what to change.
[Core Concepts](concepts.md)
:::

::: card Wait Modes
Choose what "done" means for slow resources. [Wait Modes](wait-modes.md)
:::

::: card Per-PR environments
One short-lived stack per pull request, deployed and destroyed by your CI.
[Per-PR Environments in CI](ci-per-pr.md)
:::

::: card AI coding agents
Install the cdkd skill so an agent deploys with cdkd.
[Use with AI Coding Agents](ai-agents.md)
:::

:::
