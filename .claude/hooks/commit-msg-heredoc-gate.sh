#!/usr/bin/env bash
# commit-msg-heredoc-gate.sh
#
# PreToolUse hook. Blocks `git commit -m "$(cat <<'EOF' ... EOF)"`-
# style invocations because the outer-shell parser miscounts quotes
# when the heredoc body contains apostrophes / backticks, producing
# cryptic "unexpected EOF while looking for matching '" errors that
# burn time to diagnose.
#
# Triggers when a `git commit` invocation contains a heredoc (`<<`)
# anywhere in the same command string. The recommended replacement is
# `git commit -F <file>` — write the message to a file (which is read
# verbatim by git, no shell parsing) and pass the path. This is the
# same pattern the `/verify-pr` skill uses for `gh api PATCH --field
# body=@/tmp/pr-body.md`.
#
# Note: a plain single-line `git commit -m "..."` still passes — only
# the heredoc combination is blocked.

set -u

cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Only gate git commit invocations.
if ! printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+commit\b'; then
  exit 0
fi

# Allow if no heredoc in the command.
if ! printf '%s' "$cmd" | grep -q '<<'; then
  exit 0
fi

cat >&2 <<'EOF'
Blocked by commit-msg-heredoc-gate: `git commit -m "$(cat <<'EOF' ... EOF)"`
is fragile — apostrophes / backticks in the body confuse the outer
shell's quote tracking and produce cryptic
"unexpected EOF while looking for matching `'" errors.

Use a message file instead:

  cat > /tmp/commit-msg.txt <<'MSG'
  feat(scope): subject line

  Body paragraphs that may contain stack's apostrophes, `code`
  fences, or any other shell-confusing characters.
  MSG
  git commit -F /tmp/commit-msg.txt

`-F <file>` reads the file verbatim — no shell parsing of the body.
This is the same pattern `/verify-pr` uses for PR bodies via
`gh api PATCH --field body=@/tmp/pr-body.md`.
EOF
exit 2
