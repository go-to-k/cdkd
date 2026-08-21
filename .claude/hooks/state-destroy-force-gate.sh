#!/usr/bin/env bash
# state-destroy-force-gate.sh
#
# PreToolUse hook. Blocks `git commit` when a staged
# `tests/integration/**/*.sh` file adds a line that calls
# `cdkd state destroy ... --force` — the `state destroy` subcommand
# rejects `--force` with `error: unknown option '--force'`. It only
# accepts `-y` / `--yes` to skip the confirmation prompt.
#
# WHY (the trap this closes):
#   - The TOP-LEVEL `cdkd destroy` accepts BOTH `-y/--yes` AND
#     `-f/--force`.
#   - The `cdkd state destroy` SUBCOMMAND accepts `--yes` only.
#   - The `cdkd state orphan` SUBCOMMAND accepts `--force` (to
#     bypass the lock check).
#   So three sibling commands have three different flag sets; the
#   `state destroy --force` bug is silently swallowed in fixture
#   verify.sh cleanup() traps under `>/dev/null 2>&1` and only bites
#   when a deploy FAILS partway (the trap is then the only cleanup
#   path; the broken `state destroy` errors out and never removes the
#   leftover state file).
#
#   2026-05-30 verified that the 12 originally-named offenders have
#   all been swept; this hook is the structural enforcement that
#   prevents the regression from coming back.
#
# Scope:
#   - Only fires on `git commit` (passes through everything else).
#   - Only inspects staged `*.sh` files under `tests/integration/`
#     (and `tests/integration/**/verify.sh` etc.) — that is the only
#     scope where the bug pattern actually matters. Other scripts
#     under `scripts/`, `.claude/hooks/`, etc. are NOT scanned.
#   - Only flags added/modified lines (diff lines starting with '+',
#     excluding the '+++' file marker).
#
# No bypass marker — the fix is a literal 1-character swap
# (`--force` → `--yes`).
#
# Resolution of "where will the git command actually run" mirrors
# branch-gate.sh / internal-pr-labels-gate.sh.

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate git commit — anything else passes through. Recognition goes through
# the shared matcher (.claude/hooks/lib/command-match.sh, issue #2129): heredoc
# bodies and quoted spans are neutralised, then the verb is matched in COMMAND
# POSITION with any `VAR=value` / `env` / `command` / `nohup` prefix skipped. So
# `git add -A && git commit` and `GIT_EDITOR=true git commit` fire, while
# `echo "git commit"` — which the previous unanchored `\bgit...\bcommit\b`
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

# Where the git command actually runs: the last `git -C <path>` wins, else the
# last `cd <path>` in ANY segment before the verb (the previous form saw only a
# LEADING cd, so `git add -A && cd <wt> && git commit` resolved the wrong tree),
# else the payload cwd.
# FAIL CLOSED on a target this parser cannot read (go-to-k/cdkd#2027).
# gate_target_dir would DROP an unexpanded `-C "$W"` and judge the payload
# cwd instead -- measured as a silent pass when the violation lived in the
# target tree and the cwd was clean.
if ! target_dir=$(gate_target_dir_strict "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE_GIT_COMMIT"); then
  gate_refuse_unresolved_target "state-destroy-force-gate" "${hook_cwd:-$PWD}"
fi

# If the resolved target dir is not a git repo, silently pass — we
# can't audit what we can't see.
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# Filter to staged shell scripts under tests/integration/.
staged_files=$(git -C "$target_dir" diff --cached --name-only --diff-filter=AM 2>/dev/null \
  | grep -E '^tests/integration/.*\.sh$' || true)
if [[ -z "$staged_files" ]]; then
  exit 0
fi

# Walk each file's staged diff and look for `state destroy ... --force`
# on added lines (lines starting with '+', excluding '+++' marker).
# Match the literal `state destroy` followed (possibly across
# continuation) by `--force` or `-f` on the same line. The pattern is
# anchored on `state destroy` so a TOP-LEVEL `cdkd destroy ... --force`
# (which IS valid) does not false-positive.
#
# The match is intentionally case-sensitive and word-anchored so we
# don't match a comment that mentions the literal string for
# documentation purposes (e.g. `# state destroy rejects --force`) —
# the COMMENT will start with `# ` and we anchor on the actual
# command shape `state destroy <stack-or-flag>`.

declare -a OFFENDERS=()
MAX_REPORT=20

for rel in $staged_files; do
  # Pull the staged unified diff for this file (post-commit shape).
  diff=$(git -C "$target_dir" diff --cached --unified=0 -- "$rel" 2>/dev/null || true)
  [[ -z "$diff" ]] && continue

  # Walk added lines (skip '+++' header). Match `state destroy` on the
  # same line as `--force` or ` -f ` (space-separated to avoid matching
  # flag values that contain `-f` as a substring).
  while IFS= read -r raw_line; do
    # Only inspect '+' lines (added) — exclude the '+++ b/path' header
    [[ "$raw_line" != +* ]] && continue
    [[ "$raw_line" == +++* ]] && continue

    # Drop the leading '+'.
    line="${raw_line:1}"

    # Trim leading whitespace for comment detection.
    trimmed="${line#"${line%%[![:space:]]*}"}"

    # Skip comment lines — a `# state destroy rejects --force` doc
    # comment is documenting the bug, not exercising it.
    [[ "$trimmed" == \#* ]] && continue

    # ONE regex, ordered: `state destroy` FOLLOWED BY the flag. Testing the
    # two halves independently against the whole line matched a bash file
    # test that merely PRECEDES the invocation, e.g.
    #   [ -f "${LOCAL_DIST}" ] && node ... state destroy ... --yes
    # which is correct code; that false positive blocked the #1567 sweep the
    # moment it touched such a line. (Only the single `[ -f` site tripped it;
    # the `-x` spelling its 14 siblings use never did.)
    #
    # Ordering must be expressed IN the regex, not by pre-slicing the line
    # with `sed 's/^.*state destroy//'` — `.*` is greedy, so a line carrying
    # TWO invocations would slice past the first and miss a `--force` on it.
    # The header comment already described the intent as "`state destroy`
    # FOLLOWED BY `--force`"; only the check lagged.
    if printf '%s' "$line" \
       | grep -qE 'state[[:space:]]+destroy\b.*(\-\-force\b|[[:space:]]\-f\b)'; then
      OFFENDERS+=("$rel: $trimmed")
      [[ "${#OFFENDERS[@]}" -ge "$MAX_REPORT" ]] && break 2
    fi
  done <<<"$diff"
done

if [[ "${#OFFENDERS[@]}" -eq 0 ]]; then
  exit 0
fi

{
  echo "Blocked by state-destroy-force-gate: a staged"
  echo "tests/integration/**/*.sh file adds a 'cdkd state destroy ... --force'"
  echo "invocation. The 'state destroy' subcommand rejects --force"
  echo "(only --yes is accepted)."
  echo ""
  echo "Three sibling commands have three different flag sets:"
  echo "  - 'cdkd destroy'         accepts BOTH --yes AND --force"
  echo "  - 'cdkd state destroy'   accepts --yes only"
  echo "  - 'cdkd state orphan'    accepts --force (to bypass the lock)"
  echo ""
  echo "Offending lines:"
  for o in "${OFFENDERS[@]}"; do
    echo "  $o"
  done
  echo ""
  echo "Fix: literal 1-character swap on the state destroy line:"
  echo "  - --force"
  echo "  + --yes"
  echo ""
  echo "Memory rule:"
  echo "  ~/.claude/projects/-Users-goto-pc-github-cdkd/memory/feedback_state_destroy_force_invalid_verify_sh.md"
} >&2

exit 2
