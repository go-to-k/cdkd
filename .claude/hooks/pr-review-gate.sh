#!/usr/bin/env bash
# pr-review-gate.sh
#
# PreToolUse hook. Blocks `gh pr merge` (including --auto) on PRs
# whose size + bias factors trigger the /review-pr skill's
# `1-reviewer` or `3-axis` recommendation, unless the `pr-review`
# markgate marker is fresh AND bound to the PR's current HEAD sha.
#
# `gh pr create` is intentionally NOT gated — opening a PR for review
# should be allowed freely; the gate only fires at merge time.
# `inline`-tier PRs (small / docs-only / etc.) always pass through,
# matching the skill's own "no dispatch needed" recommendation.
#
# Sentinel-based PR-sha binding: the skill writes the PR's HEAD sha
# into `.markgate-pr-review-sha` (gitignored) right before
# `markgate set pr-review`. The gate's `include:` scope in
# .markgate.yml is just that file, so a new push to the PR rewrites
# the sentinel (next /review-pr run) and `markgate verify` reports
# stale automatically. No bespoke sha tracking inside the hook.
#
# This is the structural enforcement of the "sub-agent self-review
# is not independent review" rule — see PR #267 / issue #270 and
# memory rule feedback_subagent_review_not_self_review.md.

set -u

# Read the PreToolUse payload (command + cwd) once — separate jq
# invocations would consume stdin twice.
input=$(cat 2>/dev/null || true)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `gh pr merge` (incl. --auto). Anything else passes through.
# Tolerate an optional `gh -C <path>` between `gh` and `pr`. Line-start
# anchored (per memory rule feedback_hook_command_match_line_start.md)
# so `gh pr merge` substrings inside quoted argument bodies
# (`echo "remember to gh pr merge later"`) do NOT false-positive
# into a hard block. The optional leading `cd <path> &&` prefix
# preserves the worktree-aware `cd <side> && gh pr merge` chain
# shape, mirroring check-gate.sh (PR #562 fix pattern).
if ! printf '%s' "$cmd" | grep -qE '^[[:space:]]*(cd[[:space:]]+[^[:space:]]+[[:space:]]*&&[[:space:]]*)?gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+merge([[:space:]]|$|[|;&`)])'; then
  exit 0
fi

# Resolve where the gh command will actually run (cwd-aware; cdkd #559).
#
# `gh pr merge` is a working-tree-agnostic remote operation, but
# markgate's marker is stored per-worktree at
# `<git rev-parse --absolute-git-dir>/markgate/`. The pre-#559
# implementation always landed in the main tree (via
# `git rev-parse --git-common-dir`'s parent), defeating markgate's
# per-worktree isolation and forcing every parallel agent to converge
# on the main tree's state — the actual root cause of the cross-agent
# edit-race documented in memory rule
# feedback_cross_agent_main_tree_contention.md.
#
# Post-#559: the marker lands in the SAME worktree where
# `/review-pr <N>` ran (via `mise exec -- markgate set pr-review`).
# The convention shift is: set markers from the worktree you intend to
# merge from. The sentinel `.markgate-pr-review-sha` is already
# per-worktree (each worktree has its own root), so concurrent agents
# on different PRs in different worktrees no longer clobber each
# other's sentinels.
target_dir="${hook_cwd:-$PWD}"

if [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
  cd_target="${BASH_REMATCH[1]}"
  cd_target="${cd_target%\"}"; cd_target="${cd_target#\"}"
  cd_target="${cd_target%\'}"; cd_target="${cd_target#\'}"
  if [[ "$cd_target" != /* ]]; then
    cd_target="$target_dir/$cd_target"
  fi
  target_dir="$cd_target"
fi

if [[ "$cmd" =~ gh[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
  c_target=""
  remaining="$cmd"
  while [[ "$remaining" =~ gh[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; do
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

if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

cd "$target_dir" 2>/dev/null || exit 0

# --- Parse the PR number from the command. -----------------------------
# Accepted shapes (gh pr merge syntax):
#   gh pr merge 123
#   gh pr merge 123 --auto
#   gh pr merge --auto 123
#   gh pr merge --squash --auto 123
#   gh pr merge --auto    (no number; merges PR for current branch)
#
# Take the first bare numeric token after `merge`, ignoring flag
# values. If no numeric token is found, we fall back to gh's "PR for
# current branch" semantics by passing no positional arg.
pr_number=""
# Strip everything up to and including the LAST `gh pr merge` so we only
# scan its args. Greedy `##*PATTERN` (not the shortest `#*PATTERN`) so a
# Bash comment containing the bare word "merge" earlier in the command
# (e.g. `# Wait + merge\ngh pr merge 498`) doesn't cause us to read the
# wrong token as the PR number. Matching on the full `gh pr merge` phrase
# (not bare `merge`) is the load-bearing tightening — the prior `#*merge`
# also matched merge inside `git merge`, `--no-merge`, branch names, etc.
args="${cmd##*gh pr merge}"
# shellcheck disable=SC2086
set -- $args
while [ $# -gt 0 ]; do
  case "$1" in
    --*=*) shift; continue ;;
    --auto|--admin|--delete-branch|--squash|--merge|--rebase)
      shift; continue ;;
    -*)
      # Flag that may take a value; skip the next token defensively.
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

# --- Fetch PR stats via gh. --------------------------------------------
# Pass-through on any gh error so an unrelated infra outage doesn't
# block merges (mirrors integ-destroy-gate.sh's posture).
if [ -n "$pr_number" ]; then
  pr_json=$(gh pr view "$pr_number" \
    --json additions,deletions,changedFiles,files,headRefOid 2>/dev/null) || {
    printf 'pr-review-gate: gh pr view %s failed; allowing merge (infra fail-open)\n' "$pr_number" >&2
    exit 0
  }
else
  pr_json=$(gh pr view \
    --json additions,deletions,changedFiles,files,headRefOid,number 2>/dev/null) || {
    echo "pr-review-gate: gh pr view failed; allowing merge (infra fail-open)" >&2
    exit 0
  }
  pr_number=$(printf '%s' "$pr_json" | jq -r '.number // ""' 2>/dev/null || echo "")
fi

# Parse counts.
loc=$(printf '%s' "$pr_json" | jq -r '(.additions // 0) + (.deletions // 0)' 2>/dev/null || echo 0)
fc=$(printf '%s' "$pr_json" | jq -r '.changedFiles // 0' 2>/dev/null || echo 0)
head_sha=$(printf '%s' "$pr_json" | jq -r '.headRefOid // ""' 2>/dev/null || echo "")
paths=$(printf '%s' "$pr_json" | jq -r '.files[].path' 2>/dev/null || echo "")

# Defensive: if any number is empty, fail open.
if [ -z "$loc" ] || [ -z "$fc" ]; then
  echo "pr-review-gate: could not parse PR stats; allowing merge (fail-open)" >&2
  exit 0
fi

# --- Compute final tier per the /review-pr heuristic. ------------------
# Reference: .claude/skills/review-pr/SKILL.md (steps 2-4). Logic
# duplicated here in Bash for hook-time evaluation; the duplication
# is intentional and documented — the skill is the source of truth
# for output formatting and dispatch prompts, the hook only needs
# the final tier name. Keep these two in sync when editing.

# Base tier from (loc, fc):
#   loc < 300 OR fc < 5            -> inline
#   300 <= loc < 1000 AND 5 <= fc < 10 -> 1-reviewer
#   loc >= 1000 OR fc >= 10        -> 3-axis
base_tier="inline"
if [ "$loc" -ge 1000 ] || [ "$fc" -ge 10 ]; then
  base_tier="3-axis"
elif [ "$loc" -ge 300 ] && [ "$fc" -ge 5 ]; then
  base_tier="1-reviewer"
fi

# Bias factor scan.
# Up-bias triggers: any path under security / process-launch surface
# OR src/provisioning/providers/**.
# Also: > 1 fix-back commit on the PR branch (multi-subagent heuristic).
up_bias=0
down_bias=0

# Up-bias path patterns. Sourced verbatim from the skill's list.
UP_PATH_REGEX='^(src/utils/role-arn\.ts|src/local/cognito-jwt\.ts|src/local/lambda-authorizer\.ts|src/local/docker-runner\.ts|src/local-invoke/docker-runner\.ts|src/local/docker-image-builder\.ts|src/local/ecr-puller\.ts|src/provisioning/providers/.*)$'

# Down-bias buckets. Either ALL paths are docs/infra, or ALL paths
# are tests. Mixed → no down-bias.
DOWN_DOCS_REGEX='^(\.gitignore|CLAUDE\.md|README\.md|docs/.*|\.claude/skills/.*|\.claude/agents/.*|\.claude/hooks/.*|\.claude/rules/.*|\.claude/settings.*\.json|\.markgate\.yml|package\.json)$'
DOWN_TESTS_REGEX='^tests/.*'

all_docs=1
all_tests=1
saw_path=0
while IFS= read -r p; do
  [ -z "$p" ] && continue
  saw_path=1
  if printf '%s' "$p" | grep -qE "$UP_PATH_REGEX"; then
    up_bias=1
  fi
  if ! printf '%s' "$p" | grep -qE "$DOWN_DOCS_REGEX"; then
    all_docs=0
  fi
  if ! printf '%s' "$p" | grep -qE "$DOWN_TESTS_REGEX"; then
    all_tests=0
  fi
done <<EOF_PATHS
$paths
EOF_PATHS

if [ "$saw_path" -eq 1 ] && { [ "$all_docs" -eq 1 ] || [ "$all_tests" -eq 1 ]; }; then
  down_bias=1
fi

# Multi-subagent fix-back heuristic. Same data as the skill: count
# commits on the PR branch whose message starts with `fix:` / `fix(`.
# We don't have the branch name yet at hook time; derive it from gh.
branch=$(printf '%s' "$pr_json" | jq -r '.headRefName // ""' 2>/dev/null || echo "")
if [ -n "$branch" ] && git rev-parse --verify --quiet "origin/$branch" >/dev/null 2>&1; then
  fix_count=$(git log "origin/main..origin/$branch" --oneline 2>/dev/null \
    | grep -cE '^[a-f0-9]+ fix(\(|:)' || echo 0)
  if [ "${fix_count:-0}" -gt 1 ]; then
    up_bias=1
  fi
fi

# Resolve precedence: if both fire, up wins (security beats convenience).
if [ "$up_bias" -eq 1 ]; then
  down_bias=0
fi

# Apply bias to base.
final_tier="$base_tier"
if [ "$up_bias" -eq 1 ]; then
  case "$base_tier" in
    inline) final_tier="1-reviewer" ;;
    1-reviewer) final_tier="3-axis" ;;
    3-axis) final_tier="3-axis" ;;  # clamp
  esac
elif [ "$down_bias" -eq 1 ]; then
  case "$base_tier" in
    3-axis) final_tier="1-reviewer" ;;
    1-reviewer) final_tier="inline" ;;
    inline) final_tier="inline" ;;  # clamp
  esac
fi

# --- inline tier: always pass through. ---------------------------------
if [ "$final_tier" = "inline" ]; then
  exit 0
fi

# --- 1-reviewer / 3-axis: verify the marker. ---------------------------
if command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
elif command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
else
  echo "Blocked by pr-review-gate: markgate is not installed. Run 'mise install' at the repo root (see CONTRIBUTING.md)." >&2
  exit 2
fi

"${markgate[@]}" verify pr-review >/dev/null 2>&1
status=$?

# Also verify the sentinel file's content matches the PR's HEAD sha.
# markgate verify already enforces this via the digest, but reading
# the sentinel directly lets the error message name the mismatch
# explicitly ("marker bound to <other-sha>, PR is at <current-sha>")
# rather than the generic "(digest differs)" markgate emits.
recorded_sha=""
if [ -f .markgate-pr-review-sha ]; then
  recorded_sha=$(head -c 100 .markgate-pr-review-sha 2>/dev/null | tr -d '[:space:]')
fi

if [ "$status" -eq 0 ] && [ -n "$head_sha" ] && [ "$recorded_sha" = "$head_sha" ]; then
  exit 0
fi

# Render the block message. Names the offending PR, the resolved tier,
# the stats that produced it, and the required action.
pr_label="${pr_number:-<current-branch-PR>}"
sha_short=$(printf '%s' "$head_sha" | cut -c1-7)

cat >&2 <<EOF_HEAD
Blocked by pr-review-gate: PR #${pr_label} (${loc} LOC, ${fc} files) requires \`${final_tier}\` review before merge.

PR HEAD sha: ${sha_short:-<unknown>}
Marker state: $(if [ -n "$recorded_sha" ]; then printf 'bound to %s (mismatch)' "$(printf '%s' "$recorded_sha" | cut -c1-7)"; else printf 'unset'; fi)

EOF_HEAD

cat >&2 <<'EOF'
Required action:
  /review-pr <PR-number>

The skill applies the size + bias heuristic, dispatches the recommended
reviewer count (1 or 3), waits for findings, and sets the pr-review
marker bound to the current PR HEAD sha ONLY when no blockers remain.

The skill is the ONLY legitimate setter of this marker. Do NOT call
`markgate set pr-review` directly — the whole point of the gate is
that an un-reviewed large / security-sensitive PR cannot reach main.
A new push to the PR invalidates the marker automatically (the
sentinel rewrite changes the digest), so re-run /review-pr after
addressing reviewer findings.

If the orchestrator believes the heuristic is wrong for this PR
(e.g. a 1500-LOC mechanical rename that genuinely needs no review),
the correct path is a code-comment in the PR explaining why and a
manual `markgate set pr-review` with the user's explicit go-ahead.
EOF
exit 2
