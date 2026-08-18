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
if ! cmd_matches_verb "$cmd" 'git([[:space:]]+(-[^[:space:]]+([[:space:]]+[^[:space:]-][^[:space:]]*)?))*[[:space:]]+(commit|push)([[:space:]]|$|[|;&`)])'; then
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
cd_target="$(cmd_last_cd_target "$cmd" "$target_dir" 'git([[:space:]]+(-[^[:space:]]+([[:space:]]+[^[:space:]-][^[:space:]]*)?))*[[:space:]]+(commit|push)([[:space:]]|$|[|;&`)])')"
if [[ -n "$cd_target" ]]; then
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

# Cross-repo delegation (issue 1961). The hooks a session runs come from
# ONE repo's settings, but they fire on every Bash call -- including
# commands whose target is a different repository. When that target ships
# its own copy of this gate, that copy decides; ours must not impose a
# policy the target never adopted. Falls back to this repo's policy (with
# a stderr note) when the target has no counterpart, and degrades to
# exactly today's behaviour if the library is missing -- never weaker.
__fr_dir="${BASH_SOURCE[0]%/*}"
[ "$__fr_dir" = "${BASH_SOURCE[0]}" ] && __fr_dir="."
# shellcheck source=lib/foreign-repo.sh
if . "$__fr_dir/lib/foreign-repo.sh" 2>/dev/null \
   && declare -F hook_delegate_if_foreign >/dev/null; then
  hook_delegate_if_foreign "$target_dir" "${BASH_SOURCE[0]##*/}" "$input" || true
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
