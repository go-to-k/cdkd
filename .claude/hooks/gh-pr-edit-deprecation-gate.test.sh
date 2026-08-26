#!/usr/bin/env bash
# Smoke test for gh-pr-edit-deprecation-gate.sh.
#
# The gate needs no network and no fixture repo: its whole decision is
# "is this a `gh pr edit` that sets --title / --body / --body-file". This suite
# exists because issue #2129 measured the gate BLOCKING a command that never
# called gh (`echo "next step: gh pr edit 1 --body foo"`), so both directions of
# the match are now pinned.
#
# Issue #2037 then reported four more DATA-position shapes measured in the wild
# while editing this repo's own hook fixtures: a `grep` pattern, a
# `python3 - <<'PY'` heredoc body, a `-f body=` string, and a `run_case` label.
# All four are quoted text that cannot invoke anything, and a PreToolUse denial
# aborts the WHOLE call, so blocking them ran nothing at all. They pass under the
# shared matcher and are pinned below, PAIRED with the invocation twin of each so
# a fix that merely stops refusing things cannot look green: every ALLOW case has
# a BLOCK case one quote-removal away. The unbounded-bypass class (an alias, a
# variable holding the verb) is go-to-k/cdkd#2156, deliberately not fenced here.
#
# Run from the repo root:
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
# Issue #2037's `cd <worktree> &&` twin: this repo runs nearly every gated command
# from a worktree, so losing that shape would make the gate miss its commonest form.
run_case "cd <worktree> && gh pr edit --body blocked" 2 \
  'cd /w/t && gh pr edit 123 --body x'
run_case "semicolon-chained gh pr edit --body blocked" 2 \
  'echo start; gh pr edit 123 --body x'
run_case "subshell gh pr edit --body blocked" 2 '( gh pr edit 123 --body x )'
# An interpreter's `-c` payload is CODE, not data: the quote is the interpreter's
# argument syntax, so stripping it as a data span would be a real bypass.
run_case "bash -c payload blocked" 2 "bash -c 'gh pr edit 123 --body x'"
# Flag order is not part of the match: the verb decides, the flag scan is separate.
run_case "flags before the number blocked" 2 'gh pr edit --body x 123'
run_case "pipe target gh pr edit --body-file blocked" 2 \
  'cat /tmp/b.md | gh pr edit 123 --body-file -'

# --- PASS --------------------------------------------------------------------
run_case "quoted mention does not fire" 0 'echo "next step: gh pr edit 1 --body foo"'
run_case "single-quoted mention does not fire" 0 "echo 'run gh pr edit 1 --title x'"
run_case "gh pr edit without title/body passes" 0 'gh pr edit 123 --add-label bug'
run_case "gh pr create is not gh pr edit" 0 'gh pr create --body x'
# --- PASS: the four DATA-position shapes issue #2037 measured in the wild -------
# 1. the `grep` used to locate those labels (reported repro 2).
run_case "grep pattern mentioning the verb does not fire" 0 \
  "grep -n 'gh pr edit ' pr-body-item-number-gate.test.sh"
# 2. a heredoc body carrying the spelling as a replacement anchor (reported repro 1).
run_case "python3 heredoc body does not fire" 0 \
  $'python3 - <<\'PY\'\ns = "gh pr edit 1 --body t"\nPY'
# 3. the spelling inside the body TEXT of the prescribed replacement call.
run_case "api PATCH body text mentioning the verb does not fire" 0 \
  'gh api -X PATCH repos/o/r/pulls/1 -f body="do not use gh pr edit --body"'
# 4. a test-case label quoting the verb, which is what this very file is made of.
run_case "test-case label quoting the verb does not fire" 0 \
  'run_case "gh pr edit --body blocked" 2 '\''gh pr edit 123 --body x'\'''
# The replacement the block message prescribes must never be gated by its own gate.
run_case "prescribed api PATCH replacement passes" 0 \
  'gh api -X PATCH repos/o/r/pulls/1 -f title=T -F body=@/tmp/b.md'
run_case "unrelated command passes" 0 'git status --short'
run_case "empty command passes" 0 ''

echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
