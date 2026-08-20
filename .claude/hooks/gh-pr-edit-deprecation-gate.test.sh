#!/usr/bin/env bash
# Smoke test for gh-pr-edit-deprecation-gate.sh.
#
# The gate needs no network and no fixture repo: its whole decision is
# "is this a `gh pr edit` that sets --title / --body / --body-file". This suite
# exists because issue #2129 measured the gate BLOCKING a command that never
# called gh (`echo "next step: gh pr edit 1 --body foo"`), so both directions of
# the match are now pinned. Run from the repo root:
#   bash .claude/hooks/gh-pr-edit-deprecation-gate.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gh-pr-edit-deprecation-gate.sh"

pass=0
fail=0
fail_log=""

# run_case <name> <expect_exit> <command-string>
run_case() {
  local name="$1" want="$2" cmdstr="$3" payload got
  payload=$(jq -cn --arg c "$cmdstr" '{tool_name:"Bash",tool_input:{command:$c}}')
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1)); printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got\n  command: $cmdstr\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# --- BLOCK: the deprecated shape, wherever it sits in the command list -------
run_case "bare gh pr edit --body blocked" 2 'gh pr edit 123 --body x'
run_case "gh pr edit --title blocked" 2 'gh pr edit 123 --title x'
run_case "gh pr edit --body-file blocked" 2 'gh pr edit 123 --body-file /tmp/b.md'
run_case "compound: git push && gh pr edit --body blocked" 2 \
  'git push && gh pr edit 123 --body x'
run_case "compound with echo first" 2 'echo start && gh pr edit 123 --body x'
run_case "gh -C <path> pr edit blocked" 2 'gh -C /w/t pr edit 123 --body x'
run_case "leading env assignment blocked" 2 'GH_PAGER=cat gh pr edit 123 --body x'

# --- PASS --------------------------------------------------------------------
run_case "quoted mention does not fire" 0 'echo "next step: gh pr edit 1 --body foo"'
run_case "single-quoted mention does not fire" 0 "echo 'run gh pr edit 1 --title x'"
run_case "gh pr edit without title/body passes" 0 'gh pr edit 123 --add-label bug'
run_case "gh pr create is not gh pr edit" 0 'gh pr create --body x'
run_case "unrelated command passes" 0 'git status --short'
run_case "empty command passes" 0 ''

echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
