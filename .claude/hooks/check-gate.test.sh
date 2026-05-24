#!/usr/bin/env bash
# Smoke test for check-gate.sh.
#
# Exercises the cwd-aware command-matching against fixture git
# working trees and asserts that the markgate verify runs against
# the RESOLVED target directory — not the script's location. This
# is the post-#559 contract: markers land in the worktree where the
# `git commit` actually runs, not always in the main tree.
#
# Run from the repo root: `bash .claude/hooks/check-gate.test.sh`.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-gate.sh"

# Per-run scratch dir; cleaned on EXIT.
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Two fixture git working trees. They have no markgate state of their
# own; we stub markgate via PATH and pin its verdict via env var.
side_repo="$TMPDIR/side-repo"
main_repo="$TMPDIR/main-repo"
git init -q -b feature/x "$side_repo"
git -C "$side_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git init -q -b main "$main_repo"
git -C "$main_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

# Shim dir for mise + markgate. markgate's verdict comes from
# $MARKGATE_MOCK_VERDICT (fresh -> exit 0, anything else -> exit 1).
# Each call appends $PWD to $CWD_TRACE_FILE so the test asserts the
# resolved target dir.
SHIM_DIR="$TMPDIR/bin"
mkdir -p "$SHIM_DIR"
CWD_TRACE_FILE="$TMPDIR/cwd-trace"

cat > "$SHIM_DIR/mise" <<'MISE_EOF'
#!/usr/bin/env bash
# Pass-through `mise exec -- <cmd> <args>`.
if [ "$1" = "exec" ] && [ "$2" = "--" ]; then
  shift 2
  exec "$@"
fi
exit 1
MISE_EOF
chmod +x "$SHIM_DIR/mise"

cat > "$SHIM_DIR/markgate" <<MARKGATE_EOF
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
      printf 'key:        %s\nstate:      stale (digest differs)\n' "\$2"
    fi
    exit 0
    ;;
esac
exit 1
MARKGATE_EOF
chmod +x "$SHIM_DIR/markgate"

# Drop pre-existing mise / markgate from PATH so our shims win.
export PATH="$SHIM_DIR:$PATH"

pass=0
fail=0
fail_log=""

# run_case <name> <expect_exit> <mg_verdict> <expect_cwd> <stdin_json>
#   expect_cwd: empty string skips the cwd assertion (used for
#   pass-through cases that should never reach markgate).
run_case() {
  local name="$1"; local want="$2"; local verdict="$3"; local expect_cwd="$4"; local payload="$5"
  : > "$CWD_TRACE_FILE"
  local got
  printf '%s' "$payload" | MARKGATE_MOCK_VERDICT="$verdict" "$HOOK" >/dev/null 2>&1
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

# --- PASS-THROUGH cases (matcher must NOT fire) ---

# 1. Non-commit git command always passes through.
run_case "git status passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git status"}}' "$side_repo")"

# 2. Empty command passes through.
run_case "empty stdin passes through" 0 stale "" ''

# 3. Non-git target dir → silent pass (we can't audit what we can't see).
run_case "non-git target dir allowed" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m x"}}' "$TMPDIR")"

# --- CWD-AWARE cases: marker verdict pinned to "stale" so the hook
#     MUST reach the markgate step (exit 2) and the trace MUST show
#     the resolved target dir. With fresh marker → exit 0.

# 4. Invoked from side worktree → markgate runs in side worktree.
#    This is the load-bearing #559 case: pre-fix, the hook always
#    landed in the main tree regardless of cwd.
run_case "side worktree cwd → markgate runs there" 2 stale "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m x"}}' "$side_repo")"

# 5. Invoked from main worktree → markgate runs in main worktree.
run_case "main worktree cwd → markgate runs there" 2 stale "$main_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m x"}}' "$main_repo")"

# 6. `cd <side> && git commit` from main-cwd → markgate runs in side.
run_case "cd <side> && git commit from main cwd → side wins" 2 stale "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd %s && git commit -m x"}}' "$main_repo" "$side_repo")"

# 7. `git -C <side> commit` from main-cwd → markgate runs in side.
run_case "git -C <side> commit from main cwd → side wins" 2 stale "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s commit -m x"}}' "$main_repo" "$side_repo")"

# 8. Fresh marker in side worktree → pass-through.
run_case "fresh marker passes" 0 fresh "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m x"}}' "$side_repo")"

# --- LINE-START ANCHORING cases: the matcher MUST NOT fire when the
#     literal substring `git commit` appears inside a quoted argument
#     body of an unrelated command. Per memory rule
#     feedback_hook_command_match_line_start.md — surfaced by the
#     PR #562 code review.

# 9. `gh issue create --body "...git commit..."` — `git commit` is
#    inside a quoted body, line starts with `gh`. MUST NOT fire.
run_case "gh issue body quoting 'git commit' passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh issue create --body \"we should add a git commit hook later\""}}' "$side_repo")"

# 10. `echo "Run: git commit"` — quoted body, line starts with `echo`.
run_case "echo body quoting 'git commit' passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"echo \"Run: git commit -m x\""}}' "$side_repo")"

# 11. `git commit-tree` — `commit-tree` is a separate plumbing
#     subcommand; the trailing class must exclude `-`.
run_case "git commit-tree passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit-tree HEAD^{tree} -m x"}}' "$side_repo")"

echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
