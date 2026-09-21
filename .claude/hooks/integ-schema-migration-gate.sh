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
#      deletions touching the two declarations a bump edits in
#      `src/types/state.ts`: the `StateSchemaVersion` UNION and the
#      `STATE_SCHEMA_VERSION_CURRENT` constant. The exact patterns, and why
#      the ones this gate shipped with matched NEITHER of them, are at the
#      matching loop below (go-to-k/cdkd#3351) rather than restated here --
#      a second copy of a regex in prose is how the first pair came to
#      describe a file that does not exist. Non-version-bump edits to
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
  || ! declare -F gate_resolve_marker_gate >/dev/null \
  || ! declare -F gate_refuse_no_equivalent_marker >/dev/null \
  || ! declare -F gate_refuse_stale_alias_marker >/dev/null \
  || ! declare -F gate_refuse_unevaluable_marker >/dev/null \
  || ! declare -F cmd_last_cd_target >/dev/null \
  || ! declare -F gate_target_is_foreign >/dev/null \
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

# go-to-k/cdkd#2729: the load guard above covers the FUNCTIONS this hook calls
# and CANNOT see a missing CONSTANT. Reading one the library does not define
# aborts under `set -u` with exit 1, and per .claude/rules/hooks.md any exit
# that is not 2 propagates as a NON-BLOCKING error -- i.e. a PASS. Refuse
# instead, unconditionally and before the first constant is read, naming every
# GATE_* constant read below. NOT yet fenced as a class -- the fence was split
# out of this change and is tracked by go-to-k/cdkd#2826, so nothing
# mechanical notices a hook that reads a constant without this call.
if ! declare -F gate_require_const >/dev/null 2>&1; then
  # The helper itself is missing, so nothing below can be trusted either.
  echo "Blocked: .claude/hooks/lib/command-match.sh loaded but does not define" >&2
  echo "gate_require_const, so this gate cannot verify the constants it reads." >&2
  exit 2
fi
gate_require_const GATE_RE_GH_PR_MERGE

set -u

# Read the PreToolUse payload (command + cwd).
input=$(cat 2>/dev/null || true)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `gh pr merge` (including --auto). Every other command,
# including `gh pr create`, passes through — opening a PR for review
# should always be allowed. Tolerate an optional `gh -C <path>` between
# Matching goes through the SHARED command-position matcher
# (.claude/hooks/lib/command-match.sh, issue #1455): heredoc bodies and
# quoted spans are stripped, then the verb is matched at line start OR
# after a `&&` / `||` / `;` / `|` operator. That catches chained
# invocations the old line-start anchor missed, while a quoted mention
# still does not fire (it is removed rather than dodged by position).
if ! gate_matches "$cmd" "$GATE_RE_GH_PR_MERGE"; then
  exit 0
fi

# Resolve where the gh command will actually run (cwd-aware; cdkd #559
# — pre-fix the hook resolved REPO from BASH_SOURCE which always
# landed in the main tree, defeating markgate's per-worktree isolation;
# see memory rule feedback_cross_agent_main_tree_contention.md).
# Where the git/gh command will actually RUN.
#
# This calls the SHARED resolver in lib/command-match.sh, replacing the
# hand-rolled `-C` scan this hook used to carry. That copy captured the raw
# token with no guard for an unexpanded `$VAR`, so the standard worktree
# spelling `git -C "$W" ...` resolved to the literal `<cwd>/$W`, the repo
# probe below failed, and the gate exited 0 over a tree it never looked at
# (go-to-k/cdkd#2027). The strict resolver refuses instead of guessing.
__verb_ere="$GATE_RE_GH_PR_MERGE"
if ! target_dir=$(gate_target_dir_strict "$cmd" "${hook_cwd:-$PWD}" "$__verb_ere"); then
  gate_refuse_unresolved_target "integ-schema-migration-gate" "${hook_cwd:-$PWD}"
fi

if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# REPO IDENTITY (go-to-k/cdkd#3351), and it MUST be computed HERE -- above the
# `cd` on the next line. `$__hook_dir` is RELATIVE in production
# (`${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/...`), so asking this question from
# inside the target directory resolves the hook's "own" repo TO THE TARGET, and
# every target then classifies as cdkd: the relaxation below silently inverts
# into a no-op. Same window verify-pr-gate uses.
#
# The answer is consumed by exactly ONE branch -- `__mode = none` further down --
# and NOT as an early exit. That placement is deliberate and was measured: an
# early `exit 0` for a foreign target takes this gate below the reachability
# floor in `markgate-gate-name-class.test.sh` (its fixture is a throwaway
# `git init` repo, hence foreign) and in `unresolved-target-class.test.sh`'s
# EXPECTED_EXERCISED, i.e. the gate would go quiet in the two fences whose whole
# job is to notice a gate going quiet.
__target_is_foreign=0
if gate_target_is_foreign "$__hook_dir" "$target_dir" "$cmd" "$__verb_ere"; then
  __target_is_foreign=1
fi

cd "$target_dir" 2>/dev/null || exit 0

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

# Match either the StateSchemaVersion UNION declaration or the
# STATE_SCHEMA_VERSION_CURRENT constant -- the two lines a real bump edits.
# Only lines starting with + or - inside the diff for src/types/state.ts
# count; we walk file blocks to avoid matching version references in unrelated
# files included in the same PR.
#
# A "version bump" is detected when we find at least one + line AND
# at least one - line where the pattern matches — i.e. the literal
# changed. This avoids false-positive on a fresh file with only + lines
# (uncommon for state.ts since v1 lands long ago) and on a pure deletion
# (also uncommon since v1 history is preserved).
#
# THESE PATTERNS WERE WRITTEN AGAINST THE DOCUMENTATION AND NEVER MATCHED THE
# FILE (go-to-k/cdkd#3351). Until that issue they read
# `version:[[:space:]]*[0-9]+(...)+` and `STATE_SCHEMA_VERSION[[:space:]]*=...`,
# which describe `version: 1 | 2 | 3 | 4 | 5;` and `STATE_SCHEMA_VERSION = 5` --
# the shape the docs' flattened `interface StackState` snippet renders
# (`.claude/rules/state-schema.md`, `docs/state-management.md`).
# `git log -S'  version: 1 | 2' -- src/types/state.ts` is EMPTY: the real file
# has always spelled the union as a named type and the constant with a `_CURRENT`
# suffix, so `_CURRENT:` intervenes before the `=` and the field itself carries
# no digits at all:
#
#   export type StateSchemaVersion = 1 | 2 | ... | 10;
#   export const STATE_SCHEMA_VERSION_CURRENT: StateSchemaVersion = 10;
#   version: StateSchemaVersion;          <- the StackState field
#
# Both regexes scored 0 against all three, so every bump merged with this gate
# reporting "non-bump edit" -- v6 (#546), v7 (#633), v8 (#671), v9 (#2194) and
# v10 (#3006). DERIVE any future change to these patterns from
# `src/types/state.ts`, never from a doc that describes it; the suite's fixture
# is generated from that file for the same reason.
#
# TWO BOUNDS, recorded so the next author does not discharge them by widening a
# pattern from prose again -- which is the exact move that produced the bug:
#
#   - The union pattern needs the declaration on ONE line. Print width here is
#     100 and the union is 72 characters at v10, growing ~5 per member, so it
#     reflows somewhere around v16 and this alternative then matches nothing,
#     leaving the `_CURRENT` one to carry the gate alone. That fails LOUDLY
#     rather than silently: the suite derives its fixture with
#     `grep -m1 '^export type StateSchemaVersion = '`, which misses a wrapped
#     head. Review measured which floor actually catches it: FLOOR 2, not
#     FLOOR 1 -- the grep still matches something, and it is the "the bump
#     changed nothing" guard that fires. Still loud either way. When it fires,
#     teach the derivation and the pattern about the wrap; do not delete the
#     floor.
#   - `[^=<>]*` excludes `<` and `>` on purpose. With a bare `[^=]*` the span
#     reaches across a `>=`, and a JSDoc line such as
#     `* \`STATE_SCHEMA_VERSION_CURRENT\` is stamped whenever version >= 2.`
#     MATCHES (measured) -- a false positive in a file whose header promises
#     comment edits never activate the gate. Fail-closed, but wrong.
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
      if printf '%s' "$payload" | grep -qE 'StateSchemaVersion[[:space:]]*=[[:space:]]*[0-9]+([[:space:]]*\|[[:space:]]*[0-9]+)+' \
        || printf '%s' "$payload" | grep -qE 'STATE_SCHEMA_VERSION_CURRENT[^=<>]*=[[:space:]]*[0-9]+'; then
        plus_match=1
      fi
      ;;
    "-"*)
      payload="${line#-}"
      if printf '%s' "$payload" | grep -qE 'StateSchemaVersion[[:space:]]*=[[:space:]]*[0-9]+([[:space:]]*\|[[:space:]]*[0-9]+)+' \
        || printf '%s' "$payload" | grep -qE 'STATE_SCHEMA_VERSION_CURRENT[^=<>]*=[[:space:]]*[0-9]+'; then
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

# --- which marker to ask about in THIS target repo (go-to-k/cdkd#2236) ---
# Same structural defect as integ-local-gate: this hook fires on merges whose
# target is a SIBLING repo too, and `integ-schema-migration` is a cdkd-only gate
# name, so a sibling took a refusal it could never clear. No alias row for this
# gate: cdk-local DOES persist a versioned state document (its own
# `src/types/state.ts`, at v7 in the same spelling as cdkd's), but none of the
# gates it declares -- check / docs / verify-pr / pr-review / integ /
# cdkd-parity / create-integ / merge-pr -- attests to a vN -> vN+1 round trip,
# so there is nothing for an alias row to point at. An earlier revision said
# "neither sibling persists a versioned state document", which is false and was
# contradicted thirteen lines below by this file's own relaxation comment.
__plan=$(gate_resolve_marker_gate "$target_dir" integ-schema-migration)
__mode=$(printf '%s' "$__plan" | cut -f1)
__gate=$(printf '%s' "$__plan" | cut -f2)
__gate_fix=$(printf '%s' "$__plan" | cut -f3)

if [ "$__mode" = "none" ]; then
  # A FOREIGN target that declares no equivalent gate PASSES (go-to-k/cdkd#3351),
  # on the go-to-k/cdkd#3209 precedent: a requirement only THIS repo defines is
  # required only where it is defined. Before #3351 this branch was unreachable
  # for the one repo it matters to -- the regexes above matched nothing, so no
  # sibling merge ever got here. Fixing them made it reachable, and
  # `/Users/goto/github/cdk-local` is the live case: same `src/types/state.ts`
  # path, byte-identical spelling, its own schema at v7, and a `.markgate.yml`
  # declaring check/docs/verify-pr/pr-review/integ/cdkd-parity/create-integ/
  # merge-pr -- no `integ-schema-migration`. Refusing there is unclearable by any
  # action that repo can take, which is the go-to-k/cdkd#2236 failure this gate
  # already carries a fix for; cdk-local's schema is cdk-local's contract to gate.
  #
  # BOTH conjuncts are load-bearing. `gate_target_is_foreign` is false for an
  # UNRESOLVABLE identity, so an unreadable target keeps the refusal, and its
  # allowlist half refuses to relax when the command names another repo --
  # without it, `gh pr merge <N> --repo go-to-k/cdkd` issued from a sibling
  # checkout resolves a CDKD pull request while `$target_dir` is the sibling,
  # and a real cdkd schema bump would merge ungated. That exact spelling was
  # measured going 2 -> 0 on verify-pr-gate before #3209 built the allowlist.
  #
  # RESIDUE, deliberate and fail-closed: a foreign repo whose `.markgate.yml`
  # exists but does not PARSE resolves to `canonical` (not `none`) and still
  # takes the unclearable refusal. Narrowing that needs evidence this gate does
  # not have -- an unparsable config cannot say what it declares.
  if [ "$__target_is_foreign" -eq 1 ]; then
    exit 0
  fi
  # A foreign target that did NOT relax reaches here, and the refusal it is
  # about to print tells it to add a GATE_MARKER_ALIASES row -- which is the
  # wrong remedy when the real cause was the RELAXATION being withdrawn (an
  # unexpanded `$VAR` in the command, a repo override, a `git remote add
  # upstream` naming cdkd). Say so first; `gate_refuse_no_equivalent_marker`
  # then exits 2 as before. Without this the reader is sent to a mapping table
  # that cannot fix their problem.
  if [ -n "${GATE_FOREIGN_RETRACT:-}" ]; then
    printf 'integ-schema-migration-gate: this target was NOT treated as a separate repository, because %s.\n' \
      "$GATE_FOREIGN_RETRACT" >&2
    printf '  If it really is one, re-run without that, and the gate will not apply here at all.\n' >&2
  fi
  gate_refuse_no_equivalent_marker "integ-schema-migration-gate" "integ-schema-migration" "$target_dir" \
    "a state schema version bump (src/types/state.ts)"
fi

"${markgate[@]}" verify "$__gate" >/dev/null 2>&1
status=$?
if [ "$status" -eq 0 ]; then
  exit 0
fi

# markgate exit 2 is "could not EVALUATE", not "stale", and the remedies are
# OPPOSITE. This MUST come before the alias refusal below: the one alias that
# exists is a `hash: diff` gate whose NORMAL verdict from a base tree is exit 2,
# and the alias refusal would tell the reader to go run an integ, which cannot
# clear it (go-to-k/cdkd#2236 review, items 1 + 2).
if [ "$status" -eq 2 ]; then
  gate_refuse_unevaluable_marker "integ-schema-migration-gate" "$__gate" "$target_dir"
fi

if [ "$__mode" = "alias" ]; then
  gate_refuse_stale_alias_marker "integ-schema-migration-gate" "integ-schema-migration" "$target_dir" \
    "$__gate" "$__gate_fix" \
    "a state schema version bump (src/types/state.ts)"
fi

# Extract the parenthesized reason (`digest differs` vs `expired by ttl`
# vs `marker missing`) for a more actionable error message.
reason=$("${markgate[@]}" status "$__gate" 2>/dev/null \
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
