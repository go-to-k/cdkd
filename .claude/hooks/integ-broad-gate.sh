#!/usr/bin/env bash
# integ-broad-gate.sh
#
# PreToolUse hook. Blocks `gh pr merge` (including --auto) when the
# PR's diff touches cross-cutting deploy/destroy code AND the
# `integ-broad` markgate marker is stale.
#
# Why this gate exists (PR #348 incident, 2026-05-13):
#
#   The `integ-destroy` marker is content-digest based and accepts ANY
#   clean real-AWS destroy. A narrow feature integ (e.g. PR #348's
#   `import-value-strong-ref`: 2-stack S3 + SSM fixture) IS sufficient
#   to flip `integ-destroy` green. But that fixture does NOT exercise
#   VPC + NAT GW + Lambda hyperplane ENI lifecycle, multi-resource
#   destroy ordering, Custom Resource flows, etc. — all of which the
#   cross-cutting modification (DeployEngine, destroy-runner, intrinsic
#   resolver, dag-builder) WILL touch indirectly.
#
#   PR #348 shipped that way and was flagged as an incident
#   post-merge — a follow-up bench-cdk-sample + basic regression
#   check revealed three perf overhead spots the narrow integ
#   couldn't have shown.
#
# How this gate enforces it:
#
#   1. The PR's diff is checked against the cross-cutting scope (see
#      CROSS_CUTTING_REGEX below). Non-cross-cutting PRs pass through.
#   2. For cross-cutting PRs, `markgate verify integ-broad` must pass.
#      The `integ-broad` gate's include scope is the sentinel file
#      `.markgate-broad-integ-test` which /run-integ writes ONLY when
#      the test name is in the broad set (bench-cdk-sample, lambda,
#      microservices, drift-revert, drift-revert-vpc, multi-stack-deps,
#      multi-resource, remove-protection). Narrow integs don't touch
#      the sentinel, so they don't refresh this marker.
#   3. The marker also carries the 14d TTL of integ-destroy / integ-local
#      so AWS-side drift forces a fresh broad run periodically.
#
# Set ONLY by /run-integ; never call `markgate set integ-broad` by hand
# (same rule as the other AWS-coupled gates).

set -u

# Resolve repo root from script location, accounting for worktrees by
# preferring the shared `.git` parent (same pattern as pr-review-gate.sh
# after PR #339). The hook may run from any worktree; the sentinel +
# marker live in the main tree.
SCRIPT_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if git_common=$(git -C "$SCRIPT_REPO" rev-parse --git-common-dir 2>/dev/null); then
  case "$git_common" in
    /*) abs_common="$git_common" ;;
    *)  abs_common="$SCRIPT_REPO/$git_common" ;;
  esac
  REPO="$(cd "$(dirname "$abs_common")" 2>/dev/null && pwd)" || REPO="$SCRIPT_REPO"
else
  REPO="$SCRIPT_REPO"
fi

# Read the PreToolUse payload (command + cwd).
input=$(cat 2>/dev/null || true)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Only gate `gh pr merge` (including --auto). Every other command,
# including `gh pr create`, passes through — opening a PR for review
# should always be allowed.
if ! printf '%s' "$cmd" | grep -qE '\bgh[[:space:]]+pr[[:space:]]+merge\b'; then
  exit 0
fi

cd "$REPO" 2>/dev/null || exit 0

# Cross-cutting code paths whose modification can affect EVERY user's
# deploy/destroy, not just the feature scenario the PR adds. Keep in
# sync with the same list in .claude/skills/verify-pr/SKILL.md
# (step 6, "CROSS-CUTTING CHECK") and the memory rule
# feedback_cross_cutting_needs_broad_integ.md.
CROSS_CUTTING_REGEX='^src/deployment/(deploy-engine|intrinsic-function-resolver)\.ts$|^src/cli/commands/(destroy-runner|destroy|deploy)\.ts$|^src/analyzer/(dag-builder|template-parser)\.ts$|^src/provisioning/register-providers\.ts$'

# --- Extract PR number from the `gh pr merge` command and fetch the
# actual PR diff via `gh pr view --json files`. Same pattern as
# `pr-review-gate.sh`. Avoids the bug where the hook computes the
# diff against the local main worktree's HEAD when `gh pr merge`
# runs from a worktree whose main repo is checked out to a different
# branch — typical with concurrent agent worktrees.
#
# `gh pr merge` argument shapes:
#   gh pr merge 123                          (positional)
#   gh pr merge --auto --squash 123          (flags + positional)
#   gh pr merge                              (no number: gh resolves
#                                             the PR for the current
#                                             branch automatically)
pr_number=""
args="${cmd#*merge}"
# shellcheck disable=SC2086
set -- $args
while [ $# -gt 0 ]; do
  case "$1" in
    --*=*) shift; continue ;;
    --auto|--admin|--delete-branch|--squash|--merge|--rebase)
      shift; continue ;;
    -*)
      shift
      [ $# -gt 0 ] && shift
      continue
      ;;
    *)
      if printf '%s' "$1" | grep -qE '^[0-9]+$'; then
        pr_number="$1"
        break
      fi
      shift
      ;;
  esac
done

# Pass-through on any gh error so an unrelated infra outage doesn't
# block merges (mirrors integ-destroy-gate.sh / pr-review-gate.sh).
if [ -n "$pr_number" ]; then
  pr_json=$(gh pr view "$pr_number" --json files 2>/dev/null) || {
    printf 'integ-broad-gate: gh pr view %s failed; allowing merge (infra fail-open)\n' "$pr_number" >&2
    exit 0
  }
else
  pr_json=$(gh pr view --json files 2>/dev/null) || {
    echo "integ-broad-gate: gh pr view failed; allowing merge (infra fail-open)" >&2
    exit 0
  }
fi

paths=$(printf '%s' "$pr_json" | jq -r '.files[].path' 2>/dev/null || echo "")

cross_cutting=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if printf '%s' "$f" | grep -qE "$CROSS_CUTTING_REGEX"; then
    cross_cutting=1
    break
  fi
done <<EOF_FILES
$paths
EOF_FILES

if [ "$cross_cutting" -eq 0 ]; then
  exit 0
fi

# Resolve markgate (prefer the `.mise.toml`-pinned version).
if command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
elif command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
else
  echo "Blocked by integ-broad-gate: markgate is not installed. Run 'mise install' at the repo root (see CONTRIBUTING.md)." >&2
  exit 2
fi

"${markgate[@]}" verify integ-broad >/dev/null 2>&1
status=$?
if [ "$status" -eq 0 ]; then
  exit 0
fi

# Extract the parenthesized reason (`digest differs` vs `expired by ttl`
# vs `marker missing`) for a more actionable error message.
reason=$("${markgate[@]}" status integ-broad 2>/dev/null \
  | awk '/^state:/ { if (match($0, /\([^)]+\)/)) print substr($0, RSTART, RLENGTH); exit }')

if [ -n "$reason" ]; then
  printf "Blocked by integ-broad-gate: this PR touches cross-cutting deploy/destroy code and the \`integ-broad\` marker is stale %s.\n\n" "$reason" >&2
else
  cat >&2 <<'EOF_HEAD'
Blocked by integ-broad-gate: this PR touches cross-cutting
deploy/destroy code (DeployEngine, destroy-runner, IntrinsicFunctionResolver,
DagBuilder, TemplateParser, or register-providers) and the
`integ-broad` marker is stale or missing.

EOF_HEAD
fi

cat >&2 <<'EOF'
Why: the narrow `integ-destroy` gate accepts ANY clean real-AWS
destroy. A 2-stack feature fixture is enough to flip it, but does
NOT exercise the multi-resource VPC / Lambda / Custom-Resource paths
that a cross-cutting code change touches indirectly. PR #348 shipped
that way and surfaced post-merge as an incident — broad integs
became required for this scope.

Required action — no exceptions:
  /run-integ bench-cdk-sample      # 39-resource VPC+NAT+CF+Lambda+SQS
  # or one of (the canonical broad-set is duplicated in
  # .claude/skills/run-integ/SKILL.md step 11 + .markgate.yml
  # integ-broad gate's docs + CLAUDE.md "integ-broad" entry — keep
  # all four in sync):
  /run-integ lambda
  /run-integ microservices
  /run-integ drift-revert
  /run-integ drift-revert-vpc
  /run-integ multi-stack-deps
  /run-integ multi-resource
  /run-integ remove-protection
  /run-integ export

The skill is the ONLY legitimate setter of this marker. It will run
deploy + destroy against real AWS and only call
`markgate set integ-broad` if BOTH of the following hold:
  - the test name is in the broad set above
  - destroy completed with 0 errors and 0 orphan resources

Do NOT call `markgate set integ-broad` directly from a shell to
bypass this hook. The whole point of the gate is that an unverified
broad regression cannot reach main; setting the marker by hand
defeats it.

If you believe the file in scope is genuinely unrelated to the
broad deploy/destroy path, the right fix is to narrow the
CROSS_CUTTING_REGEX in this hook, not to bypass the marker.
EOF
exit 2
