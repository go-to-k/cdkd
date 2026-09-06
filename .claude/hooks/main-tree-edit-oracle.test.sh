#!/usr/bin/env bash
# main-tree-edit-gate vs REAL BASH: a differential oracle, not a case list.
#
# WHY THIS EXISTS. Review of go-to-k/cdkd#2650 found ten fail-opens across four
# rounds, each one inside the previous round's fix, and every one was a
# hand-written scan disagreeing with bash about what a command does.
# Hand-picked cases cannot close that class: they encode the same
# misunderstanding the code has. So this harness stops asking "does the gate
# agree with what I expected" and asks the only question that settles it:
#
#     The gate says this write is / is not in the protected tree.
#     BASH RAN IT. Was it?
#
# THE GRID'S DIMENSIONS ARE THE POINT, and the first version of this file got
# them wrong: it varied write vehicle x shell context x trailing `cd` and
# reported a clean run while FIVE live fail-opens sat in the dimensions it did
# not vary. It now crosses five, because every bug found so far has lived in an
# interaction rather than in a shape:
#
#   1. write vehicle   `>`  `>>`  `tee`  `tee -a`  `sed -i`
#   2. shell context   bare, `$( )`, backticks, `{ }`, `( )`, `bash -c`, `if`
#   3. trailing cd     none, absolute, subshell, escaped-space, substitution
#   4. PAYLOAD CWD     the main checkout AND a feature worktree -- the second
#                      is where a permissive answer is SILENT, and three
#                      fail-opens lived there unseen
#   5. COMMAND SIZE    under and over the gate's own byte bound, because the
#                      bound selects a different, cheaper analysis
#
# Each command is executed for real in a disposable sandbox with a fake
# `git`/`gh` on PATH, then the protected file is inspected. `tee` and `sed` are
# deliberately NOT stubbed -- they are write vehicles under test, and stubbing
# `tee` once made every tee row read "not written": a vacuous all-pass, the
# worst failure an oracle can have, which is why STEP 1 proves discrimination
# before any verdict counts.
#
# Latency is checked too: a hook killed by the 10s PreToolUse timeout cannot
# emit exit 2, so a slow gate is an absent gate. Two of the ten fail-opens were
# that.
#
# Run:  bash .claude/hooks/main-tree-edit-oracle.test.sh
# Point it at another revision with GATE_HOOK=<path> to settle
# "inherited or introduced?" by measurement instead of by argument.
set -u

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 1
HOOK="${GATE_HOOK:-.claude/hooks/main-tree-edit-gate.sh}"

# `HOOK_BASH=<path>` runs the HOOK under that interpreter too, not merely this
# suite. `run-tests.sh` already exports it alongside each shell it drives, and
# this file IGNORED it until 2026-09-07: the hook is `#!/usr/bin/env bash`, so a
# plain `"$HOOK_RUNNER" "$HOOK"` takes whatever comes first on PATH -- 5.x -- while the
# suite itself ran under 3.2. "Passes under bash 3.2" was therefore true of the
# test and false of the thing under test, and a regex whose two bash engines
# DISAGREE (`gate_strip_prefix`'s bracket expressions; see
# .claude/rules/hooks-class-fences.md) could only fail on a runner that has 3.2
# as both -- i.e. in CI, never here. Resolved ABSOLUTE because a bare name would
# find this shim itself and recurse.
HOOK_RUNNER="${HOOK_BASH:-bash}"
HOOK_RUNNER="$(command -v "$HOOK_RUNNER" 2>/dev/null || printf '%s' "$HOOK_RUNNER")"
case "$HOOK_RUNNER" in /*) ;; *) HOOK_RUNNER="$PWD/$HOOK_RUNNER" ;; esac
# A BOUND WITHOUT coreutils. `timeout(1)` is not on a stock macOS image, which
# is the only runner carrying bash 3.2 and therefore the one this whole suite
# exists to exercise -- so requiring it made the oracle fail there permanently.
# Refusing to run unbounded is still right (these are real commands), but the
# bound does not have to come from an external binary: run the command in the
# background, and have a watchdog kill it if it outlives the budget.
#
# `wait` returns the command's own status when it finished first, and 137 when
# the watchdog got there. Either way the caller only asks whether the protected
# file changed, so the status is not consulted -- what matters is that nothing
# is left running.
bounded_bash() { # <seconds> <command>
  local secs="$1" cmd="$2" pid watchdog
  bash -c "$cmd" >/dev/null 2>&1 &
  pid=$!
  ( sleep "$secs"; kill -9 "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  watchdog=$!
  wait "$pid" 2>/dev/null
  kill -9 "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  return 0
}

TIMEOUT_BIN=$(command -v timeout || command -v gtimeout || true)
if false; then
  # NOT a silent skip: an oracle that opts out is indistinguishable from one
  # that passes, so this is loud and non-zero.
  echo "not ok main-tree-edit-oracle: no timeout(1) binary; refusing to run commands unbounded"
  echo "  total: 1  fail: 1"
  exit 1
fi

PROT="docs/_generated/ledger.tsv"
SB=$(mktemp -d); FIX=$(mktemp -d)
trap 'rm -rf "$SB" "$FIX"' EXIT INT TERM

mkdir -p "$SB/bin"
for c in git gh cdk npx vp delstack; do
  printf '#!/bin/sh\nexit 0\n' > "$SB/bin/$c"; chmod +x "$SB/bin/$c"
done

MAIN="$FIX/main"
git init -q -b main "$MAIN"
mkdir -p "$MAIN/docs/_generated"
printf 'row\n' > "$MAIN/$PROT"
touch "$MAIN/.markgate.yml"
git -C "$MAIN" add -A >/dev/null 2>&1
git -C "$MAIN" -c user.email=t@t -c user.name=t commit -q -m init
WT="$MAIN/.claude/worktrees/oracle"
git -C "$MAIN" worktree add -q "$WT" -b oracle/probe >/dev/null 2>&1
mkdir -p "$WT/docs/_generated"

# Padding that pushes a command past the gate's byte bound without changing what
# it does. `: '<a...>'` is a no-op builtin with a quoted argument.
PAD=": '$(printf 'a%.0s' $(seq 1 33000))' ;"

WRITES=( "echo POISON > %s" "echo POISON >> %s" "echo POISON | tee %s"
         "echo POISON | tee -a %s" "sed -i.bak -e s/row/POISON/ %s" )
CONTEXTS=( '%s' 'x=$(%s)' 'x=`%s`' '{ %s ; }' '( %s )' 'bash -c "%s"' 'if true; then %s; fi' )
TAILS=( '' ' ; cd /tmp' ' ; ( cd /tmp )' ' ; cd\ /tmp' ' ; cd $(echo /tmp)' )

# --- STEP 1: prove the ORACLE discriminates --------------------------------
run_bash() { # <sandbox-cwd> <protected-file> <command> -> yes|no
  local dir="$1" prot="$2" cmd="$3"
  printf 'row\n' > "$prot"
  ( cd "$dir" && PATH="$SB/bin:/usr/bin:/bin" bounded_bash 5 "$cmd" ) >/dev/null 2>&1
  if [ -f "$prot" ] && [ "$(cat "$prot" 2>/dev/null)" != "row" ]; then echo yes; else echo no; fi
}
selfcheck_fail=0
check() { # <want> <command>
  local want="$1" cmd="$2" got
  got=$(run_bash "$MAIN" "$MAIN/$PROT" "$cmd")
  [ "$got" = "$want" ] && return 0
  echo "not ok oracle self-check: expected written=$want, got $got, for [$cmd]"
  selfcheck_fail=$((selfcheck_fail + 1))
}
check yes "echo POISON > $PROT"
check yes "echo POISON | tee $PROT"
check yes "sed -i.bak -e s/row/POISON/ $PROT"
check yes "x=\$(echo POISON > $PROT)"
check no  "echo POISON > elsewhere.txt"
check no  "true"
if [ "$selfcheck_fail" -ne 0 ]; then
  echo "  total: 6  fail: $selfcheck_fail"
  echo "the oracle cannot tell a write from a non-write; every verdict below would be vacuous" >&2
  exit 1
fi
echo "ok   oracle self-check: 6 hand-derived answers, all correct"

# --- STEP 2: gate verdict vs ground truth, across all five dimensions -------
open=0; block=0; n=0; slow=0
open_list=""; block_list=""; slow_list=""
probe() { # <gate payload cwd> <sandbox cwd> <command> <label> [latency-only]
  # LATENCY-ONLY probes are timed but not scored for verdict. Their inputs are
  # deliberately pathological -- 24000 unbalanced open parens is not valid bash,
  # so nothing runs and nothing is written, while the gate still sees a write
  # target and refuses. Counting that as a false block would put a permanent
  # tolerance of 1 on the fence, and a nonzero tolerance is how a REAL false
  # block later gets absorbed without anyone noticing.
  local pcwd="$1" scwd="$2" cmd="$3" label="$4" latonly="${5:-}" written rc t0 t1 ms
  n=$((n + 1))
  written=$(run_bash "$scwd" "$MAIN/$PROT" "$cmd")
  t0=$(date +%s)
  printf '%s' "$(jq -nc --arg c "$cmd" --arg w "$pcwd" \
    '{tool_name:"Bash",cwd:$w,tool_input:{command:$c}}')" | "$HOOK_RUNNER" "$HOOK" >/dev/null 2>&1
  rc=$?
  t1=$(date +%s); ms=$((t1 - t0))
  # 5s of a 10s PreToolUse timeout. Past the budget the hook is on its way to
  # being KILLED, and a killed hook cannot emit exit 2 -- the gate disappears.
  if [ "$ms" -gt 5 ]; then
    slow=$((slow + 1)); slow_list="${slow_list}    ${ms}s  $label"$'\n'
  fi
  [ -n "$latonly" ] && return 0
  if [ "$written" = yes ] && [ "$rc" != 2 ]; then
    open=$((open + 1)); open_list="${open_list}    rc=$rc  $label"$'\n'
  elif [ "$written" = no ] && [ "$rc" = 2 ]; then
    block=$((block + 1)); block_list="${block_list}    $label"$'\n'
  fi
}

# ARM A -- payload cwd = the main checkout, relative target, no padding.
for ctx in "${CONTEXTS[@]}"; do
  for wv in "${WRITES[@]}"; do
    # shellcheck disable=SC2059
    w=$(printf "$wv" "$PROT")
    # shellcheck disable=SC2059
    body=$(printf "$ctx" "$w")
    for t in "${TAILS[@]}"; do probe "$MAIN" "$MAIN" "$body$t" "$body$t"; done
  done
done
# ARM B -- payload cwd = a FEATURE WORKTREE, reaching into the main tree with a
# real `cd`. This is the polarity where a permissive answer is silent: the gate
# is not "on main", so nothing looks wrong. Three fail-opens lived here.
for wv in "${WRITES[@]}"; do
  # shellcheck disable=SC2059
  w=$(printf "$wv" "$PROT")
  probe "$WT" "$MAIN" "cd $MAIN && $w" "[wt] cd <main> && $w"
  probe "$WT" "$MAIN" "cd $MAIN && $w $(printf '; true %.0s' $(seq 1 210))" "[wt,210seg] cd <main> && $w"
  probe "$WT" "$MAIN" "$PAD cd $MAIN && $w" "[wt,padded] cd <main> && $w"
done
# ARM C -- OVER THE BYTE BOUND from the main checkout. Past it the gate selects
# a different, cheaper analysis, so every vehicle is re-run through it.
for wv in "${WRITES[@]}"; do
  # shellcheck disable=SC2059
  w=$(printf "$wv" "$PROT")
  probe "$MAIN" "$MAIN" "$PAD $w" "[padded] $w"
  probe "$MAIN" "$MAIN" "$PAD $w ; cd /tmp" "[padded] $w ; cd /tmp"
done
# ARM D -- a multi-line substitution whose body carries a quoted `)`. Its own
# arm because the line structure is the variable, not the vehicle.
probe "$MAIN" "$MAIN" "x=\$(echo 'a)b'
cd /tmp)
echo POISON > $PROT" "[multiline] quoted ) in a substitution, then a write"
# THREE MORE MULTI-LINE SHAPES, each found by a reviewer imagining it rather
# than by this grid -- which is the grid's own lesson arriving a second time.
# What they share is a CHILD-CONTEXT `cd` the line-joiner fails to recognise, so
# the body is emitted at mark 0 and its `cd` is honoured. The dimensions above
# vary the write and the context; these vary the SHAPE OF THE JOIN, which is a
# fourth axis the grid does not cross.
probe "$MAIN" "$MAIN" "cat <(
 cd /tmp
)
echo POISON > $PROT" "[multiline] process substitution spanning lines"
probe "$MAIN" "$MAIN" "x=\$(
  # note )
  cd /tmp
)
echo POISON > $PROT" "[multiline] a comment holding ) inside \$( )"
probe "$MAIN" "$MAIN" "( echo a\\)b ; cd /tmp) ; echo POISON > $PROT" \
  "[escape] a backslash-escaped ) inside a subshell"
# ARM E -- LATENCY ONLY: shapes whose cost is superlinear in ONE segment.
probe "$MAIN" "$MAIN" "$(printf 'A=1 %.0s' $(seq 1 8000))echo POISON > $PROT" "[latency] 8000 assignment prefixes" latency
probe "$MAIN" "$MAIN" "echo $(printf '(%.0s' $(seq 1 24000)) ; echo POISON > $PROT" "[latency] 24000 open parens" latency
probe "$MAIN" "$MAIN" "$(printf 'a;%.0s' $(seq 1 16000))echo POISON > $PROT" "[latency] 16000 tiny segments" latency

fail=0
report() { # <count> <max> <what> <list>
  if [ "$1" -gt "$2" ]; then
    fail=$((fail + 1)); printf 'not ok %s: %s (tolerated %s)\n' "$3" "$1" "$2"; printf '%s' "$4"
  else
    printf 'ok   %s: %s (tolerated %s)\n' "$3" "$1" "$2"
  fi
}
# AT THE OBSERVED COUNTS, no slack. This hook does carry inherited divergences
# (a `cd` into a nonexistent directory is honoured though bash stays put --
# go-to-k/cdkd#2684), but no shape in this grid reaches one, so tolerating a
# nonzero count would tolerate a NEW one.
report "$open"  "${ORACLE_FAIL_OPEN_MAX:-0}"   "FAIL-OPEN (bash wrote the protected file, gate allowed it)" "$open_list"
report "$block" "${ORACLE_FALSE_BLOCK_MAX:-0}" "false-block (nothing written, gate refused)" "$block_list"
report "$slow"  "${ORACLE_SLOW_MAX:-0}"        "over the 5s latency budget (10s PreToolUse timeout kills the hook)" "$slow_list"
# AT THE OBSERVED COUNT, no slack -- the same rule the tolerances above follow,
# which the first spelling of this floor did not: at 200 against 204 actual, the
# whole multi-line arm plus the latency arm could be deleted and the run stayed
# green. A floor with slack is how a corpus quietly stops covering a dimension.
if [ "$n" -lt 207 ]; then
  fail=$((fail + 1)); printf 'not ok corpus floor: %s inputs, expected at least 207\n' "$n"
else
  printf 'ok   corpus: %s executed commands across 5 dimensions\n' "$n"
fi
echo "  total: 4  fail: $fail"
[ "$fail" -eq 0 ]
