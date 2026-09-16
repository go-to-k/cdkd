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
# The fix-back up-bias is computed from a source a history rewrite
# cannot erase (issue #2638) — see the "Multi-subagent fix-back
# heuristic" block below.
#
# This is the structural enforcement of the "sub-agent self-review
# is not independent review" rule — see PR #267 / issue #270 and
# memory rule feedback_subagent_review_not_self_review.md.

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
  || ! declare -F gate_matches >/dev/null \
  || ! declare -F gate_target_dir_strict >/dev/null \
  || ! declare -F gate_refuse_unresolved_target >/dev/null \
  || ! declare -F gate_gh_repo_slug >/dev/null \
  || ! declare -F gate_bounded >/dev/null \
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

# go-to-k/cdkd#2729: the load guard above covers the FUNCTIONS this hook calls
# and CANNOT see a missing CONSTANT. Reading one the library does not define
# aborts under `set -u` with exit 1, and per .claude/rules/hooks.md any exit
# that is not 2 propagates as a NON-BLOCKING error -- i.e. a PASS. Refuse
# instead, unconditionally and before the first constant is read, naming every
# GATE_* constant read below. NOT yet fenced as a class -- the fence was split
# out of this change and is tracked by go-to-k/cdkd#2826, so nothing
# mechanical notices a hook that reads a constant without this call.
if ! declare -F gate_require_const >/dev/null 2>&1; then
  # The helper itself is missing, so nothing below can be trusted either.
  echo "Blocked: .claude/hooks/lib/command-match.sh loaded but does not define" >&2
  echo "gate_require_const, so this gate cannot verify the constants it reads." >&2
  exit 2
fi
gate_require_const GATE_RE_GH_PR_MERGE

set -u

# `gate_bounded` MOVED TO `lib/command-match.sh` (go-to-k/cdkd#3273 review).
# It lived here while this was the only hook making a network call from inside a
# PreToolUse hook. `ci-green-gate` makes one too, and its `gh pr checks` was
# UNBOUNDED -- measured, `gh pr checks <n> -R <unroutable host>` takes 30 s
# against that hook's registered 20 s timeout, so the hook is KILLED and emits
# no exit 2, which is a silent PASS. Since go-to-k/cdkd#3273 the command TEXT
# can choose the host that stalls, so the bound stopped being optional there.
# Copying 70 lines of perl was the alternative; the library is where a shared
# mechanism goes ("the fix is one shared resolver, not 24 conditionals").
# Behaviour here is unchanged: the wrapped command's stderr is still discarded
# unless a caller sets `GATE_BOUNDED_KEEP_STDERR=1`, which this hook does not.

# A TIMEOUT on the PR lookup must fail CLOSED, and that is the whole point of
# telling it apart from an ordinary `gh` failure.
#
# The generic arm below allows the merge when `gh` errors -- an infra fail-open,
# deliberate and pre-existing. But a TIMEOUT is exactly the case the unbounded
# code handled correctly: it simply took longer and still produced a verdict.
# Routing a timeout into the fail-open would make a bound WEAKEN the gate.
# Measured on a 2000 LOC / 15 file PR with a stale marker, where the correct
# verdict is BLOCK: unbounded gave exit 2 at 9s and at 14s, while a bound that
# fell through to the fail-open gave exit 0. So: refuse, and say why.
gate_refuse_on_timeout() {
  [ "$1" -eq 124 ] || return 0
  printf 'Blocked by pr-review-gate: `gh pr view %s` timed out.\n\n' "$2" >&2
  printf 'The tier cannot be computed without the PR stats, and a timeout is not\n' >&2
  printf 'an answer -- allowing the merge here would let a stalled GitHub wave\n' >&2
  printf 'through exactly the large / security-sensitive PRs this gate exists\n' >&2
  printf 'for. Re-run the merge once `gh pr view %s` responds.\n' "$2" >&2
  exit 2
}

# gate_refuse_on_foreign_repo_failure <gh-rc> <pr-number> <repo-slug>
#
# THE INFRA FAIL-OPEN DOES NOT SURVIVE AN EXPLICIT `-R` (go-to-k/cdkd#3273).
# It is kept UNCHANGED for the ordinary cwd-relative merge -- an unrelated
# GitHub outage must not block those. But once the command names another
# repository, "the lookup failed" is far more likely to mean "that repository is
# not reachable from here" than a global outage, and passing then merges a PR
# whose size, files and head sha this gate never saw, in a repo whose review
# history it has never seen either. Same reasoning as the timeout arm above:
# a non-answer is not an answer.
#
# It is a no-op when no slug was named, so the everyday spelling is untouched
# by construction rather than by a condition anyone has to keep true.
gate_refuse_on_foreign_repo_failure() {
  [ -n "$3" ] || return 0
  printf 'Blocked by pr-review-gate: `gh pr view %s -R %s` failed (rc=%s).\n\n' \
    "${2:-(current branch)}" "$3" "$1" >&2
  printf 'This command names another repository, so there is no infra\n' >&2
  printf 'fail-open here: with the lookup failed the gate has no PR stats at\n' >&2
  printf 'all, and allowing the merge would wave through exactly the large /\n' >&2
  printf 'security-sensitive PRs it exists for -- in a repository whose review\n' >&2
  printf 'state this session has never read. Required action:\n\n' >&2
  printf '  gh pr view %s -R %s --json number   # confirm the slug resolves\n' \
    "${2:-<PR>}" "$3" >&2
  printf '  # or run the merge from that repository own checkout, which is\n' >&2
  printf '  # what .claude/rules/hooks.md prescribes for sibling-repo work.\n' >&2
  exit 2
}

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
# Matching goes through the SHARED command-position matcher
# (.claude/hooks/lib/command-match.sh, issue #1455): heredoc bodies and
# quoted spans are stripped, then the verb is matched at line start OR
# after a `&&` / `||` / `;` / `|` operator. That catches chained
# invocations the old line-start anchor missed, while a quoted mention
# still does not fire (it is removed rather than dodged by position).
if ! gate_matches "$cmd" "$GATE_RE_GH_PR_MERGE"; then
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
# Where the git/gh command will actually RUN.
#
# This calls the SHARED resolver in lib/command-match.sh, replacing the
# hand-rolled `-C` scan this hook used to carry. That copy captured the raw
# token with no guard for an unexpanded `$VAR`, so the standard worktree
# spelling `git -C "$W" ...` resolved to the literal `<cwd>/$W`, the repo
# probe below failed, and the gate exited 0 over a tree it never looked at
# (go-to-k/cdkd#2027). The strict resolver refuses instead of guessing.
__verb_ere="$GATE_RE_GH_PR_MERGE"
if ! target_dir=$(gate_target_dir_strict "$cmd" "${hook_cwd:-$PWD}" "$__verb_ere"); then
  gate_refuse_unresolved_target "pr-review-gate" "${hook_cwd:-$PWD}"
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
# The matched-verb strip, not a literal one: `${cmd##*gh pr merge}` returns
# the WHOLE command under `gh -R <owner/repo> pr merge`, and the walk below
# then reads an unrelated integer as the PR number. Measured 2026-08-25:
# `sleep 30 && gh -R go-to-k/cdkd pr merge 2195 --squash` resolved PR #30,
# so an unrelated PR's size decided the review tier.
# Call the shared selector rather than hand-walking its `_rest` output. The
# first version of this fix replaced the literal STRIP and left the walk, and a
# review measured the consequence: the local valueless list carried only LONG
# spellings, so `gh pr merge -d 2195` took the value-consuming arm, ate the
# number, and the gate judged the CURRENT BRANCH's PR instead. The fence for
# exactly that shape already existed -- inside `gate_pr_selector`, which this
# gate did not call. A fence in a helper protects only the callers that use it.
pr_number="$(gate_pr_selector "$cmd" "$GATE_RE_GH_PR_MERGE")"

# --- Parse the target REPO, and forward it (go-to-k/cdkd#3273). ---------
# The PR number was recovered from the command and the repository was not, so
# `gh pr view <n>` below asked about the repo the SHELL was in. MEASURED through
# this hook with an argv-recording `gh`, from a cdkd worktree:
# `gh pr merge 42 -R go-to-k/cdk-local --squash` produced the argv
# `pr view 42 --json …` -- no `-R`, so gh resolves the CWD's repo and the tier
# comes from cdkd's PR 42. An unrelated PR's diff choosing this one's review
# tier, and its `headRefOid` deciding what the `pr-review` sentinel is compared
# against, so a marker bound to the real PR reads as stale and one bound to the
# other repo's HEAD reads as fresh.
#
# The fix-back heuristic further down needs no separate change: it takes
# `owner` / `repo` from the PR's OWN `url`, which now comes from the right PR.
if ! repo_slug=$(gate_gh_repo_slug "$cmd" "$GATE_RE_GH_PR_MERGE"); then
  cat >&2 <<EOF
Blocked by pr-review-gate: this command names a repository with \`-R\` /
\`--repo\`, but the value is not literal text (an unexpanded \$VAR, a
substitution, or a trailing \`-R\` with no value), so this gate cannot
tell WHICH repository's pull request it would have to size.

Sizing the PR of whatever repo this shell is in is the go-to-k/cdkd#3273
defect, and here it decides a REVIEW TIER and the sha the pr-review
marker is bound to. Refusing instead.

  # spell the slug literally
  gh pr merge ${pr_number:-<PR>} -R <owner>/<repo> --squash --delete-branch

  # ...or run the merge from that repository's own checkout, with no -R
  cd <that repo> && gh pr merge ${pr_number:-<PR>} --squash --delete-branch
EOF
  exit 2
fi
# ABSENT rather than empty: `gh pr view -R ""` is not `gh pr view`. The
# `${a[@]+"${a[@]}"}` spelling is the one that survives `set -u` on bash 3.2,
# where a bare `"${a[@]}"` on an empty array aborts the hook.
__repo_args=()
[ -n "$repo_slug" ] && __repo_args=(-R "$repo_slug")

# --- Fetch PR stats via gh. --------------------------------------------
# Pass-through on any gh error so an unrelated infra outage doesn't
# block merges (mirrors integ-destroy-gate.sh's posture) -- EXCEPT when the
# command named another repository, where the failure is more likely to be
# "that repo is unreachable from here" and passing would let a PR this gate has
# learned nothing about merge unreviewed (go-to-k/cdkd#3273).
if [ -n "$pr_number" ]; then
  pr_json=$(gate_bounded 6 gh pr view "$pr_number" ${__repo_args[@]+"${__repo_args[@]}"} \
    --json additions,deletions,changedFiles,files,headRefOid,headRefName,commits,url)
  __gh_rc=$?
  gate_refuse_on_timeout "$__gh_rc" "$pr_number"
  if [ "$__gh_rc" -ne 0 ]; then
    gate_refuse_on_foreign_repo_failure "$__gh_rc" "$pr_number" "$repo_slug"
    printf 'pr-review-gate: gh pr view %s failed; allowing merge (infra fail-open)\n' "$pr_number" >&2
    exit 0
  fi
else
  pr_json=$(gate_bounded 6 gh pr view ${__repo_args[@]+"${__repo_args[@]}"} \
    --json additions,deletions,changedFiles,files,headRefOid,headRefName,commits,url,number)
  __gh_rc=$?
  gate_refuse_on_timeout "$__gh_rc" ""
  if [ "$__gh_rc" -ne 0 ]; then
    gate_refuse_on_foreign_repo_failure "$__gh_rc" "" "$repo_slug"
    echo "pr-review-gate: gh pr view failed; allowing merge (infra fail-open)" >&2
    exit 0
  fi
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

# Subtract auto-generated LOC before computing the tier — mirrors
# /review-pr references/pr-stats.md, step 1 (added after PR #404). Generated
# artifacts under docs/_generated/** and lockfiles inflate LOC without
# adding reviewer surface (reviewers audit the script that produced
# them, not the output line-by-line). Without this the hook and the
# skill disagree: PR #1082 was 37 substantive LOC (inline tier per the
# skill) but 2784 raw LOC (3-axis per the pre-fix hook) because
# pnpm-lock.yaml carried 2747 of them. `(^|/)` anchors match the
# lockfiles both at repo root (cdkd's actual layout) and in subdirs.
# `fc` is intentionally NOT adjusted — a many-file diff is still
# cross-cutting even when some files are generated.
autogen_excl=$(printf '%s' "$pr_json" | jq -r \
  '[.files[] | select(.path | test("^docs/_generated/|(^|/)pnpm-lock\\.yaml$|(^|/)package-lock\\.json$|(^|/)yarn\\.lock$")) | (.additions // 0) + (.deletions // 0)] | add // 0' \
  2>/dev/null || echo 0)
case "$autogen_excl" in
  ''|*[!0-9]*) autogen_excl=0 ;;  # fail-open to raw loc on parse oddity
esac
loc=$((loc - autogen_excl))
if [ "$loc" -lt 0 ]; then loc=0; fi

# --- Compute final tier per the /review-pr heuristic. ------------------
# Reference: .claude/skills/review-pr/SKILL.md step 2 (the base-tier
# table) and references/bias-factors.md (the triggers). Logic
# duplicated here in Bash for hook-time evaluation; the duplication
# is intentional and documented — the skill is the source of truth
# for output formatting (references/output-template.md) and dispatch
# prompts, the hook only needs the final tier name. Keep these in
# sync when editing; the security-surface list is fenced against this
# file by tests/unit/scripts/security-surface-list-sync.test.ts.

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
# Every CONCRETE-FILE alternative must name a file that EXISTS (the trailing
# `src/provisioning/providers/.*` is a directory glob, not a file). A dead
# path cannot fire, and it disguises the fact that the live surface went
# unlisted -- issue #1972: lambda-authorizer.ts after PR #691, local-invoke/
# after PR #228. Fenced by
# tests/unit/scripts/security-surface-list-sync.test.ts.
UP_PATH_REGEX='^(src/utils/role-arn\.ts|src/utils/docker-cmd\.ts|src/local/cognito-jwt\.ts|src/local/authorizer-resolver\.ts|src/local/authorizer-cache\.ts|src/local/sigv4-verify\.ts|src/local/agentcore-sigv4-sign\.ts|src/local/docker-runner\.ts|src/local/docker-image-builder\.ts|src/local/ecr-puller\.ts|src/local/ecs-secrets-resolver\.ts|src/local/ecs-task-runner\.ts|src/provisioning/providers/.*)$'

# Down-bias buckets. Either ALL paths are docs/infra, or ALL paths
# are tests. Mixed → no down-bias.
# Down-bias covers INERT documentation only. Files that change how the agent
# BEHAVES -- CLAUDE.md, .claude/rules, .claude/skills, .claude/agents,
# .claude/hooks, .claude/settings, .markgate.yml -- were in this set and are
# not any more: a wrong rule propagates to every future session, which is the
# opposite of low-risk. Keeping them here also made the hook disagree with
# `/review-pr`'s own text once that skill started saying they must not
# down-bias, so a large rules-only PR resolved to `1-reviewer` in the hook and
# `3-axis` in the skill. Keep this regex and the skill's down-bias list in sync.
DOWN_DOCS_REGEX='^(\.gitignore|README\.md|docs/.*|package\.json)$'
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

# --- Multi-subagent fix-back heuristic. --------------------------------
#
# Same signal as the skill: more than one `fix:` / `fix(` round on the PR means
# the diff was rewritten repeatedly, so review it harder.
#
# READ IT FROM SOMETHING A HISTORY REWRITE CANNOT ERASE (issue #2638). The only
# source used to be `git log origin/main..origin/<branch>`, i.e. the branch's
# CURRENT commits — so flattening the branch to one commit set the count to at
# most 1 and the bias could never fire, silently. Flattening is routine here:
# `flatten-before-rebase-gate.sh` prescribes it whenever the branch touches an
# append-shaped generated file. The gate was therefore strongest on the PRs
# that needed the least churn and weakest on the ones rewritten most — the
# inverse of the signal it encodes. Live on this repo's own history: PR #2634
# was flattened to a single `fix(deploy):` commit, so the old arm computed 1
# and no bias, while the PR had genuinely carried three distinct fix-back
# rounds.
#
# Two sources are unioned, and the count is the number of DISTINCT SUBJECT
# LINES matching `^fix(\(|:)` across them:
#
#   1. the PR's commits as GitHub reports them (`gh pr view --json commits`),
#      which needs no local fetch — the old `git rev-parse origin/<branch>`
#      guard silently skipped the whole check in a clone that had not fetched
#      the branch, and read the WRONG branch when a fork PR's head name
#      collided with a local remote-tracking ref. That local read is RETAINED
#      below as a FLOOR rather than removed, so a collision can still inflate
#      the count — the safe direction, and the price of never resolving lower
#      than the pre-#2638 hook did;
#   2. every commit the PR's TIMELINE recorded as a former HEAD — the
#      `before`/`after` commit of each force-push. GitHub keeps those after the
#      rewrite that abandoned them, so the round a flatten collapsed is still
#      named there.
#
# DISTINCT SUBJECTS, not distinct shas, is what keeps this from over-firing: an
# amend-and-force-push re-shas the same round, and every round of the same work
# keeps its subject through a rebase.
#
# MEASURED, by replaying BOTH hooks over the 60 most recently merged cdkd PRs
# and comparing the tier each one RESOLVES (not the raw count -- an earlier
# draft compared counts and reported the wrong number, because the skip below
# means a count can differ where the tier cannot): the tier differs on 4 --
# go-to-k/cdkd#2612 and go-to-k/cdkd#2570 inline -> 1-reviewer,
# go-to-k/cdkd#2593 and go-to-k/cdkd#2557 1-reviewer -> 3-axis. Exactly ONE of
# those, #2557, needs the TIMELINE; the other three come from source 1 alone.
# Read that cohort with its caveat: a merged PR's branch is deleted, so the old
# arm's `origin/<branch>` lookup finds nothing, which is source 1's defect
# rather than the flatten one. go-to-k/cdkd#2634 -- the flattened PR whose
# three fix-back rounds the old arm counted as 1 -- does NOT change tier: it is
# already 3-axis by size, so the skip below means this code never counts it.
#
# What a rewrite still CAN erase, so the claim is not overstated: rounds that
# SHARE a subject line. A flatten whose result reuses the last round's subject
# collapses to 1 here. That is strictly better than the old arm, which lost
# every round, but it is not "cannot erase" in the absolute.
#
# Both `gh` calls run under `gate_bounded` (see its comment for why SIGALRM
# alone does nothing to a Go binary). A timeline timeout falls back to the
# history floor -- safe, because the floor can only RAISE the count -- while a
# PR-lookup timeout refuses the merge, because without the stats there is no
# tier to check.
#
# The timeline query is skipped whenever it cannot change the outcome (an
# up-bias already fired, or the tier is 3-axis with nothing to cancel). That is
# NOT most merges -- an inline-tier PR is the common case and is not skippable,
# so budget one extra round-trip (~0.6s measured) on it. Worst case measured
# end to end -- a PR lookup answering just inside its bound, a timeline query
# that hangs to its bound plus the 0.5s TERM->KILL grace, and `markgate verify`
# -- is 10.7s against the hook's registered `timeout: 15`.
#
# One consequence worth naming rather than discovering: a GitHub that is slow
# but WORKING (over 6s on the PR lookup) now refuses a merge that would
# previously have succeeded. That is the deliberate direction -- an unanswered
# lookup is not a tier -- but it is a behaviour change, and re-running once
# GitHub responds is the whole remedy.
#
# Any failure leaves the history-derived count in place: never weaker than the
# pre-#2638 behaviour.
branch=$(printf '%s' "$pr_json" | jq -r '.headRefName // ""' 2>/dev/null || echo "")
hist_fix_count=0
if [ -n "$branch" ] && git rev-parse --verify --quiet "origin/$branch" >/dev/null 2>&1; then
  hist_fix_count=$(git log "origin/main..origin/$branch" --oneline 2>/dev/null \
    | grep -E '^[a-f0-9]+ fix(\(|:)' | wc -l | tr -d '[:space:]')
fi
case "$hist_fix_count" in ''|*[!0-9]*) hist_fix_count=0 ;; esac

fix_count="$hist_fix_count"
rewrite_fix_count=0
if [ "$up_bias" -eq 0 ] && ! { [ "$base_tier" = "3-axis" ] && [ "$down_bias" -eq 0 ]; }; then
  # `owner`/`repo` from the PR's own URL — no extra round trip, and no
  # dependence on the resolved worktree having a remote (it may be a fixture
  # repo, or a clone with a differently-named remote).
  pr_url=$(printf '%s' "$pr_json" | jq -r '.url // ""' 2>/dev/null || echo "")
  pr_slug=$(printf '%s' "$pr_url" | sed -n 's#^https\{0,1\}://[^/]*/\([^/]*\)/\([^/]*\)/pull/[0-9][0-9]*$#\1 \2#p')
  pr_owner="${pr_slug%% *}"
  pr_repo="${pr_slug#* }"
  # The URL is DATA -- it arrives from `gh pr view`, and a fork PR's repo name is
  # written by whoever opened it. `gh api -F key=value` treats a leading `@` as
  # "read this value from a file", so an unconstrained value is a file-read
  # primitive rather than a string. The sed capture already excludes `/`, which
  # bounds it to a relative name, but bound it properly instead of relying on
  # that: anything outside GitHub's own owner/repo alphabet skips the query, and
  # the count falls back to the PR's commits plus the history floor.
  case "$pr_owner$pr_repo" in
    ''|*[!A-Za-z0-9._-]*) pr_owner=""; pr_repo="" ;;
  esac

  subjects=$(printf '%s' "$pr_json" | jq -r '.commits[]?.messageHeadline // empty' 2>/dev/null || echo "")

  if [ -n "$pr_owner" ] && [ -n "$pr_repo" ] && [ -n "$pr_number" ]; then
    tl_json=$(gate_bounded 4 gh api graphql \
      -F owner="$pr_owner" -F repo="$pr_repo" -F number="$pr_number" \
      -f query='query($owner:String!,$repo:String!,$number:Int!){
        repository(owner:$owner,name:$repo){
          pullRequest(number:$number){
            timelineItems(first:100,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT]){
              nodes{... on HeadRefForcePushedEvent{
                beforeCommit{messageHeadline}
                afterCommit{messageHeadline}
              }}
            }
          }
        }
      }') || tl_json=""
    if [ -n "$tl_json" ]; then
      tl_subjects=$(printf '%s' "$tl_json" | jq -r '
        .data.repository.pullRequest.timelineItems.nodes[]?
        | (.beforeCommit.messageHeadline // empty), (.afterCommit.messageHeadline // empty)
      ' 2>/dev/null || echo "")
      subjects="$subjects
$tl_subjects"
    fi
  fi

  # `wc -l`, not `grep -c ... || echo 0`: grep exits 1 on no match, so the
  # `||` arm appends a SECOND count and the variable stops being a number.
  rewrite_fix_count=$(printf '%s\n' "$subjects" \
    | grep -E '^fix(\(|:)' \
    | sort -u \
    | wc -l | tr -d '[:space:]')
  case "$rewrite_fix_count" in ''|*[!0-9]*) rewrite_fix_count=0 ;; esac
  if [ "$rewrite_fix_count" -gt "$fix_count" ]; then
    fix_count="$rewrite_fix_count"
  fi
fi

fix_back_bias=0
if [ "$fix_count" -gt 1 ]; then
  up_bias=1
  fix_back_bias=1
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
#
# THIS COMPARISON IS THE BINDING'S ENFORCEMENT -- do not remove it as a
# duplicate of `markgate verify`. `verify` compares a DIGEST of the gate's
# scope, and the sentinel is in that scope, so REWRITING it stales the
# marker; but a sentinel nobody rewrote keeps its digest whatever the branch
# or the PR moved to, and `verify` reports `match` for a sentinel naming a
# different commit entirely. Measured on 2026-09-05 in an IN-PLACE
# `/work-issues` run (go-to-k/cdkd#2681): sentinel = a MERGED lane's tip,
# branch HEAD = PR `headRefOid` = another sha, `markgate verify pr-review`
# rc=0. A revision of this comment said the opposite -- that `verify`
# "already enforces this via the digest" and the read below only improves
# the message -- which made deleting the check look like a safe
# simplification. The explicit message ("marker bound to <other-sha>, PR is
# at <current-sha>") is a bonus, not the reason.
#
# Pinned by `.claude/hooks/pr-review-gate.test.sh`: case 7
# ("medium PR + fresh marker + sha mismatch -> block") and case 10
# ("large PR + fresh marker + sha mismatch -> block") -- a FRESH marker plus a
# sentinel holding a FOREIGN sha must still block. The ordinals are the
# suite's own (`# 7.` and `# 10.` head those cases); a review round called
# them invented and that was withdrawn on inspection.
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
Blocked by pr-review-gate: PR #${pr_label} (${loc} LOC excl. auto-generated files, ${fc} files) requires \`${final_tier}\` review before merge.

PR HEAD sha: ${sha_short:-<unknown>}
Marker state: $(if [ -n "$recorded_sha" ]; then printf 'bound to %s (mismatch)' "$(printf '%s' "$recorded_sha" | cut -c1-7)"; else printf 'unset'; fi)$(if [ "$fix_back_bias" -eq 1 ]; then printf '\nUp-bias: %s distinct fix-back rounds on this PR (the branch history alone shows %s).' "$fix_count" "$hist_fix_count"; fi)

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
