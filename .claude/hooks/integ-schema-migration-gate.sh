#!/usr/bin/env bash
# integ-schema-migration-gate.sh
#
# PreToolUse hook. Blocks `gh pr merge` (including --auto) when the
# PR diff modifies the `StackState.version` literal type in
# `src/types/state.ts` AND the `integ-schema-migration` markgate
# marker is stale.
#
# Why this gate exists (memory rule
# feedback_schema_version_migration_integ_required.md):
#
#   cdkd's S3 state schema (`s3://bucket/cdkd/<stack>/<region>/state.json`)
#   is the actual user contract — millions of state files live in real
#   AWS accounts under the v1..v5 shapes. A schema version bump
#   (v5 -> v6 etc.) MUST be transparently auto-migrated by the new
#   binary AND verified by a real-AWS integ test that proves the
#   round-trip: old binary writes vN -> new binary reads vN -> writes
#   back vN+1 -> destroy clean. Unit tests that mock the state shape
#   are NOT sufficient; the S3 wire format has its own gotchas
#   (`undefined` field stripping, key ordering, schema version
#   coercion) that only real round-trip catches.
#
#   The contract this gate enforces is absolute: every schema bump
#   MUST be transparently auto-migrated by the new binary AND verified
#   by a real-AWS round-trip integ. Users must never have to run an
#   explicit migrate command — the next read of a vN state file by
#   the vN+1 binary auto-upgrades in memory, and the next write
#   persists vN+1 silently. Schema bumps that violate transparent
#   auto-migration are not shippable.
#
# How this gate enforces it:
#
#   1. The PR's diff (via `gh pr diff <N>`) is grep'd for additions or
#      deletions touching the literal-type version line in
#      `src/types/state.ts`. The grep matches `version:\s*\d+(\s*\|\s*\d+)+`
#      OR `STATE_SCHEMA_VERSION\s*=\s*\d+`. Non-version-bump edits to
#      state.ts (JSDoc, helper additions, comment fixes) pass through
#      with no false-positive activation — the file-scope check is
#      narrowed by the second-pass git diff grep so the gate
#      activates ONLY on a real schema bump.
#   2. For schema-bump PRs, `markgate verify integ-schema-migration`
#      must pass. The `integ-schema-migration` gate's include scope is
#      `src/types/state.ts` so file-level changes invalidate the
#      marker too; the second-pass grep ensures we only ENFORCE on
#      bumps. The marker also carries the same 14d TTL as
#      integ-destroy / integ-broad / integ-local so AWS-side / binary
#      drift forces a fresh migration integ periodically.
#
# Set ONLY by /run-integ when the integ test name matches
# `schema-v*-to-v*-migration` AND the run was clean (deploy under
# vN -> upgrade to vN+1 -> read works -> destroy 0 errors).
# Never call `markgate set integ-schema-migration` by hand.

set -u

# Resolve repo root from script location, accounting for worktrees by
# preferring the shared `.git` parent (same pattern as
# pr-review-gate.sh / integ-broad-gate.sh after PR #339).
SCRIPT_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if git_common=$(git -C "$SCRIPT_REPO" rev-parse --git-common-dir 2>/dev/null); then
  case "$git_common" in
    /*) abs_common="$git_common" ;;
    *)  abs_common="$SCRIPT_REPO/$git_common" ;;
  esac
  REPO="$(cd "$(dirname "$abs_common")" 2>/dev/null && pwd)" || REPO="$SCRIPT_REPO"
else
  REPO="$SCRIPT_REPO"
fi

# Read the PreToolUse payload (command + cwd).
input=$(cat 2>/dev/null || true)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Only gate `gh pr merge` (including --auto). Every other command,
# including `gh pr create`, passes through — opening a PR for review
# should always be allowed.
if ! printf '%s' "$cmd" | grep -qE '\bgh[[:space:]]+pr[[:space:]]+merge\b'; then
  exit 0
fi

cd "$REPO" 2>/dev/null || exit 0

# Schema scope: the single file carrying the StackState.version
# literal type + STATE_SCHEMA_VERSIONS_READABLE constant + every
# state-shape interface.
SCHEMA_FILE='src/types/state.ts'

# --- Extract PR number from the `gh pr merge` command (same pattern
# as integ-broad-gate.sh / pr-review-gate.sh).
pr_number=""
args="${cmd#*merge}"
# shellcheck disable=SC2086
set -- $args
while [ $# -gt 0 ]; do
  case "$1" in
    --*=*) shift; continue ;;
    --auto|--admin|--delete-branch|--squash|--merge|--rebase)
      shift; continue ;;
    -*)
      shift
      [ $# -gt 0 ] && shift
      continue
      ;;
    *)
      if printf '%s' "$1" | grep -qE '^[0-9]+$'; then
        pr_number="$1"
        break
      fi
      shift
      ;;
  esac
done

# Pass-through on any gh error so an unrelated infra outage doesn't
# block merges (mirrors integ-destroy-gate.sh / pr-review-gate.sh /
# integ-broad-gate.sh).
if [ -n "$pr_number" ]; then
  pr_json=$(gh pr view "$pr_number" --json files 2>/dev/null) || {
    printf 'integ-schema-migration-gate: gh pr view %s failed; allowing merge (infra fail-open)\n' "$pr_number" >&2
    exit 0
  }
else
  pr_json=$(gh pr view --json files 2>/dev/null) || {
    echo "integ-schema-migration-gate: gh pr view failed; allowing merge (infra fail-open)" >&2
    exit 0
  }
fi

paths=$(printf '%s' "$pr_json" | jq -r '.files[].path' 2>/dev/null || echo "")

# Cheap first pass: does the PR touch the schema file at all? If not,
# this gate has nothing to enforce and exits cleanly.
touches_schema_file=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if [ "$f" = "$SCHEMA_FILE" ]; then
    touches_schema_file=1
    break
  fi
done <<EOF_FILES
$paths
EOF_FILES

if [ "$touches_schema_file" -eq 0 ]; then
  exit 0
fi

# Precise second pass: fetch the actual PR diff and check whether the
# version constant changed. This eliminates false positives on JSDoc /
# comment / helper-function edits to state.ts that don't actually bump
# the schema.
if [ -n "$pr_number" ]; then
  pr_diff=$(gh pr diff "$pr_number" 2>/dev/null) || {
    printf 'integ-schema-migration-gate: gh pr diff %s failed; allowing merge (infra fail-open)\n' "$pr_number" >&2
    exit 0
  }
else
  pr_diff=$(gh pr diff 2>/dev/null) || {
    echo "integ-schema-migration-gate: gh pr diff failed; allowing merge (infra fail-open)" >&2
    exit 0
  }
fi

# Match either the StackState.version literal type pattern
# (`version: 1 | 2 | 3 | 4 | 5;`) OR a STATE_SCHEMA_VERSION constant
# assignment (`STATE_SCHEMA_VERSION = 5`). Only lines starting with +
# or - inside the diff for src/types/state.ts count; we walk file
# blocks to avoid matching version references in unrelated files
# included in the same PR.
#
# A "version bump" is detected when we find at least one + line AND
# at least one - line where the literal version pattern matches —
# i.e. the literal changed. This avoids false-positive on a fresh
# file with only + lines (uncommon for state.ts since v1 lands long
# ago) and on a pure deletion (also uncommon since v1 history is
# preserved).
plus_match=0
minus_match=0
in_schema_block=0

while IFS= read -r line; do
  case "$line" in
    "diff --git "*"$SCHEMA_FILE"*)
      in_schema_block=1
      continue
      ;;
    "diff --git "*)
      in_schema_block=0
      continue
      ;;
  esac
  [ "$in_schema_block" -eq 0 ] && continue

  case "$line" in
    "+"*)
      payload="${line#+}"
      if printf '%s' "$payload" | grep -qE 'version:[[:space:]]*[0-9]+([[:space:]]*\|[[:space:]]*[0-9]+)+' \
        || printf '%s' "$payload" | grep -qE 'STATE_SCHEMA_VERSION[[:space:]]*=[[:space:]]*[0-9]+'; then
        plus_match=1
      fi
      ;;
    "-"*)
      payload="${line#-}"
      if printf '%s' "$payload" | grep -qE 'version:[[:space:]]*[0-9]+([[:space:]]*\|[[:space:]]*[0-9]+)+' \
        || printf '%s' "$payload" | grep -qE 'STATE_SCHEMA_VERSION[[:space:]]*=[[:space:]]*[0-9]+'; then
        minus_match=1
      fi
      ;;
  esac
done <<EOF_DIFF
$pr_diff
EOF_DIFF

if [ "$plus_match" -eq 0 ] || [ "$minus_match" -eq 0 ]; then
  # state.ts changed but the version constant didn't — non-bump edit
  # (JSDoc, helper, type-comment fix). Pass through.
  exit 0
fi

# This IS a schema version bump. Enforce the marker.
if command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
elif command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
else
  echo "Blocked by integ-schema-migration-gate: markgate is not installed. Run 'mise install' at the repo root (see CONTRIBUTING.md)." >&2
  exit 2
fi

"${markgate[@]}" verify integ-schema-migration >/dev/null 2>&1
status=$?
if [ "$status" -eq 0 ]; then
  exit 0
fi

# Extract the parenthesized reason (`digest differs` vs `expired by ttl`
# vs `marker missing`) for a more actionable error message.
reason=$("${markgate[@]}" status integ-schema-migration 2>/dev/null \
  | awk '/^state:/ { if (match($0, /\([^)]+\)/)) print substr($0, RSTART, RLENGTH); exit }')

if [ -n "$reason" ]; then
  printf "Blocked by integ-schema-migration-gate: this PR bumps the cdkd state schema version (src/types/state.ts) and the \`integ-schema-migration\` marker is stale %s.\n\n" "$reason" >&2
else
  cat >&2 <<'EOF_HEAD'
Blocked by integ-schema-migration-gate: this PR bumps the cdkd
state schema version (src/types/state.ts) and the
`integ-schema-migration` marker is stale or missing.

EOF_HEAD
fi

cat >&2 <<'EOF'
Why: cdkd's S3 state schema is the actual user contract. A version
bump (vN -> vN+1) must be transparently auto-migrated by the new
binary AND verified by a real-AWS integration test that proves the
round-trip: deploy under vN -> upgrade binary -> read works -> write
back vN+1 -> destroy clean. Unit tests cannot catch wire-format
divergences (`undefined` stripping, key ordering, schema version
coercion). The user instruction is absolute — schema bumps MUST
ship with a migration integ test that runs against real AWS.

Required action — no exceptions:
  1. Add a real-AWS integ fixture at
     `tests/integration/schema-v<N>-to-v<N+1>-migration/`
     with a `verify.sh` that:
       - deploys a stack under the OLD binary (or uses a recorded
         vN state.json fixture checked into the repo)
       - switches to the NEW binary and verifies every command
         works against the vN state without re-deploying
         (deploy / destroy / state list / state show / drift)
       - verifies the next write upgrades to vN+1 silently
       - asserts the post-migration state.json on S3 has the
         expected vN+1 shape
       - cleans up via destroy on all exit paths
  2. Run `/run-integ schema-v<N>-to-v<N+1>-migration` and confirm
     0 errors / 0 orphans.
  3. ALSO run one broad integ (e.g. `/run-integ bench-cdk-sample`)
     since state.ts is widely-imported and the schema change can
     affect every SDK provider's read/write path.

The skill is the ONLY legitimate setter of this marker. It will
call `markgate set integ-schema-migration` only when the test
name matches `schema-v*-to-v*-migration` AND the test ran clean
end-to-end (deploy + destroy + 0 orphans).

Do NOT call `markgate set integ-schema-migration` directly from
a shell to bypass this hook. The whole point of the gate is that
an unverified schema bump cannot reach main; setting the marker
by hand defeats it.

See memory rule
feedback_schema_version_migration_integ_required.md for the
full migration test checklist.
EOF
exit 2
