---
name: review-pr
description: Recommend the right reviewer count for a PR based on size + bias factors. Outputs a concrete plan (inline spot-check / 1 reviewer / 3-axis parallel) plus ready-to-paste Agent dispatch prompts when reviewers are warranted.
argument-hint: "<PR-number>"
---

# PR Review Recommendation

Decide how much review rigor a PR warrants — and surface the dispatch prompts for the orchestrator to copy-paste. Running none on a large security-sensitive PR misses bugs; the tiers below say what a PR needs AT MINIMUM.

**The recommended tier is a FLOOR, not a cap, and wall-clock / token cost is never a reason to come in under it or to stop at it.** See the "Cost is not a tiebreaker" rule in [CLAUDE.md](../../../CLAUDE.md) → Workflow Rules: when two options differ in how thoroughly they verify, take the more thorough one; when you are unsure which tier applies, take the higher one. The tiers exist to stop a PR being UNDER-reviewed, not to ration review. Reviewers are read-only agents that run in parallel, so the only thing a larger tier costs is time the maintainer has already said to spend.

The skill itself never spawns reviewers. It reads PR stats, applies the heuristic, and prints a recommendation. The **main session orchestrator** (the parent reading this skill's output) is responsible for actually issuing the `Agent` tool calls when the recommendation says to.

## Inputs

- **Required**: PR number (positional). Example: `/review-pr 237`.

## Steps

1. **Fetch PR stats** via `gh`:

   ```bash
   gh pr view <N> --json additions,deletions,changedFiles,title,headRefName,files \
     -q '{a: .additions, d: .deletions, fc: .changedFiles, title: .title, branch: .headRefName, paths: [.files[].path]}'
   ```

   Record: `additions` (`a`), `deletions` (`d`), `changedFiles` (`fc`), `title`, `branch`, list of file `paths`.

   Compute `loc = a + d`.

   **Subtract auto-generated LOC** before computing the tier — generated artifacts under `docs/_generated/**` (provider-coverage matrices, integ-coverage matrices, snapshot fixtures, etc.) and lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`) inflate LOC without adding reviewer surface. Reviewers do not (and cannot meaningfully) audit these files line-by-line; they only verify the SCRIPT that produced them. Compute `loc` from the diff with these paths excluded:

   ```bash
   excluded=$(gh pr view <N> --json files \
     -q '[.files[] | select(.path | test("^docs/_generated/|(^|/)pnpm-lock\\.yaml$|(^|/)package-lock\\.json$|(^|/)yarn\\.lock$")) | .additions + .deletions] | add // 0')
   loc=$(( a + d - excluded ))
   ```

   Caught in PR #404 (issue #392): 4286 raw LOC → 3-axis tier, but ~2900 LOC was auto-generated `docs/_generated/integ-coverage.json` + `docs/integ-coverage.md`. Substantive surface was ~1100 LOC, which is squarely 1-reviewer tier. Auto-gen exclusion produces the right answer without sacrificing rigor on the substantive code. Note: `fc` is NOT adjusted — a 12-file diff is still cross-cutting even when 2 of the files are generated. The lockfile patterns are `(^|/)`-anchored because cdkd's `pnpm-lock.yaml` lives at the repo ROOT — a bare `/pnpm-lock\.yaml$` pattern silently never matched it (caught on PR #1082, whose 2747-LOC lockfile churn pushed a 37-LOC toolchain PR into 3-axis). The same exclusion now also lives in `.claude/hooks/pr-review-gate.sh` (it previously computed raw LOC, disagreeing with this skill) — keep the two regexes in sync when editing.

2. **Determine the base tier** from `(loc, fc)` per the heuristic:

   | Condition | Base tier |
   |-----------|-----------|
   | `loc < 300` OR `fc < 5` | **inline** (inline spot-check by the orchestrator) |
   | `300 <= loc < 1000` AND `5 <= fc < 10` | **1-reviewer** (single code-quality pass) |
   | `loc >= 1000` OR `fc >= 10` | **3-axis** (spec + code + test in parallel) |

   The two boundary conditions overlap intentionally — a 200-LOC / 12-file PR triggers 3-axis via the file count even though LOC is small (a 12-file diff has cross-cutting risk regardless of LOC), and a 5000-LOC / 3-file PR triggers 3-axis via LOC (rare in practice but covered).

3. **Compute bias factors** by scanning the `paths` list:

   **Up-bias triggers** (move tier UP by one step, never above 3-axis):

   - Any path matches **security / process-launch surface**:
     - `src/utils/role-arn.ts`
     - `src/local/cognito-jwt.ts`
     - `src/local/lambda-authorizer.ts`
     - `src/local/docker-runner.ts`
     - `src/local-invoke/docker-runner.ts`
     - `src/local/docker-image-builder.ts`
     - `src/local/ecr-puller.ts`
   - Any path under `src/provisioning/providers/**` (deletion-sensitive — within the `integ-destroy` markgate scope; real-AWS regressions cost cleanup time)
   - Branch has > 1 fix-back commit (heuristic for "multiple sub-agents wrote the diff" — count commits whose message starts with `fix:` / `fix(` via `git log main..<branch> --oneline | grep -cE '^[a-f0-9]+ fix(\(|:)'`)

   **Down-bias triggers** (move tier DOWN by one step, never below inline) — only fires when ALL paths fall in the listed buckets:

   - **Pure INERT docs**: every path matches one of `.gitignore`, `README.md`, `docs/**`, `package.json`, `tests/**/*.md`. **Agent-instruction files are deliberately NOT here** — `CLAUDE.md`, `.claude/rules/**`, `.claude/skills/**`, `.claude/agents/**`, `.claude/hooks/**`, `.claude/settings*.json` and `.markgate.yml` change how every future session behaves, so a defect in one has a wider blast radius than most code. (`package.json` counts here only for top-level dep bumps.) `pr-review-gate.sh`'s `DOWN_DOCS_REGEX` carries the same list MINUS `tests/**/*.md` (the hook reaches that shape through its separate tests-only bucket instead), so a diff of exactly `README.md` + a `tests/**/README.md` down-biases here and not there; keep the two in sync and re-check that delta when editing either. The `tests/**/*.md` entry catches integ-test READMEs (`tests/integration/*/README.md`), written for human readers but living under `tests/**`. It is deliberately NOT a blanket `**/*.md`: that form re-admitted `CLAUDE.md`, `.claude/rules/**`, `.claude/skills/**/SKILL.md` and `.claude/agents/*.md` — every file the sentence above excludes — so the exclusion was inert on the skill side while the hook enforced it, which is the drift this list exists to prevent. Added after PR #344 surfaced a 13-file markdown-only cleanup that the strict path-bucket rule mis-categorized as mixed-bucket and forced into 3-axis review.
   - **Test-only**: every path matches `tests/**`

   If both up- and down-bias triggers fire (e.g. a tests-only diff that touches a security-sensitive provider's test file), prefer up-bias — security wins.

   **Down-bias is a statement about RISK, never about budget.** It fires only when every path is genuinely in a low-risk bucket. If a "docs-only" diff changes a rule the agent will follow (`.claude/rules/**`, `CLAUDE.md`), or a "test-only" diff changes what a checker ACCEPTS rather than what it asserts, the low-risk premise is false — do not down-bias, and say why in the recommendation. A tier that was talked down for any reason other than measured low risk is the failure this rule exists to prevent.

4. **Apply the bias** to compute the final tier:

   - `inline` + up → `1-reviewer`
   - `1-reviewer` + up → `3-axis`
   - `3-axis` + up → `3-axis` (clamp)
   - `3-axis` + down → `1-reviewer`
   - `1-reviewer` + down → `inline`
   - `inline` + down → `inline` (clamp)

5. **Render the recommendation** in the format below.

6. **Dispatch reviewers + set the marker** (only when `final_tier` is `1-reviewer` or `3-axis`):

   The recommendation tells the orchestrator what to do. The orchestrator
   then dispatches the recommended reviewers (1 or 3) via the Agent tool,
   waits for all of them to complete, and synthesizes the findings:

   - If **any blocker** surfaces (correctness bugs, security issues,
     test gaps that justify rejecting the PR), the marker is NOT set
     — the orchestrator addresses the blockers (or asks the
     implementing agent to fix them) and re-runs `/review-pr <N>`.
   - If every finding is **minor / nit / clean**, the orchestrator
     sets the marker bound to the PR's current HEAD sha:

     ```bash
     # The pr-review markgate gate's scope is the sentinel file at
     # repo root, so writing the PR HEAD sha into it before `markgate
     # set` implicitly binds the marker to that sha. A subsequent push
     # to the PR will invalidate the marker (the next /review-pr run
     # rewrites the sentinel and markgate's digest reports stale).
     #
     # Post-#559 (cwd-aware gate hooks): the sentinel + markgate
     # state both land in the CURRENT worktree — the same one where
     # `gh pr merge <N>` will later run. The gate hook resolves the
     # target worktree from the PreToolUse payload's `cwd` field +
     # `cd <path>` / `gh -C <path>` in the command, so concurrent
     # agents in different worktrees no longer collide on a shared
     # main-tree marker store. Convention: set markers from the
     # worktree you intend to merge from.
     gh pr view <N> --json headRefOid -q .headRefOid > .markgate-pr-review-sha
     mise exec -- markgate set pr-review
     ```

   For the `inline` tier, the marker is NOT set — the gate's heuristic
   also outputs `inline` for the same PR, so no enforcement fires and
   the merge proceeds without a marker.

   **NEVER set the marker without dispatching the reviewers first.**
   The whole point of the gate is that an un-reviewed large PR cannot
   reach main; bypassing dispatch defeats it. The gate's hook
   (`.claude/hooks/pr-review-gate.sh`) blocks `gh pr merge` until the
   marker is fresh AND the recorded sha matches the PR's current HEAD.

## Output template

```
Recommendation: <inline | 1-reviewer | 3-axis>

PR #<N>: <title>
Stats: +<additions> / -<deletions> = <loc> LOC, <fc> files
Branch: <branch>

Base tier (from stats): <base>
Bias factors:
  - <factor 1, or "none">
  - <factor 2>
Applied bias: <up / down / none>
Final tier: <final>

Rationale: <one line — e.g. "Small infra-only diff; orchestrator can spot-check in 5 min." / "Touches src/local/cognito-jwt.ts (credential surface), bumps base tier up.">
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

**If final tier is `3-axis`**, emit:

```
Dispatch these three reviewers IN PARALLEL (single message, three Agent tool calls):

  Agent {
    subagent_type: "general-purpose",
    description: "PR <N> spec compliance review",
    prompt: |
      Read your role definition at `.claude/agents/pr-spec-reviewer.md` (relative to the repo root) and follow it.
      Inputs:
      - PR number: <N>
      - Branch: <branch>
      - Design doc: <ASK THE USER — the orchestrator should fill this in before dispatching; spec review is meaningless without a design doc to compare against. If no design doc exists for this PR, downgrade to 1-reviewer instead.>
  }

  Agent {
    subagent_type: "general-purpose",
    description: "PR <N> code review",
    prompt: |
      Read your role definition at `.claude/agents/pr-code-reviewer.md` (relative to the repo root) and follow it.
      Inputs:
      - PR number: <N>
      - Branch: <branch>
  }

  Agent {
    subagent_type: "general-purpose",
    description: "PR <N> test adequacy review",
    prompt: |
      Read your role definition at `.claude/agents/pr-test-reviewer.md` (relative to the repo root) and follow it.
      Inputs:
      - PR number: <N>
      - Branch: <branch>
  }
```

**If final tier is `inline`**, emit:

```
No reviewer dispatch — orchestrator should spot-check inline:

  - `gh pr diff <N>` — read the full diff in one pass
  - For each changed file, ask: is it correct, complete, necessary?
  - Estimated time: 5 min

If during the inline read you discover a non-obvious bug class (cross-cutting state machine, race, security-sensitive logic), STOP and re-run /review-pr <N> after manually adding the file path to the up-bias trigger list locally, or just dispatch a code reviewer by hand.
```

## Important

- **Never auto-dispatch** the Agent tool from inside this skill. Skills run in the main conversation; this skill's job is to *recommend*, the orchestrator's job is to *act*.
- The orchestrator can extend each reviewer prompt with PR-specific context (concerns to deep-dive, design doc path for spec-reviewer, files to focus on). Treat the dispatch blocks as starting templates, not final prompts.
- For 3-axis dispatches: the spec reviewer needs a design doc path. If no design doc exists for the PR (small features, bug fixes, refactors), downgrade to 1-reviewer rather than dispatching spec-reviewer with no inputs.
- Thresholds are heuristics, not laws. When in doubt, go UP — the question is not "could I spot-check this in 5 minutes?" but "would I be comfortable being wrong about this reaching main?"; if no, dispatch.
- For an honest reading of the trade-off, see `~/.claude/projects/-Users-goto-pc-github-cdkd/memory/feedback_pr_review_scale_rule.md`.

## Dry-run reference (sanity check)

These three PRs are the calibration set. Running this skill against them should produce:

| PR | Stats | Base tier | Bias | Final |
|----|-------|-----------|------|-------|
| #240 | 390 LOC, 4 files (`.claude/hooks/*`, `CLAUDE.md`, `.claude/settings.json`) | inline (fc < 5) | none (agent-instruction files are NOT in the docs bucket) | **inline** (base tier alone) |
| #237 | 4515 LOC, 24 files (incl. `src/local/cognito-jwt.ts`, `lambda-authorizer.ts`) | 3-axis (loc >= 1000 AND fc >= 10) | up (security surface) → clamps at 3-axis | **3-axis** |
| #236 | 269 LOC, 9 files (incl. `src/local/docker-image-builder.ts`, `ecr-puller.ts`) | inline (loc < 300) | up (process-launch surface) → 1-reviewer | **1-reviewer** |
| #344 | 1488 LOC, 13 files (all `.md` — `docs/plans/*.md` deletes + `CLAUDE.md` / `docs/*.md` / `tests/integration/*/README.md` link-fix) | 3-axis (loc >= 1000 AND fc >= 10) | none — `CLAUDE.md` is an agent-instruction file, so the "every path is inert docs" premise fails | **3-axis** |
| #404 | 4286 raw LOC → ~1100 after subtracting `docs/_generated/integ-coverage.json` (2724 LOC) + `docs/integ-coverage.md` (~170 LOC) auto-gen, 19 files (scripts/, hooks, fixtures, sidecar JSON) | 3-axis (`fc >= 10` still triggers — file count not adjusted for auto-gen) | none (mixed paths exclude pure docs/infra + tests-only bias) | **3-axis** (file count alone, even after LOC adjustment) — but if PR had been split per memory `feedback_split_tooling_from_backfill.md` (tool vs backfill), each half would be 1-reviewer |

If the skill output diverges from these, the heuristic or the trigger lists have drifted — re-read this file and the linked memory entry before trusting the recommendation. **These rows are RECALCULATED expectations, not history**: #240 and #344 were originally decided under a docs bucket that included `CLAUDE.md` / `.claude/**`, and both now answer differently because that bucket was narrowed to inert documentation. Do not "restore" the old bucket to make a row match.
