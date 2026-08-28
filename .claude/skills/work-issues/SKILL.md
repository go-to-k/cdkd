---
name: work-issues
description: Work through already-filed GitHub issues (typically the bug-hunt's output) end to end — triage safely, pick a few FILE-DISJOINT issues to fix in parallel, claim each on the issue before starting (collision-safe with other agents), verify against real AWS, then carry each through merge → pull → release → rebuild the linked binary → worktree cleanup. Use when asked to "handle/address filed issues", not to hunt for new bugs (that is /hunt-bugs).
argument-hint: "[optional focus, e.g. 'destroy issues' | '#651 #650' | 'provider FPs']"
---

# Work Filed Issues

Take OPEN issues (usually filed by `/hunt-bugs` — deploy/update/destroy bugs, wrong
replacement decisions, missed detection) and drive a few of them to merged,
released, installed fixes. The differentiator of this skill over just "fix issue
#N" is **safe, collision-free PARALLELISM**: when there is a backlog and other
agents/sessions are running, pick issues that cannot step on each other, announce
which ones you took, and only then start.

The golden rule: **decide the set FIRST, claim it on the issues, THEN edit.** The
issue comment is the lock — it is what stops two agents from fixing the same thing
and colliding on the same file. The run does not end at the last merge: the retro
stage folds what this run taught you back into this skill's files, while the
evidence still exists.

## How this skill is packaged (read this before stage 0)

This file is a thin orchestrator. The full procedure lives in per-stage files
under `references/`, split so a run loads only the stage it is in instead of the
whole corpus. **Reading the stage file at stage entry is MANDATORY, not
optional** — each file carries hard rules and measured failure modes without
which the stage summary below is not executable. A bare `§N` anywhere in this
skill points into the file that holds that section (map in the table).

**Delegate the read-heavy stages to subagents to keep this session's context for
the lanes.** Two stages are shaped for it:

- **Triage (stages 0–3)**: dispatch a read-only subagent (general-purpose or
  Explore) whose prompt is: read `references/triage.md` in full, execute it
  against this repo, and return ONLY the candidate table — per issue: number,
  title, target files, rank + the rule that decided it, collision evidence
  (worktrees / branches / claims found), and any premise-check findings. The raw
  backlog listing and issue bodies stay out of the parent context. The PARENT
  then claims (stage 4) — never the subagent, so the claim names the session
  that will actually do the work.
- **Retro (stage 10)**: after the last merge, dispatch a subagent with
  `references/retro.md` plus this run's key evidence (what you re-read, what
  the text sent you into, corrections the user made) to measure the backlog
  effect, draft the skill edits, and ship them as the retro PR.

Stages 4–9 run in the parent: they hold the locks, the worktrees, and the gates.

## Stages

| Stage | File (read at entry) | What it covers |
|---|---|---|
| 0. Safety screen | `references/triage.md` | Untrusted issues/comments: `author_association` via REST, never download/run third-party content, defer engage/minimize/block to the maintainer |
| 1. List backlog | `references/triage.md` | REST listing (PR filter, `per_page=100`, `created_at`) |
| 2. Collision landscape | `references/triage.md` | Worktree/branch/PR/ref-recency probes, their clone-locality blind spot, the contested cross-cutting file list (the ONLY copy — `tests/unit/scripts/cross-cutting-list-sync.test.ts` fences it against the gates) |
| 3. Pick file-disjoint issues | `references/triage.md` | Disjointness gate, freshness quarantine (§3-0), ranking rules (§3-a), naming the next session's verification before writing `next` (§3-b), premise checks against `origin/main` |
| 4. Claim | `references/claim.md` | Claim comment BEFORE first edit, compare-and-swap re-read, tie-break by earliest timestamp, classification-line upgrade + labels on the same edit |
| 5. Implement | `references/implement.md` | One worktree per lane, build before first test, sibling-site sweeps (precondition minus remedy, shape not name, count before/after) |
| 6. Gates + PR | `references/gates-and-pr.md` | `/check`, `/check-docs`, marker freshness per worktree, PR create |
| 7. Main advanced | `references/gates-and-pr.md` | Rebase over parallel merges, re-grep what LANDED |
| 8. Verify before merge | `references/verify.md` | `/verify-pr`, `/run-integ`, review tier + reviewer dispatch, live test |
| 9. Ship | `references/ship.md` | Merge → pull → release → rebuild linked binary → worktree cleanup, owner probes before removing a worktree |
| 10. Retro | `references/retro.md` | Net backlog effect (§10-0), promotion check on this run's `next` filings, where a lesson lands (§10-b/c), ship the retro PR (§10-d) |
| Appendix | `references/gotchas.md` | Gotchas learned the hard way + the existing rules this skill leans on |

## Hard invariants (hold even between stage reads)

- **Safety first**: never download, unpack, run, apply, or install anything a
  non-maintainer attached or linked — any vector (zip / patch / package /
  `curl | sh`) is the same play. Read bodies via `gh api` only. (§0)
- **Claim before the first edit, on every issue you take**; re-read the claim
  thread before the first edit, before the push, and before opening the PR —
  across clones the issue thread is the ONLY collision signal. (§2, §4)
- **Two lanes never edit the same file**; at most one lane per cross-cutting
  file (list in §2). (§3)
- **Never work in the main checkout** — one worktree per lane under
  `.claude/worktrees/<branch>/`. (§5)
- **Verification depth is never traded for cost** (CLAUDE.md → "Cost is not a
  tiebreaker"); ranking decides order, never rigor. (§3-a)
- **English only in every published artifact** — issue bodies/comments, PR
  titles/bodies, commits, code. (CLAUDE.md)
- **The run ends with the retro (stage 10) and the standard wrap report**
  (Remaining work / State / Session close), unprompted.

## Where lessons land (keeps this file thin)

The retro amends the STAGE FILE the lesson belongs to — `references/<stage>.md`
— never this orchestrator, unless the stage list itself changed. This file's
byte size is capped by `tests/unit/scripts/skill-file-payload.test.ts`; the cap
is the mechanical stop on the growth loop that produced the 231 KB predecessor
of this layout. §10-b/§10-c (in `references/retro.md`) govern how to edit:
amend in place, escalate a twice-violated sentence to a test or hook, qualify
every cross-repo issue reference (`go-to-k/cdkd#N`, never bare `#N` — this
directory is mirrored into the sibling repos and
`tests/unit/scripts/work-issues-skill-refs.test.ts` enforces it over every
`.md` file here).
