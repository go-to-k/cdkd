#!/usr/bin/env bash
# main-tree-branch-gate.sh
#
# PreToolUse hook. Blocks branch-switching commands in the MAIN
# worktree (= the cdkd repo top-level dir) so multiple agents
# working in parallel don't race / clobber each other on the shared
# main tree. The main worktree must stay on `main` / `master`;
# feature branches go to `.claude/worktrees/<branch>/`.
#
# WHY this gate: the main worktree at `/Users/goto/pc/github/cdkd`
# is a SHARED RESOURCE across parallel agents. When agent A is
# mid-flight on a feature branch and agent B does
# `git switch <some-other-feature>`, A's uncommitted work either
# gets clobbered (if no stash) or gets silently stashed by B (if
# B was being defensive). Real incidents in 2026-05-24:
#   1. PR #459 agent stashed PR #547 fix-back uncommitted work.
#   2. PR #549 (Splunk) agent created their feature branch in the
#      main tree, forcing PR #547 agent to switch out.
# See memory feedback_cross_agent_main_tree_contention.md.
#
# Resolution order for "where is the git command running", applied PER
# SEGMENT -- a `-C` binds its one command, a `cd` persists into the next:
#   1. that segment's own `git -C <path>` — last `-C` wins.
#   2. the `cd <path>` segments before it.
#   3. The hook's `cwd` field.
#   4. $PWD.
# Per segment because one command can straddle two trees, and resolving it
# once for the whole command bypassed the gate in one direction and
# false-blocked in the other. Measured; see main_tree_of below.
#
# Gate scope:
#   - Block: `git switch <not-main>`, `git switch -c <branch>`,
#     `git checkout -b <branch>`, `git checkout <not-main>` (when
#     `<not-main>` is a local branch name).
#   - Pass: `git switch main`, `git switch master`, `git checkout
#     main`, `git checkout master`, every `git checkout <pathspec>`
#     (file restore), `git checkout <sha>` (detached HEAD), `git
#     worktree add ...` (the sanctioned path).
#
# Bypass: agents that legitimately need to operate in the main tree
# (e.g. release tooling, history surgery) can `cd <subdir>` first
# or explicitly `git -C <main-tree>` and override with the
# documented escape. The hook only fires when the target dir IS
# the main repo top-level.

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
  || ! declare -F gate_verb_rest_each_dir >/dev/null \
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

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Match `git switch` / `git checkout` in the subcommand position.
# Matching goes through the SHARED command-position matcher
# (.claude/hooks/lib/command-match.sh, issue #1455): heredoc bodies and
# quoted spans are stripped, then the verb is matched at line start OR
# after a `&&` / `||` / `;` / `|` operator. That catches chained
# invocations the old line-start anchor missed, while a quoted mention
# still does not fire (it is removed rather than dodged by position).
if ! gate_matches "$cmd" "$GATE_RE_GIT_SWITCH"; then
  exit 0
fi

# Canonicalize a path before comparing. macOS resolves `/tmp` -> `/private/tmp`
# and `/var` -> `/private/var` via symlinks; `git worktree list --porcelain`
# always emits the real path, while the user's cwd may still carry the symlink.
# `cd <dir> && pwd -P` is the portable canonicalizer (BSD readlink lacks `-f`
# until 12+).
canonicalize() {
  local p="$1"
  if [[ -d "$p" ]]; then
    (cd "$p" 2>/dev/null && pwd -P) || printf '%s' "${p%/}"
  else
    printf '%s' "${p%/}"
  fi
}

# main_tree_of <dir>
#
# Print the MAIN worktree's path when <dir> IS that worktree AND the repo opts
# into the convention; print nothing and return 1 otherwise.
#
# Called PER MATCHED SEGMENT. `-C` and a preceding `cd` can put two segments of
# one command in two different trees, and this gate's verdict is per segment, so
# asking this question once for the whole command gets BOTH directions wrong.
# Measured against the real main checkout and the real linked worktree, payload
# cwd = the main tree, before this was per-segment:
#
#   git -C <worktree> switch -c a && git switch -c b     rc=0, want 2  BYPASS
#   git -C <worktree> checkout -b a && git checkout -b b rc=0, want 2  BYPASS
#   git switch main && git -C <worktree> switch -c a     rc=2, want 0  FALSE BLOCK
#
# The bypass is the same family as the `git fetch && git switch -c` one this
# gate closed one commit earlier: the tree was resolved from segment 1, the gate
# stood down for the whole command, and segment 2 -- in the SHARED main tree --
# was never judged. The false block refuses a branch creation in a linked
# worktree, which is precisely what the worktree convention mandates.
#
#
# LIMIT, stated rather than hidden. `gate_segments` FLATTENS a subshell, so a
# `cd` inside one leaks past the closing paren and steers every later segment:
#
#   (cd <worktree> && git switch -c a) && git switch -c b
#
# resolves segment 3 to the worktree and PASSES. Measured from the real main
# checkout, rc=0 where 2 is wanted -- and measured the same against the hook
# BEFORE the per-segment change, so this is a pre-existing bound rather than one
# that change introduced. Closing it means teaching the shared segmenter to
# report subshell depth, which is a change to every gate that calls it, not to
# this one. The exposure is narrow in the other direction too: the false-BLOCK
# twin cannot happen, since a leaked `cd` can only ever make the gate quieter.
# `git rev-parse --show-toplevel` returns the CURRENT worktree's top, which
# differs between the main tree and any `.claude/worktrees/<x>/`. Cheaper
# heuristic: the main worktree is whatever `git worktree list` lists first.
#
# ONE-ENTRY memo: every ordinary command's segments share a tree, and a miss
# costs a `git worktree list` fork inside a PreToolUse hook that runs on every
# Bash call. bash 3.2 has no associative arrays and a deeper cache buys nothing
# at these sizes.
_mt_memo_dir=""
_mt_memo_val=""
main_tree_of() {
  local dir="$1" mt
  if [ "$dir" = "$_mt_memo_dir" ]; then
    [ -n "$_mt_memo_val" ] || return 1
    printf '%s' "$_mt_memo_val"
    return 0
  fi
  _mt_memo_dir="$dir"
  _mt_memo_val=""
  mt=$(git -C "$dir" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0, 10); exit}')
  # Not in a git repo / cannot resolve -- pass through (we do not gate what we
  # cannot see).
  [ -n "$mt" ] || return 1
  # Repo opt-in scope (issue #1259): only repos following the worktree +
  # markgate convention get main-tree branch protection. Unrelated repos (a
  # personal blog, a scratch clone) have no parallel-agent contention on their
  # main tree. Opt-in signal: a `.markgate.yml` at the main worktree root.
  [ -f "$mt/.markgate.yml" ] || return 1
  # A LINKED worktree (`.claude/worktrees/<x>/` or similar) is exactly where the
  # convention wants feature branches, so it is not gated.
  [ "$(canonicalize "$dir")" = "$(canonicalize "$mt")" ] || return 1
  _mt_memo_val="$mt"
  printf '%s' "$mt"
}

# Decide from the SEGMENT that matched -- its arguments AND its tree -- not from
# a walk to the first `git` token in the whole command:
#
#   `git switch <main|master>`         -> allow
#   `git checkout <main|master>`       -> allow
#   `git switch -c <branch>`           -> block
#   `git switch <other-branch>`        -> block
#   `git checkout -b <branch>`         -> block
#   `git checkout <other-branch>`      -> block (only when <other-branch> is a
#                                        local branch -- file-path / sha
#                                        checkouts pass through)
#   `git checkout -- <pathspec>`       -> allow (file restore)
#   `git checkout <sha>`               -> allow (detached HEAD)
#
# The awk walker this replaces skipped to the FIRST `git` token in the whole
# command, so a chained `git fetch origin && git switch -c <b> origin/main` read
# `sub=fetch`, fell to its "unrecognised subcommand, fail open" arm and exited
# 0 -- a live bypass of the protection the whole worktree discipline rests on,
# in the spelling this repo's own skills print. Measured on the real main
# checkout, on `main`: the bare `git switch -c` rc=2, the `git fetch && ...`
# twin rc=0. The suite had a `cd <main> && git switch` case and no
# `git <verb> && git switch` one, which is why it survived.
#
# Judging the segment also retires the hand-rolled quoted-span collapse and the
# `cd <path> &&` prefix skip: the shared segmenter already splits on `&&` / `||`
# / `;` / `|` / newline / subshells / substitutions and strips leading
# assignments and wrappers, and `GATE_FLAGS` carries the quoted-value
# alternative a local copy drops (`git -C "/a b" switch -c x`).
#
# EVERY matching segment is considered, not just the first. A gate whose verdict
# depends on the ARGUMENTS and that reads only segment 1 has the same hole one
# operator further along -- `gate_verb_rest_each`'s own header records
# dirty-path-restore-gate falling into exactly that during the #2200 review.
#
# The two verbs are read with SEPARATE EREs because the tail cannot be judged
# without knowing which fired: `-c` creates a branch under `switch` and is a
# config override under `checkout`.
first_token_of() { printf '%s' "$1" | awk '{print $1}'; }
second_token_of() { printf '%s' "$1" | awk '{print $2}'; }

target_branch=""
block_reason=""
target_dir=""
main_tree=""

# judge <verb> <verb-ere>
# Walk every matching segment WITH the tree it runs in, and set block_reason on
# the first one that must be blocked.
judge() {
  local verb="$1" ere="$2" line seg_dir seg_main rest first_token
  while IFS= read -r line; do
    # Split on the FIRST tab only. `IFS=$'\t' read -r dir rest` would fold a TAB
    # RUN inside the rest -- tab is IFS whitespace -- and silently drop an
    # argument.
    seg_dir="${line%%$'\t'*}"
    rest="${line#*$'\t'}"
    if [ -z "$seg_dir" ]; then
      # This segment names its tree with an expression the parser cannot read.
      # Refuse rather than guess: gate_target_dir_strict's contract, now applied
      # per segment (go-to-k/cdkd#2027).
      gate_refuse_unresolved_target "main-tree-branch-gate" "${hook_cwd:-$PWD}"
    fi
    seg_main=$(main_tree_of "$seg_dir") || continue
    first_token=$(first_token_of "$rest")
    case "$verb" in
      switch)
        case "$first_token" in
          -c|-C|--create|--force-create)
            # Name the BRANCH, not the flag. The old shape read token 1 and
            # printed `--create` as the branch name -- right verdict, wrong text.
            target_branch=$(second_token_of "$rest")
            block_reason="creates new feature branch '$target_branch'"
            ;;
          # `main` / `master` are the only allowed targets.
          main|master) continue ;;
          # `git switch -` resolves to the previous branch, which cannot be
          # known without running git; block conservatively.
          -)
            target_branch="-"
            block_reason="switches to previous branch (\`git switch -\`); resolved branch unknown -- block conservatively"
            ;;
          -d|--detach)
            # Detaching HEAD moves the SHARED tree off `main` just as a branch
            # switch does; block, but do not call the flag a branch name.
            target_branch=""
            block_reason="detaches HEAD in the main tree (\`git switch $first_token\`)"
            ;;
          *)
            # A bare `git switch` (empty token) blocks conservatively too.
            target_branch="$first_token"
            block_reason="switches to feature branch '$first_token'"
            ;;
        esac
        ;;
      checkout)
        case "$first_token" in
          -b|-B)
            target_branch=$(second_token_of "$rest")
            block_reason="creates new feature branch '$target_branch'"
            ;;
          # `--` is a file restore, `main` / `master` are allowed, and a bare
          # `git checkout` is a NOP or a restore depending on the git version.
          --|main|master|"") continue ;;
          *)
            # A branch name or a sha. Only a name that resolves to a LOCAL
            # branch is a branch switch; a sha or a pathspec passes. Asked of
            # the segment's OWN tree, since that is where it would run.
            if git -C "$seg_dir" show-ref --verify --quiet "refs/heads/$first_token" 2>/dev/null; then
              target_branch="$first_token"
              block_reason="switches to feature branch '$first_token'"
            else
              continue
            fi
            ;;
        esac
        ;;
    esac
    target_dir="$seg_dir"
    main_tree="$seg_main"
    return 0
  done < <(gate_verb_rest_each_dir "$cmd" "${hook_cwd:-$PWD}" "$ere")
  return 1
}

judge switch "$GATE_RE_GIT_SWITCH_ONLY" || judge checkout "$GATE_RE_GIT_CHECKOUT"

[[ -n "$block_reason" ]] || exit 0

# Compose the block message.
branch_slug=$(printf '%s' "${target_branch:-feature-branch}" | tr -c 'a-zA-Z0-9._/-' '-')
cat >&2 <<EOF
Blocked by main-tree-branch-gate: target git working tree IS the main worktree, and the command $block_reason.

  resolved target dir: $target_dir
  command: $cmd

The main worktree at $main_tree is a SHARED RESOURCE across parallel agents. Feature branches must live in their own worktree so concurrent agents don't clobber each other's uncommitted work (real incidents on 2026-05-24, see memory feedback_cross_agent_main_tree_contention.md).

Correct invocation:

  git worktree add .claude/worktrees/${branch_slug} -b ${target_branch:-<branch>} origin/main
  cd .claude/worktrees/${branch_slug}
  # ... your work here ...

The main tree must stay on \`main\` (or \`master\`). When done with the feature worktree:

  git worktree remove .claude/worktrees/${branch_slug}

If you genuinely need to operate on a feature branch IN the main tree (release surgery, history rewrite, etc.), the escape is to confirm with the user explicitly first — there is no flag to bypass this hook silently.
EOF

exit 2
