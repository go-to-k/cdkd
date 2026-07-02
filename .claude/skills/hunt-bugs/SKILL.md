---
name: hunt-bugs
description: Proactively hunt for cdkd bugs by deploying real CDK apps that exercise common-but-untested AWS resources, configs, and CloudFormation notations against real AWS, then fix what breaks. Use for a periodic "find latent bugs" sweep, not for verifying a specific change.
argument-hint: "[area hint, e.g. 'custom resources' | 'UPDATE paths' | 'CFn intrinsics']"
---

# cdkd Bug Hunt

Find latent cdkd bugs the way real users hit them: write a small CDK app that
uses a resource / config / CloudFormation notation **cdkd has not exercised
yet**, deploy it to real AWS, and watch what breaks — on both deploy AND
destroy. Reading the source finds *suspected* bugs; deploying finds *real*
ones. This skill is the deploy-first loop.

This is a deliberately exploratory, possibly-expensive workflow. Cost is
acceptable **only because every deployed resource is destroyed and verified
gone** — see "Cleanup is non-negotiable" below, which is enforced by a markgate
gate, not just trust.

## Core principles

1. **Many-people-hit beats niche.** Prioritize patterns a large fraction of CDK
   users write every day (S3→Lambda notifications, `BucketDeployment`, Lambda
   `logRetention`, `AwsCustomResource`, `LambdaRestApi`, adding a GSI / changing
   a property on redeploy, `grant*` IAM, cross-stack refs) over exotic edge
   cases. A bug in a daily pattern is worth ten niche ones.
2. **UPDATE and DESTROY are where bugs hide.** CREATE usually works; the high-
   value, under-tested paths are *re-deploying with a changed property*
   (replacement-vs-in-place classification, silent-drop of an updated field) and
   *deleting* (custom-resource onDelete, ordering, state cleanup). Always test a
   redeploy-with-a-change and always run destroy.
3. **Check coverage first.** Before building anything, `grep` the existing
   fixtures so you hunt in genuinely-uncovered territory:
   ```bash
   grep -rln "BucketDeployment\|addEventNotification\|logRetention\|AwsCustomResource\|LambdaRestApi\|NodejsFunction" tests/integration/
   ```
   Empty hits = untested = good hunting ground.
4. **Parallelize, but cap it.** Independent stacks (unique names, no shared
   global resource) can deploy/destroy concurrently as background tasks, but cap
   at ~4-5 in flight to avoid overloading the machine. One CDK app with several
   stacks (`cdkd deploy <StackName>` per stack) is the cleanest shape.
   **Pre-synth once, then deploy from the assembly** — parallel deploys that
   each re-synth collide on the shared `cdk.out` lock ("Another CLI is
   currently synthing to cdk.out"). Run `npx cdk synth --all -q` once, then
   `node dist/cli.js deploy <Stack> -a /tmp/cdkd-bughunt/cdk.out ...` per
   stack: no synth happens at deploy time, so parallel is safe. (Without `-a`,
   deploy stacks SERIALLY.)

## Workflow

### 1. Pick targets

Use the optional area hint, else pick 3-5 common-but-untested patterns (see
principle 1 + the coverage grep). Favor cheap, fast resources (S3 / SSM / IAM /
Lambda / DynamoDB / SNS / SQS / Logs / Events / API Gateway) so a round is
minutes, not hours. Note any genuinely slow ones (RDS / ElastiCache /
CloudFront) and run them sparingly.

### 2. Scaffold a throwaway app

Build cdkd first: `vp run build` (the CLI runs from `dist/`). Create one CDK app
under `/tmp/cdkd-bughunt/` with one stack per pattern, distinct stack names
prefixed so they never collide with other state (`CdkdBughunt<Pattern>`).
`pnpm install --ignore-workspace`, then `npx cdk synth --all -q` to catch synth
errors before any AWS call.

Resolve the state bucket: `cdkd-state-$(aws sts get-caller-identity --query Account --output text)`.
**Record every stack you are about to deploy into the bug-hunt sentinel** (this
is what arms the cleanup gate — see below):
```bash
.claude/skills/hunt-bugs/bughunt-track.sh add CdkdBughuntS3Notify CdkdBughuntBucketDeploy ...
```

### 3. Deploy (parallel, capped)

Deploy each stack with `node dist/cli.js deploy <Stack> -a <path-to-cdk.out> --state-bucket <bucket>`
(the pre-synthed assembly — see principle 4),
up to ~4-5 concurrently as background tasks, each to its own log. Watch for:
deploy-time errors, wrong replacement decisions (`Replacing X — immutable
properties changed`), silent drops, custom-resource hangs. For each stack also
do a quick **functional** check where cheap (e.g. put an S3 object and confirm
the Lambda notification fired) — a clean deploy summary is not proof the feature
works.

### 4. Test an UPDATE

For at least one stack, redeploy with a changed property (env var, memory,
add a GSI, add a tag, add a resource). Run `cdkd diff` first, then `cdkd deploy`.
This is the single richest bug source — verify the change actually reached AWS
and was NOT a surprise replacement.

### 5. Destroy + verify zero orphans — non-negotiable

Destroy **every** stack (`node dist/cli.js destroy <Stack> --state-bucket <bucket> --force`),
then verify nothing leaked, then clear the sentinel:
```bash
# state-side: no CdkdBughunt* state.json should remain (deployments/*.jsonl is
# the events store and is expected to survive — see note below)
aws s3 ls s3://<bucket>/cdkd/ | grep -i bughunt
# resource-side: sweep for the resources you created (Lambdas, tables, buckets,
# roles, log groups, SSM params) by their CdkdBughunt naming
.claude/skills/hunt-bugs/bughunt-track.sh verify   # asserts each tracked stack's
                                                    # state.json is gone
.claude/skills/hunt-bugs/bughunt-track.sh clear     # only after orphan-zero
```
If destroy failed or left orphans, **delete them by direct AWS API call before
doing anything else** — leaving orphans is never acceptable. Note: the
`deployments/` events store legitimately survives destroy (separate key family,
post-mortem history); it is NOT an orphan resource.

### 6. On a confirmed bug: fix it — with a unit test

When a deploy/update/destroy fails on a real cdkd bug:

1. **Root-cause it** in `src/` (replacement-rules, the provider's
   `create`/`update`/`delete`, the diff calculator, the DAG, the intrinsic
   resolver — wherever the divergence-from-CloudFormation lives).
2. **Fix it in a worktree** (`git worktree add .claude/worktrees/<branch> -b <branch> origin/main`),
   never in the main tree.
3. **Add a unit test that fails without the fix and passes with it.** This is
   mandatory, not optional — a bug found by integ MUST leave behind a unit test
   that pins the corrected behavior, so the regression can never come back
   silently. (Integ alone is too slow / expensive to be the only guard.)
4. **Re-run the live repro with the fixed binary** to confirm the real-AWS
   behavior is now correct (e.g. the GSI add becomes an in-place UpdateTable, not
   a replacement).
5. **Add a committed integ fixture** under `tests/integration/<name>/` that
   exercises the fixed path end-to-end (deploy → update → destroy), in the SAME
   PR as the fix — never defer the integ.
6. Run `/verify-pr`, then open the PR.

### 7. Record what you learned

Save a memory for any recurring surprise (a whole *class* of latent bug, a
verification gotcha) so the next sweep starts smarter.

## Cleanup is non-negotiable (markgate-enforced)

Forgetting to destroy bug-hunt resources is the one unacceptable outcome, so it
is enforced structurally rather than by discipline:

- `bughunt-track.sh add <stacks...>` records the deployed stack names in the
  gitignored sentinel under `.markgate-bughunt-pending.d/` (one file per owner).
- The `bughunt-clean` markgate gate (PreToolUse hook
  `.claude/hooks/bughunt-clean-gate.sh`) **blocks `git commit`, `gh pr create`,
  and `gh pr merge` while any tracked stack remains** — so you physically
  cannot land the fix PR (or any commit) until the bug-hunt resources are
  destroyed and verified gone.
- `bughunt-track.sh verify` confirms each tracked stack's `state.json` is gone
  from S3; `bughunt-track.sh clear` removes your stacks (releasing the gate once
  no owner has pending stacks) and is meant to be run ONLY after orphan-zero is
  verified.

**Parallel-safe by design.** The sentinel is per-owner, not a single shared
file, so multiple bug hunts can run concurrently (one agent per
`.claude/worktrees/<branch>/` worktree) without stepping on each other:
`add` / `verify` / `clear` touch only the caller's own owner file (owner key =
`$CDKD_BUGHUNT_OWNER` if set, else the per-worktree `git rev-parse
--show-toplevel`), so your `clear` can never release another hunt's still-live
resources. The gate aggregates across all owners (blocks while ANYONE is
pending) — the safe direction. Run all of one hunt's add/verify/clear from the
same worktree (or pin `CDKD_BUGHUNT_OWNER`) so they agree on the owner.

This mirrors the project's other "absolutely must happen" guarantees
(`integ-destroy`, `verify-pr`): the must-do is bound to a marker a gate checks,
not to remembering.
