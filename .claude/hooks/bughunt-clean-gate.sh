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

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Gate only `git commit`, `gh pr create`, and `gh pr merge`. Line-start anchored
# (tolerating an optional `cd <path> &&` prefix and `gh -C <path>`) so the
# command words inside a quoted argument body do NOT false-positive.
git_commit_re='^[[:space:]]*(cd[[:space:]]+[^[:space:]]+[[:space:]]*&&[[:space:]]*)?git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+commit([[:space:]]|$)'
gh_pr_re='^[[:space:]]*(cd[[:space:]]+[^[:space:]]+[[:space:]]*&&[[:space:]]*)?gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+(create|merge)([[:space:]]|$|[|;&`)])'

if ! printf '%s' "$cmd" | grep -qE "$git_commit_re" \
  && ! printf '%s' "$cmd" | grep -qE "$gh_pr_re"; then
  exit 0
fi

# Resolve where the command runs (cwd-aware; mirrors the other gates).
target_dir="${hook_cwd:-$PWD}"
if [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
  cd_target="${BASH_REMATCH[1]}"
  cd_target="${cd_target%\"}"; cd_target="${cd_target#\"}"
  cd_target="${cd_target%\'}"; cd_target="${cd_target#\'}"
  [[ "$cd_target" != /* ]] && cd_target="$target_dir/$cd_target"
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
sentinel="${main_root}/.markgate-bughunt-pending"

# Sentinel absent or empty → no pending bug-hunt resources → pass.
[ -s "$sentinel" ] || exit 0

pending=$(grep -cvE '^[[:space:]]*$' "$sentinel" 2>/dev/null || echo 0)
[ "$pending" -gt 0 ] || exit 0

{
  echo "Blocked by bughunt-clean-gate: a /hunt-bugs session still has"
  echo "${pending} un-destroyed stack(s) tracked in:"
  echo "  ${sentinel}"
  echo
  echo "Pending stacks:"
  sed 's/^/  - /' "$sentinel"
  echo
  echo "Required action — destroy every tracked stack, verify zero orphans,"
  echo "then release the gate:"
  echo "  node dist/cli.js destroy <Stack> --state-bucket <bucket> --force   # each stack"
  echo "  .claude/skills/hunt-bugs/bughunt-track.sh verify --state-bucket <bucket>"
  echo "  .claude/skills/hunt-bugs/bughunt-track.sh clear"
  echo
  echo "Do NOT delete the sentinel by hand to bypass this — the whole point is"
  echo "that bug-hunt resources cannot be forgotten. Clear it only after the"
  echo "destroy + orphan-zero verification actually passed."
} >&2
exit 2
