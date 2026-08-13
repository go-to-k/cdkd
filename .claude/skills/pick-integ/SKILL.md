---
name: pick-integ
description: Recommend which integration tests to run, based on the integ ledger (staleness / last result) plus the code areas touched by recent commits. Outputs a prioritized list of `/run-integ <name>` commands. Use before a release, after a batch of merges, or when unsure what integ coverage a change needs.
argument-hint: "[base-ref] (default: origin/main)"
---

# Integ Test Picker

Decide which integration tests to run right now. Running all ~95 back-to-back takes hours, so this
skill ORDERS them: it ranks by two signals — **how stale the last run is** (from the committed
ledger) and **whether recent code changes touch the area a test exercises** — and prints a
prioritized, copy-pasteable `/run-integ` plan. It RECOMMENDS only; the orchestrator runs the chosen
tests via `/run-integ` (which records each run back into the ledger).

**The ranking is a running ORDER, not a budget.** Per the "Cost is not a tiebreaker for
verification depth" rule in [CLAUDE.md](../../../CLAUDE.md) → Workflow Rules, real-AWS time and
spend are not grounds for dropping a candidate: when several tests plausibly cover the code a
change touched, run all of them rather than the cheapest or the top-ranked one, and prefer a
broad-set fixture over a narrow one whenever the change is cross-cutting. Use the priorities to
decide what runs FIRST (so a partial session still covers the riskiest ground), not what gets
skipped. If a plan is genuinely too long for one session, hand the remainder forward per "Running a
large plan across sessions" below — do not silently truncate it, and say in the wrap-up exactly
which tests were not run.

## Inputs

- Optional positional `base-ref` (default `origin/main`): the diff base for "what changed recently".
  Use the last release tag / commit when picking post-merge; use `origin/main` when picking for a branch.

## Data sources

1. **Ledger** `docs/_generated/integ-last-run.tsv` (committed, update-type, one row per test):
   columns `test  last_run_iso  result  duration_s  flow  note`. Written by `/run-integ` on every run.
   - **Stale**: `last_run_iso` older than the integ-gate TTL window (**14 days** — past that, the gate
     markers themselves expire, so a clean result no longer proves today's AWS behavior). Bias the
     threshold down (treat as stale sooner) for AWS-coupled paths.
   - **Expiring soon**: age **12-14d** — not stale yet, but inside the cliff window. The ledger
     accumulates in sweep-shaped cohorts (one sweep stamps 100+ rows with a single timestamp), so ages
     cluster into spikes rather than spreading out. A strict `>14d` boolean over a clustered
     distribution answers either "nothing" or "everything" and cannot express the genuinely actionable
     state — a large cohort about to expire *simultaneously*. Always report this tier: "zero stale" is
     technically true and practically misleading when 105 tests cross the TTL tomorrow (issue #1508).
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
   # authoritative (deduped below before any staleness math). The header is
   # MULTIPLE `#` comment lines — skip them all (a single NR==1 guard used to
   # let later header lines through as phantom stale rows); DEDUPED holds
   # data rows only.
   DEDUPED="$(mktemp)"
   awk -F'\t' '/^#/{next} {last[$1]=$0} END{for (t in last) print last[t]}' "$LEDGER" > "$DEDUPED"
   # never-run: fixtures with no ledger row
   comm -23 \
     <(ls -d tests/integration/*/ | sed 's#tests/integration/##;s#/##' | sort) \
     <(awk -F'\t' '{print $1}' "$DEDUPED" | sort)
   # resolve each row's age ONCE (the date subprocess is the expensive part), then
   # slice that table for the histogram / stale / expiring-soon views below.
   AGES="$(mktemp)"
   awk -F'\t' -v now="$now" '{
     cmd="date -u -j -f %Y-%m-%dT%H:%M:%SZ \""$2"\" +%s 2>/dev/null || date -u -d \""$2"\" +%s 2>/dev/null";
     cmd | getline t; close(cmd);
     printf "%s\t%d\t%s\t%s\n",$1,int((now-t)/86400),$3,$6
   }' "$DEDUPED" > "$AGES"

   # age histogram — makes a clustered cohort visible even when NOTHING is >14d
   awk -F'\t' '{print $2}' "$AGES" | sort -n | uniq -c |
     awk '{printf "%6d tests at age %sd%s\n",$1,$2,($2>14?"   <-- STALE":($2>=12?"   <-- crosses the TTL in "(15-$2)"d":""))}'

   # stale (>14d) or failing, from the ledger:
   awk -F'\t' '$3=="FAIL" || $2>14 {printf "%s\tage=%sd\tresult=%s\t%s\n",$1,$2,$3,$4}' "$AGES"

   # expiring soon (12-14d, not already failing) — the cliff cohort:
   awk -F'\t' '$2>=12 && $2<=14 && $3!="FAIL" {printf "%s\tage=%sd\texpires in %dd\n",$1,$2,15-$2}' "$AGES"

   # one-line cliff summary for the step 4 header:
   awk -F'\t' '$2>=12 && $2<=14 {n[15-$2]++} END{for (d in n) printf "%d\t%d tests expire in %dd\n",d,n[d],d}' "$AGES" |
     sort -n | cut -f2-
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

3. **Rank** the union of {changed-area tests} ∪ {failing tests} ∪ {stale >14d} ∪ {expiring soon 12-14d} ∪ {never-run}:
   - **P0**: changed-area AND (stale OR failing OR never-run) — the change touches code whose proof is also old/broken.
   - **P1**: changed-area but recently-green — verify the change didn't regress it.
   - **P2**: not changed-area but stale >14d / failing / never-run / **expiring soon** — coverage hygiene
     (cap to a sensible number; prefer the BROAD set + a spread of providers, and `log()` what you dropped).
     Rank an expiring-soon test BELOW an already-stale one but ABOVE a recently-green one; within the
     tier, oldest first. When a single cohort is large, say so — draining 105 tests the day they expire
     is not feasible, so start the drain a few days early and spread it across sessions (see the relay
     section below).
   Bias up for the AWS-coupled, deletion-sensitive, multi-resource paths; bias down for pure docs/test/skill changes (often need NO integ).

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
   (A count, not a cap: these are DEPRIORITIZED, not excluded. Say plainly that
   they were not run, so the omission is visible rather than implied.)
   ```
   **Never render "zero stale" on its own.** If nothing is >14d but a cohort sits at 12-14d, the
   headline is the cliff (`"0 stale, but 105 tests expire in 1d"`), not the clean stale count — the
   whole point of the tier is that the boolean threshold hides the cohort until the morning it is
   already too late to drain.

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
- "Recently green + untouched" tests are the ones to schedule LAST, not the ones to drop: a test whose
  area the diff did not touch is genuinely lower-risk, but "lower-risk" orders the list rather than
  truncating it. Surface the count either way so the omission is visible.
- Pure docs / `.claude/skills` / test-only diffs usually need NO integ — say so rather than padding the list.
