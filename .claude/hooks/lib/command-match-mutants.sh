#!/usr/bin/env bash
# command-match-mutants.sh -- run `command-match.test.sh` against deliberately
# BROKEN copies of `command-match.sh`, and print the tally for each.
#
# WHY THIS IS A SCRIPT AND NOT A TABLE IN A COMMENT (go-to-k/cdkd#2333). The
# mutation matrix was written into `command-match.test.sh` as prose TWICE and
# was stale BOTH times -- first measured before eleven cases were added, then
# measured on a 541-case tree while the floor already said 543, so every row
# summed to one less than the file's own case count. Each time a reviewer found
# it, and each time the remedy proposed was "re-measure". Two occurrences of
# one shape is the signal to change instrument rather than recount: the numbers
# are not written down any more, they are PRINTED by this script, so there is
# no copy that can drift.
#
# A mutant that makes the suite fail to LOAD proves nothing -- it reports a
# missing symbol, not a discriminating test -- so every mutant here keeps the
# function DEFINED and changes only its behaviour. The one that matters most is
# `wholeseg-raw`: whole-segment dequoting with the safety guards removed, which
# is the implementation that was built, reviewed four rounds and WITHDRAWN.
#
# THE BASELINE IS THE COPIED RUN, NOT THE IN-PLACE ONE, and the difference is
# real: a few cases in the suite build fixtures relative to the SUITE'S OWN
# directory, so they skip when it runs from a copy, and the copied baseline is
# therefore a few cases lower than the in-place one. Every mutant below is
# compared against the copied baseline printed on the FIRST LINE of this run,
# so the comparison is internally consistent. Do not read that line as the
# tree's case count, and -- given this script exists because a hand-copied
# tally went stale twice -- no count is written here either. `bash
# .claude/hooks/lib/command-match.test.sh` is what answers that question.
#
# Usage:  bash .claude/hooks/lib/command-match-mutants.sh [<mutant> ...]
# Exit 0 when every mutant reduced the pass count, non-zero if any did not --
# a mutant the suite does not notice is a coverage hole, and this reports it.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/command-match.sh"
SUITE="$HERE/command-match.test.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
# The suite's own CASE_FLOOR is neutralised in the copy. It exists to catch a
# case count that SHRANK in the repo, which is not what is being measured here
# -- and it fires spuriously on every run, because the copied suite skips the
# few cases that resolve fixtures from the suite's own directory. Left in, the
# unmutated baseline reports a failure and every row below inherits it.
sed 's/^CASE_FLOOR=[0-9]*$/CASE_FLOOR=0/' "$SUITE" > "$WORK/command-match.test.sh"

tally() { grep -E '^Pass: ' "$1" | head -1; }
base_out="$WORK/base.txt"
cp "$LIB" "$WORK/command-match.sh"
bash "$WORK/command-match.test.sh" > "$base_out" 2>&1
base_pass=$(sed -n 's/^Pass: \([0-9]*\).*/\1/p' "$base_out" | head -1)
printf '%-16s %s\n' "unmutated" "$(tally "$base_out")"
[ -n "$base_pass" ] || { echo "the unmutated suite printed no tally -- nothing below means anything" >&2; exit 1; }

# Each mutant is a sed/python edit applied to a COPY. Keep them minimal: one
# behaviour change each, so a red tells you which property that case pins.
mutate() { # <name>
  cp "$LIB" "$WORK/command-match.sh"
  case "$1" in
    passthrough)
      printf '%s\n' 'gate_dequote_structural() { GATE_STRUCT_SEG="$1"; return 0; }' \
        >> "$WORK/command-match.sh" ;;
    wholeseg|wholeseg-raw)
      if [ "$1" = wholeseg-raw ]; then
        python3 - "$WORK/command-match.sh" <<'PY'
import io,sys
p=sys.argv[1]; s=io.open(p,encoding='utf-8').read()
for a in ['    *[[:space:]]*) return 0 ;;\n', "    *[\\\"\\'\\\\]*) return 0 ;;\n",
          '    *[\\<\\>\;\\&\\|\\(\\)\\`\\$]*) return 0 ;;\n']:
    assert s.count(a)==1, (a, s.count(a))
    s=s.replace(a,'',1)
io.open(p,'w',encoding='utf-8').write(s)
PY
      fi
      cat >> "$WORK/command-match.sh" <<'EOF'
gate_dequote_structural() {
  local seg="$1" rest="$1" out="" first=1
  GATE_STRUCT_SEG="$seg"
  case "$seg" in *[\"\'\\]*) ;; *) return 0 ;; esac
  while [ -n "$rest" ]; do
    _gate_struct_next "$rest" || return 0
    _gate_struct_rewrite "$_GATE_STRUCT_TOK"; rest="$_GATE_STRUCT_REST"
    if [ "$first" = 1 ]; then out="$_GATE_DQ"; first=0; else out="$out $_GATE_DQ"; fi
  done
  GATE_STRUCT_SEG="$out"
}
EOF
      ;;
    *)
      python3 - "$WORK/command-match.sh" "$1" <<'PY'
import io,sys
p,probe=sys.argv[1],sys.argv[2]
s=io.open(p,encoding='utf-8').read()
edits={
 'open-quote-guard': ('  [ -z "$q" ] || return 0\n', ''),
 'len-bound':        ('  [ "${#w}" -le "$GATE_STRUCT_MAXTOKLEN" ] || return 0\n', ''),
 'span-bound':       ('    [ "$spans" -gt "$GATE_STRUCT_MAXSPAN" ] && return 0\n', ''),
 'meta-reject':      ('    *[\\<\\>\;\\&\\|\\(\\)\\`\\$]*) return 0 ;;\n', ''),
 # Deleting the ODD-TRAILING-BACKSLASH refusal in `_gate_struct_next`. That
 # token splitter breaks on whitespace alone, so without this guard `cd\\ /tmp`
 # -- ONE shell word, which bash reports as `cd /tmp: No such file or
 # directory` and never acts on -- is split into `cd\\` + `/tmp`, the first is
 # rewritten to `cd`, and the two are re-joined with a plain space. The result
 # is a `cd` MANUFACTURED out of a command bash never runs, and it moves the
 # target EVERY gate resolves: measured on the differential corpus, eleven
 # `t:` observables for `cd\\ /tmp ; git commit -m x` flip to /tmp -- every gate
 # that resolves a target, not one of them. The COUNT is deliberately absent:
 # four attempts at it produced three different numbers, so read it off the
 # differential's undeclared-cell list with this mutant applied.
 'odd-trailing-bs': ('  _gate_odd_trailing_bs "${r%%[[:space:]]*}" && return 1\n', ''),
 # Deleting the empty-pair COLLAPSE, which is what makes free padding
 # visible. Its predecessor probe -- flipping the span charge back on --
 # became inert the moment the collapse landed, and this harness REPORTED
 # that rather than passing quietly, which is the whole point of the
 # `NOT DISCRIMINATED` arm. A probe list drifts away from its subject like
 # any other enumeration.
 'empty-pair-collapse':('  while :; do\n    case "$w" in\n      *\'""\'*|*"$GATE_SQ$GATE_SQ"*) ;;\n      *) break ;;\n    esac\n    w="${w//\\"\\"/}"\n    w="${w//$GATE_SQ$GATE_SQ/}"\n  done\n', ''),
 'dq-backslash':     ('*) out="$out' + chr(92)*2 + '" ;;',
                      '*) out="$out$c"; rest="${rest#?}" ;;'),
 'gh-extra-always':  ('        case "$kind" in\n          gh)\n',
                      '        extra=1\n        case "$kind" in\n          gh)\n'),
}
a,b=edits[probe]
n=s.count(a)
assert n>=1, (probe, n)
io.open(p,'w',encoding='utf-8').write(s.replace(a,b))
PY
      ;;
  esac
}

MUTANTS="${*:-passthrough wholeseg wholeseg-raw empty-pair-collapse dq-backslash open-quote-guard len-bound span-bound meta-reject gh-extra-always odd-trailing-bs}"
rc=0
for m in $MUTANTS; do
  if ! mutate "$m" 2>"$WORK/err.txt"; then
    printf '%-16s COULD NOT APPLY: %s\n' "$m" "$(head -1 "$WORK/err.txt")"; rc=1; continue
  fi
  if ! bash -n "$WORK/command-match.sh" 2>/dev/null; then
    printf '%-16s MUTANT DOES NOT PARSE -- voids the probe\n' "$m"; rc=1; continue
  fi
  bash "$WORK/command-match.test.sh" > "$WORK/$m.txt" 2>&1
  pass=$(sed -n 's/^Pass: \([0-9]*\).*/\1/p' "$WORK/$m.txt" | head -1)
  if [ -z "$pass" ]; then
    printf '%-16s NO TALLY -- the suite failed to load, which is not discrimination\n' "$m"; rc=1; continue
  fi
  if [ "$pass" -ge "$base_pass" ]; then
    printf '%-16s %s   <- NOT DISCRIMINATED: no case notices this mutation\n' "$m" "$(tally "$WORK/$m.txt")"; rc=1
  else
    printf '%-16s %s\n' "$m" "$(tally "$WORK/$m.txt")"
  fi
done
exit "$rc"
