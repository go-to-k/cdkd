#!/usr/bin/env bash
# Smoke tests for dirty-path-restore-gate.sh
#
# Builds a REAL throwaway git repo per case (no mocking of git): the gate's
# whole decision is "does `git status --porcelain -- <path>` report anything",
# so a stubbed git would test the stub rather than the rule.
#
# Asserts:
#   - BLOCKS `git checkout -- <path>` when the path is dirty
#   - BLOCKS `git restore <path>` when the path is dirty
#   - PASSES when the path is CLEAN (the no-op case must stay quiet)
#   - PASSES for a branch switch / branch create (no `--`, not a path restore)
#   - PASSES for `git restore --staged <path>` (index only)
#   - PASSES when only an UNNAMED sibling file is dirty
#   - BLOCKS when one of several named paths is dirty
#   - PASSES under the CDKD_ALLOW_DIRTY_RESTORE=1 escape hatch
#   - PASSES for a non-Bash tool and for unrelated commands
#   - Honors `git -C <path>` when the payload cwd is elsewhere

set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/dirty-path-restore-gate.sh"
PASS=0
FAIL=0

# Create a repo with `tracked.txt` committed, plus `other.txt`.
make_repo() {
  local dir
  dir=$(mktemp -d)
  git -C "$dir" init -q
  git -C "$dir" config user.email t@example.com
  git -C "$dir" config user.name t
  echo "original" > "$dir/tracked.txt"
  echo "original" > "$dir/other.txt"
  git -C "$dir" add -A
  git -C "$dir" commit -qm init
  echo "$dir"
}

run() {
  local name="$1" cwd="$2" command="$3" expect_exit="$4" tool="${5:-Bash}"
  local input exit_code err
  input=$(jq -nc --arg t "$tool" --arg c "$command" --arg d "$cwd" \
    '{tool_name: $t, tool_input: {command: $c}, cwd: $d}')
  err=$(mktemp)
  echo "$input" | "$HOOK" 2>"$err" && exit_code=$? || exit_code=$?
  if [[ "$exit_code" -eq "$expect_exit" ]]; then
    echo "PASS: $name (exit $exit_code)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name — expected exit $expect_exit, got $exit_code"
    sed 's/^/       /' "$err"
    FAIL=$((FAIL + 1))
  fi
  rm -f "$err"
}

# --- dirty path: must BLOCK ------------------------------------------------
R=$(make_repo); echo "modified" > "$R/tracked.txt"
run "checkout -- <dirty path> blocks" "$R" "git checkout -- tracked.txt" 2

# CHAINED shapes. None of the cases below this file's original 18 was chained,
# which is why a live regression stayed green through a full review round:
# converting the gate from a raw-command match to a per-segment one made it
# read only the FIRST segment matching each verb, so a branch switch ahead of a
# discard ended the probe. Measured at the time, all three went BLOCK -> pass.
# A branch switch chained ahead of a discard is an everyday shape.
run "branch switch THEN discard blocks"        "$R" "git checkout main && git checkout -- tracked.txt" 2
run "checkout -b THEN restore blocks"          "$R" "git checkout -b wip && git restore -- tracked.txt" 2
run "semicolon-chained discard blocks"         "$R" "git checkout main; git restore -- tracked.txt" 2
run "discard THEN branch switch blocks"        "$R" "git restore tracked.txt && git checkout main" 2

# Polarity controls for those four. Without them "it blocks" is satisfied by a
# gate that blocks everything, which is the shape this session hit four times.
run "branch switch alone passes"               "$R" "git checkout main" 0
run "checkout -b alone passes"                 "$R" "git checkout -b wip" 0

# `--staged` is per-SEGMENT, not per-command. The old form exited 0 for the
# whole command on seeing `--staged`, so a staged restore chained ahead of a
# worktree restore passed the worktree one through untested.
run "staged restore alone passes"              "$R" "git restore --staged tracked.txt" 0
run "staged THEN worktree restore blocks"      "$R" "git restore --staged tracked.txt && git restore tracked.txt" 2
run "restore <dirty path> blocks" "$R" "git restore tracked.txt" 2
run "restore -- <dirty path> blocks" "$R" "git restore -- tracked.txt" 2
run "escape hatch is honored" "$R" "CDKD_ALLOW_DIRTY_RESTORE=1 git checkout -- tracked.txt" 2
CDKD_ALLOW_DIRTY_RESTORE=1 run "escape hatch via env passes" "$R" "git checkout -- tracked.txt" 0
run "restore --staged is index-only, passes" "$R" "git restore --staged tracked.txt" 0
run "non-Bash tool passes" "$R" "git checkout -- tracked.txt" 0 "Edit"
run "unnamed dirty sibling does not block a clean target" "$R" "git checkout -- other.txt" 0
run "one dirty among several named paths blocks" "$R" "git checkout -- other.txt tracked.txt" 2
run "git -C <dirty repo> blocks from elsewhere" "$PWD" "git -C $R checkout -- tracked.txt" 2
rm -rf "$R"

# --- clean path: must PASS -------------------------------------------------
R=$(make_repo)
run "checkout -- <clean path> passes" "$R" "git checkout -- tracked.txt" 0
run "branch switch passes" "$R" "git checkout main" 0
run "branch create passes" "$R" "git checkout -b feature" 0
run "unrelated command passes" "$R" "git status" 0
run "git commit passes" "$R" "git commit -m x" 0
rm -rf "$R"

# --- not a git repo: must PASS (fail open) ---------------------------------
T=$(mktemp -d)
run "outside a work tree passes" "$T" "git checkout -- tracked.txt" 0
rm -rf "$T"

# --- Command matching (issue #2129) -----------------------------------------
# The gate must see its verb wherever it sits in the command list, and must NOT
# fire on a quoted MENTION of it. Both directions, or the matcher is untested.
R=$(make_repo)
echo "dirty" > "$R/tracked.txt"
run "compound: git stash && git restore -- <dirty path> blocks" "$R" \
  "git stash && git restore -- tracked.txt" 2
run "quoted mention of git restore does not fire" "$R" \
  'echo "then git restore -- tracked.txt"' 0
rm -rf "$R"

echo
echo "dirty-path-restore-gate: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
