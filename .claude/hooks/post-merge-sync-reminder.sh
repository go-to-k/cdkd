#!/usr/bin/env bash
# post-merge-sync-reminder.sh — PostToolUse hook on `gh pr merge` that
# emits a reminder to run the routine post-merge sync commands:
#
#   1. `git pull --ff-only origin main` (from main worktree)
#   2. `vp run build` in the main worktree (the globally linked binary
#      points at its dist/cli.js) — and, only after a release PR merge,
#      `vp install -g @go-to-k/cdkd@latest` for npm-installed copies
#      (releases are batched by release-please; an ordinary merge does
#      not bump the version)
#
# Memory rule `feedback_session_completion_audit_required.md` step 6
# encodes this as mandatory, but the rule is only read at session start
# and easy to skip mid-session. This hook fires AFTER every successful
# `gh pr merge` and appends a reminder into the conversation so the
# operator sees it in the moment.
#
# Surfaced 2026-05-23 after a 2nd violation of the post-merge sync
# step within the same multi-day session. The maintainer's reaction --
# "why was it forgotten? make sure it never is again" -- was the
# trigger to upgrade from memory-only to hook-enforced. (Quoted in
# translation: the original was verbatim in the session's chat
# language, which put this file in breach of the repo's English-only
# rule for committed text and, because `non-english-text-gate` reads a
# changed file's WHOLE content, would have blocked any PR that touched
# this hook.)

__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked as
# `bash verify-pr-gate.sh` from inside the hooks dir), which would look for
# `<script-name>/lib/...`. Fall back to the cwd in that case.
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."
if ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null \
  || ! declare -F cmd_matches_verb >/dev/null \
  || ! declare -F cmd_last_cd_target >/dev/null \
  || ! declare -F strip_noncommand_spans >/dev/null; then
  # Non-blocking reminder: skip rather than refuse when the helper is absent.
  exit 0
fi

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
if ! cmd_matches_verb "$command" 'gh([[:space:]]+-[A-Za-z][[:space:]]+[^[:space:]]+)*[[:space:]]+pr[[:space:]]+merge([[:space:]]|$|[|;&`)])'; then
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
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"PR merge succeeded. Post-merge sync REQUIRED before claiming session complete (memory feedback_session_completion_audit_required step 6):\n  1. git pull --ff-only origin main   (from main worktree — advance local main + pick up parallel-session merges)\n  2. vp run build   (from main worktree — the globally linked cdkd points at its dist/cli.js)\n\nReleases are BATCHED (release-please): an ordinary merge does not bump the version — it only updates the standing chore(release) PR. Run vp install -g @go-to-k/cdkd@latest only after a release PR merge, and never merge the release PR unless the user asked for a release."}}
EOF

exit 0
