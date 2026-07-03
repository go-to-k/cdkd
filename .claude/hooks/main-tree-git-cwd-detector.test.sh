#!/usr/bin/env bash
# Smoke test for main-tree-git-cwd-detector.sh.
#
# Builds a fixture main repo + a feature worktree under
# `.claude/worktrees/`, then feeds the hook synthetic PostToolUse
# payloads and asserts whether the cwd-race warning is emitted
# (stdout contains the hook marker) or not. Run from repo root:
#   bash .claude/hooks/main-tree-git-cwd-detector.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/main-tree-git-cwd-detector.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

MAIN="$TMPDIR/main"
git init -q -b main "$MAIN"
echo "seed" > "$MAIN/file.txt"
git -C "$MAIN" add -A
git -C "$MAIN" -c user.email=t@t -c user.name=t commit -q -m init

# canonicalize (macOS /tmp -> /private/tmp) so paths in payloads match
# what the hook resolves via `pwd -P`.
MAIN="$(cd "$MAIN" && pwd -P)"

# A feature worktree under .claude/worktrees/ = "task in flight".
WT="$MAIN/.claude/worktrees/feat-x"
git -C "$MAIN" worktree add -q "$WT" -b feat/x >/dev/null 2>&1
WT="$(cd "$WT" && pwd -P)"

pass=0; fail=0
# run_case <expect: warn|quiet> <desc> <cwd> <command>
run_case() {
  local expect="$1" desc="$2" cwd="$3" cmd="$4" out got
  local json
  json=$(jq -nc --arg c "$cmd" --arg cwd "$cwd" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$c}}')
  out=$(printf '%s' "$json" | bash "$HOOK" 2>/dev/null)
  if printf '%s' "$out" | grep -q "main-tree-git-cwd-detector"; then got="warn"; else got="quiet"; fi
  if [[ "$got" == "$expect" ]]; then
    pass=$((pass+1)); printf 'ok   (%s) %s\n' "$got" "$desc"
  else
    fail=$((fail+1)); printf 'FAIL (got %s, want %s) %s\n' "$got" "$expect" "$desc"
  fi
}

# 1. Bare `git commit` from the MAIN tree cwd while a feature worktree
#    is active -> WARN (the cwd-race signature).
run_case warn  "bare git commit in main tree, feature worktree active" \
  "$MAIN" 'git commit -m x'

# 2. `git add -A && git commit` compound from main tree -> WARN.
run_case warn  "compound git add && git commit in main tree" \
  "$MAIN" 'git add -A && git commit -F /tmp/msg'

# 3. `git push` from main tree -> WARN.
run_case warn  "bare git push in main tree" \
  "$MAIN" 'git push origin HEAD'

# 4. `git -C <feature-worktree> commit` from main cwd -> QUIET
#    (the cwd-race-PROOF form; targets the worktree).
run_case quiet "git -C <worktree> commit from main cwd" \
  "$MAIN" "git -C $WT commit -m x"

# 5. `cd <worktree> && git commit` from main cwd -> QUIET
#    (cd redirects the effective dir to the worktree).
run_case quiet "cd <worktree> && git commit" \
  "$MAIN" "cd $WT && git commit -m x"

# 6. Bare `git commit` from the feature-worktree cwd -> QUIET
#    (already in the right tree).
run_case quiet "bare git commit from feature-worktree cwd" \
  "$WT" 'git commit -m x'

# 7. Read-only verb (`git status`) in main tree -> QUIET (not mutating).
run_case quiet "git status in main tree" \
  "$MAIN" 'git status'

# 8. Quoted body mentioning git commit -> QUIET (command-position anchor).
run_case quiet "echo containing 'git commit' string" \
  "$MAIN" 'echo "run git commit next"'

# 9. No feature worktree active -> QUIET even for a bare main-tree commit
#    (no task in flight; ordinary main-tree work governed by branch-gate).
git -C "$MAIN" worktree remove --force "$WT" >/dev/null 2>&1
run_case quiet "bare git commit in main tree, NO feature worktree" \
  "$MAIN" 'git commit -m x'

echo "----"
echo "passed=$pass failed=$fail"
[[ "$fail" -eq 0 ]]
