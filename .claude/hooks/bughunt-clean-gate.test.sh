#!/usr/bin/env bash
# Smoke tests for bughunt-clean-gate.sh
#
# Sets up a throwaway git repo, optionally arms the bug-hunt sentinel at the
# repo root, runs the hook against simulated tool input, and asserts the
# expected pass (0) / block (2) behavior.

set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/bughunt-clean-gate.sh"
PASS=0
FAIL=0

# run <name> <armed:0|1> <cmd> <expect_exit>
run() {
  local name="$1" armed="$2" cmd="$3" expect="$4"

  local tmp
  tmp=$(mktemp -d)
  pushd "$tmp" >/dev/null

  git init -q -b main
  git config user.email t@t
  git config user.name t
  : > seed
  git add -A
  git commit -q -m init

  if [ "$armed" = "1" ]; then
    printf 'CdkdBughuntFoo\nCdkdBughuntBar\n' > "$tmp/.markgate-bughunt-pending"
  fi

  local payload exit_code
  payload="{\"tool_input\":{\"command\":$(printf '%s' "$cmd" | jq -Rs .)},\"cwd\":\"$tmp\"}"
  set +e
  printf '%s' "$payload" | bash "$HOOK" >/dev/null 2>&1
  exit_code=$?
  set -e

  popd >/dev/null
  rm -rf "$tmp"

  if [ "$exit_code" -eq "$expect" ]; then
    PASS=$((PASS + 1))
    echo "ok   - $name (exit $exit_code)"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL - $name (got $exit_code, expected $expect)"
  fi
}

# Disarmed: every command passes through.
run "disarmed + git commit passes"        0 "git commit -m x"        0
run "disarmed + gh pr merge passes"       0 "gh pr merge 5 --squash" 0

# Armed: gated commands block.
run "armed + git commit blocks"           1 "git commit -m x"        2
run "armed + git -C commit blocks"        1 "git -C . commit -m x"   2
run "armed + gh pr create blocks"         1 "gh pr create --fill"    2
run "armed + gh pr merge blocks"          1 "gh pr merge 5 --squash" 2

# Armed: non-gated commands still pass.
run "armed + git status passes"           1 "git status"            0
run "armed + git push passes"             1 "git push origin main"  0

# Armed: quoted-body false positives must NOT block (line-start anchoring).
run "armed + echo mentioning git commit"  1 "echo 'run git commit later'"           0
run "armed + echo mentioning gh pr merge" 1 "echo 'remember to gh pr merge soon'"   0

echo
echo "bughunt-clean-gate: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
