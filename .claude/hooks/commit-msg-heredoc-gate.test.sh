#!/usr/bin/env bash
# Smoke test for commit-msg-heredoc-gate.sh.
#
# Verifies the hook blocks `git commit -m "$(cat <<EOF...)"` (the
# fragile shell-quote-tracking case) but allows the safe `cat > file
# <<EOF...EOF && git commit -F file` pattern that writes the message
# to a file before the commit reads it back. Run from the repo root:
# `bash .claude/hooks/commit-msg-heredoc-gate.test.sh`.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/commit-msg-heredoc-gate.sh"

pass=0
fail=0
fail_log=""

# run_case <name> <expect_exit> <command-string>
run_case() {
  local name="$1"; local want="$2"; local cmdstr="$3"
  local payload
  payload=$(jq -cn --arg c "$cmdstr" '{tool_input:{command:$c}}')
  local got
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got\n"
    fail_log+="  command: $cmdstr\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# --- ALLOW cases ---

run_case "non-git command always allowed" 0 \
  'ls -la'

run_case "git status (not a commit) always allowed" 0 \
  'git status'

run_case "plain git commit -m without heredoc allowed" 0 \
  'git commit -m "simple message"'

run_case "git commit -F file allowed (no heredoc anywhere)" 0 \
  'git commit -F /tmp/msg.txt'

# THE main false-positive the regex tightening fixes: heredoc writes to
# a file, then commit reads the file via -F. Heredoc is in the same
# Bash call but on a different pipeline segment (separated by &&).
run_case "cat > file <<EOF + git commit -F file (segment-separated)" 0 \
  $'cat > /tmp/m.txt <<\'EOF\'\nbody\nEOF\n && git commit -F /tmp/m.txt'

run_case "heredoc-then-commit with semicolon separator" 0 \
  $'cat > /tmp/m.txt <<\'EOF\'\nbody\nEOF\n; git commit -F /tmp/m.txt'

# Heredoc appears BEFORE git commit on the same line, but not as the
# -m argument source. Safe because the heredoc terminates before -m
# begins.
run_case "heredoc-as-stdin pattern allowed (heredoc precedes git)" 0 \
  $'tee /tmp/m.txt <<\'EOF\'\nbody\nEOF\n; git commit -F /tmp/m.txt'

# --- BLOCK cases ---

run_case "git commit -m with command-substituted heredoc blocked" 2 \
  'git commit -m "$(cat <<EOF\nbody\nEOF\n)"'

run_case "git commit --message with heredoc blocked" 2 \
  'git commit --message "$(cat <<EOF\nbody\nEOF\n)"'

# Both -m and a later heredoc in the same pipeline segment → block.
run_case "git commit -m followed by heredoc blocked" 2 \
  'git commit -m "$(<<EOF\nbody\nEOF\n)"'

# --- Edge cases ---

run_case "empty command allowed" 0 \
  ''

run_case "git commit -m without heredoc, semicolon, then unrelated heredoc" 0 \
  $'git commit -m simple; cat > /tmp/x <<\'EOF\'\nfoo\nEOF\n'

echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
