# Integration test: `cdkd import --migrate-from-cloudformation`

End-to-end verification of the one-shot CloudFormation → cdkd migration
flow. Two stacks cover the two retire-template-size paths:

| Stack | Synthesized template | Retire path |
|---|---|---|
| `CdkdMigrateSmall` | small (≤ 51,200 bytes) | inline `TemplateBody` |
| `CdkdMigrateLarge` | large (> 51,200 bytes — Lambda + 60 KB padded inline code) | upload to cdkd state bucket and submit via `TemplateURL` (the path added in PR #113) |

This intentionally lives outside `/run-integ` because the migration flow is
`cdk deploy` → `cdkd import` → `cdkd destroy`, which `/run-integ` does not
model — that skill exercises `cdkd deploy` → `cdkd destroy`.

## Prerequisites

- AWS credentials with permission to deploy CloudFormation, S3, IAM,
  Lambda, and SSM in the target region (default `us-east-1`).
- cdkd state bucket bootstrapped (`cdkd bootstrap`). The script auto-detects
  `cdkd-state-{accountId}` and falls back to the legacy
  `cdkd-state-{accountId}-{region}` bucket.
- `npx cdk` available on `PATH` (CDK CLI is also pinned in this dir's
  `package.json`).

## Run

```bash
# Both stacks in sequence (default):
./run.sh

# Only one path:
./run.sh small   # inline TemplateBody
./run.sh large   # >51,200B TemplateURL upload
```

The script:

1. Builds `cdkd` from the repo root so it tests the current worktree.
2. Pre-flight scans for orphan state and any pre-existing CFn stack with
   the same name; aborts if anything is found.
3. Runs `cdk deploy <stack>` (real CloudFormation).
4. Runs `cdkd import <stack> --migrate-from-cloudformation --yes`.
5. Asserts: cdkd state was written, the CFn stack is gone, and
   `s3://<bucket>/cdkd-migrate-tmp/` is empty (the large path uploads a
   transient template; the cleanup must run in `finally`).
6. Runs `cdkd destroy <stack> --force`.
7. Asserts: cdkd state is empty.

A successful run ends with `=== ALL CHECKS PASSED ===` and zero leftover
AWS resources.

## What it verifies

- Pre-import physical-ID resolution via `DescribeStackResources`.
- The 4-step retire flow (`DescribeStacks` → `GetTemplate` Original-stage →
  inject Retain → `UpdateStack` → `DeleteStack`).
- The state-bucket `TemplateURL` upload + `finally` cleanup added in
  PR #113 (the only path the small stack does NOT exercise).
- That `cdkd destroy` can walk and delete state populated by the migration
  rather than by `cdkd deploy`.

## When to run

- On any PR touching `src/cli/commands/retire-cfn-stack.ts` or the
  `--migrate-from-cloudformation` code path in `src/cli/commands/import.ts`.
- Periodically against a stable account to catch regressions (CFn API
  shape, IAM-policy changes affecting same-account `TemplateURL`, etc.).
