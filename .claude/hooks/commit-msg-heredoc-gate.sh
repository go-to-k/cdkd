#!/usr/bin/env bash
# commit-msg-heredoc-gate.sh
#
# PreToolUse hook. Blocks `git commit -m "$(cat <<'EOF' ... EOF)"`-
# style invocations because the outer-shell parser miscounts quotes
# when the heredoc body contains apostrophes / backticks, producing
# cryptic "unexpected EOF while looking for matching '" errors that
# burn time to diagnose.
#
# The unsafe shape is specifically `git commit -m "$(cat <<EOF...)"`
# (or `--message`) — a heredoc body being interpolated into the -m
# argument of the same git commit invocation. The hook detects this
# shape by looking for `<<` AFTER `-m` / `--message` within the same
# pipeline segment (no `;` / `&&` / `||` / `|` between them).
#
# Recommended replacement: `git commit -F <file>` — write the message
# to a file (which is read verbatim by git, no shell parsing) and
# pass the path. The `cat > /tmp/file <<EOF...EOF && git commit -F
# /tmp/file` pattern is SAFE and explicitly allowed even though
# `<<` appears in the same Bash call: the heredoc writes the file,
# the `-F` reads it back, and there is no shell parsing of the body
# in between.

set -u

cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Only gate git commit invocations.
if ! printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+commit\b'; then
  exit 0
fi

# Block only when `git commit ... (-m|--message) ... <<` appears in
# the same pipeline segment (no `;` / `&&` / `||` / `|` between them).
# The character class `[^|;&]` constrains the match to a single
# segment, so `cat > file <<EOF; git commit -F file` (heredoc and
# commit in different segments, file-based commit) is allowed, but
# `git commit -m "$(cat <<EOF)"` (heredoc inside -m on one segment)
# is caught.
if ! printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+commit\b[^|;&]*(-m|--message)[^|;&]*<<'; then
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
