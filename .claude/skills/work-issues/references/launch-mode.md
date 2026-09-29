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

Run it in the parent, pass every value into the triage dispatch and into
every lane dispatch, and state them all in the opening report.

### Reading the values

- `GITDIR` equals `COMMON` only in the main checkout (a linked worktree's
  `--git-dir` is `<common-dir>/worktrees/<name>`); `pwd -P` normalises the
  relative `.git` and macOS's `/private/tmp`.
- `MAIN_CHECKOUT` is `dirname "$COMMON"`, never `pwd` or `--show-toplevel`:
  both answer "the tree I stand in", wrong in exactly the mode needing it.
- `LAUNCH_BRANCH` is the branch at probe time — IN-PLACE, the OUTER TOOL's.
  Empty means launched detached and selects §9's detach fallback. Record it
  now: once §5 switches to the lane branch it is unrecoverable. MAIN-CHECKOUT
  never uses it.
- `ORIGIN` other than `https://github.com/go-to-k/cdkd.git` /
  `git@github.com:go-to-k/cdkd.git` is a FORK run: its issues are off and its
  `main` lags. Before triage run `git remote get-url upstream || git remote add
  upstream https://github.com/go-to-k/cdkd.git; git fetch upstream main`, and
  tell every dispatch: `gh` takes `-R go-to-k/cdkd`, a stage file's
  `origin/main` reads `upstream/main`, lanes push to `origin` and open with
  `--head <fork-owner>:<branch>`. Read `gh api repos/go-to-k/cdkd --jq
  .permissions` NOW: without `push`, the merge, its integ and any issue-body
  edit are the maintainer's, so lanes stop at PR open + CI green (or
  `action_required` awaiting approval) and correct an issue's `Session-fit` by
  comment.

**The guard on the first line is not decoration.** Outside a work tree every
substitution collapses to `""`, so an unguarded compare prints MAIN-CHECKOUT
with a wrong `LANE_TREE`. `--is-inside-work-tree` is compared to the literal
`true` because inside `.git` it prints `false` and exits 0. The probe STOPS
because `git -C "" rev-parse` exits 0 against the CWD's repo, so a blank
`<LANE_TREE>` silently retargets the main checkout.

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

IN-PLACE runs in a worktree someone else created — ONE launch tree (row 1):

| # | Consequence | Where |
|---|---|---|
| 1 | Lanes in THIS tree run serially. A CONCURRENT lane gets a SIBLING worktree, never one NESTED inside this tree: `git -C <MAIN_CHECKOUT> worktree add <MAIN_CHECKOUT>/.claude/worktrees/<b> -b <b> origin/main` (go-to-k/cdkd#3902), and its claim names that path. Integ runs and merges stay serialized; each tree runs its integ from its OWN `dist/` and `integ-destroy` marker; §9 removes a sibling with the MAIN-CHECKOUT arm | §3, §4, §5, §9 |
| 2 | §2's worktree probes take `<MAIN_CHECKOUT>/.claude/worktrees/<w>`, not a relative path | §2 |
| 3 | For a lane in THIS tree, the claim names the tree checked out here plus the branch §5 WILL create in it — never `LAUNCH_BRANCH`, which belongs to the outer tool | §4 |
| 4 | Create no worktree for a lane in THIS tree; after confirming the tree is YOURS, branch IN PLACE off `origin/main` — ALWAYS, not only when the tree is detached or its PR has merged — and never commit onto `LAUNCH_BRANCH` | §5 |
| 5 | Remove no worktree you stand in: a lane that removes the tree it runs in deletes its own cwd; a sibling this run created is yours to remove (row 1). Cleanup of the TREE belongs to whoever created it | §9 |
| 6 | Switch back to `LAUNCH_BRANCH` **as-is** — no pull, no rebase, no fast-forward — and delete only the branches THIS run created; detach only when `LAUNCH_BRANCH` was empty at probe time or is now gone | §9 |
| 7 | `main` is checked out in the main checkout, so the post-merge `git checkout main && git pull` cannot run here — pull through `git -C "<MAIN_CHECKOUT>"`, and rebuild there too | §9 |
| 8 | The retro branch is created in THIS tree, so the `LAUNCH_BRANCH` restore is the run's LAST step — after the retro PR merges, not in §9's per-lane cleanup | §10-d |
| 9 | Serial lanes SHARE this tree's `integ-destroy` marker, which is per-worktree, so lane 2 inherits lane 1's. Its `hash: diff` scope narrows that but does not close it, and a marker measured on lane 1's stack says nothing about lane 2's: run the integ per LANE | §8 |
| 10 | Serial lanes SHARE ignored files too: a new fixture's `node_modules/` survives the branch switch, the directory with it, and `gen:all-matrices` counts a fixture the next lane's branch lacks — CI's regen check then fails. List untracked fixture dirs before regenerating (go-to-k/cdkd#3644) | §6 |
