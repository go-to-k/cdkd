#!/usr/bin/env bash
# check-gate.sh
#
# PreToolUse hook. Blocks `git commit` unless both the `check` and
# `docs` markgate markers are fresh for the current content state.
# Each gate is scoped (see .markgate.yml) so edits to tests-only
# invalidate only `check`, and edits to docs-only invalidate only
# `docs`. Error messages identify which gate needs re-running.

set -u

# Resolve repo root from script location (.claude/hooks/check-gate.sh -> repo root).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Extract the command from the PreToolUse payload.
cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Only gate git commit -- any other command passes through.
if ! printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+commit\b'; then
  exit 0
fi

cd "$REPO" 2>/dev/null || exit 0

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
