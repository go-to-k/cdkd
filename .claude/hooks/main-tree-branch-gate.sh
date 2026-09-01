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
# Resolution order for "where is the git command running":
#   1. `git -C <path>` — last `-C` wins.
#   2. Leading `cd <path> && ...` — the cd target.
#   3. The hook's `cwd` field.
#   4. $PWD.
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
  || ! declare -F gate_target_dir_strict >/dev/null \
  || ! declare -F gate_refuse_unresolved_target >/dev/null \
  || ! declare -F cmd_last_cd_target >/dev/null \
  || ! declare -F gate_verb_rest_each >/dev/null \
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

# Resolve the target dir the same way branch-gate.sh does.
# Where the git/gh command will actually RUN.
#
# This calls the SHARED resolver in lib/command-match.sh, replacing the
# hand-rolled `-C` scan this hook used to carry. That copy captured the raw
# token with no guard for an unexpanded `$VAR`, so the standard worktree
# spelling `git -C "$W" ...` resolved to the literal `<cwd>/$W`, the repo
# probe below failed, and the gate exited 0 over a tree it never looked at
# (go-to-k/cdkd#2027). The strict resolver refuses instead of guessing.
__verb_ere="$GATE_RE_GIT_SWITCH"
if ! target_dir=$(gate_target_dir_strict "$cmd" "${hook_cwd:-$PWD}" "$__verb_ere"); then
  gate_refuse_unresolved_target "main-tree-branch-gate" "${hook_cwd:-$PWD}"
fi

# Is the target dir the main worktree (= the top-level of the
# shared .git directory)? `git rev-parse --show-toplevel` returns
# the current worktree's top — which differs between the main
# tree and any `.claude/worktrees/<x>/`. The MAIN tree's toplevel
# equals the directory whose parent contains `.git` as a regular
# directory (not a gitfile pointing into a worktrees subdir).
#
# Cheaper heuristic: the main worktree is whatever `git worktree
# list` lists first. We use that and compare to target_dir.
main_tree=$(git -C "$target_dir" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0, 10); exit}')

if [[ -z "$main_tree" ]]; then
  # Not in a git repo / can't resolve — pass through (we don't gate
  # what we can't see).
  exit 0
fi

# Repo opt-in scope (issue #1259): only repos following the worktree +
# markgate convention get main-tree branch protection. Unrelated repos
# (a personal blog, a scratch clone) have no parallel-agent contention
# on their main tree. Opt-in signal: a `.markgate.yml` at the main
# worktree root.
if [[ ! -f "$main_tree/.markgate.yml" ]]; then
  exit 0
fi

# Canonicalize both sides before compare. macOS resolves
# `/tmp` → `/private/tmp` and `/var` → `/private/var` via symlinks;
# `git worktree list --porcelain` always emits the real path, while
# the user's cwd may still carry the symlink. `cd <dir> && pwd -P`
# is the portable canonicalizer (BSD readlink lacks `-f` until 12+).
canonicalize() {
  local p="$1"
  if [[ -d "$p" ]]; then
    (cd "$p" 2>/dev/null && pwd -P) || printf '%s' "${p%/}"
  else
    printf '%s' "${p%/}"
  fi
}
target_norm=$(canonicalize "$target_dir")
main_norm=$(canonicalize "$main_tree")

if [[ "$target_norm" != "$main_norm" ]]; then
  # Target is a worktree (`.claude/worktrees/<x>/` or similar) —
  # branch-switching there is fine.
  exit 0
fi

# Target IS the main worktree. Decide from the SEGMENT that matched, not from a
# walk to the first `git` token in the whole command:
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

target_branch=""
block_reason=""

while IFS= read -r rest; do
  first_token=$(first_token_of "$rest")
  if [[ "$first_token" == "-c" || "$first_token" == "-C" ]]; then
    target_branch=$(printf '%s' "$rest" | awk '{print $2}')
    block_reason="creates new feature branch '$target_branch'"
    break
  fi
  # `main` / `master` are the only allowed targets; everything else -- including
  # a bare `git switch` and `git switch -` (whose resolved branch cannot be known
  # without running git) -- blocks conservatively.
  if [[ "$first_token" == "main" || "$first_token" == "master" ]]; then
    continue
  fi
  target_branch="$first_token"
  if [[ "$first_token" == "-" ]]; then
    block_reason="switches to previous branch (\`git switch -\`); resolved branch unknown -- block conservatively"
  else
    block_reason="switches to feature branch '$first_token'"
  fi
  break
done < <(gate_verb_rest_each "$cmd" "$GATE_RE_GIT_SWITCH_ONLY")

if [[ -z "$block_reason" ]]; then
  while IFS= read -r rest; do
    first_token=$(first_token_of "$rest")
    if [[ "$first_token" == "-b" || "$first_token" == "-B" ]]; then
      target_branch=$(printf '%s' "$rest" | awk '{print $2}')
      block_reason="creates new feature branch '$target_branch'"
      break
    fi
    # `--` is a file restore, `main` / `master` are allowed, and a bare
    # `git checkout` is a NOP or a restore depending on the git version.
    if [[ "$first_token" == "--" || "$first_token" == "main" || "$first_token" == "master" || -z "$first_token" ]]; then
      continue
    fi
    # A branch name or a sha. Only a name that resolves to a LOCAL branch is a
    # branch switch; a sha or a pathspec passes.
    if git -C "$target_dir" show-ref --verify --quiet "refs/heads/$first_token" 2>/dev/null; then
      target_branch="$first_token"
      block_reason="switches to feature branch '$first_token'"
      break
    fi
  done < <(gate_verb_rest_each "$cmd" "$GATE_RE_GIT_CHECKOUT")
fi

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
