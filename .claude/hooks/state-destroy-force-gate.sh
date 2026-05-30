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

# Only gate git commit — anything else passes through.
if ! printf '%s' "$cmd" | grep -qE '\bgit[^|;&]*\bcommit\b'; then
  exit 0
fi

target_dir="${hook_cwd:-$PWD}"

# Leading `cd <path> && ...` shifts the target dir.
if [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
  cd_target="${BASH_REMATCH[1]}"
  cd_target="${cd_target%\"}"; cd_target="${cd_target#\"}"
  cd_target="${cd_target%\'}"; cd_target="${cd_target#\'}"
  if [[ "$cd_target" != /* ]]; then
    cd_target="$target_dir/$cd_target"
  fi
  target_dir="$cd_target"
fi

# Last `git -C <path>` wins.
if [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
  c_target=""
  remaining="$cmd"
  while [[ "$remaining" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; do
    c_target="${BASH_REMATCH[1]}"
    remaining="${remaining#*"${BASH_REMATCH[0]}"}"
  done
  c_target="${c_target%\"}"; c_target="${c_target#\"}"
  c_target="${c_target%\'}"; c_target="${c_target#\'}"
  if [[ "$c_target" != /* ]]; then
    c_target="$target_dir/$c_target"
  fi
  target_dir="$c_target"
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

    # Anchor on `state destroy` (cdkd subcommand) AND `--force`.
    # Use grep with extended regex to be tolerant of varying whitespace.
    if printf '%s' "$line" | grep -qE 'state[[:space:]]+destroy\b' \
       && printf '%s' "$line" | grep -qE '(\-\-force\b|[[:space:]]\-f\b)'; then
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
