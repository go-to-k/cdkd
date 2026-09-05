<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), filing.md (§5-f), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 4. CLAIM the chosen issues BEFORE editing

When lanes run as SUBAGENTS (the orchestrator's default for stages 5-8), the
PARENT posts every claim in this section — the claim is the lock and must name
the session accountable for the lane — and the claim's `<ref>` names the branch
/ worktree the dispatched lane agent will create, not a branch the parent
holds. Everything else in this section is unchanged.

**IN-PLACE runs name the tree they are STANDING IN**
(`references/launch-mode.md`): the `<ref>` is the branch §5 will create plus the
`LANE_TREE` the probe recorded. Take the TREE from the opening report rather than
re-deriving it with `git rev-parse --show-toplevel`, whose answer follows a cwd
that may have silently reset to the main checkout. No WORKTREE will be created,
and a claim pointing at a worktree that never appears is exactly what §9's owner
probes misread.

**Do NOT claim `LAUNCH_BRANCH` — the branch checked out here right now is the
OUTER TOOL's, not this run's** (`references/launch-mode.md`: "a branch to PUT
BACK, never one to commit to"). So the name is COMPOSED here rather than read out
of git with `git branch --show-current`, and it does not exist yet: §5 creates it,
after this stage. Write "the branch §5 will create in `<LANE_TREE>`" and post the
claim on time. A claim delayed until the branch exists is a claim posted after the
first edit, which is the one thing this stage forbids. Such a run's lanes are
SERIAL (§3): claiming only the top candidate is fine, and so is claiming a whole
set — but a claimed set must mark every lane after the first `QUEUED`, because a
reader has to tell a lane that is RUNNING from one that is merely spoken for.

```bash
# The QUEUED form, posted up front with the rest of the set.
gh issue comment <n> --body "QUEUED behind #<the lane running first> in \
<LANE_TREE> — this session will start it only after that lane merges. Not \
started: no branch exists yet and no file is held. If you want this issue, take \
it and say so here; I will stand down."
```

And when the run ends before reaching one, **stand it down rather than leaving
the claim standing** — a QUEUED claim that outlives its session is the stale
lock §9 makes a mechanical step of releasing. Say it is unclaimed, and carry the
four classification fields so the next session inherits the triage instead of
redoing it:

```bash
gh issue comment <n> --body "Standing this down UNCLAIMED — the session that \
queued it ended first. Session-fit: next (not this session) — <reason>. \
Severity: <v> — <what stays broken>. Effort: <v> — <cycle>. Estimate: <t> — \
<what eats it>."
```

For EACH issue you will start:

```bash
gh issue comment <n> --body "Working on this in PR/branch <ref> — touching <files>. \
Claiming to avoid collision with parallel agents."
```

(English only — committed/public artifacts are English.) Mandatory, BEFORE the
first edit — the issue-level twin of the worktree DISJOINT-FILE rule (see
"Claim a filed issue before working it" in `CLAUDE.md`).

**Correct the classification lines in the same turn as the claim.** Claiming is
the first moment this run holds evidence about the issue: rewrite a legacy
packed body to the four-line shape (§3), fill a missing `Severity`, correct a
value the evidence contradicts (naming the correction in the claim comment).
The evidence is in hand now and gone later. `Notes` never goes into an issue
body.

**Carry `--add-label` on that same `gh issue edit`**
(`--add-label severity:<v> --add-label effort:<v>`, and `--remove-label` the
one a correction supersedes — every open issue carries one since the sweep, and
adding without removing leaves TWO, which §3's query picks between arbitrarily)
— a body stating a `Severity:` / `Effort:` value the labels do not carry is
refused by
`.claude/hooks/issue-classification-label-gate.sh`. A lane labels on touch,
holding the evidence, and never sweeps the backlog — a BULK sweep is the
maintainer's call. Label BEFORE the lane's PR exists: that is what makes the
PR inherit them (the workflow reads them at PR open).

**Claim at SHORTLIST time, not after the analysis** — the moment an issue
enters your candidate set, before the deep read. Retracting costs one comment;
a collision costs a whole lane, and the window this closes is the one that
bites: two sessions can each triage for minutes in mutual invisibility because
neither has posted yet.

**Then VERIFY the claim stuck (compare-and-swap).** Posting is not winning —
another session may have posted seconds earlier. Immediately re-read the issue:

```bash
gh issue view <n> --json comments \
  --jq '.comments[] | select(.body | test("Working on this")) | "\(.createdAt)\t\(.body[0:80])"'
```

**Tie-break: the EARLIEST `createdAt` wins.** If a rival's claim predates
yours, post a short stand-down comment naming the winning branch, drop the
lane, and pick a different issue — without asking; both sessions independently
reach the same answer from the same timestamps. Escalate to the maintainer only
when the timestamps cannot settle it (go-to-k/cdkd#1419 / go-to-k/cdkd#1435
were claimed twenty seconds apart and needed arbitration — 2026-08-09,
go-to-k/cdkd#1446).

**The tie-break only works if the LOSER re-reads. Nothing makes it, so the
window is not seconds — it is the whole lane.** The one-shot check above
catches only a rival who posted BEFORE you; a rival who posts LATER never
appears in it, and both lanes run to completion. Measured (2026-08-25):
go-to-k/cdkd#2200 was claimed twice 26 minutes apart, the losing session
worked it anyway, and both built the same fix — the merged go-to-k/cdkd#2206
being a superset was luck. Two cheap habits close it (a claim comment is one
API call):

- **Re-read the claims before you PUSH, not only after you post.** If a later
  claim exists and yours is earlier, say so on the issue; if yours is later,
  stand down even with code written — discarding a branch is cheaper than two
  reviews and two merges of the same change.
- **When you find yourself the loser, record the timestamps in the stand-down
  comment.** The rule is unenforced by construction (nothing can block another
  session's `gh issue comment`); violations staying visible is what keeps it
  alive.

**Claim what you FILE, too — filing is not claiming.** A self-filed deferral is
invisible to every ownership probe (no branch, no PR, no comment; only §3-0's
hour covers it). When the issue is one THIS run means to pick up
(`Session-fit: now` in its body), post the claim in the same turn you file it,
naming the LANE and the issue it defers from — not just your current branch:
§9 merges with `--delete-branch`, so a claim naming the branch you are on now
reads stale exactly when you come back; re-post with the real branch when you
open that lane. An issue you are handing off (`Session-fit: next`) gets NO
claim at filing time — that would park a released issue under a session that
decided not to do it — but a LATER run that takes it claims it normally.

**Do not trust a handoff table — verify it live.** A "these issues are taken"
note is a snapshot of the moment it was written; PRs merge and worktrees
disappear. Re-derive occupancy from `gh pr list --state open`,
`git worktree list`, and the issues' own comments before believing any of it.
