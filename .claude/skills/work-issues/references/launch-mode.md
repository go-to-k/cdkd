<!-- Part of the /work-issues skill. Stage files: launch-mode.md (before stage 0), triage.md (§0–§3), claim.md (§4), implement.md (§5), filing.md (§5-f), gates-and-pr.md (§6–§7), verify.md (§8), ship.md (§9), retro.md (§10), gotchas.md (appendix). A bare §N points into the file that holds that section. READ THIS FILE IN FULL before stage 0. -->

## Launch mode — the PARENT runs this BEFORE stage 0

This is the ONLY copy of the probe. SKILL.md "Launch mode" points here rather
than restating it, because a second verbatim copy of a command is the drift
shape §10-b fences elsewhere.

```bash
[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ] \
  || { echo 'PROBE FAILED: not inside a git work tree -- do not guess the mode'; exit 1; }
COMMON=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
GITDIR=$(cd "$(git rev-parse --git-dir)" && pwd -P)
LANE_TREE=$(cd "$(git rev-parse --show-toplevel)" && pwd -P)
MAIN_CHECKOUT=$(dirname "$COMMON")
LAUNCH_BRANCH=$(git branch --show-current)   # empty when launched detached
[ "$GITDIR" = "$COMMON" ] && MODE=MAIN-CHECKOUT || MODE=IN-PLACE
printf 'MODE=%s\nLANE_TREE=%s\nMAIN_CHECKOUT=%s\nLAUNCH_BRANCH=%s\n' \
  "$MODE" "$LANE_TREE" "$MAIN_CHECKOUT" "$LAUNCH_BRANCH"
```

### Why here and not at the top of stage 3

The probe used to sit at the top of §3, on the reasoning that §3 is the first
place the answer is used. Both halves of that were wrong, and each one alone
would be enough to move it:

- **Stages 1 and 2 already consume the mode.** §2's collision map runs
  `git -C .claude/worktrees/<w> log|show|status` — a RELATIVE path, correct
  only from the main checkout. Run IN-PLACE, the cwd is a lane tree, that path
  does not exist, git errors, and the scan returns NOTHING. An empty collision
  map reads as "no competing agents", which is the exact failure §2 exists to
  prevent, and it fails QUIETLY. `MAIN_CHECKOUT` is what makes that scan
  absolute, so it has to exist before §2 runs, not after.
- **Stages 0–3 are DELEGATED to a read-only triage subagent** (SKILL.md), whose
  return payload is a candidate table — no git state, no paths. An answer
  computed inside it never reaches the parent, and the parent is the party that
  later runs `git worktree add` or does not. Computing it in the parent before
  dispatching anything removes the problem instead of documenting it.

So: run it in the parent, pass `MODE` / `LANE_TREE` / `MAIN_CHECKOUT` /
`LAUNCH_BRANCH` into the triage dispatch and into every lane dispatch, and state
all four in the opening report.

### Reading the four values

`GITDIR` equals `COMMON` only in the main checkout — a linked worktree's
`--git-dir` is `<common-dir>/worktrees/<name>`. `pwd -P` is load-bearing in
BOTH directions: the main checkout answers `.git` RELATIVELY for both, so an
unnormalised compare is only accidentally right, and macOS spells `/tmp` as
`/private/tmp`.

`MAIN_CHECKOUT` is `dirname "$COMMON"` — the parent of the ONE shared git dir —
never `pwd` and never `--show-toplevel`, both of which answer "the tree I am
standing in" and so are exactly wrong in the mode that needs the value.

`LANE_TREE` is "the tree this run stands in", NOT "the lane worktree":
MAIN-CHECKOUT records the main checkout under it, and the two are equal there.
IN-PLACE they differ, and that difference is the whole point.

`LAUNCH_BRANCH` is `git branch --show-current` **at probe time** — the branch
the tree was handed to this run ON, which IN-PLACE means the branch the OUTER
TOOL created. An EMPTY value is a legitimate answer, not a probe failure: it
says the run was launched detached, and §9's restore keeps a detach fallback for
exactly that case. It is the one value that becomes UNRECOVERABLE if not
recorded now — §5 switches the tree onto the lane's own branch, so every later
`git branch --show-current` answers with the LANE's branch and the thing this
value exists to name (what to put back) is gone. MAIN-CHECKOUT records it and
does nothing with it: the run never leaves the main checkout, so §9's restore
arm does not fire there.

**IN-PLACE, `LAUNCH_BRANCH` is a branch to PUT BACK, never one to commit to.**
§5 branches in place off `origin/main` instead of committing onto it, and the
reason is not tidiness: `gh pr merge --delete-branch` (§9) deletes the REMOTE
branch the PR was opened from, so a lane that worked directly on the outer
tool's branch would delete the outer tool's branch on the way out — a far
heavier interference than the detached HEAD this whole rule exists to avoid.
The lane owns its own branch and deletes only that one.

**The guard on the first line is not decoration.** Outside a work tree every
`git rev-parse` fails and each substitution collapses to the empty string, so
an unguarded compare tests `""` against `""` and prints MAIN-CHECKOUT — a wrong
verdict, with a wrong `LANE_TREE` beside it. Measured 2026-08-31, the shells
even disagreed about the wreckage: bash REFUSES `cd ""` (rc=1) while zsh
accepts it (rc=0) and prints the cwd twice. `--is-inside-work-tree` is
compared to the literal `true` rather than trusted for its exit status,
because inside a `.git` directory it prints `false` and exits 0 — measured
2026-09-01; the exit-status form passed there and produced an empty
`LANE_TREE` under a `MAIN-CHECKOUT` verdict. With the value compare, all four
non-repo positions (outside a repo, inside `.git`) fail loudly in both shells,
and the shell divergence stops mattering.

**An empty value is worse than a failed command, which is why the probe stops
rather than warning.** `git -C "" rev-parse --show-toplevel` exits 0 and prints
the CWD's repo, so a `git -C "<LANE_TREE>"` recipe handed a blank silently
retargets whatever tree the shell is standing in — the main checkout, in
exactly the scenario the `-C` was added for. The guard would degrade into the
bug it guards, with no failure to read.

### The values are RECORDED, never re-derived

The opening report is their ONLY recorded copy. Every later stage runs in a
fresh shell whose cwd may have silently reset to the main checkout (appendix,
"Bash cwd silent reset"), so a stage that re-derives `LANE_TREE` from
`$(git rev-parse --show-toplevel)` or from `pwd` answers "the main checkout"
in precisely the case the value exists to guard.

**`<LANE_TREE>` and `<MAIN_CHECKOUT>` in a later stage are SUBSTITUTION
PLACEHOLDERS, not shell variables.** Paste the absolute path from the opening
report into the command text. Do NOT write `git -C "$LANE_TREE"`: the
assignments live in THIS fenced block, and every later block is its own Bash
call and its own shell (§9 spells the same trap out for `MAIN`, §10-d for
`B`), so the variable is already empty there — and per the paragraph above, an
empty `-C` does not fail, it re-targets. A placeholder that was never
substituted is visible in the command you are about to run; an empty variable
is not visible anywhere.

### What IN-PLACE changes, and where each consequence fires

SKILL.md carries the same list in short form; this is the one with the file
pointers. IN-PLACE means this run was launched inside a worktree someone else
created (an Orca/ADE workspace, a stray `cd`), so it has exactly ONE working
tree:

| # | Consequence | Where |
|---|---|---|
| 1 | Lanes run SERIALLY — a second CONCURRENT lane would need a worktree NESTED inside this one, which dies with the outer workspace and takes its uncommitted work (go-to-k/cdkd#2390). Several issues in one run is still fine when they share this tree in sequence: claim them all up front with the later ones marked QUEUED, and stand the unstarted ones down with a four-field comment if the run times out, which leaves every issue claimable (measured 2026-09-02, go-to-k/cdkd#2417) | §3 |
| 2 | §2's worktree probes take `<MAIN_CHECKOUT>/.claude/worktrees/<w>`, not a relative path | §2 |
| 3 | The claim names the tree already checked out here plus the branch §5 WILL create in it — never `LAUNCH_BRANCH`, which belongs to the outer tool | §4 |
| 4 | Create no worktree; after confirming the tree is YOURS, branch IN PLACE off `origin/main` — ALWAYS, not only when the tree is detached or its PR has merged — and never commit onto `LAUNCH_BRANCH` | §5 |
| 5 | Remove no worktree: a lane that removes the tree it runs in deletes its own cwd. Cleanup of the TREE belongs to whoever created it | §9, §10-d |
| 6 | Switch back to `LAUNCH_BRANCH` **as-is** — no pull, no rebase, no fast-forward — and delete only the branches THIS run created; detach only when `LAUNCH_BRANCH` was empty at probe time or is now gone | §9 |
| 7 | `main` is checked out in the main checkout, so the post-merge `git checkout main && git pull` cannot run here — pull through `git -C "<MAIN_CHECKOUT>"` | §9 |
| 8 | The post-release rebuild targets the MAIN checkout for the same reason | §9 |
| 9 | The retro branch is created in THIS tree too, so the `LAUNCH_BRANCH` restore is the run's LAST step — after the retro PR merges, not inside §9's per-lane cleanup | §10-d |

"Four things and nothing else" was the previous count, and it was wrong in the
direction that matters: this file is not always loaded, SKILL.md is, so an
undercount in the orchestrator wins over the reference files it points at.
Count the rows before writing a number beside them.
