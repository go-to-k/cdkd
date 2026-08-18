#!/usr/bin/env bash
# check-gate.sh
#
# PreToolUse hook. Blocks `git commit` unless both the `check` and
# `docs` markgate markers are fresh for the current content state.
# Each gate is scoped (see .markgate.yml) so edits to tests-only
# invalidate only `check`, and edits to docs-only invalidate only
# `docs`. Error messages identify which gate needs re-running.
#
# WHY the cwd-aware resolution matters (cdkd #559): this repo is
# regularly worked in via `git worktree`, and markgate stores marker
# state per-worktree at `<git rev-parse --absolute-git-dir>/markgate/`.
# The pre-#559 implementation derived REPO from `BASH_SOURCE` and
# always landed on the main working tree, defeating markgate's
# per-worktree isolation and forcing every parallel agent to converge
# on the main tree's view (see memory rule
# feedback_cross_agent_main_tree_contention.md). We now resolve the
# target working tree from the PreToolUse payload's `cwd` field +
# leading `cd <path>` + last `git -C <path>` flag, exactly mirroring
# branch-gate.sh / integ-local-gate.sh, so the markgate verify runs
# against the worktree the commit will actually land in.

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

# Only gate git commit -- any other command passes through. The
# matcher tolerates `git -C <path> commit` / `git -c <key>=<val> commit`
# / `git --no-pager commit` / etc. by allowing zero or more flag tokens
# Matching goes through the SHARED command-position matcher
# (.claude/hooks/lib/command-match.sh, issue #1455): heredoc bodies and
# quoted spans are stripped, then the verb is matched at line start OR
# after a `&&` / `||` / `;` / `|` operator. That catches chained
# invocations the old line-start anchor missed, while a quoted mention
# still does not fire (it is removed rather than dodged by position).
if ! cmd_matches_verb "$cmd" 'git([[:space:]]+(-[^[:space:]]+([[:space:]]+[^[:space:]-][^[:space:]]*)?))*[[:space:]]+commit([[:space:]]|$|[|;&`)])'; then
  exit 0
fi

# Resolve where the git command will actually run (cwd-aware; mirrors
# branch-gate.sh / integ-local-gate.sh — keep these in sync if either
# gains new resolution shapes).
target_dir="${hook_cwd:-$PWD}"

# `cd <path>` at the start of the command shifts the target dir.
# Pass the current target as the BASE so chained relative cds compose
# (`cd /abs/one && cd sub`); the helper returns a fully-resolved path.
cd_target="$(cmd_last_cd_target "$cmd" "$target_dir" 'git([[:space:]]+(-[^[:space:]]+([[:space:]]+[^[:space:]-][^[:space:]]*)?))*[[:space:]]+commit([[:space:]]|$|[|;&`)])')"
if [[ -n "$cd_target" ]]; then
  target_dir="$cd_target"
fi

# `git -C <path>` beats any earlier cd; pick the LAST occurrence.
if [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
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

# If the resolved target dir is not a git repo, silently pass — we
# can't audit what we can't see (mirrors branch-gate.sh).
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

cd "$target_dir" 2>/dev/null || exit 0

# Prefer the `.mise.toml`-pinned version via `mise exec --` so the repo's
# canonical markgate wins over an older PATH binary (e.g. Homebrew). Falls
# back to PATH `markgate` for users without mise. The mise-first preference
# is load-bearing across markgate 0.3.x: 0.3.1 bumped the marker schema
# (version 1 -> 2) and a 0.3.0 binary on PATH would silently treat a 0.3.1
# marker as missing, so mixing binaries within a team would constantly
# invalidate each other's markers. Pinning via mise keeps every contributor
# on the same schema regardless of what their Homebrew has.
if command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
elif command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
else
  echo "Blocked by check-gate: markgate is not installed. Run 'mise install' at the repo root (see CONTRIBUTING.md)." >&2
  exit 2
fi

"${markgate[@]}" verify check >/dev/null 2>&1
check_status=$?

"${markgate[@]}" verify docs >/dev/null 2>&1
docs_status=$?

if [ "$check_status" -eq 0 ] && [ "$docs_status" -eq 0 ]; then
  exit 0
fi

# Extract the parenthesized reason from `markgate status <gate>` so the
# error message tells the user *why* the gate is stale (digest differs vs
# expired by ttl vs child gate stale) instead of just naming the skill.
# Fails open: empty string when extraction fails (markgate too old, no
# parenthetical, or status itself errored), and the message falls back to
# the pre-0.3 generic hint text.
gate_reason() {
  "${markgate[@]}" status "$1" 2>/dev/null \
    | awk '/^state:/ { if (match($0, /\([^)]+\)/)) print substr($0, RSTART, RLENGTH); exit }'
}

msg="Blocked by check-gate:"
if [ "$check_status" -ne 0 ]; then
  reason=$(gate_reason check)
  if [ -n "$reason" ]; then
    msg="$msg run /check first $reason;"
  else
    msg="$msg run /check first (or re-run if src/tests/config changed);"
  fi
fi
if [ "$docs_status" -ne 0 ]; then
  reason=$(gate_reason docs)
  if [ -n "$reason" ]; then
    msg="$msg run /check-docs first $reason;"
  else
    msg="$msg run /check-docs first (or re-run if src/docs/README/CLAUDE.md changed);"
  fi
fi
msg="$msg then retry the commit."
echo "$msg" >&2
exit 2
