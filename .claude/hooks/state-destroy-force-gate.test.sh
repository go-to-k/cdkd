#!/usr/bin/env bash
# Smoke tests for state-destroy-force-gate.sh
#
# Sets up a throwaway git repo with staged shell scripts, runs the
# hook against simulated `git commit` Bash tool input, and asserts
# the expected pass/block behavior.

set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/state-destroy-force-gate.sh"
PASS=0
FAIL=0

# Run one case. Args:
#   $1 name            — test name
#   $2 file_relpath    — path inside the temp repo to stage
#   $3 file_content    — content to commit-then-modify so the staged
#                        diff is the file content as ADDED lines
#   $4 cmd             — tool_input.command to feed the hook
#   $5 expect_exit     — expected hook exit code (0 pass, 2 block)
run() {
  local name="$1" rel="$2" content="$3" cmd="$4" expect="$5"

  local tmp
  tmp=$(mktemp -d)
  pushd "$tmp" >/dev/null

  git init -q -b main
  git config user.email t@t
  git config user.name t

  mkdir -p "$(dirname "$rel")"
  : > "$rel"
  git add -A
  git commit -q -m init

  # Now stage the actual content as additions.
  printf '%s\n' "$content" > "$rel"
  git add -A

  local input
  input=$(jq -nc --arg cmd "$cmd" --arg cwd "$tmp" \
    '{tool_name:"Bash", tool_input:{command:$cmd}, cwd:$cwd}')

  local err exit_code
  err=$(mktemp)
  if echo "$input" | "$HOOK" 2>"$err"; then
    exit_code=0
  else
    exit_code=$?
  fi

  if [[ "$exit_code" -eq "$expect" ]]; then
    echo "PASS: $name (exit $exit_code)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $exit_code, expected $expect)"
    echo "  stderr: $(cat "$err")"
    FAIL=$((FAIL + 1))
  fi

  rm -f "$err"
  popd >/dev/null
  rm -rf "$tmp"
}

# ---------- BLOCK cases ----------

run "verify.sh state destroy --force blocks" \
  "tests/integration/foo/verify.sh" \
  '#!/usr/bin/env bash
node ../../../dist/cli.js state destroy "$STACK" --force' \
  "git commit -m x" \
  2

run "verify.sh state destroy -f short-flag blocks" \
  "tests/integration/foo/verify.sh" \
  '#!/usr/bin/env bash
node dist/cli.js state destroy MyStack -f' \
  "git commit -m x" \
  2

run "any *.sh under tests/integration blocks (not just verify.sh)" \
  "tests/integration/foo/cleanup.sh" \
  'cdkd state destroy MyStack --force' \
  "git commit -m x" \
  2

# ---------- PASS cases ----------

run "state destroy --yes passes" \
  "tests/integration/foo/verify.sh" \
  '#!/usr/bin/env bash
node ../../../dist/cli.js state destroy "$STACK" --yes' \
  "git commit -m x" \
  0

run "top-level cdkd destroy --force passes (NOT state destroy)" \
  "tests/integration/foo/verify.sh" \
  '#!/usr/bin/env bash
node ../../../dist/cli.js destroy "$STACK" --force' \
  "git commit -m x" \
  0

run "state orphan --force passes (orphan accepts --force)" \
  "tests/integration/foo/verify.sh" \
  '#!/usr/bin/env bash
node ../../../dist/cli.js state orphan "$STACK" --force' \
  "git commit -m x" \
  0

run "comment mentioning state destroy --force passes" \
  "tests/integration/foo/verify.sh" \
  '#!/usr/bin/env bash
# state destroy rejects --force; use --yes' \
  "git commit -m x" \
  0

run "shell script outside tests/integration passes" \
  "scripts/foo.sh" \
  'cdkd state destroy MyStack --force' \
  "git commit -m x" \
  0

run "non-commit Bash command passes" \
  "tests/integration/foo/verify.sh" \
  '#!/usr/bin/env bash
node dist/cli.js state destroy "$STACK" --force' \
  "ls -la" \
  0

run "non-Bash tool passes" \
  "tests/integration/foo/verify.sh" \
  '#!/usr/bin/env bash
node dist/cli.js state destroy "$STACK" --force' \
  "" \
  0

# ---------- Wrap up ----------

echo ""
echo "Passed: $PASS   Failed: $FAIL"
exit $FAIL
