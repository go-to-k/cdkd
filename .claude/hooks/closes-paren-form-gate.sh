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
# Recognition goes through the shared matcher (.claude/hooks/lib/command-match.sh,
# issue #2129) rather than a bare substring test, so a chained
# `vp run test && gh pr merge 1` is seen while a body or comment that merely
# QUOTES `gh pr merge` no longer reaches the PR-number extraction below.
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
gate_matches "$trimmed" "$GATE_RE_GH_PR_MERGE" || exit 0

# Extract PR number (positional integer after `gh pr merge`)
# The matched-verb selector, not a literal strip: `${trimmed##*gh pr merge}`
# returns the WHOLE command under `gh -R <owner/repo> pr merge`, the number
# regex then finds nothing, and this gate exited 0 -- fully bypassed by the
# flag the widened absorber had just taught it to match.
pr_num=$(gate_pr_selector "$trimmed" "$GATE_RE_GH_PR_MERGE")
[[ -n "$pr_num" ]] || exit 0
[[ "$pr_num" =~ ^[0-9]+$ ]] || exit 0

# Fetch PR body. Distinguish two failure modes:
#   (1) `gh pr view` exited non-zero (network / auth / rate-limit) — we
#       can't determine the body, so we can't prove the trap is absent.
#       Log a LOUD warning to stderr so the user sees the gate
#       couldn't verify and can check manually; exit 0 (fail-open by
#       policy — don't block offline workflows). PR #671 (2026-05-27)
#       merged with `Closes (#668).` because this branch silently
#       swallowed the failure with `|| true`; the user only saw #668
#       stayed OPEN post-merge.
#   (2) `gh pr view` succeeded but body is empty — legitimate state
#       (PR with no body literally has nothing to match against). The
#       grep below handles empty input cleanly; no warning needed.
# WHICH REPO the number belongs to. `gh pr view <N>` with no repo resolves
# against the hook process's cwd -- the SESSION's repo -- so a cross-repo merge
# was checked against a completely different PR that happens to share the
# number. Measured 2026-08-25: `gh pr merge 553 -R go-to-k/cdk-local`, run from
# a cdk-local worktree, was refused citing line 73 of cdkd's PR 553, a Firehose
# bundle with nothing to do with it. The cdk-local PR's body is 41 lines long.
#
# Both directions are wrong, and the silent one is worse than the false block:
# the same mismatch passes a real `Closes (#N)` whenever the session's PR of
# that number happens to be clean. `post-merge-orphan-push-gate` had the same
# defect (go-to-k/cdkd#2199) and this is the same fix -- honour the `-R` in the
# command first, then the directory the command runs in.
# The payload cwd, which this hook never read -- so even the fallback below
# resolved against the HOOK PROCESS directory rather than the one the
# command runs in.
hook_cwd=$(jq -r '.cwd // empty' <<<"$input_json" 2>/dev/null || true)

gh_repo_args=()
if [[ "$trimmed" =~ (^|[[:space:]])(-R|--repo)(=|[[:space:]]+)([^[:space:]\"\']+) ]]; then
  gh_repo_args=(-R "${BASH_REMATCH[4]}")
fi
gh_cwd=$(cmd_last_cd_target "$trimmed" "${hook_cwd:-$PWD}" "$GATE_RE_GH_PR_MERGE" 2>/dev/null || true)
[[ -n "$gh_cwd" && -d "$gh_cwd" ]] || gh_cwd="${hook_cwd:-$PWD}"

gh_stderr=$(mktemp)
trap 'rm -f "$gh_stderr"' EXIT
if ! body=$( (cd "$gh_cwd" 2>/dev/null || exit 1; gh pr view "${gh_repo_args[@]}" "$pr_num" --json body -q .body) 2>"$gh_stderr"); then
  {
    echo "⚠️  closes-paren-form-gate could not fetch PR #$pr_num body"
    echo "    (\`gh pr view\` exited non-zero — likely network / auth /"
    echo "     rate-limit). The merge will proceed, but the"
    echo "     'Closes (#N)' auto-close trap check did NOT run. If your"
    echo "     PR body uses 'Closes #N' or no close keyword at all, you"
    echo "     can ignore this warning. If you used 'Closes (#N)'"
    echo "     parens-form, the target issue will stay OPEN and you'll"
    echo "     need to manually \`gh issue close <N>\` after the merge."
    echo ""
    echo "     gh stderr:"
    sed 's/^/       /' "$gh_stderr"
  } >&2
  exit 0
fi

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
