#!/usr/bin/env bash
# command-match-mutants.test.sh -- the SHARD SELECTOR of the mutation harness.
#
# WHY THIS FILE EXISTS. `command-match-mutants.sh` is itself an instrument, so
# it had no suite: nothing in `lib/` tests the tester. That held while its only
# input was a mutant name. It stopped holding when `.github/workflows/hooks.yml`
# began driving it with `CDKD_MUTANT_SHARD=<index>/<total>` across four parallel
# jobs, because the selector can now fail in the one direction the harness
# exists to remove -- running FEWER mutants than it reports and exiting 0.
#
# That is not hypothetical. Code review round 32 measured `0/08` reaching
# `$((_sh_k % 08))`, which bash treats as an OCTAL literal error and which
# ABORTS the enclosing `if` compound rather than returning non-zero: the
# selection never happened, all mutants ran, one stderr line was the only
# trace, and the script exited 0. A CI matrix typo would have bought back the
# 60-minute cancellation the sharding was added to fix, and nothing in-tree
# would have said so.
#
# WHAT IS ASSERTED, and the split is deliberate:
#
# * EXACT COVER of the default roster -- the four shards together select every
#   mutant exactly once. This is the property the workflow's correctness rests
#   on, and it is the one no per-shard run can see: a shard that silently drops
#   its residue still prints a clean tally.
# * Every REFUSAL exits 2, including the two numeric shapes (`0/08`, `0/010`)
#   that a `case` pattern alone accepts.
# * The selection is derived WITHOUT running a suite. Each case reads the
#   selector's own `shard <spec>: N of M mutants` line, so this file costs
#   seconds rather than the hours a real matrix takes; the harness prints that
#   line before the first mutant precisely so this is possible.
#
# The suite name ends in `.test.sh` so `run-tests.sh`'s `lib/*.test.sh` glob
# picks it up -- the harness itself is NOT picked up by that glob (it is driven
# by its own CI job), which is why the selector was unfenced in the first
# place.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="$HERE/command-match-mutants.sh"
SHELL_UNDER_TEST="${HOOK_BASH:-bash}"

pass=0
fail=0
fail_log=""

# The roster the workflow shards. Read from the harness's own default rather
# than restated: a copy here would drift the moment a mutant is added, and the
# exact-cover assertion below would then be checking this file against itself.
ROSTER=$("$SHELL_UNDER_TEST" -c '
  s=$(sed -n "s/^MUTANTS=\"\${\*:-\(.*\)}\"$/\1/p" "$1" | head -1)
  printf "%s" "$s"' _ "$HARNESS")
ROSTER_N=$(printf '%s' "$ROSTER" | wc -w | tr -d ' ')

ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
ng() {
  fail=$((fail + 1))
  printf 'not ok %s\n' "$1"
  fail_log="${fail_log}not ok $1\n  $2\n"
}

# `shard <spec>: N of M mutants` off the harness's own stderr/stdout, WITHOUT
# running a suite: an explicit single mutant keeps the baseline to one run, and
# the refusal cases exit before any suite at all.
selection() { # <spec> [mutant ...] -> prints the selected names, one per line
  CDKD_MUTANT_SHARD="$1" "$SHELL_UNDER_TEST" "$HARNESS" --list-shard "${@:2}" 2>/dev/null
}

refusal_rc() { # <spec> -> the harness's exit code for a spec it must refuse
  CDKD_MUTANT_SHARD="$1" "$SHELL_UNDER_TEST" "$HARNESS" --list-shard >/dev/null 2>&1
  printf '%s' "$?"
}

# --- EXACT COVER -----------------------------------------------------------
# The union of the four shards must be the roster, with no name twice. Both
# halves matter and they fail differently: a missing name is coverage silently
# gone, a duplicated one is wasted CI minutes that look like coverage.
union=""
for i in 0 1 2 3; do
  sel=$(selection "$i/4")
  n=$(printf '%s\n' "$sel" | grep -c . | tr -d ' ')
  if [ "$n" -gt 0 ]; then
    ok "shard $i/4 selects $n of $ROSTER_N mutants"
  else
    ng "shard $i/4 selects nothing" "a shard that selects nothing reports a green over no measurement"
  fi
  union="$union$(printf '%s\n' "$sel" | grep .)
"
done
union_sorted=$(printf '%s' "$union" | grep -c . | tr -d ' ')
if [ "$union_sorted" = "$ROSTER_N" ]; then
  ok "the four shards select $ROSTER_N names in total, the roster's own count"
else
  ng "the four shards select $union_sorted names, roster is $ROSTER_N" \
    "a shortfall is coverage silently dropped; an excess is a mutant run twice"
fi
dupes=$(printf '%s' "$union" | grep . | LC_ALL=C sort | uniq -d | wc -l | tr -d ' ')
if [ "$dupes" = 0 ]; then
  ok "no mutant is selected by two shards"
else
  ng "$dupes mutant(s) selected by more than one shard" "strided selection must partition"
fi
missing=$(
  printf '%s\n' $ROSTER | LC_ALL=C sort > "$HERE/.mutants-roster.$$"
  printf '%s' "$union" | grep . | LC_ALL=C sort | LC_ALL=C comm -23 "$HERE/.mutants-roster.$$" -
  rm -f "$HERE/.mutants-roster.$$"
)
if [ -z "$missing" ]; then
  ok "every roster mutant lands in exactly one shard"
else
  ng "shards omit: $(printf '%s' "$missing" | tr '\n' ' ')" \
    "these mutants would never run in CI while every shard reported clean"
fi

# --- REFUSALS --------------------------------------------------------------
# A spec the selector cannot read must exit 2, never fall through to a full
# run. `0/08` and `0/010` are the two that a `case` pattern accepts and bash
# arithmetic does not: they are what round 32 measured going green over the
# whole roster.
for spec in abc 0 /4 4/ 1/2/3 -1/4 0/0 4/4 5/4 0/08 0/010; do
  rc=$(refusal_rc "$spec")
  case "$spec" in
    0/08|0/010)
      # These two are VALID once read in base 10 -- the assertion is that they
      # are read that way rather than aborting the block. `0/08` is shard 0 of
      # 8 and `0/010` shard 0 of 10, so both must SELECT, not refuse.
      sel=$(selection "$spec")
      n=$(printf '%s\n' "$sel" | grep -c . | tr -d ' ')
      # The EXACT decimal count, not merely "fewer than all". `0/010` read as
      # OCTAL is 8, which still shards -- 13 of 102 rather than 11 -- so a
      # "not all" assertion passes over the wrong stride while the harness
      # prints the spec back verbatim. Only the exact count separates base 10
      # from base 8 here.
      dec=${spec##*/}
      while [ "${dec#0}" != "$dec" ] && [ -n "${dec#0}" ]; do dec=${dec#0}; done
      want=$(( (ROSTER_N + dec - 1) / dec ))
      if [ "$n" = "$want" ]; then
        ok "leading-zero spec $spec strides by $dec, not by its octal value ($n of $ROSTER_N)"
      else
        ng "leading-zero spec $spec selected $n of $ROSTER_N, want $want" \
          "read as octal it either aborts the block (whole roster, exit 0 -- the round-32 defect) or strides wrong"
      fi
      ;;
    *)
      if [ "$rc" = 2 ]; then
        ok "malformed spec '$spec' refuses with exit 2"
      else
        ng "malformed spec '$spec' exited $rc" \
          "anything but 2 lets a mis-set matrix run something other than what it reports"
      fi
      ;;
  esac
done

# An EMPTY selection is the subtler refusal: the spec parses, the index is in
# range, and the list simply has nothing at that residue. Driven with an
# explicit two-mutant list so no suite runs.
rc=$(CDKD_MUTANT_SHARD=3/4 "$SHELL_UNDER_TEST" "$HARNESS" --list-shard so-bs-glue so-depth0-frame >/dev/null 2>&1; printf '%s' "$?")
if [ "$rc" = 2 ]; then
  ok "a spec that selects NO mutants refuses with exit 2"
else
  ng "an empty selection exited $rc" "a green over nothing is the failure this harness exists to remove"
fi

# An explicit list is FILTERED by the shard, not overridden by it. Pinned
# because the harness's own comment claimed the opposite until round 32.
sel=$(selection 0/4 so-bs-glue so-depth0-frame)
n=$(printf '%s\n' "$sel" | grep -c . | tr -d ' ')
if [ "$n" = 1 ]; then
  ok "an explicit list is filtered by the shard (1 of 2), not overridden"
else
  ng "an explicit list under 0/4 selected $n of 2" "the composition is what reproduces one CI shard by hand"
fi

# --- unsharded ------------------------------------------------------------
sel=$(CDKD_MUTANT_SHARD="" "$SHELL_UNDER_TEST" "$HARNESS" --list-shard 2>/dev/null)
n=$(printf '%s\n' "$sel" | grep -c . | tr -d ' ')
if [ "$n" = "$ROSTER_N" ]; then
  ok "an empty CDKD_MUTANT_SHARD leaves the whole roster selected"
else
  ng "unsharded selection is $n of $ROSTER_N" "the unsharded invocation must be unchanged by this feature"
fi

printf '\n'
[ "$fail" = 0 ] || printf '%b' "$fail_log"
printf 'Pass: %s  Fail: %s\n' "$pass" "$fail"
[ "$fail" = 0 ]
