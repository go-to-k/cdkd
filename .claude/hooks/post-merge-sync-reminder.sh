#!/usr/bin/env bash
# post-merge-sync-reminder.sh — PostToolUse hook on `gh pr merge` that
# emits a reminder to run the two routine post-merge sync commands:
#
#   1. `git pull --ff-only origin main` (from main worktree)
#   2. `vp install -g @go-to-k/cdkd@latest`
#
# Memory rule `feedback_session_completion_audit_required.md` step 6
# encodes this as mandatory, but the rule is only read at session start
# and easy to skip mid-session. This hook fires AFTER every successful
# `gh pr merge` and appends a reminder into the conversation so the
# operator sees it in the moment.
#
# Surfaced 2026-05-23 after a 2nd violation of the post-merge sync
# step within the same multi-day session. The user's reaction
# ("なぜ忘れた? 絶対忘れないようにして欲しい") was the trigger to upgrade
# from memory-only to hook-enforced.

set -euo pipefail

input_json=$(cat)

# Only fire on Bash gh pr merge (PostToolUse triggers on any Bash by default)
tool_name=$(jq -r '.tool_name // empty' <<<"$input_json" 2>/dev/null || true)
[[ "$tool_name" == "Bash" ]] || exit 0

command=$(jq -r '.tool_input.command // empty' <<<"$input_json" 2>/dev/null || true)
[[ -n "$command" ]] || exit 0

# Match `gh pr merge` ONLY when it's an actual shell command at the
# start of a line. Anchoring to line-start avoids the false-positive
# class of matching `gh pr merge` inside quoted JSON strings / heredoc
# bodies / commit message text.
#
# Trade-off: a chained `git status && gh pr merge 100` on a single
# line will NOT match, because the regex can't distinguish a real
# shell `&&` separator from `&&` inside a quoted argument. Almost
# every `gh pr merge` invocation in this codebase is standalone, so
# the trade-off is acceptable. False-negatives (silent skip) are
# better than false-positives (annoying reminder on every commit).
#
# Both shapes surfaced 2026-05-23:
#   1. `git commit -F /tmp/x` whose message body contained the text
#      "gh pr merge" (naive substring match, fixed by anchoring).
#   2. Smoke-test command containing JSON literals like
#      `"command":"... && gh pr merge ..."` triggered the
#      `[;&|]`-shell-separator branch (BSD grep doesn't know about
#      shell quoting). Fixed by dropping that branch.
if ! printf '%s\n' "$command" | grep -qE '^[[:space:]]*gh[[:space:]]+(-[A-Za-z][[:space:]]+\S+[[:space:]]+)*pr[[:space:]]+merge\b'; then
  exit 0
fi

# Don't fire if the merge actually failed — check tool_response.exit_code
# (PostToolUse fires AFTER the tool runs, regardless of exit code; the
# operator only needs the reminder when the merge actually succeeded).
exit_code=$(jq -r '.tool_response.exit_code // 0' <<<"$input_json" 2>/dev/null || echo 0)
if [[ "$exit_code" != "0" ]]; then
  exit 0
fi

# Skip when stderr contains "not mergeable" (the merge command exited 0
# but didn't actually merge — e.g. --auto flag with auto-merge disabled).
stderr=$(jq -r '.tool_response.stderr // ""' <<<"$input_json" 2>/dev/null || true)
case "$stderr" in
  *"is not mergeable"*) exit 0 ;;
  *"is in the merge queue"*) exit 0 ;;
esac

# Emit the reminder via PostToolUse additionalContext (visible to the
# operator, non-blocking).
cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"PR merge succeeded. Post-merge sync REQUIRED before claiming session complete (memory feedback_session_completion_audit_required step 6):\n  1. git pull --ff-only origin main   (from main worktree — advance local main + pick up parallel-session merges)\n  2. vp install -g @go-to-k/cdkd@latest   (semantic-release bumps the version on every merge; global cdkd binary drifts within minutes)\n\nVerify cdkd --version reports the post-release value and surface it in the session-wrap report."}}
EOF

exit 0
