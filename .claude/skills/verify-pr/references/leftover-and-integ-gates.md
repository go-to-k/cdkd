# Step 6 — Leftover resources and the integ runs

Read at step 6 of `/verify-pr`. Most of this file is CONDITIONAL: each integ
block below applies only when the diff touches its scope, so a typical run reads
the first block and skips the rest. That is why it lives here rather than in the
orchestrator, which is loaded on every invocation.

Only ONE of them is still a gate. `integ-destroy` blocks `gh pr merge` on a
stale marker; the cross-cutting, local-execution and schema-bump runs below are
now UNENFORCED — nothing stops the merge, so the decision to run them is yours,
and CLAUDE.md's "cost is not a tiebreaker" is what settles it.

`tests/unit/scripts/cross-cutting-list-sync.test.ts` used to read THIS file in
three places, each by an anchor phrase immediately followed by a bullet run or a
fenced snippet. Its scope is now `integ-destroy` alone, so those anchors are no
longer read and nothing fails when one is reworded — the lists below are kept in
step with their siblings by hand. The anchor shapes are left intact anyway,
because restoring the comparison means restoring them.

**Do not repeat one of those phrases elsewhere in this file either.** ONE of the
three extractors — the canonical-broad-set one — spans lines lazily
(`[\s\S]*?`), so a second occurrence in prose bridges to the real list and the
fence stops discriminating. Measured on go-to-k/cdkd#2930: an earlier version of
THIS paragraph quoted that anchor, and rewording the real one left the suite
green. The other two never bridged — the bullet-list anchor demands a newline
immediately, and the detection-snippet one is quote-bounded and greedy.

That warning is not theoretical twice over: an earlier draft of THIS paragraph
spelled out the detection snippet's opening literal in order to explain it, and
the snippet extractor — which binds to the first occurrence in the file — bound
to the explanation instead of the code. Describe those two snippets; never
reproduce their opening line.

The two of them share that opening, so the extractor reads whichever comes
first. Removing the cross-cutting snippet therefore makes it read the
local-execution one, which is caught downstream by `expandPathRegex`'s shape
refusal rather than by the extractor itself — a thinner margin than it looks.
Keep them in this order.

## Baseline

- Account: `aws sts get-caller-identity --query Account --output text`;
  `aws s3 ls s3://cdkd-state-{accountId}-us-east-1/stacks/ --region us-east-1`
  — no leftover state.

## Deletion-touching PRs

Changes under `src/provisioning/providers/**`, `src/cli/commands/destroy.ts`,
`src/analyzer/dag-builder.ts`, etc.: `gh pr merge` is blocked while the
`integ-destroy` marker is stale (the one surviving markgate gate — its full
scope is the `include:` list in `.markgate.yml`). Check it here so a failure
surfaces early rather than at the merge:

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

CI is necessary but not sufficient — it does not exercise real-AWS destroy; the
gate is the structural enforcement of that fact.

## CROSS-CUTTING CHECK (load-bearing)

The `integ-destroy` marker accepts ANY clean real-AWS destroy — a narrow feature
integ flips it without exercising the broad deploy/destroy paths a cross-cutting
change touches. When the PR diff touches ANY of:

- `src/deployment/deploy-engine.ts`
- `src/deployment/intrinsic-function-resolver.ts`
- `src/cli/commands/destroy-runner.ts`
- `src/cli/commands/destroy.ts`
- `src/cli/commands/deploy.ts`
- `src/analyzer/dag-builder.ts`
- `src/analyzer/template-parser.ts`
- `src/provisioning/register-providers.ts`
- `src/provisioning/provider-registry.ts`
- `src/deployment/retry.ts`
- `src/deployment/retryable-errors.ts`
- `src/deployment/rollback-executor.ts`

...you MUST run a **broad integ** in addition to the feature integ. Nothing
blocks the merge if you skip it — that is precisely why it is spelled out here.
(Nothing compares these lists across files any more: the fence that did was
scoped to the retired broad gate, so a copy edited alone now drifts silently.)
The canonical broad set (keep in sync with `/run-integ`'s "Choosing the
fixture" section and `/pick-integ`'s BROAD set):

- `bench-cdk-sample` (39-resource VPC+NAT+CF+Lambda+SQS)
- `lambda`
- `microservices`
- `drift-revert`
- `drift-revert-vpc`
- `multi-stack-deps`
- `multi-resource`
- `remove-protection`
- `export`

Cross-cutting code affects EVERY user's deploy/destroy; the broad integ is the
only defense against a regression that surfaces on stacks unlike your fixture
(the PR #348 / issue #343 incident).

```bash
# Detection: only fires when the diff actually touches cross-cutting code.
if git diff origin/main...HEAD --name-only | grep -qE '^src/deployment/(deploy-engine|intrinsic-function-resolver|retry|retryable-errors|rollback-executor)\.ts$|^src/cli/commands/(destroy-runner|destroy|deploy)\.ts$|^src/analyzer/(dag-builder|template-parser)\.ts$|^src/provisioning/(provider-registry|register-providers)\.ts$'; then
  echo "Cross-cutting code touched — broad integ required (bench-cdk-sample / lambda / microservices / drift-revert)."
  # Then run the broad integ via /run-integ and confirm 0 errors / 0 orphans.
fi
```

Both integs must pass; both refresh the same `integ-destroy` marker.

## Local-execution-touching PRs

When the diff touches `src/local/**`, `src/cli/commands/local-*.ts` or
`tests/integration/local-*/**`, run a matching local integ before the merge —
nothing blocks on it:

```bash
if git diff origin/main...HEAD --name-only | grep -qE '^src/local/|^src/cli/commands/local-|^tests/integration/local-'; then
  echo "Local-execution code touched — run /run-integ local-<test> before merging."
fi
```

Pick the fixture matching the changed surface: `local-start-api` for
HTTP-server / authorizer / container-pool, `local-invoke` for Lambda-runtime /
ZIP-asset, `local-run-task` for ECS, `local-invoke-container` for
container-Lambda, `local-invoke-layers` for Layers. Confirm `/run-integ`'s
post-run Docker sweep came back empty. `local-invoke-from-state` is worth
knowing about: it exercises the local path AND refreshes `integ-destroy`.

## State-schema-bump PRs

A PR that bumps `StackState.version` must prove the round-trip with
`/run-integ schema-v<N>-to-v<N+1>-migration` before merging. The S3 state
schema is the real user contract and transparent auto-migration is absolute —
a user must do NOTHING on upgrade — so this is a design constraint to satisfy
while writing the bump, not a box to tick at the end.

## Orphan spot-check

Spot-check the failure-prone types per region the PR touched (typically
`us-east-1`): VPCs (`describe-vpcs --filters "Name=tag:Name,Values=Cdkd*/Vpc"`),
Lambda hyperplane ENIs
(`describe-network-interfaces --filters "Name=description,Values=AWS Lambda VPC ENI-*"`),
CloudFront Distributions, NAT Gateways. Any match against a stack name in the
diff = orphan; clean up before merge.
