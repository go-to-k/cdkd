---
title: Per-PR Environments in CI
description: Deploy one ephemeral stack per pull request with cdkd in GitHub Actions — CDK context stack suffix, OIDC role design, and teardown housekeeping.
---

# Use in CI: per-PR environments

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
[`--role-arn`](cli-reference.md#role-arn) (or the
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
[`cdkd state destroy`](orphan-vs-destroy.md) deletes from the state
record alone, so it works even after the branch is gone.

If the environment contains protection-enabled resources (RDS /
DynamoDB deletion protection, EC2 termination protection, and more),
add [`--remove-protection`](cli-reference.md#remove-protection-bypass-deletion-protection-on-destroy)
to the destroy so the teardown completes in one pass — an ephemeral PR
environment has nothing worth protecting, and without the flag those
resources survive the job and linger until the next sweep.

Two more teardown-completeness flags matter for disposable
environments: resources with `DeletionPolicy: Snapshot` leave a final
snapshot behind on every PR close by default — add
[`--skip-final-snapshot`](cli-reference.md#deletionpolicy-snapshot-final-snapshots-on-delete-skip-final-snapshot)
when the environment's data is disposable, so snapshots don't
accumulate per closed PR. And `cdkd destroy --purge-events` also
removes the stack's deployment-event history so the state bucket
returns fully empty (after a `state destroy`, the equivalent is
`cdkd events prune <stack> --all`).

**Housekeeping**:

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
