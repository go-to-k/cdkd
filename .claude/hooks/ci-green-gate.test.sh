#!/usr/bin/env bash
# Smoke test for ci-green-gate.sh.
#
# Exercises the live CI-status gate against a PATH-shimmed `gh`
# binary. Each case sets $GH_FIXTURE to control what `gh pr checks`
# returns (all-pass / fail / pending / skipping / no-checks / infra
# error), then asserts the hook's exit code matches the expected gate
# decision. Includes the standard quoted-body false-positive cases
# (cdkd#563) proving the matcher is line-start anchored.
#
# Run from the repo root: `bash .claude/hooks/ci-green-gate.test.sh`.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci-green-gate.sh"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

SHIM_DIR="$(mktemp -d)"
cleanup() { rm -rf "$SHIM_DIR"; }
trap cleanup EXIT

pass=0
fail=0
fail_log=""

cat > "$SHIM_DIR/gh" <<'EOF_GH'
#!/usr/bin/env bash
set -u
case "${GH_FIXTURE:-}" in
  all-pass)
    printf 'check\tpass\t3s\thttps://x\n'
    printf 'check-build-test\tpass\t3m\thttps://x\n'
    exit 0 ;;
  with-skipping)
    printf 'check\tpass\t3s\thttps://x\n'
    printf 'runtime-compat\tskipping\t0\thttps://x\n'
    exit 1 ;;
  one-fail)
    printf 'check\tpass\t3s\thttps://x\n'
    printf 'check-build-test\tfail\t2m30s\thttps://x\n'
    exit 1 ;;
  pending)
    printf 'check-build-test\tpending\t0\thttps://x\n'
    exit 8 ;;
  no-checks)
    echo "no checks reported on the 'foo' branch" >&2
    exit 1 ;;
  infra-error)
    echo "error connecting to api.github.com" >&2
    exit 4 ;;
  *)
    echo "gh shim: unknown fixture '${GH_FIXTURE:-}'" >&2
    exit 99 ;;
esac
EOF_GH
chmod +x "$SHIM_DIR/gh"

run_case() {
  local name="$1" fixture="$2" command="$3" expected_rc="$4"
  local payload rc
  payload=$(printf '{"tool_input":{"command":%s},"cwd":"%s"}' \
    "$(printf '%s' "$command" | jq -Rs .)" "$REPO_ROOT")
  printf '%s' "$payload" | GH_FIXTURE="$fixture" PATH="$SHIM_DIR:$PATH" bash "$HOOK" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq "$expected_rc" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    fail_log="$fail_log
  FAIL: $name (expected rc=$expected_rc, got rc=$rc)"
  fi
}

# Green paths — allow.
run_case "all checks pass" all-pass "gh pr merge 123 --squash --delete-branch" 0
run_case "skipping rows are green" with-skipping "gh pr merge 123 --squash" 0
run_case "cd-prefixed merge, all pass" all-pass "cd $REPO_ROOT && gh pr merge 123 --squash" 0

# Red / unsettled paths — block (exit 2).
run_case "one failing check blocks" one-fail "gh pr merge 123 --squash" 2
run_case "pending check blocks" pending "gh pr merge 123" 2
run_case "no checks reported blocks" no-checks "gh pr merge 123" 2
run_case "number-less merge with fail blocks" one-fail "gh pr merge --squash" 2

# Infra fail-open.
run_case "gh transport error fails open" infra-error "gh pr merge 123" 0

# Escape hatch.
run_case "CDKD_SKIP_CI_GREEN_GATE=1 bypasses" one-fail "CDKD_SKIP_CI_GREEN_GATE=1 gh pr merge 123 --squash" 0

# Non-merge commands pass through untouched (no gh call at all).
run_case "unrelated command passes" one-fail "git status" 0
run_case "gh pr create passes" one-fail "gh pr create --title x" 0

# Quoted-body false positives (cdkd#563): the trigger phrase inside an
# argument body must NOT fire the gate.
run_case "quoted body in issue create" one-fail "gh issue create --body \"remember to gh pr merge 123 later\"" 0
run_case "quoted body in echo" one-fail "echo \"next step: gh pr merge 123\"" 0

# A FLAG BETWEEN `pr` AND THE VERB (go-to-k/cdkd#3242). `gh` resolves the repo
# from either slot, and this gate saw only the left one, so the whole CI-green
# requirement was dropped by moving `-R` three words to the right. These block
# against the fixed library and pass (rc=0) against the pre-#3242 one, which is
# what makes them cases rather than decoration. The FAMILY of the defect is
# fenced in lib/command-match.test.sh; what these add is that THIS gate consults
# that pattern, which a library-level case cannot say.
run_case "flag between pr and merge, short" one-fail "gh pr -R go-to-k/cdkd merge 123 --squash" 2
run_case "flag between pr and merge, long" one-fail "gh pr --repo go-to-k/cdkd merge 123 --squash" 2
run_case "flag between pr and merge, glued" one-fail "gh pr -Rgo-to-k/cdkd merge 123 --squash" 2
run_case "flag between pr and merge, =value" one-fail "gh pr --repo=go-to-k/cdkd merge 123 --squash" 2
# POLARITY: a READ verb under the same spelling must still pass untouched.
run_case "flag between pr and a read verb passes" one-fail "gh pr -R go-to-k/cdkd view 123" 0
run_case "flag between pr and list passes" one-fail "gh pr --repo=go-to-k/cdkd list" 0

# WHICH PR the gate asked about, not just that it refused. An exit code cannot
# say: `gate_pr_selector` reads the number from the span AFTER the matched verb,
# so a widened verb pattern that swallows one token too many or too few resolves
# a DIFFERENT PR and judges an unrelated CI run (go-to-k/cdkd#2129 measured
# exactly that -- `sleep 30 && gh -R … pr merge 2195` was judged as PR #30). The
# shim above ignores its argv and therefore cannot see it, so this arm records
# argv instead.
ARGV_TRACE="$SHIM_DIR/argv-trace"
mkdir -p "$SHIM_DIR/argv-bin"
cat > "$SHIM_DIR/argv-bin/gh" <<'EOF_ARGV'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${ARGV_TRACE:?}"
printf 'check\tfail\t1s\thttps://x\n'
exit 1
EOF_ARGV
chmod +x "$SHIM_DIR/argv-bin/gh"

want_pr_number() { # <name> <command> <expected number>
  local name="$1" command="$2" want="$3" payload got
  : > "$ARGV_TRACE"
  payload=$(printf '{"tool_input":{"command":%s},"cwd":"%s"}' \
    "$(printf '%s' "$command" | jq -Rs .)" "$REPO_ROOT")
  printf '%s' "$payload" | ARGV_TRACE="$ARGV_TRACE" PATH="$SHIM_DIR/argv-bin:$PATH" \
    bash "$HOOK" >/dev/null 2>&1
  # The number the gate asked `gh pr checks` about.
  got=$(sed -n 's/.*checks[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$ARGV_TRACE" | head -1)
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    fail_log="$fail_log
  FAIL: $name (gate asked gh about PR '$got', expected '$want'; trace: $(tr '\n' '|' < "$ARGV_TRACE"))"
  fi
}

want_pr_number "unshifted spelling resolves its own PR (control)" "gh pr merge 2195 --squash" 2195
want_pr_number "left-slot flag resolves its own PR (control)" "gh -R go-to-k/cdkd pr merge 2195 --squash" 2195
want_pr_number "flag between pr and merge resolves its own PR" "gh pr -R go-to-k/cdkd merge 2195 --squash" 2195
want_pr_number "two flags between pr and merge resolve its own PR" "gh pr -R go-to-k/cdkd --json number merge 2195" 2195
want_pr_number "glued flag between pr and merge resolves its own PR" "gh pr -Rgo-to-k/cdkd merge 2195 --squash" 2195
# A DECOY NUMBER, which is what makes this block discriminate the go-to-k/cdkd#2129
# class rather than merely observe it. Every row above carries exactly ONE number,
# so a hook that gave up and took the first digits in the command would still
# answer 2195 and pass: measured (go-to-k/cdkd#3242 test review) by rewriting the
# hook's selector to `grep -oE '[0-9]+' | head -1`, the block stayed 33/33 green.
# With an earlier number in the flag VALUE the same mutant asks gh about PR 30 --
# an unrelated PR's CI deciding this merge, which is #2129 exactly.
want_pr_number "a number in a between-slot flag value is not the PR" \
  "gh pr -R go-to-k/cdkd --limit 30 merge 2195 --squash" 2195
want_pr_number "a number in a LEFT-slot flag value is not the PR either" \
  "gh -R go-to-k/cdkd --limit 30 pr merge 2195 --squash" 2195

# --- The ADVICE the no-checks branch prints must itself discriminate (#2630) ---
#
# The retired text told the agent to poll `gh pr checks --json name,state`
# until it returned something other than `[]`. `gh` never returns `[]`: with no
# checks it exits 1 with an EMPTY stdout and a message on stderr. Measured
# 2026-09-06 (gh 2.89) across all four states. The `no-checks`, `one-fail`,
# `pending` and `all-pass` fixtures above match those measurements; nothing
# here claims the shim is faithful in EVERY respect (`with-skipping`'s rc is
# unverified, and a live PR's rc moves as its checks progress — two readings of
# the same PR minutes apart disagreed). The four that the cases below depend on
# are the ones that were measured:
#
#   no checks reported  rc=1  stdout 0 bytes   message on STDERR
#   a check FAILED      rc=1  stdout non-empty
#   still running       rc=8  stdout non-empty
#   all pass            rc=0  stdout non-empty
#
# So rc=1 is AMBIGUOUS and the discriminator is the empty stdout. These cases
# run the advised predicate itself against the shim, rather than asserting the
# message's wording — a wording test would keep passing if `gh` changed.
# The cases below drive a predicate this FILE defines, which pins the SHAPE of
# the advice but reads nothing the hook prints — measured: reverting the hook's
# advice to the retired `[]` form, or replacing it with nonsense, left this
# suite 18/18 green. So the hook's own stderr is asserted first, and the
# predicate cases are what explain WHY that text is the right text.
check_message() {
  local name="$1" needle="$2" want="$3"   # want = present | absent
  local payload out got
  payload=$(printf '{"tool_input":{"command":"gh pr merge 123 --squash"},"cwd":"%s"}' "$REPO_ROOT")
  out=$(printf '%s' "$payload" | GH_FIXTURE=no-checks PATH="$SHIM_DIR:$PATH" bash "$HOOK" 2>&1)
  case "$out" in (*"$needle"*) got=present ;; (*) got=absent ;; esac
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    fail_log="$fail_log
  FAIL: $name (expected $want, got $got)"
  fi
}

# The advice must be PRINTED, not executed. `cat >&2 <<EOF` is an UNQUOTED
# heredoc, so an unescaped `$( )` in the body runs at refusal time: the block
# then shows `until [ -n "" ]` — an unconditional infinite loop, i.e. exactly
# the hot-spin #2630 removes — and fires a second live `gh` call from inside a
# PreToolUse hook. Asserting the literal is what catches that.
check_message "advice prints the stdout-keyed poll" 'out=$(gh pr checks 123 2>/dev/null); rc=$?' present
check_message "advice keeps its rc-1 disambiguation" '[ "$rc" = 1 ] || {' present
check_message "advice no longer names the retired []" '[] = not registered yet' absent
# The shape the unescaped heredoc produces. Distinct from the assertions above:
# those reds if the text is REMOVED, this one reds if it is EXECUTED.
check_message "advice was not expanded by the heredoc" 'until [ -n "" ]' absent

advice_says_registered() {
  # The predicate the hook now prints, verbatim in shape.
  [ -n "$(GH_FIXTURE="$1" PATH="$SHIM_DIR:$PATH" gh pr checks 123 2>/dev/null)" ]
}

check_advice() {
  local name="$1" fixture="$2" expect="$3"
  if advice_says_registered "$fixture"; then got=registered; else got=absent; fi
  if [ "$got" = "$expect" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    fail_log="$fail_log
  FAIL: $name (expected $expect, got $got)"
  fi
}

check_advice "advice: no-checks reads as ABSENT" no-checks absent
# The three that must all read as REGISTERED. `one-fail` is the load-bearing
# one: it shares rc=1 with no-checks, so a predicate keyed on the exit code
# would report it absent and the advised loop would spin forever on a PR whose
# checks had already run and failed.
check_advice "advice: a failing check reads as REGISTERED" one-fail registered
check_advice "advice: a pending check reads as REGISTERED" pending registered
check_advice "advice: all-pass reads as REGISTERED" all-pass registered

# Guard-the-guard: the retired predicate must FAIL this suite, or the four
# cases above would pass under the very advice #2630 retired.
retired_says_registered() {
  [ "$(GH_FIXTURE="$1" PATH="$SHIM_DIR:$PATH" gh pr checks 123 2>/dev/null)" != "[]" ]
}
if retired_says_registered no-checks; then
  pass=$((pass + 1))   # retired form calls an EMPTY answer "registered" -> it never waits
else
  fail=$((fail + 1))
  fail_log="$fail_log
  FAIL: guard-the-guard expected the retired []-predicate to misread no-checks"
fi

echo "ci-green-gate.test: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  echo "$fail_log"
  exit 1
fi
exit 0
