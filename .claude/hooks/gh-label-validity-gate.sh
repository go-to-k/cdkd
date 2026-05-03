#!/usr/bin/env bash
# gh-label-validity-gate.sh
#
# PreToolUse hook. Blocks `gh issue create` / `gh issue edit` / `gh pr create`
# / `gh pr edit` invocations whose `--label` or `--add-label` argument names a
# label that doesn't exist in the current repo.
#
# Why this gate exists: when a parallel-tool-call batch contains one
# `gh issue create --label NONEXISTENT`, the runtime cancels every sibling
# call (other issue creates, subagent dispatches, etc.) once the missing-label
# error fires. Validating labels upfront keeps that blast radius from costing
# minutes of re-dispatch.
#
# See feedback memory `feedback_parallel_call_blast_radius.md` for the rule
# this hook backs.

set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Only gate `gh issue|pr create|edit` invocations that include --label / --add-label.
# Note: gh's short alias `-l` is intentionally NOT matched. `-l` is also short
# for `--limit` (gh issue list -l 5), `--locale`, etc. — too ambiguous to filter
# without parsing each subcommand's flag table. Stick to the long forms; that's
# what scripts and AI agents use anyway.
if ! printf '%s' "$cmd" | grep -qE '\bgh[[:space:]]+(issue|pr)[[:space:]]+(create|edit)\b'; then
  exit 0
fi
if ! printf '%s' "$cmd" | grep -qE -- '--(add-)?label\b'; then
  exit 0
fi

cd "$REPO" 2>/dev/null || exit 0

# Fetch valid labels. If gh isn't authenticated or the call fails for any
# reason, skip the check rather than block — the gate is a foot-gun guard,
# not a hard requirement, and a transient gh failure shouldn't block work.
valid_labels=$(gh label list --json name -q '.[].name' 2>/dev/null) || exit 0
[ -z "$valid_labels" ] && exit 0

# Extract every --label / --add-label value from the command string.
# Handles `--label X`, `--label=X`, `--add-label X`, with the value optionally
# surrounded by single or double quotes. Splits comma-separated values.
# The unquoted value is terminated by whitespace or any shell metacharacter
# (`;`, `&`, `|`, `)`, `>`, `<`, `"`, `'`) so a chained `--label X; other-cmd`
# captures `X`, not `X;`.
labels=$(printf '%s' "$cmd" \
  | grep -oE -- '--(add-)?label[= ]("[^"]+"|'\''[^'\'']+'\''|[^ ;&|()<>"'\'']+)' \
  | sed -E -e 's/^--(add-)?label[= ]//' -e 's/^["'\'']//' -e 's/["'\'']$//' \
  | tr ',' '\n' \
  | sed 's/^ *//;s/ *$//' \
  | grep -v '^$' || true)

[ -z "$labels" ] && exit 0

missing=""
while IFS= read -r label; do
  [ -z "$label" ] && continue
  if ! printf '%s\n' "$valid_labels" | grep -qFx -- "$label"; then
    missing="${missing}  - '${label}'"$'\n'
  fi
done <<EOF_LABELS
$labels
EOF_LABELS

if [ -n "$missing" ]; then
  cat >&2 <<EOF
Blocked by gh-label-validity-gate: the following label(s) don't exist in this repo:
${missing}
Available labels:
$(printf '%s\n' "$valid_labels" | sed 's/^/  - /')

To fix: either drop the missing label, use one of the available labels, or
create the missing label first:
  gh label create '<label-name>' --description '...' --color '<hex>'

Why this gate exists: a single bad --label aborts every sibling call in a
parallel tool-call batch (cdkd 2026-05-02 lost a 4-way parallel batch this
way). Catching the typo upfront keeps the blast radius bounded.
EOF
  exit 2
fi

exit 0
