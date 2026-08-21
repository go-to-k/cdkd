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
# non-english-text-gate.sh / integ-local-gate.sh).
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

if [ "$status" -eq 0 ]; then
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

if [ -n "$reason" ]; then
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
