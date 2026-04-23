#!/usr/bin/env bash
# branch-gate.sh
#
# PreToolUse hook. Blocks `git commit` and `git push` when the current
# branch is main or master. All changes to cdkd must land via PR from a
# feature branch — committing or pushing directly to main is not allowed.

set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Only gate git commit / git push -- any other command passes through.
if ! printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+(commit|push)\b'; then
  exit 0
fi

cd "$REPO" 2>/dev/null || exit 0

branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")

case "$branch" in
  main|master)
    echo "Blocked by branch-gate: current branch is '$branch'. Create a feature branch and open a PR instead (e.g. 'git switch -c fix/xxx'). Direct commits/pushes to main are not allowed in this repo." >&2
    exit 2
    ;;
esac

exit 0
