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
# directory, so they FAIL when it runs from a copy (they do not skip -- the
# copied baseline prints their failures), and the copied baseline is
# therefore a few cases lower than the in-place one. Every mutant below is
# compared against the copied baseline printed on the FIRST LINE of this run,
# so the comparison is internally consistent. Do not read that line as the
# tree's case count, and -- given this script exists because a hand-copied
# tally went stale twice -- no count is written here either. `bash
# .claude/hooks/lib/command-match.test.sh` is what answers that question.
#
# Usage:  bash .claude/hooks/lib/command-match-mutants.sh [<mutant> ...]
# Exit 0 when every mutant fails a case the unmutated run did not, non-zero
# if any does not --
# a mutant the suite does not notice is a coverage hole, and this reports it.
set -u
# `--list-shard` prints the mutant names the current `CDKD_MUTANT_SHARD` would
# run, one per line, and exits WITHOUT touching a suite. It exists so the shard
# selector can be fenced at all: the selection's load-bearing property is
# EXACT COVER across the four CI shards, which no per-shard run can observe,
# and asserting it by actually running mutants would cost hours.
# `command-match-mutants.test.sh` is the only caller.
__list_shard=0
if [ "${1:-}" = "--list-shard" ]; then __list_shard=1; shift; fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/command-match.sh"
SUITE="$HERE/command-match.test.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
# The suite's own CASE_FLOOR is neutralised in the copy. It exists to catch a
# case count that SHRANK in the repo, which is not what is being measured here
# -- and it fires spuriously on every run, because the copied suite FAILS the
# few cases that resolve fixtures from the suite's own directory. Left in, the
# unmutated baseline reports a failure and every row below inherits it.
sed 's/^CASE_FLOOR=[0-9]*$/CASE_FLOOR=0/' "$SUITE" > "$WORK/command-match.test.sh"

tally() { grep -E '^Pass: ' "$1" | head -1; }
# The failing CASE NAMES of a run, one per line, sorted. Discrimination is
# decided on these, not on the pass count: under load a LATENCY case can fail
# in the baseline run alone, and a mutant that reds exactly one case then ties
# the baseline tally and reads as NOT DISCRIMINATED (measured, review round 12
# of go-to-k/cdkd#3040, at load average 136: twenty-five one-case mutants
# reported undiscriminated at once). A mutant discriminates when it fails a
# case the baseline did NOT fail.
# Keyed on the case NAME, read from EVERY `FAIL` line -- the immediate one
# and the tail summary. Eight sites in the suite record a failure in the
# summary only (the `gate_missing_const` block, the soft-note needles), so a
# cut at the `Pass:` tally hid them (review round 14). The summary renders a
# backslash in a name through printf %b, differently from the immediate
# line, so such a case yields two keys; both runs render it the same way, so
# the comparison holds and only the count reads high. The TIMING cases carry
# their measurement in the line (`took 9s`); a case that fails in both runs
# with different seconds would read as a NEW failure and report a no-op
# mutant as discriminated (round 13 measured that with a `$(date +%s)`
# case), so lines named `latency` / `bounded walk` OR carrying a `took Ns`
# figure are outside the set: timing cannot discriminate a mutant. Byte
# collation is pinned so `sort` and `comm` agree whatever the locale.
failset() {
  grep -E '^FAIL ' "$1" | grep -vE '^FAIL (latency|bounded walk)| took [0-9]+s' \
    | LC_ALL=C sed -E 's/ \(want .*$//' | LC_ALL=C sort -u
}
# THE SPEC IS VALIDATED BEFORE THE BASELINE SUITE RUNS, because that run costs
# ~25 s locally and minutes on the macOS runner -- a typo in a CI matrix should
# not buy a full suite before it is told (code review round 32). The SELECTION
# itself stays below, beside the list it filters.
if [ -n "${CDKD_MUTANT_SHARD:-}" ]; then
  case "$CDKD_MUTANT_SHARD" in
    *[!0-9/]*|*/*/*|/*|*/) _sh_bad=1 ;;
    */*)                   _sh_bad=0 ;;
    *)                     _sh_bad=1 ;;
  esac
  [ "$_sh_bad" = 0 ] || {
    echo "CDKD_MUTANT_SHARD must be <index>/<total>, got '$CDKD_MUTANT_SHARD'" >&2; exit 2; }
  # BASE 10 FORCED. A leading zero makes bash read the number as OCTAL, and
  # `$((_sh_k % 08))` is not an error bash returns -- it ABORTS the enclosing
  # `if` compound, so `MUTANTS` kept all 102 mutants, the script exited 0, and
  # the only trace was one stderr line: the silent full run this whole block
  # exists to prevent, reproducing the 60-minute CI cancellation it exists to
  # remove (code review round 32, measured on `0/08`).
  _sh_i=$((10#${CDKD_MUTANT_SHARD%%/*}))
  _sh_n=$((10#${CDKD_MUTANT_SHARD##*/}))
  [ "$_sh_n" -gt 0 ] 2>/dev/null || { echo "CDKD_MUTANT_SHARD total must be > 0" >&2; exit 2; }
  [ "$_sh_i" -lt "$_sh_n" ] 2>/dev/null || {
    echo "CDKD_MUTANT_SHARD index $_sh_i is outside a total of $_sh_n" >&2; exit 2; }
fi

# The baseline suite is the harness's first real cost, so listing mode stops
# above it: a fence that had to pay for one could not run per case.
if [ "$__list_shard" = 1 ]; then
  MUTANTS_FOR_LIST=1
else
  MUTANTS_FOR_LIST=0
fi
if [ "$MUTANTS_FOR_LIST" = 0 ]; then
base_out="$WORK/base.txt"
cp "$LIB" "$WORK/command-match.sh"
bash "$WORK/command-match.test.sh" > "$base_out" 2>&1
base_pass=$(sed -n 's/^Pass: \([0-9]*\).*/\1/p' "$base_out" | head -1)
failset "$base_out" > "$WORK/base.fails"
printf '%-16s %s\n' "unmutated" "$(tally "$base_out")"
[ -n "$base_pass" ] || { echo "the unmutated suite printed no tally -- nothing below means anything" >&2; exit 1; }
fi

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
          '    *[\\<\\>\\;\\&\\|\\(\\)\\`\\$]*) return 0 ;;\n']:   # every backslash DOUBLED: a
          # single one is an invalid Python escape, and its SyntaxWarning went
          # to the same stderr the harness reads, so an unrelated mutant`s
          # COULD NOT APPLY line quoted this warning instead of its own cause
          # (test review round 30 chased exactly that).
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
 # Every backslash DOUBLED here too, for the reason spelled out at the
 # `wholeseg-raw` copy of this needle: a single one is an invalid Python
 # escape whose SyntaxWarning reaches the harness`s stderr.
 'meta-reject':      ('    *[\\<\\>\\;\\&\\|\\(\\)\\`\\$]*) return 0 ;;\n', ''),
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
 # --- go-to-k/cdkd#3040: the heredoc-inside-$( ) latch (`last_heredoc_opener`
 # and its call site in run()). Six review rounds each re-derived this matrix
 # by hand from the commit messages; it lives here now so the next round runs
 # it. One arm per entry; each reds the case(s) named beside it in
 # command-match.test.sh (`r2_case` / `r3_case` / the Round 6 block).
 # Round 23: `so-hash-class-rparen` takes the `)` back out of `subst_open`'s
 # comment class and `so-frame-glue` stops recording which `)` was glue --
 # either way a `)#` whose `$( )` closes on the same line reports CLOSED,
 # `last_heredoc_opener` is never called, and the top-level latch takes the
 # `<<'X'` (CP1 / CP2 / CP3 / CP4; CP-ctl2 is the glue direction).
 # Round 24: one mutant per member of `subst_open`'s OWN comment class -- the
 # third instance of the shape rounds 20 and 21 fenced elsewhere. Each reds
 # its SO case, where the observable is the resolved `cd` TARGET: without
 # the member the substitution reads as CLOSED and a `cd` running in its
 # child is resolved as top-level. `so-frame-kind-dollar` / `-gt` take the
 # two frame-kind members CP-ctl3 / CP-ctl4 pin. The `i == 1` arm has no
 # mutant: run() joins a continued substitution with `;`, so a line that
 # STARTS with the comment is reached through the `;` member instead
 # (measured -- SO6 reds under `so-hash-class-semi`, and disabling `i == 1`
 # alone reports NOT DISCRIMINATED).
 # Round 25's `so-hash-in-quotes` is retired: since round 26 the double-quote
 # branch `continue`s before any structural arm, so the `q == ""` test on the
 # `#` arm is unreachable-by-construction and the mutant reports NOT
 # DISCRIMINATED. The test stays as the stated rule (the other two machines
 # have it), and SQ1 / SQ2 are held by `so-dq-structural` instead.
 # `so-sq-before-backslash` restores the pre-round-24 ORDER, so `\\` inside
 # `'...'` eats the closing quote (SQ3). It is spelled as a three-arm inline
 # replacement rather than a move, because the backslash arm has carried
 # `sj = i` since round 29 and a plain reorder would take the glue record
 # with it -- that would vary two things at once (test review round 30
 # flagged the older wording, which still described a move).
 # Round 26: the two quote-OPENING arms of `subst_open`. Deleting either left
 # the suite green until SQ5 / SQ6, and each is fail-open-directed -- a `)`
 # inside the span then pops the frame and the `cd` after it is marked
 # top-level.
 # Round 26: `so-frame-quote-save` drops the per-frame save/restore of the
 # quote state, and `so-dq-structural` puts the double-quote fall-through
 # back so `(` / `)` / `#` are structural inside one. Either way the verb
 # after a `#` comment carrying an unbalanced `)` is swallowed (SQ7 / SQ8).
 'so-frame-quote-save': ('if (c == ")" && depth > 0) { if (K[depth] == 1) sj = i; q = SQ[depth]; depth--; continue }',
                         'if (c == ")" && depth > 0) { if (K[depth] == 1) sj = i; depth--; continue }'),
 'so-dq-structural':    ('          if (c == "`") { bt = 1 - bt; continue }\n          if (c == "$" && substr(line, i + 1, 1) == "(") { depth++; K[depth] = 1; SQ[depth] = q; q = ""; i++; continue }\n          continue\n', ''),
 # Round 29: `so-bs-glue` drops the word-glue record in `subst_open`'s
 # backslash arm, so an escaped `)` before a `#` reads as a comment and the
 # span reports CLOSED (SO7; SO-ctl2 is the unescaped control).
 'so-bs-glue':         ('{ i++; if (substr(line, i, 1) == ")") sj = i; continue }', '{ i++; continue }'),
 # Round 30: `so-depth0-frame` deletes the two depth-0 paren arms, so the `)`
 # of an `a=( )` reaches the `#` test as a raw previous character and the
 # scan ends before the `$(` on the same line (SO8; SO-ctl3 is the kind-0
 # control, which must stay a comment). `so-bs-glue-wide` widens the glue
 # record back to EVERY escaped character, the reading rounds 30 and 31
 # measured a fail-open for (CP-BS2 reds, go-to-k/cdkd#3303 has the bytes).
 'so-depth0-frame':    ('        if (c == "(") { ppd++; PK[ppd] = (i > 1 && substr(line, i - 1, 1) == "=") ? 2 : 0; continue }\n        if (c == ")" && ppd > 0) { if (PK[ppd] == 2) sj = i; ppd--; continue }\n', ''),
 'so-bs-glue-wide':    ('if (c == "\\\\") { i++; if (substr(line, i, 1) == ")") sj = i; continue }',
                        'if (c == "\\\\") { i++; sj = i; continue }'),
 'so-sq-open-arm':     ('          if (c == "\\047") { q = "\\047"; continue }\n', ''),
 'so-ansic-arm':       ('          if (c == "$" && substr(line, i + 1, 1) == "\\047") { q = "A"; i++; continue }\n', ''),
 # `so-pid-arm-whole` deletes the `$$` arm outright, which is what SQ4 pins
 # (both readings of its input end OPEN, so it cannot fence the ambiguity
 # rule itself -- that is SQ10 and `so-pid-step-over`).
 'so-pid-arm-whole':   ('          if (c == "$" && substr(line, i + 1, 1) == "$") {\n            if (substr(line, i + 2, 1) == "\\047") return 1\n            i++; continue }\n', ''),
 'so-pid-step-over':   ('            if (substr(line, i + 2, 1) == "\\047") return 1\n', ''),
 'so-sq-before-backslash': ('        if (q == "\\047") { if (c == "\\047") q = ""; continue }\n',
                          '        if (q == "\\047" && c == "\\047") { q = ""; continue }\n        if (q == "\\047" && c == "\\\\") { i++; continue }\n        if (q == "\\047") continue\n'),
 'so-hash-class-space': ('substr(line, i - 1, 1) ~ /[ \\t;&|()]/))) break', 'substr(line, i - 1, 1) ~ /[\\t;&|()]/))) break'),
 'so-hash-class-semi': ('substr(line, i - 1, 1) ~ /[ \\t;&|()]/))) break', 'substr(line, i - 1, 1) ~ /[ \\t&|()]/))) break'),
 'so-hash-class-amp': ('substr(line, i - 1, 1) ~ /[ \\t;&|()]/))) break', 'substr(line, i - 1, 1) ~ /[ \\t;|()]/))) break'),
 'so-hash-class-pipe': ('substr(line, i - 1, 1) ~ /[ \\t;&|()]/))) break', 'substr(line, i - 1, 1) ~ /[ \\t;&()]/))) break'),
 'so-hash-class-tab': ('substr(line, i - 1, 1) ~ /[ \\t;&|()]/))) break', 'substr(line, i - 1, 1) ~ /[ ;&|()]/))) break'),
 'so-frame-kind-bare':  ('if (c == "(" && depth > 0) { depth++; K[depth] = 0; SQ[depth] = q; continue }', 'if (c == "(" && depth > 0) { depth++; K[depth] = 1; SQ[depth] = q; continue }'),
 'so-frame-kind-dollar': ('        if (c == "$" && substr(line, i + 1, 1) == "(") { depth++; K[depth] = 1; SQ[depth] = q; q = ""; i++; continue }\n        # PROCESS SUBSTITUTION OPENS A SPAN TOO.',
                          '        if (c == "$" && substr(line, i + 1, 1) == "(") { depth++; K[depth] = 0; SQ[depth] = q; q = ""; i++; continue }\n        # PROCESS SUBSTITUTION OPENS A SPAN TOO.'),
 'so-frame-kind-gt': ('if ((c == "<" || c == ">") && substr(line, i + 1, 1) == "(") { depth++; K[depth] = 1; SQ[depth] = q; q = ""; i++; continue }', 'if ((c == "<" || c == ">") && substr(line, i + 1, 1) == "(") { depth++; K[depth] = (c == "<") ? 1 : 0; SQ[depth] = q; q = ""; i++; continue }'),
 'so-hash-class-rparen': ('(sj != i - 1 && substr(line, i - 1, 1) ~ /[ \\t;&|()]/))) break', '(substr(line, i - 1, 1) ~ /[ \\t;&|(]/))) break'),
 'so-frame-glue':       ('if (c == ")" && depth > 0) { if (K[depth] == 1) sj = i; q = SQ[depth]; depth--; continue }', 'if (c == ")" && depth > 0) { q = SQ[depth]; depth--; continue }'),
 'lho-reset-each-line': ('          pd = last_heredoc_opener(phys)\n',
                         '          lho_reset(); pd = last_heredoc_opener(phys)\n'),
 'lho-no-reset-on-close': ('        lho_reset()\n        # A line that ends INSIDE a quoted span',
                           '        # A line that ends INSIDE a quoted span'),
 'lho-frame-close-paren': ('if (out != "" && lho_depth <= of) { lho_bail = 1; return "" }\n                                             if (lho_OK[lho_depth] == 2 && substr(text, j + 1, 1) == "#") { lho_bail = 1; return "" }\n                                             if (lho_OK[lho_depth] == 1) gp = j; lho_iq = lho_OQ[lho_depth]', 'if (lho_OK[lho_depth] == 1) gp = j; lho_iq = lho_OQ[lho_depth]'),
 'lho-hash-class-paren': ('(gp != j - 1 && substr(text, j - 1, 1) ~ /[ \\t;&|()]/))) break', '(gp != j - 1 && substr(text, j - 1, 1) ~ /[ \\t;&|(]/))) break'),
 'lho-herestring-skip': ('if (substr(text, j + 2, 1) == "<") { j += 2; continue }', 'if (0) { j += 2; continue }'),
 'lho-iq-bail':         ('      if (lho_iq != "") return ""\n', '      if (0) return ""\n'),
 'lho-ansi-c-arm':      ('if (d == "\\047" && lho_iq == "") { lho_iq = "A"; j++; continue }\n', ''),
 'lho-ansi-c-in-dq':    ('if (d == "\\047" && lho_iq == "") { lho_iq = "A"; j++; continue }', 'if (d == "\\047") { lho_iq = "A"; j++; continue }'),
 'lho-ol-check':        ('if (out != "" && lho_depth + lho_bt > of) return ""', 'if (0) return ""'),
 # Round 21: one mutant per remaining member of `last_heredoc_opener`'s own
 # comment class -- the twin of the top-level one round 20 fenced. TAB,
 # `;`, `&` and `|` are live (LH1 / LH2 / LH3 / LH4); `(` is the refusing
 # direction (LH-ctl). `lho-array-frame-glue` makes an `a=( )` frame glue
 # like a process substitution instead of bailing (AE1 / AE2).
 'lho-hash-class-tab': ('substr(text, j - 1, 1) ~ /[ \\t;&|()]/))) break', 'substr(text, j - 1, 1) ~ /[ ;&|()]/))) break'),
 'lho-hash-class-semi': ('substr(text, j - 1, 1) ~ /[ \\t;&|()]/))) break', 'substr(text, j - 1, 1) ~ /[ \\t&|()]/))) break'),
 'lho-hash-class-amp': ('substr(text, j - 1, 1) ~ /[ \\t;&|()]/))) break', 'substr(text, j - 1, 1) ~ /[ \\t;|()]/))) break'),
 'lho-hash-class-pipe': ('substr(text, j - 1, 1) ~ /[ \\t;&|()]/))) break', 'substr(text, j - 1, 1) ~ /[ \\t;&()]/))) break'),
 'lho-hash-class-lparen': ('substr(text, j - 1, 1) ~ /[ \\t;&|()]/))) break', 'substr(text, j - 1, 1) ~ /[ \\t;&|)]/))) break'),
 # `lho-frame-kind-bail` makes a `<( )` / `>( )` frame kind 2, so its `)#`
 # bails instead of gluing and a real opener after it is not seen (PS-ctl3).
 'lho-frame-kind-bail': ('(j > 1 && substr(text, j - 1, 1) ~ /[<>]/) ? 1 : ', '(j > 1 && substr(text, j - 1, 1) ~ /[<>]/) ? 2 : '),
 'lho-array-frame-glue': ('((j > 1 && substr(text, j - 1, 1) == "=") ? 2 : 0); continue }', '((j > 1 && substr(text, j - 1, 1) == "=") ? 1 : 0); continue }'),
 'lho-hash-break':      ('if (c == "#" && (j == 1 || (gp != j - 1 && substr(text, j - 1, 1) ~ /[ \\t;&|()]/))) break', 'if (0) break'),
 'lho-brace-skip':      ('if (d == "{") { k = index(substr(text, j + 2), "}"); if (k == 0) { lho_bail = 1; return "" }', 'if (0) { k = index(substr(text, j + 2), "}"); if (k == 0) { lho_bail = 1; return "" }'),
 'lho-arith-skip':      ('if (d == "(" && substr(text, j + 2, 1) == "(") {', 'if (0) {'),
 'lho-arith-landing':   ('gp = k + 1; j = gp; continue }', 'gp = k; j = gp; continue }'),
 'lho-paren-pop-restore': ('{ lho_bail = 1; return "" }\n                                             if (lho_OK[lho_depth] == 2 && substr(text, j + 1, 1) == "#") { lho_bail = 1; return "" }\n                                             if (lho_OK[lho_depth] == 1) gp = j; lho_iq = lho_OQ[lho_depth]; lho_depth-- }', '{ lho_bail = 1; return "" }; if (lho_OK[lho_depth] == 1) gp = j; lho_depth-- }'),
 'lho-bare-paren-push': ('if (c == "(") { lho_depth++; lho_OQ[lho_depth] = ""\n', 'if (0) { lho_depth++; lho_OQ[lho_depth] = ""\n'),
 'lho-subst-push-save-iq': ('if (d == "(") { lho_depth++; lho_OQ[lho_depth] = lho_iq; lho_OK[lho_depth] = 1; lho_iq = ""; j++; continue }', 'if (d == "(") { lho_depth++; lho_OQ[lho_depth] = ""; lho_OK[lho_depth] = 1; lho_iq = ""; j++; continue }'),
 'lho-backtick-arm':    ('if (c == "`" && (lho_iq == "" || lho_iq == "\\"")) { lho_btq = lho_iq; lho_iq = ""; lho_bt = 1; continue }', 'if (0) { lho_btq = lho_iq; lho_iq = ""; lho_bt = 1; continue }'),
 'lho-terminated-guard': ('if (pd != "" && terminated(pd, i + 1) > 0) ptag = pd', 'if (pd != "") ptag = pd'),
 # heredoc_word (round 7): the delimiter is the whole WORD after quote
 # removal. `hw-stop-at-quote` ends the word at the closing quote (the old
 # regex: `<<'EOF'x` read as EOF); `hw-drop-inner-quote` strips a quote
 # INSIDE the word (`<<'a"b'` read as ab); `hw-unquoted-latch` latches an
 # unquoted delimiter in the $( ) arm; `hw-bail-not-sticky` makes an
 # unreadable word a per-line bail; `hw-flush-line-regex` puts flush_line
 # back on its own quoted-span regex instead of heredoc_word.
 # Round 23: `hw-dq-dollar-bail` lets a DOUBLE-QUOTED word bash would
 # EXPAND be latched as if it were literal (HW3). Its unquoted twin has
 # no mutant: with the bail gone the identifier test refuses `E$y`
 # anyway, so HW1 / HW2 cannot discriminate it (measured). c1b was
 # credited with this arm and is over-determined.
 'hw-dq-dollar-bail':   ('                           if (c == "$" || c == "`") return ""\n', ''),
 'hw-stop-at-quote':    ('                           w = w substr(rest, j + 1, k - 1); j += k + 1; HW_QUOTED = 1; continue }\n',
                         '                           w = w substr(rest, j + 1, k - 1); j += k + 1; HW_QUOTED = 1; break }\n'),
 'hw-drop-inner-quote': ('      HW_LEN = j - 1\n      return w\n',
                         '      HW_LEN = j - 1; gsub(/"/, "", w)\n      return w\n'),
 'hw-unquoted-latch':   ('          if (d == "" || !HW_QUOTED) { lho_bail = 1; return "" }\n',
                         '          if (d == "") { lho_bail = 1; return "" }\n'),
 'hw-bail-not-sticky':  ('          if (d == "" || !HW_QUOTED) { lho_bail = 1; return "" }\n',
                         '          if (d == "" || !HW_QUOTED) { return "" }\n'),
 'hw-flush-line-regex': ('            if (!hc && d != "" && (HW_QUOTED || d ~ /^[A-Za-z_][A-Za-z0-9_]*$/)) pending_tag = d\n',
                         '            if (match(rest, /^<<-?[ \\t]*("[^"]+"|\\047[^\\047]+\\047|[A-Za-z_][A-Za-z0-9_]*)/)) { d = substr(rest, RSTART, RLENGTH); sub(/^<<-?[ \\t]*/, "", d); gsub(/["\\047]/, "", d); if (d != "") pending_tag = d }\n'),
 # `hw-stop-at-dquote` ends the word at a closing double quote (`<<E"O"F`
 # read as EO); `hw-dq-backslash` strips a backslash before ANY character
 # inside double quotes (`<<"E\xF"` read as ExF); `hw-backslash-arm` makes
 # `<<\EOF` count as unquoted; `hw-toplevel-any-word` lets the top-level arm
 # latch a non-identifier unquoted word (`<<EOF.x`), dropping an expanded body.
 'hw-stop-at-dquote':   ('                         j++; HW_QUOTED = 1; continue }\n',
                         '                         j++; HW_QUOTED = 1; break }\n'),
 'hw-dq-backslash':     ('if (c == "\\\\") { if (substr(rest, j + 1, 1) ~ /[$`"\\\\]/) { j++; w = w substr(rest, j, 1); j++ }',
                         'if (c == "\\\\") { if (1) { j++; w = w substr(rest, j, 1); j++ }'),
 'hw-backslash-arm':    ('w = w substr(rest, j + 1, 1); j += 2; HW_QUOTED = 1; continue }',
                         'w = w substr(rest, j + 1, 1); j += 2; continue }'),
 'hw-toplevel-any-word': ('            if (!hc && d != "" && (HW_QUOTED || d ~ /^[A-Za-z_][A-Za-z0-9_]*$/)) pending_tag = d\n',
                          '            if (!hc && d != "") pending_tag = d\n'),
 # `hw-toplevel-ident-only` drops the quoted arm of the top-level guard, so a
 # QUOTED non-identifier word (`<<'EOF.x'`) is no longer latched and its body
 # is refused as commands (B2c). `ptag-paren-close` puts the latch back to
 # dropping a body line that begins with the delimiter and carries a `)`,
 # which bash 5 and 3.2 run as commands (Pc10 / Pc11 / Pc17).
 'hw-toplevel-ident-only': ('            if (!hc && d != "" && (HW_QUOTED || d ~ /^[A-Za-z_][A-Za-z0-9_]*$/)) pending_tag = d\n',
                            '            if (!hc && d != "" && d ~ /^[A-Za-z_][A-Za-z0-9_]*$/) pending_tag = d\n'),
 'ptag-paren-close':    ('          if (index(t, ptag) != 1 || index(substr(t, length(ptag) + 1), ")") == 0) continue\n',
                         '          continue\n'),
 # `ptag-keep-delimiter` hands the whole closing line to the join instead of
 # the text after the delimiter (X5: a quote in the delimiter re-opens a span).
 'ptag-keep-delimiter': ('          sub(/^[ \\t]+/, "", line); line = substr(line, length(ptag) + 1)\n', ''),
 # `ptag-trim-both` slices the remainder from the both-sides-trimmed `t`
 # (round 10 shipped that; an escaped trailing space became a continuation).
 # `ptag-paren-clause` drops the `)` test, so any line that merely BEGINS with
 # the delimiter ends the latch (Pc-ctl2).
 'ptag-trim-both':      ('          sub(/^[ \\t]+/, "", line); line = substr(line, length(ptag) + 1)\n',
                         '          line = substr(t, length(ptag) + 1)\n'),
 'ptag-paren-clause':   ('          if (index(t, ptag) != 1 || index(substr(t, length(ptag) + 1), ")") == 0) continue\n',
                         '          if (index(t, ptag) != 1) continue\n'),
 # `bs-parity` reads ANY trailing backslash as a continuation (E1 / E2 / E4);
 # `ptag-latch-off` never latches a heredoc inside `$( )` at all, the
 # pre-#3040 behaviour whose false refusals the control cases pin.
 'bs-parity':           ('        if (match(line, /\\\\+$/) && RLENGTH % 2 == 1) {\n',
                         '        if (line ~ /\\\\$/) {\n'),
 # `bs-arm-off` removes the continuation join entirely, so E3 / T1-ctl and
 # the pre-existing continuation cases are what hold it in place.
 'bs-arm-off':          ('        if (match(line, /\\\\+$/) && RLENGTH % 2 == 1) {\n',
                         '        if (0) {\n'),
 'ptag-latch-off':      ('          if (pd != "" && terminated(pd, i + 1) > 0) ptag = pd\n',
                         '          if (0) ptag = pd\n'),
 # `lho-frame-close-not-sticky` returns from a frame close without the flag
 # (X19b / X19c); `lho-hash-class-bt` puts the backtick back into the `#`
 # class -- a CLOSING backtick ends a word, so `\`a\`#"` is glued (H2; since
 # round 16 nothing inside a frame is read, so the opening one is moot).
 'lho-frame-close-not-sticky': ('if (out != "" && lho_depth <= of) { lho_bail = 1; return "" }\n                                             if (lho_OK[lho_depth] == 2 && substr(text, j + 1, 1) == "#") { lho_bail = 1; return "" }\n                                             if (lho_OK[lho_depth] == 1) gp = j; lho_iq = lho_OQ[lho_depth]',
                                'if (out != "" && lho_depth <= of) { return "" }; if (lho_OK[lho_depth] == 1) gp = j; lho_iq = lho_OQ[lho_depth]'),
 'lho-hash-class-bt':   ('substr(text, j - 1, 1) ~ /[ \\t;&|()]/))) break', 'substr(text, j - 1, 1) ~ /[ \\t;&|()`]/))) break'),
 'pending-tag-restore': ('      pending_tag = saved_pt\n', ''),
 # Round 16. `lho-bt-fallthrough` reads the text inside a backtick frame
 # again -- the round-15 shape, where a frame closing after the opener on
 # the same line latched it (X20a / X20b / X20c); `lho-bt-quoted` honours a
 # quote inside the frame, so a backtick inside it no longer closes it (Q1);
 # `lho-bt-skip-off` never closes a frame at all (H1, N1). `lho-hash-glue`
 # drops the word-glue guard, so every `)#` -- and every backslash-escaped
 # character before a `#` (round 17) -- reads as a comment again (G1 / G2 /
 # G3, W1 / W5, A7 / A8); `lho-frame-kind` makes every `)`
 # glue, the bare-subshell one included (G-ctl). `lho-brace-quote-bail`
 # skips a `${...}` span whatever it holds (K1 / K2); `lho-arith-not-sticky`
 # returns from an unterminated `$((` without the flag (AR1).
 'lho-bt-fallthrough':  ('if (c == "`") { lho_bt = 0; lho_iq = lho_btq }; continue }', 'if (c == "`") { lho_bt = 0; lho_iq = lho_btq; continue } }'),
 'lho-bt-skip-off':     ('if (lho_bt) { if (c == "\\\\") { j++; continue }', 'if (0) { if (c == "\\\\") { j++; continue }'),
 'lho-bt-quoted':       ('        if (lho_bt) { if (c == "\\\\") { j++; continue }\n                      if (c == "`") { lho_bt = 0; lho_iq = lho_btq }; continue }\n',
                         '        if (lho_bt && lho_iq != "") { if (c == lho_iq) lho_iq = ""; continue }\n        if (lho_bt) { if (c == "\\\\") { j++; continue }; if (c == "`") { lho_bt = 0; lho_iq = lho_btq; continue }; if (c == "\\"" || c == "\\047") { lho_iq = c; continue }; continue }\n'),
 'lho-hash-glue':       ('(gp != j - 1 && substr(text, j - 1, 1) ~', '(substr(text, j - 1, 1) ~'),
 'lho-frame-kind':      ('if (lho_OK[lho_depth] == 1) gp = j;', 'gp = j;'),
 'lho-brace-quote-bail': ('s = substr(text, j + 2, k - 1); if (s ~ /["\\047`\\\\]/) { lho_bail = 1; return "" }', 's = substr(text, j + 2, k - 1); if (0) { lho_bail = 1; return "" }'),
 'lho-arith-not-sticky': ('if (k > n || substr(text, k + 1, 1) != ")") { lho_bail = 1; return "" }', 'if (k > n || substr(text, k + 1, 1) != ")") return ""'),
 # Round 17. `lho-bs-glue` forgets that an unquoted backslash consumed the
 # character before a `#` (W1 / W5 / W6 / W7); `lho-arith-first-close` ends a
 # `$(( ))` at the first `))` again (A7); `lho-bt-escape-off` lets an escaped
 # backtick close a frame (BS1); `lho-brace-class-sq` / `-bt` drop one member
 # of the `${...}` bail class each (K3 / K4).
 'lho-bs-glue':         ('if (c == "\\\\") { j++; gp = j; continue }', 'if (c == "\\\\") { j++; continue }'),
 'lho-arith-first-close': ('                          m = 0; k = j + 3\n                          while (k <= n) { e = substr(text, k, 1)\n                            if (e == "(") m++\n                            else if (e == ")") { if (m == 0) break; m-- }\n                            k++ }\n',
                          '                          k = index(substr(text, j + 3), "))"); if (k == 0) k = n + 1; else k = j + 2 + k\n'),
 'lho-bt-escape-off':   ('if (lho_bt) { if (c == "\\\\") { j++; continue }', 'if (lho_bt) { if (0) { j++; continue }'),
 'lho-brace-class-sq':  ('if (s ~ /["\\047`\\\\]/)', 'if (s ~ /["`\\\\]/)'),
 'lho-brace-class-bt':  ('if (s ~ /["\\047`\\\\]/)', 'if (s ~ /["\\047\\\\]/)'),
 # Round 18. `ptag-comment-off` lets the TOP-LEVEL latch read a `<<` that sits
 # in a `#` comment (CM1 / CM2 / CM3); `ptag-comment-glue` drops the word-glue
 # half of that test, so a glued `$(echo)#` reads as a comment and a real body
 # is not dropped (CM-ctl1; also CM-ctl5, the escaped space). `ptag-comment-bs-glue`
 # and `ptag-comment-sub-glue` delete the glue record at the backslash arm and
 # at the `<( )` / `$( )` landing (CM-ctl5, CM-ctl6). `lho-arith-quote-bail` walks
 # a `$(( ))` span holding a quote (AQ1) and `lho-arith-second-close` accepts
 # a landing whose next character is not `)` (A9).
 # Round 19: `ptag-comment-class` restores the doubled backslash that made
 # the class hold a literal backslash and the letter `t` instead of a TAB
 # -- a fail-open on the tab spelling (CM4 / CM5) and a false refusal on a
 # letter-glued `cat#` (CM-ctl3), both measured against all three shells.
 'ptag-comment-bs-glue': ('if (c == "\\\\") { i++; fgp = i; continue }   # both chars stay in the run', 'if (c == "\\\\") { i++; continue }   # both chars stay in the run'),
 'ptag-comment-sub-glue': ('if ((c == "<" || c == ">") && substr(line, i + 1, 1) == "(") {\n            cp = close_paren(line, i + 2)\n            if (cp > 0) {\n              extra = extra substr(line, i + 2, cp - i - 2) "\\n"\n              res = res substr(line, runstart, i - runstart) neutralise(substr(line, i, cp - i + 1)); runstart = cp + 1\n              i = cp; fgp = i\n',
                          'if ((c == "<" || c == ">") && substr(line, i + 1, 1) == "(") {\n            cp = close_paren(line, i + 2)\n            if (cp > 0) {\n              extra = extra substr(line, i + 2, cp - i - 2) "\\n"\n              res = res substr(line, runstart, i - runstart) neutralise(substr(line, i, cp - i + 1)); runstart = cp + 1\n              i = cp\n'),
 # Round 20: one mutant per remaining member of the top-level comment class
 # -- the SPACE and TAB members had cases, the other five did not, and
 # each is a live shape (CM7 / CM8 / CM9 / CM10 / CM11).
 'ptag-comment-class-rparen': ('substr(line, i - 1, 1)) ~ /[ \\t;&|()]/))) { hc = 1', 'substr(line, i - 1, 1)) ~ /[ \\t;&|(]/))) { hc = 1'),
 'ptag-comment-class-lparen': ('substr(line, i - 1, 1)) ~ /[ \\t;&|()]/))) { hc = 1', 'substr(line, i - 1, 1)) ~ /[ \\t;&|)]/))) { hc = 1'),
 'ptag-comment-class-semi': ('substr(line, i - 1, 1)) ~ /[ \\t;&|()]/))) { hc = 1', 'substr(line, i - 1, 1)) ~ /[ \\t&|()]/))) { hc = 1'),
 'ptag-comment-class-amp': ('substr(line, i - 1, 1)) ~ /[ \\t;&|()]/))) { hc = 1', 'substr(line, i - 1, 1)) ~ /[ \\t;|()]/))) { hc = 1'),
 'ptag-comment-class-pipe': ('substr(line, i - 1, 1)) ~ /[ \\t;&|()]/))) { hc = 1', 'substr(line, i - 1, 1)) ~ /[ \\t;&()]/))) { hc = 1'),
 # `lho-frame-kind-word` classes a `<( )` / `>( )` bare `(` as an operator
 # again, so its `)` records no glue and the `#` after it reads as a
 # comment (PS1 / PS2). The `a=( )` arm is `lho-array-frame-glue`'s.
 'lho-frame-kind-word': ('(j > 1 && substr(text, j - 1, 1) ~ /[<>]/) ? 1 : ', '(0) ? 1 : '),
 'ptag-comment-class':  ('substr(line, i - 1, 1)) ~ /[ \\t;&|()]/))) { hc = 1', 'substr(line, i - 1, 1)) ~ /[ \\\\t;&|()]/))) { hc = 1'),
 'ptag-comment-off':    ('if (!hc && d != "" && (HW_QUOTED', 'if (d != "" && (HW_QUOTED'),
 'ptag-comment-glue':   ('if (c == "#" && (i == 1 || (fgp != i - 1 ', 'if (c == "#" && (i == 1 || (1 '),
 'lho-arith-quote-bail': ('if (substr(text, j + 3, k - j - 3) ~ /["\\047`\\\\]/) { lho_bail = 1; return "" }\n', ''),
 'lho-arith-second-close': ('if (k > n || substr(text, k + 1, 1) != ")") { lho_bail = 1; return "" }', 'if (k > n) { lho_bail = 1; return "" }'),
}
a,b=edits[probe]
n=s.count(a)
assert n==1, (probe, n)
io.open(p,'w',encoding='utf-8').write(s.replace(a,b))
PY
      ;;
  esac
}

MUTANTS="${*:-passthrough wholeseg wholeseg-raw empty-pair-collapse dq-backslash open-quote-guard len-bound span-bound meta-reject gh-extra-always odd-trailing-bs so-frame-quote-save so-dq-structural so-bs-glue so-depth0-frame so-bs-glue-wide so-sq-open-arm so-ansic-arm so-pid-arm-whole so-pid-step-over so-sq-before-backslash so-hash-class-space so-hash-class-tab so-hash-class-semi so-hash-class-amp so-hash-class-pipe so-frame-kind-bare so-frame-kind-dollar so-frame-kind-gt so-hash-class-rparen so-frame-glue lho-reset-each-line lho-no-reset-on-close lho-frame-close-paren lho-hash-class-paren lho-herestring-skip lho-iq-bail lho-ansi-c-arm lho-ansi-c-in-dq lho-ol-check lho-hash-break lho-hash-class-tab lho-hash-class-semi lho-hash-class-amp lho-hash-class-pipe lho-hash-class-lparen lho-array-frame-glue lho-frame-kind-bail lho-brace-skip lho-arith-skip lho-arith-landing lho-paren-pop-restore lho-bare-paren-push lho-subst-push-save-iq lho-backtick-arm lho-terminated-guard hw-dq-dollar-bail hw-stop-at-quote hw-drop-inner-quote hw-unquoted-latch hw-bail-not-sticky hw-flush-line-regex hw-stop-at-dquote hw-dq-backslash hw-backslash-arm hw-toplevel-any-word hw-toplevel-ident-only ptag-paren-close ptag-keep-delimiter ptag-trim-both ptag-paren-clause bs-parity bs-arm-off ptag-latch-off lho-frame-close-not-sticky lho-hash-class-bt pending-tag-restore lho-bt-fallthrough lho-bt-quoted lho-bt-skip-off lho-hash-glue lho-frame-kind lho-brace-quote-bail lho-arith-not-sticky lho-bs-glue lho-arith-first-close lho-bt-escape-off lho-brace-class-sq lho-brace-class-bt ptag-comment-off ptag-comment-glue ptag-comment-class ptag-comment-class-rparen ptag-comment-class-lparen ptag-comment-class-semi ptag-comment-class-amp ptag-comment-class-pipe lho-frame-kind-word ptag-comment-bs-glue ptag-comment-sub-glue lho-arith-quote-bail lho-arith-second-close}"
# SHARDING, because this harness outgrew a CI job. It runs the WHOLE suite per
# mutant, so its cost is (mutants x cases) and both factors only grow: on
# 2026-09-17 the macOS `hook-suites` job was CANCELLED at its 60-minute cap
# with `run-tests.sh` done in 15m21s and this step still running after 44m53s.
# A cancelled job reads as a flake, gets re-run, and is cancelled again --
# the shape this repo's own timeout note warns about one file over.
#
# `CDKD_MUTANT_SHARD=<index>/<total>` runs every <total>-th mutant starting at
# <index> (0-based), so `.github/workflows/hooks.yml` can fan the matrix across
# parallel jobs that each finish well inside the cap. STRIDED rather than
# contiguous on purpose: the list is grouped by machine (`lho-` then `hw-`
# then `ptag-`), and contiguous slices would put one machine's whole arm set
# on one runner, so a shard that dies takes a whole machine's coverage with it
# while the others stay green.
#
# Every refusal here is LOUD. A malformed spec, a zero or negative total, an
# index outside it, or a selection that comes back EMPTY exits 2 -- a shard
# that silently runs nothing is a green tick over no measurement, which is the
# failure mode this whole file exists to remove. The unsharded invocation is
# unchanged. An explicit mutant list on the command line is FILTERED by the
# shard rather than overriding it -- `CDKD_MUTANT_SHARD=0/4 … a b c` runs one
# of the three and shards 1..3 refuse as empty. An earlier revision of this
# comment said the list "still wins", which it does not (test review round
# 32 measured the drop). The composition is the useful one -- it is how a
# single shard is reproduced by hand -- so the COMMENT is what was wrong.
if [ -n "${CDKD_MUTANT_SHARD:-}" ]; then
  _sh_sel=""; _sh_k=0
  for m in $MUTANTS; do
    [ $((_sh_k % _sh_n)) -eq "$_sh_i" ] && _sh_sel="$_sh_sel $m"
    _sh_k=$((_sh_k + 1))
  done
  MUTANTS="$_sh_sel"
  [ -n "$(printf '%s' "$MUTANTS" | tr -d ' ')" ] || {
    echo "CDKD_MUTANT_SHARD $CDKD_MUTANT_SHARD selected NO mutants of $_sh_k -- refusing to report a green over nothing" >&2
    exit 2; }
  # PROGRESS GOES TO STDERR. In `--list-shard` mode stdout is a DATA channel --
  # one mutant name per line -- and a progress line mixed into it made the
  # fence count one name too many per shard (measured while writing that
  # fence: `1 of 2` read as two selected).
  printf 'shard %s: %s of %s mutants\n' "$CDKD_MUTANT_SHARD" "$(printf '%s' "$MUTANTS" | wc -w | tr -d ' ')" "$_sh_k" >&2
fi

if [ "$__list_shard" = 1 ]; then
  for m in $MUTANTS; do printf '%s\n' "$m"; done
  exit 0
fi

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
  failset "$WORK/$m.txt" > "$WORK/$m.fails"
  new_fails=$(LC_ALL=C comm -13 "$WORK/base.fails" "$WORK/$m.fails" | wc -l | tr -d ' ')
  if [ "$new_fails" -eq 0 ]; then
    printf '%-16s %s   <- NOT DISCRIMINATED: no case notices this mutation\n' "$m" "$(tally "$WORK/$m.txt")"; rc=1
  else
    printf '%-16s %s   (%s failure name(s) red beyond the baseline)\n' "$m" "$(tally "$WORK/$m.txt")" "$new_fails"
  fi
done
exit "$rc"
