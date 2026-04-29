#!/usr/bin/env bash
# integ-destroy-gate.sh
#
# PreToolUse hook. Blocks `gh pr merge` (including --auto) unless the
# `integ-destroy` markgate marker is fresh for the current content
# state. The gate's scope (see .markgate.yml) covers every code path
# that participates in real-AWS resource destruction; editing any of
# them invalidates the marker and forces a successful `/run-integ`
# destroy run before the PR can be merged.
#
# This is the structural counterpart to the CLAUDE.md rule "Never
# merge a PR whose destroy path is unverified". The rule said it; the
# hook enforces it.

set -u

# Resolve repo root from script location (.claude/hooks/integ-destroy-gate.sh -> repo root).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Extract the command from the PreToolUse payload.
cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Only gate `gh pr merge` invocations -- any other command passes
# through. Match both `gh pr merge` and `gh pr merge --auto`.
if ! printf '%s' "$cmd" | grep -qE '\bgh[[:space:]]+pr[[:space:]]+merge\b'; then
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
  echo "Blocked by integ-destroy-gate: markgate is not installed. Run 'mise install' at the repo root (see CONTRIBUTING.md)." >&2
  exit 2
fi

"${markgate[@]}" verify integ-destroy >/dev/null 2>&1
status=$?

if [ "$status" -eq 0 ]; then
  exit 0
fi

cat >&2 <<'EOF'
Blocked by integ-destroy-gate: this PR touches deletion logic
(provider delete(), destroy.ts, dag-builder, IMPLICIT_DELETE_DEPENDENCIES,
or similar) and the `integ-destroy` marker is stale.

Required:
  /run-integ <test-name>      # e.g. /run-integ bench-cdk-sample

The skill must report:
  - destroy completed: 0 errors
  - 0 orphan resources after the post-destroy verification

Only then will it set the `integ-destroy` marker and let the merge
through. If you genuinely need to bypass (rare — typically only when
you have a verified-good run from an earlier commit and the diff is
docs/test-only), reset the marker manually and document why in the PR
body:
    mise exec -- markgate set integ-destroy
EOF
exit 2
