#!/usr/bin/env bash
# Smoke suite for broad-process-kill-gate.sh.
#
# Run from anywhere; the hook is resolved relative to THIS file so the
# suite finds its subject beside itself.
#
# `HOOK_BASH` is honoured because `run-tests.sh` exports it to run the
# SUBJECT under each shell it tests, macOS bash 3.2 included. The first
# revision hardcoded `bash`, so the whole 3.2 round was inert here --
# `HOOK_BASH=/nonexistent/bash bash <suite>` still reported 33/0, the
# inertness signature `integ-stale-base-detector.test.sh` records.

set -u

HOOK_DIR="${BASH_SOURCE[0]%/*}"
[ "$HOOK_DIR" = "${BASH_SOURCE[0]}" ] && HOOK_DIR="."
HOOK="$HOOK_DIR/broad-process-kill-gate.sh"
HOOK_BASH="${HOOK_BASH:-bash}"

pass=0
fail=0

# run <expected-rc> <label> <command-string>
run() {
  local want="$1" label="$2" cmd="$3" got
  printf '%s' "{\"tool_input\":{\"command\":$(printf '%s' "$cmd" | jq -Rs .)}}" \
    | "$HOOK_BASH" "$HOOK" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $label (want rc=$want, got rc=$got)"
  fi
}

# --- BLOCK: the measured shape and its near neighbours ---
run 2 'the measured incident' 'pkill -f vitest'
run 2 'quoted PATTERN (the verb itself is bare)' "pkill -f 'vitest'"
run 2 'double-quoted pattern' 'pkill -f "cdkd deploy"'
run 2 'no -f, bare process name' 'pkill node'
run 2 'killall' 'killall node'
run 2 'killall with a signal' 'killall -9 node'
run 2 'signal flag before the pattern' 'pkill -9 -f vitest'
# An ENGINE-PARITY case, not a spelling case. `gate_strip_prefix` strips a
# `<pattern>)` case-arm label, and it used to do so with an inline bracket
# expression whose escapes landed INSIDE the brackets. Measured: bash 5.x
# stripped the label here and 3.2 did not, so this exact payload was rc=2
# under 5.x and rc=0 -- fail-open -- under the version CI runs. The suite
# honours HOOK_BASH, so this case is the one that would have caught it.
run 2 'case-arm label written with an escaped paren' 'x\) pkill -f node'
run 2 'bare verb, no arguments at all' 'pkill'
run 2 'long signal flag' 'pkill --signal TERM -f vitest'
run 2 'user selector' 'pkill -u "$USER" -f vitest'
run 2 'parent selector' 'pkill -P 1234'
run 2 'killall -m' 'killall -m "node.*"'
run 2 'the macOS Docker restart is refused too' 'killall "Docker Desktop"'

# --- BLOCK: path-qualified command words (passed the first revision) ---
run 2 'absolute path' '/usr/bin/pkill -f vitest'
run 2 'absolute path, killall' '/usr/bin/killall node'
run 2 'relative path' './pkill -f x'

# --- BLOCK: every chained / prefixed spelling the matcher must reach ---
run 2 'after a leading cd' 'cd /repo && pkill -f vitest'
run 2 'after another command' 'vp test run && pkill -f vitest'
run 2 'after a semicolon' 'echo cleaning; pkill -f vitest'
run 2 'after a pipe' 'true | pkill -f vitest'
run 2 'sudo prefix' 'sudo pkill -f vitest'
run 2 'env-assignment prefix' 'FOO=1 pkill -f vitest'
run 2 'inside an if' 'if pkill -f vitest; then echo done; fi'
run 2 'inside a subshell' '(pkill -f vitest)'
run 2 'backgrounded' 'pkill -f vitest &'
run 2 'inside a command substitution' 'out=$(pkill -f vitest)'
run 2 'inside a for body' 'for i in 1 2; do pkill -f vitest; done'
run 2 'on its own line of a multi-line call' 'cd /repo
pkill -f vitest
echo done'
run 2 'not the first of two kills' 'kill 123 && killall node'

# --- PASS: LOOKUPS are reads, not kills (regression: these were REFUSED) ---
# `gate_strip_prefix` sheds `command` and its `-v`, so the bare verb match
# saw `pkill` and blocked a pure read. Each is paired with the control that
# proves the neutralisation did not blind the gate on the same line.
run 0 'command -v is a read' 'command -v pkill'
run 0 'command -v inside a substitution' 'echo "$(command -v pkill)"'
run 0 'which is a read' 'which pkill'
run 0 'type is a read' 'type pkill'
run 2 'CONTROL: a lookup does not blind a real kill after it' 'command -v pkill && pkill -f vitest'
run 2 'CONTROL: a lookup of an unrelated binary does not blind one either' 'type foo && pkill -f x'

# The blanker's OWN fence. A SUBSTITUTION is a command, never a lookup's
# argument, so it must not be eaten. The first cut's argument class
# `[^[:space:];|&)]+` swallowed `$(pkill` and left `-f vitest)`, so all four
# of these PASSED -- a bypass this hook CREATED (the pre-fix revision blocked
# them) and which the suite could not see, having no case in this shape. That
# is why the class now excludes `$`, `(` and a backtick, and why both
# polarities are pinned here rather than only the false-refusal one.
run 2 'a kill inside a lookup argument (command substitution)' 'echo type $(pkill -f vitest)'
run 2 'same, after a separator' 'true; type $(pkill -f vitest)'
run 2 'same, under command -v itself' 'command -v $(pkill -f vitest)'
run 2 'same, backtick substitution' 'echo type `pkill -f vitest`'
run 0 'CONTROL: a lookup of an ordinary binary still passes' 'command -v ls'

# --- PASS: the replacement this gate steers to ---
run 0 'pgrep is a READ' 'pgrep -laf vitest'
run 0 'pgrep already used by run-integ' "pgrep -f 'Docker Desktop' >/dev/null && echo app-running"
run 0 'kill by PID' 'kill 12345'
run 0 'kill -9 by PID' 'kill -9 12345'
run 0 'docker teardown by name' 'docker rm -f cdkd-local-task-abc'

# --- PASS: a longer command name is not this verb ---
run 0 'pkillsomething' 'pkillsomething --flag'
run 0 'killall5' 'killall5 -1'
run 0 'a path whose basename only STARTS with the verb' 'ls /opt/x/pkillers'
run 0 'a path whose basename only contains the word' 'ls /tmp/pkill-notes.txt'

# --- PASS: quoted / heredoc PROSE naming the verb ---
# This repo's own rule text and PR bodies name both commands; a gate that
# fired on them would refuse its own documentation.
run 0 'quoted in a gh body' 'gh issue create --body "a lane ran pkill -f vitest repo-wide"'
run 0 'quoted in an echo' 'echo "never run killall node here"'
run 0 'in a commit message' 'git commit -m "chore(hooks): refuse pkill and killall"'
run 0 'in a heredoc body' "git commit -F - <<'EOF'
chore(hooks): refuse pkill -f vitest
EOF"

# --- KNOWN LIMITS, each pinned WITH a control that discriminates ----------
# WITNESSES, not an enumeration. The passing set is UNBOUNDED and the hook
# header names the three MECHANISMS behind it (A: the command word is not
# the verb; B: the prefix is not on `gate_strip_prefix`'s allow-list; C: the
# hook never ran). These cases pin one or two witnesses per mechanism so a
# change that starts BLOCKING one reds here and the header is updated with
# it -- they do not claim to be the whole set, and four earlier revisions of
# that claim were each measured false. The control after each is a shape
# that DOES block, so no witness is a duplicate of a pass case elsewhere.
run 0 'LIMIT A: pgrep piped into xargs kill' 'pgrep -f vitest | xargs kill'
run 2 'control: the same pipeline ending in pkill IS caught' 'pgrep -f vitest | xargs pkill'
run 0 'LIMIT A: kill over a command substitution' 'kill $(pgrep -f vitest)'
run 0 'LIMIT A: ps | awk | xargs kill' "ps aux | grep vitest | awk '{print \$2}' | xargs kill -9"
run 0 'LIMIT A: a for loop over pgrep' 'for p in $(pgrep -f vitest); do kill -9 $p; done'
run 0 'LIMIT A: double-quoted command word' '"pkill" -f vitest'
run 0 'LIMIT A: single-quoted command word' "'pkill' -f vitest"
run 2 'control: the UNQUOTED twin IS caught' 'pkill -f vitest'
run 0 'LIMIT A: variable-indirected command word' 'K=pkill; $K -f x'
run 0 'LIMIT B: a prefix the stripper does not know (no flag needed)' 'nice pkill -f x'
run 0 'LIMIT B: another, to show it is a class and not an item' 'setsid pkill -f x'
run 0 'LIMIT B: a KNOWN prefix with an argument it cannot parse' 'sudo -u root pkill -f x'
run 2 'control: a prefix ON the allow-list IS caught' 'sudo pkill -f x'
run 2 'control: and so is another one' 'env pkill -f x'
run 0 'LIMIT A: eval' 'eval pkill -f x'
run 0 'LIMIT A: kill with a NEGATIVE pid, broader than the verb' 'kill -9 -1'
run 0 'LIMIT A: NON-SHELL interpreter' 'python3 -c "import os; os.system(\\"pkill -f x\\")"'
run 2 'control: a SHELL interpreter does NOT escape (double quotes)' 'bash -c "pkill -f vitest"'
run 2 'control: a SHELL interpreter does NOT escape (single quotes)' "sh -c 'killall node'"

# --- PASS: nothing to inspect ---
run 0 'empty command' ''

# --- FAIL CLOSED when the shared library is unreachable ---
# The header CLAIMS this; a claim nothing exercises is the defect class this
# repo keeps paying for. The PAYLOAD is one the hook would otherwise PASS --
# an earlier revision used `pkill -f vitest`, which exits 2 from the ordinary
# block path too, so the case stayed green with the fail-closed arm made
# unreachable. `echo hi` can only reach rc=2 through that arm. The hook is
# copied ALONE into a scratch dir so `lib/command-match.sh` genuinely does
# not resolve, and it is invoked through "$BASH" -- an unset PATH would
# otherwise kill the shell before the hook ran and the case would pass
# vacuously. The stderr text is asserted too, so the arm is identified and
# not merely counted.
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT INT TERM
cp "$HOOK" "$scratch/broad-process-kill-gate.sh"
fc_out=$(printf '%s' '{"tool_input":{"command":"echo hi"}}' \
  | "$BASH" "$scratch/broad-process-kill-gate.sh" 2>&1 >/dev/null)
fc_rc=$?
if [ "$fc_rc" = "2" ] && case "$fc_out" in *"cannot load lib/command-match.sh"*) true ;; *) false ;; esac then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL: no lib/command-match.sh must fail CLOSED with its own message (want rc=2 + message, got rc=$fc_rc, out=$fc_out)"
fi
# CONTROL: with the library present, that same payload passes -- so the case
# above cannot go green on a hook that refuses everything.
run 0 'CONTROL: the fail-closed payload PASSES with the library present' 'echo hi'

echo "Pass: $pass  Fail: $fail"
[ "$fail" = "0" ]
