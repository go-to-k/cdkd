<!-- /work-issues stage file; stage map in ../SKILL.md. A bare §N points into the file holding that section. READ IN FULL at stage entry. -->

## 9. Ship: merge → pull → rebuild → cleanup

The PARENT's serialization point: run your own review round on a merge-ready
lane (`verify.md` §8-i — before EVERY merge, even when the lane's
reviewers passed; #3906). Grant it its turn only once that round AND its
delta reviews are CLEAN, since every fix round voids an integ started beside
them (#5337). One lane at a time: run `/run-integ` and
`gh pr merge` yourself FROM THAT LANE'S WORKTREE — never the lane agent. The
auto-mode classifier can refuse the PARENT's calls too: any refused call goes
to `AskUserQuestion`, never a reworded retry (#4059); only
`/run-integ` step 9's one retry (marker set or ledger push) is exempt.
Ship from a SECOND sibling on the PR's branch while that tree holds a follow-up
(`git -C <MAIN_CHECKOUT> worktree add <MAIN_CHECKOUT>/.claude/worktrees/<name> <branch>`),
running BOTH the integ and the merge there. A fix
round DURING that tree's integ edits a `--detach` sibling, pushes
`HEAD:<branch>` (bash reads `verify.sh` live), and fast-forwards that tree
before the marker, re-running an integ the fix touches (#4561). Never two
lanes' integs or merges at once, nor a merge during another lane's integ: it
can move `main` under that batch (#4864). A turn blocked on a fixture fix
yields to the next merge-ready lane. ANY turn holding HOURS tells the user
unasked its ETA and queue. A subagent running a turn's integs, marker and
ledger has no interim report: a handback ENDS it until a `SendMessage` resumes
it (#5245), so the `.live` Monitor below is the only progress signal. Its brief
(the runner never reads this file) makes marker and ledger due once the last PID
exits, has it run `/run-integ` step 5's block per fixture AS WRITTEN and read
each verdict from that LOG's `verify.sh rc=` line, never a driver or results
file of its own (#5519), wait on ONE command exiting with that PID (never a
per-line Monitor: each line re-ends it, #5413), bans attribution
lines in the ledger commit (#5104), and STOPs on an unreadable state record,
never purging (`/run-integ` step 7). A FAIL names the file EMITTING its message (`grep -rlF` a `${}`-free fragment over `src/`
and the fixture): the PR is blamed when that file is in its diff, cleared when
the grep hits only outside it, else UNATTRIBUTED (#4981). Size it for ONE
context (§8-d probe alone, then fixture batches), each run's fixture,
`pid=<N>` (bare digits, #5248), log, state
prefix appended as a line to `<scratch>/integ-<PR>.live` at launch. BEFORE
dispatching, the PARENT runs `/run-integ` step 4's live-lock check and lists
open PRs touching each fixture: a held one gets a lock watcher, not a runner
(#5190). The PARENT Monitors those PIDs (`timeout_ms` 1800000,
re-armed on expiry; in `bash -c`: zsh won't split `$pids`),
read only from each line's `pid=` field (`grep -oE 'pid=[0-9]+'`; a bare digit
grep matches a `mktemp` path's zeroes, and `kill -0 0000` always succeeds),
`SendMessage`s the runner as each exits, and alarms when no PID has run for 15
min unreported (#5135).
A stand-down lands on the NEXT tool round: `TaskStop` it once its PIDs exit.

- The `integ-destroy` marker is read from the tree the command runs in, so a
  merge from the main tree consults the WRONG store (#2363); read
  it by hand with `mise exec -- markgate`, as PATH's may predate `hash: diff`
  (a sibling `mise trust`s first: an untrusted `.mise.toml` fails it). Its
  `hash: diff` covers this branch's delta against `origin/main`, so run the
  integ AFTER the flatten/rebase below (`verify.md` §8-b says which
  rebases stale it). While a scoped file this branch changes is busy on `main`
  (#4183), run the set as ONE parallel batch (building fixtures per
  `/run-integ` step 1), then set the marker, record, push and merge without
  starting other work between them (the Merge bullets below still apply).
- **A `SendMessage` answering "queued" (or `Resuming agent`) is NOT delivery** —
  a lane stopped at merge-ready drains no queue: re-send, confirm in the TREE.

### Flatten, then rebase

**FLATTEN BEFORE YOU REBASE — the default step, not a remedy.** The integ ledger
gains a row at the same place on every lane that ran one, so a commit-by-commit
rebase re-conflicts once per commit; the
repo squash-merges, so flattening loses nothing. Both rewrite a PUSHED branch,
so FIRST push plainly until `git rev-list origin/<branch>..HEAD` is empty (a
denied plain push is re-authorized, never routed round through the arm). Then,
when the harness denies the `git reset`, the rebase or the `--force-with-lease`
push, take §7's MERGE ARM from `origin/<branch>` (#4327) in
`<LANE_TREE>` by literal path:
`checkout -B <branch> origin/<branch>`, `merge origin/main`, re-run the
generators and `vp run integ-ledger-normalize` (`merge=union` hides the ledger
conflict locally), commit what changed, push plainly. When the arm's checkout
or merge is denied TOO, `git merge --abort` any half-done merge and ask the
maintainer (`AskUserQuestion`) to authorize the flatten. With no denial, or
on that yes:

```bash
git reset --soft "$(git merge-base origin/main HEAD)"   # one commit
# From another tree, `.claude/hooks/bughunt-clean-gate.sh` refuses `-C "$VAR"`
# on a `git commit` / `gh pr create|merge` segment: use the LITERAL path, in this
# line's `$(git -C <path> merge-base ...)` too.
# Never the origin/main TIP: --soft onto it stages a revert of main's newer files.
# Message to a FILE named per BRANCH, never -m: inside -m "..." a backtick RUNS.
# DERIVE, WRITE and COMMIT in ONE call: shell state dies between calls.
MSGREF=$(git branch --show-current | tr / -); MSGREF=${MSGREF:-$$}   # empty when detached
MSGFILE="${TMPDIR:-/tmp}/cdkd-squash-${MSGREF}.txt"
cat > "$MSGFILE" <<'EOF'
<the squashed message>
EOF
git commit -F "$MSGFILE"
git show --stat --format= HEAD   # lane paths ONLY, else it reverts peers: redo via reflog
git rebase origin/main   # its OWN call, then `git status`: at most one conflict,
                         # and a regen / `commit --amend` chained after a STOPPED
                         # rebase amends the detached onto-commit (#3671)
```

- **A GENERATED file is REGENERATED, never hand-merged nor trusted when git
  merged it CLEANLY** (`handled-property-wiring.json` came out inconsistent):
  take upstream's copy whole — it is the generator's BASELINE — re-run the
  generator, commit ITS output before the push (#4460). Take it with
  `git show origin/main:<file> > <file>`: mid-rebase `checkout -- <file>` hits
  `dirty-path-restore-gate` on the staged copy.
- **The integ ledger is the exception**: its rows record real-AWS RUNS, so
  upstream-whole drops this lane's row. GitHub ignores its `merge=union`, so
  each `main` ledger row re-CONFLICTS the PR: rebase locally, normalize (Merge).
  Once every other pre-merge step is done and the post-rebase push leaves
  `git status --porcelain` empty, arm `gh pr merge <n> --squash --delete-branch
  --auto` so it lands before the next peer merge (#4966). It merges whatever head
  goes green, so `--disable-auto` before any push or body edit; the turn holds
  to `MERGED`.

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
  test runs only after the push: re-run `vp install --frozen-lockfile` (on a
  stale install gen exits 1), then `vp run gen:all-matrices && vp run format`
  (it ends in the ledger normalize) after EVERY rebase; push once
  `git status --porcelain` is empty (`docs/cli-flag-coverage.md` is outside `_generated/`).
- **A body edit RE-RUNS four required checks** (`on: edited`), green or
  not: merge only at `gh pr view <N> --json mergeStateStatus` = `CLEAN` (else
  "base branch policy prohibits the merge"); `gh run rerun` what it CANCELLED,
  as it blocks even after re-runs pass (#3664).
- **`gh pr merge`'s output is not the verdict — `gh pr view <N> --json state`
  = `MERGED` is**, read in its OWN call before anything presuming the merge:
  from the PR's own worktree
  `--delete-branch` prints `fatal: 'main' is already used by worktree ...` over
  a SUCCESS.
- **A lane that fixes a full-suite flake merges FIRST**, and the others rebase
  onto it. A RED check may be a peer's just-merged content: fetch, rebase,
  re-run.

- **An OUTSIDE reporter's issue is thanked after the RELEASE, not the merge**:
  merge the release PR, confirm the npm version, then comment on the issue in
  English — thanks, the version it shipped in, "feel free to open an issue"
  (#3624).

### Pull, then rebuild the linked binary

The linked binary is the main checkout's `dist/cli.js`. MAIN-CHECKOUT (SKILL.md
"Launch mode") — run THIS block, and not the next one:

```bash
git checkout main && git pull origin main    # bring the merges local
vp install --frozen-lockfile && vp run build   # a merged dependency bump (#3951)
```

IN-PLACE — run THIS block INSTEAD, never both: `checkout main` fails here, and
building THIS tree leaves the user on the old binary. `MAIN` is derived per
block (each fenced block is its own shell) from `git worktree list`'s FIRST row:

```bash
MAIN=$(git worktree list --porcelain | awk 'NR==1{print substr($0,10)}')
git -C "$MAIN" pull origin main
( cd "$MAIN" && vp install --frozen-lockfile && vp run build )
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
git worktree remove .claude/worktrees/<branch>  # --force if it refuses on artifacts
git worktree prune
git branch -D <branch>  # -D, not -d (squash); PR MERGED first
git worktree list  # every worktree THIS run added is gone
git branch --list '<your prefix>*'  # ...and so is every branch it added
```

IN-PLACE — run THIS block INSTEAD for the launch tree. **It must not remove the
tree it runs in** (a concurrent lane's sibling under `<MAIN_CHECKOUT>` takes the
block above, every `git` line prefixed with `-C <MAIN_CHECKOUT>`, and so is
not in this block's `-D` list).
`<LAUNCH_BRANCH>` and `<each branch this run created in THIS tree>` are
PLACEHOLDERS, not shell variables (`<LAUNCH_BRANCH>`: `launch-mode.md`'s probe):

```bash
git show-ref --verify --quiet refs/heads/<LAUNCH_BRANCH> || echo 'gone -> use the fallback'
DIRTY=$(git status --porcelain)
[ -z "$DIRTY" ] || echo 'dirty -> commit or stash first, then re-run this block'
[ -z "$DIRTY" ] \
  && git switch --no-guess <LAUNCH_BRANCH> \
  && git branch -D <each branch this run created in THIS tree>  # AS-IS: no pull, no rebase, no fast-forward
git branch --show-current  # must print <LAUNCH_BRANCH>
git branch --list '<your prefix>*'  # ...and every branch this run added is gone
```

`--no-guess`: plain `git switch` re-creates a gone branch from `origin` and
reports success instead of falling through. The dirty check is a TEST, since
`--porcelain` exits 0 either way and `git switch` carries uncommitted changes
ACROSS; unchained, a FAILED switch still runs the `-D`. The delete is PLURAL
(§10-d adds a retro branch, so this runs LAST, not per-lane) and
unconditional: confirm each PR reads `MERGED`.

Fallback — INSTEAD of the block above, ONLY when `LAUNCH_BRANCH` was empty at
probe time (launched detached) or is now gone. Keep it chained: after a failed
`fetch`, `switch --detach` lands on a STALE `origin/main`.

```bash
git fetch origin \
  && git switch --detach origin/main \
  && git branch -D <each branch this run created in THIS tree>
```

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
