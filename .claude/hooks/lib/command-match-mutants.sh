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
base_out="$WORK/base.txt"
cp "$LIB" "$WORK/command-match.sh"
bash "$WORK/command-match.test.sh" > "$base_out" 2>&1
base_pass=$(sed -n 's/^Pass: \([0-9]*\).*/\1/p' "$base_out" | head -1)
failset "$base_out" > "$WORK/base.fails"
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
 # --- go-to-k/cdkd#3040: the heredoc-inside-$( ) latch (`last_heredoc_opener`
 # and its call site in run()). Six review rounds each re-derived this matrix
 # by hand from the commit messages; it lives here now so the next round runs
 # it. One arm per entry; each reds the case(s) named beside it in
 # command-match.test.sh (`r2_case` / `r3_case` / the Round 6 block).
 'lho-reset-each-line': ('          pd = last_heredoc_opener(phys)\n',
                         '          lho_reset(); pd = last_heredoc_opener(phys)\n'),
 'lho-no-reset-on-close': ('        lho_reset()\n        # A line that ends INSIDE a quoted span',
                           '        # A line that ends INSIDE a quoted span'),
 'lho-frame-close-paren': ('if (out != "" && lho_depth <= of) { lho_bail = 1; return "" }; lho_iq = lho_OQ[lho_depth]', 'lho_iq = lho_OQ[lho_depth]'),
 'lho-hash-class-paren': ('~ /[ \\t;&|()]/)) break', '~ /[ \\t;&|(]/)) break'),
 'lho-herestring-skip': ('if (substr(text, j + 2, 1) == "<") { j += 2; continue }', 'if (0) { j += 2; continue }'),
 'lho-iq-bail':         ('      if (lho_iq != "") return ""\n', '      if (0) return ""\n'),
 'lho-ansi-c-arm':      ('if (d == "\\047" && lho_iq == "") { lho_iq = "A"; j++; continue }\n', ''),
 'lho-ansi-c-in-dq':    ('if (d == "\\047" && lho_iq == "") { lho_iq = "A"; j++; continue }', 'if (d == "\\047") { lho_iq = "A"; j++; continue }'),
 'lho-ol-check':        ('if (out != "" && lho_depth + lho_bt > of) return ""', 'if (0) return ""'),
 'lho-hash-break':      ('if (c == "#" && (j == 1 || substr(text, j - 1, 1) ~ /[ \\t;&|()]/)) break', 'if (0) break'),
 'lho-brace-skip':      ('if (d == "{") { k = index(substr(text, j + 2), "}"); if (k == 0) { lho_bail = 1; return "" }', 'if (0) { k = index(substr(text, j + 2), "}"); if (k == 0) { lho_bail = 1; return "" }'),
 'lho-arith-skip':      ('if (d == "(" && substr(text, j + 2, 1) == "(") {', 'if (0) {'),
 'lho-arith-landing':   ('j = j + 3 + k; continue }', 'j = j + 2 + k; continue }'),
 'lho-paren-pop-restore': ('{ lho_bail = 1; return "" }; lho_iq = lho_OQ[lho_depth]; lho_depth-- }', '{ lho_bail = 1; return "" }; lho_depth-- }'),
 'lho-bare-paren-push': ('if (c == "(") { lho_depth++; lho_OQ[lho_depth] = ""; continue }', 'if (0) { lho_depth++; lho_OQ[lho_depth] = ""; continue }'),
 'lho-subst-push-save-iq': ('if (d == "(") { lho_depth++; lho_OQ[lho_depth] = lho_iq; lho_iq = ""; j++; continue }', 'if (d == "(") { lho_depth++; lho_OQ[lho_depth] = ""; lho_iq = ""; j++; continue }'),
 'lho-backtick-arm':    ('if (c == "`" && (lho_iq == "" || lho_iq == "\\"")) { if (!lho_bt)', 'if (0) { if (!lho_bt)'),
 'lho-terminated-guard': ('if (pd != "" && terminated(pd, i + 1) > 0) ptag = pd', 'if (pd != "") ptag = pd'),
 # heredoc_word (round 7): the delimiter is the whole WORD after quote
 # removal. `hw-stop-at-quote` ends the word at the closing quote (the old
 # regex: `<<'EOF'x` read as EOF); `hw-drop-inner-quote` strips a quote
 # INSIDE the word (`<<'a"b'` read as ab); `hw-unquoted-latch` latches an
 # unquoted delimiter in the $( ) arm; `hw-bail-not-sticky` makes an
 # unreadable word a per-line bail; `hw-flush-line-regex` puts flush_line
 # back on its own quoted-span regex instead of heredoc_word.
 'hw-stop-at-quote':    ('                           w = w substr(rest, j + 1, k - 1); j += k + 1; HW_QUOTED = 1; continue }\n',
                         '                           w = w substr(rest, j + 1, k - 1); j += k + 1; HW_QUOTED = 1; break }\n'),
 'hw-drop-inner-quote': ('      HW_LEN = j - 1\n      return w\n',
                         '      HW_LEN = j - 1; gsub(/"/, "", w)\n      return w\n'),
 'hw-unquoted-latch':   ('          if (d == "" || !HW_QUOTED) { lho_bail = 1; return "" }\n',
                         '          if (d == "") { lho_bail = 1; return "" }\n'),
 'hw-bail-not-sticky':  ('          if (d == "" || !HW_QUOTED) { lho_bail = 1; return "" }\n',
                         '          if (d == "" || !HW_QUOTED) { return "" }\n'),
 'hw-flush-line-regex': ('            if (d != "" && (HW_QUOTED || d ~ /^[A-Za-z_][A-Za-z0-9_]*$/)) pending_tag = d\n',
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
 'hw-toplevel-any-word': ('            if (d != "" && (HW_QUOTED || d ~ /^[A-Za-z_][A-Za-z0-9_]*$/)) pending_tag = d\n',
                          '            if (d != "") pending_tag = d\n'),
 # `hw-toplevel-ident-only` drops the quoted arm of the top-level guard, so a
 # QUOTED non-identifier word (`<<'EOF.x'`) is no longer latched and its body
 # is refused as commands (B2c). `ptag-paren-close` puts the latch back to
 # dropping a body line that begins with the delimiter and carries a `)`,
 # which bash 5 and 3.2 run as commands (Pc10 / Pc11 / Pc17).
 'hw-toplevel-ident-only': ('            if (d != "" && (HW_QUOTED || d ~ /^[A-Za-z_][A-Za-z0-9_]*$/)) pending_tag = d\n',
                            '            if (d != "" && d ~ /^[A-Za-z_][A-Za-z0-9_]*$/) pending_tag = d\n'),
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
 # (X19b / X19c); `lho-hash-class-bt` puts the opening backtick back into the
 # `#` class (H1, refusing direction).
 'lho-frame-close-not-sticky': ('if (out != "" && lho_depth <= of) { lho_bail = 1; return "" }; lho_iq = lho_OQ[lho_depth]',
                                'if (out != "" && lho_depth <= of) { return "" }; lho_iq = lho_OQ[lho_depth]'),
 'lho-hash-class-bt':   ('~ /[ \\t;&|()]/)) break', '~ /[ \\t;&|()`]/)) break'),
 'pending-tag-restore': ('      pending_tag = saved_pt\n', ''),
}
a,b=edits[probe]
n=s.count(a)
assert n==1, (probe, n)
io.open(p,'w',encoding='utf-8').write(s.replace(a,b))
PY
      ;;
  esac
}

MUTANTS="${*:-passthrough wholeseg wholeseg-raw empty-pair-collapse dq-backslash open-quote-guard len-bound span-bound meta-reject gh-extra-always odd-trailing-bs lho-reset-each-line lho-no-reset-on-close lho-frame-close-paren lho-hash-class-paren lho-herestring-skip lho-iq-bail lho-ansi-c-arm lho-ansi-c-in-dq lho-ol-check lho-hash-break lho-brace-skip lho-arith-skip lho-arith-landing lho-paren-pop-restore lho-bare-paren-push lho-subst-push-save-iq lho-backtick-arm lho-terminated-guard hw-stop-at-quote hw-drop-inner-quote hw-unquoted-latch hw-bail-not-sticky hw-flush-line-regex hw-stop-at-dquote hw-dq-backslash hw-backslash-arm hw-toplevel-any-word hw-toplevel-ident-only ptag-paren-close ptag-keep-delimiter ptag-trim-both ptag-paren-clause bs-parity bs-arm-off ptag-latch-off lho-frame-close-not-sticky lho-hash-class-bt pending-tag-restore}"
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
