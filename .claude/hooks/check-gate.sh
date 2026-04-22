#!/usr/bin/env bash
# check-gate.sh
#
# PreToolUse hook. Blocks `git commit` unless the /check skill has
# recorded a markgate marker for the current content state. Emitted
# inline so Claude reads the failure reason and re-runs /check.

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

if "${markgate[@]}" verify check >/dev/null 2>&1; then
  exit 0
fi

echo "Blocked by check-gate: run /check first (or re-run if content changed since), then retry the commit." >&2
exit 2
