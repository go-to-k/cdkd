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
# Repo-aware runner. The stub above returns one canned body regardless of `-R`,
# so no case built on it can tell WHICH PR the gate fetched -- and that is the
# defect being fixed here: `gh pr view <N>` with no repo resolves against the
# hook process's cwd, so a cross-repo merge was checked against a different PR
# sharing the number. A fixture that cannot distinguish the two repos cannot
# fence it.
run_case_repo() {
  local name="$1" input="$2" body_with_repo="$3" body_without_repo="$4" expect_exit="$5"
  local tmp; tmp=$(mktemp -d)
  cat <<EOF > "$tmp/gh"
#!/usr/bin/env bash
# Answer per REPO: a \`-R\` anywhere means the caller asked for the other one.
if [[ "\$1" == "pr" && "\$2" == "view" ]] || [[ "\$1" == "-R" ]]; then
  for a in "\$@"; do
    if [[ "\$a" == "-R" || "\$a" == "--repo" || "\$a" == --repo=* ]]; then
      cat <<<'$body_with_repo'
      exit 0
    fi
  done
  cat <<<'$body_without_repo'
  exit 0
fi
exit 0
EOF
  chmod +x "$tmp/gh"
  local exit_code
  echo "$input" | PATH="$tmp:$PATH" "$HOOK" >/dev/null 2>"$tmp/err" && exit_code=$? || exit_code=$?
  if [[ "$exit_code" -eq "$expect_exit" ]]; then
    echo "PASS: $name (exit $exit_code)"; PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $exit_code, expected $expect_exit)"
    echo "  stderr: $(cat "$tmp/err")"; FAIL=$((FAIL + 1))
  fi
  rm -rf "$tmp"
}

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

# 8. PASS: empty body (PR has no body content — gh succeeds with "")
run "empty PR body passes silently" \
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

# 13. PASS-with-warning: `gh pr view` exits non-zero (network / auth)
#     — fail-open by policy but EMIT loud stderr warning so the user
#     sees the gate couldn't verify (closes the silent-bypass gap that
#     let PR #671 / #668 ship with Closes (#N) undetected, 2026-05-27)
run_gh_fail() {
  local name="$1"
  local input="$2"
  local expect_exit="$3"
  local expect_stderr_pattern="$4"

  local tmp
  tmp=$(mktemp -d)
  cat <<EOF > "$tmp/gh"
#!/usr/bin/env bash
# Mock gh that ALWAYS fails on \`gh pr view\` (simulates auth/network drop)
if [[ "\$1" == "pr" && "\$2" == "view" ]]; then
  echo "error connecting to api.github.com: dial tcp: lookup api.github.com: no such host" >&2
  exit 1
fi
exit 0
EOF
  chmod +x "$tmp/gh"

  local err exit_code
  echo "$input" | PATH="$tmp:$PATH" "$HOOK" 2>"$tmp/err" && exit_code=$? || exit_code=$?
  err=$(cat "$tmp/err")

  if [[ "$exit_code" -ne "$expect_exit" ]]; then
    echo "FAIL: $name (exit $exit_code, expected $expect_exit)"
    echo "  stderr: $err"
    FAIL=$((FAIL + 1))
  elif ! echo "$err" | grep -q "$expect_stderr_pattern"; then
    echo "FAIL: $name (stderr missing pattern '$expect_stderr_pattern')"
    echo "  stderr: $err"
    FAIL=$((FAIL + 1))
  else
    echo "PASS: $name (exit $exit_code + stderr warning)"
    PASS=$((PASS + 1))
  fi

  rm -rf "$tmp"
}

run_gh_fail "gh pr view fails → fail-open but loud warning to stderr" \
  '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 100 --squash"}}' \
  0 \
  'could not fetch PR #100 body'

# --- Command matching (issue #2129) -----------------------------------------
# The gate must see its verb wherever it sits in the command list, and must NOT
# fire on a quoted MENTION of it. Both directions, or the matcher is untested.
run "compound: vp run test && gh pr merge blocked" \
  '{"tool_name":"Bash","tool_input":{"command":"vp run test && gh pr merge 100 --squash"}}' \
  'Closes (#502).' \
  2

run "quoted mention of gh pr merge passes" \
  '{"tool_name":"Bash","tool_input":{"command":"echo \\"then gh pr merge 100 --squash\\""}}' \
  'Closes (#502).' \
  0

# Summary
echo ""
# --- REPO RESOLUTION (measured false positive, 2026-08-25) -------------------
#
# `gh pr merge 553 -R go-to-k/cdk-local`, run from a cdk-local worktree, was
# refused citing line 73 of CDKD's PR 553 -- a Firehose bundle with nothing to do
# with it. The cdk-local PR's body is 41 lines. Both directions are wrong and the
# silent one is worse: the same mismatch PASSES a real `Closes (#N)` whenever the
# session's PR of that number happens to be clean.
run_case_repo "explicit -R: the OTHER repo's clean body is what counts" \
  '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 553 -R go-to-k/cdk-local --squash"}}' \
  'A clean body with no close directive at all.' \
  'Closes (#549) in full.' \
  0

run_case_repo "explicit -R: a trap in the NAMED repo still refuses" \
  '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 553 -R go-to-k/cdk-local --squash"}}' \
  'Closes (#549) in full.' \
  'A clean body with no close directive at all.' \
  2

# Control: with no `-R`, the session's own repo is the right answer, so the
# body the plain call returns must still be the one that decides. Without this
# the two cases above are satisfied by a gate that stopped reading bodies.
run_case_repo "no -R: the local body still decides" \
  '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 553 --squash"}}' \
  'A clean body with no close directive at all.' \
  'Closes (#549) in full.' \
  2

echo "==== Test Summary ===="
echo "PASS: $PASS"
echo "FAIL: $FAIL"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
