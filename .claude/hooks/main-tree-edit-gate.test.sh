#!/usr/bin/env bash
# Smoke test for main-tree-edit-gate.sh.
#
# Builds a fixture repo on `main` plus a linked feature-branch
# worktree, then feeds the hook synthetic PreToolUse payloads and
# asserts the exit code. Run from the repo root:
#   bash .claude/hooks/main-tree-edit-gate.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/main-tree-edit-gate.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

MAIN="$TMPDIR/main"
git init -q -b main "$MAIN"
mkdir -p "$MAIN/docs/_generated" "$MAIN/src"
echo "row" > "$MAIN/docs/_generated/ledger.tsv"
echo "x" > "$MAIN/src/existing.ts"
git -C "$MAIN" add -A
git -C "$MAIN" -c user.email=t@t -c user.name=t commit -q -m init

# Feature worktree on a non-main branch.
WT="$MAIN/.claude/worktrees/feat"
git -C "$MAIN" worktree add -q "$WT" -b feat/work 2>/dev/null
mkdir -p "$WT/docs/_generated"

pass=0; fail=0
# run_case <expected_exit> <desc> <json>
run_case() {
  local expected="$1" desc="$2" json="$3" rc
  printf '%s' "$json" | bash "$HOOK" >/dev/null 2>&1
  rc=$?
  if [[ "$rc" == "$expected" ]]; then
    pass=$((pass+1)); printf 'ok   (exit %s) %s\n' "$rc" "$desc"
  else
    fail=$((fail+1)); printf 'FAIL (exit %s, want %s) %s\n' "$rc" "$expected" "$desc"
  fi
}

# 1. Edit a TRACKED file in the main tree on `main` -> BLOCK (2).
run_case 2 "Edit tracked ledger in main tree on main" \
  "$(jq -nc --arg fp "$MAIN/docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Edit", cwd:$cwd, tool_input:{file_path:$fp}}')"

# 2. Edit the SAME tracked file but inside the feature worktree -> PASS (0).
cp "$MAIN/docs/_generated/ledger.tsv" "$WT/docs/_generated/ledger.tsv" 2>/dev/null || true
run_case 0 "Edit tracked ledger inside feature worktree" \
  "$(jq -nc --arg fp "$WT/docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Edit", cwd:$cwd, tool_input:{file_path:$fp}}')"

# 3. Bash redirect `> trackedfile` in main tree on main -> BLOCK (2).
run_case 2 "Bash '> ledger.tsv' in main tree on main" \
  "$(jq -nc --arg cmd "echo hi > $MAIN/docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 4. Bash write to /tmp (untracked, outside repo) -> PASS (0).
run_case 0 "Bash '> /tmp/scratch' " \
  "$(jq -nc --arg cmd "echo hi > /tmp/scratch.$$.log" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 5. Write a NEW source file under src/ in main tree on main -> BLOCK (2).
run_case 2 "Write new src/ file in main tree on main" \
  "$(jq -nc --arg fp "$MAIN/src/brandnew.ts" --arg cwd "$MAIN" \
    '{tool_name:"Write", cwd:$cwd, tool_input:{file_path:$fp}}')"

# 6. Read-only Bash (no write target) in main tree -> PASS (0).
run_case 0 "Bash read-only grep in main tree" \
  "$(jq -nc --arg cmd "grep -n row $MAIN/docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 7. tee to tracked file in main tree on main -> BLOCK (2).
run_case 2 "Bash 'tee ledger.tsv' in main tree on main" \
  "$(jq -nc --arg cmd "echo x | tee $MAIN/docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 8. Variable-indirected write target is a KNOWN GAP -> PASS (0)
#    (documented: worktree-first process is the guard for this).
run_case 0 "Bash 'mv \$tmp \$LEDGER' (variable target, known gap)" \
  "$(jq -nc --arg cmd 'mv "$tmp" "$LEDGER"' --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

echo "----"
echo "passed=$pass failed=$fail"
[[ "$fail" -eq 0 ]]
