---
name: review-pr
description: Recommend the right reviewer set for a PR from what it touches. Outputs a concrete plan (1 reviewer by default, plus the security reviewer or all three axes when a trigger fires) with ready-to-paste Agent dispatch prompts.
argument-hint: "<PR-number>"
---

# PR Review Recommendation

Decide how much review rigor a PR warrants and surface the dispatch prompts.
The recommendation says what a PR needs AT MINIMUM.

**The recommended set is a FLOOR, not a cap, and wall-clock / token cost is
never a reason to come in under it or to stop at it** (CLAUDE.md → "Cost is
not a tiebreaker"): when unsure, add the axis. Reviewers are read-only agents
that run in parallel.

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
them, and a step executed from the summary alone will get the reviewer set
wrong.

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

1. **Read the PR** — `paths` above all, plus `loc` / `fc` for context and the
   touched `src/` files' recent history. Commands and their traps:
   [references/pr-stats.md](references/pr-stats.md). The history probe is
   mandatory: it is the one step-3 signal not readable off `paths`.

2. **Default: ONE reviewer** (`pr-code-reviewer`, a single code-quality pass).
   **Size selects nothing** — the old LOC / file-count ladder is gone, so a
   4000-LOC PR and a 40-LOC PR both start here, and a docs-only or test-only
   diff is not discounted below it.

3. **Triggers** from the `paths` list —
   [references/bias-factors.md](references/bias-factors.md), read at this step
   and AUTHORITATIVE for every list below; this summary is routing.

   - **Security add-on** (`pr-security-reviewer`, additive to whatever else
     runs): a security / process-launch surface, `src/provisioning/providers/**`,
     or a PR that IS a security fix. **A security blocker stops the merge like
     any other.**
   - **All three axes** (spec + code + test in parallel): a state-schema bump,
     or a security fix. Nothing else reaches 3-axis by rule — but the set is a
     floor, so add an axis whenever the judgement signals in that file fire.

4. **Resolve the set**: default one reviewer → plus `pr-security-reviewer` when
   its trigger fired → all three axes when a schema bump or security fix is in
   play (a 3-axis security fix dispatches four reviewers, not three).

5. **Render the recommendation** — format in
   [references/output-template.md](references/output-template.md).

6. **Dispatch reviewers and synthesize** —
   [references/dispatch-and-marker.md](references/dispatch-and-marker.md).
   NEVER report a round closed without dispatching the reviewers first.

## Output template

The recommendation format and the per-reviewer dispatch prompts are in
[references/output-template.md](references/output-template.md).
