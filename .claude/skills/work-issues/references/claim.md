<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 4. CLAIM the chosen issues BEFORE editing

When lanes run as SUBAGENTS (the orchestrator's default for stages 5-8), the
PARENT posts every claim in this section — the claim is the lock and must name
the session accountable for the lane — and the claim's `<ref>` names the branch
/ worktree the dispatched lane agent will create, not a branch the parent
holds. Everything else in this section is unchanged.

For EACH issue you will start:

```bash
gh issue comment <n> --body "Working on this in PR/branch <ref> — touching <files>. \
Claiming to avoid collision with parallel agents."
```

(English only — committed/public artifacts are English.) This is mandatory and
comes BEFORE the first edit. It is the issue-level twin of the worktree
DISJOINT-FILE rule (see the "Claim a filed issue before working it" rule in
`CLAUDE.md`).

**Correct the classification lines in the same turn as the claim.** Claiming is
the first moment this run holds evidence about the issue, so it is where the
four lines get written or fixed: a legacy body carrying the old packed line is
rewritten to the four-line shape (§3), a missing `Severity` is filled in from
what you just read, and a value this run's evidence contradicts is corrected
with the correction named in the claim comment. Doing it here rather than at
merge time is the same argument the deferral rule makes — the evidence is in
hand now and gone later. `Notes` never goes into an issue body.

**Carry `--add-label` on that same `gh issue edit`.** Writing a `Severity:` /
`Effort:` value into a body whose labels do not carry it is what
`.claude/hooks/issue-classification-label-gate.sh` refuses, so the edit that
upgrades a legacy body sets the labels in the same command
(`--add-label severity:<v> --add-label effort:<v>`). This is also the moment the
existing backlog gets labelled at all: it happens on touch, by the lane already
holding the evidence, rather than by the bulk sweep §3 forbids. Doing it BEFORE
the lane's PR exists is what makes the PR inherit the labels — the workflow
reads them when the PR is opened.

**Claim at SHORTLIST time, not after the analysis.** Claim the moment an issue
enters your candidate set — before the deep read of its body, before mapping
which files it lands in. Retracting a claim you then decided against costs one
comment; a collision costs a whole lane. The window this closes is the one that
actually bites: two sessions can each spend minutes triaging in total mutual
invisibility, because neither has posted anything yet.

**Then VERIFY the claim stuck (compare-and-swap).** Posting is not winning —
another session may have posted seconds earlier. Immediately re-read the issue
and check for a competing claim:

```bash
gh issue view <n> --json comments \
  --jq '.comments[] | select(.body | test("Working on this")) | "\(.createdAt)\t\(.body[0:80])"'
```

**Tie-break: the EARLIEST `createdAt` wins.** If someone else's claim predates
yours, you are the loser of the race — post a short stand-down comment naming
the winning branch, drop the lane, and pick a different issue. Do this without
asking; the whole point is that both sessions independently reach the same
answer from the same timestamps. Escalate to the maintainer only when the
timestamps cannot settle it.

This exists because it has already failed once: two sessions claimed
go-to-k/cdkd#1419 / go-to-k/cdkd#1435 twenty seconds apart (2026-08-09), both
having followed every other rule in this skill, and it took the maintainer
arbitrating to resolve. See go-to-k/cdkd#1446.

**The tie-break only works if the LOSER re-reads. Nothing makes it, so the
window is not seconds — it is the whole lane.** The compare-and-swap above is
written as a one-shot check performed right after posting, which catches only a
rival who posted BEFORE you. A rival who posts LATER never appears in it, and
since neither session re-reads the issue again, both run to completion. On
2026-08-25 go-to-k/cdkd#2200 was claimed at 14:34:26Z and again at 15:00:22Z --
26 minutes apart, so the first claim was plainly visible to the second session,
which had the losing timestamp and worked it anyway. Both lanes built the same
fix. The merged one (go-to-k/cdkd#2206) turned out to be a strict superset, so
nothing was lost but the duplicated hours; that is luck, not the rule working.

Two cheap habits close it, and they are cheap precisely because a claim comment
is one API call:

- **Re-read the claims before you PUSH, not only after you post.** By then your
  lane has a branch name to offer and a rival has had its whole triage window to
  appear. If a later claim exists and yours is earlier, say so on the issue
  rather than assuming they saw it; if yours is later, stand down even though
  you have already written code -- discarding a branch is cheaper than two
  reviews and two merges of the same change.
- **When you find yourself the loser, record the timestamps in the stand-down
  comment.** The rule is unenforced by construction (nothing can block another
  session's `gh issue comment`), so the only thing keeping it alive is that
  violations stay visible instead of being quietly absorbed.

**Claim what you FILE, too — filing is not claiming.** An issue this run files as
its own deferral is invisible to every ownership probe: no branch, no PR, no comment,
and only §3-0's hour covers it. So when the issue is one THIS run means to pick up
itself (`Session-fit: now` in its body), post the claim comment in the same turn you
file it. Name the LANE and the issue it defers from, not just your current branch:
§9 merges with `--delete-branch`, so a claim naming the branch you are on now reads
stale at exactly the moment you come back for the issue — re-post the claim with the
real branch when you open that lane. An issue you are handing off (`Session-fit:
next`) gets NO claim at filing time — that would park a released issue under a
session that has decided not to do it — but this says nothing about a LATER run that
takes it: that run claims it normally, per the mandatory rule above.

**Do not trust a handoff table — verify it live.** A "these issues are taken"
note you were handed is a snapshot of the moment it was written; PRs merge and
worktrees disappear. Re-derive occupancy from `gh pr list --state open`,
`git worktree list`, and the issues' own comments before believing any of it.

