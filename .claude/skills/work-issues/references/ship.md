<!-- /work-issues stage file; stage map in ../SKILL.md. A bare §N points into the file holding that section. READ IN FULL at stage entry. -->

## 9. Ship: merge → pull → rebuild → cleanup

The PARENT's serialization point: grant one merge-ready lane at a time its turn
— resume that lane agent (SendMessage) to run its integ fixtures and merge while
it holds the turn, or run `/run-integ` and `gh pr merge` yourself FROM THAT
LANE'S WORKTREE. Never two lanes' integs or merges at once.

- The `integ-destroy` marker is read from the tree the command runs in, so a
  merge from the main tree consults the WRONG store (go-to-k/cdkd#2363). Its
  `hash: diff` covers this branch's delta against `origin/main`, so run the
  integ AFTER the flatten/rebase below (`references/verify.md` §8-b).
- **A `SendMessage` answering "queued" (or `Resuming agent`) is NOT delivery** —
  a lane stopped at merge-ready drains no queue: re-send, confirm in the TREE.

### Flatten, then rebase

**FLATTEN BEFORE YOU REBASE — the default step, not a remedy.** The integ ledger
`docs/_generated/integ-last-run.tsv` gains a row at the same place on every lane
that ran one, so a commit-by-commit rebase re-conflicts once per commit; the
repo squash-merges, so flattening loses nothing. If the harness denies
`git reset`, run the bare `git rebase origin/main` instead and fix up with NEW
commits — safe while the ledger row is committed only AFTER the rebase:

```bash
git reset --soft "$(git merge-base origin/main HEAD)"   # one commit
# Message to a FILE named per BRANCH, never -m: inside -m "..." the shell
# EVALUATES a backtick and drops the word while still creating the commit.
# DERIVE, WRITE and COMMIT in ONE call -- shell state dies between tool calls.
MSGREF=$(git branch --show-current | tr / -); MSGREF=${MSGREF:-$$}   # empty when detached
MSGFILE="${TMPDIR:-/tmp}/cdkd-squash-${MSGREF}.txt"
cat > "$MSGFILE" <<'EOF'
<the squashed message>
EOF
git commit -F "$MSGFILE"
git show --stat --format= HEAD   # lane paths ONLY, else it reverts peers: redo via reflog
git rebase origin/main   # its OWN call, then `git status`: at most one conflict,
                         # and a regen / `commit --amend` chained after a STOPPED
                         # rebase amends the detached onto-commit (go-to-k/cdkd#3671)
```

- **A GENERATED file is REGENERATED, never hand-merged**: re-run the generator,
  commit ITS output. Take upstream whole when it derives the file from the tree.
- **The integ ledger is the exception**: its rows record real-AWS RUNS, so
  upstream-whole drops this lane's row. Keep both, then run
  `vp run integ-ledger-normalize` before `git rebase --continue` and commit it.

### Merge

```bash
gh pr merge <n> -R <owner>/<repo> --squash --delete-branch
```

- **Read the merge state before you watch CI**: at `mergeable=CONFLICTING` CI
  never fires. Poll `gh pr checks <N> --json name,state` (`--watch` returns at
  once when no check has APPEARED) and require that checks EXIST. It has no sha
  field — `headRefOid` is `gh pr view`'s: an unknown field exits 1 on EVERY
  poll, so a loop reading non-zero as pending outlives a green CI. **PUSH FIRST,
  then run the post-rebase suite while CI drains.**
- **A body edit RE-RUNS four required checks** (`on: edited`), green CI or
  not: merge only at `gh pr view <N> --json mergeStateStatus` = `CLEAN` (else
  "base branch policy prohibits the merge"); `gh run rerun` what it CANCELLED,
  which blocks even after re-runs pass (#3664, #3748).
- **`-R` is not optional in a multi-repo run**: `gh` infers it from the CWD,
  and `Could not resolve to a PullRequest` reads as a permissions problem.
- **From the PR's own worktree, `--delete-branch` prints a bare `fatal: 'main'
  is already used by worktree ...` and the merge SUCCEEDED anyway** — confirm
  with `gh pr view <N> --json state` before reacting.
- **A lane that fixes a full-suite flake merges FIRST**, and the others rebase
  onto it. A RED check can equally be a peer's just-merged content your local
  green never saw — fetch, rebase, re-run.

- **An OUTSIDE reporter's issue is thanked after the RELEASE, not the merge**:
  merge the release PR, confirm the npm version, then comment on the issue in
  English — thanks, the version it shipped in, "feel free to open an issue"
  (maintainer direction, go-to-k/cdkd#3624).

### Pull, then rebuild the linked binary

The global `pnpm link --global` points at this repo's `dist/cli.js`, so a build
on updated `main` is all the linked binary needs. MAIN-CHECKOUT (SKILL.md
"Launch mode") — run THIS block, and not the next one:

```bash
git checkout main && git pull origin main    # bring the merges local
vp run build
```

IN-PLACE — run THIS block INSTEAD, never both: `main` is checked out in the main
tree, so `checkout main` fails here, and building THIS tree leaves the user on
the old binary. `MAIN` is derived per block, never borrowed — each fenced block
is its own shell:

```bash
# The main checkout is always the FIRST row of `git worktree list`.
MAIN=$(git worktree list --porcelain | awk 'NR==1{print substr($0,10)}')
git -C "$MAIN" pull origin main
( cd "$MAIN" && vp run build )
```

That pull fails outright if the shared main tree is dirty (§7); do not restore
the offending path, which is another session's uncommitted work.

### Cleanup

**Remove every worktree YOU created — and only those.** For one you do not
recognise, each of `session-owner`, uncommitted work, its branch's PR state and
the claim thread is evidence of LIFE only; an absent `session-owner` is NO
signal, and a claim younger than `CDKD_WORKTREE_OWNER_TTL_HOURS` (default 12)
means the owner is presumed LIVE — leave it.

MAIN-CHECKOUT — run THIS block, and not the next one:

```bash
git worktree remove .claude/worktrees/<branch>   # --force if it refuses on artifacts
git worktree prune
git branch -D <branch>                           # -D, not -d (squash); PR MERGED first
git worktree list                                # every worktree THIS run added is gone
git branch --list '<your prefix>*'               # ...and so is every branch it added
```

IN-PLACE — run THIS block INSTEAD, never both. **An IN-PLACE run created no
worktree, so it removes none**: it must not remove the tree it runs in. It owes
the BRANCH — put back the one it found, delete the one it made.
`<LAUNCH_BRANCH>` and `<each branch this run created>` are SUBSTITUTION
PLACEHOLDERS, not shell variables (`references/launch-mode.md`):

```bash
git show-ref --verify --quiet refs/heads/<LAUNCH_BRANCH> || echo 'gone -> use the fallback'
DIRTY=$(git status --porcelain)
[ -z "$DIRTY" ] || echo 'dirty -> commit or stash first, then re-run this block'
[ -z "$DIRTY" ] \
  && git switch --no-guess <LAUNCH_BRANCH> \
  && git branch -D <each branch this run created>  # AS-IS: no pull, no rebase, no fast-forward
git branch --show-current      # must print <LAUNCH_BRANCH>
git branch --list '<your prefix>*'             # ...and every branch this run added is gone
```

Every line and the ORDER are load-bearing. `--no-guess`: plain `git switch`
DWIMs, re-creating the branch from `origin` and reporting success where the run
should fall through to the fallback. The dirty check runs FIRST and is a TEST,
since `--porcelain` exits 0 either way and `git switch` carries uncommitted
changes ACROSS. Unchained, a FAILED switch still runs the `-D`, which git refuses
only for the CHECKED-OUT branch. The delete is PLURAL (§10-d adds a retro branch)
and unconditional, so confirm each PR reads `MERGED` first.

Fallback — run THIS block INSTEAD of the one above, never both. It applies ONLY
when `LAUNCH_BRANCH` was empty at probe time (launched detached) or the branch
is now gone; never as the default. Chaining matters here too: an unchained
`switch --detach` after a failed `fetch` detaches at a STALE `origin/main`.

```bash
git fetch origin \
  && git switch --detach origin/main \
  && git branch -D <each branch this run created>
```

Never `git pull` into `<LAUNCH_BRANCH>`, never `git merge --ff-only origin/main`
onto it, never `git rebase <LAUNCH_BRANCH>`, and never
`git branch -D <LAUNCH_BRANCH>`. **AS-IS is the whole rule: RESTORE, never
ADJUST.** **This step runs LAST, not per-lane**: §10 branches in this same tree,
so restoring here and branching again in §10-d would undo itself.

### Release the claims

**RELEASE the claim on every issue that did NOT auto-close** — `--delete-branch`
deleted the branch the claim names, leaving a lock pointing at nothing:

```bash
for n in <the issues you claimed>; do
  printf '#%s: ' "$n"; gh issue view "$n" --json state -q .state
done
```

Every `OPEN` needs a comment saying the issue is now UNCLAIMED, what the merged
PR closed, and what remains and why, carrying forward anything expensive the
lane measured. **Write it AFTER the merge, or state the PR's ACTUAL state.**
Then go on to §10 while the run's evidence still exists.
