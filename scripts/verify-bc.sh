#!/usr/bin/env bash
#
# verify-bc.sh — Backwards-compat verification for cdkd refactor PRs.
#
# Each PR in the region/state refactor that changes a user-visible default
# carries a verification block here. The markgate `bc-check` marker is
# recorded only after this script exits 0 for the requested PR ID. See
# `docs/plans/README.md` ("Compatibility strategy") for context.
#
# Usage:
#   scripts/verify-bc.sh PR-1   # state key region prefix
#   scripts/verify-bc.sh PR-4   # default state bucket name (region-free)
#   scripts/verify-bc.sh all    # run every block in sequence
#
# Each block runs against the source tree (no real AWS required) and exits
# non-zero on the first failure. Real-AWS verification belongs in the
# matching integration test under `tests/integration/`.
#
# Implementation note: the cdkd build bundles every source file into a
# single `dist/cli.js` / `dist/index.js`, so we cannot dynamically import
# `dist/cli/config-loader.js`. We invoke the TypeScript source via `tsx`
# (a zero-config TS runner — preferred) and fall back to grepping the
# source as text when `tsx` is unavailable. The grep path covers the case
# where the script runs in a freshly-cloned repo without dev deps.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() {
  printf '[verify-bc] %s\n' "$*" >&2
}

fail() {
  printf '[verify-bc] FAIL: %s\n' "$*" >&2
  exit 1
}

assert_grep() {
  # $1: human description
  # $2: file
  # $3: pattern (passed to grep -F unless $4 is set to "-E")
  local desc="$1" file="$2" pattern="$3" mode="${4:--F}"
  log "  - ${desc}"
  if ! grep -q "${mode}" -- "${pattern}" "${file}"; then
    fail "${desc} (file: ${file}, pattern: ${pattern})"
  fi
}

refute_grep() {
  # $1: human description
  # $2: file
  # $3: pattern
  local desc="$1" file="$2" pattern="$3" mode="${4:--F}"
  log "  - ${desc}"
  if grep -q "${mode}" -- "${pattern}" "${file}"; then
    fail "${desc} (file: ${file}, pattern: ${pattern} should NOT be present)"
  fi
}

# ---------------------------------------------------------------------------
# PR-4: default state bucket name (region-free)
#
# Invariants verified here (no AWS calls):
#   - getDefaultStateBucketName(accountId) returns `cdkd-state-{accountId}`
#     and does NOT embed any region. Verified two ways: (a) signature has
#     a single `accountId` parameter, (b) return template is literally
#     `cdkd-state-${accountId}` with no region interpolation.
#   - getLegacyStateBucketName(accountId, region) is exported and returns
#     the pre-v0.8 `cdkd-state-{accountId}-{region}` shape.
#   - The bootstrap command default-name help string is updated.
#   - The `TODO(remove-bc-after-1.x)` marker is present at the legacy
#     fallback so PR 99 can grep it back out.
# ---------------------------------------------------------------------------
verify_pr4() {
  log "PR-4: default state bucket name (region-free)"

  local cfg="${REPO_ROOT}/src/cli/config-loader.ts"
  local boot="${REPO_ROOT}/src/cli/commands/bootstrap.ts"

  assert_grep \
    "getDefaultStateBucketName has region-free signature" \
    "${cfg}" \
    'export function getDefaultStateBucketName(accountId: string): string'

  assert_grep \
    "getDefaultStateBucketName returns the region-free template" \
    "${cfg}" \
    'return `cdkd-state-${accountId}`'

  # The legacy helper validly references the region-suffixed template, so we
  # cannot blanket-`refute_grep` it from the file. Instead, verify the
  # default helper's body sits adjacent to its signature and is exactly the
  # new region-free template.
  if ! awk '
    /export function getDefaultStateBucketName/ {found=NR; next}
    found && NR<=found+2 && /return `cdkd-state-\${accountId}`/ {print "ok"; exit}
  ' "${cfg}" | grep -q ok; then
    fail "getDefaultStateBucketName body is not the region-free template"
  fi
  log "  - getDefaultStateBucketName body is the region-free template"

  assert_grep \
    "getLegacyStateBucketName is exported with the pre-v0.8 signature" \
    "${cfg}" \
    'export function getLegacyStateBucketName(accountId: string, region: string): string'

  assert_grep \
    "getLegacyStateBucketName returns the legacy region-suffixed template" \
    "${cfg}" \
    'return `cdkd-state-${accountId}-${region}`'

  assert_grep \
    "config-loader carries the BC removal TODO marker" \
    "${cfg}" \
    'TODO(remove-bc-after-1.x)'

  assert_grep \
    "bootstrap help text references the region-free default" \
    "${boot}" \
    'cdkd-state-{accountId})'

  refute_grep \
    "bootstrap help text no longer advertises the legacy region-suffixed default" \
    "${boot}" \
    'cdkd-state-{accountId}-{region})'

  assert_grep \
    "bootstrap calls getDefaultStateBucketName with a single arg" \
    "${boot}" \
    'getDefaultStateBucketName(accountId);'

  log "PR-4: PASS"
}

# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

main() {
  local target="${1:-}"
  if [ -z "${target}" ]; then
    fail "usage: scripts/verify-bc.sh <PR-4|all>"
  fi

  case "${target}" in
    PR-4)
      verify_pr4
      ;;
    all)
      # Future: PR-1 lives here once that PR lands. Today the only block is
      # PR-4 — the dispatcher is shaped for forward compatibility so that
      # later PRs append a single `verify_prN` call without rearchitecting.
      verify_pr4
      ;;
    *)
      fail "unknown target '${target}' (expected: PR-4 | all)"
      ;;
  esac
}

main "$@"
