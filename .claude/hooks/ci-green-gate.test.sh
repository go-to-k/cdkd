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
  unresolvable-repo)
    # What `gh pr checks <n> -R <slug>` answers for a repo it cannot reach
    # (go-to-k/cdkd#3273): rc=1, message on STDERR, and NO tab-separated rows --
    # the shape the `not_green` awk reads as "nothing is red".
    echo "GraphQL: Could not resolve to a Repository with the name 'go-to-k/nope'." >&2
    exit 1 ;;
  hang)
    # A `gh` that never answers. SIGALRM-deaf like the real Go binary, so a
    # bound that does not FORK and signal would not stop it -- the property
    # `gate_bounded`'s own comment records. Measured against a real unroutable
    # host, `gh pr checks <n> -R 10.255.255.1/o/r` takes 30 s, past this hook's
    # registered 20 s timeout; the fixture is that, deterministically.
    exec perl -e '$SIG{ALRM} = "IGNORE"; sleep 60;' ;;
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

# =====================================================================
# WHICH REPOSITORY the gate asked about (go-to-k/cdkd#3273)
# =====================================================================
#
# The block above pins the PR NUMBER; this one pins the REPO, and the two are
# independent facts about the same question. A PR number alone names nothing --
# 42 exists in every repository -- so until go-to-k/cdkd#3273 this gate asked
# `gh pr checks 42` with no `-R` and judged whatever repo the SHELL was in. An
# exit code cannot tell that apart from the gate working, which is exactly why
# it survived: every case above is satisfied by a wrong-repo answer.
#
# The shim already records its argv for the number half; these read the `-R`
# out of the same trace. Each `-R <slug>` row fails against the pre-#3273 hook
# (trace `pr checks 2195`, no `-R`); the FIRST row is the control that says a
# command naming no repo still asks cwd-relative, so the fix is a forward and
# not a blanket `-R`.
want_pr_repo() { # <name> <command> <expected slug, or "" for none>
  local name="$1" command="$2" want="$3" payload got
  : > "$ARGV_TRACE"
  payload=$(printf '{"tool_input":{"command":%s},"cwd":"%s"}' \
    "$(printf '%s' "$command" | jq -Rs .)" "$REPO_ROOT")
  printf '%s' "$payload" | ARGV_TRACE="$ARGV_TRACE" PATH="$SHIM_DIR/argv-bin:$PATH" \
    bash "$HOOK" >/dev/null 2>&1
  got=$(sed -n 's/.*-R \([^ ][^ ]*\).*/\1/p' "$ARGV_TRACE" | head -1)
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    fail_log="$fail_log
  FAIL: $name (gate asked gh about repo '$got', expected '$want'; trace: $(tr '\n' '|' < "$ARGV_TRACE"))"
  fi
}

want_pr_repo "no repo named: the query stays cwd-relative (control)" \
  "gh pr merge 2195 --squash" ""
want_pr_repo "post-verb -R is forwarded" \
  "gh pr merge 2195 -R go-to-k/cdk-local --squash" "go-to-k/cdk-local"
want_pr_repo "post-verb --repo is forwarded" \
  "gh pr merge 2195 --repo go-to-k/cdk-local" "go-to-k/cdk-local"
want_pr_repo "left-slot -R is forwarded" \
  "gh -R go-to-k/cdk-local pr merge 2195" "go-to-k/cdk-local"
want_pr_repo "between-slot -R is forwarded" \
  "gh pr -R go-to-k/cdk-local merge 2195" "go-to-k/cdk-local"
want_pr_repo "between-slot --repo=value is forwarded" \
  "gh pr --repo=go-to-k/cdk-local merge 2195" "go-to-k/cdk-local"
want_pr_repo "between-slot glued -R is forwarded" \
  "gh pr -Rgo-to-k/cdk-local merge 2195" "go-to-k/cdk-local"
want_pr_repo "a quoted slug is forwarded unquoted" \
  'gh pr merge 2195 -R "go-to-k/cdk-local"' "go-to-k/cdk-local"
# ...and the NEGATIVE: a slug-looking string inside a quoted ARGUMENT is not a
# repo. Without this the rows above are satisfied by a scan that greps the raw
# command for `-R`.
want_pr_repo "a -R inside a quoted argument body is not a repo" \
  'gh pr merge 2195 --subject "merge -R fake/repo"' ""

# AN UNREADABLE SLUG REFUSES, and asks gh NOTHING. Falling back to the cwd repo
# there would be the #3273 defect with an extra step, so the assertion is on
# BOTH observables: exit 2, and an EMPTY argv trace. An exit-code-only case
# would pass against a hook that queried the wrong repo and happened to find it
# red, which is how this class hides.
unreadable_refuses() { # <name> <command>
  local name="$1" command="$2" payload rc trace
  : > "$ARGV_TRACE"
  payload=$(printf '{"tool_input":{"command":%s},"cwd":"%s"}' \
    "$(printf '%s' "$command" | jq -Rs .)" "$REPO_ROOT")
  printf '%s' "$payload" | ARGV_TRACE="$ARGV_TRACE" PATH="$SHIM_DIR/argv-bin:$PATH" \
    bash "$HOOK" >/dev/null 2>&1
  rc=$?
  trace=$(tr -d '\n' < "$ARGV_TRACE")
  if [ "$rc" -eq 2 ] && [ -z "$trace" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    fail_log="$fail_log
  FAIL: $name (rc=$rc, trace='$trace'; wanted rc=2 and no gh call)"
  fi
}
unreadable_refuses "an unexpanded \$VAR slug refuses" 'gh pr merge 2195 -R "$SLUG" --squash'
unreadable_refuses "a bare \$VAR slug refuses" 'gh pr merge 2195 -R $SLUG'
unreadable_refuses "a substitution slug refuses" 'gh pr merge 2195 -R $(cat /tmp/slug)'
unreadable_refuses "a trailing -R with no value refuses" 'gh pr merge 2195 --squash -R'

# TWO DIFFERENT REPOS NAMED IN ONE COMMAND (go-to-k/cdkd#3273 review). The first
# implementation returned on the FIRST `-R` it found; `gh` takes the LAST
# (measured on 2.92.0 in three slot orders). So `gh pr merge 42 -R <this repo>
# -R <other repo>` asked about THIS repo and cleared a merge in the other one --
# the very defect go-to-k/cdkd#3273 is about, reproduced by its fix. The walk
# runs to the end of the segment now and REFUSES two distinct slugs rather than
# mirroring gh's precedence, so a change in that precedence cannot silently
# re-open it. Asserted on rc=2 AND an empty trace: answering about either repo
# would be a wrong answer, so the gate must ask about NEITHER.
unreadable_refuses "two DIFFERENT slugs refuse (post-verb)" \
  'gh pr merge 2195 -R go-to-k/cdkd -R go-to-k/cdk-local --squash'
unreadable_refuses "two DIFFERENT slugs refuse (left slot + post-verb)" \
  'gh -R go-to-k/cdkd pr merge 2195 -R go-to-k/cdk-local'
unreadable_refuses "two DIFFERENT slugs refuse (between slot + post-verb)" \
  'gh pr -R go-to-k/cdkd merge 2195 --repo go-to-k/cdk-local'
# ...and the OTHER direction, which is what keeps that refusal from being a
# blanket "more than one -R": two IDENTICAL slugs are not ambiguous and must
# behave exactly like one.
want_pr_repo "two IDENTICAL slugs forward once, they do not refuse" \
  "gh pr merge 2195 -R go-to-k/cdk-local -R go-to-k/cdk-local --squash" "go-to-k/cdk-local"

# A TRAILING COMMENT IS NOT A REPOSITORY (go-to-k/cdkd#3273 review). The slug
# walk tokenised the raw segment, so the apostrophe inside a `#` comment opened
# a quote, the split truncated, and the truncation was reported as "this command
# names a repository with -R" -- a false refusal whose message is a lie, on a
# command carrying no `-R` at all. `gate_strip_comment` runs first now. The
# apostrophe is the discriminator: without it the tokeniser never truncates.
want_pr_repo "a trailing comment with an apostrophe is not a repo" \
  "gh pr merge 2195 --squash # don't wait for the flaky one" ""
want_pr_repo "a trailing comment naming -R is still not a repo" \
  "gh pr merge 2195 --squash # use -R go-to-k/cdk-local next time" ""

# THE FAIL-OPEN ENDS AT A NAMED REPO. `gh pr checks` against an unreachable
# slug answers rc=1 with its message on STDERR and NO tab-separated rows, which
# the `not_green` awk reads as "nothing is red" -- so without this the forward
# would have turned a wrong ANSWER into a silent PASS. Both shapes are covered:
# rc>1 (transport) and rc=1-with-no-rows (unresolvable repo). The
# `unresolvable-repo` fixture lives in the ONE shim at the top of this file --
# a second copy of it here is how two shims drift into disagreeing about what
# `gh` does.
run_case "unresolvable repo with -R blocks" unresolvable-repo \
  "gh pr merge 123 -R go-to-k/nope --squash" 2
run_case "transport error WITH -R blocks (no infra fail-open)" infra-error \
  "gh pr merge 123 -R go-to-k/cdk-local --squash" 2
# ...and the two CONTROLS that keep the change narrow: with no `-R` both of
# those states behave exactly as they did before. The second is the one that
# matters — the infra fail-open is deliberate and must survive.
run_case "unresolvable-repo TEXT without -R still passes (unchanged)" unresolvable-repo \
  "gh pr merge 123 --squash" 0
run_case "transport error without -R still fails open (unchanged)" infra-error \
  "gh pr merge 123 --squash" 0
# ...and a GREEN answer for a named repo still passes, so the two blocks above
# are about the FAILURE and not about `-R` itself.
run_case "all checks pass for a named repo" all-pass \
  "gh pr merge 123 -R go-to-k/cdk-local --squash" 0
run_case "a red check in a named repo blocks, as it does locally" one-fail \
  "gh pr merge 123 -R go-to-k/cdk-local --squash" 2
# The documented bypass must still clear a named-repo failure, or a repo with
# genuinely no CI becomes unmergeable from anywhere.
run_case "CDKD_SKIP_CI_GREEN_GATE=1 clears a named-repo failure" unresolvable-repo \
  "CDKD_SKIP_CI_GREEN_GATE=1 gh pr merge 123 -R go-to-k/nope --squash" 0

# --- THE CALL IS BOUNDED (go-to-k/cdkd#3273 review) ----------------------
#
# An unbounded `gh` here is not slowness, it is the gate DISAPPEARING: a hook
# killed by its registered timeout emits no exit 2, which propagates as a
# non-blocking error. Before the slug forwarding nothing in the command text
# chose what `gh` talked to; now it does, so the bound is load-bearing.
#
# These three cost ~6 s each (the bound). That is the price of measuring a
# TIMEOUT: no faster fixture exhibits one, and asserting the bound by its
# outcome is impossible — a hung `gh` and a bounded one differ only in elapsed
# time and rc. The first two also pin the DIRECTION: with a slug named a
# timeout refuses; with none it keeps today's infra fail-open.
run_case "a hung gh WITH -R blocks (no infra fail-open on a timeout)" hang \
  "gh pr merge 123 -R go-to-k/cdk-local --squash" 2
run_case "a hung gh WITHOUT -R still fails open" hang \
  "gh pr merge 123 --squash" 0
# ...and the bound must actually BIND. Without `gate_bounded` the shim sleeps
# 60 s and this case takes 60 s instead of ~6 s; the harness has no per-case
# timeout, so the elapsed time is asserted explicitly or nothing here can tell
# a bounded call from an unbounded one.
__t0=$(date +%s)
printf '{"tool_input":{"command":"gh pr merge 123 -R go-to-k/cdk-local"},"cwd":"%s"}' "$REPO_ROOT" \
  | GH_FIXTURE=hang PATH="$SHIM_DIR:$PATH" bash "$HOOK" >/dev/null 2>&1
__t1=$(date +%s)
if [ "$((__t1 - __t0))" -le 15 ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  fail_log="$fail_log
  FAIL: the gh call is NOT bounded (took $((__t1 - __t0))s; the bound is 6s)"
fi

# --- THE PERL-ABSENT ARM MUST HONOUR `GATE_BOUNDED_KEEP_STDERR` ---------
#
# `gate_bounded` degrades to running the command unbounded when perl is not on
# PATH, and that arm hardcoded `"$@" 2>/dev/null`. This gate reads "no checks
# reported" off gh's STDERR, so with perl missing the discriminator vanished:
# stdout empty, rc=1, `not_green` empty -- PASS. A fail-open caused by a MISSING
# INTERPRETER, which is the shape `.claude/rules/hooks.md` refuses.
#
# The fixture is a PATH with no perl AND no system directories, so
# `command -v perl` genuinely fails; the shim dir supplies `gh`, and the hook's
# other externals (`jq`, `git`, `awk`) come from the real PATH entries kept
# below. Measured before the fix: rc=0. After: rc=2 naming the no-checks state.
NOPERL_DIR="$SHIM_DIR/noperl"
mkdir -p "$NOPERL_DIR"
cp "$SHIM_DIR/gh" "$NOPERL_DIR/gh"
for __b in env bash sh jq git awk sed grep tr head tail wc cat date mktemp dirname basename cut sort uniq; do
  __p=$(command -v "$__b" 2>/dev/null) || continue
  ln -sf "$__p" "$NOPERL_DIR/$__b" 2>/dev/null || true
done
noperl_case() { # <name> <fixture> <command> <expected rc>
  local name="$1" fixture="$2" command="$3" want="$4" payload rc
  payload=$(printf '{"tool_input":{"command":%s},"cwd":"%s"}' \
    "$(printf '%s' "$command" | jq -Rs .)" "$REPO_ROOT")
  printf '%s' "$payload" | GH_FIXTURE="$fixture" PATH="$NOPERL_DIR" \
    bash "$HOOK" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    fail_log="$fail_log
  FAIL: $name (expected rc=$want, got rc=$rc)"
  fi
}
# Confirm the fixture really reaches the degraded arm before trusting its
# verdict -- a PATH that still finds perl would make every case below vacuous.
if PATH="$NOPERL_DIR" command -v perl >/dev/null 2>&1; then
  fail=$((fail + 1))
  fail_log="$fail_log
  FAIL: the no-perl fixture still resolves perl, so its cases prove nothing"
else
  pass=$((pass + 1))
fi
noperl_case "no-perl + no checks reported still BLOCKS" no-checks \
  "gh pr merge 123 --squash" 2
noperl_case "no-perl + a red check still BLOCKS" one-fail \
  "gh pr merge 123 --squash" 2
noperl_case "no-perl + all green still passes (the degraded arm is not a blanket refusal)" all-pass \
  "gh pr merge 123 --squash" 0

echo "ci-green-gate.test: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  echo "$fail_log"
  exit 1
fi
exit 0
