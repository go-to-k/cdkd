#!/usr/bin/env bash
# branch-gate.sh
#
# PreToolUse hook. Blocks `git commit` and `git push` when the working
# tree the command will actually act on is on `main` / `master`. All
# changes to cdkd must land via PR from a feature branch — direct
# commits/pushes to main are not allowed.
#
# WHY the cwd-aware resolution matters: this repo is regularly worked
# in via `git worktree`. The previous implementation derived the repo
# root from `BASH_SOURCE` (the hook script's location), which in a
# worktree-copy invocation pointed at the worktree itself — so the
# hook checked the worktree's branch (a feature branch) and allowed
# the commit, even when the user's actual command did
# `cd /path/to/parent && git commit` and the commit landed on the
# parent worktree's `main`. Real-world incident: 2026-05-04 lambda fix
# session, see memory feedback_git_use_C_in_worktree.md.
#
# Resolution order for "where will the git command actually run":
#   1. Explicit `git -C <path> commit/push` — last `-C` wins.
#   2. Leading `cd <path> && ...` — the cd target.
#   3. The hook input's `cwd` field (the Bash tool's persisted cwd).
#   4. The hook process's own $PWD (fallback, almost never reached).

# Shared command-position matcher (issue #1455): catches the guarded verb
# after ANY chained command (`git push && gh pr create`), not just after an
# optional leading `cd`. See .claude/hooks/lib/command-match.sh.
# shellcheck source=lib/command-match.sh
__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked as
# `bash verify-pr-gate.sh` from inside the hooks dir), which would look for
# `<script-name>/lib/...`. Fall back to the cwd in that case.
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."
if ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null \
  || ! declare -F cmd_matches_verb >/dev/null \
  || ! declare -F gate_matches >/dev/null \
  || ! declare -F gate_target_dir_strict >/dev/null \
  || ! declare -F gate_refuse_unresolved_target >/dev/null \
  || ! declare -F cmd_last_cd_target >/dev/null \
  || ! declare -F strip_noncommand_spans >/dev/null; then
  # FAIL CLOSED. Without the helper `cmd_matches_verb` is undefined, the
  # `if ! cmd_matches_verb ...` guard below sees exit 127 (truthy for `!`),
  # and the hook would `exit 0` -- silently disabling the gate, which is the
  # exact failure mode this file exists to prevent. Refuse instead.
  echo "Blocked: .claude/hooks/lib/command-match.sh is missing or unloadable," >&2
  echo "so this gate cannot evaluate the command. Restore the file; do not" >&2
  echo "work around the gate." >&2
  exit 2
fi

set -u

# Read the entire stdin payload once; we need both .tool_input.command
# and .cwd from it. Reading via two separate jq invocations would
# consume stdin twice and the second read would see nothing.

# STATED FAIL-OPENS AT THE PAYLOAD LEVEL, here rather than at the enumeration far
# below -- that one lists the readings that reach ITS line, and these never get
# that far, so the enumeration reads as a complete list of exit-0 paths and is
# not one. Both measured by driving this hook with a `git commit -m x` payload
# whose cwd is an opted-in repo on `main`, which scores rc=2 normally:
#
#   `jq` absent from PATH entirely  -> rc=0. `$cmd` is empty, so the verb match
#     below finds nothing. (Easy to mis-measure: a dev Mac carries `jq` at BOTH
#     /opt/homebrew/bin and /usr/bin, so dropping only the first proves nothing.
#     Measured under `env -i PATH=<dir with bash/git/cat/dirname only>`.)
#   a malformed or truncated JSON payload -> rc=0, same way.
#
# Deliberate and unchanged. A gate that could not read its own input has nothing
# to say about a command it never saw, and the alternative -- refusing every
# Bash call on a box without `jq` -- is worse than the hole.
#
# A THIRD CANDIDATE WAS RAISED IN REVIEW AND IS NOT ONE IN THIS REPO: a
# `git -C "$W" commit` whose target is an unexpanded variable. `gate_target_dir_strict`
# REFUSES it (rc=2) rather than falling back, which is exactly what #2027 added.
# Measured in all three shapes -- cwd inside the gated repo, cwd drifted out of
# it, and an explicit `cd <non-gated>` before the verb -- rc=2 every time. The
# two sibling repos still take the loose resolver and DO exit 0 on the last two,
# which is the difference worth knowing when this comment is read side by side
# with theirs.
input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate git commit / git push — any other command passes through.
# The regex matches `git` + optional global flags (e.g. `-C <path>`,
# `-c <key>=<value>`, `--no-pager`, `--git-dir=<path>`) + the literal
# subcommand `commit` or `push`, anchored so that `commit` / `push`
# must appear in the GIT SUBCOMMAND POSITION — not as a substring of
# a refspec (`<sha>^{commit}`), a pathspec (`-- '*push*.md'`), or a
# `--grep=push` query.
#
# Anchors:
#   `^[[:space:]]*(cd[[:space:]]+...&&[[:space:]]*)?git`
# Matching goes through the SHARED command-position matcher
# (.claude/hooks/lib/command-match.sh, issue #1455): heredoc bodies and
# quoted spans are stripped, then the verb is matched at line start OR
# after a `&&` / `||` / `;` / `|` operator. That catches chained
# invocations the old line-start anchor missed, while a quoted mention
# still does not fire (it is removed rather than dodged by position).
if ! gate_matches "$cmd" "$GATE_RE_GIT_COMMIT_OR_PUSH"; then
  exit 0
fi

# Start from the Bash session's persisted cwd; fall back to the hook
# process's own cwd if the payload did not include a `cwd` field.
# Where the git/gh command will actually RUN.
#
# This calls the SHARED resolver in lib/command-match.sh, replacing the
# hand-rolled `-C` scan this hook used to carry. That copy captured the raw
# token with no guard for an unexpanded `$VAR`, so the standard worktree
# spelling `git -C "$W" ...` resolved to the literal `<cwd>/$W`, the repo
# probe below failed, and the gate exited 0 over a tree it never looked at
# (go-to-k/cdkd#2027). The strict resolver refuses instead of guessing.
__verb_ere="$GATE_RE_GIT_COMMIT_OR_PUSH"
if ! target_dir=$(gate_target_dir_strict "$cmd" "${hook_cwd:-$PWD}" "$__verb_ere"); then
  gate_refuse_unresolved_target "branch-gate" "${hook_cwd:-$PWD}"
fi

# Repo opt-in scope (issue #1259): this gate protects repos that follow
# the feature-branch + PR + markgate convention. A session rooted in
# such a repo can still run git against OTHER repos (a personal blog, a
# scratch clone) where committing straight to main is the normal
# workflow; the gate must not fire there. Opt-in signal: a
# `.markgate.yml` at the resolved target repo's top level. Repos
# without it pass through untouched.
target_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || echo "")
if [[ -z "$target_top" || ! -f "$target_top/.markgate.yml" ]]; then
  exit 0
fi

# Read the branch from the resolved target dir. `-C` lets git operate on a
# directory that isn't our cwd. An EMPTY answer is not one condition -- see the
# `if [ -z "$branch" ]` arm below, which is where that used to be got wrong.
branch=$(git -C "$target_dir" symbolic-ref --short HEAD 2>/dev/null || echo "")

# The MAIN-vs-LINKED distinction, in the shape `main-tree-branch-gate.sh`
# already uses: the main checkout is whatever `git worktree list --porcelain`
# lists FIRST. Reused rather than re-invented, per go-to-k/cdkd#2402 -- but two
# parts of that shape are deliberately NOT copied here, because each was
# measured to buy nothing at this call site:
#
#   NO MEMO. That gate asks the question once per matched SEGMENT and caches the
#   last answer in a pair of globals. This gate asks at most once per command,
#   so a memo would cache nothing.
#
#   NO `canonicalize`. That gate compares its RAW `<dir>` argument -- a payload
#   cwd, which may still carry a symlink -- against the porcelain path, so it
#   must resolve both. This gate compares `$target_top`, which git has ALREADY
#   resolved. Probed against git 2.x on macOS, where `/var` is a symlink to
#   `/private/var`, with `<dir>` also reached through a symlinked parent and
#   through a subdir under one -- `rev-parse --show-toplevel` returned the fully
#   resolved real path in all four shapes, byte-identical to `worktree list
#   --porcelain`'s first entry. A local `canonicalize` copy was written here
#   first and NO mutation could kill it, which is what sent the question to a
#   probe. If a future git ever stopped resolving `--show-toplevel`, this
#   compare would fail OPEN, and `branch-gate.test.sh` is what goes red -- but
#   NOT the five cases this sentence used to name. That count was stale in two
#   directions at once: the suite has grown since, and the number was never a
#   constant to begin with. Stood in for by swapping the compare to
#   `$target_dir` and re-running: 22 of 42 rows red on this macOS fixture root,
#   3 of 42 on a non-symlinked one, for the reason the arm below spells out.
#   The only fixed number in the pair is the SCOPED one that arm already
#   quotes, so that is where a count is given and this is not.
if [ -z "$branch" ]; then
  # `symbolic-ref --short HEAD` prints NOTHING in two situations that are not
  # the same thing, and the comment that used to stand here asserted only the
  # harmless one ("if the dir doesn't exist or isn't inside a git repo ... we
  # can't gate what we can't see"):
  #
  #   (a) there is no repo to read       -> genuinely invisible; pass through.
  #   (b) a real repo with a DETACHED HEAD -> the tree has LEFT `main`, which is
  #       exactly the state this gate exists to catch, wearing a spelling it
  #       could not see because it recognised the state only by branch NAME.
  #
  # (b) is reachable from the documented flow. `main-tree-branch-gate.sh`
  # deliberately passes `git checkout <sha>` in the main checkout (its own
  # `--detach` note carries the measurement, and keeps the verdict); the tree
  # detaches, and this gate then waved a commit straight into the SHARED main
  # checkout. Measured on a scratch opted-in repo before this arm existed,
  # driving this hook with a `git commit -m x` payload: rc=2 on `main`, rc=0
  # once detached. Two gates, a hole neither has alone (go-to-k/cdkd#2402).
  #
  # THE DISCRIMINATOR IS ALREADY IN HAND. `$target_top` is `rev-parse
  # --show-toplevel` from this same dir, and it is non-empty here because the
  # opt-in check above returned early otherwise. A non-empty toplevel IS a real
  # repo with a work tree, so an empty branch beside it can only mean a detached
  # HEAD; a second `rev-parse --git-dir` probe would fork again to re-learn what
  # `$target_top` already said.
  #
  # IT COMPARES TOPLEVELS, NOT THE RAW DIR, and that single choice removes TWO
  # independent failures. `main_tree_of` in the sibling gate compares its
  # `<dir>` argument, which is the payload cwd, so (i) a cwd one level down
  # (`cd <repo>/src && ...`) is not equal to the checkout root, and (ii) the cwd
  # still carries whatever symlink the caller typed, while the porcelain path
  # does not. `$target_top` has neither problem: git resolves both out of
  # `--show-toplevel`.
  #
  # THE FIRST VERSION OF THIS SENTENCE OVERCLAIMED, and the correction is the
  # reason the symlinked-cwd row below exists. Swapping the compare to
  # `$target_dir` does turn all five pre-existing block rows red -- but only
  # because macOS's `mktemp -d` hands out a `/var` path that git reports as
  # `/private/var`, so the ENTIRE fixture is symlinked and reason (ii) fires on
  # every row for free. Re-measured with the same fixture built on a
  # NON-symlinked root -- which is what a Linux runner gets, `/tmp` being a real
  # directory there -- that mutation kills exactly ONE of the five, the subdir
  # row, for reason (i). So wherever this suite runs on Linux, reason (ii) had no
  # coverage at all. That is cdk-local and cdk-real-drift, which run it from
  # `ci.yml` on `ubuntu-latest`; cdkd pins its own `hooks.yml` to `macos-latest`,
  # because that is the only runner image carrying the bash 3.2 this suite also
  # exists to exercise -- so there the accident holds and the gap does not open.
  # `branch-gate.test.sh` now carries a row whose payload cwd is an explicit
  # `ln -s` to the main checkout, and that row dies under the mutation on BOTH
  # roots: non-symlinked 1/5 -> 2/6, symlinked 5/5 -> 6/6.
  #
  # BLOCKED ONLY IN THE MAIN CHECKOUT. A detached HEAD in a LINKED worktree is
  # the remedy this repo's own Stop hook prints -- `stop-unmerged-lane-warn.sh`
  # tells a session that must not remove its worktree to run
  # `git switch --detach origin/main`, "because a worktree with no current
  # branch is not a lane". Blocking that would refuse a documented instruction.
  #
  # `substr($0, 10)` rather than `$2`, for the reason the sibling gate records:
  # awk splits on whitespace, so a checkout path containing a SPACE is truncated
  # at it and the compare below then never matches -- the gate standing down
  # over a main checkout it had mis-read. Fenced by the spaced-path case in
  # `branch-gate.test.sh`.
  #
  # STATED BOUND -- a NEWLINE in the path still fails open, and no field
  # expression fixes it: awk's records ARE lines, so an embedded newline ends the
  # record early whatever reads it. Measured on git 2.53, same fixture twice: a
  # detached MAIN checkout at `<tmp>/nl<LF>repo` scores rc=0, and rc=2 with the
  # newline removed. `worktree list --porcelain -z` DOES read it correctly
  # (checked under bash 3.2 and 5.3 on git 2.53, and it still names the MAIN
  # checkout when run from a linked worktree), and is deliberately not taken.
  # `-z` is a later addition to `worktree list` than `--porcelain` itself, so it
  # would need this awk kept behind it as a fallback for older git anyway --
  # measured: an unsupported flag makes `worktree list` print NOTHING, so a
  # `-z`-only read fails OPEN there, which is the same bug class this arm exists
  # to close. And once `-z` runs first, the awk stops executing on every git new
  # enough to have it, retiring the spaced-path fence -- trading a fence over a
  # shape that has actually been produced here for one over a shape nobody has.
  # Only this arm is affected; the branch-NAME arm parses no paths.
  main_checkout=$(git -C "$target_dir" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0, 10); exit}')
  if [ "$target_top" = "$main_checkout" ]; then
    # WHICH REMEDY TO PRINT. A refusal that names a command git itself rejects is
    # worse than no refusal at all: the block is correct and the reader still has
    # no way out. A conflicted rebase is one of the ways a MAIN checkout reaches a
    # detached HEAD, and `git pull` on `main` in the main checkout is this repo's
    # own mandated post-merge sync, so the route is a documented one rather than a
    # contrived one. Measured on git 2.53, HEAD detached in each case:
    #
    #   rebase / rebase -i / rebase --apply  ->  fatal: cannot switch branch while rebasing
    #   am                                   ->  fatal: cannot switch branch in the middle of an am session
    #   cherry-pick                          ->  fatal: cannot switch branch while cherry-picking
    #   revert                               ->  fatal: cannot switch branch while reverting
    #   merge                                ->  fatal: cannot switch branch while merging
    #   bisect                               ->  warning, then Switched -- but BISECT_LOG survives
    #   nothing in progress                  ->  Switched to branch 'main'
    #
    # Five of those make `switch main` a dead end and the sixth makes it
    # incomplete, so the operation is detected and the remedy follows it.
    #
    # THE GIT DIR IS RESOLVED, NOT ASSUMED. `<target_dir>/.git` is wrong whenever
    # `$target_dir` is a SUBDIRECTORY of the checkout, which is a shape this arm
    # already has rows for, and this arm is reachable by `-C` from anywhere.
    #
    # `rebase-apply` is shared by `git am` and `git rebase --apply`; the
    # `applying` sentinel inside that directory is what separates them, and it is
    # load-bearing IN THE DIRECTION THAT FAILS SILENTLY. Both crossings measured
    # on git 2.53, from a MAIN checkout detached mid-operation:
    #
    #   `git rebase --abort` inside an AM session -> rc=128, `fatal: It looks
    #     like 'git am' is in progress. Cannot rebase.`, HEAD unchanged. LOUD --
    #     the reader is told the remedy was the wrong one.
    #   `git am --abort` inside a `rebase --apply` session -> rc=0, NO output,
    #     HEAD still DETACHED -- where `git rebase --abort` from that same state
    #     lands on `main`. SILENT: exit 0 reads as "done", and the one thing the
    #     remedy existed to fix is still true.
    #
    # An earlier version of this comment cited "No rebase in progress?" as git's
    # answer to the FIRST crossing. It is not: `fatal: no rebase in progress` is
    # what git says when NOTHING is in progress, a different condition -- and the
    # quiet crossing is the one worth naming anyway, since a loud one cannot
    # mislead anybody.
    #
    # STATED BOUND -- a `rebase-apply/` holding neither `applying` nor
    # `head-name` reads as a rebase here, and the printed `rebase --abort` then
    # exits 1 with `warning: could not read '.git/rebase-apply/head-name'`.
    # `git status` calls that same state "You are currently rebasing.", so the
    # hook agrees with git; and no git command produces it, since both rebase
    # backends write `head-name` at start and `git am` writes `applying`. A bound
    # rather than a bug. Measured on git 2.53 by creating the directory by hand.
    # (`git rebase --apply` also writes a `rebasing` file, and this code
    # deliberately does not read it. `rebase-apply` WITHOUT `applying` is a
    # rebase, so the negative read already answers the question; a positive read
    # would add a third, ambiguous state whose only member is exactly the
    # hand-made directory above. The comment used to name both files as the
    # discriminator, which overstated what the code looks at.)
    #
    # STATED BOUND -- A `$` IN THE CHECKOUT PATH. Every remedy this gate prints
    # wraps the path in DOUBLE quotes, which is how the sibling gates spell it
    # too, so a literal `$` in the path RE-EXPANDS in whatever shell the reader
    # pastes it into. Measured on git 2.53 by rebuilding `branch-gate.test.sh`'s
    # fixture under a root containing `$`: the printed `rebase --abort` exits 1
    # with `<rest-of-path>: unbound variable` under `set -u`, and in a shell
    # without `set -u` it would expand to nothing and quietly act on the WRONG
    # directory -- the silent half being the worse one.
    #
    # Left as a bound rather than fixed, and the reasons are worth writing down
    # because "the quoting is just a convention" is how it stayed implied. (1)
    # It is not local to this arm: the branch-NAME arm's `switch -c fix/xxx`
    # line is printed the same way, so single-quoting here alone would leave the
    # gate inconsistent with itself and with the other gates. (2) The same
    # fixture also reddens rows whose PAYLOAD carries a `-C` target, so the
    # gate's own path handling is already affected upstream of any remedy -- a
    # `$` path is outside what these gates read correctly at all, not merely
    # outside what they print correctly. Fixing the print alone would buy the
    # appearance of a fix.
    #
    # The order below follows git's own status precedence: rebase, then
    # cherry-pick / revert, then merge, then bisect.
    git_dir=$(git -C "$target_dir" rev-parse --absolute-git-dir 2>/dev/null || echo "")
    inflight=""
    if [ -n "$git_dir" ]; then
      if [ -d "$git_dir/rebase-merge" ]; then
        inflight="rebase"
      elif [ -d "$git_dir/rebase-apply" ]; then
        if [ -f "$git_dir/rebase-apply/applying" ]; then
          inflight="am"
        else
          inflight="rebase"
        fi
      elif [ -f "$git_dir/CHERRY_PICK_HEAD" ]; then
        inflight="cherry-pick"
      elif [ -f "$git_dir/REVERT_HEAD" ]; then
        inflight="revert"
      elif [ -f "$git_dir/MERGE_HEAD" ]; then
        inflight="merge"
      elif [ -f "$git_dir/BISECT_LOG" ]; then
        inflight="bisect"
      fi
    fi

    # WHERE THE REMEDY LEAVES HEAD -- the observable the previous round did not
    # take. That round verified every printed remedy EXITS 0, which all nine do,
    # and then promised `--abort` would "re-attach". Measured on git 2.53 by
    # running each printed remedy verbatim against the fixture and reading HEAD
    # afterwards:
    #
    #   rebase --abort, rebase started FROM a branch      -> branch main
    #   rebase --abort, rebase started ALREADY detached   -> DETACHED
    #   am / cherry-pick / revert / merge --abort         -> DETACHED (all four)
    #   bisect reset, bisect started FROM a branch        -> branch main
    #   bisect reset, bisect started ALREADY detached     -> DETACHED
    #
    # `am` / `cherry-pick` / `revert` / `merge` never detach HEAD themselves, so
    # this arm is reachable for them ONLY from an already-detached tree, and
    # `--abort` restores exactly that pre-op state: still detached. The user runs
    # the remedy, reads exit 0 as success, and the next gated command blocks
    # again with `in progress : nothing` -- the same dead end this arm exists to
    # remove, one layer down. So the promise is made conditional on what results.
    #
    # ONE SENTENCE COVERS BOTH ENDINGS, because the outcome is a property of the
    # SESSION rather than of which ending is picked. Measured the same way: a
    # completed `rebase --continue` re-attaches only when the rebase started from
    # a branch, and `am` / `cherry-pick` / `revert` / `merge --continue` all
    # leave HEAD detached.
    #
    # THE DISCRIMINATOR IS GIT'S OWN `head-name`, written by both rebase backends
    # into `rebase-merge/` or `rebase-apply/`: `refs/heads/<branch>` when the
    # rebase started from that branch, the literal string `detached HEAD` when it
    # did not. `git am` writes no `head-name` at all, which is consistent with it
    # never re-attaching. Anything not matching `refs/heads/<name>` -- absent,
    # `detached HEAD`, empty -- is read as "no branch to return to", the
    # conservative direction: it under-promises instead of repeating the
    # overclaim.
    #
    # BISECT HAS THE SAME TWO POLARITIES AND ITS OWN DISCRIMINATOR, and the
    # sentence below it used to carry was the SAME defect one arm over: it said
    # the bisect "is what detached HEAD here" and that `bisect reset` "restores
    # the branch you started from". Both are false of a bisect begun in a tree
    # that was ALREADY detached -- and `main-tree-branch-gate.sh` passes
    # `git checkout <sha>` in the main checkout, so that is one allowed command
    # away. Measured on git 2.53, same fixture both ways:
    #
    #   started FROM a branch   BISECT_START = main    reset -> branch main
    #   started DETACHED        BISECT_START = <sha>   reset -> rc=0, STILL DETACHED
    #
    # `git bisect start` records what it must return to in `.git/BISECT_START`:
    # the BRANCH NAME when it began on a branch, a raw SHA when it began
    # detached. That file is to bisect exactly what `head-name` is to rebase.
    #
    # ASKED WITH `show-ref`, NOT WITH A 40-HEX PATTERN, because `git bisect
    # reset` ends in `git checkout "$(cat BISECT_START)"` and `show-ref
    # --verify refs/heads/<x>` is the same question that checkout resolves
    # against. Three consequences, all measured on git 2.53: a branch whose NAME
    # happens to be 40 hex characters is answered "re-attaches", and checkout
    # agrees, where a pattern would have called it a sha; an EMPTY or missing
    # `BISECT_START` is answered "no branch", and reset does leave HEAD
    # detached; and a start branch that no longer exists is answered "no
    # branch", where reset fails loudly (`fatal: invalid reference`) rather than
    # re-attaching. That last state is not reachable by ordinary commands --
    # `git branch -D` refuses with `cannot delete branch 'x' used by worktree`
    # while the bisect holds it -- and needs a low-level `update-ref -d` to
    # produce, so it is a bound rather than a case.
    reattach_to=""
    if [ "$inflight" = "rebase" ] && [ -n "$git_dir" ]; then
      __head_name=""
      if [ -f "$git_dir/rebase-merge/head-name" ]; then
        __head_name=$(cat "$git_dir/rebase-merge/head-name" 2>/dev/null || echo "")
      elif [ -f "$git_dir/rebase-apply/head-name" ]; then
        __head_name=$(cat "$git_dir/rebase-apply/head-name" 2>/dev/null || echo "")
      fi
      case "$__head_name" in
        refs/heads/?*) reattach_to="${__head_name#refs/heads/}" ;;
      esac
    elif [ "$inflight" = "bisect" ] && [ -n "$git_dir" ]; then
      __bisect_start=""
      if [ -f "$git_dir/BISECT_START" ]; then
        __bisect_start=$(cat "$git_dir/BISECT_START" 2>/dev/null || echo "")
      fi
      if [ -n "$__bisect_start" ] &&
        git -C "$target_dir" show-ref --verify --quiet "refs/heads/$__bisect_start" 2>/dev/null; then
        reattach_to="$__bisect_start"
      fi
    fi
    echo "Blocked by branch-gate: target git working tree has a DETACHED HEAD in the MAIN checkout." >&2
    echo "  resolved target dir: $target_dir" >&2
    echo "  main checkout      : $main_checkout" >&2
    echo "  HEAD               : $(git -C "$target_dir" rev-parse --short HEAD 2>/dev/null || echo '?')" >&2
    echo "  in progress        : ${inflight:-nothing}" >&2
    echo "  command: $cmd" >&2
    echo "A detached HEAD is not a feature branch, and this is the SHARED main checkout," >&2
    echo "so a commit here puts off-branch work in the tree every other lane reads." >&2
    if [ "$inflight" = "bisect" ]; then
      echo "A 'git bisect' is IN PROGRESS, and 'switch main' would leave it running --" >&2
      echo "git switches with a warning and the bisect survives. End it instead:" >&2
      echo "  git -C \"$main_checkout\" bisect reset" >&2
      if [ -n "$reattach_to" ]; then
        echo "That restores the branch you started from, '$reattach_to'." >&2
      else
        echo "That does NOT re-attach HEAD: this bisect started from a tree that was" >&2
        echo "ALREADY detached, so 'bisect reset' returns to that same detached commit." >&2
        echo "Re-attach afterwards:" >&2
        echo "  git -C \"$main_checkout\" switch main" >&2
      fi
    elif [ -n "$inflight" ]; then
      echo "A '$inflight' is IN PROGRESS, so 'switch main' is not available here -- git" >&2
      echo "refuses it outright. Finish or abandon the operation first:" >&2
      echo "  git -C \"$main_checkout\" $inflight --continue   # after resolving the conflict" >&2
      echo "  git -C \"$main_checkout\" $inflight --abort      # to abandon it" >&2
      if [ -n "$reattach_to" ]; then
        echo "Either ending re-attaches HEAD to '$reattach_to' (the branch the rebase started from)." >&2
      else
        echo "NEITHER ending re-attaches HEAD: git has no branch recorded to return to, so" >&2
        echo "both leave this checkout DETACHED. Re-attach afterwards:" >&2
        echo "  git -C \"$main_checkout\" switch main" >&2
      fi
    else
      echo "Re-attach first: git -C \"$main_checkout\" switch main" >&2
    fi
    echo "Then do the work in its own worktree: git worktree add <path> -b fix/xxx origin/main" >&2
    echo "A detached HEAD in a LINKED worktree is NOT blocked -- that is the documented" >&2
    echo "way to clear a lane." >&2
    exit 2
  fi
  # FAIL-OPEN, deliberate and stated. FOUR readings reach this line -- and this
  # list is NOT every exit-0 path in the hook, only every path to THIS one; the
  # payload-level ones are stated at the `jq` read near the top. The
  # compare above sends all four here without needing a guard of their own,
  # since `$target_top` is non-empty and so can equal none of the answers below:
  #   - `git worktree list` gave nothing (not a repo we can read) -- we do not
  #     gate what we cannot see;
  #   - the awk found no `worktree ` line at all -- same reading;
  #   - the detached tree is a LINKED worktree, the sanctioned lane-clearing
  #     state named above;
  #   - the detached tree is a SUBMODULE. This one is not an empty answer, which
  #     is why it went unenumerated: `worktree list --porcelain` inside a
  #     submodule reports the GITDIR (`<super>/.git/modules/<name>`) where
  #     `--show-toplevel` reports the work tree (`<super>/<name>`), so the two
  #     never match. Measured on git 2.53 with a `.markgate.yml` planted at the
  #     submodule root to clear the opt-in: rc=0. The outcome is the one we want
  #     -- a submodule left detached is what `git submodule update` does, and it
  #     is nobody's shared main checkout -- but it arrives by a different route
  #     than the other three.
  exit 0
fi

case "$branch" in
  main|master)
    echo "Blocked by branch-gate: target git working tree is on branch '$branch'." >&2
    echo "  resolved target dir: $target_dir" >&2
    echo "  command: $cmd" >&2
    echo "Create a feature branch and open a PR instead (e.g. 'git -C \"$target_dir\" switch -c fix/xxx')." >&2
    echo "Direct commits/pushes to main are not allowed in this repo." >&2
    exit 2
    ;;
esac

exit 0
