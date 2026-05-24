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
# Line-start anchored (per memory rule
# feedback_hook_command_match_line_start.md) so `gh pr create` /
# `gh pr merge` substrings inside quoted argument bodies
# (`echo "next step: gh pr create"`) do NOT false-positive into a
# hard block. The optional leading `cd <path> &&` prefix preserves
# the worktree-aware `cd <side> && gh pr create` chain shape,
# mirroring check-gate.sh (PR #562 fix pattern).
if ! printf '%s' "$cmd" | grep -qE '^[[:space:]]*(cd[[:space:]]+[^[:space:]]+[[:space:]]*&&[[:space:]]*)?gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+(create|merge)([[:space:]]|$|[|;&`)])'; then
  exit 0
fi

# Resolve where the gh command will actually run (cwd-aware; mirrors
# non-english-text-gate.sh / integ-local-gate.sh).
target_dir="${hook_cwd:-$PWD}"

# `cd <path>` at the start of the command shifts the target dir.
if [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
  cd_target="${BASH_REMATCH[1]}"
  cd_target="${cd_target%\"}"; cd_target="${cd_target#\"}"
  cd_target="${cd_target%\'}"; cd_target="${cd_target#\'}"
  if [[ "$cd_target" != /* ]]; then
    cd_target="$target_dir/$cd_target"
  fi
  target_dir="$cd_target"
fi

# Last `gh -C <path>` wins.
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

# If the resolved target dir is not a git repo, silently pass — we
# can't audit what we can't see.
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
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
