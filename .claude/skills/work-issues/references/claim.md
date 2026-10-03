<!-- /work-issues stage file; stage map in ../SKILL.md. A bare §N points into the file holding that section. READ IN FULL at stage entry. -->

## 4. CLAIM the chosen issues BEFORE editing

With SUBAGENT lanes (stages 5-8's default) the PARENT posts every claim;
its `<ref>` names the branch or worktree the lane agent will create.

**IN-PLACE runs name the tree they are STANDING IN**: the `<ref>` is the branch
§5 will create plus the opening report's `LANE_TREE`, never
`git rev-parse --show-toplevel` (its cwd may have reset to the main checkout);
a concurrent lane's claim names its sibling tree instead (launch-mode.md row 1).

**Do NOT claim `LAUNCH_BRANCH` — it is the OUTER TOOL's branch**, to PUT BACK.
Write "the branch §5 will create in `<LANE_TREE>`" and post now — a claim that
waits for the branch lands after the first edit. Such lanes are SERIAL (§3):
claim the top one or the whole set, every lane after the first QUEUED.

```bash
gh issue comment <n> --body "QUEUED behind #<the lane running first> in \
<LANE_TREE> — this session starts it only after that lane merges. Not \
started: no branch exists yet and no file is held. If you want this issue, take \
it and say so here; I will stand down."
```

When the run ends before reaching one — or a lane never becomes RUNNABLE because
an open PR holds what its fix needs (triage.md §2: a peer's files, a fork's
hunks) — **stand it down**: say it is
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
`gh issue view <n> --json state`, §2's open-PR `files` query, and §3's premise
check on CURRENT `origin/main` — in a call BEFORE the claim, never chained with
it: after TRIAGE a peer can close a queued issue, or open a PR holding its
files, before its turn (#3979). Then:

```bash
gh issue comment <n> --body "Working on this in PR/branch <ref> — touching <files>. \
Claiming to avoid collision with parallel agents."
```

Mandatory, BEFORE the first edit (the issue-level DISJOINT-FILE rule).
**`<files>` is every file the lane will EDIT, and the lane is dispatched with
that list**: beside the fix and its unit test, the integ fixture §8-c will
extend (`grep -rl '<type's last segment>' tests/integration/*/lib`) and, when a
provider gains `context?: UpdateContext`, triage.md §2's checker/test pair, and
every comment, doc or rule the fix makes FALSE — stating the old invariant or
calling the issue open (`grep -rnw '<issue digits>\|<key symbol>' src docs
.claude/rules`, minus `docs/_generated`, each through §2's open-PR `files`
query); a NEW SDK provider adds `.claude/rules/providers.md`'s "Adding a New
SDK Provider" files plus the tables its fences read (`name-keys.ts` + tests,
nested-key coverage, `docs/cli-drift.md`) — a narrower list stops the lane
mid-run to ask (go-to-k/cdkd#1160).

**Correct the classification lines in the same turn as the claim**: rewrite a
legacy packed body to the four-line shape (§3), fill a missing `Severity`, fix
what the evidence contradicts (`Notes` never enters a body).

**Carry `--add-label` on that same `gh issue edit`** (`severity:<v>`,
`effort:<v>`, plus `--remove-label` for the one superseded — else §3's query
picks between TWO), BEFORE the lane's PR exists, so the PR inherits them.

**Claim at SHORTLIST time, before the analysis.**

**Then VERIFY the claim stuck** — posting is not winning:

```bash
gh issue view <n> --json comments \
  --jq '.comments[] | select(.body | test("Working on this")) | "\(.createdAt)\t\(.body[0:80])"'
```

**Tie-break: the EARLIEST `createdAt` wins.** If a rival's claim predates yours,
stand down naming the winning branch and pick another issue, unasked. Escalate
when timestamps cannot settle it (go-to-k/cdkd#1446).

**A QUEUED comment IS a claim, and its `createdAt` is what the tie-break reads.**
Re-read the thread to the END before publishing a precedence account, and never
infer absence from a missing branch: a signal shows LIFE only (§9), and a claim
has no TTL, so one you believe dead goes to arbitration.

**Nothing makes the tie-break's LOSER re-read**: re-read the claims before you
PUSH; if yours is later, stand down even with code written.

**Claim what you FILE, too — filing is not claiming**: a self-filed
deferral is invisible to ownership probes. For one THIS run means to pick up
(`Session-fit: now`), claim it in the turn you file it, naming the LANE, not your
current branch, which §9 deletes. One handed off (`next`) gets NO claim until a
later run takes it.

**Verify occupancy live, never from a handoff table** (`gh pr list`, `git
worktree list`, the comments); a stand-down or a close RELEASES (§9).
