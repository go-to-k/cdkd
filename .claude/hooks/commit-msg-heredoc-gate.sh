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

# Only gate git commit invocations. Recognition goes through the shared
# matcher (.claude/hooks/lib/command-match.sh, issue #2129): heredoc bodies and
# quoted spans are neutralised, then the verb is matched in COMMAND POSITION
# with a `VAR=value` / `env` / `command` / `nohup` prefix skipped. The old
# unanchored form blocked `echo "do not use git commit -m <<EOF form"` — a
# measured false positive on a command that never reached git.
#
# The SHAPE check below deliberately still reads the RAW command: neutralising
# the `"$(cat <<EOF ...)"` span is exactly what would hide the shape this gate
# exists to catch.
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
gate_matches "$cmd" "$GATE_RE_GIT_COMMIT" || exit 0

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
