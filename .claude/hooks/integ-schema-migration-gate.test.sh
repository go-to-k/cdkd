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

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/integ-schema-migration-gate.sh"

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
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
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

# Canonical schema bump: literal type expansion
BUMP_DIFF='diff --git a/src/types/state.ts b/src/types/state.ts
index abc..def 100644
--- a/src/types/state.ts
+++ b/src/types/state.ts
@@ -10,3 +10,3 @@
-  version: 1 | 2 | 3 | 4 | 5;
+  version: 1 | 2 | 3 | 4 | 5 | 6;'

run_case "version bump + marker stale BLOCKS" 2 \
  '{"tool_input":{"command":"gh pr merge 400 --squash"}}' \
  '{"files":[{"path":"src/types/state.ts"}]}' \
  "$BUMP_DIFF"

MARKGATE_MOCK_VERDICT="fresh" run_case "version bump + marker fresh passes" 0 \
  '{"tool_input":{"command":"gh pr merge 401 --squash"}}' \
  '{"files":[{"path":"src/types/state.ts"}]}' \
  "$BUMP_DIFF"

# STATE_SCHEMA_VERSION constant variant: another form of version bump
CONST_BUMP_DIFF='diff --git a/src/types/state.ts b/src/types/state.ts
index abc..def 100644
--- a/src/types/state.ts
+++ b/src/types/state.ts
@@ -2,1 +2,1 @@
-export const STATE_SCHEMA_VERSION = 5;
+export const STATE_SCHEMA_VERSION = 6;'

run_case "STATE_SCHEMA_VERSION bump + marker stale BLOCKS" 2 \
  '{"tool_input":{"command":"gh pr merge 402 --squash"}}' \
  '{"files":[{"path":"src/types/state.ts"}]}' \
  "$CONST_BUMP_DIFF"

# --- Mixed PR: state.ts bumped AND non-state files also touched ---

MIXED_DIFF='diff --git a/src/types/state.ts b/src/types/state.ts
index abc..def 100644
--- a/src/types/state.ts
+++ b/src/types/state.ts
@@ -10,3 +10,3 @@
-  version: 1 | 2 | 3 | 4 | 5;
+  version: 1 | 2 | 3 | 4 | 5 | 6;
diff --git a/src/state/s3-state-backend.ts b/src/state/s3-state-backend.ts
index abc..def 100644
--- a/src/state/s3-state-backend.ts
+++ b/src/state/s3-state-backend.ts
@@ -50,1 +50,1 @@
-    // unchanged
+    // adjusted comment'

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
git -C "$CWD_SIDE_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git init -q -b main "$CWD_MAIN_REPO"
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

# --- Summary ------------------------------------------------------

echo ""
echo "Summary: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  printf '\nFailures:\n%b' "$fail_log"
  exit 1
fi
exit 0
