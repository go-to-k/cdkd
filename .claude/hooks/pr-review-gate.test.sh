#!/usr/bin/env bash
# Smoke test for pr-review-gate.sh.
#
# Exercises the size+bias heuristic and the marker-freshness check
# against PATH-shimmed `gh` and `markgate` binaries. Each case stubs
# `gh pr view` to return a synthetic PR JSON shape and stubs
# `markgate` to return either "fresh" or "stale", then asserts the
# hook's exit code matches the expected gate decision.
#
# Run from the repo root: `bash .claude/hooks/pr-review-gate.test.sh`.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pr-review-gate.sh"
SCRIPT_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Post-#559: the hook is cwd-aware, so the sentinel lives in the
# WORKTREE the test runs from (the worktree containing this hook).
# Every test payload below uses `cwd = REPO_ROOT` (the worktree
# itself) so the hook lands on this same dir; the sentinel write
# below puts the fixture sha where the hook will read it.
REPO_ROOT="$SCRIPT_REPO"

# Per-run scratch dir for shim binaries; cleaned on EXIT.
SHIM_DIR="$(mktemp -d)"
SENTINEL="$REPO_ROOT/.markgate-pr-review-sha"
ORIG_SENTINEL=""
if [ -f "$SENTINEL" ]; then
  ORIG_SENTINEL=$(cat "$SENTINEL")
fi
cleanup() {
  rm -rf "$SHIM_DIR"
  if [ -n "$ORIG_SENTINEL" ]; then
    printf '%s' "$ORIG_SENTINEL" > "$SENTINEL"
  else
    rm -f "$SENTINEL"
  fi
}
trap cleanup EXIT

pass=0
fail=0
fail_log=""

# Write the gh shim. It dispatches by the args fixture name in
# $GH_FIXTURE — each test case sets that env var before invoking the
# hook to control what `gh pr view` returns.
cat > "$SHIM_DIR/gh" <<'EOF_GH'
#!/usr/bin/env bash
set -u
case "${GH_FIXTURE:-}" in
  small)
    # 200 LOC, 3 files: src + tests. Base tier = inline (fc<5).
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"abc1234567890","headRefName":"feat/small","files":[{"path":"src/foo.ts"},{"path":"tests/foo.test.ts"},{"path":"README.md"}]}
EOF
    ;;
  medium)
    # 500 LOC, 7 files. Base = 1-reviewer.
    cat <<'EOF'
{"additions":300,"deletions":200,"changedFiles":7,"headRefOid":"med1234567890","headRefName":"feat/medium","files":[{"path":"src/a.ts"},{"path":"src/b.ts"},{"path":"src/c.ts"},{"path":"src/d.ts"},{"path":"src/e.ts"},{"path":"src/f.ts"},{"path":"src/g.ts"}]}
EOF
    ;;
  large)
    # 1500 LOC, 15 files. Base = 3-axis.
    cat <<'EOF'
{"additions":1000,"deletions":500,"changedFiles":15,"headRefOid":"big1234567890","headRefName":"feat/large","files":[{"path":"src/a.ts"},{"path":"src/b.ts"},{"path":"src/c.ts"},{"path":"src/d.ts"},{"path":"src/e.ts"},{"path":"src/f.ts"},{"path":"src/g.ts"},{"path":"src/h.ts"},{"path":"src/i.ts"},{"path":"src/j.ts"},{"path":"src/k.ts"},{"path":"src/l.ts"},{"path":"src/m.ts"},{"path":"src/n.ts"},{"path":"src/o.ts"}]}
EOF
    ;;
  docs-with-security)
    # 200 LOC, 3 files: includes cognito-jwt.ts → up-bias to 1-reviewer.
    cat <<'EOF'
{"additions":150,"deletions":50,"changedFiles":3,"headRefOid":"sec1234567890","headRefName":"feat/docs-sec","files":[{"path":"docs/foo.md"},{"path":"src/local/cognito-jwt.ts"},{"path":"README.md"}]}
EOF
    ;;
  tests-only-large)
    # 1500 LOC, 15 files, ALL under tests/ → down-bias to 1-reviewer.
    cat <<'EOF'
{"additions":1000,"deletions":500,"changedFiles":15,"headRefOid":"tst1234567890","headRefName":"feat/tests","files":[{"path":"tests/a.test.ts"},{"path":"tests/b.test.ts"},{"path":"tests/c.test.ts"},{"path":"tests/d.test.ts"},{"path":"tests/e.test.ts"},{"path":"tests/f.test.ts"},{"path":"tests/g.test.ts"},{"path":"tests/h.test.ts"},{"path":"tests/i.test.ts"},{"path":"tests/j.test.ts"},{"path":"tests/k.test.ts"},{"path":"tests/l.test.ts"},{"path":"tests/m.test.ts"},{"path":"tests/n.test.ts"},{"path":"tests/o.test.ts"}]}
EOF
    ;;
  rules-only-large)
    # 781 LOC, 11 files, ALL under .claude/rules/ + CLAUDE.md → down-bias
    # to 1-reviewer. Mirrors the PR #532 shape that originally surfaced
    # the missing `.claude/rules/.*` clause in DOWN_DOCS_REGEX.
    cat <<'EOF'
{"additions":460,"deletions":321,"changedFiles":11,"headRefOid":"rul1234567890","headRefName":"docs/claude-md-trim","files":[{"path":"CLAUDE.md"},{"path":".claude/rules/architecture.md"},{"path":".claude/rules/code-layout.md"},{"path":".claude/rules/state-schema.md"},{"path":".claude/rules/providers.md"},{"path":".claude/rules/synthesis.md"},{"path":".claude/rules/assets.md"},{"path":".claude/rules/analyzer.md"},{"path":".claude/rules/cli-internals.md"},{"path":".claude/rules/testing.md"},{"path":".claude/rules/hooks.md"}]}
EOF
    ;;
  lockfile-inflated)
    # PR #1082 shape: 2784 raw LOC but 2747 of it is root-level
    # pnpm-lock.yaml churn. Adjusted loc = 37 (< 300) with fc = 9
    # (< 10) → inline tier → pass-through. Pre-fix the hook computed
    # raw LOC → 3-axis → spurious block.
    cat <<'EOF'
{"additions":1651,"deletions":1133,"changedFiles":9,"headRefOid":"lck1234567890","headRefName":"chore/lockfile-heavy","files":[{"path":"pnpm-lock.yaml","additions":1614,"deletions":1133},{"path":"package.json","additions":8,"deletions":0},{"path":"vite.config.ts","additions":4,"deletions":0},{"path":"CLAUDE.md","additions":4,"deletions":0},{"path":"CONTRIBUTING.md","additions":2,"deletions":0},{"path":".mise.toml","additions":2,"deletions":0},{"path":"scripts/a.ts","additions":6,"deletions":0},{"path":"scripts/b.ts","additions":6,"deletions":0},{"path":".claude/skills/verify-pr/SKILL.md","additions":5,"deletions":0}]}
EOF
    ;;
  autogen-inflated-manyfiles)
    # 3000 raw LOC, 2900 under docs/_generated/** — adjusted loc = 100,
    # but fc = 12 (>= 10) still forces 3-axis: fc is intentionally NOT
    # adjusted for auto-generated files (a many-file diff stays
    # cross-cutting). Gate must still block on a stale marker.
    cat <<'EOF'
{"additions":2500,"deletions":500,"changedFiles":12,"headRefOid":"agn1234567890","headRefName":"feat/autogen-heavy","files":[{"path":"docs/_generated/integ-coverage.json","additions":2400,"deletions":500},{"path":"src/a.ts","additions":10,"deletions":0},{"path":"src/b.ts","additions":10,"deletions":0},{"path":"src/c.ts","additions":10,"deletions":0},{"path":"src/d.ts","additions":10,"deletions":0},{"path":"src/e.ts","additions":10,"deletions":0},{"path":"src/f.ts","additions":10,"deletions":0},{"path":"src/g.ts","additions":10,"deletions":0},{"path":"src/h.ts","additions":10,"deletions":0},{"path":"src/i.ts","additions":10,"deletions":0},{"path":"src/j.ts","additions":10,"deletions":0},{"path":"src/k.ts","additions":10,"deletions":0}]}
EOF
    ;;
  fail)
    # Simulate gh failure.
    exit 1
    ;;
  *)
    # Default: medium tier so the test author notices an unset fixture.
    cat <<'EOF'
{"additions":300,"deletions":200,"changedFiles":7,"headRefOid":"def1234567890","headRefName":"feat/default","files":[{"path":"src/a.ts"},{"path":"src/b.ts"},{"path":"src/c.ts"},{"path":"src/d.ts"},{"path":"src/e.ts"},{"path":"src/f.ts"},{"path":"src/g.ts"}]}
EOF
    ;;
esac
EOF_GH
chmod +x "$SHIM_DIR/gh"

# Trace file: the mocked markgate writes $PWD to this file on every
# call. The cwd-aware test cases below (run_case_cwd) can assert the
# hook `cd`'d to the resolved target dir before invoking markgate.
# Mirrors check-gate.test.sh (post-#562) — closes the coverage gap
# the #562 reviewer flagged.
CWD_TRACE_FILE="$SHIM_DIR/cwd-trace"

# markgate shim: $MARKGATE_FIXTURE controls verify's exit code. Also
# writes $PWD to $CWD_TRACE_FILE so the cwd-aware test cases can
# assert the hook `cd`'d to the resolved target dir.
cat > "$SHIM_DIR/markgate" <<EOF_MG
#!/usr/bin/env bash
set -u
echo "\$PWD" >> "$CWD_TRACE_FILE"
case "\${1:-}" in
  verify)
    case "\${MARKGATE_FIXTURE:-stale}" in
      fresh) exit 0 ;;
      stale) exit 1 ;;
      *) exit 1 ;;
    esac
    ;;
  status)
    echo "state: stale (digest differs)"
    exit 0
    ;;
  set)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
EOF_MG
chmod +x "$SHIM_DIR/markgate"

# Wrap mise so the hook's `mise exec -- markgate ...` path also routes
# through the shim. The real `mise exec` would re-resolve the
# repo-pinned markgate version, defeating our shim.
cat > "$SHIM_DIR/mise" <<EOF_MISE
#!/usr/bin/env bash
# Skip leading "exec --" so we can call the shim directly.
set -u
if [ "\${1:-}" = "exec" ]; then
  shift
  if [ "\${1:-}" = "--" ]; then shift; fi
  exec "$SHIM_DIR/\$@"
fi
exec "\$@"
EOF_MISE
chmod +x "$SHIM_DIR/mise"

# run_case <name> <expect_exit> <gh_fixture> <mg_fixture> <sentinel_content> <command>
run_case() {
  local name="$1"
  local want="$2"
  local gh_fix="$3"
  local mg_fix="$4"
  local sentinel="$5"
  local command="$6"

  # Reset sentinel.
  if [ -n "$sentinel" ]; then
    printf '%s' "$sentinel" > "$SENTINEL"
  else
    rm -f "$SENTINEL"
  fi

  local payload
  payload=$(printf '{"cwd":"%s","tool_input":{"command":"%s"}}' "$REPO_ROOT" "$command")

  local got out
  out=$(GH_FIXTURE="$gh_fix" MARKGATE_FIXTURE="$mg_fix" \
        PATH="$SHIM_DIR:$PATH" \
        printf '%s' "$payload" | \
        GH_FIXTURE="$gh_fix" MARKGATE_FIXTURE="$mg_fix" PATH="$SHIM_DIR:$PATH" "$HOOK" 2>&1)
  got=$?

  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got\n"
    fail_log+="  fixture: gh=$gh_fix mg=$mg_fix sentinel=$sentinel\n"
    fail_log+="  command: $command\n"
    fail_log+="  output : $out\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# --- Pass-through cases ------------------------------------------------

# 1. Non-merge command always passes through (no gh call needed).
run_case "git status passes" 0 \
  unused stale "" \
  "git status"

# 2. gh pr create is NOT gated.
run_case "gh pr create passes" 0 \
  unused stale "" \
  "gh pr create --title foo"

# 3. gh pr view is not gated.
run_case "gh pr view passes" 0 \
  unused stale "" \
  "gh pr view 42"

# --- Small / inline tier: always pass regardless of marker --------------

# 4. Small PR (200 LOC, 3 files) → inline tier → pass-through.
run_case "small PR (inline) passes regardless of marker" 0 \
  small stale "" \
  "gh pr merge 100"

# 4b. Lockfile-inflated PR (PR #1082 shape): 2784 raw LOC but only 37
# after subtracting root-level pnpm-lock.yaml churn → inline tier →
# pass-through even on a stale marker. Pins the auto-gen LOC exclusion
# (and its `(^|/)` anchoring for ROOT-level lockfiles).
run_case "lockfile-inflated PR (inline after exclusion) passes on stale marker" 0 \
  lockfile-inflated stale "" \
  "gh pr merge 1082"

# 4c. Auto-gen-inflated PR that still has fc >= 10: loc adjusts to 100
# but the file count alone keeps it 3-axis (fc is NOT adjusted) →
# block on stale marker.
run_case "autogen-inflated PR with fc>=10 still 3-axis → block on stale" 2 \
  autogen-inflated-manyfiles stale "" \
  "gh pr merge 404"

# --- Medium / 1-reviewer tier -----------------------------------------

# 5. Medium PR with fresh marker matching sha → pass.
run_case "medium PR + fresh marker + sha match → pass" 0 \
  medium fresh "med1234567890" \
  "gh pr merge 200"

# 6. Medium PR with stale marker → block.
run_case "medium PR + stale marker → block" 2 \
  medium stale "" \
  "gh pr merge 200"

# 7. Medium PR with fresh marker but WRONG sha → block.
run_case "medium PR + fresh marker + sha mismatch → block" 2 \
  medium fresh "stale1234567890" \
  "gh pr merge 200"

# --- Large / 3-axis tier ----------------------------------------------

# 8. Large PR with fresh marker matching sha → pass.
run_case "large PR + fresh marker + sha match → pass" 0 \
  large fresh "big1234567890" \
  "gh pr merge 300"

# 9. Large PR with stale marker → block.
run_case "large PR + stale marker → block" 2 \
  large stale "" \
  "gh pr merge 300"

# 10. Large PR with fresh marker but different sha (new push since
#     last review) → block.
run_case "large PR + fresh marker + sha mismatch → block" 2 \
  large fresh "old1234567890" \
  "gh pr merge 300"

# --- Bias factors -----------------------------------------------------

# 11. Docs+security: 200 LOC, 3 files, includes cognito-jwt.ts.
#     Base tier inline → up-bias → 1-reviewer → marker required.
#     With stale marker, expect block.
run_case "docs+security PR up-bias → block on stale" 2 \
  docs-with-security stale "" \
  "gh pr merge 400"

# 12. Same as above but with fresh+matching marker → pass.
run_case "docs+security PR up-bias + fresh marker → pass" 0 \
  docs-with-security fresh "sec1234567890" \
  "gh pr merge 400"

# 13. Tests-only large PR: 1500 LOC, 15 files, all under tests/.
#     Base = 3-axis → down-bias → 1-reviewer → still gated.
#     With stale marker, expect block (down-bias does NOT unblock).
run_case "tests-only large PR down-bias → still gated on stale" 2 \
  tests-only-large stale "" \
  "gh pr merge 500"

# 14. Tests-only large PR with fresh marker → pass.
run_case "tests-only large PR + fresh marker → pass" 0 \
  tests-only-large fresh "tst1234567890" \
  "gh pr merge 500"

# 14b. .claude/rules/-only large PR (PR #532 shape):
#      781 LOC, 11 files, all under .claude/rules/ + CLAUDE.md → base
#      3-axis → down-bias → 1-reviewer → still gated. Verifies the
#      `.claude/rules/.*` clause in DOWN_DOCS_REGEX (added in #533).
run_case ".claude/rules/-only large PR down-bias → still gated on stale" 2 \
  rules-only-large stale "" \
  "gh pr merge 532"

# 14c. Same PR with fresh+matching marker → pass.
run_case ".claude/rules/-only large PR + fresh marker → pass" 0 \
  rules-only-large fresh "rul1234567890" \
  "gh pr merge 532"

# --- gh failure fail-open --------------------------------------------

# 15. gh failure → pass-through with debug warning.
run_case "gh pr view failure → pass-through (fail-open)" 0 \
  fail stale "" \
  "gh pr merge 999"

# --- gh pr merge --auto variant --------------------------------------

# 16. `gh pr merge --auto <N>` form matches.
run_case "gh pr merge --auto <N> + stale marker → block" 2 \
  medium stale "" \
  "gh pr merge --auto 600"

# 17. `gh pr merge <N> --auto` (number first) matches.
run_case "gh pr merge <N> --auto + stale marker → block" 2 \
  medium stale "" \
  "gh pr merge 700 --auto"

# 18. Command containing the bare word "merge" BEFORE the actual
#     `gh pr merge` in a single-line `;`-chain (typical: an inline
#     `# Wait + merge` comment in a multi-line Bash script, OR a
#     `git merge` / `npm run merge:foo` earlier in a `;`-chained
#     command).
#
#     Pre-issue #563 the matcher was `\bgh ... pr merge\b` (word-
#     boundary), so the line as a whole matched and the
#     `${cmd##*gh pr merge}` greedy-strip parser then landed on the
#     correct PR number. Post-#563 the matcher is line-start anchored
#     (per memory rule feedback_hook_command_match_line_start.md) to
#     eliminate quoted-body false-positives (the `gh issue create
#     --body "...gh pr merge..."` shape, see the Part C cases below).
#     The trade-off is that single-line chained `... ; gh pr merge`
#     shapes now fall through the matcher (the line starts with
#     `echo`, not `gh`) — an ACCEPTED FALSE-NEGATIVE of the line-
#     start tightening. The dominant agent shape is
#     `cd <worktree> && gh pr merge ...` which IS line-start matched
#     because of the leading `cd <path> &&` allowance.
run_case "single-line chained gh pr merge after echo (accepted false-negative)" 0 \
  medium stale "" \
  "echo merge first; for i in 1 2 3; do echo loop; done; gh pr merge 800 --squash"

# --- CWD-AWARE cases (cdkd #559) ---------------------------------------
#
# Verify that the hook resolves the target git working tree from the
# payload's `cwd` field / `cd <path>` / `gh -C <path>` flag, and that
# the sentinel + markgate state are read from THAT worktree rather
# than always the main tree. Pre-#559 the hook landed in the main
# tree via `git rev-parse --git-common-dir`'s parent.
#
# Side worktree fixture: a fresh empty git repo with its own sentinel
# binding to the medium-fixture's `headRefOid` ("med1234567890").
# When the hook resolves to this side dir, the marker is fresh AND
# the sentinel matches → pass.
CWD_TMP="$(mktemp -d)"
trap 'rm -rf "$SHIM_DIR" "$CWD_TMP"; [ -n "$ORIG_SENTINEL" ] && printf "%s" "$ORIG_SENTINEL" > "$SENTINEL" || rm -f "$SENTINEL"' EXIT

CWD_SIDE_REPO="$CWD_TMP/side-worktree"
git init -q -b feature/x "$CWD_SIDE_REPO"
git -C "$CWD_SIDE_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
printf 'med1234567890' > "$CWD_SIDE_REPO/.markgate-pr-review-sha"

# Override run_case to take an explicit cwd. We define a parallel
# helper below to avoid touching every existing case's signature.
#
# Accepts an optional 7th arg, `expect_cwd`, that asserts the hook
# `cd`'d into the expected dir before invoking markgate (issue #563
# — closes the coverage gap the PR #562 reviewer flagged). Empty
# (or omitted) skips the cwd assertion — used for the markgate-fresh
# pass-through cases where the trace still gets written but the
# explicit assertion is unnecessary if the caller doesn't pass it.
run_case_cwd() {
  local name="$1"; local want="$2"; local gh_fix="$3"; local mg_fix="$4"; local cwd="$5"; local command="$6"; local expect_cwd="${7:-}"

  : > "$CWD_TRACE_FILE"
  local payload
  payload=$(printf '{"cwd":"%s","tool_input":{"command":"%s"}}' "$cwd" "$command")

  local got out
  out=$(GH_FIXTURE="$gh_fix" MARKGATE_FIXTURE="$mg_fix" \
        PATH="$SHIM_DIR:$PATH" \
        printf '%s' "$payload" | \
        GH_FIXTURE="$gh_fix" MARKGATE_FIXTURE="$mg_fix" PATH="$SHIM_DIR:$PATH" "$HOOK" 2>&1)
  got=$?

  local cwd_ok=1
  if [ -n "$expect_cwd" ]; then
    if ! grep -qFx "$expect_cwd" "$CWD_TRACE_FILE" 2>/dev/null; then
      cwd_ok=0
    fi
  fi

  if [ "$got" = "$want" ] && [ "$cwd_ok" -eq 1 ]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got"
    if [ "$cwd_ok" -eq 0 ]; then
      fail_log+="; cwd mismatch (want '$expect_cwd', trace: $(cat "$CWD_TRACE_FILE" 2>/dev/null | tr '\n' '|'))"
    fi
    fail_log+="\n  cwd: $cwd; command: $command\n"
    fail_log+="  output : $out\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# 19. cwd in side worktree + fresh marker (mocked) + sentinel binding
#     to PR head sha → pass. Proves the hook reads the SIDE worktree's
#     sentinel rather than always the main tree's. The 7th arg asserts
#     markgate was invoked from the SIDE worktree (issue #563).
run_case_cwd "side worktree cwd + fresh marker + sentinel match → pass" 0 \
  medium fresh "$CWD_SIDE_REPO" "gh pr merge 1000" "$CWD_SIDE_REPO"

# 20. cwd in main tree + stale marker → block (sanity that the cwd
#     resolution doesn't break the existing path).
run_case_cwd "main tree cwd + stale marker → block" 2 \
  medium stale "$REPO_ROOT" "gh pr merge 1100" "$REPO_ROOT"

# 21. `cd <side> && gh pr merge` from main cwd routes to side → pass.
run_case_cwd "cd <side> && gh pr merge from main cwd → side wins" 0 \
  medium fresh "$REPO_ROOT" "cd $CWD_SIDE_REPO && gh pr merge 1200" "$CWD_SIDE_REPO"

# 22. `gh -C <side> pr merge` from main cwd routes to side → pass.
run_case_cwd "gh -C <side> pr merge from main cwd → side wins" 0 \
  medium fresh "$REPO_ROOT" "gh -C $CWD_SIDE_REPO pr merge 1300" "$CWD_SIDE_REPO"

# --- LINE-START ANCHORING cases (issue #563) ---
#
# The matcher MUST NOT fire when the literal substring `gh pr merge`
# appears inside a quoted argument body of an unrelated command. Per
# memory rule feedback_hook_command_match_line_start.md, applied to
# pr-review-gate.sh in issue #563 (mirroring the PR #562 fix to
# check-gate.sh). Even with a large/3-axis-tier PR fixture, the
# quoted-body form must pass through because the matcher fires
# BEFORE the tier computation.

# 23. `gh issue create --body "...gh pr merge..."`: body mentions
#     `gh pr merge` but the line starts with `gh issue create`.
#     MUST pass through.
run_case "gh issue body quoting 'gh pr merge' passes (FP)" 0 \
  large stale "" \
  "gh issue create --body \"next step: gh pr merge --squash\""

# 24. `echo "...gh pr merge..."`: body mentions `gh pr merge` but
#     the command starts with `echo`. MUST pass through.
run_case "echo body quoting 'gh pr merge' passes (FP)" 0 \
  large stale "" \
  "echo \"after CI: gh pr merge 999 --auto\""

echo
echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
