---
title: Per-PR Environments in CI
description: "Deploy one ephemeral stack per pull request with cdkd in GitHub Actions: stack naming, the deploy role, the workflow, and a teardown that leaves nothing behind."
---

# Per-PR Environments in CI

A per-PR environment is a copy of your stack that is deployed when a pull
request opens, redeployed on every push, and destroyed when the pull request
closes. Every one of those deploys is billed CI time, so cdkd's faster deploys
add up over the life of a pull request.

cdkd needs no change to your CDK code. You can switch only the PR workflow to
cdkd, keep production and staging on the CDK CLI, and switch back by
reverting the workflow.

This page sets it up in four parts: bootstrap, one stack per PR, a deploy
role, and the workflow.

## Before you start

Run `cdkd bootstrap` once per AWS account. It creates the state bucket and
the asset storage cdkd uses. `cdk bootstrap` is not required.

```bash
cdkd bootstrap
```

## One stack per PR

Pass the PR number as CDK context and add it to the stack name:

```ts
const prNumber = app.node.tryGetContext('prNumber');
new WebAppStack(app, `WebApp${prNumber ? `-pr-${prNumber}` : ''}`);
```

```bash
cdkd deploy --yes -c prNumber=123   # deploys WebApp-pr-123
```

cdkd keeps state per stack name and region, and locks per stack. PR
environments therefore deploy at the same time without waiting on each other.

## Credentials

cdkd calls AWS APIs directly, so the identity that deploys needs permissions
for every resource in the stack. The `cdk-hnb659fds-*` roles that `cdk
bootstrap` creates do not work here: they are built to hand a deployment to
CloudFormation.

Create one dedicated deploy role and have cdkd assume it:

| Role | Permissions | Trusted by |
| --- | --- | --- |
| Base role, assumed by the workflow through OIDC | `sts:AssumeRole` on the deploy role, nothing else | GitHub's OIDC provider |
| Deploy role | Everything the stack's resources need | The base role only |

Point cdkd at the deploy role with `--role-arn` or the `CDKD_ROLE_ARN`
environment variable. The strong permissions then live in one role that is
reachable through one path, and the CI runner's own credentials can do
nothing but assume it. See [CLI Reference](cli-reference.md) for how
`--role-arn` behaves.

## A minimal GitHub Actions workflow

The workflow deploys when a pull request is opened, pushed to or reopened,
and destroys when it is closed:

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

The destroy job has no checkout and no `npm ci`. `cdkd state destroy` deletes
from the state record alone and does not synthesize, so the job works after
the branch is gone. With no local install for `npx` to find, the job invokes
cdkd by its full package name.

## Making the teardown complete

A PR environment holds nothing worth protecting, and a teardown that leaves a
resource behind leaves it billing. These flags remove what a plain destroy
keeps:

| Flag | Add it when | Without it |
| --- | --- | --- |
| `--remove-protection` | The stack has deletion or termination protection on a resource, such as RDS, DynamoDB or EC2 | Those resources survive the job |
| `--skip-final-snapshot` | A resource carries `DeletionPolicy: Snapshot` and its data is disposable | A final snapshot is added on every PR close |
| `--purge-events` | You do not want the stack's deployment-event history kept | The history stays in the state bucket for post-mortems |

`--remove-protection` and `--skip-final-snapshot` work on both `cdkd destroy`
and `cdkd state destroy`. `--purge-events` exists on `cdkd destroy` only, and
`cdkd state destroy` rejects it as an unknown option. In the workflow above,
prune the history in a second step:

```bash
cdkd state destroy WebApp-pr-123 --yes --remove-protection --skip-final-snapshot
cdkd events prune WebApp-pr-123 --all
```

## Housekeeping

| Task | How |
| --- | --- |
| Choose how long the deploy waits | `--no-wait` for review-only environments; the default, or `--full-wait`, when end-to-end tests run next. See [Wait Modes](wait-modes.md). |
| Clear a lock left by a cancelled job | It expires after 30 minutes, or run `cdkd force-unlock WebApp-pr-123` |
| Find forgotten environments | `cdkd state list --json` on a schedule |
| Reclaim unreferenced assets | `cdkd gc --older-than 30d --dry-run`, then without `--dry-run` |
| Comment the environment URL on the PR | Read the stack outputs with `cdkd state show WebApp-pr-123 --json` |
| Gate a PR without deploying | `cdkd diff --fail` exits `1` on any change; `cdkd diff --fail-on=destructive` only on a replace, delete or orphan |
| Check a live environment for changes made outside cdkd | `cdkd drift --json` |

A job cancelled mid-deploy, for example by `concurrency.cancel-in-progress`,
is what leaves a stack lock behind. `cdkd gc` aborts while any stack is
locked, so schedule it outside deploy hours.

## Related

- [Destroy flags & guards](cli-destroy.md): the guards the teardown flags
  turn off, and what each one protects
- [`cdkd state`](cli-state.md): the state-driven commands the destroy job
  runs
- [Orphan vs Destroy](orphan-vs-destroy.md): the cleanup commands compared
- [Wait Modes](wait-modes.md): choosing what "done" means for the deploy job
- [CLI Reference](cli-reference.md): every command and the exit codes
