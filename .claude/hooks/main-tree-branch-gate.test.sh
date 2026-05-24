#!/usr/bin/env bash
# Smoke test for main-tree-branch-gate.sh.
#
# Exercises the cwd-aware main-tree resolution against fixture
# main + worktree pairs, asserting both BLOCK (exit 2) and ALLOW
# (exit 0) outcomes. Run from the repo root:
#   bash .claude/hooks/main-tree-branch-gate.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/main-tree-branch-gate.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Set up a main repo + one linked worktree under
# `.claude/worktrees/feat-x/`.
main_repo="$TMPDIR/main-repo"
git init -q -b main "$main_repo"
git -C "$main_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
# Pre-create the feature branch (refs needed for show-ref).
git -C "$main_repo" branch feat-x
git -C "$main_repo" branch some-feature
# A worktree at `.claude/worktrees/feat-x/` checked out to `feat-x`.
mkdir -p "$main_repo/.claude/worktrees"
worktree_dir="$main_repo/.claude/worktrees/feat-x"
git -C "$main_repo" worktree add -q "$worktree_dir" feat-x

pass=0
fail=0
fail_log=""

run_case() {
  local name="$1"; local want="$2"; local payload="$3"
  local out got
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) || true
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got\n"
    fail_log+="  payload: $payload\n"
    fail_log+="  output : $out\n"
  fi
}

# --- ALLOW cases ---

# 1. git switch main in main tree → allow (going back to main).
run_case "git switch main in main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git switch main"}}' "$main_repo")"

# 2. git checkout main in main tree → allow.
run_case "git checkout main in main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git checkout main"}}' "$main_repo")"

# 3. git switch master in main tree → allow.
run_case "git switch master in main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git switch master"}}' "$main_repo")"

# 4. git switch -c feat in a worktree (not main tree) → allow.
run_case "git switch -c feat in worktree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git switch -c feat-new"}}' "$worktree_dir")"

# 5. git switch feat in a worktree → allow.
run_case "git switch <feat> in worktree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git switch some-feature"}}' "$worktree_dir")"

# 6. git checkout -- <pathspec> in main tree → allow (file restore).
run_case "git checkout -- <pathspec> in main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git checkout -- README.md"}}' "$main_repo")"

# 7. git checkout <sha> in main tree → allow (detached HEAD).
HEAD_SHA=$(git -C "$main_repo" rev-parse HEAD)
run_case "git checkout <sha> in main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git checkout %s"}}' "$main_repo" "$HEAD_SHA")"

# 8. git worktree add in main tree → allow (sanctioned escape).
run_case "git worktree add in main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git worktree add .claude/worktrees/x -b feat-y"}}' "$main_repo")"

# 9. git status in main tree → allow (not a switch/checkout).
run_case "git status in main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git status"}}' "$main_repo")"

# 10. Empty payload → allow (nothing to gate).
run_case "empty payload allowed" 0 ''

# --- BLOCK cases ---

# 11. git switch -c <feat> in main tree → block.
run_case "git switch -c <feat> in main tree blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git switch -c feat-new"}}' "$main_repo")"

# 12. git switch <feat> (existing branch) in main tree → block.
run_case "git switch <feat> in main tree blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git switch some-feature"}}' "$main_repo")"

# 13. git checkout -b <feat> in main tree → block.
run_case "git checkout -b <feat> in main tree blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git checkout -b feat-new"}}' "$main_repo")"

# 14. git checkout <feat> (existing local branch) in main tree → block.
run_case "git checkout <feat> (existing branch) in main tree blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git checkout some-feature"}}' "$main_repo")"

# 15. cd <main> && git switch feat from worktree cwd → block (cd target wins).
run_case "cd <main> && git switch <feat> from worktree blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd %s && git switch some-feature"}}' "$worktree_dir" "$main_repo")"

# 16. git -C <main> switch feat → block.
run_case "git -C <main> switch <feat> blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s switch some-feature"}}' "$worktree_dir" "$main_repo")"

# 17. git switch - (previous branch, conservative) in main tree → block.
run_case "git switch - in main tree blocked conservatively" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git switch -"}}' "$main_repo")"

# --- Edge cases ---

# 18. Not a git repo → fall through (can't see, can't gate).
run_case "non-repo target dir passes through" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git switch foo"}}' "$TMPDIR")"

# --- LINE-START ANCHORING cases (issue #563) ---
#
# The matcher MUST NOT fire when the literal substrings `git switch`
# / `git checkout` appear inside a quoted argument body of an
# unrelated command. Per memory rule
# feedback_hook_command_match_line_start.md, applied to
# main-tree-branch-gate.sh in issue #563 (mirroring the PR #562
# fix to check-gate.sh).

# 19. `gh issue create --body "...git switch..."` in main tree: the
#     body mentions `git switch` but the command itself starts with
#     `gh`. MUST pass through (would otherwise block routine issue
#     creation from the main tree).
run_case "gh issue body quoting 'git switch' in main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh issue create --body \"remember to git switch back to main after\""}}' "$main_repo")"

# 20. `echo "...git checkout..."` in main tree: the body mentions
#     `git checkout` but the command starts with `echo`. MUST pass
#     through.
run_case "echo body quoting 'git checkout' in main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"echo \"tip: git checkout -b some-feature in a worktree\""}}' "$main_repo")"

echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
