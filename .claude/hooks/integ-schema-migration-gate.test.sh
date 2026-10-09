#!/usr/bin/env bash
# Smoke test for integ-schema-migration-gate.sh.
#
# Exercises the command-matching, file-scope filter (state.ts in
# PR files), and the precise second-pass `gh pr diff` grep that
# distinguishes a real version bump from cosmetic edits to
# `src/types/state.ts`. Marker freshness is mocked via
# $MARKGATE_MOCK_VERDICT so the test runs deterministically
# regardless of the local repo's markgate state.
#
# Run from the repo root: `bash .claude/hooks/integ-schema-migration-gate.test.sh`.

set -u

# The gate consults `gate_target_is_foreign` since go-to-k/cdkd#3351, whose
# allowlist reads `GH_REPO` from the ENVIRONMENT: inherited, it retracts the
# relaxation in every case at once. verify-pr-gate.test.sh carries the same line
# with a measured reason (with `GH_REPO=x` exported that suite reported 69/10).
#
# `GH_HOST` is unset alongside it because gh honours it too and this suite must
# not depend on the caller's environment -- but note the allowlist does NOT read
# it, so unsetting it here fences nothing on its own. An earlier revision of
# this comment claimed it did; that is the shape of claim this whole PR exists
# to stop making.
unset GH_REPO GH_HOST

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/integ-schema-migration-gate.sh"
HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_REAL="$HOOKS_DIR/lib/command-match.sh"

# `run-tests.sh` runs each SUITE under both bashes and exports HOOK_BASH, but the
# hook is `#!/usr/bin/env bash` and takes whatever is first on PATH -- so without
# this the hook has never run under bash 3.2 locally, only in CI (go-to-k/cdkd#2715).
# "Passes under 3.2" was true of the test and false of the thing under test.
HOOK_RUN="${HOOK_BASH:+$HOOK_BASH }$HOOK"

# go-to-k/cdkd#2236: a fixture repo must DECLARE the gate the hook asks about,
# the way the real repo does. The gates now read the target repo's own
# `.markgate.yml` to tell "this repo does not have that gate" (unsatisfiable --
# the sibling-repo defect) from "the marker is stale", so a fixture with no
# config takes the no-equivalent-gate refusal and never reaches markgate at all.
# Without this the cwd assertions below go green-to-red, and worse, the exit-2
# cases would pass for the wrong reason.
declare_gate() {
  printf 'gates:\n  %s:\n    hash: files\n    include:\n      - "src/**"\n' "$2" > "$1/.markgate.yml"
}


TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

GH_BIN_DIR="$TMPDIR/bin"
mkdir -p "$GH_BIN_DIR"

GH_MOCK_FILES="$TMPDIR/gh-mock-files.json"
GH_MOCK_DIFF="$TMPDIR/gh-mock-diff.txt"

# Mock gh: dispatches on the first two arg pairs ("pr view" / "pr
# diff") to its respective payload file. Exit 1 when the payload
# file is absent (simulates gh failure for the infra-fail-open test).
cat > "$GH_BIN_DIR/gh" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "pr" ] && [ "\$2" = "view" ]; then
  if [ ! -f "$GH_MOCK_FILES" ]; then exit 1; fi
  cat "$GH_MOCK_FILES"
  exit 0
fi
if [ "\$1" = "pr" ] && [ "\$2" = "diff" ]; then
  if [ ! -f "$GH_MOCK_DIFF" ]; then exit 1; fi
  cat "$GH_MOCK_DIFF"
  exit 0
fi
exit 1
EOF
chmod +x "$GH_BIN_DIR/gh"

# Mock mise: pass-through `mise exec -- <cmd> <args>`.
cat > "$GH_BIN_DIR/mise" <<'MISE_EOF'
#!/usr/bin/env bash
if [ "$1" = "exec" ] && [ "$2" = "--" ]; then
  shift 2
  exec "$@"
fi
exit 1
MISE_EOF
chmod +x "$GH_BIN_DIR/mise"

# Trace file: the mocked markgate writes $PWD to this file on every
# call. Each test case can assert the hook `cd`'d to the resolved
# target dir before invoking markgate. Mirrors check-gate.test.sh
# (post-#562) — closes the coverage gap the #562 reviewer flagged.
CWD_TRACE_FILE="$TMPDIR/cwd-trace"

# Mock markgate: verdict pinned by $MARKGATE_MOCK_VERDICT. Also
# writes $PWD to $CWD_TRACE_FILE so the cwd-aware test cases can
# assert the hook `cd`'d to the resolved target dir.
cat > "$GH_BIN_DIR/markgate" <<MARKGATE_EOF
#!/usr/bin/env bash
echo "\$PWD" >> "$CWD_TRACE_FILE"
verdict="\${MARKGATE_MOCK_VERDICT:-stale}"
case "\$1" in
  verify)
    [ "\$verdict" = "fresh" ] && exit 0
    exit 1
    ;;
  status)
    if [ "\$verdict" = "fresh" ]; then
      printf 'key:        %s\nstate:      match\n' "\$2"
    else
      printf 'key:        %s\nstate:      stale (marker missing)\n' "\$2"
    fi
    exit 0
    ;;
esac
exit 1
MARKGATE_EOF
chmod +x "$GH_BIN_DIR/markgate"

export PATH="$GH_BIN_DIR:$PATH"
export MARKGATE_MOCK_VERDICT="stale"

pass=0
fail=0
fail_log=""

# run_case <name> <expect_exit> <payload> <files_json> <diff_text> [expect_cwd]
#   payload     - PreToolUse JSON
#   files_json  - JSON for `gh pr view --json files` (empty -> gh failure)
#   diff_text   - text for `gh pr diff` (empty -> gh failure)
#   expect_cwd  - optional: dir the hook should have cd'd into before
#                 calling markgate. The mocked markgate appends $PWD
#                 to $CWD_TRACE_FILE; this assertion verifies the
#                 cwd-aware resolution actually landed there. Empty
#                 skips the cwd assertion (pass-through cases that
#                 never reach markgate).
run_case() {
  local name="$1"; local want="$2"; local payload="$3"; local files="$4"; local diff="$5"; local expect_cwd="${6:-}"
  : > "$CWD_TRACE_FILE"
  if [ -n "$files" ]; then
    echo "$files" > "$GH_MOCK_FILES"
  else
    rm -f "$GH_MOCK_FILES"
  fi
  if [ -n "$diff" ]; then
    printf '%s' "$diff" > "$GH_MOCK_DIFF"
  else
    rm -f "$GH_MOCK_DIFF"
  fi
  local got
  printf '%s' "$payload" | $HOOK_RUN >/dev/null 2>&1
  got=$?

  local cwd_ok=1
  if [ -n "$expect_cwd" ]; then
    if ! grep -qFx "$expect_cwd" "$CWD_TRACE_FILE" 2>/dev/null; then
      cwd_ok=0
    fi
  fi

  if [[ "$got" == "$want" ]] && [ "$cwd_ok" -eq 1 ]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got"
    if [ "$cwd_ok" -eq 0 ]; then
      fail_log+="; cwd mismatch (want '$expect_cwd', trace: $(cat "$CWD_TRACE_FILE" 2>/dev/null | tr '\n' '|'))"
    fi
    fail_log+="\n  payload: $payload\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# --- Pass-through cases (not gh pr merge) -------------------------

run_case "git_status passes through" 0 \
  '{"tool_input":{"command":"git status"}}' \
  '{"files":[]}' ''

run_case "gh_pr_create passes through" 0 \
  '{"tool_input":{"command":"gh pr create --title x --body y"}}' \
  '{"files":[]}' ''

run_case "gh_pr_view passes through" 0 \
  '{"tool_input":{"command":"gh pr view 123"}}' \
  '{"files":[]}' ''

# --- PR does NOT touch state.ts -----------------------------------

run_case "non_schema_PR passes through" 0 \
  '{"tool_input":{"command":"gh pr merge 100 --squash"}}' \
  '{"files":[{"path":"src/cli/commands/destroy.ts"},{"path":"README.md"}]}' \
  ''

run_case "non_schema_PR with --auto passes through" 0 \
  '{"tool_input":{"command":"gh pr merge --auto --squash 200"}}' \
  '{"files":[{"path":"src/local/http-server.ts"}]}' \
  ''

# --- PR touches state.ts but NO version-constant change in diff ---

# Example: JSDoc-only edit to state.ts (the "limit-near-zero false
# positive" case). The diff has + lines mentioning state but neither
# the version literal type pattern nor STATE_SCHEMA_VERSION constant.
COSMETIC_DIFF='diff --git a/src/types/state.ts b/src/types/state.ts
index abc..def 100644
--- a/src/types/state.ts
+++ b/src/types/state.ts
@@ -10,3 +10,4 @@
 // JSDoc text
-// Old comment
+// New comment about state shape
+// Additional explanation paragraph'

run_case "state.ts cosmetic edit passes through" 0 \
  '{"tool_input":{"command":"gh pr merge 300 --squash"}}' \
  '{"files":[{"path":"src/types/state.ts"}]}' \
  "$COSMETIC_DIFF"

# Example: helper function added to state.ts without changing
# the version literal type.
HELPER_DIFF='diff --git a/src/types/state.ts b/src/types/state.ts
index abc..def 100644
--- a/src/types/state.ts
+++ b/src/types/state.ts
@@ -50,0 +51,4 @@
+export function isV5(state: StackState): boolean {
+  return state.version === 5;
+}
+'

run_case "state.ts helper-only addition passes through" 0 \
  '{"tool_input":{"command":"gh pr merge 301 --squash"}}' \
  '{"files":[{"path":"src/types/state.ts"}]}' \
  "$HELPER_DIFF"

# --- PR touches state.ts AND bumps the version literal type -------

# THE FIXTURE IS DERIVED FROM THE REAL FILE, NOT HAND-DRAWN (go-to-k/cdkd#3351).
# Until that issue the two bump fixtures below spelled `version: 1 | 2 | 3;` and
# `export const STATE_SCHEMA_VERSION = 5;`. Neither shape has ever existed in
# `src/types/state.ts` -- `git log --all -S'  version: 1 | 2'` over that file is
# EMPTY -- they are the flattened `interface StackState` rendering the docs
# carry. So the gate's regexes and this suite's fixtures were written from
# the same prose and agreed with each other perfectly while matching nothing the
# repo can actually produce: every case passed, and five real schema bumps
# merged with the gate reporting "non-bump edit".
#
# Reading the real declarations makes that failure unrepresentable: a fixture
# that cannot be produced from the file under test cannot silently stop
# describing it. Same shape as the PARSER FENCE in integ-local-gate.test.sh,
# which asserts against the real `.markgate.yml` this repo ships.
SCHEMA_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/src/types/state.ts"

UNION_OLD=$(grep -m1 '^export type StateSchemaVersion = ' "$SCHEMA_SRC" 2>/dev/null || true)
CONST_OLD=$(grep -m1 '^export const STATE_SCHEMA_VERSION_CURRENT' "$SCHEMA_SRC" 2>/dev/null || true)
SCHEMA_N=$(printf '%s' "$CONST_OLD" | sed -E 's/.*=[[:space:]]*([0-9]+);.*/\1/')

# FLOOR 1: refuse to run on an empty derivation. Without this a rename in
# state.ts yields a diff carrying no +/- version line at all, every BLOCK case
# below silently becomes a PASS case, and the suite reports green over a gate
# that fires on nothing -- which is EXACTLY the failure being fixed here.
case "$SCHEMA_N" in
  '' | *[!0-9]*)
    echo "FATAL: could not derive the schema version from $SCHEMA_SRC" >&2
    echo "  union line: ${UNION_OLD:-<not found>}" >&2
    echo "  const line: ${CONST_OLD:-<not found>}" >&2
    echo "  Did the declarations get renamed? Re-derive them -- do NOT hand-write" >&2
    echo "  a fixture, which is how this suite came to test a file that does not exist." >&2
    exit 1
    ;;
esac
SCHEMA_NEXT=$((SCHEMA_N + 1))

# `[|]`, never `\|`. POSIX leaves a backslash-escaped ordinary character
# UNDEFINED in an ERE, so `\|` is at the implementation's discretion; a bracket
# expression is unambiguous everywhere and costs nothing.
#
# WHAT WAS AND WAS NOT MEASURED, because an earlier revision of this comment got
# it wrong in the direction this whole PR is about. It asserted that GNU sed 4.9
# and busybox read `\|` as ALTERNATION and corrupt the fixture -- stated as a
# measurement, and never measured: no GNU sed exists on the machine it was
# written on. Review then measured all three (BSD on macOS, GNU sed 4.9 on
# `debian:stable-slim`, busybox on `alpine:3`) and they AGREE, treating `\|` as
# a literal pipe and producing the identical correct fixture.
#
# So this is a portability HARDENING against an undefined construct, not a fix
# for an observed divergence. Keeping the spelling and deleting the false
# justification is the honest disposition; inventing a measurement to defend a
# correct change is the same defect as the doc-derived regex, one layer up.
UNION_NEW=$(printf '%s' "$UNION_OLD" | sed -E "s/ [|] ${SCHEMA_N};\$/ | ${SCHEMA_N} | ${SCHEMA_NEXT};/")
CONST_NEW=$(printf '%s' "$CONST_OLD" | sed -E "s/=[[:space:]]*${SCHEMA_N};\$/= ${SCHEMA_NEXT};/")

# FLOOR 2: the bump must actually CHANGE the line. A rename leaving both greps
# matching the same text would otherwise produce a vacuous "bump" whose + and -
# lines are identical, and the gate would be tested against a no-op.
if [ "$UNION_NEW" = "$UNION_OLD" ] || [ "$CONST_NEW" = "$CONST_OLD" ]; then
  echo "FATAL: the derived v${SCHEMA_N} -> v${SCHEMA_NEXT} bump changed nothing." >&2
  echo "  union: $UNION_OLD" >&2
  echo "  const: $CONST_OLD" >&2
  exit 1
fi

# Canonical schema bump: the UNION declaration.
BUMP_DIFF="diff --git a/src/types/state.ts b/src/types/state.ts
index abc..def 100644
--- a/src/types/state.ts
+++ b/src/types/state.ts
@@ -146,1 +146,1 @@
-${UNION_OLD}
+${UNION_NEW}"

run_case "version bump + marker stale BLOCKS" 2 \
  '{"tool_input":{"command":"gh pr merge 400 --squash"}}' \
  '{"files":[{"path":"src/types/state.ts"}]}' \
  "$BUMP_DIFF"

MARKGATE_MOCK_VERDICT="fresh" run_case "version bump + marker fresh passes" 0 \
  '{"tool_input":{"command":"gh pr merge 401 --squash"}}' \
  '{"files":[{"path":"src/types/state.ts"}]}' \
  "$BUMP_DIFF"

# The CONSTANT variant: the other line a bump edits, and a SEPARATE regex
# alternative. Kept as its own case because the two shipped patterns were wrong
# for two DIFFERENT reasons -- the union one looked for `version:` where the file
# spells `StateSchemaVersion =`, and the constant one required `=` adjacent to
# `STATE_SCHEMA_VERSION` where `_CURRENT:` intervenes -- so one case cannot
# stand in for the other.
CONST_BUMP_DIFF="diff --git a/src/types/state.ts b/src/types/state.ts
index abc..def 100644
--- a/src/types/state.ts
+++ b/src/types/state.ts
@@ -148,1 +148,1 @@
-${CONST_OLD}
+${CONST_NEW}"

run_case "STATE_SCHEMA_VERSION_CURRENT bump + marker stale BLOCKS" 2 \
  '{"tool_input":{"command":"gh pr merge 402 --squash"}}' \
  '{"files":[{"path":"src/types/state.ts"}]}' \
  "$CONST_BUMP_DIFF"

# --- THE NEGATIVE CONTROL THIS GATE SHIPPED WITHOUT (go-to-k/cdkd#3351) ------
#
# The DOC shape must NOT arm the gate. `.claude/rules/state-schema.md` renders
# StackState with the union flattened into the field:
#
#   version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
#
# `src/types/state.ts` has never spelled it that way. The original regexes
# matched THIS line and nothing in the real file, so this case is the exact
# inverse of the defect: it passes only while the patterns are derived from the
# source rather than from the prose describing it. If someone "fixes" a future
# miss by pattern-matching the docs again, this case reds.
#
# It is a DIFF the gate would otherwise treat as a bump -- a + and a - line,
# inside the state.ts block -- so it isolates the shape and nothing else.
DOC_SHAPE_DIFF='diff --git a/src/types/state.ts b/src/types/state.ts
index abc..def 100644
--- a/src/types/state.ts
+++ b/src/types/state.ts
@@ -10,1 +10,1 @@
-  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
+  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;'

run_case "the doc-snippet shape alone does NOT arm the gate" 0 \
  '{"tool_input":{"command":"gh pr merge 403 --squash"}}' \
  '{"files":[{"path":"src/types/state.ts"}]}' \
  "$DOC_SHAPE_DIFF"

# --- The `[^=<>]*` narrowing, pinned (go-to-k/cdkd#3351 round 2) -------------
#
# The constant pattern spans everything between `STATE_SCHEMA_VERSION_CURRENT`
# and the first `=`. With a bare `[^=]*` that span reaches ACROSS a `>=`, so an
# ordinary JSDoc line mentioning the constant and a comparison MATCHES -- a
# false positive in a file whose own header promises comment edits never arm the
# gate. Measured: this diff arms under `[^=]*` and does not under `[^=<>]*`.
# Fail-closed, so it costs a spurious block rather than a bypass, but the header
# would be telling the next reader something untrue.
JSDOC_COMPARISON_DIFF='diff --git a/src/types/state.ts b/src/types/state.ts
index abc..def 100644
--- a/src/types/state.ts
+++ b/src/types/state.ts
@@ -120,2 +120,2 @@
- * `STATE_SCHEMA_VERSION_CURRENT` is stamped whenever version >= 2.
+ * `STATE_SCHEMA_VERSION_CURRENT` is stamped whenever version >= 2 (reworded).'

run_case "a JSDoc line carrying >= near the constant does NOT arm the gate" 0 \
  '{"tool_input":{"command":"gh pr merge 404 --squash"}}' \
  '{"files":[{"path":"src/types/state.ts"}]}' \
  "$JSDOC_COMPARISON_DIFF"

# --- Mixed PR: state.ts bumped AND non-state files also touched ---

MIXED_DIFF="diff --git a/src/types/state.ts b/src/types/state.ts
index abc..def 100644
--- a/src/types/state.ts
+++ b/src/types/state.ts
@@ -146,1 +146,1 @@
-${UNION_OLD}
+${UNION_NEW}
diff --git a/src/state/s3-state-backend.ts b/src/state/s3-state-backend.ts
index abc..def 100644
--- a/src/state/s3-state-backend.ts
+++ b/src/state/s3-state-backend.ts
@@ -50,1 +50,1 @@
-    // unchanged
+    // adjusted comment"

run_case "mixed PR with version bump BLOCKS" 2 \
  '{"tool_input":{"command":"gh pr merge 500 --squash"}}' \
  '{"files":[{"path":"src/types/state.ts"},{"path":"src/state/s3-state-backend.ts"}]}' \
  "$MIXED_DIFF"

# --- False-positive guard: another file mentions "version: 1 | 2"
# in a comment or test fixture but state.ts itself is not changed -

OTHER_FILE_DIFF='diff --git a/docs/state-management.md b/docs/state-management.md
index abc..def 100644
--- a/docs/state-management.md
+++ b/docs/state-management.md
@@ -10,1 +10,1 @@
-version: 1 | 2 | 3 | 4 | 5;
+version: 1 | 2 | 3 | 4 | 5 | 6;'

run_case "version-pattern in docs only passes through" 0 \
  '{"tool_input":{"command":"gh pr merge 600 --squash"}}' \
  '{"files":[{"path":"docs/state-management.md"}]}' \
  "$OTHER_FILE_DIFF"

# --- Infra fail-open paths ---------------------------------------

run_case "gh pr view failure allows merge (infra fail-open)" 0 \
  '{"tool_input":{"command":"gh pr merge 700 --squash"}}' \
  '' \
  ''

# --- gh pr merge without PR number (auto-resolve via current branch)

run_case "gh pr merge no number, non-schema files passes" 0 \
  '{"tool_input":{"command":"gh pr merge --squash --delete-branch"}}' \
  '{"files":[{"path":"docs/cli-reference.md"}]}' \
  ''

# --- CWD-AWARE cases (cdkd #559) ----------------------------------
#
# Verify that the hook resolves the target git working tree from
# the payload's `cwd` field / `cd <path>` / `gh -C <path>`.
# Pre-#559 the hook always landed in the main tree.

CWD_SIDE_REPO="$TMPDIR/side-worktree"
CWD_MAIN_REPO="$TMPDIR/main-worktree"
git init -q -b feature/x "$CWD_SIDE_REPO"
declare_gate "$CWD_SIDE_REPO" integ-schema-migration
git -C "$CWD_SIDE_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git init -q -b main "$CWD_MAIN_REPO"
declare_gate "$CWD_MAIN_REPO" integ-schema-migration
git -C "$CWD_MAIN_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

# Reuse the BUMP_DIFF defined earlier (a real version-literal bump).
# With cwd in side worktree + schema bump + stale marker → block.
# $CWD_TRACE_FILE assertion verifies the hook actually `cd`'d into
# the resolved target dir before invoking markgate (issue #563 —
# closes the coverage gap the PR #562 reviewer flagged).
run_case "side worktree cwd + version bump + stale BLOCKS" 2 \
  "$(printf '{"tool_input":{"command":"gh pr merge 2000 --squash"},"cwd":"%s"}' "$CWD_SIDE_REPO")" \
  '{"files":[{"path":"src/types/state.ts"}]}' \
  "$BUMP_DIFF" \
  "$CWD_SIDE_REPO"

# `cd <side> && gh pr merge` routes to side; schema bump → block.
run_case "cd <side> && gh pr merge from main cwd + bump BLOCKS" 2 \
  "$(printf '{"tool_input":{"command":"cd %s && gh pr merge 2001 --squash"},"cwd":"%s"}' "$CWD_SIDE_REPO" "$CWD_MAIN_REPO")" \
  '{"files":[{"path":"src/types/state.ts"}]}' \
  "$BUMP_DIFF" \
  "$CWD_SIDE_REPO"

# `gh -C <side> pr merge` routes to side.
run_case "gh -C <side> pr merge + bump BLOCKS" 2 \
  "$(printf '{"tool_input":{"command":"gh -C %s pr merge 2002 --squash"},"cwd":"%s"}' "$CWD_SIDE_REPO" "$CWD_MAIN_REPO")" \
  '{"files":[{"path":"src/types/state.ts"}]}' \
  "$BUMP_DIFF" \
  "$CWD_SIDE_REPO"

# --- LINE-START ANCHORING cases (issue #563) ---
#
# The matcher MUST NOT fire when the literal substring `gh pr merge`
# appears inside a quoted argument body of an unrelated command. Per
# memory rule feedback_hook_command_match_line_start.md, applied to
# integ-schema-migration-gate.sh in issue #563 (mirroring the PR #562
# fix to check-gate.sh). Even with a schema-bump diff in the
# mocked response, the quoted-body form must pass through because
# the matcher fires BEFORE the file-scope / diff-grep checks.

run_case "gh issue body quoting 'gh pr merge' passes through (FP)" 0 \
  '{"tool_input":{"command":"gh issue create --body \"next step: gh pr merge --squash\""}}' \
  '{"files":[{"path":"src/types/state.ts"}]}' \
  "$BUMP_DIFF"

run_case "echo body quoting 'gh pr merge' passes through (FP)" 0 \
  '{"tool_input":{"command":"echo \"after CI: gh pr merge 999 --auto\""}}' \
  '{"files":[{"path":"src/types/state.ts"}]}' \
  "$BUMP_DIFF"


# --- CROSS-REPO GATE NAMING (go-to-k/cdkd#2236) ---
#
# This hook fires on every Bash call the session makes, including merges whose
# target is a SIBLING repository -- deliberate policy. It then asked that repo
# about `integ-schema-migration`, a cdkd-only gate name, and markgate exits 1 for an
# UNDECLARED gate exactly as it does for a stale marker (measured with markgate
# 0.4.1: `status` prints `state: no marker` in both cases). The refusal was
# therefore unsatisfiable by any legitimate action -- hit live on
# `integ-local-gate`, and structurally identical here.
#
# Case 2 is the load-bearing one for THIS gate: unlike `integ-local` there is
# deliberately NO alias row for `integ-schema-migration`, because neither sibling verifies
# anything equivalent. It drives a FRESH verdict, so a hook that had guessed an
# alias by name would exit 0 and the case would fail.
x2236_mk_repo() {
  local dir="$1" origin="$2"; shift 2
  git init -q -b feature/x "$dir"
  git -C "$dir" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  [ "$origin" = "-" ] || git -C "$dir" remote add origin "$origin"
  if [ "$#" -gt 0 ]; then
    printf 'gates:\n' > "$dir/.markgate.yml"
    local g
    for g in "$@"; do
      printf '  %s:\n    hash: files\n    include:\n      - "src/**"\n' "$g" >> "$dir/.markgate.yml"
    done
  fi
}

x2236_declares="$TMPDIR/x2236-declares"
x2236_mk_repo "$x2236_declares" "https://github.com/go-to-k/cdkd.git" check integ-schema-migration
x2236_other="$TMPDIR/x2236-other"
x2236_mk_repo "$x2236_other" "https://github.com/go-to-k/cdk-local.git" check docs integ
x2236_bare="$TMPDIR/x2236-bare"
x2236_mk_repo "$x2236_bare" "https://github.com/go-to-k/cdk-local.git"
x2236_emptycfg="$TMPDIR/x2236-emptycfg"
x2236_mk_repo "$x2236_emptycfg" "https://github.com/go-to-k/cdk-local.git" check
: > "$x2236_emptycfg/.markgate.yml"

# x2236_case <name> <want_exit> <verdict> <CALLED|NOT_CALLED> <want-stderr|-> <repo>
#   The marker expectation reads $CWD_TRACE_FILE, which the mocked markgate
#   appends to on every call: an empty trace means the gate answered without
#   consulting a marker at all, which is what the no-equivalent refusal must do.
x2236_case() {
  local name="$1" want="$2" verdict="$3" mg="$4" want_txt="$5" repo="$6"
  # Optional 7th arg: override the command. Needed since go-to-k/cdkd#3351 to
  # drive the allowlist half of the foreign relaxation, which reads the command
  # text rather than the target directory.
  local command="${7:-gh pr merge 1 --squash}"
  local out got detail=""
  : > "$CWD_TRACE_FILE"
  printf '{"files":[{"path":"src/types/state.ts"}]}' > "$GH_MOCK_FILES"
  printf '%s' "$BUMP_DIFF" > "$GH_MOCK_DIFF"
  out=$(printf '{"cwd":"%s","tool_input":{"command":"%s"}}' "$repo" "$command" \
    | MARKGATE_MOCK_VERDICT="$verdict" $HOOK_RUN 2>&1)
  got=$?
  [ "$got" = "$want" ] || detail="$detail; want exit $want, got $got"
  if [ "$mg" = "NOT_CALLED" ] && [ -s "$CWD_TRACE_FILE" ]; then
    detail="$detail; markgate must not be consulted, trace: $(tr '\n' '|' < "$CWD_TRACE_FILE")"
  fi
  if [ "$mg" = "CALLED" ] && [ ! -s "$CWD_TRACE_FILE" ]; then
    detail="$detail; markgate was never consulted"
  fi
  if [ "$want_txt" != "-" ] && ! printf '%s' "$out" | grep -qF "$want_txt"; then
    detail="$detail; stderr missing [$want_txt]"
  fi
  if [ -z "$detail" ]; then
    pass=$((pass + 1)); printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log="${fail_log}FAIL $name$detail\n  output: $out\n"
    printf 'FAIL %s%s\n' "$name" "$detail"
  fi
}

x2236_case "target declaring integ-schema-migration consults that marker" 2 stale CALLED - "$x2236_declares"
# --- The foreign relaxation (go-to-k/cdkd#3351) ------------------------------
#
# These two REFUSED until #3351, and the refusal was unclearable: the target
# declares no `integ-schema-migration` and no sibling gate attests to a state
# schema round trip, so no action that repo could take would satisfy it. It was
# also UNREACHABLE in practice -- the gate's regexes matched nothing, so no
# sibling merge ever got this far. Correcting the regexes made it reachable and
# cdk-local the live case, so the go-to-k/cdkd#3209 precedent applies: a
# requirement only cdkd defines is required only where it is defined.
#
# markgate is NOT_CALLED on both: the relaxation happens before the verify.
x2236_case "foreign sibling declaring only its own gate is RELAXED" 0 fresh NOT_CALLED - "$x2236_other"
x2236_case "foreign checkout with no .markgate.yml is RELAXED" 0 fresh NOT_CALLED - "$x2236_bare"

# THE FAIL-OPEN GUARD, and the reason the relaxation needs the ALLOWLIST rather
# than the directory comparison alone. `gh pr merge <N> --repo go-to-k/cdkd`
# issued from a SIBLING checkout resolves a CDKD pull request, while the target
# directory is still the sibling. Relaxing on the directory alone would let a
# real cdkd schema bump merge with the marker never consulted. The identical
# spelling was measured going 2 -> 0 on verify-pr-gate before go-to-k/cdkd#3209
# built this allowlist.
# The stderr needle is the RETRACT REASON, not the generic refusal: a reader who
# hits this needs to know the relaxation was withdrawn by a repo override, not
# that they should add a GATE_MARKER_ALIASES row. Nothing asserted any of the
# three retract messages reached a user until go-to-k/cdkd#3351 round 2.
x2236_case "foreign target + --repo naming cdkd still REFUSES, and says why" 2 fresh NOT_CALLED \
  "carries a repo override" "$x2236_other" "gh pr merge 1 --squash --repo go-to-k/cdkd"
x2236_case "foreign target + a CLUSTERED -R still REFUSES" 2 fresh NOT_CALLED \
  "declares no gate" "$x2236_other" "gh pr merge 1 -sdR go-to-k/cdkd"
x2236_case "foreign target + a PR URL selector still REFUSES" 2 fresh NOT_CALLED \
  "declares no gate" "$x2236_other" "gh pr merge https://github.com/go-to-k/cdkd/pull/1 --squash"
x2236_case "unparsable config keeps the cdkd gate name (fail closed)" 2 stale CALLED "integ-schema-migration" "$x2236_emptycfg"

# --- The identity is computed BEFORE this process changes its cwd -------------
#
# `.claude/settings.json` invokes the hook as
# `${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/integ-schema-migration-gate.sh`, so in
# production the script's own path is RELATIVE whenever that variable is unset.
# The identity block therefore runs ABOVE the hook's `cd "$target_dir"`, or
# `$__hook_dir` resolves from inside the TARGET, the hook's "own" repo becomes
# the target, every target classifies as cdkd, and the relaxation inverts into a
# no-op -- the unclearable sibling refusal silently back.
#
# NOTHING FENCED THAT until go-to-k/cdkd#3351's review: every case above invokes
# `$HOOK` by ABSOLUTE path, so `__hook_dir` is already resolved and the ordering
# cannot matter. Measured -- moving the call below the `cd` left this suite at
# 27/0 while the production spelling went 0 -> 2.
#
# So this case must use a RELATIVE invocation from a cwd that is NOT the target,
# which is the same discriminator verify-pr-gate.test.sh records for its own
# copy of this block.
rel_home="$TMPDIR/rel-home"
x2236_mk_repo "$rel_home" "https://github.com/go-to-k/cdkd.git" check integ-schema-migration
mkdir -p "$rel_home/.claude/hooks/lib"
cp "$HOOK" "$rel_home/.claude/hooks/integ-schema-migration-gate.sh"
cp "$LIB_REAL" "$rel_home/.claude/hooks/lib/command-match.sh"
chmod +x "$rel_home/.claude/hooks/integ-schema-migration-gate.sh"

printf '{"files":[{"path":"src/types/state.ts"}]}' > "$GH_MOCK_FILES"
printf '%s' "$BUMP_DIFF" > "$GH_MOCK_DIFF"
rel_rc=$(cd "$rel_home" && printf '{"cwd":"%s","tool_input":{"command":"gh -C %s pr merge 1 --squash"}}' \
  "$rel_home" "$x2236_other" \
  | MARKGATE_MOCK_VERDICT=fresh ${HOOK_BASH:+$HOOK_BASH }./.claude/hooks/integ-schema-migration-gate.sh >/dev/null 2>&1; echo $?)
if [ "$rel_rc" = "0" ]; then
  pass=$((pass + 1)); printf 'OK   a RELATIVE invocation resolves its own repo BEFORE the cd\n'
else
  fail=$((fail + 1))
  fail_log="${fail_log}FAIL relative invocation: got $rel_rc, want 0 -- the identity block has moved below the cd, so the foreign target reads as cdkd\n"
  printf 'FAIL a RELATIVE invocation resolves its own repo BEFORE the cd (got %s)\n' "$rel_rc"
fi

# --- Summary ------------------------------------------------------

echo ""
echo "Summary: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  printf '\nFailures:\n%b' "$fail_log"
  exit 1
fi
exit 0
