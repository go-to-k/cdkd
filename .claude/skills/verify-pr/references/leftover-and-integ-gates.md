# Step 6 — Leftover resources and the integ runs

Read at step 6 of `/verify-pr`. Most of this file is CONDITIONAL: each integ
block applies only when the diff touches its scope.

Only ONE of them is still a gate. `integ-destroy` blocks `gh pr merge` on a stale
marker; the cross-cutting, local-execution and schema-bump runs below are
UNENFORCED — nothing stops the merge, so the decision to run them is yours, and
CLAUDE.md's "cost is not a tiebreaker" is what settles it.

## Baseline

- Account: `aws sts get-caller-identity --query Account --output text`;
  `aws s3 ls s3://cdkd-state-{accountId}-us-east-1/stacks/ --region us-east-1`
  — no leftover state.

## Deletion-touching PRs

Changes under `src/provisioning/providers/**`, `src/cli/commands/destroy.ts`,
`src/analyzer/dag-builder.ts` and the rest of the `include:` list in
`.markgate.yml`: `gh pr merge` is blocked while the `integ-destroy` marker is
stale. Check it here so a failure surfaces early rather than at the merge:

```bash
mise exec -- markgate verify integ-destroy
```

**Read the exit code — two non-zero outcomes have opposite remedies**:

- **exit 1** — genuinely stale (in-scope change on this branch, or the 14d TTL
  expired). Run `/run-integ <relevant-test>` and confirm 0 errors / 0 orphans;
  the skill sets the marker itself.
- **exit 2** — markgate could not EVALUATE the gate (`origin/main` unresolvable,
  or no delta against the merge base). `/run-integ` cannot fix this —
  `markgate set` fails on the identical condition, so running one burns a
  real-AWS run and leaves the gate blocked. Remedy: `git fetch origin` (or
  `--unshallow`, or commit the branch's work).

CI is necessary but not sufficient — it does not exercise real-AWS destroy.

## Cross-cutting PRs

The `integ-destroy` marker accepts ANY clean real-AWS destroy — a narrow feature
integ flips it without exercising the broad deploy/destroy paths a cross-cutting
change touches. When the diff touches any of `src/deployment/{deploy-engine,intrinsic-function-resolver,retry,retryable-errors,rollback-executor}.ts`,
`src/cli/commands/{destroy-runner,destroy,deploy}.ts`,
`src/analyzer/{dag-builder,template-parser}.ts` or
`src/provisioning/{register-providers,provider-registry}.ts`,
...run a **broad integ** in addition to the feature integ. Cross-cutting code
affects every user's deploy/destroy, and a broad fixture is the only defense
against a regression that surfaces on stacks unlike your fixture. Keep the set
below in step with `/run-integ`'s "Choosing the fixture" section and
`/pick-integ`'s BROAD set — nothing compares them for you:

- `bench-cdk-sample` (39-resource VPC+NAT+CF+Lambda+SQS)
- `lambda`
- `microservices`
- `drift-revert`
- `drift-revert-vpc`
- `multi-stack-deps`
- `multi-resource`
- `remove-protection`
- `export`

```bash
if git diff origin/main...HEAD --name-only | grep -qE '^src/deployment/(deploy-engine|intrinsic-function-resolver|retry|retryable-errors|rollback-executor)\.ts$|^src/cli/commands/(destroy-runner|destroy|deploy)\.ts$|^src/analyzer/(dag-builder|template-parser)\.ts$|^src/provisioning/(provider-registry|register-providers)\.ts$'; then
  echo "Cross-cutting code touched — broad integ required."
fi
```

Both integs must pass; both refresh the same `integ-destroy` marker.

## Local-execution-touching PRs

When the diff touches `src/local/**`, `src/cli/commands/local-*.ts` or
`tests/integration/local-*/**`, run a matching local integ before the merge:

```bash
if git diff origin/main...HEAD --name-only | grep -qE '^src/local/|^src/cli/commands/local-|^tests/integration/local-'; then
  echo "Local-execution code touched — run /run-integ local-<test> before merging."
fi
```

Pick the fixture matching the changed surface: `local-start-api` for
HTTP-server / authorizer / container-pool, `local-invoke` for Lambda-runtime /
ZIP-asset, `local-run-task` for ECS, `local-invoke-container` for
container-Lambda, `local-invoke-layers` for Layers. Confirm `/run-integ`'s
post-run Docker sweep came back empty. `local-invoke-from-state` exercises the
local path AND refreshes `integ-destroy`.

## State-schema-bump PRs

A PR that bumps `StackState.version` must prove the round-trip with
`/run-integ schema-v<N>-to-v<N+1>-migration` before merging, and
`integ-schema-migration-gate.sh` blocks `gh pr merge` until it has. The S3 state schema
is the real user contract and transparent auto-migration is absolute — a user
must do NOTHING on upgrade — so this is a design constraint to satisfy while
writing the bump, not a box to tick at the end.

## Orphan spot-check

Spot-check the failure-prone types per region the PR touched (typically
`us-east-1`): VPCs (`describe-vpcs --filters "Name=tag:Name,Values=Cdkd*/Vpc"`),
Lambda hyperplane ENIs
(`describe-network-interfaces --filters "Name=description,Values=AWS Lambda VPC ENI-*"`),
CloudFront Distributions, NAT Gateways. Any match against a stack name in the
diff is an orphan; clean up before merge.
