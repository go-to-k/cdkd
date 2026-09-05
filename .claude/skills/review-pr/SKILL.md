---
name: review-pr
description: Recommend the right reviewer count for a PR based on size + bias factors. Outputs a concrete plan (inline spot-check / 1 reviewer / 3-axis parallel) plus ready-to-paste Agent dispatch prompts when reviewers are warranted.
argument-hint: "<PR-number>"
---

# PR Review Recommendation

Decide how much review rigor a PR warrants and surface the dispatch prompts.
The tiers say what a PR needs AT MINIMUM.

**The recommended tier is a FLOOR, not a cap, and wall-clock / token cost is
never a reason to come in under it or to stop at it** (CLAUDE.md → "Cost is
not a tiebreaker"): when unsure which tier applies, take the higher one.
Reviewers are read-only agents that run in parallel.

The skill itself never spawns reviewers — it reads PR stats, applies the
heuristic, and prints a recommendation; the **main session orchestrator**
issues the `Agent` calls.

## Steps

1. **Fetch PR stats**:

   ```bash
   gh pr view <N> --json additions,deletions,changedFiles,title,headRefName,files \
     -q '{a: .additions, d: .deletions, fc: .changedFiles, title: .title, branch: .headRefName, paths: [.files[].path]}'
   ```

   `loc = a + d`, **minus auto-generated LOC** — `docs/_generated/**` and
   lockfiles inflate LOC without reviewer surface (reviewers audit the SCRIPT
   that produced them):

   ```bash
   excluded=$(gh pr view <N> --json files \
     -q '[.files[] | select(.path | test("^docs/_generated/|(^|/)pnpm-lock\\.yaml$|(^|/)package-lock\\.json$|(^|/)yarn\\.lock$")) | .additions + .deletions] | add // 0')
   loc=$(( a + d - excluded ))
   ```

   (PR #404: 4286 raw LOC → ~1100 substantive after exclusion. `fc` is NOT
   adjusted — a 12-file diff is still cross-cutting when 2 files are
   generated. The lockfile patterns are `(^|/)`-anchored because the lockfile
   lives at repo ROOT — a bare `/pnpm-lock\.yaml$` never matched it, PR #1082.
   The same exclusion lives in `.claude/hooks/pr-review-gate.sh`; keep the two
   regexes in sync.)

   **Then gather each touched `src/` file's recent HISTORY in the same pass**
   — the recent-defect up-bias in step 3 is the one trigger that cannot be read off
   `paths`, so a step that does not fetch it leaves the trigger to be
   remembered rather than evaluated. Measured on go-to-k/cdkd#2612: the loop
   below scores its two `src/` files 2 and 3, and the tier was still raised
   from standing memory rather than from a query.

   ```bash
   BASE=$(gh pr view <N> --json baseRefOid -q .baseRefOid)   # NOT plain HEAD --
   # run on the PR branch, an unanchored log counts the PR's OWN fix-back
   # commits and a 2-fix-back PR self-trips the bias.
   git fetch -q origin
   # The `if` is the point, not the `echo`. baseRefOid can be missing locally
   # (shallow clone; a base that exists only on the remote), and then `git log`
   # dies, `|| true` swallows it, and every file prints 0 -- a VOID probe whose
   # output is character-identical to a clean one. Warning BESIDE the loop does
   # not fix that; the loop must not run at all.
   if git rev-parse --verify -q "$BASE^{commit}" >/dev/null; then
     for f in $(gh pr view <N> --json files -q '.files[].path' | grep -E '^src/'); do
       # `|| true` because `grep -c` exits 1 when the count is zero.
       n=$(git log --oneline -3 "$BASE" -- "$f" | grep -cE '^[a-f0-9]+ fix(\(|:)' || true)
       printf '%s\t%s\n' "$f" "$n"
     done   # n >= 2 of the last 3 on a file = evaluate the step-3 bias
   else
     echo "base $BASE is not local -- history probe VOID, not zero"
   fi
   ```

   **That loop is `^src/`-filtered, and for `.claude/**` no prefix count works
   at all — which is where the stakes are highest.** `commit-prefix-scope-gate`
   refuses a `feat:` / `fix:` commit that stages no `src/**` file, so an
   agent-instruction change lands as `chore:` (or `docs:` / `test:`) and scores
   zero however many times the file has been corrected: measured on this file,
   whose last five commits carry no `fix:` while the go-to-k/cdkd#2595 run's
   retro was correcting a gap in text go-to-k/cdkd#2596 had added to it one run
   earlier. A nonzero is no better, because a commit staging `src/**` AND a
   `.claude/**` file may carry `fix:` and score the instruction file for a
   defect that was never in it (`git log --oneline -5 origin/main --
   .claude/rules/testing.md` returns go-to-k/cdkd#2450, a `fix(state):`).

   So for a `.claude/**` path, read the SUBJECTS rather than a count
   (`git log --oneline -5 "$BASE" -- "$f"`) and treat consecutive retro /
   correction commits on the same file as the recency signal.

2. **Base tier** from `(loc, fc)`:

   | Condition | Base tier |
   |-----------|-----------|
   | `loc < 300` OR `fc < 5` | **inline** (spot-check by the orchestrator) |
   | `300 <= loc < 1000` AND `5 <= fc < 10` | **1-reviewer** (single code-quality pass) |
   | `loc >= 1000` OR `fc >= 10` | **3-axis** (spec + code + test in parallel) |

   The boundary overlap is intentional: a 200-LOC / 12-file PR is 3-axis via
   file count (cross-cutting risk regardless of LOC).

3. **Bias factors** from the `paths` list:

   **Up-bias triggers** (tier UP one step, clamped at 3-axis):

   - Any path matches **security / process-launch surface**:
     - `src/utils/role-arn.ts`
     - `src/utils/docker-cmd.ts`
     - `src/local/cognito-jwt.ts`
     - `src/local/authorizer-resolver.ts`
     - `src/local/authorizer-cache.ts`
     - `src/local/sigv4-verify.ts`
     - `src/local/agentcore-sigv4-sign.ts`
     - `src/local/docker-runner.ts`
     - `src/local/docker-image-builder.ts`
     - `src/local/ecr-puller.ts`
     - `src/local/ecs-secrets-resolver.ts`
     - `src/local/ecs-task-runner.ts`

     **What belongs here**: a file is listed when it (a) verifies or mints
     authn material or loads credentials, (b) resolves secret material, or
     (c) launches a process or derives the executable path one is launched
     from. Consumers of those primitives are NOT listed. Several entries are
     thin re-export shims over cdk-local — they stay listed on purpose: a
     shim edit changes WHICH implementation cdkd consumes. The list rots two
     silent ways (an entry stops existing; a live surface never gets added —
     both seen in issue #1972);
     `tests/unit/scripts/security-surface-list-sync.test.ts` fences the first
     and the four-copy sync, the second needs the (a)/(b)/(c) test re-applied
     when this area changes.

   - Any path under `src/provisioning/providers/**` (deletion-sensitive —
     `integ-destroy` scope; real-AWS regressions cost cleanup time)
   - **> 1 fix-back ROUND on the PR** ("multiple sub-agents wrote the diff").
     Count DISTINCT `fix:` SUBJECTS across the PR's commits AND every commit
     its timeline recorded as a former HEAD. `git log main..<branch>` alone is
     what a FLATTEN erases, so that spelling killed the trigger on exactly the
     PRs rewritten most — and this repo flattens by policy
     (`flatten-before-rebase-gate.sh`). go-to-k/cdkd#2638. Subjects rather than
     shas because an amend re-shas one round. Replaying both hooks over the 60
     most recently merged PRs, the resolved TIER differs on 4; exactly one of
     those, go-to-k/cdkd#2557, needs the timeline, and a merged PR's branch is
     deleted, which flatters the other three.

     `pr-review-gate.sh` takes the MAX of this and the branch's own `fix:`
     commit count, so it can resolve HIGHER than the number below; and it skips
     the query entirely once the tier can no longer change, so it can also
     report 0 where this prints more. Read this as the tier-relevant floor, not
     as the hook's internal count:

     ```bash
     gh api graphql -F owner=go-to-k -F repo=cdkd -F number=<N> -f query='
     query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){
       pullRequest(number:$number){
         commits(first:100){nodes{commit{messageHeadline}}}
         timelineItems(first:100,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT]){nodes{
           ... on HeadRefForcePushedEvent{beforeCommit{messageHeadline} afterCommit{messageHeadline}}}}}}}' \
       | jq '[(.data.repository.pullRequest.commits.nodes[]?.commit.messageHeadline),
              (.data.repository.pullRequest.timelineItems.nodes[]?
                 | .beforeCommit.messageHeadline, .afterCommit.messageHeadline)]
             | map(select(. != null and test("^fix(\\(|:)"))) | unique | length'
     ```

     Exact paths, not `.. | .messageHeadline?`. GraphQL returns `data` and
     `errors` together with HTTP 200, and a recursive-descent read harvests
     every `messageHeadline` in the document — including blocks this query did
     not ask for — which up-biases a PR with one round. Fenced by the
     `graphql-malformed` case in `.claude/hooks/pr-review-gate.test.sh`.
   - **The code this PR edits shipped a defect in a RECENT PR.** A judgement
     trigger, not a path list: `pr-review-gate.sh` reads the diff's stats and
     paths plus the BRANCH's own commit subjects, and has no view of the
     edited file's HISTORY — so it cannot see this and may not require the
     marker. Raise the tier anyway and say why. Read the tell off the history
     step 1 gathered — 2 or more `fix:` commits among a touched file's last 3
     — rather than from what you remember about the area. Measured on
     go-to-k/cdkd#2593: the heuristic said `inline`,
     while that log on `src/deployment/recreate-targets.ts` showed the two
     preceding merges were both data-loss-guard fixes and the nearer one
     (go-to-k/cdkd#2565) had fixed a fail-open reading in the very function
     this PR edits again. Code + security ran, and both converged on the same
     two untested response shapes. Recency is evidence about the code, the
     same way a security path is.

   **Security add-on reviewer (additive — NOT part of the tier ladder).**
   Whenever ANY security / process-launch path matches (surface list +
   `src/provisioning/providers/**`), OR the PR is a **security fix** (secrets
   / credentials, redaction / masking / escaping, sensitive-value
   persistence, GHSA-tied) — ALSO dispatch **`pr-security-reviewer`**, in
   addition to the size tier. The size tier decides BREADTH; a security
   defect is a DEPTH concern a tiny PR can carry — the GHSA-p5qg-v9gv-hc7w
   rollback blocker was surfaced by the generic reviewer only on a second,
   prompted round; a standing security lens catches that class in round one.

   **Down-bias triggers** (tier DOWN one step, clamped at inline) — only when
   ALL paths fall in the listed buckets:

   - **Pure INERT docs**: every path matches `.gitignore`, `README.md`,
     `docs/**`, `package.json` (top-level dep bumps only), `tests/**/*.md`.
     **Agent-instruction files are deliberately NOT here** — `CLAUDE.md`,
     `.claude/rules/**`, `.claude/skills/**`, `.claude/agents/**`,
     `.claude/hooks/**`, `.claude/settings*.json`, `.markgate.yml` change how
     every future session behaves; a defect there has a wider blast radius
     than most code. (`tests/**/*.md` catches integ READMEs; it is
     deliberately NOT a blanket `**/*.md`, which re-admitted every excluded
     agent-instruction file. The hook's `DOWN_DOCS_REGEX` carries the same
     list minus `tests/**/*.md` — it reaches that shape through its
     tests-only bucket; keep the two in sync.)
   - **Test-only**: every path matches `tests/**`

   Both fire → up wins (security wins).

   **Down-bias is a statement about RISK, never about budget.** If a
   "docs-only" diff changes a rule the agent will follow, or a "test-only"
   diff changes what a checker ACCEPTS, the low-risk premise is false — do
   not down-bias, and say why.

4. **Apply the bias**: inline+up→1-reviewer; 1-reviewer+up→3-axis; 3-axis+up
   →3-axis (clamp); 3-axis+down→1-reviewer; 1-reviewer+down→inline;
   inline+down→inline (clamp).

5. **Render the recommendation** (format below).

6. **Dispatch reviewers + set the marker** (only for `1-reviewer` / `3-axis`):
   the orchestrator dispatches the recommended reviewers via the Agent tool,
   waits for all, and synthesizes:

   - Any **blocker** → the marker is NOT set; address the blockers and
     re-run `/review-pr <N>` **from step 1**, on the PR's CURRENT stats. A
     fix round adds LOC and files AND a `fix:` commit, so the tier is not
     fixed for the life of a PR and neither is whether `pr-review-gate.sh`
     requires the marker at all: go-to-k/cdkd#2593 opened at 306 LOC / 4
     files (`inline`, no marker required) and its review-fix commit took it
     to 406 LOC / 6 files — `1-reviewer` by size, and `3-axis` once the
     hook's second-`fix:`-commit up-bias fires on the same push. Caught only
     by recomputing before the merge; re-read the stats after every fix
     round, in both directions.
   - Every finding minor / nit / clean → set the marker bound to the PR's
     current HEAD sha:

     ```bash
     # The pr-review gate's scope is the sentinel file at repo root, so
     # writing the PR HEAD sha into it before `markgate set` binds the marker
     # to that sha — a later push invalidates it. Sentinel + markgate state
     # land in the CURRENT worktree; set markers from the worktree you intend
     # to merge from.
     gh pr view <N> --json headRefOid -q .headRefOid > .markgate-pr-review-sha
     mise exec -- markgate set pr-review
     ```

   For `inline`, the marker is NOT set — the gate's heuristic also outputs
   `inline`, so no enforcement fires.

   **Security add-on dispatch**: when the trigger fired, dispatch
   `pr-security-reviewer` in the same parallel batch and fold its findings in
   — a security blocker blocks the marker like any other. This applies at
   EVERY tier, `inline` included (a skill-level requirement, not yet a hard
   gate).

   **NEVER set the marker without dispatching the reviewers first** — the
   gate exists so an un-reviewed large PR cannot reach main
   (`pr-review-gate.sh` blocks `gh pr merge` until the marker is fresh AND
   the recorded sha matches HEAD).

## Output template

```
Recommendation: <inline | 1-reviewer | 3-axis>

PR #<N>: <title>
Stats: +<additions> / -<deletions> = <loc> LOC, <fc> files
Branch: <branch>

Base tier (from stats): <base>
Bias factors:
  - <factor 1, or "none">
Applied bias: <up / down / none>
Final tier: <final>

Rationale: <one line>
```

Then, **if final tier is `1-reviewer`**, emit:

```
Dispatch this single reviewer (run via Agent tool in the main session):

  Agent {
    subagent_type: "general-purpose",
    description: "PR <N> code review",
    prompt: |
      Read your role definition at `.claude/agents/pr-code-reviewer.md` (relative to the repo root) and follow it.
      Inputs:
      - PR number: <N>
      - Branch: <branch>
  }
```

**If final tier is `3-axis`**, emit the same block three times in ONE
parallel message, for `.claude/agents/pr-spec-reviewer.md` (add
`- Design doc: <path>` — ask the user; spec review is meaningless without
one, and if none exists, downgrade to 1-reviewer instead),
`.claude/agents/pr-code-reviewer.md`, and
`.claude/agents/pr-test-reviewer.md`.

**If final tier is `inline`**, emit:

```
No reviewer dispatch — orchestrator should spot-check inline:

  - `gh pr diff <N>` — read the full diff in one pass
  - For each changed file, ask: is it correct, complete, necessary?

If the inline read surfaces a non-obvious bug class (cross-cutting state
machine, race, security-sensitive logic), STOP and dispatch a code reviewer.
```

**ADDITIONALLY, if the security add-on trigger fired**, append (at ANY tier,
same parallel batch):

```
  Agent {
    subagent_type: "general-purpose",
    description: "PR <N> security review",
    prompt: |
      Read your role definition at `.claude/agents/pr-security-reviewer.md` (relative to the repo root) and follow it.
      Inputs:
      - PR number: <N>
      - Branch: <branch>
      - Security concern to focus on: <name the sensitive value(s) / surface this PR touches — e.g. "the redacted secret expression persisted to state + journal; trace every reader". With no named value, the reviewer defaults to enumerating all sensitive values in the diff.>
  }
```

## Important

- **Never auto-dispatch** from inside this skill — it recommends, the
  orchestrator acts. Extend reviewer prompts with PR-specific context; the
  blocks are starting templates.
- Thresholds are heuristics. When in doubt, go UP — the question is "would I
  be comfortable being wrong about this reaching main?".

## Dry-run reference (sanity check)

Calibration set — the skill run against these should produce:

| PR | Stats | Base tier | Bias | Final |
|----|-------|-----------|------|-------|
| #240 | 390 LOC, 4 files (`.claude/hooks/*`, `CLAUDE.md`, `.claude/settings.json`) | inline (fc < 5) | none (agent-instruction files are NOT in the docs bucket) | **inline** |
| #237 | 4515 LOC, 24 files (incl. `src/local/cognito-jwt.ts`) | 3-axis | up (security surface) → clamps | **3-axis** |
| #236 | 269 LOC, 9 files (incl. `src/local/docker-image-builder.ts`, `ecr-puller.ts`) | inline (loc < 300) | up (process-launch surface) | **1-reviewer** |
| #344 | 1488 LOC, 13 files (all `.md`, incl. `CLAUDE.md`) | 3-axis | none — `CLAUDE.md` fails the inert-docs premise | **3-axis** |
| #404 | 4286 raw → ~1100 LOC after auto-gen exclusion, 19 files | 3-axis (`fc >= 10`, file count not adjusted) | none (mixed paths) | **3-axis** |

Divergence from these rows means the heuristic or trigger lists drifted —
re-read this file before trusting the recommendation. **The rows are
RECALCULATED expectations, not history** (#240 / #344 were originally decided
under a wider docs bucket); do not "restore" the old bucket to make a row
match.
