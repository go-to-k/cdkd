#!/usr/bin/env bash
# Smoke tests for closes-paren-form-gate.sh
#
# Mocks `gh pr view` via a $GH_BIN injected stub so we don't hit real
# GitHub. Asserts:
#   - Hook PASSES when body has parens-free `Closes #N`
#   - Hook PASSES when body has parens form WITHOUT close keyword (incidental ref)
#   - Hook BLOCKS when body has `Closes (#N)` / `Fixes (#N)` / `Resolves (#N)`
#   - Hook PASSES for non-merge commands
#   - Hook PASSES when gh fails (offline tolerance)

set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/closes-paren-form-gate.sh"
PASS=0
FAIL=0

run() {
  local name="$1"
  local input="$2"
  local mock_body="$3"
  local expect_exit="$4"

  # Create a temp dir + mock gh binary
  local tmp
  tmp=$(mktemp -d)
  cat <<EOF > "$tmp/gh"
#!/usr/bin/env bash
# Mock gh — emit the canned body on \`gh pr view ... --json body -q .body\`
if [[ "\$1" == "pr" && "\$2" == "view" ]]; then
  cat <<<'$mock_body'
  exit 0
fi
exit 0
EOF
  chmod +x "$tmp/gh"

  local out err exit_code
  out=$(echo "$input" | PATH="$tmp:$PATH" "$HOOK" 2>"$tmp/err") && exit_code=$? || exit_code=$?
  err=$(cat "$tmp/err")

  if [[ "$exit_code" -eq "$expect_exit" ]]; then
    echo "PASS: $name (exit $exit_code)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $exit_code, expected $expect_exit)"
    echo "  stderr: $err"
    FAIL=$((FAIL + 1))
  fi

  rm -rf "$tmp"
}

# 1. PASS: parens-free Closes #N
run "parens-free Closes #N passes" \
  '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 100 --squash"}}' \
  'Closes #502.' \
  0

# 2. BLOCK: Closes (#N) parens form
run "Closes (#N) blocked" \
  '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 100 --squash"}}' \
  'Closes (#502).' \
  2

# 3. BLOCK: Fixes (#N) parens form
run "Fixes (#N) blocked" \
  '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 100 --squash"}}' \
  'Fixes (#502).' \
  2

# 4. BLOCK: Resolves (#N) parens form (case-insensitive)
run "resolves (#N) lowercase blocked" \
  '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 100 --squash"}}' \
  'resolves (#502).' \
  2

# 5. PASS: incidental ref `(#N)` WITHOUT close keyword
run "incidental (#N) without close keyword passes" \
  '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 100 --squash"}}' \
  'See also (#502) for context.' \
  0

# 6. PASS: non-merge gh command
run "non-merge gh command passes" \
  '{"tool_name":"Bash","tool_input":{"command":"gh pr view 100"}}' \
  'Closes (#502).' \
  0

# 7. PASS: non-Bash tool
run "non-Bash tool passes" \
  '{"tool_name":"Read","tool_input":{"file_path":"/tmp/x"}}' \
  'Closes (#502).' \
  0

# 8. PASS: offline (gh returns nothing)
run "offline tolerance" \
  '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 100 --squash"}}' \
  '' \
  0

# 9. PASS: mixed body — Closes #N AND (#X) incidental — only counts parens-form-on-keyword
run "mixed body: Closes #N + (#X) incidental ref passes" \
  '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 100 --squash"}}' \
  'Closes #502. References (#510) for context.' \
  0

# 10. BLOCK: even one parens-form close in a multi-line body
run "multi-line body with one Closes (#N) blocks" \
  '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 100 --squash"}}' \
  '## Summary
Some body text.

Closes #502.
Also closes (#512).' \
  2

# 11. PASS: gh -C <path> pr merge variant
run "gh -C <path> pr merge with parens-free Closes" \
  '{"tool_name":"Bash","tool_input":{"command":"gh -C /tmp/x pr merge 100 --squash"}}' \
  'Closes #502.' \
  0

# 12. PASS: Bash comment containing "gh pr merge" + real "gh pr merge N" — extract LAST occurrence
run "Bash comment + real merge extracts last PR num" \
  '{"tool_name":"Bash","tool_input":{"command":"# wait then gh pr merge\nfor i in 1 2 3; do echo loop; done; gh pr merge 800 --squash"}}' \
  'Closes #800.' \
  0

# Summary
echo ""
echo "==== Test Summary ===="
echo "PASS: $PASS"
echo "FAIL: $FAIL"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
