<!-- /work-issues stage file; stage map in ../SKILL.md. A bare §N points into the file holding that section. READ IN FULL at stage entry. -->

## 9. Ship: merge → pull → rebuild → cleanup

The PARENT's serialization point: run your own review round on a merge-ready
lane (`references/verify.md` §8-i — before EVERY merge, even when the lane's
reviewers passed; go-to-k/cdkd#3906), grant it its turn only once that round is
CLEAN (one lane at a time), then run `/run-integ` and
`gh pr merge` yourself FROM THAT LANE'S WORKTREE — never the lane agent, whose
real-AWS integ and merge the auto-mode classifier can refuse, and a refused
lane call is the user's call, not a retry (go-to-k/cdkd#4059); the parent's own
marker set and ledger push follow `/run-integ` step 9. While that tree is
busy with a follow-up branch, ship from a SECOND sibling on the PR's branch
(`git -C <MAIN_CHECKOUT> worktree add <MAIN_CHECKOUT>/.claude/worktrees/<name> <branch>`),
running BOTH the integ and the merge there (the marker is per tree). A fix
round DURING that tree's integ edits a `--detach` sibling, pushes
`HEAD:<branch>` (bash reads `verify.sh` live), and fast-forwards that tree
before the marker, re-running an integ the fix touches (#4561). Never two
lanes' integs or merges at once; when a turn will hold for HOURS, tell the user
unasked its ETA and the PRs queued.

- The `integ-destroy` marker is read from the tree the command runs in, so a
  merge from the main tree consults the WRONG store (go-to-k/cdkd#2363). Its
  `hash: diff` covers this branch's delta against `origin/main`, so run the
  integ AFTER the flatten/rebase below (`references/verify.md` §8-b says which
  rebases stale it). While a scoped file this branch changes is busy on `main`
  (go-to-k/cdkd#4183), run the set as ONE parallel batch (building fixtures per
  `/run-integ` step 1), then set the marker, record, push and merge without
  starting other work between them (the Merge bullets below still apply).
- **A `SendMessage` answering "queued" (or `Resuming agent`) is NOT delivery** —
  a lane stopped at merge-ready drains no queue: re-send, confirm in the TREE.

### Flatten, then rebase

**FLATTEN BEFORE YOU REBASE — the default step, not a remedy.** The integ ledger
`docs/_contents/_generated/integ-last-run.tsv` gains a row at the same place on every lane
that ran one, so a commit-by-commit rebase re-conflicts once per commit; the
repo squash-merges, so flattening loses nothing. Both rewrite a PUSHED branch,
so FIRST push plainly until `git rev-list origin/<branch>..HEAD` is empty (a
denied plain push is re-authorized, never routed round through the arm). Then,
when the harness denies the `git reset`, the rebase or the `--force-with-lease`
push, take §7's MERGE ARM from `origin/<branch>` (go-to-k/cdkd#4327), spelled
here as a denial blocks re-reading §7, in `<LANE_TREE>` by literal path:
`checkout -B <branch> origin/<branch>`, `merge origin/main`, re-run the
generators and `vp run integ-ledger-normalize` (`merge=union` hides the ledger
conflict locally), commit what changed, push plainly. When the arm's checkout
or merge is denied TOO, `git merge --abort` any half-done merge and ask the
maintainer (`AskUserQuestion`) to authorize the flatten. With no denial, or
on that yes:

```bash
git reset --soft "$(git merge-base origin/main HEAD)"   # one commit
# From another tree, `.claude/hooks/bughunt-clean-gate.sh` refuses `-C "$VAR"`
# on a `git commit` / `gh pr create|merge` segment, so every gated line takes
# the LITERAL path; keep `$(git -C <literal path> merge-base origin/main HEAD)`.
# Never the origin/main TIP: --soft onto it stages a revert of main's newer files.
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
  commit ITS output. Upstream whole only clears the conflict: it lacks this
  lane's inputs, so regenerate before the push (go-to-k/cdkd#4460).
- **The integ ledger is the exception**: its rows record real-AWS RUNS, so
  upstream-whole drops this lane's row. GitHub ignores its `merge=union`, so a
  `main` ledger row turns the PR CONFLICTING: rebase locally, normalize (Merge).

### Merge

```bash
gh pr merge <n> -R <owner>/<repo> --squash --delete-branch
# -R on every gh call below too: "Could not resolve to a PullRequest" is no permissions error
```

- **Read the merge state before you watch CI** — at `CONFLICTING` CI never
  fires, and `--watch` returns at once while no check EXISTS. Wait with THIS, not
  a hand-written loop. It re-reads the state every pass and ends non-zero on
  anything but green CI; the merge verdict is still `CLEAN` (next bullet), not
  the watch's exit:

  ```bash
  R=<owner>/<repo>; N=<n>; rc=1; i=0
  while [ $((i+=1)) -le 60 ]; do   # 15 min: past it, no workflow is coming
    m=$(gh pr view $N -R $R --json state,mergeable -q '.state+" "+.mergeable') || m=ERR
    case "$m" in
      'OPEN MERGEABLE') [ "$(gh pr checks $N -R $R --json state -q length 2>/dev/null || echo 0)" -gt 0 ] \
        && { gh pr checks $N -R $R --watch; rc=$?; break; } ;;
      'OPEN CONFLICTING') echo 'CONFLICTING: CI never fires; rebase (above), push, re-run'; break ;;
      'OPEN UNKNOWN'|ERR) ;;   # ERR to the end: a wrong N/R or dead auth
      *) echo "$m: not open"; break ;;
    esac; sleep 15
  done; echo "m=$m rc=$rc"; [ $rc = 0 ]
  ```

  **PUSH FIRST, then run the post-rebase suite while CI drains** — so its ledger
  test runs only after the push: re-run `vp run gen:all-matrices && vp run format`
  (it ends in the ledger normalize) after EVERY rebase; push once
  `git status --porcelain` is empty (`docs/_contents/cli-flag-coverage.md` is outside `_generated/`).
- **A body edit RE-RUNS four required checks** (`on: edited`), green or
  not: merge only at `gh pr view <N> --json mergeStateStatus` = `CLEAN` (else
  "base branch policy prohibits the merge"); `gh run rerun` what it CANCELLED,
  as it blocks even after re-runs pass (#3664).
- **`gh pr merge`'s output is not the verdict — `gh pr view <N> --json state`
  = `MERGED` is**, read in its OWN call before anything presuming the merge (the
  thank-you, the claim release, the pull): from the PR's own worktree
  `--delete-branch` prints `fatal: 'main' is already used by worktree ...` over
  a SUCCESS.
- **A lane that fixes a full-suite flake merges FIRST**, and the others rebase
  onto it. A RED check may be a peer's just-merged content: fetch, rebase,
  re-run.

- **An OUTSIDE reporter's issue is thanked after the RELEASE, not the merge**:
  merge the release PR, confirm the npm version, then comment on the issue in
  English — thanks, the version it shipped in, "feel free to open an issue"
  (go-to-k/cdkd#3624).

### Pull, then rebuild the linked binary

The global `pnpm link --global` points at this repo's `dist/cli.js`, so a build
on updated `main` is all the linked binary needs. MAIN-CHECKOUT (SKILL.md
"Launch mode") — run THIS block, and not the next one:

```bash
git checkout main && git pull origin main    # bring the merges local
pnpm install --frozen-lockfile && vp run build   # a merged dependency bump (#3951)
```

IN-PLACE — run THIS block INSTEAD, never both: `main` is checked out in the main
tree, so `checkout main` fails here, and building THIS tree leaves the user on
the old binary. `MAIN` is derived per block, never borrowed — each fenced block
is its own shell:

```bash
# The main checkout is always the FIRST row of `git worktree list`.
MAIN=$(git worktree list --porcelain | awk 'NR==1{print substr($0,10)}')
git -C "$MAIN" pull origin main
( cd "$MAIN" && pnpm install --frozen-lockfile && vp run build )
```

A dirty shared main tree fails that pull (§7); never restore the offending
path: it is another session's work.

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

IN-PLACE — run THIS block INSTEAD for the launch tree. **It must not remove the
tree it runs in** (a concurrent lane's sibling under `<MAIN_CHECKOUT>` takes the
block above, every `git` line prefixed with `-C <MAIN_CHECKOUT>`, and so is
not in this block's `-D` list). It owes the BRANCH — put back the
one it found, delete the one it made.
`<LAUNCH_BRANCH>` and `<each branch this run created in THIS tree>` are SUBSTITUTION
PLACEHOLDERS, not shell variables (`references/launch-mode.md`):

```bash
git show-ref --verify --quiet refs/heads/<LAUNCH_BRANCH> || echo 'gone -> use the fallback'
DIRTY=$(git status --porcelain)
[ -z "$DIRTY" ] || echo 'dirty -> commit or stash first, then re-run this block'
[ -z "$DIRTY" ] \
  && git switch --no-guess <LAUNCH_BRANCH> \
  && git branch -D <each branch this run created in THIS tree>  # AS-IS: no pull, no rebase, no fast-forward
git branch --show-current      # must print <LAUNCH_BRANCH>
git branch --list '<your prefix>*'             # ...and every branch this run added is gone
```

`--no-guess`: plain `git switch` DWIMs, re-creating the branch from `origin`
and reporting success where the run should fall through to the fallback. The
dirty check runs FIRST and is a TEST,
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
  && git branch -D <each branch this run created in THIS tree>
```

Never pull, fast-forward, rebase or delete `<LAUNCH_BRANCH>`. **AS-IS is the
whole rule: RESTORE, never ADJUST.** **This step runs LAST, not per-lane**:
§10-d branches in this tree.

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
