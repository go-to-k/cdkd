#!/usr/bin/env bash
# bughunt-clean-gate.sh
#
# PreToolUse hook. Blocks `git commit`, `gh pr create`, and `gh pr merge` while
# a /hunt-bugs session still has un-destroyed AWS resources tracked in the
# sentinel `.markgate-bughunt-pending` (at the shared main-tree root).
#
# WHY: /hunt-bugs deploys real AWS resources to find latent cdkd bugs. The one
# unacceptable outcome is forgetting to destroy them. Rather than trust the
# operator to remember, the skill records every deployed stack in the sentinel
# via `bughunt-track.sh add`, and this gate makes it physically impossible to
# land any commit / PR until `bughunt-track.sh clear` empties the sentinel —
# which the skill runs ONLY after destroy + orphan-zero verification. This is
# the structural counterpart of the CLAUDE.md "always destroy bug-hunt
# resources" rule: the rule says it, the hook enforces it.
#
# The sentinel is resolved at the SHARED main-tree root (via --git-common-dir)
# so a fix committed from a feature worktree still sees a sentinel armed from
# the main tree.

# Shared command-position matcher (issue #1455): catches the guarded verb
# after ANY chained command (`git push && gh pr create`), not just after an
# optional leading `cd`. See .claude/hooks/lib/command-match.sh.
# shellcheck source=lib/command-match.sh
__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked as
# `bash verify-pr-gate.sh` from inside the hooks dir), which would look for
# `<script-name>/lib/...`. Fall back to the cwd in that case.
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."
if ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null \
  || ! declare -F cmd_matches_verb >/dev/null \
  || ! declare -F cmd_last_cd_target >/dev/null \
  || ! declare -F strip_noncommand_spans >/dev/null; then
  # FAIL CLOSED. Without the helper `cmd_matches_verb` is undefined, the
  # `if ! cmd_matches_verb ...` guard below sees exit 127 (truthy for `!`),
  # and the hook would `exit 0` -- silently disabling the gate, which is the
  # exact failure mode this file exists to prevent. Refuse instead.
  echo "Blocked: .claude/hooks/lib/command-match.sh is missing or unloadable," >&2
  echo "so this gate cannot evaluate the command. Restore the file; do not" >&2
  echo "work around the gate." >&2
  exit 2
fi

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Matching goes through the SHARED command-position matcher
# (.claude/hooks/lib/command-match.sh, issue #1455): heredoc bodies and
# quoted spans are stripped, then the verb is matched at line start OR
# after a `&&` / `||` / `;` / `|` operator. That catches chained
# invocations the old line-start anchor missed, while a quoted mention
# still does not fire (it is removed rather than dodged by position).
git_commit_re='git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+commit([[:space:]]|$)'
gh_pr_re='gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+(create|merge)([[:space:]]|$|[|;&`)])'

if ! cmd_matches_verb "$cmd" "$git_commit_re" \
  && ! cmd_matches_verb "$cmd" "$gh_pr_re"; then
  exit 0
fi

# Resolve where the command runs (cwd-aware; mirrors the other gates).
target_dir="${hook_cwd:-$PWD}"
cd_target="$(cmd_last_cd_target "$cmd" "$target_dir" "$git_commit_re")"
if [[ -n "$cd_target" ]]; then
  target_dir="$cd_target"
fi

# Not a git repo (or git unavailable) → nothing to gate.
git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Resolve the shared main-tree root (parent of the common .git dir) so the
# sentinel is the same path regardless of which worktree this runs in.
git_common="$(git -C "$target_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -n "$git_common" ]; then
  main_root="$(dirname "$git_common")"
else
  main_root="$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || echo "$target_dir")"
fi
# Per-owner sentinel files live under this directory (one file per concurrent
# bug-hunt owner — see bughunt-track.sh's PARALLEL-SAFE DESIGN). The gate
# AGGREGATES across all owners on purpose: a shared repo must not accept a
# commit / PR while ANY hunt still has live resources. Only the destructive
# `clear` side is per-owner (so one agent can never release another's gate);
# the read-only block decision here is deliberately repo-wide.
pending_dir="${main_root}/.markgate-bughunt-pending.d"
# Legacy single-file sentinel (pre per-owner) is still honored so an in-flight
# upgrade or an older bughunt-track.sh writer is not silently un-gated.
legacy="${main_root}/.markgate-bughunt-pending"

# Collect every non-empty sentinel source (per-owner files + legacy flat file).
sources=()
if [ -d "$pending_dir" ]; then
  while IFS= read -r f; do
    [ -s "$f" ] && sources+=("$f")
  done < <(find "$pending_dir" -type f 2>/dev/null)
fi
[ -s "$legacy" ] && sources+=("$legacy")

# No sentinel sources → no pending bug-hunt resources → pass.
[ "${#sources[@]}" -gt 0 ] || exit 0

# Count non-blank stack lines across all sources. cat is guarded by the
# non-empty `sources` check above so it never reads stdin.
pending=$(cat "${sources[@]}" 2>/dev/null | grep -cvE '^[[:space:]]*$' || echo 0)
[ "$pending" -gt 0 ] || exit 0

{
  echo "Blocked by bughunt-clean-gate: a /hunt-bugs session still has"
  echo "${pending} un-destroyed stack(s) tracked under:"
  echo "  ${pending_dir}/"
  echo
  echo "Pending stacks:"
  cat "${sources[@]}" 2>/dev/null | grep -vE '^[[:space:]]*$' | sed 's/^/  - /'
  echo
  echo "Required action — destroy every tracked stack, verify zero orphans,"
  echo "then release the gate (run clear from the SAME worktree you armed from,"
  echo "or set CDKD_BUGHUNT_OWNER to the same value):"
  echo "  node dist/cli.js destroy <Stack> --state-bucket <bucket> --force   # each stack"
  echo "  .claude/skills/hunt-bugs/bughunt-track.sh verify --state-bucket <bucket>"
  echo "  .claude/skills/hunt-bugs/bughunt-track.sh clear"
  echo
  echo "Do NOT delete the sentinel by hand to bypass this — the whole point is"
  echo "that bug-hunt resources cannot be forgotten. Clear it only after the"
  echo "destroy + orphan-zero verification actually passed."
} >&2
exit 2
