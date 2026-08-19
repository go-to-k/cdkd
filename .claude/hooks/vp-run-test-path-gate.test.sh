#!/usr/bin/env bash
# Smoke suite for vp-run-test-path-gate.sh.
#
# Run from anywhere; the hook is resolved relative to THIS file so the
# suite finds its subject beside itself. Running it from a scratch copy
# is what makes every case exit 127 and read as a regression the change
# did not cause.

set -u

HOOK_DIR="${BASH_SOURCE[0]%/*}"
[ "$HOOK_DIR" = "${BASH_SOURCE[0]}" ] && HOOK_DIR="."
HOOK="$HOOK_DIR/vp-run-test-path-gate.sh"

pass=0
fail=0

# run <expected-rc> <label> <command-string>
run() {
  local want="$1" label="$2" cmd="$3" got
  printf '%s' "{\"tool_input\":{\"command\":$(printf '%s' "$cmd" | jq -Rs .)}}" \
    | bash "$HOOK" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $label (want rc=$want, got rc=$got)"
  fi
}

# --- BLOCK: the cached-replay shape, in every spelling that reaches it ---
run 2 'bare path' 'vp run test tests/unit/foo.test.ts'
run 2 'path with a leading cd' 'cd /repo && vp run test tests/unit/foo.test.ts'
run 2 'path after another command' 'vp run build && vp run test tests/unit/foo.test.ts'
run 2 'directory rather than a file' 'vp run test tests/unit/provisioning'
run 2 'path plus a flag' 'vp run test tests/unit/foo.test.ts --coverage'
run 2 'flag before the path' 'vp run test --coverage tests/unit/foo.test.ts'
run 2 'value-taking flag then a path' 'vp run test --reporter json tests/unit/foo.test.ts'
run 2 'after a semicolon' 'echo start; vp run test tests/unit/foo.test.ts'

# --- PASS: the whole-suite form the gate flow legitimately runs ---
run 0 'bare vp run test' 'vp run test'
run 0 'bare with a leading cd' 'cd /repo && vp run test'
run 0 'flag only, no path' 'vp run test --coverage'
run 0 'long flag with inline value' 'vp run test --reporter=json'
run 0 'value-taking flag consumes its value' 'vp run test --reporter json'

# --- PASS: not this command at all ---
run 0 'a different vp task' 'vp run typecheck'
run 0 'a task whose name starts with test' 'vp run test:once-leak'
run 0 'the recommended replacement itself' 'vp test run tests/unit/foo.test.ts'
run 0 'plain vitest' 'npx vitest run tests/unit/foo.test.ts'

# --- PASS: quoted-body false positives (cdkd#563) ---
# The trigger appears only inside an argument of an unrelated command, so
# the command-position matcher must not fire.
run 0 'quoted in a gh body' 'gh issue create --body "do not use vp run test tests/unit/foo.test.ts"'
run 0 'quoted in an echo' 'echo "vp run test tests/unit/foo.test.ts is cached"'
run 0 'quoted in a commit message' 'git commit -m "docs: explain why vp run test tests/x.test.ts replays"'

# --- PASS: the whole-suite form with SHELL PLUMBING attached ---
# Every one of these blocked under the first cut's "a token that is not a flag
# is a path" rule. The first is the exact command this repo's own skills
# instruct for capturing the rc, so the hook was refusing its own documentation.
run 0 'redirect to a file, then read rc' 'vp run test > /tmp/out 2>&1; rc=$?'
run 0 'redirect merged into a pipe' 'vp run test 2>&1 | tail -40'
run 0 'append redirect' 'vp run test >> /tmp/out'
run 0 'backgrounded' 'vp run test &'
run 0 'trailing comment' 'vp run test # runs the whole suite'
run 0 'env prefix' 'CDKD_ONCE_LEAK_DETECT=1 vp run test'
run 0 'value-taking flag not on any list' 'vp run test -t "some name"'
run 0 'another unlisted value flag' 'vp run test --testNamePattern foo'
run 0 'output file under a path' 'vp run test --outputFile /tmp/out.json'

# --- PASS: a NEWLINE ends the argument list ---
# A multi-line Bash call is the norm here; without newline truncation the next
# line's command was read as this one's arguments.
run 0 'bare run, next line is another command' 'vp run test
vp run build'
run 0 'bare run between two other lines' 'cd /repo
vp run test
echo done'

# --- BLOCK: a real path still caught across those same shapes ---
run 2 'path then redirect' 'vp run test tests/unit/foo.test.ts > /tmp/out 2>&1'
run 2 'path on a line of its own' 'cd /repo
vp run test tests/unit/foo.test.ts
echo done'
run 2 'multiple spaces between words' 'vp   run   test   tests/unit/foo.test.ts'
run 2 'earlier occurrence, sibling task last' 'vp run test tests/unit/a.test.ts && vp run test:hooks'
run 2 'nested tests dir' 'vp run test packages/x/tests/unit/foo.test.ts'
run 2 'relative tests dir' 'vp run test ./tests/unit'

# --- PASS: heredoc bodies are prose, not commands ---
run 0 'command named inside a heredoc body' "vp run test && git commit -F - <<'EOF'
note: vp run test tests/x.test.ts is cached
EOF"

# --- Known limit, asserted so it cannot widen silently ---
# A fully quoted path is neutralised to a placeholder and is NOT recognised.
# This is a false NEGATIVE (the pre-hook status quo), which is the safe
# direction; the control below proves the unquoted twin IS caught.
run 0 'KNOWN LIMIT: fully quoted path' 'vp run test "tests/unit/foo.test.ts"'
run 2 'control for the limit above: unquoted' 'vp run test tests/unit/foo.test.ts'

# --- PASS: nothing to inspect ---
run 0 'empty command' ''

echo "Pass: $pass  Fail: $fail"
[ "$fail" = "0" ]
