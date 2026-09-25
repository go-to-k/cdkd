<!-- /work-issues stage file; stage map in ../SKILL.md. A bare §N points into the file holding that section. READ IN FULL at stage entry. -->

## 4. CLAIM the chosen issues BEFORE editing

When lanes run as SUBAGENTS (the default for stages 5-8), the PARENT posts every
claim — the lock names the session accountable — and its `<ref>` names the branch
or worktree the lane agent will create.

**IN-PLACE runs name the tree they are STANDING IN**: the `<ref>` is the branch
§5 will create plus the opening report's `LANE_TREE`, never
`git rev-parse --show-toplevel`, whose cwd may have reset to the main checkout.

**Do NOT claim `LAUNCH_BRANCH` — it is the OUTER TOOL's branch**, to PUT BACK.
Write "the branch §5 will create in `<LANE_TREE>`" and post now — a claim that
waits for the branch lands after the first edit. Such lanes are SERIAL (§3):
mark every lane after the first QUEUED, so a reader tells RUNNING from spoken for.

```bash
gh issue comment <n> --body "QUEUED behind #<the lane running first> in \
<LANE_TREE> — this session will start it only after that lane merges. Not \
started: no branch exists yet and no file is held. If you want this issue, take \
it and say so here; I will stand down."
```

When the run ends before reaching one — or a lane never becomes RUNNABLE because
an open PR holds what its fix needs (triage.md §2: a peer's files, a fork's
hunks) — **stand it down rather than leave the claim standing**: say it is
unclaimed, carry the four classification fields, and **when the blocker is
EXTERNAL name the query that clears it**, passing it **via `--body-file`** (that
query is BACKTICKED; `--body "..."` would execute it).

```bash
cat > "$SCRATCH/standdown-<n>.md" <<'EOF'
Standing this down UNCLAIMED — <the session that queued it ended first | open
PR #N holds <file, or the lines of it the fix needs>>. <Resume query, when the
blocker is external.>
Session-fit: next (not this session) — <reason>.
Severity: <v> — <what stays broken>.
Effort: <v> — <cycle>.
Estimate: <t> — <what eats it>.
EOF
gh issue comment <n> --body-file "$SCRATCH/standdown-<n>.md"
```

For EACH issue you start — PROMOTING a QUEUED one included — first re-check
`gh issue view <n> --json state` and re-run §3's premise check on CURRENT
`origin/main`: triage's findings date from TRIAGE time, and a peer can fix and
close a queued issue before its turn (#3700/#3704/#3627: claimed after closing,
one lane spent). Then:

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
`effort:<v>`, plus `--remove-label` for the one superseded — else §3's query
picks between TWO), BEFORE the lane's PR exists, so the PR inherits them.

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

**Verify occupancy live, never from a handoff table** (`gh pr list`, `git
worktree list`, the comments): LIFE only; a stand-down or a close RELEASES (§9).
