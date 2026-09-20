---
name: work-issues
description: Work through already-filed GitHub issues (typically the bug-hunt's output) end to end — triage safely, pick as many FILE-DISJOINT issues as the run can carry, claim each on the issue before starting (collision-safe with other agents), verify against real AWS, then carry each through merge → pull → rebuild the linked binary → worktree cleanup. Use when asked to "handle/address filed issues", not to hunt for new bugs (that is /hunt-bugs).
argument-hint: "[optional focus, e.g. 'destroy issues' | '#651 #650' | 'provider FPs']"
---

# Work Filed Issues

Drive as many OPEN issues as the run can carry to merged, released, installed
fixes. The differentiator over "fix issue #N" is **safe, collision-free
PARALLELISM**.

The golden rule: **decide the set FIRST, claim it on the issues, THEN edit.**
The issue comment is the lock — it is what stops two agents fixing the same
thing and colliding on the same file.

## Launch mode: main checkout, or already inside a worktree

The flow creates one worktree per lane — right from the MAIN checkout, wrong
when the launch location is ALREADY a linked worktree (an Orca/ADE workspace, a
stray `cd`): `git worktree add` then NESTS one, and deleting the outer workspace
takes the inner directory and its uncommitted work with it.

**The PARENT computes which case applies BEFORE stage 0**: read
`references/launch-mode.md` and run the probe it holds (the ONLY copy).

- Before stage 0, because §2's collision scan consumes the answer: IN-PLACE its
  relative `.claude/worktrees/<w>` paths resolve to nothing and the scan reports
  an empty board, reading as "no competing agents".
- In the PARENT, because stages 0–3 go to a read-only subagent whose return
  payload carries no git state, so an answer computed there never reaches the
  party running `git worktree add`.

State all four printed values — `MODE`, which is `MAIN-CHECKOUT` or
`IN-PLACE`, plus `LANE_TREE`, `MAIN_CHECKOUT` and `LAUNCH_BRANCH` (the branch
§9 puts back; empty if launched detached) — in the opening report, written
after the probe and before any lane starts, and pass them into the triage
dispatch and every lane dispatch. That report is their only recorded copy.

`IN-PLACE` changes the collision scan's paths, the claim, the branch recipe,
the cleanup step, how `main` is reached, and where the retro branch is created;
`references/launch-mode.md` maps each consequence to the stage that fires it.

## How this skill is packaged (read this before stage 0)

This file is a thin orchestrator; the procedure lives in per-stage files under
`references/`. **Reading the stage file at stage entry is MANDATORY** — the
summaries below are not executable on their own. A bare `§N` points into the
file that holds that section.

**Delegate for context; keep the locks and the serialization in the parent.**

- **Triage (stages 0–3): a read-only subagent.** Prompt: read
  `references/triage.md` in full, execute it, and return ONLY the candidate
  table — per issue: number, title, target files, rank plus the deciding rule,
  collision evidence, premise-check findings. Hand it the probe's four values
  (§2's worktree scan needs the absolute main checkout). The backlog listing and
  the issue bodies stay out of the parent context.
- **Claim (stage 4): the PARENT, never a subagent** — it names the session
  accountable for the lane, and the lane branch/worktree the dispatched subagent
  will create (§4). IN-PLACE that branch does not exist yet and is NEVER
  `LAUNCH_BRANCH`.
- **Lanes (stages 5–8): one general-purpose subagent per claimed issue.**
  Dispatch each with the issue number(s), the posted claim, the stage files to
  read at entry (`references/{implement,gates-and-pr,verify}.md`, plus
  `references/filing.md` ONLY when §5's sweep produces a finding the lane will
  not fix itself), and the probe's four values. The lane creates its own
  worktree per §5 — or works in place — implements, runs `/check` and
  `/check-docs` (once, at the final sha), opens the PR, dispatches its reviewers
  (§8-i), addresses findings, drives CI green, then STOPS at merge-ready and
  reports PR number, HEAD sha, review verdicts, integ fixtures still needed and
  anything deferred. It must NOT run a real-AWS integ or merge on its own.
- **Finishing (stage 9): the parent, one lane at a time.** Grant each
  merge-ready lane its turn — resume the lane agent (SendMessage) to run its
  named integ fixtures and merge while it holds the turn, or run `/run-integ`
  and `gh pr merge` yourself FROM THAT LANE'S WORKTREE (the `integ-destroy`
  marker is read from the worktree the command runs from). Post-merge (pull →
  rebuild → worktree cleanup) follows §9.
- **Retro (stage 10): a subagent**, dispatched after the last merge with
  `references/retro.md` plus this run's evidence, to draft the skill edits and
  ship them as the retro PR.

Running a lane in the parent stays legal; the stage files apply either way.

## Stages

| Stage | File (read at entry) |
|---|---|
| Before 0. Launch mode | `references/launch-mode.md` |
| 0. Safety screen — 1. List backlog — 2. Collision landscape — 3. Pick file-disjoint issues | `references/triage.md` |
| 4. Claim | `references/claim.md` |
| 5. Implement | `references/implement.md` |
| 5-f. File findings | `references/filing.md` |
| 6. Checks + PR — 7. Main advanced | `references/gates-and-pr.md` |
| 8. Verify before merge | `references/verify.md` |
| 9. Ship | `references/ship.md` |
| 10. Retro | `references/retro.md` |
| Appendix (gotchas + the rules this skill leans on) | `references/gotchas.md` |

## Hard invariants (hold even between stage reads)

- **Safety first**: read issue bodies via `gh api` only, and never run anything
  a non-maintainer attached or linked. (§0, CLAUDE.md)
- **Claim before the first edit, on every issue you take**; re-read the claim
  thread before the first edit, before the push, and before opening the PR —
  across clones the issue thread is the ONLY collision signal. (§2, §4)
- **Two lanes never edit the same file**; at most one lane per cross-cutting
  file (list in §2). (§3)
- **Never work in the main checkout** — one tree per lane: a new worktree under
  `.claude/worktrees/<branch>/`, or the launch worktree itself IN-PLACE. (§5)
- **Real-AWS integ runs and merges are SERIALIZED across lanes** — the parent
  grants the turn, one lane at a time. Everything else runs concurrently. (§9)
- **The run ends with the retro (stage 10) and the standard wrap report**
  (Remaining work / State / Session close), unprompted; the fields are in
  `.claude/rules/session-report.md`, which never auto-loads.
- **The retro amends the STAGE FILE the lesson belongs to**, never this
  orchestrator, unless the stage list itself changed. (§10-b, §10-c)
