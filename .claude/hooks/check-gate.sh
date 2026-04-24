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

# Prefer direct `markgate` (Homebrew/go install/mise-activated shim); fall back
# to `mise exec --` so users who installed via `mise install` but don't have
# shims on PATH still work.
if command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
elif command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
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

msg="Blocked by check-gate:"
if [ "$check_status" -ne 0 ]; then
  msg="$msg run /check first (or re-run if src/tests/config changed);"
fi
if [ "$docs_status" -ne 0 ]; then
  msg="$msg run /check-docs first (or re-run if src/docs/README/CLAUDE.md changed);"
fi
msg="$msg then retry the commit."
echo "$msg" >&2
exit 2
