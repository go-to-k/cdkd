---
name: review-pr
description: Recommend the right reviewer count for a PR based on size + bias factors. Outputs a concrete plan (inline spot-check / 1 reviewer / 3-axis parallel) plus ready-to-paste Agent dispatch prompts when reviewers are warranted.
argument-hint: "<PR-number>"
---

# PR Review Recommendation

Decide how much review rigor a PR actually warrants — and surface the dispatch prompts for the orchestrator to copy-paste. Running all 3 reviewer agents on every PR is expensive (~25 min) and drains attention; running none on a large security-sensitive PR misses bugs. This skill applies the heuristic codified in `~/.claude/projects/-Users-goto-pc-github-cdkd/memory/feedback_pr_review_scale_rule.md`.

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
     -q '[.files[] | select(.path | test("^docs/_generated/|/pnpm-lock\\.yaml$|/package-lock\\.json$|/yarn\\.lock$")) | .additions + .deletions] | add // 0')
   loc=$(( a + d - excluded ))
   ```

   Caught in PR #404 (issue #392): 4286 raw LOC → 3-axis tier, but ~2900 LOC was auto-generated `docs/_generated/integ-coverage.json` + `docs/integ-coverage.md`. Substantive surface was ~1100 LOC, which is squarely 1-reviewer tier. Auto-gen exclusion produces the right answer without sacrificing rigor on the substantive code. Note: `fc` is NOT adjusted — a 12-file diff is still cross-cutting even when 2 of the files are generated.

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

   - **Pure docs/infra**: every path matches one of `.gitignore`, `CLAUDE.md`, `README.md`, `**/*.md`, `docs/**`, `.claude/skills/**`, `.claude/agents/**`, `.claude/hooks/**`, `.claude/settings*.json`, `.markgate.yml`, `package.json` (top-level deps only — count as docs-ish for review purposes when the diff is dep bumps). The `**/*.md` entry catches markdown anywhere outside `docs/**` — most commonly integ-test READMEs (`tests/integration/*/README.md`) that are written for human readers but live under `tests/**`. Added after PR #344 surfaced a 13-file markdown-only cleanup that the strict path-bucket rule mis-categorized as mixed-bucket and forced into 3-axis review.
   - **Test-only**: every path matches `tests/**`

   If both up- and down-bias triggers fire (e.g. a tests-only diff that touches a security-sensitive provider's test file), prefer up-bias — security wins.

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
     # `git worktree`-aware: cd into the main working tree first so
     # the sentinel + markgate state land where the gate hook reads
     # them. The hook resolves its scope via
     # `git rev-parse --git-common-dir` (the shared `.git` dir, or
     # the main repo's `.git` from a worktree); markgate's marker
     # store is per-cwd, so running from a worktree would land in a
     # different store than the hook checks. `gh pr merge` itself is
     # working-tree-agnostic — the cwd at merge time may not match
     # the cwd at marker-set time. cd to the shared main tree to
     # avoid the divergence.
     main_tree=$(git rev-parse --path-format=absolute --git-common-dir | xargs dirname)
     gh pr view <N> --json headRefOid -q .headRefOid > "$main_tree/.markgate-pr-review-sha"
     ( cd "$main_tree" && mise exec -- markgate set pr-review )
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
- Thresholds are heuristics, not laws. When in doubt, ask: "would I be comfortable spot-checking this in 5 minutes?" — if yes, inline; if no, dispatch.
- For an honest reading of the trade-off, see `~/.claude/projects/-Users-goto-pc-github-cdkd/memory/feedback_pr_review_scale_rule.md`.

## Dry-run reference (sanity check)

These three PRs are the calibration set. Running this skill against them should produce:

| PR | Stats | Base tier | Bias | Final |
|----|-------|-----------|------|-------|
| #240 | 390 LOC, 4 files (`.claude/hooks/*`, `CLAUDE.md`, `.claude/settings.json`) | inline (fc < 5) | down (pure infra) → clamps at inline | **inline** |
| #237 | 4515 LOC, 24 files (incl. `src/local/cognito-jwt.ts`, `lambda-authorizer.ts`) | 3-axis (loc >= 1000 AND fc >= 10) | up (security surface) → clamps at 3-axis | **3-axis** |
| #236 | 269 LOC, 9 files (incl. `src/local/docker-image-builder.ts`, `ecr-puller.ts`) | inline (loc < 300) | up (process-launch surface) → 1-reviewer | **1-reviewer** |
| #344 | 1488 LOC, 13 files (all `.md` — `docs/plans/*.md` deletes + `CLAUDE.md` / `docs/*.md` / `tests/integration/*/README.md` link-fix) | 3-axis (loc >= 1000 AND fc >= 10) | down (every path is `.md`, matches `**/*.md` in pure-docs bucket) → 1-reviewer | **1-reviewer** |
| #404 | 4286 raw LOC → ~1100 after subtracting `docs/_generated/integ-coverage.json` (2724 LOC) + `docs/integ-coverage.md` (~170 LOC) auto-gen, 19 files (scripts/, hooks, fixtures, sidecar JSON) | 3-axis (`fc >= 10` still triggers — file count not adjusted for auto-gen) | none (mixed paths exclude pure docs/infra + tests-only bias) | **3-axis** (file count alone, even after LOC adjustment) — but if PR had been split per memory `feedback_split_tooling_from_backfill.md` (tool vs backfill), each half would be 1-reviewer |

If the skill output diverges from these, the heuristic or the trigger lists have drifted — re-read this file and the linked memory entry before trusting the recommendation.
