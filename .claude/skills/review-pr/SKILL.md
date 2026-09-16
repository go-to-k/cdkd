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
issues the `Agent` calls, extending the dispatch templates in
[references/output-template.md](references/output-template.md) with PR-specific
context.

## How this skill is packaged

This file is a thin orchestrator. The per-stage detail lives under
`references/`, and **reading a stage's file at stage entry is MANDATORY, not
optional** — the one-line summaries below are routing, not the procedure. Each
file carries the trigger lists, the shell, and the measured incidents behind
them, and a step executed from the summary alone will get the tier wrong.

Splitting it was forced rather than stylistic: at 22,994 B this file sat 6 bytes
under its cap, and go-to-k/cdkd#3169 measured the cost — six drafts of one
needed clause were all refused, and two of the squeezes that did land damaged a
sentence (one dropped a word, one left a selector vacuously true). A file that
can only accept edits which shrink it accumulates more of those.

## Steps

0. **Is it your turn?** A PUSH is not a round-completion signal — a REPLY is.
   Read [references/round-completion.md](references/round-completion.md) and
   apply it BEFORE opening a round on a head you have not reviewed. Skip the
   wait only on the conditions it names.

1. **Fetch PR stats** — `loc`, `fc`, `paths`, minus auto-generated LOC, plus the
   touched `src/` files' recent history. Commands and their traps:
   [references/pr-stats.md](references/pr-stats.md). The history probe is
   mandatory: it is the one step-3 trigger not readable off `paths`.

2. **Base tier** from `(loc, fc)`:

   | Condition | Base tier |
   |-----------|-----------|
   | `loc < 300` OR `fc < 5` | **inline** (spot-check by the orchestrator) |
   | `300 <= loc < 1000` AND `5 <= fc < 10` | **1-reviewer** (single code-quality pass) |
   | `loc >= 1000` OR `fc >= 10` | **3-axis** (spec + code + test in parallel) |

   The boundary overlap is intentional: a 200-LOC / 12-file PR is 3-axis via
   file count (cross-cutting risk regardless of LOC).

3. **Bias factors** from the `paths` list —
   [references/bias-factors.md](references/bias-factors.md), read at this step.
   Up-bias (security / process-launch surface, `src/provisioning/providers/**`,
   more than one fix-back round, a recent defect in the code being edited),
   down-bias (pure inert docs, test-only) — only when ALL paths fall in those
   buckets, and **agent-instruction files are NOT docs**, which is the arm a
   `.claude/**`-only diff gets wrong. Both fire → up wins.

   The **security reviewer is ADDITIVE, not a rung on the size ladder**:
   dispatch it at ANY tier, `inline` included, whenever a security /
   process-launch surface is touched or the PR is a security fix.

4. **Apply the bias**: inline+up→1-reviewer; 1-reviewer+up→3-axis; 3-axis+up
   →3-axis (clamp); 3-axis+down→1-reviewer; 1-reviewer+down→inline;
   inline+down→inline (clamp).

5. **Render the recommendation** — format in
   [references/output-template.md](references/output-template.md).

6. **Dispatch reviewers + set the marker** (only for `1-reviewer` / `3-axis`) —
   [references/dispatch-and-marker.md](references/dispatch-and-marker.md).
   NEVER set the marker without dispatching the reviewers first.

## Output template

The recommendation format, the per-tier dispatch prompts, and the dry-run
calibration set are in
[references/output-template.md](references/output-template.md).
