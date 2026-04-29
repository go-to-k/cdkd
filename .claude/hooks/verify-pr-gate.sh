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

set -u

# Resolve repo root from script location (.claude/hooks/verify-pr-gate.sh -> repo root).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Extract the command from the PreToolUse payload.
cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Only gate `gh pr create` and `gh pr merge` invocations -- any other
# command passes through. Match both `gh pr merge` and
# `gh pr merge --auto`.
if ! printf '%s' "$cmd" | grep -qE '\bgh[[:space:]]+pr[[:space:]]+(create|merge)\b'; then
  exit 0
fi

cd "$REPO" 2>/dev/null || exit 0

# Prefer direct `markgate`; fall back to `mise exec --` for users who
# installed via `mise install` but don't have shims on PATH.
if command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
elif command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
else
  echo "Blocked by verify-pr-gate: markgate is not installed. Run 'mise install' at the repo root (see CONTRIBUTING.md)." >&2
  exit 2
fi

"${markgate[@]}" verify verify-pr >/dev/null 2>&1
status=$?

if [ "$status" -eq 0 ]; then
  exit 0
fi

cat >&2 <<'EOF'
Blocked by verify-pr-gate: the `verify-pr` marker is stale (or missing).

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
