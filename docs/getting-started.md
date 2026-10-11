---
title: Getting Started
description: Install cdkd, bootstrap your AWS account, and deploy an existing CDK app directly through AWS APIs.
---

# Getting Started

cdkd deploys the CDK app you already have. You install it, run `cdkd bootstrap`
once per AWS account, and then use `cdkd deploy` where you used `cdk deploy`.
Your CDK code does not change.

This page takes an existing CDK app from install to a first deploy and a clean
teardown. It then lists the commands you will reach for afterwards.

> [!IMPORTANT]
> cdkd is for dev and test environments. It is early in development and not
> yet production-ready. Keep deploying production with the AWS CDK CLI; the
> same CDK app serves both (see [Mixed Estates](mixed-estates.md)).

## Before you start

You need three things:

- **Node.js** >= 22.12.0
- **A CDK app**, which is the directory that holds your `cdk.json`. cdkd reads
  the same `cdk.json` the AWS CDK CLI does.
- **AWS credentials that can create the resources your stacks deploy.** cdkd
  calls each service's API directly, so it needs the permissions you would
  need to create those resources by hand. It also needs a small set of
  permissions for its own storage.
  [Troubleshooting](troubleshooting.md) has a policy to start from, under
  its "Access Denied" entry.

You do not need to run `cdk bootstrap`. An account where it has already run
works too.

## Install

<pm>
npm i -g @go-to-k/cdkd
</pm>

The command is `cdkd`. To install a specific release, name it:
`@go-to-k/cdkd@<version>`.

## Your first deploy

::: steps

1. Bootstrap the account

   Run this once per AWS account, from any directory:

   ```bash
   cdkd bootstrap
   ```

   Bootstrap creates the storage cdkd needs:

   - an S3 bucket, `cdkd-state-{accountId}`, for cdkd's **state**: its record
     of what it has deployed,
   - an S3 bucket, `cdkd-assets-{accountId}-{region}`, and an ECR repository,
     `cdkd-container-assets-{accountId}-{region}`, for your app's **assets**:
     Lambda code, other files and container images.

   The asset bucket and repository exist per region. When you first deploy to
   another region, that deploy creates them there.
   [`cdkd bootstrap`](cli-bootstrap.md) covers custom names and existing
   setups.

2. Preview what a deploy would do

   From your CDK app's directory:

   ```bash
   cdkd list     # the stacks in the app
   cdkd diff     # what the next deploy would create, change or delete
   ```

   cdkd has not deployed this stack yet, so `diff` shows every resource as a
   create.

3. Deploy

   ```bash
   cdkd deploy              # the app's only stack
   cdkd deploy MyStack      # one stack by name
   cdkd deploy --all        # every stack
   ```

   cdkd first synthesizes the app, which means it runs your CDK code to
   produce a CloudFormation template for each stack. It then uploads the
   assets and creates the resources through AWS APIs. Resources are created in
   parallel, and each one starts as soon as the resources it depends on are
   done.

   If a resource fails, cdkd rolls back: it deletes the resources this deploy
   had already created.

4. Change something and deploy again

   Edit your CDK code and run `cdkd deploy` again. cdkd compares the new
   template with its state and touches only the resources whose properties
   changed. This edit-and-deploy loop is what cdkd is built to make short.

5. Tear down

   ```bash
   cdkd destroy MyStack
   ```

   This deletes the stack's AWS resources and then cdkd's state for the
   stack.

:::

A command that deletes AWS resources, or changes which resources cdkd manages,
asks for confirmation first. Every command accepts `-y` / `--yes` to answer
the prompt. Pass it in CI, because a prompt nobody answers is an error there.

## Make deploys faster

Some resources take minutes to become usable after AWS has accepted the call
that creates them: CloudFront distributions, RDS instances, ElastiCache
clusters, NAT gateways. By default `cdkd deploy` waits until each resource is
ready to use. `--no-wait` skips that wait:

```bash
cdkd deploy --no-wait
```

With `--no-wait`, the command returns once AWS has accepted each create call,
and AWS finishes the slow resources in the background. The largest speedups in
the [benchmarks](benchmarks.md) come from this flag.
[Wait Modes](wait-modes.md) lists what each mode waits for and when
`--no-wait` is the wrong choice.

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
| Deploy through a dedicated IAM role | `cdkd deploy --role-arn <arn>` | [Credentials and --role-arn](cli-reference-credentials.md) |

`cdkd diff` and `cdkd drift` answer different questions. `diff` compares the
template your code produces with cdkd's state, so it shows what your next
deploy will change. `drift` compares cdkd's state with what is in AWS now, so
it shows what someone changed outside cdkd.

The [CLI Reference](cli-reference.md) has every command and flag.

## Which commands need the CDK app

Most commands synthesize your app to learn which stacks and resources they are
working on, so you run them from the app's directory. The others read only the
state bucket or AWS. Those work from any directory, and they still work after
the app's source code is gone.

| Commands | Need the CDK app |
| --- | --- |
| `deploy`, `destroy`, `diff`, `synth`, `list`, `import`, `export`, `orphan`, `scrub`, `publish-assets` | Yes |
| `bootstrap`, `drift`, `rollback`, `events`, `gc`, `force-unlock` | No |
| [`cdkd state ...`](cli-state.md): `info`, `list`, `resources`, `show`, `orphan`, `destroy`, `migrate`, `refresh-observed` | No |
| [`cdkd local ...`](local-emulation.md): `invoke`, `start-api`, `run-task`, `start-service`, `start-alb`, `start-cloudfront`, `invoke-agentcore`, `start-agentcore` | Yes |

The `cdkd local` commands synthesize the app to find what to run, and deploy
nothing.

Two commands in the first row can also run without the app. `cdkd destroy`
selects stacks from state when no app is configured, and `cdkd export` skips
synthesis when you pass `--template`. To delete a stack from a machine that
has no app at all, use `cdkd state destroy`.

You can leave out options such as `--app` and `--state-bucket` when they are
set in `cdk.json` or in the environment (`CDKD_APP`, `CDKD_STATE_BUCKET`).

## Upgrading from an earlier cdkd version

There is no manual step. Install the new version and deploy. Two things may
look different on the first deploy after an upgrade.

### A one-time update that moves asset references

The first deploy into each region creates cdkd's own asset storage if it is
missing. cdkd asks once per region before creating it, or creates it without
asking under `--yes`.

The same deploy shows a one-time in-place update, which points the stack's
asset references at the new storage. The asset content is identical and no
resource is replaced. Going back to an older cdkd version afterwards is safe,
because an older version ignores the marker that records the move.

### A deprecation warning about the state bucket name

A state bucket created by an earlier version has the region in its name:
`cdkd-state-{accountId}-{region}`. cdkd still finds it and prints a
deprecation warning. To move it to the current name,
`cdkd-state-{accountId}`, run:

```bash
cdkd state migrate
```

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
