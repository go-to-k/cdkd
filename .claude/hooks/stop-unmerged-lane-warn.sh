#!/usr/bin/env bash
# stop-unmerged-lane-warn.sh
#
# Stop hook. `stop-warn.sh` next to it catches UNCOMMITTED work in the main
# tree. This catches the other, quieter half: a feature worktree whose branch
# is COMMITTED but still ahead of `origin/main` -- a lane that is finished as
# far as the editor is concerned and unfinished as far as the repo is.
#
# Why this is a hook rather than another sentence. CLAUDE.md already says a
# NOT-CLOSEABLE verdict is a to-do list and not a stopping point, and already
# says that if you cannot name a signal that will re-invoke you then you are
# STOPPED rather than WAITING. Both were violated repeatedly in one session on
# 2026-08-26: turns ended with `Mode: WAITING` next to `Waiting on: none`, and
# with `Verdict: NOT CLOSEABLE` in the same report as the stop. A rule that is
# already in the text and gets violated anyway is not made load-bearing by a
# third spelling of it (`/work-issues` section 10-b says to escalate rather
# than restate), so this computes the verdict from the REPO instead of from the
# agent's own self-report -- which is the part that was wrong.
#
# Deliberately does NOT call `gh`: a Stop hook runs on every turn, and a network
# round-trip per turn is a cost this warning does not justify. Branch state
# alone separates "there is unmerged work here" from "there is not".
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO" 2>/dev/null || exit 0

# Cheap: no fetch. A stale `origin/main` can only UNDER-report (a branch whose
# work already merged still looks ahead until the next fetch), and the failure
# direction that matters is missing a real lane, not naming a merged one.
git rev-parse --verify origin/main >/dev/null 2>&1 || exit 0

lanes=""
while IFS= read -r wt; do
  [ -n "$wt" ] || continue
  [ "$wt" = "$REPO" ] && continue
  br=$(git -C "$wt" branch --show-current 2>/dev/null) || continue
  [ -n "$br" ] || continue
  case "$br" in main | master) continue ;; esac
  ahead=$(git -C "$wt" rev-list --count "origin/main..$br" 2>/dev/null) || continue
  [ "${ahead:-0}" -gt 0 ] || continue
  lanes="${lanes}  ${br}  (${ahead} commit(s) ahead, worktree ${wt##*/})
"
done < <(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')

[ -n "$lanes" ] || exit 0

msg="WARNING: unmerged lane(s) still open -- a NOT-CLOSEABLE verdict is a TO-DO LIST, not a stopping point.
Each branch below is committed but not on origin/main. If any is YOURS, you are not done: rebase, run the
gates, open the PR, merge. If one belongs to another session, say which and why, rather than leaving it
unexplained. And if you are ending the turn with nothing that will re-invoke you, the honest label is
STOPPED, not WAITING."

payload=$(printf '%s\n%s' "$msg" "$lanes" |
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
printf '{"systemMessage": %s}' "$payload"
