---
name: review-pr
description: Recommend the right reviewer set for a PR from what it touches. Outputs a concrete plan (1 reviewer by default, plus the security reviewer or all three axes when a trigger fires) with ready-to-paste Agent dispatch prompts.
argument-hint: "<PR-number>"
---

# PR Review Recommendation

Decide how much review rigor a PR warrants and surface the dispatch prompts. The
recommendation says what a PR needs AT MINIMUM.

**The recommended set is a FLOOR, not a cap, and wall-clock / token cost is never
a reason to come in under it or to stop at it** (AGENTS.md, "Cost is not a
tiebreaker"): when unsure, add the axis. Reviewers are read-only agents that run
in parallel.

This skill never spawns reviewers — it reads PR stats, applies the heuristic, and
prints a recommendation. The **main session orchestrator** issues the `Agent`
calls, extending the templates in
[references/output-template.md](references/output-template.md) with PR-specific
context.

The per-stage detail lives under `references/`, and **reading a stage's file at
stage entry is mandatory** — the one-line summaries below are routing, not the
procedure.

## Steps

0. **Is it your turn?** A PUSH is not a round-completion signal — a REPLY is.
   Read [references/round-completion.md](references/round-completion.md) and
   apply it BEFORE opening a round on a head you have not reviewed.

1. **Read the PR** — `paths` above all, plus `loc` / `fc` for context and the
   touched `src/` files' recent history. Commands and their traps:
   [references/pr-stats.md](references/pr-stats.md). The history probe is
   mandatory: it is the one step-3 signal not readable off `paths`.

2. **Default: ONE reviewer** (`pr-code-reviewer`). A docs-only or test-only
   diff is not discounted below it.

3. **Triggers** from the `paths` list and the `src/**` size —
   [references/bias-factors.md](references/bias-factors.md), read at this step
   and AUTHORITATIVE for every list below.

   - **Size**: the `src/**` diff exceeds 400 lines OR 8 files → add
     `pr-spec-reviewer` + `pr-test-reviewer` (all three axes).
   - **Security add-on** (`pr-security-reviewer`, additive to whatever else
     runs): a secret / credential / redaction / masking / sensitive-value
     persistence / process-launch surface, `src/provisioning/providers/**`, or a
     PR that IS a security fix. A security blocker stops the merge like any
     other.
   - **All three axes plus security**: a state-schema bump, or a security fix.

4. **Resolve the set**: default one reviewer, plus the size axes when the size
   trigger fired, plus `pr-security-reviewer` when its trigger fired (a 3-axis
   security fix dispatches four reviewers, not three). Reviewers run ONCE, on
   the FINAL sha: a fix round is re-checked by messaging the SAME reviewer with
   the delta (`SendMessage`), never by a fresh dispatch.

5. **Render the recommendation** —
   [references/output-template.md](references/output-template.md).

6. **Dispatch reviewers and synthesize** —
   [references/dispatch-and-marker.md](references/dispatch-and-marker.md). NEVER
   report a round closed without dispatching the reviewers first.
