<!-- Part of the /work-issues skill. Stage files: triage.md (§0–§3), claim.md (§4), implement.md (§5), filing.md (§5-f), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL when your run enters this stage. -->

## 4. CLAIM the chosen issues BEFORE editing

When lanes run as SUBAGENTS (the default for stages 5-8), the PARENT posts every
claim — the lock names the session accountable — and its `<ref>` names the branch
or worktree the lane agent will create.

**IN-PLACE runs name the tree they are STANDING IN**
(`references/launch-mode.md`): the `<ref>` is the branch §5 will create plus the
`LANE_TREE` the probe recorded — taken from the opening report, not from
`git rev-parse --show-toplevel`, whose answer follows a cwd that may have reset
to the main checkout.

**Do NOT claim `LAUNCH_BRANCH` — the branch checked out right now is the OUTER
TOOL's, not this run's** (a branch to PUT BACK, never to commit to). Compose the
name here; §5 creates it after this stage. Write "the branch §5 will create in
`<LANE_TREE>`" and post on time — a claim delayed until the branch exists is one
posted after the first edit. Such lanes are SERIAL (§3): claim the top candidate
or the whole set, but mark every lane after the first QUEUED, so a reader tells a
RUNNING lane from one spoken for.

```bash
gh issue comment <n> --body "QUEUED behind #<the lane running first> in \
<LANE_TREE> — this session will start it only after that lane merges. Not \
started: no branch exists yet and no file is held. If you want this issue, take \
it and say so here; I will stand down."
```

When the run ends before reaching one — or a lane never becomes RUNNABLE because
another SESSION's open PR holds its file — **stand it down rather than leave the
claim standing**: say it is unclaimed, carry the four classification fields, and
**when the blocker is EXTERNAL name the query that clears it**, passing it **via
`--body-file`** (that query is BACKTICKED; `--body "..."` would execute it).

```bash
cat > "$SCRATCH/standdown-<n>.md" <<'EOF'
Standing this down UNCLAIMED — <the session that queued it ended first | open
PR #N holds <file>>. <Resume query, when the blocker is external.>
Session-fit: next (not this session) — <reason>.
Severity: <v> — <what stays broken>.
Effort: <v> — <cycle>.
Estimate: <t> — <what eats it>.
EOF
gh issue comment <n> --body-file "$SCRATCH/standdown-<n>.md"
```

For EACH issue you start:

```bash
gh issue comment <n> --body "Working on this in PR/branch <ref> — touching <files>. \
Claiming to avoid collision with parallel agents."
```

Mandatory, BEFORE the first edit (the issue-level DISJOINT-FILE rule).

**Correct the classification lines in the same turn as the claim**, the first
moment the run holds evidence: rewrite a legacy packed body to the four-line
shape (§3), fill a missing `Severity`, fix what the evidence contradicts (`Notes`
never enters a body).

**Carry `--add-label` on that same `gh issue edit`** (`severity:<v>`,
`effort:<v>`, plus `--remove-label` for the one a correction supersedes — adding
without removing leaves TWO, which §3's query picks between arbitrarily). Label
BEFORE the lane's PR exists, which is what makes it inherit them.

**Claim at SHORTLIST time, not after the analysis** — retracting costs one
comment, a collision costs a lane.

**Then VERIFY the claim stuck** — posting is not winning:

```bash
gh issue view <n> --json comments \
  --jq '.comments[] | select(.body | test("Working on this")) | "\(.createdAt)\t\(.body[0:80])"'
```

**Tie-break: the EARLIEST `createdAt` wins.** If a rival's claim predates yours,
post a stand-down naming the winning branch and pick a different issue — without
asking. Escalate when timestamps cannot settle it (go-to-k/cdkd#1446).

**A QUEUED comment IS a claim, and its `createdAt` is what the tie-break reads.**
Re-read the thread to the END before publishing a precedence account, and never
infer absence from a missing branch: a signal shows LIFE only (§9), and a claim
has no TTL, so one you believe dead goes to arbitration.

**The tie-break only works if the LOSER re-reads, and nothing makes it** — the
check above catches only a rival who posted BEFORE you. Re-read the claims before
you PUSH; if yours is later, stand down even with code written.

**Claim what you FILE, too — filing is not claiming**, since a self-filed
deferral is invisible to every ownership probe. For one THIS run means to pick up
(`Session-fit: now`), claim it in the turn you file it, naming the LANE, not your
current branch, which §9 deletes. One handed off (`next`) gets NO claim until a
later run takes it.

**Do not trust a handoff table — verify occupancy live** (`gh pr list`,
`git worktree list`, the issues' comments): each is evidence of LIFE only, and
only a stand-down or a closed issue RELEASES one (§9).
