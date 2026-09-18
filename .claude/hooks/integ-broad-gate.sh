#!/usr/bin/env bash
# integ-broad-gate.sh
#
# PreToolUse hook. Blocks `gh pr merge` (including --auto) when the
# PR's diff touches cross-cutting deploy/destroy code AND the
# `integ-broad` markgate marker is stale.
#
# Why this gate exists (PR #348 incident, 2026-05-13):
#
#   The `integ-destroy` marker records a digest, not provenance, and
#   accepts ANY clean real-AWS destroy. A narrow feature integ (e.g. PR #348's
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
#      multi-resource, remove-protection, export). Narrow integs don't
#      touch the sentinel, so they don't refresh this marker.
#      The set is written out in this comment, the block message below,
#      .markgate.yml and several skills. Do not list the copies here:
#      tests/unit/scripts/cross-cutting-list-sync.test.ts holds the
#      current population and compares every copy against the block
#      message, which is the base.
#   3. The marker also carries the 14d TTL of integ-destroy / integ-local
#      so AWS-side drift forces a fresh broad run periodically.
#
# Set ONLY by /run-integ; never call `markgate set integ-broad` by hand
# (same rule as the other AWS-coupled gates).

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
  || ! declare -F gate_resolve_marker_gate >/dev/null \
  || ! declare -F gate_refuse_no_equivalent_marker >/dev/null \
  || ! declare -F gate_refuse_stale_alias_marker >/dev/null \
  || ! declare -F gate_refuse_unevaluable_marker >/dev/null \
  || ! declare -F cmd_last_cd_target >/dev/null \
  || ! declare -F gate_pr_selector >/dev/null \
  || ! declare -F gate_pr_selector_unreadable >/dev/null \
  || ! declare -F gate_pr_selector_ate_number >/dev/null \
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

# Read the PreToolUse payload (command + cwd).
input=$(cat 2>/dev/null || true)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `gh pr merge` (including --auto). Every other command,
# including `gh pr create`, passes through — opening a PR for review
# should always be allowed. Tolerate an optional `gh -C <path>` between
# Matching goes through the SHARED command-position matcher
# (.claude/hooks/lib/command-match.sh, issue #1455): heredoc bodies and
# quoted spans are stripped, then the verb is matched at line start OR
# after a `&&` / `||` / `;` / `|` operator. That catches chained
# invocations the old line-start anchor missed, while a quoted mention
# still does not fire (it is removed rather than dodged by position).
if ! gate_matches "$cmd" "$GATE_RE_GH_PR_MERGE"; then
  exit 0
fi

# Resolve where the gh command will actually run (cwd-aware; cdkd #559
# — pre-fix the hook resolved REPO from BASH_SOURCE which always
# landed in the main tree, defeating markgate's per-worktree isolation;
# see memory rule feedback_cross_agent_main_tree_contention.md).
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
  gate_refuse_unresolved_target "integ-broad-gate" "${hook_cwd:-$PWD}"
fi

if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

cd "$target_dir" 2>/dev/null || exit 0

# Cross-cutting code paths whose modification can affect EVERY user's
# deploy/destroy, not just the feature scenario the PR adds. Keep in
# sync with the same list in
# .claude/skills/verify-pr/references/leftover-and-integ-gates.md (step 6) --
# BOTH its bullet list and the verbatim regex in its detection snippet --
# and .claude/skills/pick-integ/SKILL.md step 2's changed-path table.
# (feedback_cross_cutting_needs_broad_integ.md records why the gate
# exists; it names no paths, so it is not one of the copies.) Those
# three prose copies are fenced against this one by
# tests/unit/scripts/cross-cutting-list-sync.test.ts, because the list
# had already drifted between copies before that fence existed.
#
# `retry.ts` / `retryable-errors.ts` joined the list in issue #2042:
# `withRetry` wraps every provider's create/update/delete and
# `destroy-runner.ts` consults `isRetryableTransientError` directly, so
# a change to which errors are retryable reaches every mutating AWS call
# cdkd makes. `rollback-executor.ts` was found unscoped in the same pass
# (it was NOT named by that issue): its reverse-replacement path deletes
# the new physical resource and re-creates the old one.
#
# `provider-registry.ts` joined in issue #2720. Its sibling
# `register-providers.ts` decides which TYPES have an SDK provider; this
# one decides which provider actually runs EVERY resource in EVERY
# template -- the SDK-vs-Cloud-Control routing decision, delete path
# included -- which is the multi-resource blast radius this gate exists
# for. It was in NEITHER real-AWS gate until then.
CROSS_CUTTING_REGEX='^src/deployment/(deploy-engine|intrinsic-function-resolver|retry|retryable-errors|rollback-executor)\.ts$|^src/cli/commands/(destroy-runner|destroy|deploy)\.ts$|^src/analyzer/(dag-builder|template-parser)\.ts$|^src/provisioning/(provider-registry|register-providers)\.ts$'

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
# PR SELECTOR (go-to-k/cdkd#3365). `gate_pr_selector` replaces a hand-rolled
# walk this gate carried in common with two siblings; `ci-green-gate` and
# `pr-review-gate` already called it. The substitution alone buys one spelling
# -- a short flag no longer eats the number (`gh pr merge -s 552` used to yield
# empty) -- and the measurement that mattered is what it does NOT buy: a URL
# selector is empty through BOTH walks.
#
# So the fix is the EMPTY case, not the parser. An empty selector sends this
# gate to `gh pr view` with no argument, which resolves the CURRENT BRANCH's PR.
# That is right for `gh pr merge --squash` from the PR's own worktree -- the
# spelling CLAUDE.md prescribes -- and wrong for `gh pr merge <URL>`, where gh
# merges the URL'd PR while this gate scope-checks a different one, or finds
# none and takes the infra fail-open below at exit 0.
#
# `gate_pr_selector_unreadable` separates the two: a selector that was PRESENT
# and could not be read refuses, a command carrying none keeps the fallback.
__selector_unreadable=0
pr_number="$(gate_pr_selector "$cmd" "$__verb_ere")"
if [ -z "$pr_number" ] && gate_pr_selector_unreadable "$cmd" "$__verb_ere"; then
  # NOT an exit. Refusing HERE would land ahead of the scope check, so a
  # docs-only PR merged by URL -- which this gate exempts by design -- would be
  # refused by a cross-cutting-code gate. Instead the unreadable selector is
  # carried as "scope UNKNOWN": the scope check is skipped (treated as in
  # scope, since nothing can say otherwise) and the marker decides. A FRESH
  # marker passes, which is right -- with the marker fresh the gate would
  # permit the merge whatever the PR touched, so the identity never mattered.
  # The refusal is spent only where the answer is load-bearing: a STALE marker,
  # where falling back to the current branch's PR could exempt a PR gh is
  # actually merging.
  __selector_unreadable=1
fi

# An unreadable selector means the scope is UNKNOWN, not out of scope: the
# only PR whose files could be fetched is the current branch's, which is not
# the one gh is about to merge. Treat it as in scope and let the marker decide
# (go-to-k/cdkd#3365).
if [ "$__selector_unreadable" -eq 1 ]; then
  cross_cutting=1
else

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
fi

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

# --- which marker to ask about in THIS target repo (go-to-k/cdkd#2236) ---
# Same structural defect as integ-local-gate: this hook fires on merges whose
# target is a SIBLING repo too, and `integ-broad` is a cdkd-only gate name, so a
# sibling took a refusal it could never clear. No alias row for this gate:
# `integ-broad` is bound to the broad-set sentinel a multi-resource real-AWS run
# writes, which neither sibling has any counterpart for.
__plan=$(gate_resolve_marker_gate "$target_dir" integ-broad)
__mode=$(printf '%s' "$__plan" | cut -f1)
__gate=$(printf '%s' "$__plan" | cut -f2)
__gate_fix=$(printf '%s' "$__plan" | cut -f3)

# The SCOPE DESCRIPTOR these refusals print. With an unreadable selector
# the scope was never checked -- no PR diff could be fetched -- so asserting
# it here is the same wrong claim the stale-marker arm was fixed not to make
# (go-to-k/cdkd#3365 review). Bound once so the two call sites below cannot
# drift apart.
if [ "$__selector_unreadable" -eq 1 ]; then
  __scope_desc="code this gate could not identify, because the pull request named in the command cannot be resolved to a number"
else
  __scope_desc="cross-cutting deploy / destroy code (deploy-engine, dag-builder, retry, register-providers)"
fi

if [ "$__mode" = "none" ]; then
  gate_refuse_no_equivalent_marker "integ-broad-gate" "integ-broad" "$target_dir" \
    "$__scope_desc"
fi

"${markgate[@]}" verify "$__gate" >/dev/null 2>&1
status=$?
if [ "$status" -eq 0 ]; then
  exit 0
fi

# markgate exit 2 is "could not EVALUATE", not "stale", and the remedies are
# OPPOSITE. This MUST come before the alias refusal below: the one alias that
# exists is a `hash: diff` gate whose NORMAL verdict from a base tree is exit 2,
# and the alias refusal would tell the reader to go run an integ, which cannot
# clear it (go-to-k/cdkd#2236 review, items 1 + 2).
if [ "$status" -eq 2 ]; then
  gate_refuse_unevaluable_marker "integ-broad-gate" "$__gate" "$target_dir"
fi

if [ "$__mode" = "alias" ]; then
  gate_refuse_stale_alias_marker "integ-broad-gate" "integ-broad" "$target_dir" \
    "$__gate" "$__gate_fix" \
    "$__scope_desc"
fi

# Extract the parenthesized reason (`digest differs` vs `expired by ttl`
# vs `marker missing`) for a more actionable error message.
reason=$("${markgate[@]}" status "$__gate" 2>/dev/null \
  | awk '/^state:/ { if (match($0, /\([^)]+\)/)) print substr($0, RSTART, RLENGTH); exit }')

# The selector arm speaks FIRST and in its own words: the sentences below assert
# the PR touches cross-cutting code, which is exactly what could not be checked
# here. Saying it anyway would send the reader to a diff that does not support
# it.
if [ "$__selector_unreadable" -eq 1 ]; then
  cat >&2 <<'EOF_SELECTOR'
Blocked by integ-broad-gate: the pull request cannot be identified, and the
`integ-broad` marker is stale or missing.

The command names a PR in a form this gate cannot resolve to a number -- a URL,
a branch name, or a number consumed by a flag it does not know -- so it could
not read that PR's diff to decide whether this gate even applies. The current
branch's PR is a DIFFERENT pull request than the one gh merges, so it is not
consulted. With the marker fresh this would have passed regardless; it is only
the stale marker that makes the identity load-bearing.

Re-run naming the PR by number, which lets the scope check run:
  gh pr merge <N> --squash --delete-branch
EOF_SELECTOR
  exit 2
fi

if [ -n "$reason" ]; then
  printf "Blocked by integ-broad-gate: this PR touches cross-cutting deploy/destroy code and the \`integ-broad\` marker is stale %s.\n\n" "$reason" >&2
else
  cat >&2 <<'EOF_HEAD'
Blocked by integ-broad-gate: this PR touches cross-cutting
deploy/destroy code (DeployEngine, destroy-runner, IntrinsicFunctionResolver,
DagBuilder, TemplateParser, register-providers, the retry classifier, or
the rollback executor) and the `integ-broad` marker is stale or missing.

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
  # or one of (this message is the base that
  # cross-cutting-list-sync.test.ts compares every other copy against):
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
