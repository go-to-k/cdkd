---
name: pick-integ
description: Recommend which integration tests to run, based on the integ ledger (staleness / last result) plus the code areas touched by recent commits. Outputs a prioritized list of `/run-integ <name>` commands. Use before a release, after a batch of merges, or when unsure what integ coverage a change needs.
argument-hint: "[base-ref] (default: origin/main)"
---

# Integ Test Picker

Decide which integration tests to run right now, ranked by two signals: how
stale the last run is (from the committed ledger) and whether recent changes
touch the area a test exercises. It RECOMMENDS only; the orchestrator runs
the chosen tests via `/run-integ`.

**The ranking is a running ORDER, not a budget** (CLAUDE.md → "Cost is not a
tiebreaker"): when several tests plausibly cover the touched code, run all of
them, and prefer a broad-set fixture whenever the change is cross-cutting.
Priorities decide what runs FIRST; a plan too long for one session is handed
forward per "Running a large plan across sessions" — never silently
truncated, and the wrap-up names exactly which tests were not run.

## Inputs

- Optional positional `base-ref` (default `origin/main`): the diff base. Use
  the last release tag when picking post-merge; `origin/main` for a branch.

## Data sources

1. **Ledger** `docs/_generated/integ-last-run.tsv` (committed, one row per
   test; written by `/run-integ` on every run):
   - **Stale**: age > the integ-gate TTL (**14 days**) — past that the gate
     markers expire, so a clean result no longer proves today's AWS behavior.
   - **Expiring soon**: age **12–14d**. The ledger accumulates in
     sweep-shaped cohorts (one sweep stamps 100+ rows with one timestamp), so
     a strict `>14d` boolean answers "nothing" or "everything" — always
     report this tier; "zero stale" is misleading when 105 tests cross the
     TTL tomorrow (issue #1508).
   - **Failing**: `result == FAIL` — always a candidate.
   - **Never-run**: a fixture directory with NO ledger row — highest
     staleness.

2. **Recent changes**: `git diff <base-ref>...HEAD --name-only`, mapped to
   tests via the table below.

## Steps

1. **Discover the universe + ledger state**:
   ```bash
   LEDGER="docs/_generated/integ-last-run.tsv"
   now=$(date -u +%s)
   # Union-merge can leave duplicate rows — LAST row per test wins. The
   # header is MULTIPLE `#` lines; skip them all (a single NR==1 guard let
   # later header lines through as phantom stale rows).
   DEDUPED="$(mktemp)"
   awk -F'\t' '/^#/{next} {last[$1]=$0} END{for (t in last) print last[t]}' "$LEDGER" > "$DEDUPED"
   # never-run: fixtures with no ledger row
   comm -23 \
     <(ls -d tests/integration/*/ | sed 's#tests/integration/##;s#/##' | sort) \
     <(awk -F'\t' '{print $1}' "$DEDUPED" | sort)
   # resolve each row's age ONCE, then slice for the views below.
   AGES="$(mktemp)"
   awk -F'\t' -v now="$now" '{
     cmd="date -u -j -f %Y-%m-%dT%H:%M:%SZ \""$2"\" +%s 2>/dev/null || date -u -d \""$2"\" +%s 2>/dev/null";
     cmd | getline t; close(cmd);
     printf "%s\t%d\t%s\t%s\n",$1,int((now-t)/86400),$3,$6
   }' "$DEDUPED" > "$AGES"

   # age histogram — makes a clustered cohort visible even when NOTHING is >14d
   awk -F'\t' '{print $2}' "$AGES" | sort -n | uniq -c |
     awk '{printf "%6d tests at age %sd%s\n",$1,$2,($2>14?"   <-- STALE":($2>=12?"   <-- crosses the TTL in "(15-$2)"d":""))}'

   # stale (>14d) or failing:
   awk -F'\t' '$3=="FAIL" || $2>14 {printf "%s\tage=%sd\tresult=%s\t%s\n",$1,$2,$3,$4}' "$AGES"

   # expiring soon (12-14d, not already failing) — the cliff cohort:
   awk -F'\t' '$2>=12 && $2<=14 && $3!="FAIL" {printf "%s\tage=%sd\texpires in %dd\n",$1,$2,15-$2}' "$AGES"

   # one-line cliff summary for the step 4 header:
   awk -F'\t' '$2>=12 && $2<=14 {n[15-$2]++} END{for (d in n) printf "%d\t%d tests expire in %dd\n",d,n[d],d}' "$AGES" |
     sort -n | cut -f2-
   ```
   (The `date` line handles both BSD/macOS `-j -f` and GNU `-d`.)

2. **Map recent changes to tests** (a changed path pulls in the listed tests;
   when in doubt, include the broad set):

   | Changed path | Integ tests to run |
   |---|---|
   | `src/deployment/deploy-engine.ts`, `src/deployment/intrinsic-function-resolver.ts`, `src/deployment/retry.ts`, `src/deployment/retryable-errors.ts`, `src/deployment/rollback-executor.ts`, `src/analyzer/dag-builder.ts`, `src/analyzer/template-parser.ts`, `src/cli/commands/{deploy,destroy,destroy-runner}.ts`, `src/provisioning/register-providers.ts` | **BROAD set** (`bench-cdk-sample`, `lambda`, `microservices`, `multi-resource`, `multi-stack-deps`, `drift-revert`, `drift-revert-vpc`, `remove-protection`, `export`) — cross-cutting deploy/destroy. Also `cross-stack-references` for any cross-stack/exports change. |
   | `src/state/**`, `src/state/export-index-store.ts` | `schema-v<N>-to-v<N+1>-migration` (latest), `cross-stack-references`, `import-value-strong-ref` |
   | `src/provisioning/providers/<Svc>*` | the matching service integ (`iam-managed-policy`, `dynamodb-*`, `s3-*`, `rds-*`, `kms-encryption`, `stepfunctions`, `eventbridge`, `sns-sqs-event`, `cognito`, `wafv2`, `route53`, …). Custom Resource changes → `custom-resource-provider`. |
   | `src/provisioning/cloud-control-provider.ts` | `cc-api-fallback`, `cc-api-fallback-transitions`, `recreate-via-cc-api` |
   | `src/local/**`, `src/cli/commands/local-*.ts` | the matching `local-*` test; a cross-cutting `src/local/` change → at least `local-invoke` + `local-start-api`. |
   | `src/cli/commands/{export,import,migrate,retire-cfn-stack}*` | `export`, `export-nested-stack`, `migrate-from-cfn`, `import-nested-stack`, `import-value-strong-ref` |
   | `src/synthesis/macro-*` | `macro-expansion` |
   | `package.json` (cdk-local bump) | `local-*` cluster (the bump's blast radius) |

3. **Rank** the union of {changed-area} ∪ {failing} ∪ {stale >14d} ∪
   {expiring soon} ∪ {never-run}:
   - **P0**: changed-area AND (stale OR failing OR never-run).
   - **P1**: changed-area but recently-green — verify no regression.
   - **P2**: not changed-area but stale / failing / never-run / expiring soon
     — coverage hygiene (prefer the BROAD set + a spread of providers; ORDER
     them, do not cap them — a long tail is handed forward, and whatever is
     not run is named in the wrap-up). An expiring-soon test ranks below an
     already-stale one, above a recently-green one; within a tier, oldest
     first. A large cohort is drained a few days early, across sessions.
   Bias up for AWS-coupled, deletion-sensitive, multi-resource paths; pure
   docs/test/skill changes often need NO integ.

4. **Render the plan**:
   ```
   Recommendation: run N integ tests (P0: ..., P1: ..., P2: ...)
   Base: <base-ref> (<changed-file-count> files changed)
   Ledger: <count> stale (>14d), <count> failing, <count> never-run,
           <count> expiring soon (12-14d) — <N> tests expire in <M>d
   Age histogram:
     <the uniq -c output from step 1, cliff rows annotated>

   P0 (changed + stale/failing/never-run):
     /run-integ <name>    # <why: which changed path + age/result>
   P1 (changed, recently green):
     /run-integ <name>    # verify no regression in <area>
   P2 (coverage hygiene):
     /run-integ <name>    # stale <age>d / expires in <M>d / never-run

   Not scheduled this pass (recently green + untouched): <count> tests — list a few.
   (A count, not a cap: these are DEPRIORITIZED, not excluded.)
   ```
   **Never render "zero stale" on its own** — if a cohort sits at 12–14d, the
   headline is the cliff (`"0 stale, but 105 tests expire in 1d"`).

## Running a large plan across sessions

A big plan will NOT finish in one session (~15–20 deploy/destroy cycles per
session before context degrades; the tell is garbled tool calls — pushing
past drops orphans). Treat a large sweep as a **multi-session relay**:

- Batches of ~4–5 tests. After EACH batch: (a) verify the account is
  orphan-clean (`aws s3 ls s3://<bucket>/cdkd/ --recursive | grep state.json`
  returns 0; no live NAT / RDS / OpenSearch / Redshift / ElastiCache / EC2),
  (b) commit the ledger.
- A backgrounded batch loop can have a test's subshell die between deploy and
  destroy, leaving a full orphan (incl. a NAT GW) — the post-batch state scan
  is what catches it; the orphan's stack NAME often differs from the fixture
  dir name (read it from the deploy log / synth).
- When context gets heavy: **STOP cleanly.** Commit the ledger, tell the user
  "ran N more (list), account clean, ~M remain — new session, 'continue the
  sweep'", and leave a project memory with the remaining list + findings.
- The sweep is DONE only when `/pick-integ` shows no stale tests left; the
  committed ledger is the source of truth.
- A `FAIL` that is fixture staleness (AWS retired an engine/instance tier the
  fixture hardcodes) is NOT a cdkd bug — record it as such and queue a
  fixture version-bump follow-up.

## Important

- This skill never runs `/run-integ` itself. Tests run serially — one AWS
  account; mind VPC/EIP/NAT limits.
- The ledger is only as good as its discipline; treat an absent or
  impossibly-old row as stale.
- "Recently green + untouched" tests are scheduled LAST, not dropped —
  surface the count either way.
- Pure docs / `.claude/skills` / test-only diffs usually need NO integ — say
  so rather than padding the list.
