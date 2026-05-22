#!/usr/bin/env bash
# closes-paren-form-gate.sh — block `gh pr merge` when PR body uses
# `Closes (#N)` / `Fixes (#N)` / `Resolves (#N)` (closing-paren form),
# which does NOT trigger GitHub's auto-close because the keyword
# grammar requires parens-free `#N`.
#
# Closes the trap surfaced 2026-05-22 across PRs #509 / #510 / #511 /
# #514 — all 4 PRs used `Closes (#N).` uniformly (overgeneralization of
# memory `feedback_pr_body_no_hash_for_item_numbers.md`'s
# closing-paren disambig), and every merged PR left its target issue
# OPEN until a manual `gh issue close` was run.
#
# This hook fires PreToolUse on `gh pr merge` and short-circuits before
# the merge happens, so the user sees the error in time to either:
#   (a) rewrite the PR body to drop parens on the actual close keyword
#   (b) reword to a non-close-keyword incidental reference

set -euo pipefail

input_json=$(cat)

tool_name=$(jq -r '.tool_name // empty' <<<"$input_json" 2>/dev/null || true)
[[ "$tool_name" == "Bash" ]] || exit 0

command=$(jq -r '.tool_input.command // empty' <<<"$input_json" 2>/dev/null || true)
[[ -n "$command" ]] || exit 0

# Match `gh pr merge <N>` (allowing `gh -R repo` / `gh -C path` prefixes
# and any flag order). Extract the LAST `gh pr merge ... N` occurrence
# so a `# Wait + merge` Bash comment doesn't confuse the parser (same
# fix as pr-review-gate.sh).
trimmed="${command}"
case "$trimmed" in
  *"gh pr merge"*) ;;
  *) exit 0 ;;
esac

# Extract PR number (positional integer after `gh pr merge`)
args="${trimmed##*gh pr merge}"
pr_num=$(echo "$args" | grep -oE '^[[:space:]]*[0-9]+' | head -1 | tr -d '[:space:]' || true)
[[ -n "$pr_num" ]] || exit 0
[[ "$pr_num" =~ ^[0-9]+$ ]] || exit 0

# Fetch PR body (offline tolerant — if gh fails, don't block)
body=$(gh pr view "$pr_num" --json body -q .body 2>/dev/null || true)
[[ -n "$body" ]] || exit 0

# Match `(closes?|fix(es)?|resolves?) (#N)` case-insensitive, only
# when the parens IMMEDIATELY follow the keyword + whitespace. This
# avoids false positives on text like `also closes some (#N) issue`
# (a parenthetical that happens to follow `closes` but isn't part of
# the close directive).
matches=$(echo "$body" | grep -inE '\b(close[sd]?|fix(es|ed)?|resolve[sd]?)[[:space:]]+\(#[0-9]+\)' || true)

if [[ -n "$matches" ]]; then
  {
    echo "Blocked by closes-paren-form-gate: PR #$pr_num body uses"
    echo "the parens form on a GitHub auto-close keyword, which does"
    echo "NOT trigger auto-close on merge. Offending lines:"
    echo ""
    echo "$matches" | sed 's/^/  /'
    echo ""
    echo "GitHub auto-close grammar requires parens-free \`#N\`:"
    echo "  ✅ Closes #502.         (auto-close fires on merge)"
    echo "  ❌ Closes (#502).       (silent no-op; issue stays OPEN)"
    echo ""
    echo "Two fixes:"
    echo "  1. If the close IS intended: drop the parens, e.g."
    echo "       sed -i '' 's/Closes (#\\([0-9]*\\))/Closes #\\1/g' <body-file>"
    echo "     then update via:"
    echo "       gh api -X PATCH repos/<owner>/<repo>/pulls/$pr_num -F body=@<file>"
    echo "  2. If the parens form was an incidental reference (not a"
    echo "     close directive): reword to drop the close keyword, e.g."
    echo "       'References (#502).' / 'See also (#502).'"
    echo ""
    echo "Memory rule:"
    echo "  ~/.claude/projects/-Users-goto-pc-github-cdkd/memory/feedback_pr_body_no_hash_for_item_numbers.md"
    echo "  (Counter-trap section, added 2026-05-22)"
  } >&2
  exit 2
fi

exit 0
