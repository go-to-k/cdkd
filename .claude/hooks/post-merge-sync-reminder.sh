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
# rule for committed text, and would have blocked any PR touching this
# hook -- the PR-diff scan reads a changed file's WHOLE content, not just
# its added lines. That scan was `non-english-text-gate` until it was
# retired to CI by go-to-k/cdkd#2717; the property is the CI check's now,
# and the reason for translating stands either way.)

__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked as
# `bash verify-pr-gate.sh` from inside the hooks dir), which would look for
# `<script-name>/lib/...`. Fall back to the cwd in that case.
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."
if ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null \
  || ! declare -F cmd_matches_verb >/dev/null \
  || ! declare -F gate_matches >/dev/null \
  || ! declare -F cmd_last_cd_target >/dev/null \
  || ! declare -F strip_noncommand_spans >/dev/null; then
  # Non-blocking reminder: skip rather than refuse when the helper is absent.
  exit 0
fi

# go-to-k/cdkd#2729: the guard above covers the FUNCTIONS this hook calls and
# CANNOT see a missing CONSTANT. Since go-to-k/cdkd#3266 this hook reads ONE of
# its own -- `GATE_RE_GH_PR_MERGE`, which replaced the inline ERE below -- so it
# is named here; the call still asks about the library's own too, which the
# shared walk reads BARE inside function bodies where the `${X:-}` defaults on
# the load-time assignments do nothing.
#
# The SOFT form: this hook is NON-BLOCKING and only prints a reminder, so it
# skips rather than refuses, exactly as its library-load guard already does. It
# still says what is missing, because whatever it would have done did not
# happen and nothing else would show that. The blocking / non-blocking split
# is a convention here, not yet a checked partition: the class fence that
# would hold it is split out into go-to-k/cdkd#2826.
if ! declare -F gate_require_const_soft >/dev/null 2>&1; then
  exit 0
fi
gate_require_const_soft GATE_RE_GH_PR_MERGE || exit 0

set -euo pipefail

input_json=$(cat)

# Only fire on Bash gh pr merge (PostToolUse triggers on any Bash by default)
tool_name=$(jq -r '.tool_name // empty' <<<"$input_json" 2>/dev/null || true)
[[ "$tool_name" == "Bash" ]] || exit 0

command=$(jq -r '.tool_input.command // empty' <<<"$input_json" 2>/dev/null || true)
[[ -n "$command" ]] || exit 0

# Match `gh pr merge` in COMMAND POSITION, via the shared matcher: heredoc
# bodies and quoted spans are neutralised first, so a commit message or a JSON
# literal mentioning the phrase does not fire. Both of those shapes surfaced
# 2026-05-23 and were the reason this hook stopped substring-matching:
#   1. `git commit -F /tmp/x` whose message body contained "gh pr merge";
#   2. a smoke-test command carrying `"command":"... && gh pr merge ..."`.
#
# THE PATTERN IS THE LIBRARY'S SINCE go-to-k/cdkd#3266. It was an inline ERE,
# `gh([[:space:]]+-[A-Za-z][[:space:]]+[^[:space:]]+)*[[:space:]]+pr[[:space:]]+merge(...)`,
# which absorbed a LEFT-slot flag with a separated value and nothing else, so it
# went silent on every between-slot spelling go-to-k/cdkd#3242 taught the
# blocking gates to read. Measured through this hook:
#
#   gh pr merge 42 --squash        MATCH    MATCH
#   gh -R o/r pr merge 42          MATCH    MATCH
#   gh pr -R o/r merge 42          nomatch  MATCH
#   gh pr --repo=o/r merge 42      nomatch  MATCH
#   gh pr -Ro/r merge 42           nomatch  MATCH
#
# `gate_matches`, NOT `cmd_matches_verb`: the latter wraps its argument in
# `^( ... )` and the shared constants carry their own `^`, so the wrapper would
# nest the anchor. `ci-green-gate` reads the same constant the same way.
#
# The inline ERE also carried pipe / semicolon / ampersand / backtick / close-
# paren as extra verb terminators. Dropping them costs nothing: `gate_matches`
# tests one SEGMENT at a time and a segment ends AT the separator, so `$`
# already covers every one of them -- pinned by the chained, piped and subshell
# cases in this hook's suite.
if ! gate_matches "$command" "$GATE_RE_GH_PR_MERGE"; then
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
