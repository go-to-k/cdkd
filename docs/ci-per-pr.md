---
title: Per-PR Environments in CI
description: "Deploy one ephemeral stack per pull request with cdkd in GitHub Actions: stack naming, the deploy role, the workflow, and a teardown that leaves nothing behind."
---

# Per-PR Environments in CI

A per-PR environment is a copy of your stack that exists for one pull
request. CI deploys it when the pull request opens, redeploys it on every
push, and destroys it when the pull request closes. Each of those deploys is
billed CI time, so cdkd's faster deploys add up over the life of a pull
request.

cdkd needs no change to your CDK code. You can move only the PR workflow to
cdkd and keep production and staging on the AWS CDK CLI. To go back, revert
the workflow.

This page sets it up in four parts: bootstrap the account, give each PR its
own stack, create a deploy role, and write the workflow.

## Bootstrap the account

Run `cdkd bootstrap` once per AWS account, before the first workflow run. It
creates the bucket for cdkd's state, its record of what it deployed, and the
storage for your app's assets. You do not need `cdk bootstrap`.

```bash
cdkd bootstrap
```

## One stack per PR

Each pull request needs a stack of its own, so that two PRs do not overwrite
each other. Pass the PR number to the app as CDK context, and put it in the
stack name:

```ts
const prNumber = app.node.tryGetContext('prNumber');
new WebAppStack(app, `WebApp${prNumber ? `-pr-${prNumber}` : ''}`);
```

```bash
cdkd deploy --yes -c prNumber=123   # deploys WebApp-pr-123
```

cdkd keeps state for each stack name and region separately, and locks each
stack separately. PR environments can therefore deploy at the same time
without waiting for each other.

## Credentials

cdkd calls AWS APIs directly, so the identity that deploys needs permissions
for every resource in the stack. The `cdk-hnb659fds-*` roles that
`cdk bootstrap` creates do not work here, because they are built to hand a
deployment to CloudFormation.

Create a dedicated deploy role, and have cdkd assume it from a second role
that can do nothing else:

| Role | Permissions | Trusted by |
| --- | --- | --- |
| Base role | `sts:AssumeRole` on the deploy role only | GitHub's OIDC provider |
| Deploy role | Everything the stack's resources need | The base role only |

The workflow signs in as the base role through OIDC. cdkd then assumes the
deploy role, which you name with `--role-arn` or the `CDKD_ROLE_ARN`
environment variable. With this setup the strong permissions live in one
role with one way in, and the CI runner's own credentials can do nothing but
assume it. [Credentials and --role-arn](cli-reference-credentials.md)
explains how `--role-arn` behaves.

## A minimal GitHub Actions workflow

The workflow has two jobs. The `deploy` job runs when a pull request is
opened, pushed to or reopened. The `destroy` job runs when it is closed.

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
      - run: |
          npx cdkd deploy --yes \
            -c prNumber=${{ github.event.pull_request.number }}
  destroy:
    if: github.event.action == 'closed'
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-actions-base
          aws-region: us-east-1
      - run: |
          npx @go-to-k/cdkd state destroy \
            WebApp-pr-${{ github.event.pull_request.number }} \
            --yes
```

The destroy job has no checkout and no `npm ci`, and that is deliberate.
`cdkd state destroy` reads only the stack's state and does not synthesize the
app, so the job still works after the branch has been deleted. Because the
job has no local install for `npx` to find, it invokes cdkd by its full
package name, `@go-to-k/cdkd`.

## Make the teardown complete

A plain destroy protects some resources, and in a PR environment that
protection only leaves resources behind that keep costing money. Three flags
remove what a plain destroy keeps.

### `--remove-protection`

Add it when a resource in the stack has deletion protection or termination
protection, such as an RDS instance, a DynamoDB table or an EC2 instance.
Without the flag, those resources survive the job.

### `--skip-final-snapshot`

Add it when a resource has `DeletionPolicy: Snapshot` and its data is
disposable. Without the flag, every PR that closes leaves a final snapshot.

### `--purge-events`

Add it when you do not want to keep the stack's deployment history, the
record of what each deploy did. Without the flag, the history stays in the
state bucket, where you can read it after a failure.

`--purge-events` exists on `cdkd destroy` only. `cdkd state destroy` rejects
it as an unknown option. The workflow above uses `cdkd state destroy`, so
delete the history there in a second step:

```bash
cdkd state destroy WebApp-pr-123 --yes --remove-protection --skip-final-snapshot
cdkd events prune WebApp-pr-123 --all
```

`--remove-protection` and `--skip-final-snapshot` work on both destroy
commands.

## Housekeeping

These tasks come up once PR environments are running.

### Choose how long the deploy waits

Use `cdkd deploy --no-wait` for environments that are only looked at by a
reviewer. Use the default, or `--full-wait`, when end-to-end tests run right
after the deploy. See [Wait Modes](wait-modes.md).

### Clear a lock left by a cancelled job

A job cancelled in the middle of a deploy, for example by
`concurrency.cancel-in-progress`, leaves the stack locked. The lock expires
after 30 minutes. To clear it sooner:

```bash
cdkd force-unlock WebApp-pr-123
```

### Find forgotten environments

List every stack in the state bucket on a schedule, and compare the list with
your open pull requests:

```bash
cdkd state list --json
```

### Delete assets no stack uses

Assets that no stack refers to any more stay in storage until you delete
them. `cdkd gc` deletes them. Preview first:

```bash
cdkd gc --older-than 30d --dry-run
cdkd gc --older-than 30d
```

`cdkd gc` stops without deleting anything while any stack is locked, so
schedule it outside the hours when deploys run.

### Comment the environment URL on the PR

Publish the URL as a stack output, and read it back in the workflow:

```bash
cdkd state show WebApp-pr-123 --json
```

### Check a PR without deploying

`cdkd diff --fail` exits `1` when the deploy would change anything.
`cdkd diff --fail-on=destructive` exits `1` only when it would replace,
delete or orphan a resource.

### Check a running environment for outside changes

`cdkd drift --json` reports resources that were changed in AWS outside cdkd.
See [Drift Detection](drift.md).

## Related

- [cdkd destroy](cli-destroy.md): the guards the teardown flags
  turn off, and what each one protects
- [`cdkd state`](cli-state.md): `cdkd state destroy` and the other commands
  that work from state
- [Orphan vs Destroy](orphan-vs-destroy.md): the cleanup commands compared
- [Wait Modes](wait-modes.md): choosing what "done" means for the deploy job
- [CLI Reference](cli-reference.md): every command and the exit codes
