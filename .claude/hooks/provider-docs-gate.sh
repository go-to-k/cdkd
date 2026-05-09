#!/usr/bin/env bash
# provider-docs-gate.sh
#
# PreToolUse hook. Blocks `git commit` when newly-added
# `registry.register('AWS::Service::Type', ...)` lines in
# `src/provisioning/register-providers.ts` lack a matching entry in
# both `docs/supported-resources.md` and `docs/import.md`.
#
# WHY: CLAUDE.md "Adding a New SDK Provider" rule 5 says every new
# resource type must be added to docs/supported-resources.md AND
# docs/import.md. The v2 drift coverage push (PRs #210-#216) shipped
# 7 new resource types (Glue Job/Crawler/Connection/Trigger/Workflow/
# SecurityConfiguration + Kinesis StreamConsumer) and missed BOTH
# docs files entirely — caught only on a post-merge audit (#219).
# This hook closes the gap structurally, mirroring the
# roundtrip-test-gate.sh precedent (PRs #163-168 retroactive patch
# motivated the round-trip test gate).
#
# Scope:
#   - Only fires on `git commit` (passes through everything else).
#   - Only fires when register-providers.ts has staged diff lines
#     introducing a new `registry.register('AWS::...'` call. Pure
#     refactors that move existing registrations around without
#     introducing a NEW resource type pass through.
#   - Accepts staged diff in either docs file as satisfying the gate
#     (so a single commit adding the register + both docs entries
#     passes).
#
# Resolution of "where will the git command actually run" mirrors
# branch-gate.sh / roundtrip-test-gate.sh.

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

REG_FILE="src/provisioning/register-providers.ts"
DOCS_SUPPORTED="docs/supported-resources.md"
DOCS_IMPORT="docs/import.md"

# Pull the staged diff for register-providers.ts. If the file isn't
# staged, nothing to check.
diff=$(git -C "$target_dir" diff --cached -- "$REG_FILE" 2>/dev/null || true)
if [[ -z "$diff" ]]; then
  exit 0
fi

# Collect the resource types being ADDED (lines starting with "+ ",
# excluding the "+++" header) and REMOVED (lines starting with "- ",
# excluding "---"). A type that's both removed and re-added in the
# same diff is a no-op refactor (e.g. reordering / renaming the
# variable bound to the provider instance) and should not trigger
# the gate.
extract_types() {
  local prefix="$1" diff_text="$2"
  printf '%s\n' "$diff_text" \
    | grep -E "^${prefix} *registry\.register\(['\"]AWS::[A-Za-z0-9]+::[A-Za-z0-9]+['\"]" \
    | sed -E "s/^${prefix} *registry\.register\(['\"](AWS::[A-Za-z0-9]+::[A-Za-z0-9]+)['\"].*/\1/" \
    | sort -u
}

added_types=$(extract_types '\+' "$diff")
removed_types=$(extract_types '-' "$diff")

if [[ -z "$added_types" ]]; then
  exit 0
fi

# Subtract: only types in added but NOT in removed are net-new
# registrations.
net_new=$(comm -23 <(printf '%s\n' "$added_types") <(printf '%s\n' "$removed_types"))
if [[ -z "$net_new" ]]; then
  exit 0
fi

# Read the staged content of each docs file. The check accepts EITHER
# the staged blob OR the tracked file as the source of truth — so a
# single commit adding both the register line and the docs entries
# passes.
read_docs_blob() {
  local rel="$1"
  local staged
  staged=$(git -C "$target_dir" diff --cached -- "$rel" 2>/dev/null || true)
  if [[ -n "$staged" ]]; then
    # The staged blob is what would be in the working tree post-commit.
    git -C "$target_dir" show ":$rel" 2>/dev/null || true
  else
    # No staged diff for this file — read the tracked version.
    git -C "$target_dir" show "HEAD:$rel" 2>/dev/null || true
  fi
}

supported_blob=$(read_docs_blob "$DOCS_SUPPORTED")
import_blob=$(read_docs_blob "$DOCS_IMPORT")

if [[ -t 2 ]]; then
  RED_BOLD=$'\033[1;31m'
  RESET=$'\033[0m'
else
  RED_BOLD=""
  RESET=""
fi

violations=()
while IFS= read -r type; do
  [[ -z "$type" ]] && continue
  missing=()
  if ! printf '%s' "$supported_blob" | grep -qF -- "$type"; then
    missing+=("$DOCS_SUPPORTED")
  fi
  if ! printf '%s' "$import_blob" | grep -qF -- "$type"; then
    missing+=("$DOCS_IMPORT")
  fi
  if [[ ${#missing[@]} -gt 0 ]]; then
    IFS=','; missing_csv="${missing[*]}"; unset IFS
    violations+=("$type|$missing_csv")
  fi
done <<< "$net_new"

if [[ ${#violations[@]} -eq 0 ]]; then
  exit 0
fi

{
  echo "${RED_BOLD}Blocked by provider-docs-gate: new SDK provider registration missing docs entry.${RESET}"
  echo
  echo "Every new resource type registered in src/provisioning/register-providers.ts"
  echo "must also be added to docs/supported-resources.md (deploy/manage capability"
  echo "table) AND docs/import.md (import-side coverage). Both files are the"
  echo "single source of truth that users / contributors rely on, and the v2 drift"
  echo "coverage push (PRs #210-#216) shipped 7 types that missed both files until"
  echo "a post-merge audit caught the gap (#219)."
  echo
  echo "See CLAUDE.md \"Adding a New SDK Provider\" rule 5."
  echo
  echo "Missing entries:"
  for v in "${violations[@]}"; do
    type="${v%%|*}"
    missing_csv="${v##*|}"
    echo "  - $type"
    IFS=',' read -ra files <<< "$missing_csv"
    for f in "${files[@]}"; do
      echo "      add to: $f"
    done
  done
  echo
  echo "Stage the docs updates in the same commit as the register-providers.ts"
  echo "change to satisfy the gate. If the registration is intentionally"
  echo "internal-only (no user-visible support change), file an explicit"
  echo "carve-out by leaving an # internal-only comment on the register line"
  echo "(this hook does not yet honor that — extend if needed)."
} >&2

exit 2
