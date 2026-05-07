#!/usr/bin/env bash
# roundtrip-test-gate.sh
#
# PreToolUse hook. Blocks `git commit` when a NEWLY-ADDED SDK provider
# under `src/provisioning/providers/*-provider.ts` contains
# `readCurrentState` but no corresponding round-trip test exists either
# staged or already-committed under `tests/unit/provisioning/`.
#
# WHY: PRs #163-168 retroactively patched a class of drift bug — a
# provider's `readCurrentState` snapshot round-trips through
# `provider.update()` during `cdkd drift --revert`, and AWS-rejection-
# shaped values silently break the revert. The fix was a per-provider
# `*-roundtrip.test.ts` (or `*-update.test.ts` — both naming
# conventions co-exist). `docs/provider-development.md § 3b`
# documents the rule, but doc-by-courtesy doesn't enforce it on the
# next NEW provider. This hook closes that gap structurally.
#
# Scope:
#   - Only fires on `git commit` (passes through everything else).
#   - Only fires on status-A (newly added) provider files.
#     Edits / deletes / renames pass through.
#   - Skips providers that don't contain `readCurrentState` (sub-
#     resource providers like lambda-permission, iam-policy: their
#     state is fully managed via their parent's snapshot, no round-
#     trip test required).
#
# Resolution of "where will the git command actually run" mirrors
# branch-gate.sh:
#   1. Explicit `git -C <path> commit` — last `-C` wins.
#   2. Leading `cd <path> && ...` — the cd target.
#   3. The hook input's `cwd` field.
#   4. The hook process's own $PWD.

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate git commit — anything else passes through.
if ! printf '%s' "$cmd" | grep -qE '\bgit[^|;&]*\bcommit\b'; then
  exit 0
fi

target_dir="${hook_cwd:-$PWD}"

# Leading `cd <path> && ...` shifts the target dir.
if [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
  cd_target="${BASH_REMATCH[1]}"
  cd_target="${cd_target%\"}"; cd_target="${cd_target#\"}"
  cd_target="${cd_target%\'}"; cd_target="${cd_target#\'}"
  if [[ "$cd_target" != /* ]]; then
    cd_target="$target_dir/$cd_target"
  fi
  target_dir="$cd_target"
fi

# Last `git -C <path>` wins.
if [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
  c_target=""
  remaining="$cmd"
  while [[ "$remaining" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; do
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
# can't audit what we can't see (mirrors branch-gate.sh).
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# List newly-ADDED files in the staged index.
added_files=$(git -C "$target_dir" diff --cached --name-only --diff-filter=A 2>/dev/null || true)

# Filter to provider source files. Sub-resource providers without
# readCurrentState will be handled below.
provider_files=$(printf '%s\n' "$added_files" | grep -E '^src/provisioning/providers/[^/]+-provider\.ts$' || true)

if [[ -z "$provider_files" ]]; then
  exit 0
fi

# Pre-compute the list of test files known to git — both staged-new
# (status A) and already-committed (tracked). A round-trip test added
# in the SAME commit as the provider should satisfy the gate, so we
# union staged adds with `git ls-files`.
staged_tests=$(printf '%s\n' "$added_files" | grep -E '^tests/unit/provisioning/' || true)
tracked_tests=$(git -C "$target_dir" ls-files 'tests/unit/provisioning/' 2>/dev/null || true)
all_tests=$(printf '%s\n%s\n' "$staged_tests" "$tracked_tests" | sort -u | grep -v '^$' || true)

# Bold-red ANSI for the blocking header. Falls back to plain text
# if stderr isn't a TTY (most CI / hook contexts).
if [[ -t 2 ]]; then
  RED_BOLD=$'\033[1;31m'
  RESET=$'\033[0m'
else
  RED_BOLD=""
  RESET=""
fi

violations=()

while IFS= read -r provider_path; do
  [[ -z "$provider_path" ]] && continue

  # Resolve the absolute path of the provider in the target repo so we
  # can grep it. The file is staged but on disk too (status A means
  # added in index — it must exist in the working tree to have been
  # staged). Use the index blob to be safe across edge cases.
  provider_blob=$(git -C "$target_dir" show ":$provider_path" 2>/dev/null || true)
  if [[ -z "$provider_blob" ]]; then
    # If we somehow can't read the blob, fall through and check the
    # working tree copy.
    if [[ -f "$target_dir/$provider_path" ]]; then
      provider_blob=$(cat "$target_dir/$provider_path")
    fi
  fi

  # Skip providers that don't capture AWS-current snapshots — these
  # don't need round-trip tests.
  if ! printf '%s' "$provider_blob" | grep -qF 'readCurrentState'; then
    continue
  fi

  # Compute base name (strip path + .ts). E.g.
  # `src/provisioning/providers/foo-bar-provider.ts` → `foo-bar-provider`.
  base=$(basename "$provider_path" .ts)

  # Accept any of:
  #   tests/unit/provisioning/<base>-roundtrip.test.ts
  #   tests/unit/provisioning/<base>-update.test.ts
  #   tests/unit/provisioning/*<base>*roundtrip*.test.ts
  match=$(printf '%s\n' "$all_tests" | grep -E "^tests/unit/provisioning/(${base}-roundtrip\.test\.ts|${base}-update\.test\.ts|.*${base}.*roundtrip.*\.test\.ts)$" || true)

  if [[ -z "$match" ]]; then
    violations+=("$provider_path|$base")
  fi
done <<< "$provider_files"

if [[ ${#violations[@]} -eq 0 ]]; then
  exit 0
fi

{
  echo "${RED_BOLD}Blocked by roundtrip-test-gate: new SDK provider missing round-trip test.${RESET}"
  echo
  echo "Each new provider in src/provisioning/providers/ that captures AWS-current"
  echo "state via readCurrentState() must ship with a corresponding round-trip test"
  echo "in tests/unit/provisioning/. The round-trip test asserts that the snapshot"
  echo "produced by readCurrentState() can be passed back through provider.update()"
  echo "without AWS rejecting the shape — guarding the bug class that PRs #163-168"
  echo "patched retroactively across every existing provider."
  echo
  echo "Missing test file(s):"
  for v in "${violations[@]}"; do
    provider_path="${v%%|*}"
    base="${v##*|}"
    echo "  - $provider_path"
    echo "      expected: tests/unit/provisioning/${base}-roundtrip.test.ts"
    echo "      (or:      tests/unit/provisioning/${base}-update.test.ts)"
  done
  echo
  echo "See docs/provider-development.md § 3b for the round-trip test pattern."
  echo "If this provider intentionally does not implement readCurrentState (e.g."
  echo "a sub-resource provider whose state is fully managed by its parent),"
  echo "remove the readCurrentState method to bypass this gate."
} >&2

exit 2
