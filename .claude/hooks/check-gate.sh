#!/usr/bin/env bash
# check-gate.sh
#
# PreToolUse hook. Blocks `git commit` unless the /check skill has
# recorded a success marker for the current content state. Emitted
# inline so Claude reads the failure reason and re-runs /check.

set -u

MARKER="${CDKD_CHECK_MARKER:-/tmp/cdkd-check-marker.json}"
# Resolve repo root from script location (.claude/hooks/check-gate.sh → repo root).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Extract the command from the PreToolUse payload.
cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Only gate git commit — any other command passes through.
if ! printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+commit\b'; then
  exit 0
fi

cd "$REPO" 2>/dev/null || exit 0

head=$(git rev-parse HEAD 2>/dev/null || echo "none")
# Staging-agnostic: union of tracked changes + untracked files, hashed by content.
content=$({
  git diff HEAD --name-only 2>/dev/null
  git ls-files --others --exclude-standard 2>/dev/null
} | sort -u | while IFS= read -r f; do
  if [ -f "$f" ]; then
    printf 'FILE:%s\n' "$f"
    cat "$f"
  else
    printf 'DEL:%s\n' "$f"
  fi
done | shasum -a 256 | cut -c1-16)
current=$(printf '{"head":"%s","content":"%s"}' "$head" "$content")

if [ ! -f "$MARKER" ]; then
  echo "Blocked by check-gate: run /check first, then retry the commit." >&2
  exit 2
fi

saved=$(cat "$MARKER" 2>/dev/null || echo "")
if [ "$current" != "$saved" ]; then
  echo "Blocked by check-gate: content changed since /check last ran. Re-run /check, then retry the commit." >&2
  exit 2
fi

exit 0
