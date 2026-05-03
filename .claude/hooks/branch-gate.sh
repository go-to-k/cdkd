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

set -u

# Read the entire stdin payload once; we need both .tool_input.command
# and .cwd from it. Reading via two separate jq invocations would
# consume stdin twice and the second read would see nothing.
input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate git commit / git push — any other command passes through.
# `[^|;&]*` matches any flag/value pairs between `git` and the
# subcommand (e.g. `git -C <path> commit`) WITHOUT crossing pipeline
# separators. `git status; git commit` therefore still matches the
# second segment via re-positioning.
if ! printf '%s' "$cmd" | grep -qE '\bgit[^|;&]*\b(commit|push)\b'; then
  exit 0
fi

# Start from the Bash session's persisted cwd; fall back to the hook
# process's own cwd if the payload did not include a `cwd` field.
target_dir="${hook_cwd:-$PWD}"

# `cd <path>` at the start of the command shifts the target dir. We
# look at the FIRST `cd` and stop — chained `cd` patterns are rare
# enough that handling only the leading one covers the realistic
# foot-gun (the "cd into parent for tooling" case) without parsing
# arbitrary shell.
if [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
  cd_target="${BASH_REMATCH[1]}"
  # Strip surrounding single or double quotes if present.
  cd_target="${cd_target%\"}"; cd_target="${cd_target#\"}"
  cd_target="${cd_target%\'}"; cd_target="${cd_target#\'}"
  # Resolve relative paths against the inherited cwd.
  if [[ "$cd_target" != /* ]]; then
    cd_target="$target_dir/$cd_target"
  fi
  target_dir="$cd_target"
fi

# `git -C <path>` is git's own "run as if from <path>" flag and beats
# any earlier cd. Find the LAST occurrence so a chained
# `git -C /a foo && git -C /b commit` resolves to /b.
if [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
  # Use a pattern that captures the last occurrence by greedy-skipping.
  # bash regex doesn't support lookbehind, so re-scan from the end.
  c_target=""
  remaining="$cmd"
  while [[ "$remaining" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; do
    c_target="${BASH_REMATCH[1]}"
    remaining="${remaining#*"${BASH_REMATCH[0]}"}"
  done
  c_target="${c_target%\"}"; c_target="${c_target#\"}"
  c_target="${c_target%\'}"; c_target="${c_target#\'}"
  if [[ "$c_target" != /* ]]; then
    c_target="$target_dir/$c_target"
  fi
  target_dir="$c_target"
fi

# Read the branch from the resolved target dir. `-C` lets git operate
# on a directory that isn't our cwd; if the dir doesn't exist or isn't
# inside a git repo, symbolic-ref returns empty and we fall through to
# the safe `exit 0` below (we can't gate what we can't see).
branch=$(git -C "$target_dir" symbolic-ref --short HEAD 2>/dev/null || echo "")

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
