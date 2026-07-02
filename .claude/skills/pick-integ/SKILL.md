---
name: pick-integ
description: Recommend which integration tests to run, based on the integ ledger (staleness / last result) plus the code areas touched by recent commits. Outputs a prioritized list of `/run-integ <name>` commands. Use before a release, after a batch of merges, or when unsure what integ coverage a change needs.
argument-hint: "[base-ref] (default: origin/main)"
---

# Integ Test Picker

Decide which integration tests are worth running right now. Running all ~95 is impractical
(real-AWS cost + hours; some take 20min+). This skill ranks tests by two signals — **how stale
the last run is** (from the committed ledger) and **whether recent code changes touch the area a
test exercises** — and prints a prioritized, copy-pasteable `/run-integ` plan. It RECOMMENDS only;
the orchestrator runs the chosen tests via `/run-integ` (which records each run back into the ledger).

## Inputs

- Optional positional `base-ref` (default `origin/main`): the diff base for "what changed recently".
  Use the last release tag / commit when picking post-merge; use `origin/main` when picking for a branch.

## Data sources

1. **Ledger** `docs/_generated/integ-last-run.tsv` (committed, update-type, one row per test):
   columns `test  last_run_iso  result  duration_s  flow  note`. Written by `/run-integ` on every run.
   - **Stale**: `last_run_iso` older than the integ-gate TTL window (**14 days** — past that, the gate
     markers themselves expire, so a clean result no longer proves today's AWS behavior). Bias the
     threshold down (treat as stale sooner) for AWS-coupled paths.
   - **Failing**: `result == FAIL` — always a candidate (re-run after a fix, or to confirm still-broken).
   - **Never-run**: a directory under `tests/integration/` with NO ledger row — highest staleness.

2. **Recent code changes**: `git diff <base-ref>...HEAD --name-only` (and/or `git log <base-ref>..HEAD`).
   Map changed source paths to the integ tests that exercise them (table below).

## Steps

1. **Discover the universe + ledger state**:
   ```bash
   LEDGER="docs/_generated/integ-last-run.tsv"
   now=$(date -u +%s)
   # The ledger merges with the union driver (.gitattributes), so a rare
   # same-test collision can leave duplicate rows — the LAST row per test is
   # authoritative (deduped below before any staleness math).
   DEDUPED="$(mktemp)"
   awk -F'\t' 'NR==1{print; next} {last[$1]=$0; order[$1]=NR} END{for (t in last) print last[t]}' "$LEDGER" > "$DEDUPED"
   # never-run: fixtures with no ledger row
   comm -23 \
     <(ls -d tests/integration/*/ | sed 's#tests/integration/##;s#/##' | sort) \
     <(awk -F'\t' 'NR>1{print $1}' "$DEDUPED" | sort)
   # stale (>14d) or failing, from the ledger:
   awk -F'\t' -v now="$now" 'NR>1 {
     cmd="date -u -j -f %Y-%m-%dT%H:%M:%SZ \""$2"\" +%s 2>/dev/null || date -u -d \""$2"\" +%s 2>/dev/null";
     cmd | getline t; close(cmd);
     age=int((now-t)/86400);
     if ($3=="FAIL" || age>14) printf "%s\tage=%sd\tresult=%s\t%s\n",$1,age,$3,$6
   }' "$DEDUPED"
   ```
   (The `date` line handles both BSD/macOS `-j -f` and GNU `-d`.)

2. **Map recent changes to tests**. Run `git diff <base-ref>...HEAD --name-only` and apply this heuristic
   (a changed path pulls in the listed integ tests; when in doubt, include the broad set):

   | Changed path | Integ tests to run |
   |---|---|
   | `src/deployment/deploy-engine.ts`, `src/deployment/intrinsic-function-resolver.ts`, `src/analyzer/dag-builder.ts`, `src/analyzer/template-parser.ts`, `src/cli/commands/{deploy,destroy,destroy-runner}.ts`, `src/provisioning/register-providers.ts` | **BROAD set** (`bench-cdk-sample`, `lambda`, `microservices`, `multi-resource`, `multi-stack-deps`, `drift-revert`, `drift-revert-vpc`, `remove-protection`, `export`) — cross-cutting deploy/destroy. Also `cross-stack-references` for any cross-stack/exports change. |
   | `src/state/**`, `src/state/export-index-store.ts` | `schema-v<N>-to-v<N+1>-migration` (latest), `cross-stack-references`, `import-value-strong-ref` |
   | `src/provisioning/providers/<Svc>*` | the matching service integ (`iam-managed-policy`, `dynamodb-*`, `s3-*`, `rds-*`, `kms-encryption`, `stepfunctions`, `eventbridge`, `sns-sqs-event`, `cognito`, `wafv2`, `route53`, …). Custom Resource changes → `custom-resource-provider`. |
   | `src/provisioning/cloud-control-provider.ts` | `cc-api-fallback`, `cc-api-fallback-transitions`, `recreate-via-cc-api` |
   | `src/local/**`, `src/cli/commands/local-*.ts` | the matching `local-*` test (`local-invoke`, `local-start-api`, `local-start-service`, `local-start-alb`, `local-run-task`, `local-invoke-agentcore`, `local-invoke-container`, …). `src/local/` bump / cross-cutting → at least `local-invoke` + `local-start-api`. |
   | `src/cli/commands/{export,import,migrate,retire-cfn-stack}*` | `export`, `export-nested-stack`, `migrate-from-cfn`, `import-nested-stack`, `import-value-strong-ref` |
   | `src/synthesis/macro-*` | `macro-expansion` |
   | `package.json` (cdk-local bump) | `local-*` cluster (the bump's blast radius) |

3. **Rank** the union of {changed-area tests} ∪ {failing tests} ∪ {stale >14d} ∪ {never-run}:
   - **P0**: changed-area AND (stale OR failing OR never-run) — the change touches code whose proof is also old/broken.
   - **P1**: changed-area but recently-green — verify the change didn't regress it.
   - **P2**: not changed-area but stale >14d / failing / never-run — coverage hygiene (cap to a sensible number; prefer the BROAD set + a spread of providers, and `log()` what you dropped).
   Bias up for the AWS-coupled, deletion-sensitive, multi-resource paths; bias down for pure docs/test/skill changes (often need NO integ).

4. **Render the plan**:
   ```
   Recommendation: run N integ tests (P0: ..., P1: ..., P2: ...)
   Base: <base-ref> (<changed-file-count> files changed)

   P0 (changed + stale/failing/never-run):
     /run-integ <name>    # <why: which changed path + age/result>
   P1 (changed, recently green):
     /run-integ <name>    # verify no regression in <area>
   P2 (coverage hygiene, capped):
     /run-integ <name>    # stale <age>d / never-run

   Skipped (recently green + untouched): <count> tests — list a few + note the cap.
   ```

## Running a large plan across sessions

A big plan (dozens of `/run-integ` calls) will NOT finish in one session: a single
session's context degrades after roughly 15-20 deploy/destroy cycles, and the tell-tale
symptom is garbled / malformed tool calls. Pushing past that point drops orphans and
misreads results. So treat a large sweep as a **multi-session relay**, and make the
orchestrator aware of it up front:

- Run in small batches (~4-5 tests). After EACH batch: (a) verify the account is
  orphan-clean — `aws s3 ls s3://<bucket>/cdkd/ --recursive | grep state.json` returns 0,
  and no live NAT / RDS / OpenSearch / Redshift / ElastiCache / EC2 — and (b) commit the ledger.
- A backgrounded batch loop can have a single test's subshell die right after `node deploy`
  returns but before `node destroy` (intermittent), leaving a full orphan (incl. a NAT GW).
  The post-batch state.json scan above is what catches it — never skip it. The orphan's
  stack NAME often differs from the fixture dir name; read it from the deploy log / synth.
- When context gets heavy (long transcript, ANY garbled tool call, or after ~15 tests this
  session): **STOP cleanly — do not power through.** Commit the ledger, then hand off:
  tell the user "ran N more (list), account clean, ~M remain — open a NEW session and say
  'continue the sweep' to keep going." An in-progress sweep should also leave a project
  memory with the remaining list + any FAIL / orphan finding so the next session resumes fast.
- The sweep is DONE only when `/pick-integ` shows no stale tests left. Until then each
  session runs a slice and passes the baton; the committed ledger is the source of truth.
- A `FAIL` that is fixture staleness (AWS retired an engine / instance / node tier the
  fixture hardcodes — e.g. `Cannot find version 17.4 for postgres`) is NOT a cdkd bug;
  record it as such and queue a fixture version-bump follow-up rather than blocking the sweep.

## Important

- This skill never runs `/run-integ` itself — it prints the plan; the orchestrator runs the chosen tests
  (serially — they share one AWS account; mind VPC/EIP/NAT account limits).
- The ledger is only as good as its discipline: it is updated by `/run-integ` on EVERY run (pass or fail).
  If a test's row looks impossibly old, it may simply not have been run via the skill — treat absent/old as stale.
- "Recently green + untouched" tests are the ones it is safe to SKIP; surface the count so a human can override.
- Pure docs / `.claude/skills` / test-only diffs usually need NO integ — say so rather than padding the list.
