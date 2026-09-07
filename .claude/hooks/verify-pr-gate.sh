#!/usr/bin/env bash
# verify-pr-gate.sh
#
# PreToolUse hook. Blocks `gh pr create` and `gh pr merge` (including
# --auto) unless the `verify-pr` markgate marker is fresh for the
# current content state. The gate's scope (see .markgate.yml) covers
# every code/test/doc path the /verify-pr skill inspects, so editing
# any of them invalidates the marker and forces a successful
# /verify-pr run before the PR can be opened or merged.
#
# This is the structural enforcement of the "PR readiness checklist"
# rule: live-test the changed behavior, walk all shared-utility
# callers, refresh PR title + body, and run the session retrospective
# (proposing new rules/hooks/skills for recurring patterns) BEFORE
# `gh pr create` / `gh pr merge`. The skill said it; the hook
# enforces it.
#
# WHY the cwd-aware resolution matters (cdkd #559): this repo is
# regularly worked in via `git worktree`, and markgate stores marker
# state per-worktree at `<git rev-parse --absolute-git-dir>/markgate/`.
# The pre-#559 implementation derived REPO from `BASH_SOURCE` and
# always landed on the main working tree, defeating markgate's
# per-worktree isolation and forcing every parallel agent to converge
# on the main tree's view (see memory rule
# feedback_cross_agent_main_tree_contention.md). We now resolve the
# target working tree from the PreToolUse payload's `cwd` field +
# leading `cd <path>` + last `gh -C <path>` flag.

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

# Read the entire stdin payload once; we need both .tool_input.command
# and .cwd from it.
input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `gh pr create` and `gh pr merge` invocations -- any other
# command passes through. Match both `gh pr merge` and
# `gh pr merge --auto`. Tolerate an optional `gh -C <path>` between
# `gh` and `pr` so `gh -C <path> pr create` is also recognised.
# Matching goes through the SHARED command-position matcher
# (.claude/hooks/lib/command-match.sh, issue #1455): heredoc bodies and
# quoted spans are stripped, then the verb is matched at line start OR
# after a `&&` / `||` / `;` / `|` operator. That catches chained
# invocations the old line-start anchor missed, while a quoted mention
# still does not fire (it is removed rather than dodged by position).
if ! gate_matches "$cmd" "$GATE_RE_GH_PR_CREATE_OR_MERGE"; then
  exit 0
fi

# Resolve where the gh command will actually run (cwd-aware; mirrors
# integ-local-gate.sh).
# Where the git/gh command will actually RUN.
#
# This calls the SHARED resolver in lib/command-match.sh, replacing the
# hand-rolled `-C` scan this hook used to carry. That copy captured the raw
# token with no guard for an unexpanded `$VAR`, so the standard worktree
# spelling `git -C "$W" ...` resolved to the literal `<cwd>/$W`, the repo
# probe below failed, and the gate exited 0 over a tree it never looked at
# (go-to-k/cdkd#2027). The strict resolver refuses instead of guessing.
__verb_ere="$GATE_RE_GH_PR_CREATE_OR_MERGE"
if ! target_dir=$(gate_target_dir_strict "$cmd" "${hook_cwd:-$PWD}" "$__verb_ere"); then
  gate_refuse_unresolved_target "verify-pr-gate" "${hook_cwd:-$PWD}"
fi

# If the resolved target dir is not a git repo, silently pass — we
# can't audit what we can't see.
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# Repo opt-in scope (mirrors branch-gate.sh, issue #1259): this gate protects
# repos that follow the markgate convention. A session rooted in such a repo can
# still run git / gh against OTHER repos (a dotfiles checkout, a scratch clone)
# that have no markers at all, and blocking there is pure friction — the gate
# would demand a marker the repo cannot have. Opt-in signal: a `.markgate.yml`
# at the resolved target repo's top level. Repos without it pass through.
target_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || echo "")
if [[ -z "$target_top" || ! -f "$target_top/.markgate.yml" ]]; then
  exit 0
fi

cd "$target_dir" 2>/dev/null || exit 0

# Prefer the `.mise.toml`-pinned version via `mise exec --` so the repo's
# canonical markgate wins over an older PATH binary; see check-gate.sh for
# the schema-bump rationale (0.3.0 markers are silently invisible to 0.3.1).
if command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
elif command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
else
  echo "Blocked by verify-pr-gate: markgate is not installed. Run 'mise install' at the repo root (see CONTRIBUTING.md)." >&2
  exit 2
fi

"${markgate[@]}" verify verify-pr >/dev/null 2>&1
status=$?

# SHA BINDING (go-to-k/cdkd#2686).
#
# A fresh marker is not enough. `verify-pr` is declared `requires: [check,
# docs]` with NO `include:` of its own, so once set in a worktree it never
# stales by itself -- it is only ever MASKED by a stale child. Running `/check`
# and `/check-docs` un-masks it, and the gate that is supposed to physically
# block `gh pr create` / `gh pr merge` for a PR whose live behaviour was never
# exercised goes green for a PR `/verify-pr` has never seen.
#
# That is invisible in a single-PR session and NOT invisible in the IN-PLACE
# worktree mode CLAUDE.md prescribes, where lane N inherits lane N-1's parent
# marker. Measured twice, in different worktrees a day apart: a parent an hour
# older than children four minutes old, `markgate verify verify-pr` rc=0, and
# `gh pr create` unblocked.
#
# THIS COMPARISON IS THE ENFORCEMENT, not a nicer error string. `markgate
# verify` digests the gate's SCOPE; a sentinel nobody rewrote keeps its digest
# whatever the branch moved to, so `verify` reports `match` for a sentinel
# naming a different commit entirely (measured on the sibling gate,
# go-to-k/cdkd#2681 -- whose whole subject is a comment that claimed the digest
# enforced it, and which would have made deleting this look like a safe
# simplification). Do not remove it on the strength of the digest.
#
# Bound to the LOCAL HEAD, not to the PR's `headRefOid` as `pr-review-gate.sh`
# is: this gate also guards `gh pr create`, where there is no PR to ask. The
# local HEAD exists at both moments and is exactly what distinguishes one lane
# from the next.
# Read from the repo TOP, not the cwd: `gh pr create` run from a subdirectory
# would otherwise find no sentinel and be refused for a reason that has nothing
# to do with the marker. `target_top` is already resolved above.
recorded_sha=""
if [ -f "$target_top/.markgate-verify-pr-sha" ]; then
  recorded_sha=$(head -c 100 "$target_top/.markgate-verify-pr-sha" 2>/dev/null | tr -d '[:space:]')
fi
# `--verify`, not a bare `rev-parse HEAD`: in a repo with no commits the bare
# form prints the literal string `HEAD` on STDOUT (and the fatal on stderr), so
# `head_sha` would be "HEAD" rather than empty and the `-n` guard below would be
# dead code. Measured. `--verify` yields a sha or nothing.
head_sha=$(git rev-parse --verify HEAD 2>/dev/null || echo "")

if [ "$status" -eq 0 ] && [ -n "$head_sha" ] && [ "$recorded_sha" = "$head_sha" ]; then
  exit 0
fi

# Extract the parenthesized reason from `markgate status verify-pr` so the
# error message tells the user *why* the gate is stale. With markgate 0.3+
# `requires: [check, docs]` the reason often names the failing child
# (e.g. "(child docs is stale)"), pointing the user straight at /check or
# /check-docs without forcing them to re-run /verify-pr blindly. Fails open
# to the static heredoc body when extraction fails.
reason=$("${markgate[@]}" status verify-pr 2>/dev/null \
  | awk '/^state:/ { if (match($0, /\([^)]+\)/)) print substr($0, RSTART, RLENGTH); exit }')

if [ "$status" -eq 0 ] && [ "$recorded_sha" != "$head_sha" ]; then
  # The marker is FRESH; what is wrong is what it is bound to. Saying "stale"
  # here would send the reader to `/check` for a problem no child has.
  printf "Blocked by verify-pr-gate: the \`verify-pr\` marker is fresh but bound to a different commit.\n\n" >&2
  printf "  HEAD is:          %s\n" "${head_sha:-<unreadable>}" >&2
  printf "  marker bound to:  %s\n\n" "${recorded_sha:-<unset>}" >&2
  printf "This is the second-lane case: a marker set for an earlier branch in this\nworktree, un-masked by a later \`/check\` + \`/check-docs\`. Run \`/verify-pr\`\nfor THIS branch.\n\n" >&2
elif [ -n "$reason" ]; then
  printf "Blocked by verify-pr-gate: the \`verify-pr\` marker is stale %s.\n\n" "$reason" >&2
else
  echo "Blocked by verify-pr-gate: the \`verify-pr\` marker is stale (or missing)." >&2
  echo >&2
fi

cat >&2 <<'EOF'
Required action — no exceptions:
  /verify-pr [PR-number]

The skill walks the full PR-readiness checklist:
  - typecheck / lint / build / unit tests
  - test coverage for the diff
  - CI status / working tree / docs consistency / leftover AWS resources
  - code review (incl. shared-utility caller verification)
  - live-test the changed behavior against real or fixture input
  - retrospective + proposals for new rules / hooks / skills
  - PR title + body freshness vs the actual diff

It is the ONLY legitimate setter of this marker. Do NOT call
`markgate set verify-pr` directly from a shell to bypass this hook —
the whole point of the gate is that an unverified PR cannot be opened
or merged. If a check legitimately cannot pass right now (e.g. no
AWS credentials for live-test), say so explicitly in the report; the
gate stays red so a human can decide whether to override.
EOF
exit 2
