#!/usr/bin/env bash
# gh-pr-edit-deprecation-gate.sh
#
# PreToolUse hook. Blocks `gh pr edit --title` / `gh pr edit --body`
# because they currently fail SILENTLY due to a GraphQL
# Projects-classic deprecation warning: gh exits non-zero, prints the
# warning to stderr, and the title/body mutation is never applied.
# Diagnosing this wastes time when the PR appears unchanged after a
# command that "succeeded enough" to not throw.
#
# Recommended replacement is the raw REST API:
#
#   gh api -X PATCH repos/<owner>/<repo>/pulls/<num> \
#     -f title="..." \
#     -F body=@/tmp/pr-body.md
#
# This bypasses the deprecated GraphQL path. The `/verify-pr` skill
# uses this form for PR title + body refreshes.
#
# Other `gh pr edit` flags that don't touch title/body (e.g. labels,
# reviewers) pass through — those use a different code path that
# isn't affected by the deprecation.

set -u

cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Only gate `gh pr edit` invocations. Recognition goes through the shared
# matcher (.claude/hooks/lib/command-match.sh, issue #2129): the old unanchored
# form blocked `echo "next step: gh pr edit 1 --body foo"` — a measured false
# positive on a command that never called gh — while missing nothing it caught.
# Issue #2037 re-reported the same class from the other end: a `grep` pattern,
# a `python3 - <<'PY'` heredoc body, or a test-case label that merely QUOTES the
# deprecated spelling is data, not an invocation, and a PreToolUse denial aborts
# the WHOLE call, so those runs did nothing at all. The shared matcher already
# neutralises quoted spans and heredoc bodies before looking for the verb in
# command position, so all four reported shapes pass; the suite beside this file
# now pins them so a future rewrite cannot quietly reintroduce them.
#
# DELIBERATELY NOT SOLVED HERE: deciding policy by regex-matching shell text
# leaves the set of bypass spellings unbounded (an alias, a variable holding the
# verb, an interpreter reading the command off stdin). That class is tracked in
# go-to-k/cdkd#2156 and is out of scope for this gate — the choice was made, not
# missed.
# shellcheck source=lib/command-match.sh
_gate_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/command-match.sh"
# Fail CLOSED: a gate that cannot evaluate the command must not wave it through.
# `|| exit 0` silently disabled the gate whenever the library was unreadable or
# truncated, while ten of these files carried a comment claiming the opposite
# (go-to-k/cdkd#2130 review). The 18 gates that predate this convergence already
# exit 2 here; these now match them.
if [ ! -r "$_gate_lib" ]; then
  echo "Blocked: .claude/hooks/lib/command-match.sh is missing or unreadable, so this gate cannot evaluate the command." >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$_gate_lib"
if ! declare -F gate_matches >/dev/null 2>&1; then
  echo "Blocked: .claude/hooks/lib/command-match.sh loaded but gate_matches is undefined (truncated file?)." >&2
  exit 2
fi
gate_matches "$cmd" "$GATE_RE_GH_PR_EDIT" || exit 0

# Only block if the invocation actually sets --title or --body.
if ! printf '%s' "$cmd" | grep -qE '(--title|--body|--body-file)\b'; then
  exit 0
fi

cat >&2 <<'EOF'
Blocked by gh-pr-edit-deprecation-gate: `gh pr edit --title` /
`--body` currently fails SILENTLY due to a GraphQL Projects-classic
deprecation warning. The mutation is not applied even though the
command appears to succeed.

Use the raw REST API instead:

  gh api -X PATCH repos/<owner>/<repo>/pulls/<num> \
    -f title="New title" \
    -F body=@/tmp/pr-body.md

  # Verify it actually applied:
  gh pr view <num> --json title,body -q '{title, body}'

`--body=@<file>` reads the file verbatim, sidestepping shell-escape
issues with backticks / apostrophes. This is the form the
`/verify-pr` skill uses for PR title + body refresh.

If a future gh release fixes the deprecation, this gate can be
removed.
EOF
exit 2
