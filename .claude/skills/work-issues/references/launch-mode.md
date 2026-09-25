<!-- /work-issues stage file; stage map in ../SKILL.md. A bare §N points into the file holding that section. READ IN FULL before stage 0. -->

## Launch mode — the PARENT runs this BEFORE stage 0

This is the ONLY copy of the probe.

```bash
[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ] \
  || { echo 'PROBE FAILED: not inside a git work tree -- do not guess the mode'; exit 1; }
COMMON=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
GITDIR=$(cd "$(git rev-parse --git-dir)" && pwd -P)
LANE_TREE=$(cd "$(git rev-parse --show-toplevel)" && pwd -P)
MAIN_CHECKOUT=$(dirname "$COMMON")
LAUNCH_BRANCH=$(git branch --show-current)   # empty when launched detached
[ "$GITDIR" = "$COMMON" ] && MODE=MAIN-CHECKOUT || MODE=IN-PLACE
printf 'MODE=%s\nLANE_TREE=%s\nMAIN_CHECKOUT=%s\nLAUNCH_BRANCH=%s\nORIGIN=%s\n' \
  "$MODE" "$LANE_TREE" "$MAIN_CHECKOUT" "$LAUNCH_BRANCH" "$(git remote get-url origin)"
```

Run it in the parent, pass all four values into the triage dispatch and into
every lane dispatch, and state all four in the opening report.

**`ORIGIN` not `go-to-k/cdkd` is a FORK run** — the fork's issues are off and
its `main` lags. Before triage, `git remote add upstream
https://github.com/go-to-k/cdkd.git && git fetch upstream main`, and pass the
fork layout into every dispatch: each `gh` call takes `-R go-to-k/cdkd`,
`origin/main` in any stage file reads `upstream/main`, lanes push to `origin`
and open with `--head <fork-owner>:<branch>`, and without upstream `push` the
merge and its integ are the maintainer's — lanes stop at merge-ready.

### Reading the four values

- `GITDIR` equals `COMMON` only in the main checkout — a linked worktree's
  `--git-dir` is `<common-dir>/worktrees/<name>`. `pwd -P` is load-bearing: the
  main checkout answers `.git` RELATIVELY for both, so an unnormalised compare
  is only accidentally right, and macOS spells `/tmp` as `/private/tmp`.
- `MAIN_CHECKOUT` is `dirname "$COMMON"` — the parent of the ONE shared git dir
  — never `pwd` and never `--show-toplevel`, both of which answer "the tree I am
  standing in" and so are exactly wrong in the mode that needs the value.
- `LANE_TREE` is "the tree this run stands in", NOT "the lane worktree":
  MAIN-CHECKOUT records the main checkout under it and the two are equal there.
  IN-PLACE they differ, and that difference is the whole point.
- `LAUNCH_BRANCH` is `git branch --show-current` **at probe time** — the branch
  the tree was handed to this run ON, which IN-PLACE means the branch the OUTER
  TOOL created. An EMPTY value is a legitimate answer, not a probe failure: it
  says the run was launched detached, and selects §9's detach fallback. It is
  the one value that becomes UNRECOVERABLE if not recorded now — §5 switches the
  tree onto the lane's own branch, after which every `git branch
  --show-current` answers with the LANE's branch. MAIN-CHECKOUT records it and
  does nothing with it: §9's restore arm does not fire there.

**The guard on the first line is not decoration.** Outside a work tree every
`git rev-parse` fails and each substitution collapses to the empty string, so an
unguarded compare tests `""` against `""` and prints MAIN-CHECKOUT — a wrong
verdict with a wrong `LANE_TREE` beside it. `--is-inside-work-tree` is compared
to the literal `true` rather than trusted for its exit status, because inside a
`.git` directory it prints `false` and exits 0. The probe STOPS rather than
warning because an empty value is worse than a failed command:
`git -C "" rev-parse` exits 0 and answers about the CWD's repo, so a
`git -C "<LANE_TREE>"` recipe handed a blank silently retargets the main
checkout — the one tree the `-C` was added to avoid.

### LAUNCH_BRANCH is borrowed, not owned

**IN-PLACE, `LAUNCH_BRANCH` is a branch to PUT BACK, never one to commit to —
and never one to RENAME.** §5 branches in place off `origin/main` instead of
committing onto it, because `gh pr merge --delete-branch` (§9) deletes the
REMOTE branch the PR was opened from: a lane that worked directly on the outer
tool's branch would delete it on the way out. A RENAME looks like taking a lane
branch and is cheaper, but it DESTROYS the restore target: `git branch -m`
leaves the old name nowhere, so §9's `show-ref` finds nothing and the run falls
through to the detach fallback. Only `git switch -c <lane> origin/main` gets you
the lane branch.

**The outer tool renames too, so `show-ref` before the restore is mandatory
rather than defensive** — Orca derives a workspace branch name from a session's
FIRST PROMPT and can rename a tree out from under a recorded value
(go-to-k/cdkd#2413). Recovery from EITHER rename is the reflog:

```bash
git reflog --all --date=iso | grep -i 'Branch: renamed'   # the old name + its sha
git branch <LAUNCH_BRANCH> <that sha>                     # re-create, then §9 restores
```

Run that BEFORE §9's `git branch -D <lane>`: a branch's reflog is deleted with
the branch, so afterwards the rename survives only in HEAD's copy.

**Pin lane identity to the TREE PATH, never to the branch name** (§2's collision
reading). Because the outer tool derives that name from a prompt, a tree can sit
on a branch NAMING ANOTHER WORKSPACE, which reads as a trespass and is noise.

### The values are RECORDED, never re-derived

Later stages run in a fresh shell whose cwd may have silently reset to the main
checkout (gotchas.md, "A Bash cwd silently drifts back"), so a stage that re-derives
`LANE_TREE` from `$(git rev-parse --show-toplevel)` or from `pwd` answers "the
main checkout" in precisely the case the value exists to guard.

**The same fault arrives through commands that never MENTION the values** — a
`grep` / `cat` on a RELATIVE path, or a bare `git branch --show-current` /
`git diff`. Read every file this run owns under the recorded absolute
`<LANE_TREE>`, and treat an answer CONTRADICTING those values as a cwd fault,
not a finding (go-to-k/cdkd#2514).

**`<LANE_TREE>` and `<MAIN_CHECKOUT>` in a later stage are SUBSTITUTION
PLACEHOLDERS, not shell variables.** Paste the absolute path from the opening
report into the command text. Do NOT write `git -C "$LANE_TREE"`: every later
block is its own shell, so the variable is already empty there — and an empty
`-C` does not fail, it re-targets.

### What IN-PLACE changes, and where each consequence fires

IN-PLACE means the run was launched inside a worktree someone else created, so
it has exactly ONE working tree:

| # | Consequence | Where |
|---|---|---|
| 1 | Lanes run SERIALLY — a second CONCURRENT lane would need a worktree NESTED inside this one (go-to-k/cdkd#2390). Several issues in one run is still fine when they share this tree in sequence: claim them all up front with the later ones marked QUEUED, and stand the unstarted ones down with a four-field comment if the run times out | §3 |
| 2 | §2's worktree probes take `<MAIN_CHECKOUT>/.claude/worktrees/<w>`, not a relative path | §2 |
| 3 | The claim names the tree checked out here plus the branch §5 WILL create in it — never `LAUNCH_BRANCH`, which belongs to the outer tool | §4 |
| 4 | Create no worktree; after confirming the tree is YOURS, branch IN PLACE off `origin/main` — ALWAYS, not only when the tree is detached or its PR has merged — and never commit onto `LAUNCH_BRANCH` | §5 |
| 5 | Remove no worktree: a lane that removes the tree it runs in deletes its own cwd. Cleanup of the TREE belongs to whoever created it | §9 |
| 6 | Switch back to `LAUNCH_BRANCH` **as-is** — no pull, no rebase, no fast-forward — and delete only the branches THIS run created; detach only when `LAUNCH_BRANCH` was empty at probe time or is now gone | §9 |
| 7 | `main` is checked out in the main checkout, so the post-merge `git checkout main && git pull` cannot run here — pull through `git -C "<MAIN_CHECKOUT>"`, and rebuild there too | §9 |
| 8 | The retro branch is created in THIS tree, so the `LAUNCH_BRANCH` restore is the run's LAST step — after the retro PR merges, not in §9's per-lane cleanup | §10-d |
| 9 | Serial lanes SHARE this tree's `integ-destroy` marker, which is per-worktree, so lane 2 inherits lane 1's. Its `hash: diff` scope narrows that but does not close it, and a marker measured on lane 1's stack says nothing about lane 2's: run the integ per LANE | §8 |
| 10 | Serial lanes SHARE ignored files too: a new fixture's `node_modules/` survives the branch switch, the directory with it, and `gen:all-matrices` counts a fixture the next lane's branch lacks — CI's regen check then fails. List untracked fixture dirs before regenerating (go-to-k/cdkd#3644) | §6 |
