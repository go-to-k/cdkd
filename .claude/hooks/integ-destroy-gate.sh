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

# Decide whether the diff actually touches deletion logic. The markgate
# scope (.markgate.yml) is file-level, so it can't tell apart a real
# delete-method change from an unrelated edit in the same file (e.g.
# adding `provider.import` to every provider in PR #67 invalidated the
# marker even though no provider's `delete` was modified). Use git diff
# vs origin/main to look at the actual hunks: if no delete-touching
# symbol is added or removed, skip the gate entirely.
#
# Heuristic:
# - "always-delete" files: any change at all is delete-touching.
# - provider files: only delete-touching when the diff hunks add/remove
#   a delete-related symbol (delete*, IMPLICIT_DELETE, ENI/hyperplane,
#   DependencyViolation).
# - everything else: not delete-touching.
#
# When in doubt, fall through to verifying the marker — false positives
# cost an integ-test run; false negatives cost a broken main.
diff_base=""
if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  diff_base="origin/main"
fi

if [ -n "$diff_base" ]; then
  changed_files=$(git diff --name-only "$diff_base"...HEAD 2>/dev/null)
  delete_touch=0
  always_delete='^(src/cli/commands/destroy(-runner)?\.ts|src/deployment/deploy-engine\.ts|src/analyzer/(dag-builder|implicit-delete-deps|lambda-vpc-deps)\.ts)$'
  provider_pattern='^src/provisioning/(providers/.*\.ts|cloud-control-provider\.ts|region-check\.ts)$'
  # Match a delete-touching symbol on an added/removed line, but NOT inside
  # a single-line comment. This avoids the false positives PR #73 hit
  # (e.g. an ECS provider doc-comment containing the words "delete/update"
  # tripped the gate even though the diff didn't change any delete code).
  #
  #   ^[-+]                  added or removed line
  #   [^-+]                  one non-+/- char so we don't match the diff header `+++`/`---`
  #   [[:space:]]*           leading indent
  #   (?!//|\*|#)            negative lookahead — but POSIX grep -E doesn't
  #                          support lookahead. Workaround: filter comment
  #                          lines with a second grep -v pass below.
  delete_symbol_pattern='^[-+][^-+].*\b(delete|IMPLICIT_DELETE|hyperplane|DependencyViolation|ENI|detach)\b'
  # Lines we consider "comment only" — drop them before the symbol grep.
  # Matches an added/removed line whose first non-whitespace content is
  # a JS/TS/SH comment introducer (`//`, `/*`, `*` mid-block, `#`).
  comment_line_pattern='^[-+][^-+][[:space:]]*(\*|/\*|//|#)'

  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if printf '%s' "$f" | grep -qE "$always_delete"; then
      delete_touch=1
      break
    fi
    if printf '%s' "$f" | grep -qE "$provider_pattern"; then
      if git diff "$diff_base"...HEAD -- "$f" \
         | grep -vE "$comment_line_pattern" \
         | grep -qE "$delete_symbol_pattern"; then
        delete_touch=1
        break
      fi
    fi
  done <<EOF_FILES
$changed_files
EOF_FILES

  if [ "$delete_touch" -eq 0 ]; then
    # No delete-touching changes → gate is irrelevant. Skip.
    exit 0
  fi
fi

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

Required action — no exceptions:
  /run-integ <test-name>      # e.g. /run-integ bench-cdk-sample

The skill is the ONLY legitimate setter of this marker. It will run
deploy + destroy against real AWS and only call
`markgate set integ-destroy` if BOTH of the following hold:
  - destroy completed with 0 errors
  - 0 orphan resources after the post-destroy verification

Do NOT call `markgate set integ-destroy` directly from a shell to
bypass this hook. The whole point of the gate is that an unverified
destroy cannot reach main; setting the marker by hand defeats it. If
you believe the file in scope is genuinely unrelated to deletion
behavior, the right fix is to narrow `.markgate.yml` integ-destroy
scope, not to bypass the marker.
EOF
exit 2
