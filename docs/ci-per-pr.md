---
title: Per-PR Environments in CI
description: Deploy one ephemeral stack per pull request with cdkd in GitHub Actions — CDK context stack suffix, OIDC role design, and teardown housekeeping.
---

# Per-PR Environments in CI

Deploy time is CI job time, and a PR environment redeploys on every
push — so cdkd's speedup compounds across a PR's lifetime. Because
cdkd needs **zero CDK code changes**, you can swap only the PR-environment
workflow to cdkd and keep production / staging on the CDK CLI; switching
back is a one-line workflow revert.

Run `cdkd bootstrap` once per AWS account beforehand (creates the state
bucket + asset storage; `cdk bootstrap` is not required).

## One stack per PR

Pass the PR number as CDK context and suffix the stack name. cdkd state is
keyed by (stack name, region) and locks are per-stack, so PR environments
deploy concurrently without contention:

```ts
const prNumber = app.node.tryGetContext('prNumber');
new WebAppStack(app, `WebApp${prNumber ? `-pr-${prNumber}` : ''}`);
```

## Credentials

cdkd calls AWS APIs directly, so the deploying identity needs permissions
for every deployed resource (CDK's
`cdk-hnb659fds-*` roles do not work: they are designed for
CloudFormation delegation, and cdkd uses its own bootstrap storage).
Create a dedicated deploy role and switch into it with
[`--role-arn`](cli-reference.md#role-arn) (or the
`CDKD_ROLE_ARN` env var): the workflow's OIDC base role needs only
`sts:AssumeRole` on the deploy role, and the deploy role's trust policy
allows only that base role — the strong permissions live in exactly one
place, reachable through one path, and never sit on the CI runner
itself.

## A minimal GitHub Actions workflow

Deploy on open / synchronize / reopen, destroy on close:

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

The destroy job has no checkout and no `npm ci`, which is why it invokes the
full package name — there is no local install for `npx` to find. It needs
neither, and no synth either, because
[`cdkd state destroy`](cli-state.md#cdkd-state-destroy) deletes from the state
record alone, so it works even after the branch is gone.

## Making the teardown complete

The destroy job above runs `cdkd state destroy`. The first two flags exist on
it and on `cdkd destroy` alike; the third is `cdkd destroy`-only. An ephemeral
PR environment has nothing worth protecting, so a teardown that needs a second
pass is a teardown that leaves resources billing.

| Flag | Reach for it when | Without it |
| --- | --- | --- |
| [`--remove-protection`](cli-destroy.md#remove-protection-bypass-deletion-protection-on-destroy) | The environment has RDS or DynamoDB deletion protection, EC2 termination protection, or any other protection-enabled resource | Those resources survive the job and linger until the next sweep |
| [`--skip-final-snapshot`](cli-destroy.md#deletionpolicy-snapshot-final-snapshots-on-delete-skip-final-snapshot) | The environment's data is disposable and a resource carries `DeletionPolicy: Snapshot` | A final snapshot accumulates on every PR close |
| `--purge-events` (`cdkd destroy` only) | You want an object listing of the state bucket to come back empty (earlier object versions still survive) | The stack's deployment-event history is kept as post-mortem context |

`cdkd state destroy` does not accept `--purge-events` — passing it is an
unknown-option error. Run `cdkd events prune <stack> --all` after the teardown
instead.

## Housekeeping

- Pick the wait mode from what runs next (see
  [wait modes](wait-modes.md)): review-only environments can use
  `--no-wait`; E2E tests after the deploy should keep the default, or
  `--full-wait` when they need ECS steady state / CloudFront
  propagation.
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
  divergence). See [Exit codes](cli-reference.md#exit-codes) for
  per-command semantics.

## Related

- [Destroy flags & guards](cli-destroy.md) — the guards the teardown job turns
  off, and what each one protects
- [`cdkd state`](cli-state.md) — the state-driven commands the destroy job runs,
  with their flags and exit codes
- [Orphan vs Destroy](orphan-vs-destroy.md) — why the destroy job needs no
  checkout
- [Wait Modes](wait-modes.md) — choosing what "done" means for the deploy job
- [CLI Reference](cli-reference.md) — every command and the full exit-code table
