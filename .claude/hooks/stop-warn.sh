#!/usr/bin/env bash
# stop-warn.sh
#
# Stop hook. Emits a systemMessage when there are uncommitted changes,
# nudging Claude to commit-and-push. When the /check marker is stale
# (or missing), the message says so — a bare commit would be blocked.

set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MARKER="${CDKD_CHECK_MARKER:-/tmp/cdkd-check-marker.json}"

cd "$REPO" 2>/dev/null || exit 0

status=$(git status --porcelain 2>/dev/null || echo "")
if [ -z "$status" ]; then
  exit 0
fi

head=$(git rev-parse HEAD 2>/dev/null || echo "none")
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
saved=$(cat "$MARKER" 2>/dev/null || echo "")

if [ "$current" = "$saved" ]; then
  msg="⚠️ 未コミットの変更があります (/check 済・コミット可能)"
else
  msg="⚠️ 未コミットの変更があります。/check を走らせるとコミット可能になります (マーカー無効)"
fi

# Escape the status snippet for inclusion in JSON.
status_snippet=$(echo "$status" | head -10 | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
printf '{"systemMessage": "%s\\n%s"}' "$msg" "${status_snippet:1:${#status_snippet}-2}"
