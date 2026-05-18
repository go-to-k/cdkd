#!/usr/bin/env bash
# integ-coverage-matrix-gate.sh
#
# PreToolUse hook. Blocks `git commit` when staged changes touch the
# integ-coverage matrix's source scope (`tests/integration/<name>/{lib,bin}/*.ts`
# or `src/provisioning/register-providers.ts`) AND the regenerated matrix
# (`docs/integ-coverage.md` + `docs/_generated/integ-coverage.json`) would
# differ from what is currently in the working tree.
#
# WHY: CI's `check-build-test` job runs `vp run integ-coverage` followed
# by `git diff --quiet -- docs/integ-coverage.md docs/_generated/integ-coverage.json`
# and hard-fails on drift. A forgotten regen costs the contributor one CI
# cycle + a fix-up commit. The other commit-time gates do NOT catch this:
#   - /check covers typecheck / lint / build / tests
#   - /check-docs covers prose docs vs src consistency
#   - Generated artifacts (the matrix snapshots) are out of both scopes
# Only /verify-pr step 5 detects it locally, and most contributors push
# before running /verify-pr. This hook closes the structural gap.
#
# Detection:
#   1. Inspect the staged file list. If no file matches the gate scope,
#      pass through immediately (cheap exit).
#   2. Snapshot the current matrix files.
#   3. Run the regenerator (~0.1s) against the working tree.
#   4. Compare regen output against the snapshot:
#        - Identical -> matrix is up-to-date, restore (no-op anyway) + pass.
#        - Different -> matrix is stale. Restore the originals so the
#          working tree is not left modified by the hook, then block
#          with the exact `vp run integ-coverage` + `git add ...` recipe.
#
# A refactor that touches the gate scope but does NOT change the matrix
# output (e.g. rewording an L2 fixture's prose comment) passes through
# cleanly because step 4 finds no diff.
#
# Resolution of "where will the git command actually run" mirrors
# branch-gate.sh / provider-integ-gate.sh.

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Optional entry log. Surface that the hook was invoked AT ALL via the
# Claude Code harness; helps debug matcher-level bypasses (issue #433)
# where the `if:` predicate in settings.json fails to fire for a form
# the hook script itself would handle correctly. Off by default.
if [[ -n "${CDKD_HOOK_DEBUG:-}" ]]; then
  echo "[debug] integ-coverage-matrix-gate: entered (cmd=$cmd, cwd=$hook_cwd)" >&2
fi

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

# If the resolved target dir is not a git repo, silently pass.
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# Trigger condition: any staged file matches the matrix's source scope.
# Mirrors the path glob used by the CI step and by /verify-pr step 5.
staged=$(git -C "$target_dir" diff --cached --name-only 2>/dev/null || true)
if [[ -z "$staged" ]]; then
  exit 0
fi

if ! printf '%s\n' "$staged" \
  | grep -qE '^src/provisioning/register-providers\.ts$|^tests/integration/[^/]+/(lib|bin)/.+\.ts$'; then
  exit 0
fi

SCRIPT="scripts/build-integ-coverage-matrix.ts"
DOC_MD="docs/integ-coverage.md"
DOC_JSON="docs/_generated/integ-coverage.json"

# Sanity: the regenerator script must exist. If not, silently pass
# (this hook may be running against a repo that predates the script,
# or in a worktree where the file is somehow missing).
if [[ ! -f "$target_dir/$SCRIPT" ]]; then
  exit 0
fi

# Defensive: bail out cleanly if `node` is missing from PATH. The hook
# would otherwise crash on the regen call and produce a confusing
# error. /check / CI will catch the stale matrix anyway.
if ! command -v node >/dev/null 2>&1; then
  echo "integ-coverage-matrix-gate: node not in PATH; skipping check." >&2
  exit 0
fi

if [[ -t 2 ]]; then
  RED_BOLD=$'\033[1;31m'
  RESET=$'\033[0m'
else
  RED_BOLD=""
  RESET=""
fi

# Snapshot current contents. May not exist on a fresh clone — guard
# with empty defaults so the diff below still works (post-regen the
# file will exist and the empty-vs-present diff blocks correctly).
md_before=""
json_before=""
md_existed=0
json_existed=0
if [[ -f "$target_dir/$DOC_MD" ]]; then
  md_before=$(cat "$target_dir/$DOC_MD")
  md_existed=1
fi
if [[ -f "$target_dir/$DOC_JSON" ]]; then
  json_before=$(cat "$target_dir/$DOC_JSON")
  json_existed=1
fi

# Run the regenerator (writes to working tree in-place). Capture
# stderr separately so we can surface failures while still discarding
# the noisy success "wrote N/M covered" line.
regen_stderr=$(cd "$target_dir" && node --experimental-strip-types "$SCRIPT" 2>&1 >/dev/null) || regen_rc=$?
regen_rc=${regen_rc:-0}

if [[ "$regen_rc" -ne 0 ]]; then
  # Regenerator crashed — restore snapshots so we don't leave the tree
  # in a half-modified state, then surface a warn. Don't block: a
  # crashed regenerator is itself a bug that /check or CI will catch.
  if [[ "$md_existed" -eq 1 ]]; then
    printf '%s' "$md_before" > "$target_dir/$DOC_MD"
  else
    rm -f "$target_dir/$DOC_MD"
  fi
  if [[ "$json_existed" -eq 1 ]]; then
    printf '%s' "$json_before" > "$target_dir/$DOC_JSON"
  else
    rm -f "$target_dir/$DOC_JSON"
  fi
  {
    echo "integ-coverage-matrix-gate: regenerator failed (rc=$regen_rc); skipping check."
    [[ -n "$regen_stderr" ]] && printf '%s\n' "$regen_stderr"
  } >&2
  exit 0
fi

md_after=""
json_after=""
if [[ -f "$target_dir/$DOC_MD" ]]; then
  md_after=$(cat "$target_dir/$DOC_MD")
fi
if [[ -f "$target_dir/$DOC_JSON" ]]; then
  json_after=$(cat "$target_dir/$DOC_JSON")
fi

md_changed=0
json_changed=0
[[ "$md_before" != "$md_after" ]] && md_changed=1
[[ "$json_before" != "$json_after" ]] && json_changed=1

if [[ "$md_changed" -eq 0 && "$json_changed" -eq 0 ]]; then
  # Matrix already matches the source state. Pass.
  exit 0
fi

# Matrix is stale. Restore the originals so the working tree is NOT
# silently modified by the hook — the user runs `vp run integ-coverage`
# themselves and stages the result. This avoids the "hook moved files
# under me" surprise and keeps the regen step explicit in the user's
# shell history.
if [[ "$md_existed" -eq 1 ]]; then
  printf '%s' "$md_before" > "$target_dir/$DOC_MD"
else
  rm -f "$target_dir/$DOC_MD"
fi
if [[ "$json_existed" -eq 1 ]]; then
  printf '%s' "$json_before" > "$target_dir/$DOC_JSON"
else
  rm -f "$target_dir/$DOC_JSON"
fi

# Build the list of staged scope-touching files for the error message.
scope_files=$(printf '%s\n' "$staged" \
  | grep -E '^src/provisioning/register-providers\.ts$|^tests/integration/[^/]+/(lib|bin)/.+\.ts$' \
  | sed 's/^/  - /')

{
  echo "${RED_BOLD}Blocked by integ-coverage-matrix-gate: integ coverage matrix is stale.${RESET}"
  echo
  echo "You staged changes that touch the integ-coverage matrix's source scope:"
  printf '%s\n' "$scope_files"
  echo
  echo "Regenerating the matrix would change these snapshot files:"
  if [[ "$md_changed" -eq 1 ]]; then echo "  - $DOC_MD"; fi
  if [[ "$json_changed" -eq 1 ]]; then echo "  - $DOC_JSON"; fi
  echo
  echo "WHY: CI's check-build-test job runs 'vp run integ-coverage' followed by"
  echo "'git diff --quiet -- $DOC_MD $DOC_JSON' on every PR. A forgotten regen"
  echo "makes CI hard-fail. /check + /check-docs don't catch this (their scopes"
  echo "are build/lint/test and doc consistency, not generated artifacts);"
  echo "/verify-pr step 5 does, but commits typically land before /verify-pr."
  echo
  echo "Fix:"
  echo "  1. Regenerate the matrix:"
  echo "       vp run integ-coverage"
  echo "  2. Stage the regen:"
  echo "       git add $DOC_MD $DOC_JSON"
  echo "  3. Retry the commit."
} >&2

exit 2
