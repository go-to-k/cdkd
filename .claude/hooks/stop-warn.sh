#!/usr/bin/env bash
# stop-warn.sh
#
# Stop hook. Emits a systemMessage when there are uncommitted changes,
# nudging Claude to commit-and-push. When the markgate /check marker is
# stale (or missing), the message says so -- a bare commit would be
# blocked.

set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$REPO" 2>/dev/null || exit 0

status=$(git status --porcelain 2>/dev/null || echo "")
if [ -z "$status" ]; then
  exit 0
fi

# Prefer direct `markgate` to avoid `mise exec` startup overhead on every
# Stop hook; fall back to `mise exec --` for users who installed via
# `mise install` without shims on PATH.
if command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
elif command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
else
  markgate=()
fi

if [ ${#markgate[@]} -gt 0 ] && "${markgate[@]}" verify check >/dev/null 2>&1; then
  msg="WARNING: Uncommitted changes (/check passed, commit allowed)"
else
  msg="WARNING: Uncommitted changes. Run /check to allow commit (marker invalid)"
fi

# Escape the status snippet for inclusion in JSON.
status_snippet=$(echo "$status" | head -10 | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
printf '{"systemMessage": "%s\\n%s"}' "$msg" "${status_snippet:1:${#status_snippet}-2}"
