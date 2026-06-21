#!/usr/bin/env bash
# Smoke test for main-tree-dirty-detector.sh.
#
# Builds a fixture repo, dirties (or not) its tracked files, and feeds
# the hook synthetic PostToolUse payloads — asserting whether a warning
# is emitted (stdout contains the hook marker) or not. Run from repo root:
#   bash .claude/hooks/main-tree-dirty-detector.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/main-tree-dirty-detector.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

MAIN="$TMPDIR/main"
git init -q -b main "$MAIN"
mkdir -p "$MAIN/docs/_generated"
echo "row" > "$MAIN/docs/_generated/ledger.tsv"
git -C "$MAIN" add -A
git -C "$MAIN" -c user.email=t@t -c user.name=t commit -q -m init

pass=0; fail=0
# run_case <expect: warn|quiet> <desc> <json>
run_case() {
  local expect="$1" desc="$2" json="$3" out got
  out=$(printf '%s' "$json" | bash "$HOOK" 2>/dev/null)
  if printf '%s' "$out" | grep -q "main-tree-dirty-detector"; then got="warn"; else got="quiet"; fi
  if [[ "$got" == "$expect" ]]; then
    pass=$((pass+1)); printf 'ok   (%s) %s\n' "$got" "$desc"
  else
    fail=$((fail+1)); printf 'FAIL (got %s, want %s) %s\n' "$got" "$expect" "$desc"
  fi
}

writecmd() { jq -nc --arg c "$1" --arg cwd "$MAIN" '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$c}}'; }

# 1. Clean main tree + write-ish command -> quiet.
run_case quiet "clean main tree + mv command" "$(writecmd 'mv "$tmp" "$LEDGER"')"

# 2. Dirty a TRACKED file in main tree + write-ish command -> warn.
echo "drift" >> "$MAIN/docs/_generated/ledger.tsv"
run_case warn "dirty tracked file + mv command (the incident shape)" "$(writecmd 'mv "$tmp" "$LEDGER"')"

# 3. Dirty main tree but READ-ONLY command -> quiet (token gate).
run_case quiet "dirty tracked file + read-only grep" "$(writecmd 'grep -n row docs/_generated/ledger.tsv')"

# 4. Dirty main tree + redirect command -> warn.
run_case warn "dirty tracked file + > redirect command" "$(writecmd 'echo x > "$f"')"

# 5. Restore main tree clean -> quiet again.
git -C "$MAIN" checkout -q -- docs/_generated/ledger.tsv
run_case quiet "restored clean main tree + mv command" "$(writecmd 'mv a b')"

# 6. Untracked-only change must NOT warn (only tracked changes matter).
echo "scratch" > "$MAIN/untracked.txt"
run_case quiet "untracked-only file present + mv command" "$(writecmd 'mv a b')"
rm -f "$MAIN/untracked.txt"

# 7. Main repo on a FEATURE branch + dirty tracked + write -> quiet (branch guard).
git -C "$MAIN" checkout -q -b feat/x
echo "drift2" >> "$MAIN/docs/_generated/ledger.tsv"
run_case quiet "main repo on feature branch + dirty + mv (branch guard)" "$(writecmd 'mv a b')"
git -C "$MAIN" checkout -q -- docs/_generated/ledger.tsv
git -C "$MAIN" checkout -q main

echo "----"
echo "passed=$pass failed=$fail"
[[ "$fail" -eq 0 ]]
