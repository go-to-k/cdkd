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

# Match the hook's worktree-shared sentinel resolution: prefer the main
# working tree (shared across `git worktree` instances) via
# `git rev-parse --git-common-dir`. From the main repo this is a no-op;
# from a worktree this redirects to the parent repo so the test
# fixture sentinel lands where the hook will actually read it.
if git_common=$(git -C "$SCRIPT_REPO" rev-parse --git-common-dir 2>/dev/null); then
  case "$git_common" in
    /*) abs_common="$git_common" ;;
    *)  abs_common="$SCRIPT_REPO/$git_common" ;;
  esac
  REPO_ROOT="$(cd "$(dirname "$abs_common")" 2>/dev/null && pwd)" || REPO_ROOT="$SCRIPT_REPO"
else
  REPO_ROOT="$SCRIPT_REPO"
fi

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

# markgate shim: $MARKGATE_FIXTURE controls verify's exit code.
cat > "$SHIM_DIR/markgate" <<'EOF_MG'
#!/usr/bin/env bash
set -u
case "${1:-}" in
  verify)
    case "${MARKGATE_FIXTURE:-stale}" in
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

echo
echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
