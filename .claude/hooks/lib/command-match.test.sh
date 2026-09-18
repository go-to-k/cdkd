#!/usr/bin/env bash
# Smoke test for lib/command-match.sh (issue #1455).
#
# The gate hooks each have their own smoke test; this one pins the SHARED
# matcher directly, so a regression is reported once and precisely instead of
# as a scatter of failures across thirteen hook tests.
#
# Run from the repo root: `bash .claude/hooks/lib/command-match.test.sh`.

set -u

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/command-match.sh"

MERGE='gh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+pr[[:space:]]+merge([[:space:]]|$|[|;&`)])'
COMMIT='git([[:space:]]+(-[^[:space:]]+([[:space:]]+[^[:space:]-][^[:space:]]*)?))*[[:space:]]+commit([[:space:]]|$|[|;&`)])'

pass=0
fail=0
fail_log=""

check() { # name, want (0=matches, 1=does not), verb, command
  local name="$1" want="$2" verb="$3" cmd="$4" got
  if cmd_matches_verb "$cmd" "$verb"; then got=0; else got=1; fi
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$name"
  else
    fail=$((fail + 1)); printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
    fail_log+="FAIL $name\n  command: $cmd\n"
  fi
}

# --- Command position: the shapes the old line-start anchor MISSED ---------
check "plain invocation" 0 "$MERGE" "gh pr merge 1 --squash"
check "leading cd && (previously the only tolerated chain)" 0 "$MERGE" "cd /tmp/x && gh pr merge 1"
check "after && (the shape that motivated #1455)" 0 "$MERGE" "git push && gh pr merge 1"
check "after ||" 0 "$MERGE" "false || gh pr merge 1"
check "after ;" 0 "$MERGE" "echo done; gh pr merge 1"
check "after a pipe" 0 "$MERGE" "true | gh pr merge 1"
check "on a later line" 0 "$MERGE" "$(printf 'git push\ngh pr merge 1\n')"
check "gh -C <path> form after a chain" 0 "$MERGE" "git status && gh -C /tmp/w pr merge 1"
check "git commit after a chain" 0 "$COMMIT" "vp run test && git commit -m x"

# --- Quoted spans: the false positives the anchor originally guarded ------
check "double-quoted mention" 1 "$MERGE" 'echo "next step: gh pr merge --squash"'
check "single-quoted mention" 1 "$MERGE" "echo 'next step: gh pr merge --squash'"
check "quoted mention AFTER a chain operator" 1 "$MERGE" 'git status && echo "then: gh pr merge"'
check "quoted mention with an inner chain operator" 1 "$MERGE" 'echo "run: git push && gh pr merge"'
check "gh issue body quoting the verb" 1 "$MERGE" 'gh issue create --body "do gh pr merge after CI"'

# --- Heredoc bodies -------------------------------------------------------
#
# Not a hypothetical: the commit that introduced this helper was blocked by
# integ-broad-gate because its own message body explained the bug by quoting a
# chained merge command. A heredoc body is not shell-quoted, so quote-stripping
# alone leaves it and prose reads as an invocation.
heredoc_msg=$(printf '%s\n' \
  "git commit -q -F - <<'EOF'" \
  "fix(hooks): match verbs in command position" \
  "" \
  "A \`vp run build && gh pr merge 123 --squash\` would have skipped the gates." \
  "EOF")
check "heredoc message body quoting a chained merge" 1 "$MERGE" "$heredoc_msg"

heredoc_dash=$(printf '%s\n' \
  "git commit -F - <<-EOF" \
  "  see: foo && gh pr merge 1" \
  "  EOF")
check "heredoc <<- with an indented terminator" 1 "$MERGE" "$heredoc_dash"

heredoc_unquoted=$(printf '%s\n' \
  "git commit -F - <<EOF" \
  "body: git push && gh pr merge 2" \
  "EOF")
check "unquoted heredoc delimiter" 1 "$MERGE" "$heredoc_unquoted"

heredoc_then_real=$(printf '%s\n' \
  "git commit -F - <<'EOF'" \
  "an ordinary message" \
  "EOF" \
  "gh pr merge 7 --squash")
check "real invocation on a line AFTER the heredoc is still caught" 0 "$MERGE" "$heredoc_then_real"

# The heredoc-opening line itself carries a real command and must be kept.
check "the heredoc-opening line's own verb is still seen" 0 "$COMMIT" "$heredoc_msg"

# --- Heredoc bodies INSIDE a command substitution (go-to-k/cdkd#3040) -------
#
# The top-level `tag` latch never saw these: a `$(` still open at end of line
# makes run() JOIN the following lines with `;` into one logical line BEFORE
# any heredoc is recognised, so the body lines arrived in drain_extra as
# `;`-separated commands of the substitution. Measured live: `gh issue create
# --body "$(cat <<'EOF' ... EOF)"` whose prose quoted `gh pr merge` was refused
# by integ-local-gate, and the issue could only be filed via `--body-file`.
subst_heredoc_prose=$(printf '%s\n' \
  'gh issue create --repo o/r --title "t" --body "$(cat <<'"'"'EOF'"'"'' \
  '## What happened' \
  'so `gh pr merge` is not gated by the scope regex.' \
  'EOF' \
  ')"')
check "a heredoc body inside \$( ) is data, not commands" 1 "$MERGE" "$subst_heredoc_prose"

# The body was extracted as commands AND its backtick spans were then taken as
# nested substitutions -- two segments reading `gh pr merge`. Both gone.
subst_heredoc_bt=$(printf '%s\n' \
  'x="$(cat <<'"'"'EOF'"'"'' \
  'run `gh pr merge 1` then `gh pr merge 2`' \
  'EOF' \
  ')"')
check "backticks inside that body are not substitutions either" 1 "$MERGE" "$subst_heredoc_bt"

# The fail-CLOSED half, each the direction that would silently disarm a gate:
# a real verb AFTER the terminator inside the same substitution is still seen,
# a real verb on the SAME line after the substitution closes is still seen, and
# an opener with NO terminator latches nothing (the prose after it is scanned).
subst_heredoc_then_real=$(printf '%s\n' \
  'x="$(cat <<'"'"'EOF'"'"'' \
  'prose' \
  'EOF' \
  'gh pr merge 7 --squash)"')
check "a verb after the terminator, still inside \$( ), is caught" 0 "$MERGE" "$subst_heredoc_then_real"

subst_heredoc_same_line=$(printf '%s\n' \
  'x="$(cat <<'"'"'EOF'"'"'' \
  'prose' \
  'EOF' \
  ')" && gh pr merge 1')
check "a verb after the substitution closes is caught" 0 "$MERGE" "$subst_heredoc_same_line"

subst_unterminated=$(printf '%s\n' \
  'x="$(echo <<EOF is prose' \
  'gh pr merge 1)"')
check "an unterminated opener inside \$( ) does not swallow" 0 "$MERGE" "$subst_unterminated"
# The case above spells its opener UNQUOTED, which since round 2 never reaches
# the terminator look-ahead at all (an unquoted opener is a bail on its own),
# so it stopped fencing that guard -- code review round 3 measured the guard
# deleted with the suite green. This QUOTED twin is the fence: bash 3.2 runs
# the commit (no terminator, the `)` closes the substitution), and with
# `terminated()` no longer consulted the latch swallows it.
subst_unterminated_q=$(printf '%s\n' \
  'x=$(cat <<'"'"'X'"'"'' \
  'body' \
  ')' \
  'git commit -m y')
check "a QUOTED opener with no terminator is not latched (terminated() guard)" 0 "$COMMIT" "$subst_unterminated_q"

# --- Security review of go-to-k/cdkd#3040: three shapes bash RUNS that the ---
# --- first cut of the body-skip swallowed. Each was measured with a stub  ---
# --- `git` on PATH: real bash executes the verb, origin/main matched it,  ---
# --- and the first cut answered NO MATCH -- a NEW fail-open.             ---
#
# S1: with an UNQUOTED delimiter the body undergoes expansion, so the `$( )`
# inside it executes. Round 2 settled HOW this stays matched: an unquoted
# delimiter is never latched at all (see the block further down), so the body
# is read as commands and the substitution is scanned on the ordinary path.
# The quoted twin (S1q) is the control: no expansion, so dropped.
subst_unquoted_expands=$(printf '%s\n' \
  'x="$(cat <<EOF' \
  '$(git commit -m y)' \
  'EOF' \
  ')"')
check "S1: \$( ) in an UNQUOTED-delimiter body inside \$( ) is run, so it matches" 0 "$COMMIT" "$subst_unquoted_expands"
subst_quoted_no_expand=$(printf '%s\n' \
  'x="$(cat <<'"'"'EOF'"'"'' \
  '$(git commit -m y)' \
  'EOF' \
  ')"')
check "S1q: the same body under a QUOTED delimiter is not expanded, so it does not" 1 "$COMMIT" "$subst_quoted_no_expand"

# S2 / S2b: the opener scan must see the PHYSICAL line, not the joined `$(`
# text. Scanning the join re-found an opener whose heredoc had already closed,
# and any bare delimiter line still ahead -- a second same-delimiter heredoc in
# the substitution, or a top-level one after the `)` -- satisfied the
# look-ahead, so the latch swallowed the real commands in between.
subst_two_heredocs=$(printf '%s\n' \
  'out=$(' \
  'cat <<'"'"'EOF'"'"'' \
  'm1' \
  'EOF' \
  'echo start' \
  'git push origin HEAD' \
  'cat <<'"'"'EOF'"'"'' \
  'm2' \
  'EOF' \
  ')')
check "S2: a verb between two same-delimiter heredocs in one \$( ) is caught" 0 "$GATE_RE_GIT_PUSH" "$subst_two_heredocs"
subst_then_toplevel_heredoc=$(printf '%s\n' \
  'x="$(cat <<'"'"'EOF'"'"'' \
  'a' \
  'EOF' \
  'echo start' \
  'git commit -m y' \
  ')"' \
  'cat <<'"'"'EOF'"'"'' \
  'b' \
  'EOF')
check "S2b: a verb inside \$( ) is caught when a top-level heredoc follows the )" 0 "$COMMIT" "$subst_then_toplevel_heredoc"

# S3 / S3d: the opener scan is quote-aware. A `<<X` INSIDE a quoted span on the
# opener line plus a bare `X` line later is prose, not a heredoc, and the verb
# between them runs.
subst_quoted_mention_sq=$(printf '%s\n' \
  'x="$(echo '"'"'<<X'"'"'' \
  'git commit -m y' \
  'X' \
  ')"')
check "S3: a single-quoted <<X mention on the opener line is not an opener" 0 "$COMMIT" "$subst_quoted_mention_sq"
subst_quoted_mention_dq=$(printf '%s\n' \
  'x="$(echo "see <<X"' \
  'git commit -m y' \
  'X' \
  ')"')
check "S3d: a double-quoted <<X mention on the opener line is not an opener" 0 "$COMMIT" "$subst_quoted_mention_dq"

# --- Round 2 (security + code review): the quote walk needs a STACK. ---------
# A single saved outer state, restored only at depth 0, lost the `"` on the way
# out of a NESTED substitution -- so a `"<<X"` still inside bash's double-quoted
# string read as an opener, and with a bare `X` later the commit between was
# dropped. Each below: bash runs the commit, origin/main matched, the round-1
# cut did not. The quoting is now pushed per `$(` / bare `(` and popped at the
# matching `)`; a backtick saves and restores across its own span; `$'` is
# ANSI-C only outside double quotes; `${...}` / `$((...))` are skipped whole;
# a `#` at word start ends the scan; and an opener followed by a NEW `$(` still
# open at end of line is discarded, because bash defers that body until the
# substitution closes (1g).
r2_case() { # <label> <expect> <line1> [line2...]  -- lines joined by newline
  local label="$1" want="$2"; shift 2
  check "$label" "$want" "$COMMIT" "$(printf '%s\n' "$@")"
}
r2_case "1c2: a backtick inside double quotes before \"<<X\" keeps the dq state" 0 \
  'x="$(echo "`echo hi`" "<<X"' 'git commit -m y' 'X' ')"'
r2_case "1d2: a nested \$( ) inside double quotes before \"<<X\" keeps the dq state" 0 \
  'x="$(echo "$(echo a)" "<<X"' 'git commit -m y' 'X' ')"'
r2_case "1e3b: a bare subshell ( ) inside \$( ) does not close the substitution early" 0 \
  'x="$( (echo a); echo "<<X"' 'git commit -m y' 'X' ')"'
r2_case "1g: a quoted opener followed by a NEW \$( open at end of line is not latched" 0 \
  'a=$(echo a) && cat <<'"'"'X'"'"' && b=$(' 'git commit -m y' 'X' 'echo b)'
r2_case "q2i: a backtick substitution whose dq text holds \$(true) <<X" 0 \
  'x=`echo "$(true) <<X"' 'git commit -m y' 'X' '`'
r2_case "q2j: \$'a' inside double quotes is not ANSI-C, so the later \"<<X\" is still quoted" 0 \
  'x="$(echo "$'"'"'a'"'"'" "<<X"' 'git commit -m y' 'X' ')"'
r2_case "q3c: a multi-line \$( inside an UNQUOTED body is scanned (body not latched)" 0 \
  'x="$(cat <<EOF' '$(' 'git commit -m y' ')' 'EOF' ')"'
r2_case "4a: a literal <<Y on an unquoted body line cannot become the latch" 0 \
  'x="$(cat <<EOF' 'see $(true) <<Y' 'EOF' 'git commit -m y' 'Y' ')"'
r2_case "#-comment: a <<X after # on the opener line is not an opener" 0 \
  'x="$(echo a # <<X' 'git commit -m y' 'X' ')"'
r2_case "\${...}: a <<X inside a parameter expansion is not an opener" 0 \
  'x="$(echo ${y:-<<X}' 'git commit -m y' 'X' ')"'
r2_case "\$((...)): a <<X inside arithmetic is not an opener" 0 \
  'x="$(echo $((1<<X))' 'git commit -m y' 'X' ')"'
# C1 (test review round 2): the `)` of a CLOSED substitution must restore the
# enclosing double quote, so the `<<X` after it is still quoted text and the
# NEW `$(cat` at end of line is where the next lines belong. The one survivor
# of the author's own mutation set: with the restore arm deleted the commit
# was dropped -- a fail-open -- and no case saw it.
r2_case "C1: a <<X after a closed \$( ) inside double quotes is still quoted" 0 \
  'x="$(true) <<X $(cat' 'git commit -m y' 'X' ')"'
# B1 (test review round 2, re-pinned in round 14): the backtick arm keeps the
# quote STATE right across a backtick span -- with it deleted, the `"` after
# the backtick was read as closing the dq and the line bailed on the
# unbalanced quote. What the arm no longer does is LATCH a heredoc opened
# inside a backtick frame: bash delimits a backtick substitution textually,
# so a `\`foo\`` mention on a body line closes it and the rest of the body
# runs (security round 14, all three shells; P01 / P03 below). The scan
# therefore reads NOTHING inside a backtick frame (round 16) -- the opener
# is never seen -- and its prose body is read as commands: origin/main
# parity, a false refusal, never a miss. A backtick frame still open at the
# end of the opener's line (opened AFTER the opener) is the end-of-line
# check's job (`lho-ol-check`).
check "B1: a quoted heredoc inside a backtick substitution inside double quotes is read as commands (parity)" 0 "$MERGE" \
  "$(printf '%s\n' 'x="`cat <<'"'"'EOF'"'"'' 'gh pr merge 1 was refused' 'EOF' '`"')"
check "P03: a backtick mention on a body line closes the backtick substitution, and the line after it runs" 0 "$MERGE" \
  "$(printf '%s\n' 'gh issue create --repo o/r --title t --body "`cat <<'"'"'E'"'"'' 'see `foo` first' 'gh pr merge 1 was refused' 'E' '`"')"
check "P01: the same without the enclosing double quotes" 0 "$MERGE" \
  "$(printf '%s\n' 'x=`cat <<'"'"'E'"'"'' 'see `foo` first' 'gh pr merge 1 was refused' 'E' '`')"

# --- The QUOTED-delimiter twins of the arms above (round 2, author's matrix) --
# Once the latch became quoted-only, every bare `<<X` case above answers 0
# whatever the scan does -- a bare word is never an opener -- so seven of the
# nine arms survived deletion with the suite green. Each arm below is fenced by
# the spelling it actually decides: a QUOTED delimiter that bash does NOT read
# as a heredoc (comment / `${}` / `$(( ))` / `$'` inside dq -- verified by
# running each shape), where the deleted arm latches and drops the commit; and
# for the stack arms, a REAL heredoc after a `)` that must restore the outer
# quoting, where the deleted arm reads `; cat <<'X'` as quoted text and scans
# the body as commands. Deleting an arm reds exactly its case.
# Two of the arms share one case: `$(` SAVES the enclosing quote and `)`
# RESTORES it, and `stack pop` reds when either half goes; there is no shape
# that tells the halves apart, since a save nobody restores is a no-op.
# The `$'` twin carries a trailing `# ... "` on purpose: with the arm deleted
# the scan leaves the string one `"` early, so every later `"` flips parity and
# the line ends inside a quote -- which the bail-on-doubt answers with "no
# opener", the same verdict as the intact arm. Only a `#` the intact scan stops
# at, holding one `"` the deleted arm keeps reading, re-syncs the two and
# makes the fail-open observable (bash 5 and zsh run the commit; bash 3.2
# rejects the line as a syntax error and runs nothing -- safe either way). Both this
# twin and the `${}` one carry a SPACE after the delimiter: round 6 added a
# word-boundary bail (`<<\047EOF\047x` is delimiter `EOFx`), and a `"` or
# `}` right after the closing quote now bails before either arm is asked.
r2_case "#-comment (quoted): a <<'X' after # on the opener line is not an opener" 0 \
  'x="$(echo a # <<'"'"'X'"'"'' 'git commit -m y' 'X' ')"'
r2_case "\${...} (quoted): a <<'X' inside a parameter expansion is not an opener" 0 \
  'x="$(echo ${y:-<<'"'"'X'"'"' }' 'git commit -m y' 'X' ')"'
r2_case "\$((...)) (quoted): a <<\"2\" inside arithmetic is a shift, not an opener" 0 \
  'x="$(echo $((1<<"2"))' 'git commit -m y' '2' ')"'
# The `$((` skip's fail-open twin is now caught by the frame-close bail (round
# 3: a `)` at or below the opener frame), so what the arm still decides is the
# REFUSING direction: a bare `<<` shift inside arithmetic ahead of a real
# quoted opener must not trip the unquoted-opener bail and turn the body
# back into commands. Deleting the arm reds this case alone.
check "\$((...)) (bare shift): \$((1<<2)) before a quoted opener is arithmetic, not an unquoted opener" 1 "$MERGE" \
  "$(printf '%s\n' 'x="$(echo $((1<<2)); cat <<'"'"'EOF'"'"'' 'gh pr merge 1 was refused' 'EOF' ')"')"
r2_case "\$'a' (quoted): \$' inside double quotes is literal, so the <<'X' after it is still quoted" 0 \
  'x="$(echo "$'"'"'a'"'"' <<'"'"'X'"'"' " # the comment holds one "' 'git commit -m y' 'X' ')"'
check "stack pop: the ) of a nested \$( ) inside dq restores the dq, so the ; cat <<'X' after the closing quote is a real opener" 1 "$MERGE" \
  "$(printf '%s\n' 'x="$(echo "$(true)" ; cat <<'"'"'X'"'"'' 'gh pr merge 1 was refused' 'X' ')"')"
check "stack push: a bare ( ) inside \$( ) pushes its own frame, so its ) does not pop the \$( frame" 1 "$MERGE" \
  "$(printf '%s\n' 'x="$( (echo a); cat <<'"'"'X'"'"'' 'gh pr merge 1 was refused' 'X' ')"')"

# --- Round 3 (security + code + test review): the FRAME, not the depth -------
# Every shape below was measured through real bash with a stub `git` on PATH:
# bash runs the verb, origin/main matched, and the round-2 cut answered NO
# MATCH. All are fail-opens in the shared matcher; the fix for each is named.
#
# Security: two openers on one line, the FIRST unquoted. bash reads the bodies
# in order and EXPANDS the unquoted one, so a `$(git commit)` on an A-body line
# runs; the scan recorded only the last QUOTED delimiter (B) and the latch
# dropped every line through B, the expanded body included. An unquoted opener
# anywhere on the line is now a bail (`return ""`), not merely "not recorded".
r3_case() { local label="$1" want="$2" re="$3"; shift 3; check "$label" "$want" "$re" "$(printf '%s\n' "$@")"; }
r3_case "d01: unquoted A then quoted B on one line -- verb in the EXPANDED A body" 0 "$COMMIT" \
  'x=$(cat <<A <<'"'"'B'"'"'' '$(git commit -m y)' 'A' 'bbb' 'B' ')'
r3_case "d02: same, a backtick push in the A body" 0 "$GATE_RE_GIT_PUSH" \
  'x=$(cat <<A <<'"'"'B'"'"'' '`git push origin main`' 'A' 'bbb' 'B' ')'
r3_case "d07: same, a decoy line before the verb in the A body" 0 "$COMMIT" \
  'x=$(cat <<A <<'"'"'B'"'"'' 'notdelim' '$(git commit -m x)' 'A' 'bbb' 'B' ')'
r3_case "d03: quoted A then unquoted B -- the unquoted one is a bail wherever it sits" 0 "$COMMIT" \
  'x=$(cat <<'"'"'A'"'"' <<B' 'aaa' 'A' '$(git commit -m y)' 'B' ')'
r3_case "d04: two QUOTED openers -- both bodies are still data (control)" 1 "$MERGE" \
  'x=$(cat <<'"'"'A'"'"' <<'"'"'B'"'"'' 'gh pr merge 1 was refused' 'A' 'gh pr merge 2 was refused' 'B' ')'
r3_case "d05: two QUOTED openers, verb after both terminators is still a segment" 0 "$MERGE" \
  'x=$(cat <<'"'"'A'"'"' <<'"'"'B'"'"'' 'aaa' 'A' 'bbb' 'B' 'gh pr merge 1)'
# Code review: the `ol` bail compared NET depth, so a line whose opener FRAME
# closes and then opens another `$(` ended at the recorded depth and latched.
# Which shell reads the next line as the new substitution and which as the
# heredoc body is VERSION-DEPENDENT (bash 3.2 and zsh run the commit, bash 5
# reads a body; the backtick twin runs it in all three), so the scan bails
# the moment the opener frame closes -- a `)` at or below the recorded depth
# -- rather than modelling it; an opener inside a backtick frame is never
# seen at all (round 14; the frame is skipped whole since round 16), so the
# backtick half of this rule is gone.
r3_case "c1: opener frame closes, a new \$( opens -- \$( form" 0 "$COMMIT" \
  'y=$(cat <<'"'"'EOF'"'"') ; z=$(' 'git commit -m y' 'EOF' ')'
r3_case "c1b: opener frame closes, a new \$( opens -- backtick form (a CONTROL: no mutant of the matrix reds it)" 0 "$COMMIT" \
  'y=`cat <<'"'"'EOF'"'"'` ; z=$(' 'git commit -m y' 'EOF' ')'
r3_case "c1c: a NESTED opener frame closes while the outer stays open" 0 "$COMMIT" \
  'x=$(echo $(cat <<'"'"'X'"'"')' 'git commit -m y' 'X' ')'
# Code review: `)#` starts a comment like ` #` does -- measured on bash 3.2.57,
# bash 5 and zsh alike (a round-4 report said 3.2 rejects it; round 6
# re-measured and it runs). The class had every separator but `)`.
r3_case "c2: a # right after ) is a comment, so the quoted <<X in it is not an opener" 0 "$COMMIT" \
  'x="$( (echo a)# <<'"'"'X'"'"'' 'git commit -m y' 'X' ')"'
# Code review: two arms that existed and were fenced by nothing -- the `<<<`
# here-string skip and the unbalanced-quote bail. Deleting either was green.
r3_case "c3a: a here-string <<<'X' is not an opener" 0 "$COMMIT" \
  'x=$(cat <<<'"'"'X'"'"'' 'git commit -m y' 'X' ')'
# Since round 7 an unreadable word bails anyway, so c3a passes with the `<<<`
# skip deleted; what the skip still decides is the REFUSING direction -- a
# here-string ahead of a real quoted heredoc must not bail the body back
# into commands. Deleting the skip reds this case alone.
check "c3a2: a here-string before a real quoted heredoc on the same line does not bail its body" 1 "$MERGE" \
  "$(printf '%s\n' 'x=$(cat <<<'"'"'X'"'"' ; cat <<'"'"'Y'"'"'' 'gh pr merge 1 was refused' 'Y' ')')"
r3_case "c3b: a quoted opener followed by an UNBALANCED double quote is a bail" 0 "$COMMIT" \
  'x=$(cat <<'"'"'X'"'"' "' 'abc' '" ; git commit -m y' 'X' ')'
# Test review: the round-2 `$'` twin fenced the dq CONDITION of the ANSI-C arm
# and not the arm: with the whole arm deleted, `$'a\''` read as a plain
# single-quoted span one quote out of phase, the `'<<'X'` after it read as an
# opener, and a trailing `# '` re-synced the parity so the line did not bail.
r3_case "t1: \$'a\\'' is ANSI-C, so the '<<' after it is a quoted span, not an opener" 0 "$COMMIT" \
  'x="$(echo $'"'"'a\'"'"''"'"' '"'"'<<'"'"'X'"'"' # '"'"'' 'git commit -m y' 'X' ')"'

# --- Round 4 (security review): the scan must CARRY state across lines -----
# Round 3 scanned each physical line of an open `$( )` on its own, so every
# bail it added held for one line only. bash carries the lexer state across
# lines: an unquoted opener on line 1 makes line 2 onward its EXPANDED body;
# a quote or backtick left open at the end of line 1 makes a `<<'X'` on line
# 2 data; a nested `$(` opened on line 1 is what the `)` on line 2 closes.
# Each of these latched from the fresh line-2 scan and dropped a verb bash
# runs (measured through a stub `git`; origin/main matched all five). The
# scan now reads every physical line of the open substitution and records an
# opener only from the LAST one.
r3_case "s1: an unquoted opener on line 1 -- the quoted opener on line 2 is inside its expanded body" 0 "$COMMIT" \
  'x=$(cat <<A' 'cat <<'"'"'B'"'"'' '$(git commit -m y)' 'A' 'B' ')'
r3_case "s2: same, a backtick push in the A body" 0 "$GATE_RE_GIT_PUSH" \
  'x=$(cat <<A' 'cat <<'"'"'B'"'"'' '`git push origin main`' 'A' 'B' ')'
r3_case "s3: a double quote left open on line 1 makes the <<'X' on line 2 data" 0 "$COMMIT" \
  'x=$(echo "abc' '<<'"'"'X'"'"' "a"' '" ; git commit -m y ; echo "' 'X' '")'
r3_case "s4: a single quote left open on line 1 makes the <<\"X\" on line 2 data" 0 "$COMMIT" \
  'x=$(echo '"'"'abc' '<<"X" '"'"'a'"'"'' ''"'"' ; git commit -m y ; echo '"'"'' 'X' ''"'"')'
r3_case "s5: a backtick left open on line 1 makes the <<'X' on line 2 data" 0 "$COMMIT" \
  'x=$(echo `abc' '<<'"'"'X'"'"' `a`' '` ; git commit -m y ; echo `' 'X' '`)'
r3_case "s6: a nested \$( opened on line 1 is closed by the ) after the opener on line 2" 0 "$COMMIT" \
  'x=$(echo $(cat' '<<'"'"'X'"'"')' 'git commit -m y' 'X' ')'
# Controls for the carried scan: an earlier line's `#` comment ends at ITS
# newline, so the quoted opener on the next line still latches; and a quoted
# heredoc that already closed on an earlier line is not re-found by the scan
# of the accumulated text (the round-1 S2 shape, kept green here on purpose).
check "s7: a # comment on line 1 of the substitution does not swallow line 2's real opener" 1 "$MERGE" \
  "$(printf '%s\n' 'x=$(echo a # not an opener' "cat <<'EOF'" 'gh pr merge 1 was refused' 'EOF' ')')"
check "s8: a quoted heredoc closed on an earlier line is not re-found -- the push after it is a segment" 0 "$GATE_RE_GIT_PUSH" \
  "$(printf '%s\n' 'out=$(' "cat <<'EOF'" 'm1' 'EOF' 'git push origin HEAD' ')')"

# Code review round 4: the `#` class had `)` (round 3) but not the backtick,
# so `` x=`#<<'X' `` read the comment as an opener inside the backtick frame
# and latched it -- all three shells run the commit. Round 14 retired that
# class member, and since round 16 nothing inside a backtick frame is read
# at all, so this case pins that skip.
r3_case "s10: a <<'X' after # inside a backtick frame is not latched (the frame is skipped)" 0 "$COMMIT" \
  'x=`#<<'"'"'X'"'"'' 'git commit -m y' 'X' '`'
# The carried state is per SUBSTITUTION: it resets when a line closes one, so
# the sticky unquoted-opener bail from a first `$( )` does not leak into a
# later one and turn its quoted body back into commands.
check "s11: the sticky bail from a closed substitution does not leak into the next one" 1 "$MERGE" \
  "$(printf '%s\n' 'x=$(cat <<A' 'body' 'A' ')' "y=\$(cat <<'B'" 'gh pr merge 1 was refused' 'B' ')')"

# --- Round 6 (/review-pr 3-axis + security): pending_tag and the delimiter WORD
# Security: this latch WIDENED go-to-k/cdkd#3066. A `cat <<EOF` in a flushed
# substitution body sets the GLOBAL `pending_tag`; run() then tests it for the
# ENCLOSING line, and terminated() finds the bare `EOF` of any LATER top-level
# heredoc, so every line between -- a real `git push` -- is dropped as that
# body. origin/main had it for a plain body; a body carrying a backtick or
# `$(` went through drain_extra there and the verb after the `)` was still
# matched, while the latch dropped that body and lost the match (bash 3.2,
# 5 and zsh all run the push; main MATCH, the round-5 tree NOMATCH).
# drain_extra now saves and restores `pending_tag` the way it does `q`, which
# is the fix #3066 itself asked for and closes both variants.
r3_case "f01: a backtick in a quoted body, then a LATER top-level heredoc reusing the delimiter -- the push between is a segment" 0 "$GATE_RE_GIT_PUSH" \
  'x="$(cat <<'"'"'E'"'"'' '`echo z`' 'E' ')"' 'git push origin main' 'cat <<E' 'zz' 'E'
r3_case "y5: same, gh pr merge between" 0 "$MERGE" \
  'x="$(cat <<'"'"'E'"'"'' '`echo z`' 'E' ')"' 'gh pr merge 1 --squash' 'cat <<E' 'zz' 'E'
r3_case "zA: #3066 with a plain quoted body -- pre-existing on origin/main, closed here" 0 "$GATE_RE_GIT_PUSH" \
  'x="$(cat <<'"'"'E'"'"'' 'prose' 'E' ')"' 'git push origin main' 'cat <<E' 'zz' 'E'
r3_case "3066: the issue shape itself, UNQUOTED body, commit before a later top-level heredoc" 0 "$COMMIT" \
  'x=$(cat <<EOF' 'p' 'EOF' ')' 'git commit -m x' 'cat <<EOF' 'q' 'EOF'
check "3066 control: the later top-level heredoc body is still data" 1 "$MERGE" \
  "$(printf '%s\n' 'x="$(cat <<'"'"'E'"'"'' 'prose' 'E' ')"' 'cat <<E' 'gh pr merge 1 was refused' 'E')"
# Code review rounds 6 and 7: the delimiter is the whole WORD as bash reads it
# after quote removal (`heredoc_word`). `<<'EOF'x` is `EOFx` -- bash 3.2 and 5
# run the line after a decoy `EOF` -- and `<<"EO"F` is `EOF`, so the line
# after a decoy `EO` is still body; the round-2 regex took the quoted span
# alone. `<<'a"b'` is `a"b` with the inner quote kept -- stripping every
# quote made it `ab`, which the body's prose then terminated early. All three
# are MODELLED now rather than bailed, so a body under such a delimiter stays
# data (P2, P3) instead of being refused as commands. Shells measured: P1 runs
# the commit on bash 3.2, 5 and zsh; P2 and P3 run nothing on any of them
# (P3 is a syntax error on 3.2).
r3_case "P1: <<'EOF'x -- the delimiter is EOFx, so a bare EOF line is not the terminator" 0 "$COMMIT" \
  'x=$(cat <<'"'"'EOF'"'"'x' 'body' 'EOFx' 'git commit -m y' 'EOF' ')'
check "P2: <<\"EO\"F -- the delimiter is EOF, so a decoy EO line does not end the body before the verb" 1 "$MERGE" \
  "$(printf '%s\n' 'x=$(cat <<"EO"F' 'body' 'EO' 'gh pr merge 1 was refused' 'EOF' ')')"
check "P2t: the top-level twin of P2" 1 "$MERGE" \
  "$(printf '%s\n' 'cat <<E"O"F $(echo y)' 'p' 'EO' 'gh pr merge 1 was refused' 'EOF')"
check "P3: <<'a\"b' keeps the inner quote, so an ab line does not end the body early" 1 "$MERGE" \
  "$(printf '%s\n' 'x=$(cat <<'"'"'a"b'"'"'' 'body' 'ab' 'gh pr merge 1 was refused' 'a"b' ')')"
# Round 7 (/review-pr, second pass). Security + code: the TOP-LEVEL arm in
# flush_line had the same two defects, and the round-6 pending_tag restore
# made them reachable where drain_extra used to reset the wrong tag by
# accident -- `cat <<'EOF'x $(echo y)` set `pending_tag = EOF`, and a later
# bare `EOF` swallowed the push between (all three shells run it; origin/main
# matched). Both arms read the word through heredoc_word now.
r3_case "D5: top-level <<'EOF'x with a substitution on the line -- the push before a later bare EOF is a segment" 0 "$GATE_RE_GIT_PUSH" \
  'cat <<'"'"'EOF'"'"'x $(echo y)' 'p' 'EOFx' 'git push' 'cat <<'"'"'EOF'"'"'' 'q' 'EOF'
r3_case "D7: top-level <<EOF.x -- not an identifier, so nothing is latched and the push after the body is a segment" 0 "$GATE_RE_GIT_PUSH" \
  'cat <<EOF.x $(echo y)' 'p' 'EOF.x' 'git push' 'cat <<'"'"'EOF'"'"'' 'q' 'EOF'
r3_case "D8: top-level <<E\"O\"F -- quote removal gives EOF" 0 "$GATE_RE_GIT_PUSH" \
  'cat <<E"O"F $(echo y)' 'p' 'EOF' 'git push' 'cat <<'"'"'E'"'"'' 'q' 'E'
r3_case "D9: top-level <<-'EOF'x" 0 "$GATE_RE_GIT_PUSH" \
  'cat <<-'"'"'EOF'"'"'x $(echo y)' 'p' 'EOFx' 'git push' 'cat <<'"'"'EOF'"'"'' 'q' 'EOF'
check "D-ctl: a top-level <<'EOF'x body is still data" 1 "$MERGE" \
  "$(printf '%s\n' 'cat <<'"'"'EOF'"'"'x' 'gh pr merge 1 was refused' 'EOFx')"
check "D-bs: <<\\EOF is a quoted delimiter EOF, body is data" 1 "$MERGE" \
  "$(printf '%s\n' 'x=$(cat <<\EOF' 'gh pr merge 1 was refused' 'EOF' ')')"
# Test review: a delimiter the walk cannot read has no modelled body end, so
# its bail is STICKY like the unquoted one -- a per-line bail let a <<'B' on
# the next line, inside that body, latch and drop the verb after the real
# terminator (all three shells run it; origin/main matched).
r3_case "D-sticky: <<'EOF'\$x is unreadable, and the <<'B' on the next line must not latch" 0 "$COMMIT" \
  'x=$(cat <<'"'"'EOF'"'"'$x' 'cat <<'"'"'B'"'"'' 'EOF$x' 'git commit -m y' 'B' ')'
# Test review: the pending_tag restore also REMOVES a false refusal. A heredoc
# opened on the substitution's CLOSING line -- `x=$(echo a) ; cat <<EOF` --
# had its tag cleared by the body flush (flush_line resets pending_tag), so
# the prose after it was read as commands on origin/main.
check "R1: a heredoc opened on the line that closes a substitution keeps its tag through the drain" 1 "$MERGE" \
  "$(printf '%s\n' 'x=$(echo a) ; cat <<EOF' 'gh pr merge 1 was refused' 'EOF')"
# Round 8 (/review-pr, third pass). Security + code: inside double quotes a
# backslash is removed only before `$`, a backtick, `"` or `\` -- `<<"E\xF"`
# is the delimiter `E\xF`, and the round-7 walk gave `ExF`, so a decoy `ExF`
# line ended the latch early and the verb after the real terminator, which
# all three shells run, was dropped (origin/main matched).
r3_case "B1a: <<\"E\\xF\" keeps the backslash -- a decoy ExF line is not the terminator" 0 "$COMMIT" \
  'x=$(cat <<"E\xF"' 'body' 'E\xF' 'git commit -m y' 'ExF' ')'
r3_case "B1b: the top-level twin of B1a" 0 "$GATE_RE_GIT_PUSH" \
  'cat <<"E\xF"' 'body' 'E\xF' 'git push' 'ExF'
check "B1c: a real E\\xF terminator ends the body -- the fix also removes a false refusal (the old walk waited for ExF)" 1 "$MERGE" \
  "$(printf '%s\n' 'x=$(cat <<"E\xF"' 'gh pr merge 1 was refused' 'E\xF' ')')"
# Security: the top-level arm latches an UNQUOTED word only when it is a
# whole identifier; origin/main latched the identifier PREFIX of any word that has one. That arm drops a
# body whatever its quoting, and bash EXPANDS an unquoted body, so `<<EOF.x`
# latched by the round-7 walk dropped a `$(git push)` main still matched.
r3_case "B2a: top-level <<EOF.x is unquoted and not an identifier -- its expanded body is scanned" 0 "$GATE_RE_GIT_PUSH" \
  'cat <<EOF.x' '$(git push)' 'EOF.x'
r3_case "B2b: top-level <<E-x likewise" 0 "$GATE_RE_GIT_PUSH" \
  'cat <<E-x' '$(git push)' 'E-x'
check "B2c: top-level <<'EOF.x' is QUOTED, so its body is data -- fenced by hw-toplevel-ident-only" 1 "$MERGE" \
  "$(printf '%s\n' 'cat <<'"'"'EOF.x'"'"'' 'gh pr merge 1 was refused' 'EOF.x')"
# origin/main latched the identifier PREFIX of `<<EOF.x` -- the tag `EOF` --
# so a later bare `EOF` line dropped the expanded body; B2a has no such line
# and passes on main, this one fences the closed main fail-open.
r3_case "B2d: top-level <<EOF.x with a decoy bare EOF line -- main latched the prefix and dropped the expanded body" 0 "$GATE_RE_GIT_PUSH" \
  'cat <<EOF.x' '$(git push)' 'EOF.x' 'EOF'
# Round 9 (/review-pr, fourth pass). Security: inside `$( )` bash 5 and 3.2
# end BOTH the heredoc and the substitution on a body line that begins with
# the delimiter and carries a `)` -- `E);git commit -m C` runs C, and every
# line after it at top level (zsh keeps reading the body). The latch dropped
# all of it; origin/main matched. Such a line now ends the latch and falls
# through to the join, where its `)` closes the frame.
r3_case "Pc10: a body line E);<verb> closes the heredoc AND the substitution -- both verbs are segments" 0 "$COMMIT" \
  'x=$(cat <<'"'"'E'"'"'' 'body' 'E);git commit -m C' 'git commit -m B' 'E' ')'
r3_case "Pc11: E) && <verb> likewise" 0 "$COMMIT" \
  'x=$(cat <<'"'"'E'"'"'' 'body' 'E) && git commit -m C' 'E' ')'
r3_case "Pc17: E) ; x=\$( -- the verb on the next line is a segment either way" 0 "$COMMIT" \
  'x=$(cat <<'"'"'E'"'"'' 'body' 'E) ; x=$(' 'git commit -m B' 'E' ')'
check "Pc-ctl1: a body line carrying a ) that does not begin with the delimiter is still data" 1 "$MERGE" \
  "$(printf '%s\n' 'x=$(cat <<'"'"'E'"'"'' 'gh pr merge 1 was refused (see #3)' 'E' ')')"
check "Pc-ctl2: a body line beginning with the delimiter but carrying no ) is still data" 1 "$MERGE" \
  "$(printf '%s\n' 'x=$(cat <<'"'"'E'"'"'' 'E;gh pr merge 1' 'E' ')')"
# Round 10: the fall-through hands the join only what FOLLOWS the delimiter.
# A delimiter carrying a quote (`<<"a'b"`) re-lexed as an open quoted span in
# subst_open and folded the verbs after `a'b)` into it -- bash 5 runs both.
r3_case "X5: a delimiter carrying a quote does not re-open a quoted span on the fall-through line" 0 "$COMMIT" \
  'x=$(cat <<"a'"'"'b"' 'body' 'a'"'"'b);git commit -m C' 'git commit -m B' 'a'"'"'b' ')'
check "X5-ctl: the same delimiter over a plain body keeps it data" 1 "$MERGE" \
  "$(printf '%s\n' 'x=$(cat <<"a'"'"'b"' 'gh pr merge 1 was refused' 'a'"'"'b' ')')"
# Round 11: the remainder is sliced from the line with only its LEADING
# whitespace removed. Round 10 sliced the both-sides-trimmed copy, so a closing
# line ending in an escaped space lost it and read as a `\`-continuation that
# glued the verb on the next line onto `echo` (bash 5 and 3.2 run the verb).
r3_case "T1: a closing line ending in an escaped space is not a line continuation" 0 "$MERGE" \
  'x=$(cat <<'"'"'E'"'"'' 'body' 'E);echo \ ' 'gh pr merge 1' 'E' ')'
check "T1-ctl: a closing line ending in a REAL continuation glues the next line -- the verb is an argument (control)" 1 "$MERGE" \
  "$(printf '%s\n' 'x=$(cat <<'"'"'E'"'"'' 'body' 'E);echo \' 'gh pr merge 1' 'E' ')')"
# Round 12 (security): the continuation arm read ANY trailing backslash as a
# continuation. bash continues only on an ODD run -- `echo \\` is an escaped
# backslash and the line ends -- so the verb on the next line, which all three
# shells run, was glued onto `echo` as an argument and no gate saw it. Pre-
# existing on origin/main and independent of heredocs; fixed here because it
# sits beside the arm the last three rounds worked on.
r3_case "E1: an EVEN run of trailing backslashes is not a continuation -- the next line is a command" 0 "$MERGE" \
  'echo \\' 'gh pr merge 1'
r3_case "E2: four trailing backslashes likewise" 0 "$MERGE" \
  'echo \\\\' 'gh pr merge 1'
check "E3: an ODD run is a real continuation, the verb is an argument (control)" 1 "$MERGE" \
  "$(printf '%s\n' 'echo \\\' 'gh pr merge 1')"
r3_case "E4: the same on a closing body line inside \$( )" 0 "$MERGE" \
  'x=$(cat <<'"'"'E'"'"'' 'body' 'E);echo \\' 'gh pr merge 1' 'E' ')'
# Round 15 (security): the frame-close bail returned without scanning the
# rest of the line and without the sticky flag, so a backtick opened AFTER
# the `)` was missing from the carried state; the next line then latched an
# opener that sat inside that backtick, and the body line closing the
# backtick -- which all three shells run -- was dropped. The three early
# returns (frame close, unterminated `$((`, unterminated `${`) are sticky now.
r3_case "X19b: opener frame closes and a backtick opens after it -- the next line's opener is inside the backtick" 0 "$MERGE" \
  'x=$(cat <<'"'"'E'"'"') ; echo `' 'E' 'cat <<'"'"'F'"'"'' '`; gh pr merge 1 --squash' 'F'
r3_case "X19c: the nested-frame twin" 0 "$MERGE" \
  'x=$(echo $(cat <<'"'"'E'"'"') `' 'E' 'cat <<'"'"'F'"'"'' '`; gh pr merge 1' 'F'
# Round 15 (test review), re-pointed in round 16: `x=\`#\`` is a backtick
# frame holding a `#`, and the real quoted heredoc after the frame closes is
# data. Since round 16 nothing inside a frame is read, so what this pins is
# the frame CLOSING on the same line (`lho-bt-skip-off` never closes one and
# reds it); the `#` class member it once fenced is H2's job now.
check "H1: a # right after an opening backtick is not a comment once the backtick closes on the same line" 1 "$MERGE" \
  "$(printf '%s\n' 'y=$(x=`#` ; cat <<'"'"'X'"'"'' 'gh pr merge 1 was refused' 'X' ')')"
# Round 16 (spec, code and test review, one finding): round 15 dropped the
# opener-time backtick bail for the end-of-line check, which sees a backtick
# frame only while it is still OPEN at the end of the line. A backtick that
# closes AFTER the opener on the same line left `lho_bt` at 0 there, the
# opener latched, and all three shells ran the next line (the backtick's
# heredoc has no body: "delimited by end-of-file"). The scan now skips a
# backtick frame wholesale -- textually, the way bash delimits it -- so an
# opener inside one is never seen. Mutant `lho-bt-fallthrough` reads the
# frame's text again and reds X20a / X20b / X20c; Q1 below is `lho-bt-quoted`.
r3_case "X20a: a backtick closing after the opener on the same line -- the opener is inside it" 0 "$MERGE" \
  'x=$(echo `cat <<'"'"'E'"'"' ` ; true' 'gh pr merge 1' 'E' ')'
r3_case "X20b: the assignment twin" 0 "$MERGE" \
  'x=$(y=`cat <<'"'"'E'"'"' `' 'gh pr merge 1' 'E' ')'
r3_case "X20c: the carried-state twin -- the frame opened on the line before" 0 "$MERGE" \
  'x=$(echo `abc' '<<'"'"'X'"'"' `' 'gh pr merge 1' 'X' ')'
# The skip is NOT sticky (test review round 16 asked for this control): a
# backtick frame that closes on a LATER line leaves a plain `$( )`, and a
# real quoted heredoc after the close is data in all three shells.
r3_case "N1: a backtick frame closing on a later line, then a real quoted heredoc -- its body is data" 1 "$MERGE" \
  'x=$(y=`cat <<'"'"'E'"'"'' 'a` ; cat <<'"'"'X'"'"'' 'gh pr merge 1 was refused' 'X' ')'
# Round 16 (security): bash ends a backtick substitution at the next
# unescaped backtick whatever quotes sit inside it, while the scan honoured a
# quote there -- one `'"'"'` inside the frame closed it at the wrong backtick, and
# the line closing bash's quote ran the verb (bash 5.3 and 3.2; zsh does
# not). The skip above reads no quote inside the frame.
r3_case "Q1: a quote inside a backtick frame protects nothing -- the frame ends at the next backtick" 0 "$MERGE" \
  'x=$(echo `a '"'"'`'"'"' `' 'cat <<'"'"'E'"'"'' "' ; gh pr merge 1" 'E' ')'
# Round 16 (security): the `)` closing a `$( )` or a `$(( ))` ends a WORD, so
# a `#` right after it is glued (`$(true)#"` opens a quote bash keeps open
# across lines), while the `)` closing a bare `( )` is an operator and the
# `#` after it a comment -- all three shells, both directions. The scan read
# every `)#` as a comment, stopped, missed the quote, latched the next line's
# opener and dropped the line closing the quote. Mutant `lho-hash-glue`.
r3_case "G1: \$(true)# glues the # -- the quote after it is real" 0 "$MERGE" \
  'x=$(echo $(true)#"' 'cat <<'"'"'E'"'"'' '" ; gh pr merge 1' 'E' ')'
r3_case "G2: \$((1))# glues the # -- the arithmetic close ends a word too" 0 "$MERGE" \
  'x=$(echo $((1))#"' 'cat <<'"'"'E'"'"'' '" ; gh pr merge 1' 'E' ')'
r3_case "G3: the single-quote twin of G1" 0 "$MERGE" \
  'x=$(echo $(true)#'"'" 'cat <<'"'"'E'"'"'' "' ; gh pr merge 1" 'E' ')'
r3_case "G-ctl: (true)# after a BARE subshell is a comment -- the heredoc after it is real (control)" 1 "$MERGE" \
  'x=$( (true)#"' 'cat <<'"'"'E'"'"'' '" ; gh pr merge 1 was refused' 'E' ')'
r3_case "H2: a closing backtick ends a word too -- \`a\`# glues the # (pins the class without the backtick)" 0 "$MERGE" \
  'x=$(echo `a`#"' 'cat <<'"'"'E'"'"'' '" ; gh pr merge 1' 'E' ')'
# Round 16 (security): the `${...}` skip runs to the first `}` whatever
# quotes sit inside, and `${a:-"}` puts that brace inside a double quote
# bash keeps open across lines: the scan reported a clean end of line,
# latched the next opener and dropped the line closing the quote (all three
# shells; the single-quote, backtick and backslash spellings measured the
# same). A quote, backtick or backslash inside the span is the sticky bail.
# Mutant `lho-brace-quote-bail`.
r3_case "K1: \${a:-\"} -- a quote inside the brace span keeps the line open" 0 "$MERGE" \
  'x=$(echo ${a:-"}' 'cat <<'"'"'E'"'"'' '"} ; gh pr merge 1' 'E' ')'
r3_case "K2: the backslash twin" 0 "$MERGE" \
  'x=$(echo ${a:-\}' 'cat <<'"'"'E'"'"'' '} ; gh pr merge 1' 'E' ')'
# One case per class member (test review round 17: deleting the apostrophe or
# the backtick from the class left the suite green while both spellings run
# -- the apostrophe in all three shells, the backtick in both bashes).
r3_case "K3: the single-quote twin" 0 "$MERGE" \
  'x=$(echo ${a:-'"'"'}' 'cat <<'"'"'E'"'"'' "'} ; gh pr merge 1" 'E' ')'
r3_case "K4: the backtick twin" 0 "$MERGE" \
  'x=$(echo ${a:-`}' 'cat <<'"'"'E'"'"'' '`} ; gh pr merge 1' 'E' ')'
r3_case "K-ctl: a plain \${a} before a real quoted heredoc -- its body is data (control)" 1 "$MERGE" \
  'x=$(echo ${a} ; cat <<'"'"'E'"'"'' 'gh pr merge 1 was refused' 'E' ')'
# Round 16 (code and test review): the round-15 sticky flag on an
# unterminated `$((` was unfenced. bash reads `$((1 +` across the line break
# and the heredoc opened after the `))` on the next line as data; the sticky
# bail refuses its prose instead -- origin/main parity, the safe direction --
# and the non-sticky return would pop the outer frame on that `))` and latch
# the opener at depth 0. Mutant `lho-arith-not-sticky`. The `${` twin cannot
# be fenced by a running shape: a `${a` left open at a line end is a bad
# substitution in all three shells, so nothing runs either way.
r3_case "AR1: an arithmetic span left open at the line end is a sticky bail -- the heredoc after its close is read as commands (parity)" 0 "$MERGE" \
  'x=$(echo $((1 +' '2)); cat <<'"'"'X'"'"'' 'gh pr merge 1 was refused' 'X' ')'
# Round 17 (code review): the `#` test read the RAW previous character, but
# an unquoted backslash had already consumed it as a literal -- `\)#"`,
# `\ #"`, `\;#"`, `\(#"` are one word, the `"` is real, and both bashes ran
# the line closing it (W5's `\ #"` on bash 5.3 and zsh; 3.2 rejects it).
# `gp` now records the escaped character too (W1 / W5 / W6 / W7; W-ctl).
# Mutant `lho-bs-glue`.
r3_case "W1: an escaped ) before # is word glue, not a bare-frame close" 0 "$MERGE" \
  'x=$(echo \)#"' 'cat <<'"'"'E'"'"'' '" ; gh pr merge 1' 'E' ')'
r3_case "W5: an escaped space before # is word glue" 0 "$MERGE" \
  'x=$(echo a\ #"' 'cat <<'"'"'E'"'"'' '" ; gh pr merge 1' 'E' ')'
r3_case "W6: an escaped ; before # is word glue" 0 "$MERGE" \
  'x=$(echo a\;#"' 'cat <<'"'"'E'"'"'' '" ; gh pr merge 1' 'E' ')'
r3_case "W7: an escaped ( before # is word glue" 0 "$MERGE" \
  'x=$(echo \(#"' 'cat <<'"'"'E'"'"'' '" ; gh pr merge 1' 'E' ')'
r3_case "W-ctl: an escaped ) then a SPACE before # -- a comment, the heredoc after it is real (control)" 1 "$MERGE" \
  'x=$(echo \) #"' 'cat <<'"'"'E'"'"'' '" ; gh pr merge 1 was refused' 'E' ')'
# Round 17 (code review): the `$(( ))` end was the FIRST `))`, one closer
# short of `$((2*(1+1)))`; the leftover `)` popped the enclosing frame, and
# when that frame was a bare `( )` the `#` after it read as a comment. The
# end is a paren walk now. Mutant `lho-arith-first-close` (A7 reds; A8 stays
# green under it because the leftover `)` pops the outer `$(`, whose kind
# still glues -- kept as the direct spelling's own pin).
r3_case "A7: \$((2*(1+1)))# inside a bare subshell -- the third ) is the arithmetic close, the # is glued" 0 "$MERGE" \
  'x=$( ( $((2*(1+1)))#"' 'cat <<'"'"'E'"'"'' '" ; gh pr merge 1' 'E' ') )'
r3_case "A8: \$((2*(1+1)))# directly inside \$( )" 0 "$MERGE" \
  'x=$(echo $((2*(1+1)))#"' 'cat <<'"'"'E'"'"'' '" ; gh pr merge 1' 'E' ')'
r3_case "A-ctl: \$((2*(1+1))) then a real quoted heredoc -- its body is data (control)" 1 "$MERGE" \
  'x=$(echo $((2*(1+1))) ; cat <<'"'"'E'"'"'' 'gh pr merge 1 was refused' 'E' ')'
# Round 17 (test review): the backslash skip inside a backtick frame had no
# case -- with it gone, `\`` inside the frame closed it and the `<<'E'` after
# the real close was latched over the line all three shells run. Mutant
# `lho-bt-escape-off`.
r3_case "BS1: an escaped backtick inside a backtick frame does not close it" 0 "$MERGE" \
  'x=$(echo `a \`b\` ; cat <<'"'"'E'"'"'' '` ; gh pr merge 1' 'E' ')'
# Round 18 (security): a `#` at word start comments out the rest of the line,
# so a `<<` after it is not an opener -- but the TOP-LEVEL latch read the word
# anyway, dropped the commands up to a later bare delimiter, and all three
# shells RUN them. origin/main escaped it only because its identifier-PREFIX
# latch could not read a QUOTED word, so reading the word properly (round 7)
# is what made the comment reachable. Mutant `ptag-comment-off`.
r3_case "CM1: a quoted <<X inside a top-level # comment is not an opener" 0 "$MERGE" \
  'x=$(echo) #<<'"'"'X'"'"'' 'gh pr merge 1' 'X'
r3_case "CM2: the bare-subshell twin" 0 "$MERGE" \
  'x=$( (echo) ) #<<'"'"'X'"'"'' 'gh pr merge 1' 'X'
r3_case "CM3: a line that STARTS with the comment" 0 "$MERGE" \
  '#<<'"'"'X'"'"'' 'gh pr merge 1' 'X'
# Both directions: a `#` GLUED to the previous word is not a comment and the
# heredoc after it IS real -- no shell runs the line then (measured), so the
# body must still be dropped.
r3_case "CM-ctl1: \$(echo)# is one word -- the heredoc after it is real (control)" 1 "$MERGE" \
  'x=$(echo)#<<'"'"'X'"'"'' 'gh pr merge 1 was refused' 'X'
r3_case "CM-ctl2: an escaped # is one word too (control)" 1 "$MERGE" \
  'echo \#<<'"'"'X'"'"'' 'gh pr merge 1 was refused' 'X'
# Round 19 (spec and code review, one finding): the class above was written
# `[ \\t...]` -- in an awk regexp constant `\\` is a LITERAL BACKSLASH, so it
# held `\` and the letter `t` and NOT a tab, while all five sibling classes
# spell it `\t`. Both polarities of round 18's own subject were wrong: a tab
# before the `#` was not a comment (fail-open, all three shells run the next
# line) and a letter-glued `cat#` was (false refusal). One character; these
# four cases pin both directions, and `ptag-comment-class` is the mutant.
r3_case "CM4: a TAB before the # is word start too" 0 "$MERGE" \
  'echo a	#<<'"'"'X'"'"'' 'gh pr merge 1' 'X'
r3_case "CM5: the TAB twin after a closed \$( )" 0 "$MERGE" \
  'x=$(echo)	#<<'"'"'X'"'"'' 'gh pr merge 1' 'X'
r3_case "CM-ctl3: a LETTER before the # is glue -- the heredoc after it is real (control)" 1 "$MERGE" \
  'cat#<<'"'"'X'"'"'' 'gh pr merge 1 was refused' 'X'
# CM-ctl2 (`\#`) cannot discriminate the GLUE half: the backslash arm consumes
# the `#` itself, so the word-start test is never reached (code review round
# 19). Nor can CM-ctl4, whose escaped character is not in the boundary class --
# it pins the arm's OTHER half, that an escaped character is still scanned.
r3_case "CM-ctl4: an escaped character before the # is glue (control)" 1 "$MERGE" \
  'echo a\b#<<'"'"'X'"'"'' 'gh pr merge 1 was refused' 'X'
# The two other glue positions, each with a shape that discriminates it (test
# review round 19): an escaped SPACE (a class member, so without the backslash
# arm's `fgp` the `#` would read as a comment) and the `<( )` landing. Both are
# data in all three shells; the SPACE twin of the second RUNS and is CM6.
r3_case "CM-ctl5: an escaped SPACE before the # is glue (control)" 1 "$MERGE" \
  'echo a\ #<<'"'"'X'"'"'' 'gh pr merge 1 was refused' 'X'
r3_case "CM-ctl6: a <( ) landing before the # is glue (control)" 1 "$MERGE" \
  'diff <(echo)#<<'"'"'X'"'"'' 'gh pr merge 1 was refused' 'X'
r3_case "CM6: a <( ) then a SPACE before the # -- a comment" 0 "$MERGE" \
  'diff <(echo) #<<'"'"'X'"'"'' 'gh pr merge 1' 'X'
# Round 20 (test review): only the SPACE and TAB members of the class above
# had a case; deleting any of `)` `(` `;` `&` `|` from it left the suite green
# while each is a live shape -- `(echo)#<<'X'`, `echo a ;#<<'X'`, `true &#<<'X'`
# and `echo a |#<<'X'` all RUN the next line in bash 5.x, bash 3.2 and zsh, and
# the latch would drop it. One case per member, the way CM4 pinned the tab;
# mutants `ptag-comment-class-<member>`.
r3_case "CM7: a ) before the # is word start at top level too" 0 "$MERGE" \
  '(echo)#<<'"'"'X'"'"'' 'gh pr merge 1' 'X'
r3_case "CM9: a ; before the #" 0 "$MERGE" \
  'echo a ;#<<'"'"'X'"'"'' 'gh pr merge 1' 'X'
r3_case "CM10: an & before the #" 0 "$MERGE" \
  'true &#<<'"'"'X'"'"'' 'gh pr merge 1' 'X'
r3_case "CM11: a | before the #" 0 "$MERGE" \
  'echo a |#<<'"'"'X'"'"'' 'gh pr merge 1' 'X'
# CM8 pins the `(` member in the REFUSING direction: no shell runs this one
# (`(#` opens a subshell bash never closes), so the latch would only drop
# prose -- but the member has to be in the class for the shapes that do.
r3_case "CM8: a ( before the # (refusing direction -- no shell runs it)" 0 "$MERGE" \
  '(#<<'"'"'X'"'"'' 'gh pr merge 1 is prose here' 'X'
# Round 20 (code review): the walk classed EVERY bare `(` as an operator, so
# the `)` closing one recorded no word glue and a `#` after it read as a
# comment. `<( )` and `>( )` are words and bash glues the `#` to them:
# `x=$(diff <(echo)#"` leaves a quote open that all three shells carry to the
# next line, and the line closing it RUNS. `flush_line` already knew this at
# its own `<( )` landing; only this walk was left out. Mutant
# `lho-frame-kind-word` (PS1 / PS2). PS3's `a=( )` took the same reading until
# round 21 measured the shells disagreeing about it; it is the kind-2 bail
# now, which `lho-array-frame-glue` pins alongside AE1 / AE2.
r3_case "PS1: <( ) is a WORD -- the # after it is glued" 0 "$MERGE" \
  'x=$(diff <(echo)#"' '<<'"'"'X'"'"'' '" ; gh pr merge 1' 'X' ')'
r3_case "PS2: the >( ) twin" 0 "$MERGE" \
  'x=$(diff >(true)#"' '<<'"'"'X'"'"'' '" ; gh pr merge 1' 'X' ')'
r3_case "PS3: an a=( ) frame bails on its )# -- its body is read as commands" 0 "$MERGE" \
  'x=$(a=(1)#"' '<<'"'"'X'"'"'' '" ; gh pr merge 1' 'X' ')'
r3_case "PS-ctl1: <( ) then a SPACE before the # -- a comment (control)" 1 "$MERGE" \
  'x=$(diff <(echo) #"' '<<'"'"'X'"'"'' '" ; gh pr merge 1 was refused' 'X' ')'
r3_case "PS-ctl2: a BARE subshell ) before the # -- still a comment (control)" 1 "$MERGE" \
  'x=$( ( true )#"' '<<'"'"'X'"'"'' '" ; gh pr merge 1 was refused' 'X' ')'
# kind 1 has to be pinned against kind 2 as well (test review round 22: PS1 and
# PS2 pass under either reading, so "the # is GLUED" was unverified). Here the
# glue is what makes `<<'X'` part of the same word and therefore a real opener
# whose body is data; the kind-2 bail would read the line as commands. No shell
# runs the body, so this is the allowing direction. Mutant `lho-frame-kind-bail`.
r3_case "PS-ctl3: a <( ) glue makes the <<X after it a real opener (kind 1, not kind 2)" 1 "$MERGE" \
  'x=$(diff <(echo)#<<'"'"'X'"'"'' 'gh pr merge 1 was refused' 'X' ')'
# Round 23 (code review): a `)#` whose enclosing `$( )` CLOSES on the same line
# was a fail-open all the way through. `subst_open` spelled the comment class
# without `)`, so it read past the `#`, counted the final `)`
# and reported the span CLOSED -- which means `last_heredoc_opener`, whose own
# class is right, never ran: it is called only inside `if (subst_open(line))`.
# `flush_line` then latched the `<<'X'` at TOP level and dropped the next line,
# which bash 5.x and zsh RUN. That walk records the frame kind now, as the
# opener scan has since round 20: a `)` closing a BARE `( )` starts a comment,
# one closing a `$( )` / `<( )` / `>( )` is word glue, and an `a=( )` is
# neither -- leaving it a comment there is the REFUSING direction, because the
# span then reads as open and the lines join into commands. `close_paren` is
# NOT given the same treatment: the security review measured that version
# closing only 256 of the 295 shapes while turning 413 into fail-opens of its
# own, so the change stops at the walk that decides whether the line joins.
# Mutants `so-hash-class-rparen` and `so-frame-glue`.
r3_case "CP1: a )# closing the substitution on the same line" 0 "$MERGE" \
  'x=$( (true)#)<<XX' 'gh pr merge 1' 'XX' ')'
r3_case "CP2: the arithmetic twin" 0 "$MERGE" \
  'x=$( ((1))#)<<XX' 'gh pr merge 1' 'XX' ')'
r3_case "CP3: the process-substitution twin" 0 "$MERGE" \
  'cat <( (true)#)<<XX' 'gh pr merge 1' 'XX' ')'
r3_case "CP4: the a=( ) spelling of the same close (no separate arm -- every ( at depth is one kind here)" 0 "$MERGE" \
  'x=$(a=(1)#)<<XX' 'gh pr merge 1' 'XX' ')'
# CP-ctl1 and CP-ctl2 are PARSE-ERROR shapes in bash 5.x, bash 3.2 and zsh
# alike, exactly as CP-ctl3 / CP-ctl4 are said to be four lines down (test
# review round 32 measured all four; only the second pair carried the label).
# They pin the READING the frame-kind arms implement, and no shell executes
# the input -- which is the safe direction here, since nothing can run while
# the matcher declines to match.
r3_case "CP-ctl1: a bare subshell with no # -- the heredoc is real (control, a parse-error shape)" 1 "$MERGE" \
  'x=$( (true) )<<XX' 'gh pr merge 1 was refused' 'XX' ')'
r3_case "CP-ctl2: a <( ) glue before the )# -- still not a comment (control, a parse-error shape)" 1 "$MERGE" \
  'x=$(diff <(echo)#)<<XX' 'gh pr merge 1 was refused' 'XX' ')'
# The frame-KIND class had two of its four members pinned (CP1-CP4 for the bare
# frame, CP-ctl2 for `<( )`); these are the other two, both in the allowing
# direction -- the `)` of a `$( )` or a `>( )` is word glue, so the `#` after it
# is not a comment and the `<<XX` IS a real opener whose body is data. No shell
# runs these. Mutants `so-frame-kind-dollar` and `so-frame-kind-gt`.
r3_case "CP-ctl3: a \$( ) glue before the )# -- not a comment (control)" 1 "$MERGE" \
  'x=$(echo $(true)#)<<XX' 'gh pr merge 1 was refused' 'XX' ')'
r3_case "CP-ctl4: the >( ) twin (control)" 1 "$MERGE" \
  'x=$(diff >(true)#)<<XX' 'gh pr merge 1 was refused' 'XX' ')'
# The three refuse-on-expansion-character arms get their cases. bash does NOT
# expand a heredoc delimiter word -- measured on 5.x and 3.2, `cat <<E$y` with
# `y=INNER` is terminated by the literal line `E$y` and the body is data -- so
# this is a DELIBERATE OVER-REFUSAL, not a modelling gap: cdkd declines to latch
# a delimiter carrying a `$` or a backtick rather than encode a rule about them.
# (Round 23 called the word "not knowable from the text", which is false and
# would send a later round modelling an expansion that does not happen; test
# review round 24 measured it.) The body then reads as commands: origin/main
# parity, a false refusal at worst. Only the double-quoted arm
# carries a mutant (`hw-dq-dollar-bail`, HW3): with the unquoted bail gone the
# identifier test refuses `E$y` anyway, so HW1 / HW2 document the shapes
# without discriminating that arm -- measured, the mutant reports NOT
# DISCRIMINATED.
r3_case "HW1: an unquoted \$ in the delimiter word is refused, though bash takes it literally" 0 "$MERGE" \
  'x=$(cat <<E$y' 'gh pr merge 1' 'E$y' ')'
r3_case "HW2: a backtick in the delimiter word is refused the same way" 0 "$MERGE" \
  'x=$(cat <<E`y`' 'gh pr merge 1' 'E' ')'
r3_case "HW3: the double-quoted twin of HW1" 0 "$MERGE" \
  'x=$(cat <<"E$y"' 'gh pr merge 1' 'E$y' ')'
# Round 21 (test review): the TWIN of the class round 20 fenced -- this one is
# `last_heredoc_opener`'s own, and five of its seven members had no case, so
# deleting any of TAB `;` `&` `|` `(` left the suite green. Four are live: the
# shapes below RUN the next line in bash 5.x, bash 3.2 and zsh, and the latch
# would drop it. LH-ctl pins the `(` member in the refusing direction (no shell
# runs `(#`); mutants `lho-hash-class-<member>`.
r3_case "LH1: a TAB before the # inside \$( )" 0 "$MERGE" \
  'x=$(echo a	#<<'"'"'X'"'"'' 'gh pr merge 1' 'X' ')'
r3_case "LH2: a ; before the #" 0 "$MERGE" \
  'x=$(echo a ;#<<'"'"'X'"'"'' 'gh pr merge 1' 'X' ')'
r3_case "LH3: an & before the #" 0 "$MERGE" \
  'x=$(true &#<<'"'"'X'"'"'' 'gh pr merge 1' 'X' ')'
r3_case "LH4: a | before the #" 0 "$MERGE" \
  'x=$(echo a |#<<'"'"'X'"'"'' 'gh pr merge 1' 'X' ')'
r3_case "LH-ctl: a ( before the # (refusing direction -- no shell runs it)" 0 "$MERGE" \
  'x=$(echo a (#<<'"'"'X'"'"'' 'gh pr merge 1 is prose here' 'X' ')'
# Round 21 (code review): the `=` member of the frame-kind class models BASH,
# which glues the `#` to an `a=( )` word -- and zsh reads it as a comment, so
# gluing dropped a line zsh RUNS (a Bash tool call here runs under zsh). Such a
# frame is kind 2 and a `)#` closing it is the sticky bail, the same answer this
# file gives everywhere the shells disagree. Mutant `lho-array-frame-glue`.
r3_case "AE1: a=( ) then # -- the shells disagree, so it bails" 0 "$MERGE" \
  'x=$(a=(1)#<<'"'"'X'"'"'' 'gh pr merge 1' 'X' ')'
r3_case "AE2: the subscripted twin" 0 "$MERGE" \
  'x=$(y[1]=(1)#<<'"'"'X'"'"'' 'gh pr merge 1' 'X' ')'
# Round 18 (code review): the `$(( ))` paren walk counted every `(` / `)`,
# while bash finds the close honouring quotes -- a `))` inside a double quote
# is not the end, and landing there inverted the scan's quote state for the
# rest of the substitution (both bashes ran the line closing it). A quote,
# backtick or backslash inside the span is the sticky bail, as in `${...}`.
# Mutant `lho-arith-quote-bail`.
r3_case "AQ1: a quoted )) inside \$(( )) is not its close" 0 "$MERGE" \
  'x=$( false && echo "((" $(( "))" ))#"' 'cat <<'"'"'EOF'"'"'' '"; gh pr merge 1; : "' 'EOF' '")'
# One case per member of the arithmetic bail class too (test review round 21:
# only the double quote was pinned). Each RUNS the closing line in all three
# shells, and each is MATCHED with its member deleted as well -- the `)#` glue
# path reaches the same verdict, so the members carry no discriminating mutant
# and the class is defence in depth rather than the thing that decides these.
# Measured, not assumed: a per-member mutant reports NOT DISCRIMINATED.
r3_case "AQ2: a single quote inside \$(( ))" 0 "$MERGE" \
  'x=$( false && echo "((" $(( '"'"')'"'"' ))#"' 'cat <<'"'"'EOF'"'"'' '"; gh pr merge 1; : "' 'EOF' '")'
r3_case "AQ3: a backtick inside \$(( ))" 0 "$MERGE" \
  'x=$( false && echo "((" $(( `echo 1` ))#"' 'cat <<'"'"'EOF'"'"'' '"; gh pr merge 1; : "' 'EOF' '")'
r3_case "AQ4: a backslash inside \$(( ))" 0 "$MERGE" \
  'x=$( false && echo "((" $(( 1\ ))#"' 'cat <<'"'"'EOF'"'"'' '"; gh pr merge 1; : "' 'EOF' '")'
# Round 18 (test review): the walk's "the next character must be a )" arm had
# no case -- shells abandon an unclosed `$((` and re-read it as `$( (`, and
# this shape ran the body line in all three. Mutant `lho-arith-second-close`.
r3_case "A9: \$((1) is not an arithmetic span -- the shells run the body line" 0 "$MERGE" \
  'x=$( $((1) ; cat <<'"'"'E'"'"'' 'gh pr merge 1' 'E' ') )'

# --- The UNQUOTED delimiter is DELIBERATELY not latched (round 2) ------------
# Two review rounds of go-to-k/cdkd#3040 each measured shapes bash executes
# that the unquoted-delimiter arm dropped: a `$(git commit)` on a body line, a
# multi-line `$(` spanning body lines, a literal `<<Y` on a fallen-through line
# overwriting the latch. bash EXPANDS an unquoted body, so nothing short of a
# full parse can say what runs in it. The latch therefore fires on a QUOTED
# delimiter alone, and an unquoted prose body is read as commands exactly as
# origin/main read it -- a LOUD false refusal (write the delimiter quoted, or
# use --body-file), never a silent miss. This case pins that decision: it
# MATCHES, and a "fix" making it not match has to re-answer the review rounds.
subst_bare_delim=$(printf '%s\n' \
  'gh issue create --body "$(cat <<EOF' \
  'gh pr merge 1 was refused' \
  'EOF' \
  ')"')
check "an UNQUOTED delimiter (<<EOF) inside \$( ) is NOT latched: origin/main parity" 0 "$MERGE" "$subst_bare_delim"
# The `-` of `<<-` is its own grammar arm and was unfenced (test review):
# deleting it left the suite green.
subst_dash_delim=$(printf '%s\n' \
  'x="$(cat <<-'"'"'EOF'"'"'' \
  "$(printf '\tgh pr merge 1 was refused')" \
  "$(printf '\tEOF')" \
  ')"')
check "<<- with an indented terminator inside \$( ) is stripped" 1 "$MERGE" "$subst_dash_delim"

# The opener on the line AFTER the `$(` -- the shape an agent most often writes
# (`--body "$(` newline `cat <<'EOF'` ...) -- and a heredoc inside a BACKTICK
# substitution. Both were false positives on origin/main and are fixed by the
# same latch; neither had a case.
subst_opener_next_line=$(printf '%s\n' \
  'gh issue create --body "$(' \
  '  cat <<'"'"'EOF'"'"'' \
  'gh pr merge 1 was refused' \
  'EOF' \
  ')"')
check "an opener on the line after the \$( is caught by the latch" 1 "$MERGE" "$subst_opener_next_line"
subst_backtick_heredoc=$(printf '%s\n' \
  'x=`cat <<'"'"'EOF'"'"'' \
  'gh pr merge 1 was refused' \
  'EOF' \
  '`')
# Round 14: NOT stripped -- a backtick frame bails (see B1 / P01 / P03).
check "a heredoc inside a BACKTICK substitution is read as commands (parity)" 0 "$MERGE" "$subst_backtick_heredoc"

# --- Reviewer-found regressions of the FIRST cut (all must MATCH) ---------
#
# The first stripper treated `<<<`, a `<<EOF` mentioned in prose, and an
# unterminated heredoc as real openers, latched `in_heredoc` on, and dropped
# every remaining line — turning the gate OFF for these commands. Strict
# false negatives vs the old anchored matcher, i.e. worse than the bug.
check "here-string <<< does not swallow a later invocation" 0 "$MERGE" \
  "$(printf 'grep -q a <<< "$v"\ngh pr merge 1\n')"
check "a <<EOF mentioned in quoted prose does not swallow" 0 "$MERGE" \
  "$(printf 'echo "docs say <<EOF works"\ngh pr merge 1\n')"
check "an UNTERMINATED heredoc does not swallow" 0 "$MERGE" \
  "$(printf 'cat <<EOF\nsome text\ngh pr merge 1\n')"

# The other direction: a multi-line QUOTED argument was left intact by the
# per-line sed, producing a NEW hard block on prose describing the command.
check "multi-line -m message quoting a chained merge" 1 "$MERGE" \
  "$(printf 'git commit -m "fix: x\n\nrun: git push && gh pr merge 5"\n')"
check "multi-line --body quoting a chained merge" 1 "$MERGE" \
  "$(printf 'gh pr create --title x --body "intro\nthen git push && gh pr merge 5"\n')"

# An apostrophe inside a double-quoted span is literal, not an opener — the
# state machine must not use it to swallow a following real command.
check "apostrophe inside double quotes does not swallow" 0 "$MERGE" \
  "$(printf 'echo "don%st do this"\ngh pr merge 1\n' "'")"

# A heredoc body full of prose apostrophes is why heredocs are removed BEFORE
# quotes; reversing the order would let "don't" swallow the trailing command.
check "heredoc prose with an apostrophe, real invocation after" 0 "$MERGE" \
  "$(printf 'git commit -F - <<%sEOF%s\ndon%st do this\nEOF\ngh pr merge 1\n' "'" "'" "'")"

# --- cmd_last_cd_target ---------------------------------------------------
#
# Which tree the verb runs in decides whose per-worktree markgate markers the
# gate consults. Reading only a LEADING `cd` was safe while the verb matcher
# was line-start anchored (a mid-chain `cd` command did not fire the gate at
# all); now that it does fire, the wrong tree means the wrong markers — which
# can produce a spurious PASS.
cd_check() { # name, expected, command [, verb-ere]
  local name="$1" want="$2" cmd="$3" verb="${4:-}" got
  got="$(cmd_last_cd_target "$cmd" "" "$verb")"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$name"
  else
    fail=$((fail + 1)); printf 'FAIL %s (want "%s", got "%s")\n' "$name" "$want" "$got"
    fail_log+="FAIL $name\n  command: $cmd\n"
  fi
}
cd_check "no cd yields nothing" "" "gh pr merge 1"
cd_check "leading cd" "/tmp/w" "cd /tmp/w && gh pr merge 1"
cd_check "MID-CHAIN cd is found" "/tmp/w" "git push && cd /tmp/w && gh pr merge 1"
cd_check "the LAST absolute cd wins" "/tmp/second" "cd /tmp/first && cd /tmp/second && gh pr merge 1"
cd_check "chained RELATIVE cd composes against the previous one" "/abs/one/sub" "cd /abs/one && cd sub && gh pr merge 1"
cd_check "cd after a semicolon" "/tmp/w" "echo hi; cd /tmp/w; gh pr merge 1"
cd_check "a cd mentioned in a quoted body is ignored" "" 'echo "then cd /tmp/w and merge"'
cd_check "cdkd (a different command) is not a cd" "" "cdkd deploy && gh pr merge 1"

# --- Round-3: a cd AFTER the verb must not move the target ----------------
#
# Following every cd let a trailing one hijack the marker lookup:
# `gh pr merge N --squash --delete-branch && cd <repo> && git pull` -- the
# standing post-merge step -- silently redirected all seven markgate gates to
# the main tree's store.
cd_check "cd AFTER the verb is ignored" "" \
  "gh pr merge 1 --squash --delete-branch && cd /tmp/other" "$MERGE"
cd_check "cd BEFORE the verb still counts, cd after does not" "/tmp/before" \
  "cd /tmp/before && gh pr merge 1 && cd /tmp/after" "$MERGE"
cd_check "without a verb every cd is followed (back-compat)" "/tmp/after" \
  "gh pr merge 1 && cd /tmp/after"

# A fully-quoted cd path now RESOLVES. It used to yield nothing — the stripper
# had replaced the span with a placeholder, so the caller fell back to the
# payload cwd — and recovering it from the raw text was tried and removed,
# because the raw command still holds quoted `cd` MENTIONS the neutralised pass
# correctly ignored and pairing the two by order resolved the WRONG directory.
# The #2129 segmenter removes the dilemma: segments carry their original text,
# so the path is simply there, and a quoted mention still never starts a segment.
cd_check "a fully-quoted cd path resolves" "/tmp/a b" \
  'cd "/tmp/a b" && gh pr merge 1'

# `subst_open`'s own comment class is the THIRD instance of the shape rounds 20
# and 21 fenced at the other two sites, and it arrived with only the member
# round 23 added (`)`) pinned (test review round 24). Each member below decides
# whether the comment ends the line: without it the `)` inside the comment is
# counted, the substitution reads as CLOSED, and the `cd` that runs in its CHILD
# is resolved as the TOP-LEVEL target -- the fail-open the function exists to
# close. `cmd_last_cd_target` is the observable, because the verb matches either
# way; mutants `so-hash-class-<member>`.
cd_check "SO1: a SPACE before the # keeps the substitution open" "" \
  "$(printf '%s\n' 'x=$(' 'echo hi # note )' 'cd /tmp' ')' 'git commit -m x')" "$COMMIT"
cd_check "SO2: a TAB before the #" "" \
  "$(printf '%s\n' 'x=$(' 'echo hi	# note )' 'cd /tmp' ')' 'git commit -m x')" "$COMMIT"
cd_check "SO3: a ; before the #" "" \
  "$(printf '%s\n' 'x=$(' 'echo hi ;# note )' 'cd /tmp' ')' 'git commit -m x')" "$COMMIT"
cd_check "SO4: an & before the #" "" \
  "$(printf '%s\n' 'x=$(' 'true &# note )' 'cd /tmp' ')' 'git commit -m x')" "$COMMIT"
cd_check "SO5: a | before the #" "" \
  "$(printf '%s\n' 'x=$(' 'echo hi |# note )' 'cd /tmp' ')' 'git commit -m x')" "$COMMIT"
cd_check "SO6: a # at the START of the line (reached through the join\047s `;`, not the i == 1 arm)" "" \
  "$(printf '%s\n' 'x=$(' '# note )' 'cd /tmp' ')' 'git commit -m x')" "$COMMIT"
# The seventh member, `(`, carries NO case here and no mutant: measured, a
# `(` before the `#` resolves the same target with the member present or
# absent, and every shape that would separate them is a syntax error in all
# three shells (test review round 25 built `so-hash-class-lparen` and got
# NOT DISCRIMINATED). CM8 and LH-ctl pin the same member at the other two
# sites, where the observable is the latch rather than the resolved target.
# It is not wholly inert: the one shape that changes anything (`$(# note )`
# on a body line) changes segment ORDER and no mark, and is a parse error in
# all three shells -- said here so a later round does not read
# "undiscriminable" as "no observable difference at all".

# --- Round-2 review regressions (quoted VALUES must survive) --------------
#
# The second cut DELETED quoted spans instead of replacing them, so a quoted
# argument VALUE vanished and every pattern that needs it stopped matching.
# `gh -C "$WT" pr merge` is the documented worktree shape, and it failed to
# match in nine gates -- a silent fail-open, the worst direction.
check "gh -C with a QUOTED path still matches" 0 "$MERGE" 'gh -C "/tmp/wt" pr merge 5'
check "gh -C with a single-quoted path still matches" 0 "$MERGE" "gh -C '/tmp/wt' pr merge 5"
check "git -C with a quoted path still matches" 0 "$COMMIT" 'git -C "/tmp/wt" commit -m x'
check "quoted path after a chain still matches" 0 "$MERGE" 'git push && gh -C "/tmp/wt" pr merge 5'

# An escaped quote inside a double-quoted span must not desync the machine
# and swallow the following line.
esc_cmd=$(printf 'git commit -m "a \\" b"\ngh pr merge 5')
check "escaped quote does not swallow the next line" 0 "$MERGE" "$esc_cmd"

# A `<<X` inside a quoted span is not a heredoc opener, even when a bare line
# equal to the delimiter turns up later.
fake_open=$(printf 'echo "delimiter is <<DONE"\ngh pr merge 5\nDONE')
check "quoted <<DELIM plus a later bare DELIM line does not swallow" 0 "$MERGE" "$fake_open"

# --- Leading prefixes before the verb (issue #2129) ------------------------
#
# Measured on 2026-08-20 against branch-gate.sh: each of these exited 0, so the
# commit/push reached git ungated. An assignment or an `env` / `command` /
# `nohup` wrapper does not change which program runs, so it must not change
# whether the gate fires.
check "leading env assignment" 0 "$COMMIT" "GIT_EDITOR=true git commit -m x"
check "two leading assignments" 0 "$COMMIT" "GIT_EDITOR=true LC_ALL=C git commit -m x"
check "env wrapper" 0 "$COMMIT" "env git commit -m x"
check "command wrapper" 0 "$COMMIT" "command git commit -m x"
check "nohup wrapper" 0 "$COMMIT" "nohup git commit -m x"
check "assignment after a chain operator" 0 "$COMMIT" "git add -A && GIT_EDITOR=true git commit -m x"
check "assignment on a gh merge" 0 "$MERGE" "CDKD_X=1 gh pr merge 1 --squash"
# The prefix rule must not turn a quoted mention into a match.
check "assignment inside a quoted mention" 1 "$COMMIT" 'echo "run GIT_EDITOR=true git commit later"'
# An assignment-looking token that is an ARGUMENT, not a prefix, still must not
# manufacture a verb out of nowhere.
check "assignment with no verb after it" 1 "$COMMIT" "GIT_EDITOR=true vp run test"

# --- Non-matches ----------------------------------------------------------
check "different subcommand" 1 "$MERGE" "gh pr create --title x"
check "substring inside a path" 1 "$COMMIT" "ls /tmp/git-commit-notes"
check "empty command" 1 "$MERGE" ""

# --- gate_matches / gate_target_dir ------------------------------------------
#
# Folded in from the short-lived `_command-match.test.sh` when the two matchers
# converged into this file. These drive the SAME engine as the `check` cases
# above, through the API the 34 gates call, so a regression is reported once.

# want_match <expect 0|1> <label> <command> <regex>
want_match() {
  local want="$1" label="$2" cmd="$3" re="$4" got
  if gate_matches "$cmd" "$re"; then got=0; else got=1; fi
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL %s (want %s, got %s)\n' "$label" "$want" "$got"
    fail_log+="FAIL $label\n  command: $cmd\n"
  fi
}

# want_dir <expected> <label> <command> <fallback> <regex>
want_dir() {
  local want="$1" label="$2" cmd="$3" fallback="$4" re="$5" got
  got=$(gate_target_dir "$cmd" "$fallback" "$re")
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n' "$label"
    fail_log+="FAIL $label\n  want: $want\n  got:  $got\n"
  fi
}

C="$GATE_RE_GIT_COMMIT"
P="$GATE_RE_GIT_PUSH"
M="$GATE_RE_GH_PR_MERGE"

# --- a FLAG VALUE CONTAINING A SPACE (go-to-k/cdkd#2200) ---------------------
#
# `git -c user.name="Jane Doe" commit` is an everyday shape and it walked past
# EVERY gate keyed on GATE_FLAGS -- measured at the gate level, not just here:
# on a repo sitting on `main`, `git commit -m x` gave branch-gate rc=2 while
# `git -c user.name="Jane Doe" commit -m x` gave rc=0. A commit straight to
# main, ungated. The value alternative stopped at the first space, so the flag
# loop ended mid-value and the verb was never reached.
#
# WHICH OF THESE ACTUALLY DISCRIMINATE, measured by mutation rather than
# assumed. A review round found the first version of this block naming six
# hazards while its assertions pinned one, so each line now says what it is:
want_match 0 "flag value with a space, double quotes" 'git -c user.name="Jane Doe" commit -m x' "$C"
want_match 0 "flag value with a space, single quotes" "git -c user.name='Jane Doe' commit -m x" "$C"
want_match 0 "escaped quote inside a flag value"      'git -c k="a\" b" commit -m x' "$C"
want_match 0 "gh repo flag with a spaced value"       'gh --repo "go to/k" pr merge 1' "$M"
# ^ these four red when the widening is reverted. They are the fix.

# REGRESSION GUARDS, not bypass fixes: all three already matched before this
# change, and they are here so the widening is shown not to LOSE them. Saying so
# matters -- an earlier version of this comment presented them as newly-fixed
# bypasses, which would have sent the next reader hunting for a defect that was
# never there.
want_match 0 "glued flag value with a space"          'git --author="Jane Doe" commit -m x' "$C"
want_match 0 "quoted span containing a dash"          'git -c core.editor="vim -f" commit -m x' "$C"
want_match 0 "flag after a valueless flag"            'git -C /tmp -q commit -m x' "$C"

# POLARITY CONTROLS. Widening a flag absorber is exactly the change that makes a
# gate fire on commands it should ignore, and "it matches" is satisfied by a
# pattern that matches everything.
#
# The first version of this pair was `git -c user.name="Jane Doe" status` and
# `... log --oneline`, and neither could EVER red: neither string contains the
# word `commit`, so no amount of over-reach in GATE_FLAGS could make a commit
# gate match them. Proven by mutating GATE_FLAGS to the total over-reach
# `([[:space:]]+[^[:space:]]+)*` -- both stayed green. A control that cannot
# fail is not a control.
#
# These do contain the verb, in a position where matching it would be wrong: a
# quoted flag VALUE, and an argument. An absorber that swallows the closing
# quote reaches them.
want_match 1 "verb inside a spaced flag value"        'git -c alias.x="run commit later" status' "$C"
# FLIPPED by go-to-k/cdkd#2156, deliberately, and it is the one case in this
# file whose expectation the trigger inversion changed. Once the prefix stops
# enumerating flag spellings, "a bare token here is a flag VALUE" and "a bare
# token here is the subcommand" become indistinguishable after the first flag --
# and the whole point is that the AMBIGUOUS reading must WIDEN, because a
# narrowing miss exits 0 silently while a widening reaches the strict resolver
# and refuses out loud. Note origin/main already matched the same shape without
# the `-c` (`git --no-pager log --grep commit`), so this is one spelling joining
# a class that already existed, not a new class.
#
# What still keeps ordinary read commands out is the case BELOW it -- a bare
# token in FIRST position is the subcommand by git's own syntax, so
# `git log --grep commit` settles with no list of subcommand names to go stale.
# That pair is the real control; do not "fix" this line back without checking
# what the one below then still discriminates.
want_match 0 "verb after a spaced value is CONSIDERED (over-approximate trigger)" \
  'git -c user.name="Jane Doe" log --grep commit' "$C"
want_match 1 "bare first token settles the subcommand: git log is not a commit" \
  'git log --grep commit' "$C"
want_match 1 "gh verb inside a spaced repo value"     'gh --repo "a pr merge b" issue list' "$M"

# =============================================================================
# A FLAG BETWEEN THE gh GROUP WORD AND ITS VERB (go-to-k/cdkd#3242)
# =============================================================================
#
# `gh` takes a global flag in EITHER slot and resolves from it identically --
# measured on gh 2.92.0 from a directory that is not a repo, `gh pr -R
# go-to-k/cdkd view 3214` answered the cdkd PR. `GATE_GH_C` covered only the
# LEFT slot, so `gh pr -R <slug> merge <n>` matched NOTHING and no gate fired at
# all: measured through the shipped hooks in this repo, `gh pr merge 3242
# --squash` gave verify-pr-gate rc=2 and `gh pr -R go-to-k/cdkd merge 3242
# --squash` gave rc=0, and `gh issue -R <slug> create --body-file <bare #N>` took
# pr-body-item-number-gate from 2 to 0.
#
# THE FENCE IS A FAMILY FENCE, NOT A CASE PER GATE PER SPELLING, and the choice
# is the same one hooks-class-fences.md makes for every other class here: a
# hand-written case list is one spelling behind by construction, and the gates
# are many while the defect is ONE position in ONE shared pattern. So:
#
#   part 1  derives the POPULATION from the library SOURCE -- every
#           `GATE_RE_GH_*` constant -- and fails any one whose group word is not
#           followed by the absorber. That is what catches the constant written
#           NEXT month by someone copying a neighbour, which no dynamic case can.
#   part 2  crosses that population's (group, verb) pairs with every flag
#           spelling gh accepts and asserts each MATCHES.
#   part 3  drives the OTHER direction over the same cross product: a widened
#           absorber is exactly the change that makes a gate fire on commands it
#           must ignore, so gh's READ verbs must still match nothing.
#
# A KNOWN BOUND, stated rather than detected. This fence's subject is the
# ABSORBER -- whether a flag between the group word and the verb is tolerated --
# and NOT the verb ALTERNATION of each constant. Four constants have no live
# hook reader (`GATE_RE_GH_PR_EDIT`, `_PR_MERGE_OR_EDIT`, `_ISSUE_EDIT`,
# `_ISSUE_CREATE`), so widening the VERB LIST of one of those is invisible to
# every suite in this repo: nothing consumes the constant, and the cases here
# vary the flag spelling rather than the verb set. That is a deliberate bound,
# not an oversight -- building detection for a constant nobody reads would fence
# a value with no consumer. **Wiring a reader to one of those four owes its own
# case**, because the moment it has a consumer the verb list becomes a live
# trigger and this block will not notice it changing (go-to-k/cdkd#3242 round-4
# review).
#
# Per-gate cases still exist for the four gates measured live-defeated
# (verify-pr, bughunt-clean, ci-green, pr-body-item-number) -- they pin that the
# gate CONSULTS this pattern, which a library-level case cannot say.
__ghv_start=$((pass + fail))

# --- part 1: the population, read out of the library ------------------------
#
# Derived from the assignments themselves rather than from a list here, so a new
# `GATE_RE_GH_*` constant is IN the population the moment it is written.
#
# NORMALISATION IS GENERIC, not a list of the two spellings in the tree today.
# The first version rewrote the literals `(issue|pr)` and `(pr|issue)` only, and
# a reviewer defeated it in one line: appending
# `GATE_RE_GH_PROBE="^gh[[:space:]]+(pr|issue|release)[[:space:]]+create(...)"`
# — a neighbour copied and extended — left the suite GREEN, because the group
# word there is followed by `)` rather than by the space class. Any parenthesised
# alternation whose members are ALL group words now collapses to one group word
# first, in any order and any subset, so the scan sees the same shape however the
# constant is spelled (go-to-k/cdkd#3242 test review).
__ghv_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/command-match.sh"
# gh's real command groups (gh 2.92.0 `gh --help`, the "core"/"actions"/
# "additional" command lists), not the three this repo gates today. Deriving the
# set from what cdkd uses is what let a `gist` / `label` constant sit outside the
# fence; deriving it from gh means the fence covers a group the first time
# someone writes a constant for it.
__GHV_GROUPS="pr issue release repo run workflow cache secret variable label project ruleset org search gist codespace extension alias config auth attestation"
__ghv_bad=""
__ghv_seen=0
while IFS= read -r __ghv_line; do
  __ghv_name="${__ghv_line%%=*}"
  __ghv_rhs="${__ghv_line#*=}"
  __ghv_seen=$((__ghv_seen + 1))
  # POSITIVE CHECK, not a blacklist of the two bad shapes. The first version
  # asked only whether a group word was immediately followed by the space class
  # or a `(`, which is closed to the spellings already in the tree -- measured
  # in go-to-k/cdkd#3242's round-4 review, FOUR synthetic un-widened constants
  # all passed it: `(pr|label)[[:space:]]+create` (an alternation carrying a
  # word the normaliser does not know), `gist[[:space:]]+create` (a group word
  # outside the hardcoded three), `pr +create` (a LITERAL space rather than the
  # class), and `pr${GATE_NOPE:-}[[:space:]]+create` (a FAKE absorber). The
  # failure message meanwhile claimed "not followed by ${GATE_GH_V", which no
  # arm actually tested -- the message was true of the intent and false of the
  # code.
  #
  # So the question is inverted: for EVERY gh group word this constant mentions,
  # the literal `${GATE_GH_V:-}` must follow it. An unknown spelling now fails
  # CLOSED (it is not followed by the absorber, so it is reported) instead of
  # falling through the two shapes someone remembered.
  #
  # The group-word set is gh's REAL command groups, not the three cdkd happens
  # to gate today, so the next `gh label` / `gh gist` / `gh repo` constant is
  # inside the fence the moment it is written rather than after the next bypass.
  # AN ALTERNATION OF GROUP WORDS IS ONE GROUP WORD. `(issue|pr)${GATE_GH_V:-}`
  # puts the absorber after the closing paren, so the positive check below has
  # to see through the alternation first. It collapses only when EVERY member is
  # a known group word -- a mixed `(pr|bogus)` is left alone, so its bare `pr`
  # is still found by the boundary grep and still owes the absorber, which is
  # the conservative direction.
  __ghv_alt=$(printf '%s' "$__GHV_GROUPS" | tr ' ' '|')
  __ghv_rhs=$(printf '%s' "$__ghv_rhs" \
    | sed -E "s/\\((${__ghv_alt})(\\|(${__ghv_alt}))*\\)/pr/g")
  for __ghv_g in $__GHV_GROUPS; do
    # Does the RHS mention this group word as a standalone token? `[[:<:]]`-style
    # word boundaries are not portable to bash 3.2 here, so the boundary is
    # spelled explicitly: a group word is preceded by a space class, a `(`, a
    # `|` or the `+` of a preceding quantifier, and followed by something that
    # is NOT an identifier character. A LITERAL SPACE is in the leading class as
    # well as the regex punctuation: `^gh${GATE_GH_C:-} pr create` spells the
    # separator as a real space rather than as `[[:space:]]+`, and without this
    # the group word there is preceded by nothing the class knows -- the one of
    # the round-4 probes that still escaped after the rewrite.
    printf '%s' "$__ghv_rhs" | grep -qE "(\\+|\\(|\\||[[:space:]])${__ghv_g}([^A-Za-z0-9_]|\$)" || continue
    # ...and if it does, the absorber must be the very next thing after it.
    printf '%s' "$__ghv_rhs" | grep -qF "${__ghv_g}\${GATE_GH_V:-}" && continue
    __ghv_bad="${__ghv_bad}\n  $__ghv_name (group word '$__ghv_g' is not followed by the literal \${GATE_GH_V:-})"
  done
done < <(grep -E '^GATE_RE_GH_[A-Z_]+=' "$__ghv_lib")

if [ "$__ghv_seen" -lt 10 ]; then
  # A floor on the POPULATION, not on the result: a grep that stops matching
  # reports zero violations over zero constants, which reads exactly like a
  # clean tree (hooks-class-fences.md, "a population derived from the DEFECT").
  fail=$((fail + 1))
  fail_log="${fail_log}FAIL gh sub-flag population: only $__ghv_seen GATE_RE_GH_* constants found in $__ghv_lib -- the scan collapsed, so the violation check below is vacuous\n"
  printf 'FAIL gh sub-flag population: only %s GATE_RE_GH_* constants found\n' "$__ghv_seen"
elif [ -n "$__ghv_bad" ]; then
  fail=$((fail + 1))
  fail_log="${fail_log}FAIL gh sub-flag absorber missing from:$(printf '%b' "$__ghv_bad")\n"
  printf 'FAIL gh sub-flag absorber missing from:%b\n' "$__ghv_bad"
else
  pass=$((pass + 1))
  printf 'ok   every one of %s GATE_RE_GH_* constants absorbs a flag between the group word and the verb\n' "$__ghv_seen"
fi

# --- part 2: the cross product, asserted to MATCH ---------------------------
#
# One (group, verb, constant) triple per constant that HAS a group word, crossed
# with every flag spelling gh accepts in that slot. The spellings come from gh's
# own option grammar (short, short-glued, short-with-=, long, long-with-=), plus
# a repeated flag and a valueless one, because the absorber must not depend on
# how many tokens a flag eats.
__ghv_flags=(
  "-R go-to-k/cdkd"
  "-Rgo-to-k/cdkd"
  "-R=go-to-k/cdkd"
  "--repo go-to-k/cdkd"
  "--repo=go-to-k/cdkd"
  "-R go-to-k/cdkd --json number"
  "--json number -R go-to-k/cdkd"
)
# group | verb | constant name.  Every gh verb the gates guard.
__ghv_targets=(
  "pr|merge|GATE_RE_GH_PR_MERGE"
  "pr|merge|GATE_RE_GH_PR_CREATE_OR_MERGE"
  "pr|merge|GATE_RE_GH_PR_MERGE_OR_EDIT"
  "pr|merge|GATE_RE_GH_PR_WRITE"
  "pr|create|GATE_RE_GH_PR_CREATE"
  "pr|create|GATE_RE_GH_PR_CREATE_OR_MERGE"
  "pr|create|GATE_RE_GH_LABEL_CARRIER"
  "pr|create|GATE_RE_GH_BODY_CARRIER"
  "pr|create|GATE_RE_GH_PROSE_CARRIER"
  "pr|edit|GATE_RE_GH_PR_EDIT"
  "pr|edit|GATE_RE_GH_BODY_CARRIER"
  "issue|create|GATE_RE_GH_ISSUE_CREATE"
  "issue|create|GATE_RE_GH_LABEL_CARRIER"
  "issue|create|GATE_RE_GH_BODY_CARRIER"
  "issue|edit|GATE_RE_GH_ISSUE_EDIT"
  "issue|comment|GATE_RE_GH_BODY_CARRIER"
  "release|create|GATE_RE_GH_PROSE_CARRIER"
  # Round-2 additions: every constant was exercised, but several at ONE verb
  # only, so a per-verb regression inside a multi-verb alternation had no case
  # (go-to-k/cdkd#3242 test review, MINOR 5). Uniform substitution makes that
  # low-risk and part 1 covers the structure, which is why these are cheap
  # rather than load-bearing -- but "low-risk" is not "fenced".
  "pr|edit|GATE_RE_GH_PR_MERGE_OR_EDIT"
  "pr|edit|GATE_RE_GH_PR_WRITE"
  "pr|edit|GATE_RE_GH_LABEL_CARRIER"
  "pr|comment|GATE_RE_GH_PROSE_CARRIER"
  "pr|review|GATE_RE_GH_PROSE_CARRIER"
  "issue|create|GATE_RE_GH_PROSE_CARRIER"
  "issue|comment|GATE_RE_GH_PROSE_CARRIER"
  "issue|edit|GATE_RE_GH_PROSE_CARRIER"
  "release|edit|GATE_RE_GH_PROSE_CARRIER"
)
# THE AXIS SIZES ARE CHECKED BEFORE THE LOOPS THAT READ THEM, and the position
# is the fix rather than a tidy-up. They sat AFTER the cross-product loop, so
# under `set -u` an emptied array aborted the whole file at the `for` line --
# `__ghv_flags[@]: unbound variable`, rc=1, no tally, and these assertions never
# ran. Under bash 5.x the mutant reddened for a stated reason; under bash 3.2,
# the engine CI uses, it reddened by ACCIDENT and said nothing about an axis.
# Measured in go-to-k/cdkd#3242's round-3 review.
__ghv_axis_ok=1
if [ "${#__ghv_targets[@]}" -ne 26 ]; then
  fail=$((fail + 1)); __ghv_axis_ok=0
  fail_log="${fail_log}FAIL gh sub-flag axis: __ghv_targets holds ${#__ghv_targets[@]} triples, expected exactly 26\n"
  printf 'FAIL gh sub-flag axis: __ghv_targets holds %s triples, expected exactly 26\n' "${#__ghv_targets[@]}"
fi
if [ "${#__ghv_flags[@]}" -ne 7 ]; then
  fail=$((fail + 1)); __ghv_axis_ok=0
  fail_log="${fail_log}FAIL gh sub-flag axis: __ghv_flags holds ${#__ghv_flags[@]} spellings, expected exactly 7\n"
  printf 'FAIL gh sub-flag axis: __ghv_flags holds %s spellings, expected exactly 7\n' "${#__ghv_flags[@]}"
fi
[ "$__ghv_axis_ok" = 1 ] && { pass=$((pass + 1)); printf 'ok   the gh sub-flag axes are 26 triples x 7 flag spellings\n'; }

for __ghv_t in "${__ghv_targets[@]}"; do
  __ghv_grp="${__ghv_t%%|*}"; __ghv_rest="${__ghv_t#*|}"
  __ghv_vrb="${__ghv_rest%%|*}"; __ghv_cn="${__ghv_rest#*|}"
  __ghv_re="${!__ghv_cn}"
  for __ghv_f in "${__ghv_flags[@]}"; do
    want_match 0 "gh $__ghv_grp <$__ghv_f> $__ghv_vrb -> ${__ghv_cn#GATE_RE_GH_}" \
      "gh $__ghv_grp $__ghv_f $__ghv_vrb 42" "$__ghv_re"
  done
  # The CONTROL for the whole row: the same triple with the flag in the LEFT
  # slot, which matched before this change. A row where both directions pass for
  # the wrong reason (a pattern that matches everything) is caught by part 3.
  want_match 0 "gh <-R slug> $__ghv_grp $__ghv_vrb -> ${__ghv_cn#GATE_RE_GH_} (pre-3242 control)" \
    "gh -R go-to-k/cdkd $__ghv_grp $__ghv_vrb 42" "$__ghv_re"
done

# --- part 3: the other direction --------------------------------------------
#
# gh's READ verbs under the SAME flag spellings. These are the polarity control
# for the widening: the absorber allows ANY token after the first flag, so the
# only thing keeping `gh pr -R o/r list` out of the gates is that `list` is not
# in the verb alternation. If a future edit widens the verb ALTERNATION -- "any
# token may be the verb" -- every one of these reds.
#
# THAT IS A CLAIM ABOUT THE ALTERNATION AND NOT ABOUT THE ABSORBER, and an
# earlier revision of this paragraph conflated the two. Every command here still
# carries a real `-R`, so relaxing the absorber's SHAPE (dropping its
# leading-dash requirement) leaves all of them green: measured in
# go-to-k/cdkd#3242's round-4 review, that mutant reddened quoted-mention and
# selector cases elsewhere in the file and nothing in this block. The shape is
# pinned by the three BARE-token cases above instead.
for __ghv_rv in list view diff checks status ready; do
  for __ghv_f in "-R go-to-k/cdkd" "--repo=go-to-k/cdkd" "-R go-to-k/cdkd --json number"; do
    want_match 1 "gh pr <$__ghv_f> $__ghv_rv is not a write verb" \
      "gh pr $__ghv_f $__ghv_rv 42" "$GATE_RE_GH_PR_WRITE"
  done
done
# A verb NAME that merely starts with a guarded verb must not match either --
# the trailing `([[:space:]]|$)` is what stops it, and it is easy to drop while
# editing the group-word half.
want_match 1 "gh pr <-R slug> merged-at is not merge"  'gh pr -R go-to-k/cdkd merged-at 42' "$GATE_RE_GH_PR_MERGE"
want_match 1 "gh pr <-R slug> created-by is not create" 'gh pr -R go-to-k/cdkd created-by 42' "$GATE_RE_GH_PR_CREATE"
# And the quoted-mention guard, which the widening must not spend: a verb that
# only ever appears inside an argument value is still not a command.
want_match 1 "the verb inside a --body value stays inert" \
  'gh pr -R go-to-k/cdkd comment 42 --body "then gh pr merge 3242"' "$GATE_RE_GH_PR_MERGE"
want_match 1 "the verb inside a --title value stays inert" \
  'gh pr -R go-to-k/cdkd list --search "gh pr merge"' "$GATE_RE_GH_PR_MERGE"

# THE ACCEPTED FALSE REFUSALS, declared rather than discovered — and the first
# version of this paragraph UNDERSTATED them, which is the part worth reading.
#
# It said "exactly one shape". That was measured on a 33-command corpus and it is
# FALSE, because the right slot is structurally more permissive than the left:
# `GATE_GH_V` sits between the group word and the VERB, so after the first flag
# an arbitrary RUN of tokens may intervene before the alternation is tried, and
# `_GATE_WORD_BLIND` is quote-blind enough to tile half a single-quoted span. In
# the LEFT slot the equivalent needed the literal `pr merge` inside the value;
# here only the VERB WORD is needed, anywhere later in the segment. So an
# ordinary SINGLE-QUOTED body containing the word `merge` or `create` reaches the
# gates. Measured through the shipped hooks (go-to-k/cdkd#3242 code review):
#
#   gh pr -R <slug> comment 3242 --body 'Ready to merge once CI is green'
#      verify-pr-gate rc=2, ci-green-gate rc=2, pr-review-gate queried the PR
#   gh pr -R <slug> create --title x --body 'ready to merge 5 after CI'
#      ci-green-gate rc=2, and `gate_pr_selector` read PR *5* out of the PROSE
#
# The trade is KEPT, not narrowed, and this file already records the same trade
# one slot left: `_GATE_WORD_LOOSE_FLAG` admits three false refusals because "a
# false refusal is LOUD -- visible, diagnosable, one rephrase away -- while a
# bypass is SILENT". Both halves hold here: the DOUBLE-quoted spelling of every
# command below is inert (one case up), so the rephrase exists; and narrowing the
# absorber to avoid these restores a total bypass of every merge gate.
#
# What changed is the HONESTY of the declaration, not the behaviour. Do not
# re-narrow it to "one shape" from a corpus that happens not to contain a
# single-quoted body -- and note it was measured too narrow a SECOND time:
# the class is any BARE or SINGLE-QUOTED mid-span verb word after a
# right-slot flag, not `--body` alone. A survey of ~70 realistic read and
# comment shapes against origin/main found 9 newly refusing, including
# `list --search merge`, `--label merge`, `--template create` and
# `comment -b 'LGTM, merge it'`. Every double-quoted twin, a verb word at a
# quote EDGE, `--json mergeable`, `--state merged` and a `--jq` program
# containing the word all stay inert.
want_match 0 "ACCEPTED false refusal: an unquoted verb as a later flag value" \
  'gh pr -R go-to-k/cdkd list --label merge' "$GATE_RE_GH_PR_MERGE"
want_match 0 "ACCEPTED false refusal: the verb word inside a SINGLE-quoted body" \
  "gh pr -R go-to-k/cdkd comment 3242 --body 'Ready to merge once CI is green'" "$GATE_RE_GH_PR_MERGE"
want_match 0 "ACCEPTED false refusal: a single-quoted body on a create" \
  "gh pr -R go-to-k/cdkd create --title x --body 'ready to merge 5 after CI'" "$GATE_RE_GH_PR_MERGE"
# ...and the CONTROL that keeps the rephrase real: the DOUBLE-quoted twin of the
# line above is inert, so the advice "quote it with double quotes" is not a
# guess. If this ever goes MATCH the accepted trade has silently widened.
want_match 1 "the same body in DOUBLE quotes stays inert (the rephrase)" \
  'gh pr -R go-to-k/cdkd comment 3242 --body "Ready to merge once CI is green"' "$GATE_RE_GH_PR_MERGE"
# THE ISSUE GROUP TAKES THE SAME COST, and had no case: a bare flag value that
# happens to be a gh verb arms the ISSUE constants from a READ command. Pinned
# because `GATE_RE_GH_ISSUE_CREATE` is the mint gate's trigger, so this is the
# accepted class landing on the group word the other cases do not cover.
want_match 0 "ACCEPTED false refusal: a bare flag value on the ISSUE group" \
  'gh issue -R go-to-k/cdkd list --label create' "$GATE_RE_GH_ISSUE_CREATE"
# THE QUOTE EDGES bound the accepted class, and they are TIGHTER than any prose
# written about them so far -- the reviewer's note said "a verb word at a quote
# edge is inert", and the library's own note said "single-quoted bodies refuse".
# Measured, the verb word must be STRICTLY INTERIOR: neither the first word of
# the span nor the LAST. The last-word half is the one both descriptions missed,
# and it falls straight out of the pattern: the verb alternation is followed by
# `([[:space:]]|$)`, and the character after the final word of a span is the
# closing QUOTE, which is neither. So the surface is narrower than declared, and
# these three pin all three positions rather than restating a sentence.
want_match 1 "a verb word FIRST in a quoted span stays inert" \
  "gh pr -R go-to-k/cdkd list --search 'create'" "$GATE_RE_GH_PR_CREATE"
want_match 1 "a verb word LAST in a quoted span stays inert too (no trailing space)" \
  "gh pr -R go-to-k/cdkd list --search 'x create'" "$GATE_RE_GH_PR_CREATE"
want_match 0 "...only a STRICTLY INTERIOR verb word is reached" \
  "gh pr -R go-to-k/cdkd list --search 'x create y'" "$GATE_RE_GH_PR_CREATE"

# A QUOTED VERB AFTER A BETWEEN-SLOT FLAG (go-to-k/cdkd#3242 review, found
# independently by the security and code reviewers). `gate_dequote_structural`
# took the token straight after the group word, so for `gh pr -R <slug> "merge"`
# it rewrote `-R` and stopped, leaving the quoted verb undequoted while the LEFT
# slot handled the same shape. Measured before the fix, through the real hooks:
# `gh pr -R go-to-k/cdkd "merge" 42 --squash` gave verify-pr-gate rc=0 against
# rc=2 for both `gh pr "merge" 42` and `gh -R … pr "merge" 42`, and
# `gh issue -R <slug> "create" --body-file <bare #N>` took
# pr-body-item-number-gate from 2 to 0.
want_match 0 "quoted verb after a between-slot flag, double quotes" \
  'gh pr -R go-to-k/cdkd "merge" 42 --squash' "$GATE_RE_GH_PR_MERGE"
want_match 0 "quoted verb after a between-slot flag, single quotes" \
  "gh pr -R go-to-k/cdkd 'merge' 42 --squash" "$GATE_RE_GH_PR_MERGE"
want_match 0 "quoted verb after a glued between-slot flag" \
  'gh pr -Rgo-to-k/cdkd "merge" 42' "$GATE_RE_GH_PR_MERGE"
# THE BOUNDARY OF THE FIX, asserted rather than left implicit. This case was a
# RESIDUE until go-to-k/cdkd#3284 and is a positive now: `--json` is not in
# `_gate_is_value_flag`, so `number` used to read as the first bare token and
# the walk stopped there, leaving the quoted verb behind it unreachable.
#
# What closed it is a RULE, not a longer flag list -- widening that list is the
# enumeration treadmill hooks-class-fences.md says to refuse. Measured on
# gh 2.92.0 at the group level: `gh pr --json number "view" 3271 -R go-to-k/cdkd`
# resolves (the unknown flag ate `number`, the QUOTED `view` was the verb) while
# `gh pr --web "view" 3271` errors `unknown flag: --web`. So an unknown bare
# `--x` / `-x` there consumes exactly ONE following token verbatim, and the walk
# now does the same regardless of that token's quoting.
want_match 0 "a quoted verb behind an unenumerated value flag IS reached (#3284)" \
  'gh pr -R go-to-k/cdkd --json number "merge" 42' "$GATE_RE_GH_PR_MERGE"
# The four spellings go-to-k/cdkd#3284 names, each measured nomatch on
# `origin/main` AND on go-to-k/cdkd#3242's head -- a residue that change did not
# close rather than one it opened.
want_match 0 "#3284: quoted verb after a long flag's bare value" \
  'gh pr --json url "merge" 42' "$GATE_RE_GH_PR_MERGE"
want_match 0 "#3284: quoted verb after a short flag's bare value" \
  'gh pr -q .x "merge" 42' "$GATE_RE_GH_PR_MERGE"
want_match 0 "#3284: quoted verb after -t's bare value" \
  'gh pr -t x "merge" 42' "$GATE_RE_GH_PR_MERGE"
want_match 0 "#3284: the ISSUE group takes the same rule" \
  'gh issue -R o/r --json url "create"' "$GATE_RE_GH_ISSUE_CREATE"
# A GLUED value consumes NOTHING, so the token after it is still the subcommand.
# Without this the fix could have been written as "skip one token after any
# flag", which loses `--json=x "merge"`.
want_match 0 "#3284: a --flag=value consumes nothing, so the next quoted token is the verb" \
  'gh pr --json=number "merge" 42' "$GATE_RE_GH_PR_MERGE"
# THE OTHER DIRECTION, and it is the half that prices the change. The consumed
# value is still emitted VERBATIM, so a QUOTED value keeps its quotes and the
# gates still do not see the verb word inside it. Every one of these is nomatch
# BEFORE and AFTER; if one flips, the accepted false-refusal surface has widened
# beyond what go-to-k/cdkd#3242's declaration priced.
want_match 1 "#3284 polarity: a quoted flag VALUE is not the verb (read command)" \
  'gh pr --search "merge" list' "$GATE_RE_GH_PR_MERGE"
want_match 1 "#3284 polarity: a quoted value on a read verb stays inert" \
  'gh pr -R o/r --json "merge" view 42' "$GATE_RE_GH_PR_MERGE"
want_match 1 "#3284 polarity: a template body carrying the word stays inert" \
  'gh pr --template "{{.title}} merge {{.number}}" list' "$GATE_RE_GH_PR_MERGE"
want_match 1 "#3284 polarity: a quoted READ verb after a bare value stays inert" \
  'gh pr -L 5 "list"' "$GATE_RE_GH_PR_WRITE"
# A FLAG VALUE THAT STARTS WITH `-` IS STILL THE VALUE (go-to-k/cdkd#3273
# review). cobra does not look at what it is consuming: measured on gh 2.92.0,
# `gh pr --search -x "list"` and `gh pr --search --web "list"` both RUN `list`,
# so the `-`-prefixed token was eaten as `--search`'s value and the QUOTED token
# after it was the subcommand. The first cut of go-to-k/cdkd#3284 put the
# pending-value test inside the `*)` arm, so a `-`-prefixed value took the FLAG
# arm instead and these four real merges matched NOTHING in every gate. They are
# nomatch on the merge base too, so a residue rather than a regression -- but the
# rule that closes them is the same one condition, in the refusing direction.
want_match 0 "#3273: a --flag whose value starts with -- still leaves the verb reachable" \
  'gh pr -t --squash "merge" 42' "$GATE_RE_GH_PR_MERGE"
want_match 0 "#3273: ...with a short-flag value" \
  'gh pr -t -x "merge" 42' "$GATE_RE_GH_PR_MERGE"
want_match 0 "#3273: ...with a bare -- as the value" \
  'gh pr -t -- "merge" 42' "$GATE_RE_GH_PR_MERGE"
want_match 0 "#3273: ...with -R itself eaten as the value, a later -R naming the repo" \
  'gh pr -t -R "merge" 42 -R o/r' "$GATE_RE_GH_PR_MERGE"
# THE OTHER DIRECTION for that same condition. Consuming a `-`-prefixed value
# must not make a READ reachable: the token after the consumed one is the
# subcommand, and `list` is not a gated verb.
want_match 1 "#3273 polarity: a read verb after a --flag with a -- value stays inert" \
  'gh pr --search -x "list"' "$GATE_RE_GH_PR_MERGE"
want_match 1 "#3273 polarity: the same with a long-flag value" \
  'gh pr --search --web "list"' "$GATE_RE_GH_PR_MERGE"
# ...and the case the widening LOSES, pinned so the loss is declared rather
# than discovered. `--json` eats `--repo`, so `o/r` is the subcommand and gh
# answers `unknown command`. Not a merge, so losing it is correct.
want_match 1 "#3273: an enumerated flag EATEN as a value stops being a value flag" \
  'gh pr --json --repo o/r "merge" 42' "$GATE_RE_GH_PR_MERGE"

# THE RESIDUE THAT SURVIVES, stated rather than left silent. A short-flag CLUSTER
# longer than `-X` is classified as carrying its own value (the
# go-to-k/cdkd#3242 arm that keeps `-Rgo-to-k/cdkd "merge"` working), so a
# cluster whose LAST member takes a SEPARATE value stops the walk on that value.
# Undecidable from the text -- `-tRelease` is `--title Release`, `-sR o/r` is
# `--squash --repo o/r`, and only a per-flag arity table tells them apart, which
# is the enumeration this file refuses. Pinned so that anyone who changes the
# cluster arm reds here.
want_match 1 "residue: a 3+-char short cluster taking a separate value stops the walk" \
  'gh pr -sR go-to-k/cdkd "merge" 42' "$GATE_RE_GH_PR_MERGE"
# ...and the control proving that residue is about the CLUSTER shape and not
# about "two flags": two ordinary flags DO reach the quoted verb.
want_match 0 "two enumerated value flags still reach the quoted verb" \
  'gh pr -R go-to-k/cdkd --repo go-to-k/cdkd "merge" 42' "$GATE_RE_GH_PR_MERGE"
want_match 0 "quoted group verb on issue create" \
  'gh issue -R go-to-k/cdkd "create" --title t' "$GATE_RE_GH_ISSUE_CREATE"
# POLARITY: dequoting the verb slot must not turn a quoted READ verb into a
# write one. Without this the five above are satisfied by a walk that dequotes
# every token and lets any of them fill the verb slot.
want_match 1 "a quoted READ verb after a between-slot flag stays inert" \
  'gh pr -R go-to-k/cdkd "list" --json number' "$GATE_RE_GH_PR_WRITE"

# THE ABSORBER'S SHAPE, not just the verb ALTERNATION -- one per group word.
#
# `GATE_GH_V` requires the prefix to OPEN WITH A FLAG: a bare token in first
# position is the subcommand, which is the whole stopping rule this change
# leans on. Nothing pinned that. The read-verb cases above vary the VERB while
# every command still carries a real `-R`, so relaxing the absorber to "any
# token sequence" left them all green -- measured, that mutant reddened only
# quoted-mention and selector cases elsewhere in the file, never the family
# block's own subject.
#
# These three carry a BARE non-flag token where the flag would go, so they
# discriminate the SHAPE: nomatch with the absorber as written, MATCH under the
# relaxed mutant, on all three group words (go-to-k/cdkd#3242 round-4 review).
want_match 1 "a BARE token before the verb is the subcommand, not a flag (pr)" \
  'gh pr list merge 42' "$GATE_RE_GH_PR_MERGE"
want_match 1 "...the same for the issue group" \
  'gh issue list create x' "$GATE_RE_GH_ISSUE_CREATE"
want_match 1 "...and for the release group" \
  'gh release list create v1' "$GATE_RE_GH_PROSE_CARRIER"

# THE DEQUOTE WALK SHARES ONE TOKEN BUDGET ACROSS BOTH SLOTS, fenced
# DETERMINISTICALLY rather than by a clock (go-to-k/cdkd#3242 round-3 review).
#
# The round-2 walk took a PRIVATE `GATE_STRUCT_MAXTOK`, so a segment could buy
# 24 `_gate_struct_next` full-string regexes per slot instead of 24 in total.
# That walk is quadratic in the remaining string, so the cost lands on command
# LENGTH: through the real pr-body-item-number-gate with both slots filled, a
# 150 KB tail went 4.27 s on origin/main to 7.02 s, and the cheapest input that
# KILLS the hook fell from ~260 KB to ~155 KB. A killed hook emits no exit 2 and
# disarms every gate at once.
#
# A TIMING case was written for this first and REJECTED after a reviewer probed
# it: reinstating the private budget left the suite green at 2-3 s against an
# 8 s budget, because the doubling is worth only +1-2 s and machine noise
# exceeds it. The reviewer's own proposed replacement -- k flags in the RIGHT
# slot alone -- was then measured here and does not discriminate either: shared
# and private are byte-identical verdicts for k=1..30, because one slot never
# exceeds one budget. Both are recorded because each looks right.
#
# What DOES discriminate is filling BOTH slots, which is where the doubling
# lives by construction: the outer walk spends the budget and the inner one then
# either shares what is left (matching stops at half) or starts over (matching
# continues to the full count). Measured across k=1..20:
#
#   shared `n`        MATCH to k=11, nomatch from k=12
#   private budget    MATCH at every k through 20
#
# so the pair below straddles that boundary. `k` is DERIVED from
# `GATE_STRUCT_MAXTOK` rather than written as 11/12, so retuning the cap moves
# the fence with it instead of silently retiring it.
__bud_k=$(( GATE_STRUCT_MAXTOK / 2 ))
__bud_lo=""; __bud_hi=""
for _i in $(seq 1 $((__bud_k - 1))); do __bud_lo="$__bud_lo -R o/r"; done
for _i in $(seq 1 "$__bud_k"); do __bud_hi="$__bud_hi -R o/r"; done
want_match 0 "both slots just inside the SHARED budget still reach the quoted verb" \
  "gh$__bud_lo pr$__bud_lo \"merge\" 42" "$GATE_RE_GH_PR_MERGE"
want_match 1 "both slots past the SHARED budget abandon the rewrite (a private budget would still match)" \
  "gh$__bud_hi pr$__bud_hi \"merge\" 42" "$GATE_RE_GH_PR_MERGE"
# The BARE verb is unaffected at any count -- it needs no dequoting -- which is
# what says the pair above measures the WALK's budget and not the regex.
want_match 0 "the bare verb is reached at the same count (the budget is the walk's, not the pattern's)" \
  "gh$__bud_hi pr$__bud_hi merge 42" "$GATE_RE_GH_PR_MERGE"

# THE QUOTED VALUE OF AN UNENUMERATED FLAG IS NOT THE VERB (go-to-k/cdkd#3242
# round-2 security review). The first revision of the dequote walk rewrote every
# token it stepped over, so a flag `_gate_is_value_flag` does not know -- `gh`
# really does accept non-global flags in this slot; `gh pr --search x -R o/r
# list` answers normally -- had its QUOTED value dequoted and then taken as the
# subcommand. Measured against origin/main, which matched NEITHER:
#
#   gh pr --search "merge" list            nomatch -> MATCH
#   gh pr -R o/r --json "merge" view 42    nomatch -> MATCH, selector 42
#
# The second is a READ command arming ci-green, pr-review and the four integ
# gates. It also falsified the accepted-false-refusal note above, which promises
# the DOUBLE-quoted rephrase is inert -- true for a body, false for a flag value
# placed before the verb. The walk now emits such a token VERBATIM and keeps
# looking, so only a BARE token becomes the verb.
want_match 1 "a quoted flag value before the verb is not the verb" \
  'gh pr --search "merge" list' "$GATE_RE_GH_PR_MERGE"
want_match 1 "a quoted flag value before a READ verb does not arm the merge gates" \
  'gh pr -R go-to-k/cdkd --json "merge" view 42' "$GATE_RE_GH_PR_MERGE"
want_match 1 "the same, single-quoted" \
  "gh pr -R go-to-k/cdkd --json 'merge' view 42" "$GATE_RE_GH_PR_MERGE"
# CONTROLS. The narrowing must not cost the two shapes the walk exists for: an
# ENUMERATED value flag still reaches its quoted verb, and the plain between-slot
# spelling is untouched.
want_match 0 "an ENUMERATED value flag still reaches the quoted verb" \
  'gh pr -R go-to-k/cdkd "merge" 42' "$GATE_RE_GH_PR_MERGE"
want_match 0 "the plain between-slot spelling is untouched" \
  'gh pr -R go-to-k/cdkd merge 42' "$GATE_RE_GH_PR_MERGE"
# ...and the BARE half is deliberately unchanged: it is the pre-existing
# over-approximation already declared above, not something this narrowing claims.
want_match 0 "a BARE flag value is still read as the subcommand (declared, unchanged)" \
  'gh pr --search merge list' "$GATE_RE_GH_PR_MERGE"

# BLOCK CARDINALITY GUARD. `CASE_FLOOR` below is a collapse detector set well
# under the total and cannot see this block shrink; a `for` over an array that
# stops expanding runs zero cases and reports a clean tally.
#
# THE EXPECTED COUNT IS LITERAL, and the first version of it was VACUOUS for the
# textbook reason: it read `${#__ghv_targets[@]}` and `${#__ghv_flags[@]}`, the
# very arrays whose collapse it claims to detect, so emptying either shrank both
# sides of the comparison and the guard reported `ok ... ran all 41 cases`
# (measured, go-to-k/cdkd#3242 test review — and under bash 3.2 it only reddened
# by ACCIDENT, on `set -u` against an empty array). A floor whose expected value
# is computed from the pool it guards is unfalsifiable; hooks-class-fences.md
# says so about its own floors and this block ignored it.
#
# So the two axis SIZES are asserted as literals first, and the case count is a
# literal product. Adding an axis member is meant to be a two-line edit here —
# that is the cost of a floor that cannot be satisfied by its own collapse.
__ghv_ran=$((pass + fail - __ghv_start))
# 1 population lint + 1 axis assertion + 26*(7+1) cross product + 6*3 read verbs
# + 2 verb-prefix + 2 quoted-mention + 8 accepted false refusals
# + 36 quoted-verb / flag-value / bare-token / shared-budget
#   (19, plus the 10 go-to-k/cdkd#3284 added: 5 newly-reached spellings, 4
#   polarity controls and 1 surviving-residue case; plus the 7 its review
#   added for a flag VALUE that starts with `-`: 4 newly-reached merges, 2
#   read-verb polarity controls and 1 declared LOSS).
# (The prose said 4 and 13 while the literals said 8 and 19 -- the arithmetic was
# right and the sentence was not, which is the cheapest kind of stale claim to
# ship and the easiest to catch by reading the two against each other.)
__ghv_want=$(( 1 + 1 + 26 * 8 + 18 + 2 + 2 + 8 + 36 ))
if [ "$__ghv_ran" -ne "$__ghv_want" ]; then
  fail=$((fail + 1))
  fail_log="${fail_log}FAIL the gh sub-flag block ran $__ghv_ran cases, expected exactly $__ghv_want -- an axis stopped expanding, or one was added without updating the literal\n"
  printf 'FAIL the gh sub-flag block ran %s cases, expected exactly %s\n' "$__ghv_ran" "$__ghv_want"
else
  pass=$((pass + 1))
  printf 'ok   the gh sub-flag block ran all %s cases\n' "$__ghv_ran"
fi

# --- the spellings that used to bypass ---------------------------------------
want_match 0 "bare git commit"              'git commit -m x' "$C"
want_match 0 "git add -A && git commit"     'git add -A && git commit -m x' "$C"
want_match 0 "cd && git commit"             'cd /w/t && git commit -m x' "$C"
want_match 0 "cd ; git commit"              'cd /w/t; git commit -m x' "$C"
want_match 0 "no spaces around &&"          'cd /w/t&&git commit -m x' "$C"
want_match 0 "subshell"                     '(cd /w/t && git commit -m x)' "$C"
want_match 0 "leading env assignment"       'GIT_EDITOR=true git commit -m x' "$C"
want_match 0 "env wrapper"                  'env git commit -m x' "$C"
want_match 0 "git -C <path> commit"         'git -C /w/t commit -m x' "$C"
want_match 0 "git -c k=v commit"            'git -c user.name=t commit -m x' "$C"
want_match 0 "three-segment chain"          'vp run check && git add -A && git commit -m x' "$C"
want_match 0 "pipe into another command"    'git commit -m x | tee log' "$C"
want_match 0 "gh pr merge after a push"     'git push && gh pr merge 1 --squash' "$M"
want_match 0 "git push in second position"  'echo go && git push origin HEAD' "$P"

# --- negatives ----------------------------------------------------------------
want_match 1 "verb inside a double-quoted string" 'echo "next: git commit -m x"' "$C"
want_match 1 "verb inside a single-quoted string" "echo 'run git commit later'" "$C"
want_match 1 "heredoc body mentioning the verb"   'cat <<EOF
git commit -m x
EOF' "$C"
want_match 1 "different verb"                     'git status --short' "$C"
want_match 1 "commit as an argument, not a verb"  'git log --grep commit' "$C"
want_match 1 "push is not commit"                 'git push origin HEAD' "$C"
want_match 1 "gh pr create is not merge"          'gh pr create --fill' "$M"

# --- target directory ---------------------------------------------------------
want_dir "/fallback"  "no cd, no -C"           'git commit -m x' /fallback "$C"
want_dir "/w/t"       "leading cd"             'cd /w/t && git commit -m x' /fallback "$C"
want_dir "/w/t"       "cd in an earlier segment" 'cd /w/t && git add -A && git commit -m x' /fallback "$C"
want_dir "/w/b"       "chained cd"             'cd /w && cd /w/b && git commit -m x' /fallback "$C"
want_dir "/fallback/rel" "relative cd"         'cd rel && git commit -m x' /fallback "$C"
want_dir "/w/t"       "git -C beats cd"        'cd /other && git -C /w/t commit -m x' /fallback "$C"
want_dir "/w/t"       "gh -C on a merge"       'gh -C /w/t pr merge 1 --squash' /fallback "$M"
want_dir "/fallback"  "cd AFTER the verb does not count" 'git commit -m x && cd /w/t' /fallback "$C"

# --- the review findings from go-to-k/cdk-local#542 --------------------------
# Every one of these was measured WRONG in the first version of this helper.
want_match 0 "bare & separator"              'sleep 0 & git commit -m x' "$C"
want_match 0 "command substitution"          'echo $(git commit -m x)' "$C"
want_match 0 "substitution into a variable"  'SHA=$(git commit -m x)' "$C"
want_match 0 "backtick substitution"         'echo `git commit -m x`' "$C"
want_match 0 "bash -c wrapper"               'bash -c "git commit -m x"' "$C"
want_match 0 "if/then compound"              'if true; then git commit -m x; fi' "$C"
want_match 0 "for/do compound"               'for f in a; do git commit -m x; done' "$C"
want_match 0 "timeout wrapper"               'timeout 60 git commit -m x' "$C"
want_match 0 "time wrapper"                  'time git commit -m x' "$C"
want_match 0 "nested subshells"              '( ( git commit -m x ) )' "$C"
want_match 0 "backslash continuation"        'git \
  commit -m x' "$C"
want_match 0 "quoted -C path with a space"   'git -C "/w t" commit -m x' "$C"

# The quote machinery only earns its keep on a separator INSIDE a string: without
# it these match, and the gates start blocking ordinary `echo`s.
want_match 1 "&& inside a quoted string"     'echo "step && git commit -m x"' "$C"
want_match 1 "; inside a quoted string"      "echo 'step ; git commit -m x'" "$C"
want_match 1 "| inside a quoted string"      'echo "step | git commit -m x"' "$C"
# A quoted span survives a NEWLINE: a `--body "…"` argument is one span, and this
# repo writes PR bodies that quote shell examples.
want_match 1 "multi-line quoted body" 'gh pr create --body "line one
line two && git commit -m x
line three"' "$C"
want_match 1 "CRLF heredoc terminator" 'cat <<EOF
body
EOF
echo done' "$C"

want_dir "/w t"   "quoted cd path"   'cd "/w t" && git commit -m x' /fb "$C"
want_dir "/w t"   "quoted -C path"   'git -C "/w t" commit -m x' /fb "$C"
want_dir "/fb"    "-C in a NON-matched segment is ignored" \
  'git -C /elsewhere status && git commit -m x' /fb "$C"


# --- heredoc openers are only honoured when TERMINATED (cdkd, issue #1455) ----
# Latching onto any `<<WORD` blanks every remaining line, so a real verb after
# an unterminated heredoc measures as NO MATCH — fail open.
want_match 0 "unterminated heredoc then a real commit" 'cat <<EOF
some prose
git commit -m x' "$C"
want_match 0 "here-string is not a heredoc opener" 'grep x <<< "data" && git commit -m x' "$C"

# --- one compound positive + one negative for every cdkd-only GATE_RE_* ------
want_match 0 "commit-or-push"          'git add -A && git commit -m x'                  "$GATE_RE_GIT_COMMIT_OR_PUSH"
want_match 1 "commit-or-push negative" 'git fetch origin'                               "$GATE_RE_GIT_COMMIT_OR_PUSH"

want_match 0 "git merge"               'git fetch origin && git merge origin/main'      "$GATE_RE_GIT_MERGE"
want_match 1 "git merge negative"      'git log --merges'                               "$GATE_RE_GIT_MERGE"

want_match 0 "git switch"              'git fetch && git switch -c fix/x'               "$GATE_RE_GIT_SWITCH"
want_match 1 "git switch negative"     'echo "then git switch main"'                    "$GATE_RE_GIT_SWITCH"

want_match 0 "git restore"             'git stash && git restore -- src/a.ts'           "$GATE_RE_GIT_CHECKOUT_RESTORE"
want_match 1 "git restore negative"    'git status && ls restore'                       "$GATE_RE_GIT_CHECKOUT_RESTORE"

want_match 0 "gh pr create-or-merge"   'vp run test && gh pr merge 1 --squash'          "$GATE_RE_GH_PR_CREATE_OR_MERGE"
want_match 1 "gh pr create-or-merge negative" 'gh pr checks 1'                          "$GATE_RE_GH_PR_CREATE_OR_MERGE"

want_match 0 "gh pr write"             'git push && gh pr edit 1 --title x'             "$GATE_RE_GH_PR_WRITE"
want_match 1 "gh pr write negative"    'gh pr diff 1'                                   "$GATE_RE_GH_PR_WRITE"

want_match 0 "gh label carrier"        'git push && gh issue create --label bug'        "$GATE_RE_GH_LABEL_CARRIER"
want_match 1 "gh label carrier negative" 'gh issue list --label bug'                    "$GATE_RE_GH_LABEL_CARRIER"

want_match 0 "gh api"                  'gh pr view 1 && gh api repos/o/r/issues'        "$GATE_RE_GH_API"
want_match 1 "gh api negative"         'echo "call gh api later"'                       "$GATE_RE_GH_API"

want_match 0 "gh body carrier"         'git push && gh issue comment 1 --body-file b.md' "$GATE_RE_GH_BODY_CARRIER"
want_match 1 "gh body carrier negative" 'gh issue view 1'                               "$GATE_RE_GH_BODY_CARRIER"

want_match 0 "vp run test"             'vp run build && vp run test'                    "$GATE_RE_VP_RUN_TEST"
want_match 1 "vp run test negative"    'vp run test:hooks'                              "$GATE_RE_VP_RUN_TEST"

want_match 0 "cdk deploy"              'cd tests/integration/x && npx cdk deploy --all' "$GATE_RE_CDK_DEPLOY"
want_match 1 "cdk deploy negative"     'echo "then npx cdk deploy"'                     "$GATE_RE_CDK_DEPLOY"

want_match 0 "cdk destroy"             'cd x && cdk destroy --force'                    "$GATE_RE_CDK_DESTROY"
want_match 1 "cdk destroy negative"    'ls cdk-destroy.log'                             "$GATE_RE_CDK_DESTROY"

want_match 0 "delstack"                'cd x && delstack -s S -r us-east-1 -y -f'       "$GATE_RE_DELSTACK"
want_match 1 "delstack negative"       'echo "run delstack afterwards"'                 "$GATE_RE_DELSTACK"

# --- positions issue #2093 named (all must MATCH) ----------------------------
# Measured against main-tree-git-cwd-detector.sh: the #1455 anchor treated only
# a control operator as opening a command position, so each of these was quiet
# where the pre-shared-matcher hook had warned.
want_match 0 "subshell"                       '(git commit -m x)' "$C"
want_match 0 "subshell after a chain"         'true && (git commit -m x)' "$C"
want_match 0 "command substitution"           'out=$(git commit -m x)' "$C"
want_match 0 "backtick substitution"          'out=`git commit -m x`' "$C"
want_match 0 "bare & separator"               'sleep 1 & git commit -m x' "$C"
want_match 0 "bash -c runs its argument"      'bash -c "git commit -m x"' "$C"
want_match 0 "then keyword"                   'if true; then git commit -m x; fi' "$C"
want_match 0 "unbalanced apostrophe upstream" $'echo don\'t; git commit -m y' "$C"
want_match 0 "backslash continuation"         'git add -A && \
  git commit -m x' "$C"
# ...and through the compatibility wrapper the other 18 gates call.
check "subshell via cmd_matches_verb" 0 "$COMMIT" '(git commit -m x)'
check "substitution via cmd_matches_verb" 0 "$COMMIT" 'out=$(git commit -m x)'

# --- heredoc openers only count when TERMINATED ------------------------------
# Latching onto any `<<WORD` blanks every remaining line, so a real verb after
# an unterminated heredoc reads as NO MATCH — fail open, the direction that
# silently disables a gate.
want_match 0 "unterminated heredoc then a real commit" 'cat <<EOF
some prose
git commit -m x' "$C"
want_match 0 "here-string is not a heredoc opener" 'grep x <<< "data" && git commit -m x' "$C"
want_match 1 "terminated heredoc body is data" 'cat <<EOF
git commit -m x
EOF' "$C"

# --- one compound positive + one negative for every cdkd-only GATE_RE_* ------
want_match 0 "commit-or-push"          'git add -A && git commit -m x'                  "$GATE_RE_GIT_COMMIT_OR_PUSH"
want_match 1 "commit-or-push negative" 'git fetch origin'                               "$GATE_RE_GIT_COMMIT_OR_PUSH"

want_match 0 "git merge"               'git fetch origin && git merge origin/main'      "$GATE_RE_GIT_MERGE"
want_match 1 "git merge negative"      'git log --merges'                               "$GATE_RE_GIT_MERGE"

want_match 0 "git switch"              'git fetch && git switch -c fix/x'               "$GATE_RE_GIT_SWITCH"
want_match 1 "git switch negative"     'echo "then git switch main"'                    "$GATE_RE_GIT_SWITCH"

want_match 0 "git restore"             'git stash && git restore -- src/a.ts'           "$GATE_RE_GIT_CHECKOUT_RESTORE"
want_match 1 "git restore negative"    'git status && ls restore'                       "$GATE_RE_GIT_CHECKOUT_RESTORE"

want_match 0 "gh pr create-or-merge"   'vp run test && gh pr merge 1 --squash'          "$GATE_RE_GH_PR_CREATE_OR_MERGE"
want_match 1 "gh pr create-or-merge negative" 'gh pr checks 1'                          "$GATE_RE_GH_PR_CREATE_OR_MERGE"

want_match 0 "gh pr write"             'git push && gh pr edit 1 --title x'             "$GATE_RE_GH_PR_WRITE"
want_match 1 "gh pr write negative"    'gh pr diff 1'                                   "$GATE_RE_GH_PR_WRITE"

want_match 0 "gh label carrier"        'git push && gh issue create --label bug'        "$GATE_RE_GH_LABEL_CARRIER"
want_match 1 "gh label carrier negative" 'gh issue list --label bug'                    "$GATE_RE_GH_LABEL_CARRIER"

want_match 0 "gh api"                  'gh pr view 1 && gh api repos/o/r/issues'        "$GATE_RE_GH_API"
want_match 1 "gh api negative"         'echo "call gh api later"'                       "$GATE_RE_GH_API"

want_match 0 "gh body carrier"         'git push && gh issue comment 1 --body-file b.md' "$GATE_RE_GH_BODY_CARRIER"
want_match 1 "gh body carrier negative" 'gh issue view 1'                               "$GATE_RE_GH_BODY_CARRIER"

want_match 0 "vp run test"             'vp run build && vp run test'                    "$GATE_RE_VP_RUN_TEST"
want_match 1 "vp run test negative"    'vp run test:hooks'                              "$GATE_RE_VP_RUN_TEST"

want_match 0 "cdk deploy"              'cd tests/integration/x && npx cdk deploy --all' "$GATE_RE_CDK_DEPLOY"
want_match 1 "cdk deploy negative"     'echo "then npx cdk deploy"'                     "$GATE_RE_CDK_DEPLOY"

want_match 0 "cdk destroy"             'cd x && cdk destroy --force'                    "$GATE_RE_CDK_DESTROY"
want_match 1 "cdk destroy negative"    'ls cdk-destroy.log'                             "$GATE_RE_CDK_DESTROY"

want_match 0 "delstack"                'cd x && delstack -s S -r us-east-1 -y -f'       "$GATE_RE_DELSTACK"
want_match 1 "delstack negative"       'echo "run delstack afterwards"'                 "$GATE_RE_DELSTACK"

# --- the legacy API keeps its contract on quoted paths -----------------------
# `cmd_last_cd_target` prints NOTHING when no cd precedes the verb, and a
# formerly-unresolvable quoted path now resolves rather than falling back.
if [ -z "$(cmd_last_cd_target 'git commit -m x' /fb "$COMMIT")" ]; then
  pass=$((pass + 1)); printf 'OK   cmd_last_cd_target prints nothing with no cd\n'
else
  fail=$((fail + 1)); printf 'FAIL cmd_last_cd_target prints nothing with no cd\n'
  fail_log+="FAIL cmd_last_cd_target no-cd\n"
fi
got=$(cmd_last_cd_target 'cd "/w t" && git commit -m x' /fb "$COMMIT")
if [ "$got" = "/w t" ]; then
  pass=$((pass + 1)); printf 'OK   cmd_last_cd_target resolves a quoted path\n'
else
  fail=$((fail + 1)); printf 'FAIL cmd_last_cd_target quoted path (got %s)\n' "$got"
  fail_log+="FAIL cmd_last_cd_target quoted path: got $got\n"
fi

# --- go-to-k/cdkd#2130 review: leaders, process substitution, unexpanded paths ---
want_match 0 "if ... then <verb>"      'if true; then git commit -m x; fi' "$C"
want_match 0 "negation"                '! git commit -m x' "$C"
want_match 0 "sudo wrapper"            'sudo git commit -m x' "$C"
want_match 0 "xargs behind a pipe"     'echo f | xargs git commit -m x' "$C"
want_match 0 "case arm"                'case a in a) git commit -m x;; esac' "$C"
want_match 0 "process substitution"    'diff <(git commit -m x) /dev/null' "$C"
want_match 0 "output process substitution" 'tee >(git commit -m x) < f' "$C"

# `cd "$WT" && …` is the spelling /work-issues mandates: an UNEXPANDED path must
# be skipped, so the gate falls back to the payload cwd and fails CLOSED rather
# than resolving `<cwd>/$WT` and exiting 0.
if [ "$(cmd_last_cd_target 'cd "$WT" && git commit -m x' /base)" = "" ]; then
  pass=$((pass + 1)); echo "OK   unexpanded cd is skipped"
else
  fail=$((fail + 1)); echo "FAIL unexpanded cd resolved to $(cmd_last_cd_target 'cd "$WT" && git commit -m x' /base)"
  fail_log+="FAIL unexpanded cd is skipped\n"
fi

# --- go-to-k/cdkd#2130 test review: two real defects, and the unpinned rest ----
want_match 0 "bash -c with an inner chain" 'bash -c "cd /w && git commit -m x"' "$C"
want_match 1 "escaped semicolon is literal" 'echo a\; git commit -m x' "$C"
want_match 1 "ANSI-C quoting hides its contents" "echo \$'x; git commit'" "$C"
want_match 0 "parameter expansion default runs"  'echo ${V:-a; git commit -m x}' "$C"
want_match 1 "# comment holding the verb"        'echo hi # git commit -m x' "$C"
want_match 1 "grep pattern is not a verb"        'git log --grep commit' "$C"
want_match 1 "grep=pattern is not a verb"        'git log --grep=commit' "$C"
want_match 1 "an ordinary task run"              'vp run test' "$C"
# The quoted-span protection is the only thing keeping a gate off prose: pin it
# with a separator INSIDE the quotes, the one shape that can distinguish it.
want_match 1 "separator inside a quoted body" 'gh issue create --body "run vp check && git commit -m x"' "$C"

# --- gate_target_dir_strict (go-to-k/cdkd#2027) -------------------------------
# The strict resolver's whole contract is the DISTINCTION its predecessor could
# not express: "resolved to the fallback" vs "could not resolve at all". The
# fallback form stays available for the non-blocking callers, so both are pinned
# here side by side -- a change that collapsed them again would have to break
# one of these two groups.

# The subject must EXIST. Without this, `gate_target_dir_strict` disappearing
# would turn every refusal case below into a pass rather than a failure.
if declare -F gate_target_dir_strict >/dev/null && declare -F gate_refuse_unresolved_target >/dev/null; then
  pass=$((pass + 1)); printf 'OK   %s\n' "the strict resolver and its refusal helper are defined"
else
  fail=$((fail + 1)); printf 'FAIL %s\n' "gate_target_dir_strict / gate_refuse_unresolved_target undefined"
  fail_log+="FAIL the strict resolver is not defined; every refusal case below is vacuous\n"
fi

# want_strict <expected-dir|REFUSE> <label> <command> <fallback> <regex>
want_strict() {
  local want="$1" label="$2" cmd="$3" fallback="$4" re="$5" got rc
  if got=$(gate_target_dir_strict "$cmd" "$fallback" "$re"); then rc=0; else rc=$?; fi
  # ONLY rc 2 is a refusal. An absent function exits 127, which would otherwise
  # satisfy every REFUSE case below and make this whole block a green no-op --
  # the zero-red-probe failure, arriving through the harness rather than the
  # subject.
  if [ "$rc" = 2 ]; then got="REFUSE"; elif [ "$rc" != 0 ]; then got="ERR($rc)"; fi
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n' "$label"
    fail_log+="FAIL $label\n  want: $want\n  got:  $got\n"
  fi
}

# Resolvable shapes must behave EXACTLY like gate_target_dir.
want_strict "/base"      "no target expression -> fallback"        'git commit -m x' /base "$C"
want_strict "/abs/repo"  "absolute -C"                             'git -C /abs/repo commit -m x' /base "$C"
want_strict "/base/sub"  "relative -C composes onto the fallback"  'git -C sub commit -m x' /base "$C"
want_strict "/a b"       "quoted -C path containing a space"       'git -C "/a b" commit -m x' /base "$C"
want_strict "/abs/one"   "resolvable cd before the verb"           'cd /abs/one && git commit -m x' /base "$C"

# The refusals. Each is a spelling that used to resolve to something else and be
# reported as a pass.
want_strict REFUSE "unexpanded -C, double-quoted"   'git -C "$W" commit -m x' /base "$C"
want_strict REFUSE "unexpanded -C, bare"            'git -C $W commit -m x' /base "$C"
want_strict REFUSE "unexpanded -C, braced"          'git -C "${WORKTREE}" commit -m x' /base "$C"
want_strict REFUSE "backtick in -C"                 'git -C "`pwd`" commit -m x' /base "$C"
want_strict REFUSE "unexpanded cd before the verb"  'cd "$W" && git commit -m x' /base "$C"
want_strict REFUSE "unexpanded cd + RELATIVE -C"    'cd "$W" && git -C sub commit -m x' /base "$C"
want_strict REFUSE "unexpanded gh -C"               'gh -C "$W" pr merge 42 --squash' /base "$M"

# The two shapes that must NOT be refused, because refusing them would be a new
# foot-gun rather than a closed hole. Both were found by a red test, not by
# reasoning: an absolute `-C` makes an earlier unreadable `cd` MOOT (the command
# is perfectly determinate), and a `cd` AFTER the verb never steered it at all
# -- the latter is the standing `git commit ... && cd <repo> && git pull` form.
want_strict "/abs/side" "absolute -C cures an unresolvable cd" \
  'cd "$W" && git -C /abs/side commit -m x' /base "$C"
want_strict "/base"     "a cd AFTER the verb is not a refusal" \
  'git commit -m x && cd "$W" && git pull' /base "$C"

# `~` reaches a hook as a literal segment (no shell has expanded it), so the
# resolver expands it rather than letting a caller refuse a good path.
want_strict "$HOME/repo" "tilde in -C is expanded, not refused" \
  'git -C ~/repo commit -m x' /base "$C"

# The spellings the REVIEW found, which the first round of this fix did not
# cover: a substitution is not a variable, and a quoted path with a space is not
# unreadable at all -- it is determinate, and must RESOLVE rather than refuse.
want_strict REFUSE "quoted command substitution in -C"   'git -C "$(git rev-parse --show-toplevel)" commit -m x' /base "$C"
want_strict REFUSE "UNQUOTED command substitution in -C" 'git -C $(git rev-parse --show-toplevel) commit -m x' /base "$C"
want_strict REFUSE "backtick substitution in -C"         'git -C `pwd` commit -m x' /base "$C"
want_strict "/a b"  "quoted -C path with a space RESOLVES" 'git -C "/a b" commit -m x' /base "$C"

# Anchoring: a `-C` inside an ARGUMENT is prose, not a target. Refusing it named
# a flag the command does not carry and prescribed a fix that could not clear it.
want_strict "/base"     "a -C mentioned inside a commit message is not a target" \
  'git commit -m "repro: git -C $W commit failed"' /base "$C"
want_strict "/abs/repo" "a real -C is not overridden by a mention in an argument" \
  'git -C /abs/repo commit -m "see git -C $W commit"' /base "$C"
want_strict "/two"      "repeated -C takes the LAST, like git itself" \
  'git -C /one -C /two commit -m x' /base "$C"

# The third must-not-refuse shape, alongside the absolute `-C` and the trailing
# `cd`: an ABSOLUTE cd also makes an earlier unreadable one moot.
want_strict "/abs/wt" "an absolute cd cures an earlier unreadable cd" \
  'cd "$W" && cd /abs/wt && git commit -F f' /base "$C"
want_strict REFUSE    "a RELATIVE cd after an unreadable one stays unreadable" \
  'cd "$W" && cd sub && git commit -F f' /base "$C"

# Tilde expands only where a shell would expand it.
want_strict "/tmp/~/x" "a MID-PATH tilde is left alone (no shell expands it)" \
  'git -C /tmp/~/x commit -m x' /base "$C"

# The segmenter must still scan a substitution BODY as a command in its own
# right -- the dual-emit change keeps the enclosing command intact, and this is
# the half that must not be lost in exchange.
want_match 0 "verb inside a command substitution still matches" 'out=$(git commit -m x)' "$C"
want_match 0 "verb inside a subshell still matches"             '(git commit -m x)' "$C"

# The falling-back twin is unchanged for its callers: same inputs, no refusal.
want_dir "/base" "gate_target_dir still FALLS BACK on an unexpanded -C" \
  'git -C "$W" commit -m x' /base "$C"
want_dir "/base" "gate_target_dir still FALLS BACK on an unexpanded cd" \
  'cd "$W" && git commit -m x' /base "$C"

# --- gate_pr_selector: the selector must come from the MATCHED verb ---------
#
# Three gates hand-rolled `${cmd##*gh pr merge}` -- a LITERAL strip. Once
# GATE_GH_C absorbed `-R <owner/repo>`, they began to FIRE on the flagged
# spelling while still failing to strip it, so whatever ran next read the wrong
# token. Measured 2026-08-25 against the shipped hooks: `sleep 30 && gh -R
# go-to-k/cdkd pr merge 2195 --squash` resolved PR #30 in pr-review-gate, and
# closes-paren-form-gate got an empty selector and exited 0. Widening the flag
# absorber was necessary and NOT sufficient -- it moved the bypass one step
# later. These cases fence the second step.
want_sel() {
  local expect="$1" name="$2" cmd="$3" got
  got=$(gate_pr_selector "$cmd" "$GATE_RE_GH_PR_MERGE")
  if [ "$got" = "$expect" ]; then
    pass=$((pass + 1)); printf 'ok   %s\n' "$name"
  else
    fail=$((fail + 1)); printf 'FAIL %s (got %s, want %s)\n' "$name" "${got:-<empty>}" "${expect:-<empty>}"
    fail_log="${fail_log}FAIL ${name}\n"
  fi
}

want_sel 2195 "selector: plain"                 'gh pr merge 2195 --squash'
want_sel 2195 "selector: -R space"              'gh -R go-to-k/cdkd pr merge 2195 --squash'
want_sel 2195 "selector: --repo space"          'gh --repo go-to-k/cdkd pr merge 2195 --squash'
want_sel 2195 "selector: --repo="               'gh --repo=go-to-k/cdkd pr merge 2195 --squash'
want_sel 2195 "selector: -R="                   'gh -R=go-to-k/cdkd pr merge 2195 --squash'
want_sel 2195 "selector: -R glued"              'gh -Rgo-to-k/cdkd pr merge 2195 --squash'
want_sel 2195 "selector: -C then -R"            'gh -C /tmp -R go-to-k/cdkd pr merge 2195 --squash'
# THE case. A leading integer anywhere in the command must not be read as the
# PR number -- this is the exact input that resolved PR #30 before the fix.
want_sel 2195 "selector: leading sleep 30 does not win" \
  'sleep 30 && gh -R go-to-k/cdkd pr merge 2195 --squash'
want_sel 2195 "selector: flag with a numeric value first" \
  'gh pr merge --delete-branch 2195'
want_sel ""   "selector: no number given"       'gh pr merge --squash'
want_sel ""   "selector: quoted mention only"   'echo "gh pr merge 5"'
# A sibling lane's fix REGRESSED on this shape: its new anchor accepted a
# selector only IMMEDIATELY after the verb, so `gh pr merge --squash 1` lost the
# number and its ci-green-gate returned 0 -- a red-CI bypass introduced by the
# fix itself, on a spelling gh accepts and the OLD extractor handled.
want_sel 1    "selector: flags BEFORE the number"       'gh pr merge --squash 1'
want_sel 1    "selector: -R and flags before the number" 'gh -R go-to-k/cdkd pr merge --squash 1'
want_sel 2195 "selector: several flags first"           'gh pr merge --delete-branch --squash 2195'
# And the other half of that lane's finding: the selector must come from the
# MATCHED SEGMENT, never the whole command. A PR body quoting another merge
# command must not donate its number.
want_sel ""   "selector: number quoted inside another segment" \
  'gh pr create --body "later: gh pr merge 42 --squash"'
want_sel ""   "selector: quoted mention then a bare verb" \
  'gh pr create --body "then run gh pr merge 9 --squash" && gh pr merge'

# A repo flag AFTER the verb: the verb ERE only absorbs LEADING flags, so `-R`
# reaches the selector walk. Enumerating VALUE-TAKERS (the polarity a sibling
# lane tried) leaves the slug in place and the gate then judges repo-slug-as-PR;
# `-t 42 552` is the same shape with a plausible-looking integer. Enumerating
# VALUELESS flags instead fails SAFE: an unlisted one eats the number and the
# selector comes back empty.
want_sel 552  "selector: -R after the verb"        'gh pr merge -R go-to-k/cdkd 552 --squash'
want_sel 552  "selector: --repo after the verb"    'gh pr merge --repo go-to-k/cdkd 552'
want_sel 552  "selector: -t consumes its value"    'gh pr merge -t 42 552'
want_sel 552  "selector: --disable-auto is valueless" 'gh pr merge --disable-auto 552'
# SHORT spellings. `gh help pr merge` documents -s/-m/-r/-d, and listing only
# the long forms sent every short one down the value-consuming arm, eating the
# PR number. Found by a sibling repo's round-3 review, where the empty selector
# then reached a `no pull requests found` fail-open and MERGED PAST RED CI.
want_sel 2195 "selector: -s is valueless"            'gh pr merge -s 2195'
want_sel 2195 "selector: -d is valueless"            'gh pr merge -d 2195'
want_sel 2195 "selector: -m is valueless"            'gh pr merge -m 2195'
want_sel 2195 "selector: -r is valueless"            'gh pr merge -r 2195'
want_sel 2195 "selector: long and short mixed"       'gh pr merge --squash -d 2195'

# "empty" has TWO causes and the caller must tell them apart. A corrected
# comment does not close the hole for the next unlisted flag: a sibling repo's
# ci-green-gate treated every empty selector as "fall back to the current
# branch" and so merged past red CI when a flag had eaten the number.
want_ate() {
  local expect="$1" name="$2" cmd="$3"
  local got=no
  gate_pr_selector_ate_number "$cmd" "$GATE_RE_GH_PR_MERGE" && got=YES
  if [ "$got" = "$expect" ]; then
    pass=$((pass + 1)); printf 'ok   %s\n' "$name"
  else
    fail=$((fail + 1)); printf 'FAIL %s (got %s, want %s)\n' "$name" "$got" "$expect"
    fail_log="${fail_log}FAIL ${name}\n"
  fi
}
want_ate no  "ate: no number given at all"        'gh pr merge --squash'
want_ate no  "ate: a branch name is not a number" 'gh pr merge feature-branch'
want_ate no  "ate: number present and returned"   'gh pr merge 552 --squash'
want_ate no  "ate: a non-numeric flag value"      'gh pr merge -t msg 2195'
want_ate YES "ate: an UNLISTED flag swallowed it" 'gh pr merge --future-flag 552'
want_ate YES "ate: a numeric flag value"          'gh pr merge --body-file 7 2195'
want_sel ""   "selector: unknown flag fails SAFE, not wrong" 'gh pr merge --future-flag 552'
want_sel ""   "selector: a branch name is not a PR number"   'gh pr merge feature-branch'

# The FOURTH iteration of "the fix moved the bypass one step later", found by a
# sibling repo's round-2 review. Skipping `-…` tokens but NOT their values makes
# a flag value the selector: `gh pr merge -t msg 2195` yielded `msg`, which
# `gh pr checks msg` answers with "no pull requests found" -- straight into
# ci-green-gate's fail-open arm. Strictly worse than the empty selector it
# replaced, because empty fell back to the current branch and blocked.
want_sel 2195 "selector: -t value is consumed, not returned"  'gh pr merge -t msg 2195 --squash'
want_sel 2195 "selector: --match-head-commit value consumed"  'gh pr merge --match-head-commit abc 2195'
want_sel 2195 "selector: --body-file numeric value consumed"  'gh pr merge --body-file 7 2195 --squash'
want_sel 2195 "selector: a QUOTED flag value is one token"    'gh pr merge --subject "chore: x" 2195 --squash'

# `--flag=value` carries its value inside the token. The hand-walk this helper
# replaced had this arm; dropping it was a regression the replacement made.
want_sel 552  "selector: --repo=<slug> before the number"  'gh pr merge --repo=go-to-k/cdkd 552'
want_sel 2195 "selector: --body-file=<path> before it"     'gh pr merge --body-file=/tmp/b 2195'

# An UNBALANCED apostrophe in a path made GATE_EMBEDDING_TOKEN fail outright,
# so gate_leading_c_value returned NOTHING and the caller silently judged the
# session cwd -- and gate_target_dir_strict cannot refuse it, because it cannot
# tell "no -C" from "unparsable -C". Same silent-fallback class as the reverted
# go-to-k/cdkd#2200. Built with a variable because a literal apostrophe inside
# these already-quoted case strings is what broke this file once.
APO=$(printf "\047")
want_dir "/tmp/o${APO}neill/repo" "an apostrophe in the -C path still resolves" \
  "git -C /tmp/o${APO}neill/repo commit -m x" FALLBACK "$C"
want_dir "/w/t" "an apostrophe in an earlier flag VALUE does not lose it" \
  "git -c user.name=O${APO}Brien -C /w/t commit -m x" FALLBACK "$C"

# A `-C` embedded in a quoted FLAG VALUE must not become the target. Measured on
# origin/main: `git -c core.pager="less -C /evil" commit` resolved `/evil`, and
# through branch-gate on `main` that turned rc=2 into rc=0 -- a bypass driven by
# a flag value. Pre-existing, found by a sibling repo's review of the same code.
want_dir "/fallback" "-C inside a quoted flag value is not a target" \
  'git -c core.pager="less -C /evil" commit -m y' /fallback "$C"
want_dir "/w/t" "a real -C after -c k=v still resolves" \
  'git -c k=v -C /w/t commit -m x' /fallback "$C"

# =============================================================================
# go-to-k/cdkd#2156 -- every KNOWN bypass spelling, pinned, and every known
# FALSE-REFUSAL shape as a negative control
# =============================================================================
#
# The issue's own table lists the spellings four review rounds each found one at
# a time. They are pinned here as cases so a future narrowing of GATE_FLAGS
# fails LOUDLY rather than reopening one of them silently. Each name says which
# round found it; `strict-resolver` on a name means the segment MATCHES here and
# the refusal is `gate_target_dir_strict`'s job, which is the split this issue
# asked for -- over-approximate the trigger, stay strict on resolution.

# round 1 -- an unexpanded variable in -C. MATCHES; the resolver refuses it.
want_match 0 "bypass r1: git -C \$W (strict-resolver refuses)"        'git -C "$W" commit -m x' "$C"
want_match 0 "bypass r1: git -C \$W unquoted"                         'git -C $W commit -m x' "$C"
# round 2 -- a quoted path containing a space; determinate, must BLOCK outright.
want_match 0 "bypass r2: quoted -C path with a space"                 'git -C "/a b/wt" commit -m x' "$C"
want_match 0 "bypass r2: \$( ) in -C (strict-resolver refuses)"       'git -C "$(git rev-parse --show-toplevel)" commit -m x' "$C"
want_match 0 "bypass r2: backtick in -C (strict-resolver refuses)"    'git -C `pwd` commit -m x' "$C"
# round 3 -- a gh GLOBAL flag ahead of the verb.
want_match 0 "bypass r3: gh -R owner/repo pr merge"                   'gh -R go-to-k/cdkd pr merge 42 --squash' "$M"
want_match 0 "bypass r3: gh --repo=owner/repo pr merge"               'gh --repo=go-to-k/cdkd pr merge 42 --squash' "$M"
# round 3 -- a MULTI-LINE $( ). Fixed here (subst_open joins the lines); on
# origin/main this segmented to `git -C` + `) commit -m x` and matched nothing.
want_match 0 "bypass r3: multi-line \$( ) in -C"                      'git -C $(
  git rev-parse --show-toplevel
) commit -m x' "$C"
want_match 0 "bypass r3: multi-line \$( ) in a gh flag"               'gh -R $(
  echo go-to-k/cdkd
) pr merge 42 --squash' "$M"
# #2156 -- the shapes the FLAG GRAMMAR could not parse, which is the class the
# inverted trigger exists to end. None of these matched on origin/main.
want_match 0 "wide trigger: a flag taking TWO values"                 'git --exec-path /x /y commit -m x' "$C"
want_match 0 "wide trigger: a bare token between flags"               'git -c a=b junkjunk commit -m x' "$C"
want_match 0 "wide trigger: gh flag with two values"                  'gh -R o/r --jsonflag x y pr merge 42' "$M"

# --- FALSE-REFUSAL negative controls -----------------------------------------
# All four shipped as real false refusals during the go-to-k/cdkd#2027 lane. The
# `gate_leading_c_value` anchoring that fixed the first three is preserved by
# this work; these pin that, and pin that the wider trigger did not undo it.
want_match 1 "no-refuse: a commit message QUOTING git -C \$W"         'git commit -m "repro: git -C $W commit failed" && true' "$M"
want_dir "/fallback" "no-refuse: the quoted -C in the message is not the target" \
  'git commit -m "repro: git -C $W commit failed"' /fallback "$C"
want_match 1 "no-refuse: a --body carrying a newline and a command"   'gh issue comment 1 --body "we ran:
git -C $W commit -F f"' "$C"
want_match 1 "no-refuse: MSG=\$(echo git commit -m x)"                'MSG=$(echo git commit -m x)' "$C"
# `cd <newdir> && git init && git commit` -- the newdir does not exist yet, so a
# gate that treats an unstat-able target as unreadable refuses a legitimate
# bootstrap. The MATCH is correct here (it really is a commit); what must hold
# is that the target resolves to the named directory rather than to nothing.
want_dir "/tmp/newdir" "no-refuse: cd <newdir> && git init && git commit" \
  'cd /tmp/newdir && git init && git commit -m x' /fallback "$C"

# Ordinary read commands must stay OUT of every gate: a bare token in first
# position IS the subcommand, so these settle without any list of names.
want_match 1 "no-refuse: git show --stat commit"      'git show --stat commit' "$C"
want_match 1 "no-refuse: git config alias.ci commit"  'git config alias.ci commit' "$C"
want_match 1 "no-refuse: git diff -- commit.md"       'git diff main -- commit.md' "$C"
want_match 1 "no-refuse: git worktree add ... origin/main" \
  'git worktree add .claude/worktrees/x -b x origin/main' "$GATE_RE_GIT_MERGE"
want_match 1 "no-refuse: git branch --merged"         'git branch --merged origin/main' "$GATE_RE_GIT_MERGE"
want_match 1 "no-refuse: gh pr list --search merge"   'gh pr list --search merge' "$M"
# The single-quoted body that the first draft of the wide prefix DID refuse:
# blind tokens tiled `pr` and `merge` out of the quoted value. Both quotings.
want_match 0 "accepted FR: pr create whose body says pr merge (single quotes)" \
  "gh -R o/r pr create -b 'x pr merge y'" "$M"
want_match 1 "no-refuse: pr create whose body says pr merge (double quotes)" \
  'gh -R o/r pr create -b "x pr merge y"' "$M"

# --- GATE_RE_GH_PROSE_CARRIER (the verb gh-body-english-gate matches) --------
#
# That hook used to hand-roll its own absorber -- three flag names and one
# UNQUOTED value shape -- so any other gh global flag ahead of the verb left the
# gate unarmed and non-English prose reached GitHub. It now takes the shared
# constant, and these cases live HERE rather than in that hook's own suite ON
# PURPOSE: an end-to-end case needs a non-English BODY, and non-english-text-gate
# scans the whole content of every file a PR touches with no allow-list, so
# adding one there makes the PR carrying the fix unopenable. The hole was in the
# TRIGGER, and the trigger IS this constant, so ASCII fences it precisely.
#
# Driven through `check` (i.e. `cmd_matches_verb`, which anchors at a segment
# START) rather than `want_match`, because that is how the hook consumes it. The
# constant is deliberately UNANCHORED -- the hook also feeds it to
# `cmd_last_cd_target` -- so a raw `gate_matches` finds it inside a quoted
# mention and the polarity control below could never fail.
PROSE="$GATE_RE_GH_PROSE_CARRIER"
check "prose carrier: plain issue create"          0 "$PROSE" 'gh issue create --title x --body y'
check "prose carrier: -R before the verb"          0 "$PROSE" 'gh -R go-to-k/cdkd issue comment 5 --body y'
check "prose carrier: an UNLISTED global flag"     0 "$PROSE" 'gh --template "{{.body}}" issue create --title x --body y'
check "prose carrier: unlisted flag, spaced value" 0 "$PROSE" 'gh -R "go-to-k/cdkd" --template "a b" pr comment 5 --body y'
check "prose carrier: release create"              0 "$PROSE" 'gh release create v1 --notes y'
check "prose carrier: gh api"                      0 "$PROSE" 'gh api repos/o/r/issues -f body=y'
check "prose carrier: after a chain operator"      0 "$PROSE" 'git push && gh --template "a b" issue create --body y'
# Polarity: it must NOT fire on a gh verb that publishes nothing, nor on prose
# quoting one -- otherwise the cases above pass by matching everything.
check "prose carrier: gh pr list is not a publish"    1 "$PROSE" 'gh pr list --search merge'
check "prose carrier: gh issue view is not a publish" 1 "$PROSE" 'gh issue view 5 --json body'
check "prose carrier: a quoted MENTION does not fire" 1 "$PROSE" 'echo "then run gh issue create --body x"'
check "prose carrier: a commit message quoting it"    1 "$PROSE" 'git commit -m "next: gh issue create --body x"'

# =============================================================================
# go-to-k/cdkd#2156 review round 1 -- the three BLOCKERS
# =============================================================================

# --- BLOCKER 1: the strip helpers must cut at the LEFTMOST verb --------------
#
# POSIX `=~` is leftmost-LONGEST, so the widened prefix gained a legal parse
# that swallows the real verb and anchors on a LATER one in the same segment.
# The booleans stayed right; the three LENGTH-strip helpers read the wrong
# arguments, and NO strict resolver catches that -- resolution succeeds, on the
# wrong tail. A case per helper, asserting the EXTRACTED VALUE rather than the
# boolean, because the boolean is exactly what stayed green through the defect.
want_rest() { # <expected> <label> <command> <regex>
  local want="$1" label="$2" cmd="$3" re="$4" got
  got=$(gate_verb_rest "$cmd" "$re")
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n' "$label"
    fail_log+="FAIL $label\n  want rest: [$want]\n  got  rest: [$got]\n"
  fi
}
want_rest_each() { # <expected-newline-joined> <label> <command> <regex>
  local want="$1" label="$2" cmd="$3" re="$4" got
  got=$(gate_verb_rest_each "$cmd" "$re")
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n' "$label"
    fail_log+="FAIL $label\n  want: [$want]\n  got:  [$got]\n"
  fi
}
# gate_verb_rest -- the go-to-k/cdkd#1700 data-loss shape. Before the fix the
# tail came back as `main`, the `--` vanished, dirty-path-restore-gate read a
# branch switch and PASSED (measured rc=2 -> rc=0 through the shipped hook).
want_rest '-- f.txt # undo probe, then git checkout main' \
  "leftmost verb: a trailing MENTION does not move the anchor" \
  'git -C /wt checkout -- f.txt # undo probe, then git checkout main' "$GATE_RE_GIT_CHECKOUT"
want_rest '-- f.txt # see git checkout main' \
  "leftmost verb: same, with a flag before -C" \
  'git -c a=b -C /wt checkout -- f.txt # see git checkout main' "$GATE_RE_GIT_CHECKOUT"
want_rest '-- f.txt' \
  "leftmost verb: the plain shape is unchanged" \
  'git -C /wt checkout -- f.txt' "$GATE_RE_GIT_CHECKOUT"
# A path COMPONENT named like the verb must not become the cut point -- this is
# why the fix asks the regex for its shortest match instead of cutting at the
# first `pr` / `checkout` token.
want_rest '-- f.txt' \
  "leftmost verb: a path component named checkout is not the verb" \
  'git -C /repo/checkout checkout -- f.txt' "$GATE_RE_GIT_CHECKOUT"
want_rest_each 'main
-- f.txt' "leftmost verb: rest_each still reports BOTH segments" \
  'git checkout main && git checkout -- f.txt' "$GATE_RE_GIT_CHECKOUT"
# gate_pr_selector -- before the fix this returned 9, so ci-green-gate /
# pr-review-gate / closes-paren-form-gate judged PR 9 while merging 2195.
want_sel 2195 "leftmost verb: a trailing mention does not steal the selector" \
  'gh -R o/r pr merge 2195 --squash --delete-branch # then gh pr merge 9'
want_sel 42 "leftmost verb: a path component named pr is not the verb" \
  'gh -C /repo/pr pr merge 42 --squash'
want_sel 42 "leftmost verb: a gh flag taking two values" \
  'gh -R o/r --jsonflag x y pr merge 42'

# --- BLOCKER 2: multi-line BACKTICK substitution ------------------------------
#
# `subst_open` counted only `$(`, so the backtick spelling of the same shape
# stayed a full bypass while the docs called the class closed. Measured with the
# repo on `main`: branch-gate rc=0 for the backtick, rc=2 for the `$( )` twin.
want_match 0 "bypass: multi-line backtick in -C" 'git -C `
  echo /a/b
` commit -m x' "$C"
want_match 0 "bypass: multi-line backtick in a gh flag" 'gh -R `
  echo o/r
` pr merge 42' "$M"
# PARITY, not depth: backticks do not nest, so an ordinary balanced pair must
# NOT hold the line open. If it did, every `git -C \`pwd\` commit` would join
# with the next line and the segment would be wrong.
want_match 0 "backtick parity: a balanced pair on one line still matches" \
  'git -C `pwd` commit -m x' "$C"
want_match 0 "backtick parity: a balanced pair inside a quoted span" \
  'echo "a `b` c" && git commit -m x' "$C"

# --- BLOCKER 3: the apostrophe idiom must NOT be a false refusal --------------
#
# The quote-close-escape-reopen idiom is THE shell way to put an apostrophe
# inside a single-quoted string, so every English body with a contraction takes
# that shape. All four were rc=0 on origin/main and began matching once the
# prefix widened.
want_match 0 "accepted FR: the quote-escape-reopen apostrophe idiom in a body" \
  "gh -R go-to-k/cdk-local issue comment 42 --body 'we can'\''t pr merge 99 until CI is green'" "$M"
# FLIPPED by the round-3 security review, deliberately. Round 2 asserted these
# three must NOT match; forbidding the token shape that makes them match also
# forbade `--work-tree=/x/o'brien`, which took the go-to-k/cdkd#1700 data-loss
# gate and both merge gates from rc=2 to rc=0. A false refusal on a `gh issue
# comment` is LOUD -- visible, diagnosable, one rephrase away; a
# dirty-path-restore-gate returning 0 destroys uncommitted work in silence. So
# these are now the ACCEPTED cost, pinned as cases so the trade cannot be
# quietly reversed. The everyday contraction idiom is still NOT refused, which
# is asserted separately below.
want_match 0 "accepted FR: --body='<single-quoted>' with a verb inside" \
  "gh -R o/r issue comment 1 --body='next: pr merge 5'" "$M"
want_match 0 "accepted FR: -b'<single-quoted>' with a verb inside" \
  "gh -R o/r issue comment 1 -b'next: pr merge 5'" "$M"
want_match 0 "accepted FR: --body=\$'<ansi-c>' with a verb inside" \
  "gh -R o/r issue comment 1 --body=\$'next: pr merge 5'" "$M"
# The counterweight: the apostrophe-PATH cases go-to-k/cdkd#2199 added, which is
# why apostrophes cannot simply be banned from a blind token. The third is the
# one that ruled out the reviewer-suggested "first interior word only" fix.
want_match 0 "keep: an unbalanced apostrophe in the -C path" \
  "git -C /tmp/o'neill/repo commit -m x" "$C"
want_match 0 "keep: an unbalanced apostrophe in an earlier flag VALUE" \
  "git -c user.name=O'Brien -C /w/t commit -m x" "$C"
want_match 0 "keep: an apostrophe path in a LATER word, not the first" \
  "git -c a=b -C /tmp/o'neill/repo commit -m x" "$C"
# Single-quoted flag VALUES containing a space must still tile as one word.
want_match 0 "keep: a spaced single-quoted flag value" \
  "git -c core.pager='less -S' commit -m x" "$C"
want_match 0 "keep: a spaced single-quoted gh flag value" \
  "gh --template 'a b' pr merge 42" "$M"

# --- GATE_RE_GH_PROSE_CARRIER: the `cmd_last_cd_target` half ------------------
#
# The hook feeds this SAME constant to `cmd_last_cd_target`, whose job is to
# stop following `cd`s AT THE VERB -- a trailing `cd` must not hijack the
# directory a relative `--body-file` resolves against. That half had no case:
# the constant's terminator is spelled `([[:space:]]|$|[|;&`)])` rather than
# `\b` precisely because this consumer is AWK (where `\b` is a BACKSPACE), and
# nothing fenced the spelling. Planting `\b` there makes the case below resolve
# `/b` instead of `/a`, which is the whole point of having it.
want_cd() { # <expected> <label> <command> <base> <verb-ere>
  local want="$1" label="$2" cmd="$3" base="$4" re="$5" got
  got=$(cmd_last_cd_target "$cmd" "$base" "$re")
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n' "$label"
    fail_log+="FAIL $label\n  want: [$want]\n  got:  [$got]\n"
  fi
}
want_cd "/a" "prose carrier: a cd AFTER the verb does not move the body-file base" \
  'cd /a && gh issue create --title x --body y && cd /b' /fallback "$PROSE"
want_cd "/a" "prose carrier: same with a global flag before the verb" \
  'cd /a && gh --template "a b" issue create --body y && cd /b' /fallback "$PROSE"
want_cd "" "prose carrier: no cd before the verb resolves to nothing" \
  'gh issue create --title x --body y && cd /b' /fallback "$PROSE"

# --- the FAIL-CLOSED arm that guards this constant ---------------------------
#
# `gh-body-english-gate.sh` refuses to run when the library it loaded does not
# define GATE_RE_GH_PROSE_CARRIER, because an unset constant leaves its VERB_ERE
# empty and an empty ERE matches EVERY segment -- the gate would fire on
# everything, and the natural "fix" is to delete it. Two reviewers verified the
# arm works by deleting the constant; NOTHING fenced that it keeps working (the
# hook suite was still 80/80 with the arm removed).
#
# The case lives HERE rather than in that hook's own suite for the reason
# already documented above: that file carries non-English fixtures, and
# `non-english-text-gate` scans the full content of every file a PR touches with
# no allow-list, so adding a case there makes the PR carrying the fix unopenable.
# This one needs no non-English text at all -- it asserts an exit code.
#
# RE-POINTED by go-to-k/cdkd#2717, which retired `gh-body-english-gate.sh` to
# CI. The subject was that hook and the constant it consumed
# (`GATE_RE_GH_PROSE_CARRIER`); it is now `pr-body-item-number-gate.sh` and
# `GATE_RE_GH_BODY_CARRIER`, chosen because that gate survives, sources this
# library, and fails CLOSED on the same shape. The PROPERTY under test is
# unchanged: a library that is otherwise complete but predates a constant the
# gate interpolates must make the gate REFUSE, not wave the command through.
#
# The old form guarded on `[ -f .../gh-body-english-gate.sh ]`, so deleting that
# hook made these two cases SILENTLY SKIP -- the count fell 596 -> 594 and the
# only symptom was the mid-file CASE_FLOOR, whose own message is off by one and
# read "only 546 cases ran, expected at least 546". A guard that turns a missing
# subject into a skip is the vacuous-pass shape `.claude/rules/testing.md`
# warns about; the file is now REQUIRED, so a future retirement reds here with
# the reason instead of quietly shrinking the suite.
_gate_hook_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -f "$_gate_hook_dir/pr-body-item-number-gate.sh" ]; then
  fail=$((fail + 1))
  printf 'FAIL %s\n' "fail-closed fixture: pr-body-item-number-gate.sh is gone -- re-point this case at another surviving gate that sources the library, do not delete it"
  fail_log+="FAIL fail-closed fixture: pr-body-item-number-gate.sh is missing; the fail-closed arm is now unfenced\n"
else
  _fc_tmp="$(mktemp -d)"
  mkdir -p "$_fc_tmp/lib"
  cp "$_gate_hook_dir/pr-body-item-number-gate.sh" "$_fc_tmp/"
  grep -v '^GATE_RE_GH_BODY_CARRIER=' "$_gate_hook_dir/lib/command-match.sh" \
    > "$_fc_tmp/lib/command-match.sh"
  _fc_payload='{"cwd":"/tmp","tool_name":"Bash","session_id":"fc","tool_input":{"command":"gh issue create --title x --body y"}}'
  printf '%s' "$_fc_payload" | bash "$_fc_tmp/pr-body-item-number-gate.sh" >/dev/null 2>&1
  _fc_rc=$?
  if [ "$_fc_rc" -eq 2 ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "fail-closed: a library without GATE_RE_GH_BODY_CARRIER refuses"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n' "fail-closed: a library without GATE_RE_GH_BODY_CARRIER refuses"
    fail_log+="FAIL fail-closed arm: expected rc=2, got rc=$_fc_rc\n"
  fi
  # Polarity: the SAME fixture with the constant present must pass the command
  # through (rc=0), or the case above would pass on any breakage at all.
  cp "$_gate_hook_dir/lib/command-match.sh" "$_fc_tmp/lib/command-match.sh"
  printf '%s' "$_fc_payload" | bash "$_fc_tmp/pr-body-item-number-gate.sh" >/dev/null 2>&1
  _fc_rc=$?
  if [ "$_fc_rc" -eq 0 ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "fail-closed: the same fixture WITH the constant passes an english body"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n' "fail-closed: the same fixture WITH the constant passes an english body"
    fail_log+="FAIL fail-closed polarity: expected rc=0, got rc=$_fc_rc\n"
  fi
  rm -rf "$_fc_tmp"
fi

# =============================================================================
# go-to-k/cdkd#2156 review round 2 -- LATER-position quoted flag values
# =============================================================================
#
# Round 1 split the prefix into a FIRST interior word and LATER ones and dropped
# the single-quoted-span alternative for the later ones. That fixed the
# apostrophe idiom and LOST seven balanced, runnable commands -- a lost match is
# a BYPASS, so it was strictly worse than the false refusal it fixed.
#
# The battery that cleared round 1 pinned `-c core.pager='less -S'` and
# `gh --template 'a b'` in FIRST position only, with no later-position twin, so
# the whole class was invisible to it. These are the twins. Where a case above
# has a first-position form, the one here is the same shape moved later.
want_match 0 "later sq value: -c core.pager after -C (commit)" \
  "git -C /repo -c core.pager='less -S' commit -m x" "$C"
want_match 0 "later sq value: -c core.pager after -C (checkout)" \
  "git -C /repo -c core.pager='less -S' checkout -- f.txt" "$GATE_RE_GIT_CHECKOUT"
want_match 0 "later sq value: gh --template after -R (create)" \
  "gh -R o/r --template 'a b' pr create --title x" "$GATE_RE_GH_PR_CREATE"
want_match 0 "later sq value: gh --template after -R (merge)" \
  "gh -R o/r --template 'a b' pr merge 42" "$M"
want_match 0 "later sq value: -c a='b c' (push)" \
  "git -C /repo -c a='b c' push origin HEAD" "$P"
want_match 0 "later sq value: --work-tree='/a b' (merge)" \
  "git -C /repo -c x=y --work-tree='/a b' merge origin/main" "$GATE_RE_GIT_MERGE"
# The span must be a SUFFIX of its token. That is what separates the cases above
# from the apostrophe idiom, whose span sits MID-token -- so this pair has to
# keep BOTH verdicts, and a fix that restores the span alternative wholesale
# (measured: 2 wrong) flips the second one.
# ROUND 5 FLIPPED THESE THREE, and it is the third time this PR has made the
# same trade in the same direction. Restoring the quote-BLIND fallback for later
# words is what stops a token carrying MORE THAN ONE apostrophe from matching
# nothing -- measured, `git -C <wt> --exec-path='/opt/git'/libexec commit` took
# branch-gate rc=2 -> rc=0, and its `checkout` twin took the go-to-k/cdkd#1700
# data-loss gate with it. These three now reach the merge gates as LOUD
# refusals (verified rc=2 with a message through verify-pr-gate).
#
# The rule that decided rounds 3, 4 and 5 identically, stated once: when a
# grammar choice trades a SILENT loss against a LOUD refusal, take the refusal,
# and stop trying to separate the two populations by POSITION. Every attempt was
# locally correct and moved the failure one grammar case sideways.
want_match 0 "accepted FR: a MID-token span now reaches the merge gates too" \
  "gh -R go-to-k/cdk-local issue comment 42 --body 'we can'\''t pr merge 99 until CI is green'" "$M"

# The round-3 security review's blocker, in every verb it reaches. A LATER,
# DASH-LED token carrying a LOOSE apostrophe was briefly forbidden and priced as
# "two cells on `commit`" -- the real price was dirty-path-restore-gate (the
# go-to-k/cdkd#1700 data-loss gate) and BOTH merge gates going rc=2 -> rc=0.
# THE VERB IS THE POINT of these five: the corpus that mispriced it carried the
# shape only with `commit`, so the `checkout` / `restore` / `pr merge`
# instances were invisible. Whenever a token shape is pinned, pin it with every
# verb it can carry.
want_match 0 "loose apo, dash-led: commit" \
  "git -C /repo --work-tree=/Users/o'brien/wt commit -m x" "$C"
want_match 0 "loose apo, dash-led: checkout (the data-loss gate)" \
  "git -C /wt --work-tree=/x/o'brien checkout -- f.txt" "$GATE_RE_GIT_CHECKOUT"
want_match 0 "loose apo, dash-led: restore" \
  "git -C /wt --work-tree=/x/o'brien restore f.txt" "$GATE_RE_GIT_RESTORE"
want_match 0 "loose apo, dash-led: pr merge" \
  "gh -R o/r --template=/a/o'neill pr merge 2195 --squash" "$M"
want_match 0 "not lost: BARE-led later token with a loose apostrophe" \
  "git -c a=b -C /tmp/o'neill/repo commit -m x" "$C"
# The apostrophe-free twins, so the four above cannot pass by the gate simply
# matching everything -- on the forbidding shape these stayed rc=2 while their
# apostrophe versions went rc=0, which is what made the apostrophe the culprit.
want_match 0 "control: same shape with no apostrophe (checkout)" \
  "git -C /wt --work-tree=/x/obrien checkout -- f.txt" "$GATE_RE_GIT_CHECKOUT"
want_match 0 "control: same shape with no apostrophe (pr merge)" \
  "gh -R o/r --template=/a/oneill pr merge 2195 --squash" "$M"
# ACCEPTED FALSE REFUSALS, and they are cases so the trade cannot be forgotten:
# admitting the shape above lets a single-quoted `--body` carrying a gated verb
# reach the merge gates. Loud and recoverable, versus a silent bypass of the
# data-loss gate -- measured at 3 wrong here against 4 either way round.
want_match 0 "accepted FR: --body='<verb inside>' reaches the merge gates" \
  "gh -R o/r issue comment 1 --body='next: pr merge 5'" "$M"
# But the everyday contraction is NOT refused -- that is the whole reason the
# span-suffix rule exists rather than dropping the split entirely.
want_match 0 "accepted FR: the quote-escape-reopen contraction idiom" \
  "gh -R go-to-k/cdk-local issue comment 42 --body 'we can'\''t pr merge 99 until CI is green'" "$M"

# The walk is BOUNDED. Past the cap gate_verb_span falls back to the greedy end
# rather than walking, because an unbounded walk outlives the `timeout: 10` that
# four gates carry and a timed-out PreToolUse hook does not block at all. This
# asserts the bound HOLDS, not the fallback's value: the point is that it
# returns promptly and the ordinary shapes above are unaffected.
_cap_cmd="gh -R o/r"
_cap_i=0
while [ "$_cap_i" -lt 200 ]; do _cap_cmd="$_cap_cmd -c k$_cap_i=v$_cap_i"; _cap_i=$((_cap_i + 1)); done
_cap_cmd="$_cap_cmd pr merge 42 pr merge"
_cap_start=$(date +%s)
gate_pr_selector "$_cap_cmd" "$GATE_RE_GH_PR_MERGE" >/dev/null
gate_verb_rest "$_cap_cmd" "$GATE_RE_GH_PR_MERGE" >/dev/null
_cap_elapsed=$(( $(date +%s) - _cap_start ))
if [ "$_cap_elapsed" -le 5 ]; then
  pass=$((pass + 1)); printf 'OK   %s\n' "bounded walk: 200 flags + a repeated verb stays under the hook timeout (${_cap_elapsed}s)"
else
  fail=$((fail + 1)); printf 'FAIL %s\n' "bounded walk: 200 flags + a repeated verb took ${_cap_elapsed}s, near the timeout: 10 four gates carry"
  fail_log+="FAIL bounded walk: ${_cap_elapsed}s\n"
fi

# --- round 5: a LATER token with MORE THAN ONE apostrophe --------------------
#
# The blind fallback's subject. Every other alternative rules these out (NOSQ
# has no apostrophe, SPANSUF takes one span that must END the token,
# BLIND_BARE cannot start with `-`, LOOSE_FLAG takes exactly ONE), so without
# it they matched NOTHING. Pinned with several verbs, per the round-4 lesson.
want_match 0 "multi-apo later: span-then-tail (commit)" \
  "git -C /wt --exec-path='/opt/git'/libexec commit -m x" "$C"
want_match 0 "multi-apo later: span-then-tail (checkout, the data-loss gate)" \
  "git -C /wt --exec-path='/opt/git'/libexec checkout -- f.txt" "$GATE_RE_GIT_CHECKOUT"
want_match 0 "multi-apo later: two loose apostrophes (commit)" \
  "git -C /wt --work-tree=/x/o'brien/d'arcy commit -m x" "$C"
want_match 0 "multi-apo later: two loose apostrophes (pr merge)" \
  "gh -R o/r --work-tree=/x/o'brien/d'arcy pr merge 42 --squash" "$M"
want_match 0 "multi-apo later: space-separated flag value (commit)" \
  "git -C /repo --author 'O'\\''Brien' commit -m x" "$C"
want_match 0 "multi-apo later: five apostrophes in a gh flag (pr merge)" \
  "gh -R go-to-k/cdkd --jq='.a'\\''b' pr merge 2330 --squash" "$M"

# Round 5 flagged this one to FILE as pre-existing. It is not deferred -- the
# blind fallback FIXES it, so it is pinned here instead. Measured: NOMATCH on
# the vendored merge base, MATCH now, i.e. this lane is strictly ahead of the
# base on the shape rather than merely restoring it.
want_match 0 "beyond the base: -c <key> <spaced idiom value> (commit)" \
  "git -C /repo -c user.name 'O'\\''Brien' commit" "$C"
want_match 0 "beyond the base: -c <key> <spaced idiom value> (checkout)" \
  "git -C /repo -c user.name 'O'\\''Brien' checkout -- f.txt" "$GATE_RE_GIT_CHECKOUT"

# --- BACKTICK INSIDE A DOUBLE-QUOTED SPAN (go-to-k/cdkd#2339) ----------------
#
# `flush_line`'s in-quote branch handled `$(` but had no backtick arm, so the
# body was never scanned as a command in its own right and reached the shell
# with no gate armed. Through the gates that is dirty-path-restore-gate -- the
# go-to-k/cdkd#1700 data-loss gate -- returning 0 on a command that discards
# uncommitted work. The two spellings that already worked are what make the
# third one's failure legible, so all three belong here together.
CO="$GATE_RE_GIT_CHECKOUT"
want_match 0 "2339: backtick in a double-quoted span" \
  'echo "r: `git -C /wt checkout -- f.txt`"' "$CO"
want_match 0 "2339 control: dollar-paren in a double-quoted span" \
  'echo "r: $(git -C /wt checkout -- f.txt)"' "$CO"
want_match 0 "2339 control: bare backtick" \
  'echo `git -C /wt checkout -- f.txt`' "$CO"

# DOUBLE quotes only. A backtick inside SINGLE quotes does not run, so there is
# no bypass to close, and firing anyway refuses a markdown code span in a
# single-quoted body -- this repo's commonest issue/PR shape, measured being
# blocked by branch-gate before this was scoped.
want_match 1 "2339 bound: backtick in a SINGLE-quoted span does not run" \
  "echo 'r: \`git -C /wt checkout -- f.txt\`'" "$CO"
want_match 1 "2339 bound: markdown code span in a single-quoted body" \
  "gh issue comment 1 --body 'Run \`git push\` first'" "$P"

# The enclosing command survives, and the separator must sit INSIDE the span:
# with it outside, the case passes under every mutation because the segment
# already starts with the verb.
want_match 0 "2339: enclosing verb survives a substitution carrying a separator" \
  'git commit -m "built at `date; git push --force` see log"' "$C"
want_match 0 "2339: a verb INSIDE the span is reached" \
  'git commit -m "built at `date; git push --force` see log"' "$P"
# The UNTERMINATED arm, whose fail-open direction its own comment names.
want_match 0 "2339: unterminated in-quote backtick still segments the body" \
  'echo "r: `git -C /wt checkout -- f.txt' "$CO"

# --- gate_verb_rest_each_dir: the tree AND the tail, per segment, one walk ----
#
# The subject must EXIST, for the same reason `want_strict`'s guard above does:
# an absent function makes every case below vacuous.
if declare -F gate_verb_rest_each_dir >/dev/null; then
  pass=$((pass + 1)); printf 'OK   %s\n' "gate_verb_rest_each_dir is defined"
else
  fail=$((fail + 1)); printf 'FAIL %s\n' "gate_verb_rest_each_dir undefined"
  fail_log+="FAIL gate_verb_rest_each_dir is not defined; every case below is vacuous\n"
fi

GVTAB=$(printf '\t')

# want_each <expected, newline-joined> <label> <cmd> <fallback> <regex>
want_each() {
  local want="$1" label="$2" cmd="$3" fallback="$4" re="$5" got
  got=$(gate_verb_rest_each_dir "$cmd" "$fallback" "$re")
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n' "$label"
    fail_log+="FAIL $label\n  want: $want\n  got:  $got\n"
  fi
}

# THE ANTI-DRIFT FENCE. `gate_verb_rest_each_dir` carries a deliberate COPY of
# gate_target_dir_strict's cd / `-C` reading (that function BREAKS at the verb,
# which this walk must not). On a SINGLE-segment command the two must agree, so
# the copy cannot drift without a red case here.
for _gv in 'git commit -m x' 'cd /w/t && git commit -m x' 'cd /w && cd /w/b && git commit -m x' \
           'git -C /w/t commit -m x' 'cd /other && git -C /w/t commit -m x' \
           'cd rel && git commit -m x' 'cd "/w t" && git commit -m x'; do
  _gvs=$(gate_target_dir_strict "$_gv" /fallback "$C") || _gvs="REFUSE"
  _gve=$(gate_verb_rest_each_dir "$_gv" /fallback "$C")
  _gve="${_gve%%$GVTAB*}"
  [ -n "$_gve" ] || _gve="REFUSE"
  if [ "$_gvs" = "$_gve" ]; then
    pass=$((pass + 1)); printf 'OK   per-segment dir agrees with the strict resolver :: %s\n' "$_gv"
  else
    fail=$((fail + 1)); printf 'FAIL per-segment dir disagrees :: %s\n' "$_gv"
    fail_log+="FAIL per-segment dir disagrees :: $_gv\n  strict: $_gvs\n  each:   $_gve\n"
  fi
done
# ...and the REFUSAL channel agrees too: strict returns 2, this prints an EMPTY
# dir field. Kept in its own loop because the values are compared as strings and
# `REFUSE` is the harness's spelling for both.
for _gv in 'git -C "$W" commit -m x' 'cd "$W" && git commit -m x' 'git -C ~root/x commit -m x'; do
  _gvs=$(gate_target_dir_strict "$_gv" /fallback "$C") || _gvs="REFUSE"
  _gve=$(gate_verb_rest_each_dir "$_gv" /fallback "$C")
  _gve="${_gve%%$GVTAB*}"
  [ -n "$_gve" ] || _gve="REFUSE"
  if [ "$_gvs" = "REFUSE" ] && [ "$_gve" = "REFUSE" ]; then
    pass=$((pass + 1)); printf 'OK   both refuse an unreadable target :: %s\n' "$_gv"
  else
    fail=$((fail + 1)); printf 'FAIL refusal disagreement :: %s\n' "$_gv"
    fail_log+="FAIL refusal disagreement :: $_gv\n  strict: $_gvs\n  each:   $_gve\n"
  fi
done
unset _gv _gvs _gve

# ...and the part the strict resolver CANNOT express: two segments, two trees.
want_each "/w/one${GVTAB}-m a
/w/two${GVTAB}-m b" "two -C segments resolve independently" \
  'git -C /w/one commit -m a && git -C /w/two commit -m b' /fallback "$C"
# A `cd` PERSISTS into later segments; a `-C` binds only its own command.
want_each "/w/t${GVTAB}-m a
/w/t${GVTAB}-m b" "a cd carries into later segments" \
  'cd /w/t && git commit -m a && git commit -m b' /fallback "$C"
want_each "/w/t${GVTAB}-m a
/w/o${GVTAB}-m b
/w/t${GVTAB}-m c" "a -C does not leak into the next segment" \
  'cd /w/t && git commit -m a && git -C /w/o commit -m b && git commit -m c' /fallback "$C"
# An unreadable target in ONE segment leaves that segment's dir EMPTY and the
# others intact -- the per-segment shape of the strict resolver's refusal.
want_each "/fallback${GVTAB}-m a
${GVTAB}-m b" "an unreadable -C empties only its own segment" \
  'git commit -m a && git -C "$W" commit -m b' /fallback "$C"



# --- gate_tokens ---------------------------------------------------------------
#
# The argument-list splitter main-tree-branch-gate parses options with. It lives
# HERE rather than in the gate because matching `GATE_EMBEDDING_TOKEN` inside a
# hook and then reading a positional `${BASH_REMATCH[N]}` out of it is the
# go-to-k/cdkd#2200 coupling: widening the shared constant shifts the index and
# silently re-opens the gate. Pinned here so the gate can rely on it.
tok_case() { # name, text, expected newline-joined tokens
  local name="$1" text="$2" want="$3" got
  got=$(gate_tokens "$text")
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   gate_tokens: %s\n' "$name"
  else
    fail=$((fail + 1)); printf 'FAIL gate_tokens: %s\n' "$name"
    fail_log="${fail_log}FAIL gate_tokens: $name\n  text: [$text]\n  want: [$want]\n  got : [$got]\n"
  fi
}
tok_case "plain words" " -b feat" "$(printf -- '-b\nfeat')"
tok_case "leading and trailing space" "   feat   " "feat"
tok_case "empty text yields nothing" "" ""
tok_case "only whitespace yields nothing" "    " ""
tok_case "a double-quoted span stays ONE token" ' -c "wt feat new"' "$(printf -- '-c\n"wt feat new"')"
tok_case "a single-quoted span stays ONE token" " -c 'wt feat new'" "$(printf -- "-c\n'wt feat new'")"
tok_case "a glued flag value is not split" " --orphan=feat" "--orphan=feat"
tok_case "a bare -- survives as its own token" " some-feature -- README.md" "$(printf -- 'some-feature\n--\nREADME.md')"
tok_case "an unquoted glob is not expanded" " *" "*"
tok_case "runs of spaces collapse" " a     b" "$(printf -- 'a\nb')"


# --- gate_argv ------------------------------------------------------------------
#
# `gate_tokens` splits SHELL WORDS; this splits git's ARGV, which is what an
# option parse actually reads. The difference is not cosmetic: a redirection, its
# spaced target, a trailing `&` and a `#` comment are all WORDS and none of them
# is an ARGUMENT, and counting them as arguments is what made
# `git checkout <branch> 2>/dev/null` read as a two-positional file restore and
# PASS through main-tree-branch-gate (measured rc=0, want 2, on a command that
# really moves HEAD).
argv_case() { # name, text, expected newline-joined argv, expected rc
  local name="$1" text="$2" want="$3" wantrc="${4:-0}" got gotrc
  got=$(gate_argv "$text"); gotrc=$?
  if [ "$got" = "$want" ] && [ "$gotrc" = "$wantrc" ]; then
    pass=$((pass + 1)); printf 'OK   gate_argv: %s\n' "$name"
  else
    fail=$((fail + 1)); printf 'FAIL gate_argv: %s\n' "$name"
    fail_log="${fail_log}FAIL gate_argv: $name\n  text: [$text]\n  want: [$want] rc=$wantrc\n  got : [$got] rc=$gotrc\n"
  fi
}
argv_case "plain words are argv unchanged" " -b feat" "$(printf -- '-b\nfeat')"
argv_case "a glued redirection is dropped" " feat 2>/dev/null" "feat"
argv_case "two glued redirections are dropped" " feat >/dev/null 2>&1" "feat"
argv_case "an append redirection is dropped" " feat 2>>log" "feat"
argv_case "a SPACED redirection drops its target too" " feat > /dev/null" "feat"
argv_case "a numbered spaced redirection drops its target" " feat 2> log" "feat"
argv_case "an input redirection is dropped" " feat < in" "feat"
argv_case "a trailing & is dropped" " feat &" "feat"
argv_case "a comment ends the argv" " feat # switch lane" "feat"
argv_case "a comment ends it even mid-list" " a # b -- c" "a"
# The COMMENT rule keys on an UNQUOTED leading `#`. A quoted one is an argument
# the shell passes through, and the token still carries its quotes here.
argv_case "a QUOTED # is an argument, not a comment" " '#branch'" "'#branch'"
argv_case "a # inside a word is not a comment" " feat#1" "feat#1"
# CONTROLS: the things that look like the above and are NOT shell syntax.
argv_case "a bare -- survives" " feat -- README.md" "$(printf -- 'feat\n--\nREADME.md')"
argv_case "a digit-only word is not a redirection" " --unified 3 feat" "$(printf -- '--unified\n3\nfeat')"
argv_case "a quoted span survives whole" ' -c "wt feat new"' "$(printf -- '-c\n"wt feat new"')"
# An UNBALANCED quote cannot be split at all. Reporting it is the whole point:
# `gate_tokens` used to return the prefix it managed and rc=0, so `-b
# agent's-branch` yielded the single token `-b` and the gate read a bare
# `git checkout`.
argv_case "an unbalanced quote returns 1 and nothing" " -b agent's-branch" "" 1
argv_case "an unbalanced quote at the start returns 1" " a'unbalanced" "" 1
argv_case "empty text is not a truncation" "" "" 0
# CONTROL, not a fence: `gate_argv` feeds its loop from a HEREDOC, and a heredoc
# delimiter is matched in the SCRIPT text rather than in an expansion -- so a
# token that happens to spell the delimiter cannot end the body early. Nothing
# reddens this today; it is here so a rewrite that re-scans the value (an `eval`,
# a here-string built from it) has a case to fail.
argv_case "a token spelling the heredoc delimiter survives" " EOF -- x" "$(printf -- 'EOF\n--\nx')"


# A FLOOR on the case total. Every `for` loop above expands a LIST, and emptying
# one -- or deleting a case -- removes assertions SILENTLY while the tally still
# reads `fail: 0`. No suite in this repo had one, so the only thing standing
# between a gutted loop and a green run was somebody noticing the number move.
# Raise it when cases are added; never lower it to make a red run green.
# --- gate_word_is_literal -------------------------------------------------------
#
# The INVERTED default. `gate_argv` above splits words; this answers whether a
# word reaches the command as the text it carries, and it answers NO by default.
# Three rounds of `main-tree-branch-gate` fixes each taught the stripper one more
# shell form and each time the next round found the form still missing -- last
# `$EMPTY` (an empty expansion VANISHES, so the gate counted a positional git
# never receives) and `{fd}>/dev/null` (bash's fd-variable redirection, a word
# git never receives at all). Both turned a real branch switch into a two-
# positional file restore and PASSED.
#
# The cases below are therefore in two halves, and the SECOND half is what makes
# the first mean anything: if the inert list quietly shrank, the refusals would
# all still pass while every ordinary command started blocking.
lit_case() { # name, word, want-rc
  local name="$1" word="$2" wantrc="$3" gotrc
  gate_word_is_literal "$word"; gotrc=$?
  if [ "$gotrc" = "$wantrc" ]; then
    pass=$((pass + 1)); printf 'OK   gate_word_is_literal: %s\n' "$name"
  else
    fail=$((fail + 1))
    printf 'FAIL gate_word_is_literal: %s\n  word: [%s]\n  want rc=%s got rc=%s\n' \
      "$name" "$word" "$wantrc" "$gotrc"
  fi
}
# REFUSED -- every one of these is a word the shell may rewrite or remove.
lit_case "an unquoted \$ expansion is refused" '$EMPTY' 1
lit_case "a braced \$ expansion is refused" '${EMPTY}' 1
lit_case "a \$ inside DOUBLE quotes is still refused" '"$f"' 1
lit_case "a backtick substitution is refused" '`date`' 1
lit_case "a backslash escape is refused" 'a\b' 1
lit_case "the fd-variable redirection prefix is refused" '{fd}>/dev/null' 1
lit_case "a brace word is refused" '{a,b}' 1
lit_case "a glob star is refused" '*.ts' 1
lit_case "a glob question mark is refused" 'a?b' 1
lit_case "a bracket expression is refused" 'a[bc]' 1
lit_case "a leading tilde is refused" '~/x' 1
lit_case "a history bang is refused" 'a!b' 1
lit_case "a metacharacter that reached here is refused" 'a;b' 1
lit_case "a pipe is refused" 'a|b' 1
lit_case "a redirection character is refused" '>x' 1
lit_case "a subshell paren is refused" '(x)' 1
lit_case "a leading # is refused (it opens a comment)" '#branch' 1
lit_case "an unbalanced quote is refused" "'open" 1
lit_case "the empty word is refused" '' 1
# ADMITTED -- the other half. Each of these is an ordinary git argument, and the
# gate's ALLOW arms are unreachable without them.
lit_case "a plain name is literal" 'feat' 0
lit_case "a slashed, dotted, dashed name is literal" 'feat/x-1.2' 0
lit_case "a glued long-option value is literal" '--create=feat' 0
lit_case "a caret revision is literal" 'HEAD^' 0
lit_case "a # INSIDE a word is literal" 'has#hash' 0
lit_case "a comma is literal without a brace" 'a,b' 0
lit_case "a colon and an at-sign are literal" 'a:b@c' 0
lit_case "a plus and a percent are literal" 'a+b%c' 0
lit_case "a SINGLE-quoted \$ is literal" "'feat\$x'" 0
lit_case "a single-quoted space is literal" "'my branch'" 0
lit_case "a DOUBLE-quoted plain word is literal" '"main"' 0
lit_case "an embedded quoted span is literal" 'core.pager="less"' 0

# --- gate_strip_comment ---------------------------------------------------------
#
# The cut happens BEFORE the split, which is the whole fix: an apostrophe inside
# a comment used to be weighed as a quote, so `git checkout main # don't switch
# lanes` came back a truncation and the gate blocked a command bash calls valid
# and git answers with "Already on 'main'".
cut_case() { # name, text, want
  local name="$1" text="$2" want="$3" got
  got=$(gate_strip_comment "$text")
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   gate_strip_comment: %s\n' "$name"
  else
    fail=$((fail + 1))
    printf 'FAIL gate_strip_comment: %s\n  text: [%s]\n  want: [%s]\n  got : [%s]\n' \
      "$name" "$text" "$want" "$got"
  fi
}
cut_case "a comment is cut at the word start" 'main # switch lane' 'main '
cut_case "an APOSTROPHE inside the comment does not poison it" \
  "main # don't switch lanes" 'main '
cut_case "a # mid-word is not a comment" 'feat#1' 'feat#1'
cut_case "a # inside a quoted span is not a comment" "main -- 'a#b'" "main -- 'a#b'"
# The DISCRIMINATING half of that pair: with a SPACE before it, the `#` sits at
# what would be a word start if the quotes were not tracked, so a cut here is
# exactly what dropping the quote state produces. The case above cannot see
# that -- its `#` is preceded by `a` either way.
cut_case "a # at a word start INSIDE quotes is still not a comment" \
  "main -- 'a #b' tail" "main -- 'a #b' tail"
cut_case "an escaped # is not a comment" 'main \# x' 'main \# x'
cut_case "text with no comment is unchanged" '-b feat' '-b feat'
# The SECOND PASS, the `ignore_q` trick `gate_segments_raw` already uses: the
# leading `'` never closes, so on the retry it is treated as literal and the
# comment is found. The result is still unsplittable, and `gate_argv` still
# refuses it -- correctly, since bash calls that text a syntax error.
cut_case "an unclosed quote is retried with the quote literal" \
  "'unbalanced # x" "'unbalanced "

# --- gate_argv: round 4 ---------------------------------------------------------
argv_case "a comment carrying an apostrophe no longer truncates" \
  " main # don't switch lanes" "main"
# SPACED redirection operators. Each of these drops BOTH words; dropping an
# operator from GATE_REDIR_TOKEN makes the operator itself read as an argument,
# which is the FAIL-OPEN direction (an extra positional relaxes the gate's
# verdict to "file restore").
argv_case "a spaced append redirection drops its target" " feat 2>> log" "feat"
argv_case "a spaced clobber redirection drops its target" " feat >| out" "feat"
argv_case "a spaced dup-out redirection drops its target" " feat >& out" "feat"
argv_case "a spaced dup-in redirection drops its target" " feat <& 3" "feat"
argv_case "a spaced &> redirection drops its target" " feat &> out" "feat"
argv_case "a spaced &>> redirection drops its target" " feat &>> out" "feat"


# --- gate_dequote_structural (go-to-k/cdkd#2333) ----------------------------
# The differential fence observes match / target / segcount, so a change to the
# segment TEXT is invisible to it until it changes a verdict. These cases assert
# the TEXT directly, and the second block is the load-bearing half: the rewrite
# must be POSITIONAL, so every shape whose quoting is an ARGUMENT has to come
# back BYTE-IDENTICAL. That is the property the withdrawn whole-segment
# implementation did not have -- it rewrote `'f\.txt'` for
# `dirty-path-restore-gate`'s `split_paths` and the `=>` of
# `grep -n '=>' x.ts && git commit` for `gated-command-preamble-gate`.
dq_case() { # name, input, expected segment text
  local name="$1" in="$2" want="$3"
  gate_dequote_structural "$in"
  if [ "$GATE_STRUCT_SEG" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   gate_dequote_structural: %s\n' "$name"
  else
    fail=$((fail + 1)); printf 'FAIL gate_dequote_structural: %s\n' "$name"
    fail_log="${fail_log}FAIL gate_dequote_structural: $name\n  in  : [$in]\n  want: [$want]\n  got : [$GATE_STRUCT_SEG]\n"
  fi
}
dq_same() { dq_case "$1" "$2" "$2"; }
# MUTATION EVIDENCE LIVES IN A SCRIPT, NOT IN THIS COMMENT.
# `bash .claude/hooks/lib/command-match-mutants.sh` applies ten deliberately
# broken copies of `command-match.sh` -- among them the whole-segment dequote
# with its safety guards removed, which is the implementation that was built,
# reviewed four rounds and WITHDRAWN -- and prints the tally for each. It exits
# non-zero if any mutant fails to reduce the pass count, so a mutation no case
# notices is reported rather than assumed absent.
#
# NO TALLIES ARE COPIED HERE ON PURPOSE. They were, twice, and were stale both
# times: first measured before eleven cases were added, then measured on a
# 541-case tree while the floor already said 543, so every published row summed
# to one less than the file's own case count. A reviewer caught it each time.
# Two occurrences of one shape is the signal to change instrument rather than
# to recount, so the numbers now have exactly one home and it is executable.

# The eight shapes go-to-k/cdkd#2333 measured, each an executable command that
# really runs the gated verb.
dq_case "a DOUBLE-quoted verb"        'git "commit" -m x'          'git commit -m x'
dq_case "a SINGLE-quoted verb"        "git 'commit' -m x"          'git commit -m x'
dq_case "a verb split by a quoted span" 'git c"o"mmit -m x'        'git commit -m x'
dq_case "an ESCAPED verb"             'git \commit -m x'           'git commit -m x'
dq_case "a quoted leading FLAG"       'git "-C" /tmp/wt commit -m x' 'git -C /tmp/wt commit -m x'
dq_case "an escaped leading FLAG"     'git \-C /tmp/wt commit -m x'  'git -C /tmp/wt commit -m x'
dq_case "a quoted FIRST gh verb token"  'gh "pr" merge 1 --squash' 'gh pr merge 1 --squash'
dq_case "a quoted SECOND gh verb token" 'gh pr "merge" 1 --squash' 'gh pr merge 1 --squash'
# The RESOLVER's own clause: a quoted `cd` sent `"cd" /main-tree && git commit`
# straight through branch-gate.
dq_case "a quoted cd command word"    '"cd" /tmp/wt'               'cd /tmp/wt'
dq_case "an escaped cd command word"  '\cd /tmp/wt'                'cd /tmp/wt'
# `bash -c` is re-segmented by gate_segments, which keys on the LITERAL word.
dq_case "a quoted bash -c leader"     '"bash" -c "git commit"'     'bash -c "git commit"'
dq_case "a quoted -c flag on bash"    'bash "-c" "git commit"'     'bash -c "git commit"'
# A flag NAME may be rewritten; its VALUE never is, even in the same segment.
dq_case "a rewritten flag keeps its quoted VALUE" \
  "git \"-C\" '/a b' commit -m x" "git -C '/a b' commit -m x"

# --- and the other direction: BYTE-IDENTICAL or the rewrite has overreached --
# The read-only shapes the withdrawn implementation took from rc=0 to rc=2 all
# share one property: the quoted token sits AFTER the verb. Three stand for the
# class here and are ALSO corpus ids 218-220 in the differential; the other
# nine are pinned further down, under "the remaining nine". An earlier revision
# of this comment said "the rest are corpus ids 218-220" -- those ids are these
# same three, so nine shapes were pinned nowhere and the sentence said they
# were.
dq_same "a quoted --grep pattern is an ARGUMENT"  'git -C /tmp/wt log --grep "commit"'
dq_same "a quoted revision is an ARGUMENT"        'git -C /tmp/wt show "commit"'
dq_same "a quoted pathspec is an ARGUMENT"        'git -C /tmp/wt grep -n "commit" -- src'
# An unknown command word stops the walk before it starts -- this is what keeps
# `gated-command-preamble-gate`'s `=>` a redirect-free argument.
dq_same "an unknown command word is never walked" "grep -n '=>' x.ts"
dq_same "a quoted mention in an echo"             'echo "git commit -m x"'
# A backslash inside SINGLE quotes is a literal backslash, and dequoting it
# would make it escape: `split_paths` then resolved a different path and the
# go-to-k/cdkd#1700 data-loss gate exited 0.
dq_same "a single-quoted backslash path"          "git checkout -- 'f\\.txt'"
# A result carrying WHITESPACE means the span was how the shell passes ONE
# argument, so its content is DATA.
dq_same "a quoted -C value containing a space"    'git -C "/a b" commit -m x'
dq_same "a quoted -c value containing a space"    'git -c user.name="Jane Doe" commit -m x'
dq_same "a quoted alias value naming a verb"      'git -c alias.x="run commit later" status'
# An ESCAPED quote outside a span dequotes to a BARE quote, which the
# quote-AWARE _GATE_WORD alternatives then read as an OPENING quote -- three
# gates stopped firing on this shape in the withdrawn round.
dq_same "an escaped quote inside a flag value"    'git -c user.name=O\"Brien commit'
# An UNBALANCED apostrophe in a path is the case that forced apostrophes to stay
# legal in the trigger at all (go-to-k/cdkd#2199).
dq_same "an unbalanced apostrophe in a -C path"   "git -C /tmp/o'neill/repo commit"
dq_same "a gh --body carrying a gated verb"       'gh issue comment 42 --body "next: pr merge 5"'
dq_same "a gh --body in single quotes"            "gh issue comment 42 --body 'next: pr merge 5'"
dq_same "an already-bare command needs no rewrite" 'git commit -m "msg"'

# THE CAP IS IN TOKENS, NOT BYTES, and both halves are asserted. Padding lives
# INSIDE a token, so no amount of it moves the verb past a token cap -- the
# withdrawn implementation's 512-byte cap was defeated by 400 bytes of `-c`
# value. Reaching the cap abandons the rewrite WHOLE, which is today's
# behaviour rather than a half-rewritten stream.
dq_pad=$(printf 'x%.0s' $(seq 1 400))
dq_case "400 bytes of padding do not hide the verb" \
  "git -c user.name=$dq_pad -C /tmp/wt \"commit\" -m x" \
  "git -c user.name=$dq_pad -C /tmp/wt commit -m x"
# THE THREE BOUNDS. Each one is a security property, not tidiness: a hook
# killed by the 10 s PreToolUse timeout cannot emit exit 2, which disarms every
# gate at once -- strictly worse than the bypass this whole change closes. Each
# is paired with a case proving it does NOT fire on a real command line, so a
# bound tightened by accident is loud.
#
# THE TOKEN-COUNT CAP IS A COST BOUND AND A RESIDUE AT THE SAME TIME, and both
# halves are pinned here because two successive revisions got it wrong in
# opposite directions. First the file claimed a token cap "cannot be padded
# past, because padding lives INSIDE a token" -- false, measured against a real
# `main` checkout with `branch-gate.sh`: `git --no-pager x23 "commit"` rc=2,
# `git --no-pager x24 "commit"` rc=0. Then the cap was raised to 256 to close
# that, which re-opened a timeout DoS BELOW origin/main's cost -- the outer walk
# is quadratic too, `branch-gate` went from 4.43 s on main to KILLED at 10 s on
# a 164 KB payload, and a killed hook disarms every gate at once. There is no
# value that is neither, so the cap is set for COST and the bypass is recorded.
dq_over="git"
for _i in $(seq 1 30); do dq_over="$dq_over --no-pager"; done
dq_same "past the token-count cap the segment is returned UNCHANGED" \
  "$dq_over \"commit\" -m x"
dq_under="git"
for _i in $(seq 1 20); do dq_under="$dq_under --no-pager"; done
dq_case "under the token-count cap the verb is still dequoted" \
  "$dq_under \"commit\" -m x" "$dq_under commit -m x"
# EMPTY QUOTED PAIRS ARE FREE PADDING -- they do not change the word, so
# `c""""..""ommit` really runs `git commit` (confirmed with `eval printf`:
# argv is `[commit] [-m] [x]`). Charging them against the SPAN budget let 32
# pairs -- 79 bytes -- exhaust it and abandon, re-opening this issue'"'"'s own
# bypass more cheaply than the shape it was filed for. Deleting the pairs
# before the walk is what closes it: the earlier span-charge exemption stopped
# the bypass but still paid O(remaining) per pair, so 49 KB cost 11.5 s and
# killed the hook.
#
# THESE TWO CASES DO NOT FENCE THE COLLAPSE, and saying so matters: both stay
# green with the collapse deleted, because the charge exemption alone also lets
# them through. The collapse's behavioural fence is the cross-context case
# after them, and its cost fence is the wall-clock case at the end of this file.
dq_free=""
for _i in $(seq 1 40); do dq_free="$dq_free\"\""; done
dq_case "40 EMPTY quoted pairs do not hide the verb" \
  "git c${dq_free}ommit -m x" 'git commit -m x'
dq_freesq=$(printf "''%.0s" $(seq 1 40))
dq_case "40 empty APOSTROPHE pairs do not hide the verb either" \
  "git c${dq_freesq}ommit -m x" 'git commit -m x'
# THE COLLAPSE'S OWN FENCE, and it pins a FALSE FIRE on purpose. Deleting the
# pairs is a rewrite, so it reaches across quoting contexts: `git 'com""mit'`
# runs a subcommand git does not have and now dequotes to `commit`, so the
# gates fire on a command that commits nothing. That is the loud direction and
# it is the price of the collapse -- pinning it is what lets a NON-timing case
# notice if the collapse is ever removed.
dq_case "an empty pair ACROSS quoting contexts is collapsed too (a false fire, pinned)" \
  "git 'com\"\"mit' -m x" 'git commit -m x'
# LENGTH and SPAN bounds on ONE token. Without them the span walk is quadratic
# in token length AND in quote count together: measured through `gate_segments`
# on one input, 12 KB took 154.5 s and 67 KB took 45.1 s, against 0.05 s and
# 0.40 s on origin/main -- so `git <4 KB of quoted padding> ; git commit -m x`
# burned the budget in segment ONE, the hook died, and segment TWO committed
# with every gate disarmed. Bounded, the same inputs are 0.065 s and 0.520 s.
dq_long=$(printf 'a%.0s' $(seq 1 600))
dq_same "a structural token past the LENGTH bound is left alone" \
  "git \"c${dq_long}ommit\" -m x"
# The SPAN bound is charged only by spans that consumed characters, so the
# case that exercises it must carry NON-empty ones.
# `"x"y` rather than `"x"`: consecutive `"x"` pairs put a `""` at every
# junction, which the empty-pair collapse removes, leaving a token with almost
# no spans at all.
dq_many=$(printf '"x"y%.0s' $(seq 1 40))
dq_same "a structural token past the SPAN bound is left alone" \
  "git c${dq_many}ommit -m x"
# ...and the bounds must not fire on an ordinary command: a real global-flag
# name and subcommand are far under both.
dq_case "an ordinary command is nowhere near either bound" \
  'git --no-pager "commit" -m x' 'git --no-pager commit -m x'

# --- what the rewrite must NOT touch, round 2 -------------------------------
# Every case here was a REAL defect found in review of the first round, and
# each is the withdrawn design's failure class -- an ARGUMENT being rewritten --
# arriving through a different door.
#
# `gh`'s second token is a verb only for the groups that HAVE one. It is an
# ARGUMENT for `api`, and the first round consumed it unconditionally.
dq_same "gh api's second token is an ARGUMENT, not a verb" 'gh api "repos/o/r/pulls/1"'
dq_same "gh api's argument keeps a metacharacter quoted" 'gh api "repos/o/r/x;y"'
dq_case "gh pr still takes a TWO-token verb" 'gh "pr" "merge" 1' 'gh pr merge 1'
dq_case "gh issue still takes a TWO-token verb" 'gh "issue" "create" -t x' 'gh issue create -t x'
# `bash`'s second token is the `-c` FLAG or a script PATH; only the flag is
# structural.
dq_same "bash's script PATH is an argument"        'bash "scripts/foo.sh"'
dq_case "bash's -c flag is structural"             'bash "-c" "git commit"' 'bash -c "git commit"'
# SHELL METACHARACTERS. `git "a>b"` was rewritten to `git a>b`, which puts a
# live REDIRECT into the stream every reader parses -- the probe that found it
# created the file. `git "com;mit"` grew a bare `;` the segmenter splits on.
dq_same "a quoted redirect operator is never unquoted"   'git "a>b"'
dq_same "a quoted command separator is never unquoted"   'git "com;mit"'
dq_same "a quoted background operator is never unquoted" 'git "a&&b"'
dq_same "a quoted pipe is never unquoted"                'git "a|b"'
dq_same "a quoted subshell paren is never unquoted"      'git "a(b)"'
# ANSI-C quoting: the walk reads `$'...'` as `$` plus a quoted span, which is
# NOT what bash does, so it used to emit the mangled `$commit`. Abandoning is
# correct; `$'...'` stays a recorded residue.
dq_same "ANSI-C quoting abandons rather than mangling"   "git \$'commit' -m x"
# A backslash inside a DOUBLE-quoted span escapes only `$ \` \" \\` and a
# newline; before anything else it is literal. Consuming it unconditionally
# made `git "com\mit"` dequote to `commit`, firing every gate on a command that
# runs no gated verb.
dq_same "a literal backslash inside a double-quoted span" 'git "com\mit"'
dq_case "an ESCAPED quote inside a double-quoted span"    'git "com\"mit"' 'git "com\"mit"'

# --- branches the first round left with no case at all ----------------------
dq_case "a non-value FLAG before a quoted verb"  'git -q "commit" -m x' 'git -q commit -m x'
dq_case "a value flag's VALUE is copied verbatim while the verb is rewritten" \
  'git -C "/tmp/wt" "commit" -m x' 'git -C "/tmp/wt" commit -m x'
# The bare-`grep` control stops at cheap-stop 2 and never reaches the
# unknown-command-word arm; a QUOTED unknown word is what exercises it.
dq_same "a QUOTED unknown command word abandons the walk" "\"grep\" -n '=>' x.ts"
dq_same "a quoted unknown command word with a gated verb after it" '"echo" git commit'
dq_case "sh takes the same arm as bash"  'sh "-c" "git commit"'  'sh -c "git commit"'
dq_case "zsh takes the same arm as bash" 'zsh "-c" "git commit"' 'zsh -c "git commit"'
dq_case "ksh takes the same arm as bash" 'ksh "-c" "git commit"' 'ksh -c "git commit"'
dq_case "delstack is a bare command word" '"delstack" -f' 'delstack -f'
dq_same "npx with nothing after it abandons" '"npx"'
# The `#` default arm of the outside-quotes walk: a `#` is not a quote and must
# survive the dequote. The previous case for this used `git c#mmit -m x`, which
# has no quote or backslash at all and returned at cheap-stop 1 -- it never
# reached the code it was named for.
dq_case "a # inside a QUOTED token survives the dequote" 'git "com#mit" -m x' 'git com#mit -m x'

# --- the remaining nine of the sixteen withdrawn-round read-only shapes ------
# The first round pinned three and its comment claimed "the rest are corpus ids
# 218-220" -- those ARE the same three. These are the other nine, each one a
# command whose quoted token sits after a READ verb.
dq_same "read-only: log --author"   'git -C /tmp/wt log --author "push"'
dq_same "read-only: tag -l"         'git -C /tmp/wt tag -l "push"'
dq_same "read-only: diff --stat"    'git -C /tmp/wt diff --stat "commit"'
dq_same "read-only: ls-files"       'git -C /tmp/wt ls-files "push"'
dq_same "read-only: rev-list"       'git -C /tmp/wt rev-list -n 1 "commit"'
dq_same "read-only: describe --tags" 'git -C /tmp/wt describe --tags "commit"'
dq_same "read-only: cat-file -p"    'git -C /tmp/wt cat-file -p "commit"'
dq_same "read-only: notes list"     'git -C /tmp/wt notes list "commit"'
dq_same "read-only: log -1 --pretty" 'git -C /tmp/wt log -1 --pretty="%s" -- "commit"'



# Degenerate inputs, and the command-word arms the cases above do not reach.
# An UNTERMINATED quote is the one that matters: it cannot be split into shell
# words at all, so the rewrite must abandon rather than guess -- the same answer
# `gate_tokens` gives, and the opposite of the round-4 defect where one
# unbalanced apostrophe in a `--body` segmented the whole command to ZERO and
# disarmed every gate at once.
dq_same "an unterminated double quote abandons" 'git "unterminated'
dq_same "an unterminated apostrophe abandons"   "git 'unterminated"
dq_same "an EMPTY quoted token is not a verb"   'git ""  -m x'
dq_same "a bare command word alone"             'git'
dq_same "a # inside a word is not a quote"      'git c#mmit -m x'
dq_case "a quoted command word alone"           '"git"' 'git'
# The other command-word arms. `npx` shifts one token before the grammar
# starts; `cdk` takes one verb token and `vp` two, like `git` and `gh`.
dq_case "npx shifts to the SECOND command word" 'npx cdk "deploy"'     'npx cdk deploy'
dq_case "cdk takes a one-token verb"            'cdk "deploy" --all'   'cdk deploy --all'
dq_case "vp takes a two-token verb"             'vp run "test" foo.ts' 'vp run test foo.ts'
# The sharpest VALUE case: the flag value carries a SPACE inside double quotes
# and the verb right after it is quoted. Dequoting the value would hand
# `gate_target_dir` a path that no longer parses.
dq_case "a spaced -C value survives a rewritten verb" \
  'git -C "/a b" "commit" -m x' 'git -C "/a b" commit -m x'
dq_case "a spaced cd path survives a rewritten cd" \
  '"cd" "/a b" && git commit' 'cd "/a b" && git commit'

# --- an ODD trailing BACKSLASH escapes the whitespace (go-to-k/cdkd#2650) ----
# `cd\ /tmp` is ONE shell word, so it is not a `cd` at all -- bash answers
# `cd /tmp: No such file or directory` and stays put. The token splitter here
# breaks on whitespace alone, so it used to hand back `cd\`, rewrite that to
# `cd`, and re-join with a plain space: a `cd` MANUFACTURED out of a command
# bash never runs. Live: `cd\ /tmp ; echo hi > <tracked>` in the main checkout
# on `main` came out of `main-tree-edit-gate` at rc=0 where it owed a 2.
dq_same "an odd trailing backslash on the command word abandons" \
  'cd\ /tmp && echo x > f'
dq_same "the same in the subcommand slot" \
  'git commit\ -m x'
# EVEN is not odd: `\\` is a literal backslash, the space after it separates,
# and the word really is `cd\` -- still not `cd`, and still left alone, but by
# the existing backslash-in-result guard rather than by this one.
dq_same "an even trailing backslash is a literal, not an escape" \
  'cd\\ /tmp && echo x > f'
# THE CONTROL THAT CAUGHT THE FIRST ATTEMPT. The parity walk reads a bounded
# TAIL of the token, and the first spelling used `${t: -64}` unconditionally --
# which bash evaluates to the EMPTY string when the token is shorter than the
# window, unlike the analogous Python slice. Every short token then took the
# unknowable-parity arm, so `gate_dequote_structural` abandoned on EVERY input
# and the dequote silently stopped existing. A plain quoted verb is the
# cheapest witness to that, and it is the one below.
dq_case "a short verb still dequotes (bounded-tail regression)" \
  'git "commit" -m x' 'git commit -m x'
dq_case "a long token past the tail window still dequotes" \
  'git "commit" -m aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  'git commit -m aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

# --- the READER SITES, with a QUOTED structural token (go-to-k/cdkd#2333) ----
# Closing this at `gate_matches` alone would not close it: every function that
# decides a gate outcome from a segment reads the same stream, and each
# unpatched one is an independent live bypass. Measured against `origin/main`'s
# library, all four of these returned EMPTY -- `pr-review-gate` and
# `ci-green-gate` would have tiered and CI-gated a DIFFERENT PR than the one
# merging, and `dirty-path-restore-gate` (the go-to-k/cdkd#1700 data-loss gate)
# would have had no path to check.
want_sel "552" "gh pr \"merge\" <N>: a quoted verb still yields the selector" 'gh pr "merge" 552 --squash'
want_sel "552" "gh \"pr\" merge <N>: a quoted FIRST verb token too" 'gh "pr" merge 552 --squash'
want_sel "552" "gh -R o/r pr \"merge\" <N>: behind a global flag" 'gh -R o/r pr "merge" 552'
want_rest_each "-- f.txt" "a quoted checkout verb still yields its path tail" \
  'git -C /wt "checkout" -- f.txt' "$GATE_RE_GIT_CHECKOUT_RESTORE"
want_rest_each "f.txt" "a quoted -C flag still yields the restore tail" \
  'git "-C" /wt restore f.txt' "$GATE_RE_GIT_CHECKOUT_RESTORE"

# --- LATENCY IS A CORRECTNESS PROPERTY HERE, so it gets a case ---------------
# A hook killed by the 10 s PreToolUse timeout cannot emit exit 2, and that
# disarms EVERY gate at once -- strictly worse than any single unmatched
# spelling. THREE successive revisions of `gate_dequote_structural` blew that
# budget and nothing in this file noticed any of them: an unbounded walk took a
# 12 KB command to 154 s; raising the token cap to 256 took `branch-gate` from
# 4.43 s to KILLED on 164 KB; and exempting empty spans from the span budget
# without DELETING them still ran a full O(remaining) extraction per pair, so
# 49 KB took 11.5 s against origin/main's 0.49 s.
#
# THE PAYLOAD IS THE ONE THAT WAS SLOW, and choosing it is the whole case. Two
# earlier versions of this case measured nothing. The first used tokens with 30
# NON-empty spans, which bail at the span bound after ~17 iterations: it ran in
# 0.645 s with ALL THREE bounds removed, against a 3 s budget. The second used
# empty pairs but only two SEGMENTS, and the per-segment walk stops at
# GATE_STRUCT_MAXTOK tokens, so the cost plateaued at ~1.5 s -- still under
# budget with the fix removed.
#
# Cost is per SEGMENT, so the payload has to be. Four segments of twice the
# token cap, measured on this machine against a 4 s threshold:
#
#   as it ships                        0.86 s
#   with the empty-pair collapse gone  6.68 s
#   with GATE_STRUCT_MAXTOK at 256    80.01 s
#
# So it reds for BOTH regressions this file has already shipped, with 4.6x of
# headroom below the threshold -- re-measured under 8-way load at 1.08 s in
# review, so it does not flake.
lat_tok="-$(printf '""%.0s' $(seq 1 253))q"
# DERIVED from the cap, not the literal 24: with exactly MAXTOK tokens the
# payload is indifferent to the cap's VALUE, so raising the cap -- the round-2
# regression -- did not redden this. Twice the cap does.
lat_seg="git"
for _i in $(seq 1 $((GATE_STRUCT_MAXTOK * 2))); do lat_seg="$lat_seg $lat_tok"; done
lat_cmd="$lat_seg"
for _i in $(seq 1 3); do lat_cmd="$lat_cmd ; $lat_seg"; done
lat_cmd="$lat_cmd ; git commit -m x"
lat_start=$(date +%s)
gate_segments "$lat_cmd" >/dev/null 2>&1
lat_end=$(date +%s)
lat_secs=$((lat_end - lat_start))
# THE BUDGET IS 4s AND THE MESSAGES SAID 8s, so a failure here printed
# `took 6s, budget 8s` -- self-contradictory, and it reads as a broken check
# rather than a slow one. The THRESHOLD is left alone (retuning another change's
# fence is not this PR's business); only the text is made true. Worth knowing
# while reading a red: standalone this payload measures 0-1s on both
# `origin/main` and this branch under bash 3.2, so a 6s reading here is
# contention INSIDE the suite process, not a cost of the command
# (go-to-k/cdkd#3242 round-4).
if [ "$lat_secs" -le 4 ]; then
  pass=$((pass + 1))
  printf 'OK   latency: %s bytes through gate_segments in %ss (budget 4s)\n' "${#lat_cmd}" "$lat_secs"
else
  fail=$((fail + 1))
  printf 'FAIL latency: %s bytes took %ss, budget 4s\n' "${#lat_cmd}" "$lat_secs"
  fail_log="${fail_log}FAIL latency: ${#lat_cmd} bytes took ${lat_secs}s against a 4s budget -- the PreToolUse timeout is 10s and a KILLED hook cannot emit exit 2, which disarms every gate at once; if the machine is loaded, re-measure this payload standalone before reading it as a cost\n"
fi

# BOTH GH FLAG SLOTS AT LENGTH (go-to-k/cdkd#3242 round-2 security review). The
# existing case above pads the TOKEN COUNT; this one pads the TAIL, because the
# dequote walk's `_gate_struct_next` ERE-matches the ENTIRE remaining string per
# token, so its real cost scales with command LENGTH times the number of tokens
# it walks. The round-2 revision gave the right slot its OWN
# `GATE_STRUCT_MAXTOK` budget, which doubled that product and took the cheapest
# hook-killing input from ~260 KB down to ~155 KB -- a SILENT PASS, since a
# killed hook emits no exit 2 and every gate goes quiet together. Measured
# through the real pr-body-item-number-gate at a 150 KB tail: origin/main 4.27s,
# private budget 7.02s, shared budget 5.09s. The walk shares the outer `n` now.
#
# The budget is deliberately the same 8s as its sibling and NOT tighter: this
# case runs on a machine that may be carrying peer suites, and a flaky timing
# fence gets discharged by raising the number rather than by re-measuring. What
# it must catch is the DOUBLING, which is well outside that band.
__ds_f=""
for _i in $(seq 1 23); do __ds_f="$__ds_f -R \"o/r\""; done
__ds_tail=$(head -c $((150 * 1024)) < /dev/zero | tr '\0' 'x')
__ds_cmd="gh$__ds_f pr$__ds_f \"merge\" 42 $__ds_tail"
__ds_start=$(date +%s)
gate_segments "$__ds_cmd" >/dev/null 2>&1
__ds_end=$(date +%s)
__ds_secs=$((__ds_end - __ds_start))
if [ "$__ds_secs" -le 8 ]; then
  pass=$((pass + 1))
  printf 'OK   latency: both gh flag slots + %s bytes through gate_segments in %ss (budget 8s)\n' "${#__ds_cmd}" "$__ds_secs"
else
  fail=$((fail + 1))
  printf 'FAIL latency: both gh flag slots + %s bytes took %ss, budget 8s\n' "${#__ds_cmd}" "$__ds_secs"
  fail_log="${fail_log}FAIL latency: both gh flag slots + ${#__ds_cmd} bytes took ${__ds_secs}s -- the dequote walk is spending more than the outer GATE_STRUCT_MAXTOK budget; a killed hook cannot emit exit 2 and disarms every gate at once\n"
fi

# At the OBSERVED count, with no slack. It carried one case of slack until
# go-to-k/cdkd#2650, which is the shape the differential's own header warns
# about one directory over: slack is how a probe deletes cases and still
# passes. Both builds agree on the number -- 556 under bash 3.2 and under 5.3
# -- so no case is version-gated and a strict floor cannot fail on one runner
# while passing on the other.

# `gate_segments_marked` marks a segment 1 when it is SUBSHELL-DERIVED -- a `cd`
# there cannot move the caller -- and 0 at top level. Which mark a `cd` carries
# is what decides the tree every gate resolves its markers in, so it is the
# observable for anything that changes where a substitution is thought to end.
mark_of() { # name, segment-text, expected-mark, command
  local name="$1" seg="$2" want="$3" cmd="$4" got
  got="$(gate_segments_marked "$cmd" | awk -F'\t' -v s="$seg" '$2 == s {print $1; exit}')"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$name"
  else
    fail=$((fail + 1)); printf 'FAIL %s (want mark "%s", got "%s")\n' "$name" "$want" "$got"
    fail_log+="FAIL $name\n  command: $cmd\n"
  fi
}

mark_last() { # name, expected-LAST-line, command
  local name="$1" want="$2" cmd="$3" got
  got="$(gate_segments_marked "$cmd" | tail -1)"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$name"
  else
    fail=$((fail + 1)); printf 'FAIL %s (want "%s", got "%s")\n' "$name" "$want" "$got"
    fail_log+="FAIL $name\n  command: $cmd\n"
  fi
}

mark_check() { # name, expected-first-line, command
  local name="$1" want="$2" cmd="$3" got
  got="$(gate_segments_marked "$cmd" | head -1)"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$name"
  else
    fail=$((fail + 1)); printf 'FAIL %s (want "%s", got "%s")\n' "$name" "$want" "$got"
    fail_log+="FAIL $name\n  command: $cmd\n"
  fi
}

# `subst_open`'s `#` arm must not run inside quotes (code review round 25). It
# sits after the double-quote branch falls through -- substitutions are live in
# double quotes -- so a `#` in a QUOTED argument ended the scan; round 23 adding
# `)` to that class made `x="a )#"$(` do it, and the `cd` running in the
# substitution child resolved as the TOP-LEVEL target. SQ2 is the pre-existing
# half and the commonest `gh` spelling in this repo. `close_paren` and
# `flush_line` both test the quote state; this was the third machine.
# Mutant `so-hash-in-quotes`.
mark_check "SQ1: a )# inside a double-quoted argument does not end the scan" "1	cd /tmp" \
  "$(printf '%s\n' 'x="a )#"$(' 'cd /tmp' ')')"
mark_check "SQ2: a # in a --body argument does not either" "1	cd /tmp" \
  "$(printf '%s\n' 'gh pr comment 1 --body "closes #3040" $(' 'cd /tmp' ')')"
mark_check "SQ-ctl: the same shape with no # (control)" "1	cd /tmp" \
  "$(printf '%s\n' 'x="a )"$(' 'cd /tmp' ')')"
# Round 24 reordered the single-quote arm ahead of the backslash skip; this is
# the shape that discriminates it (code review round 25 supplied it): a `\`
# inside `'"'"'...'"'"' is literal, so the span stays open and the `$(` that follows is
# inside it. Reverted, the backslash eats the closing quote and the `cd` is
# read as top-level. Mutant `so-sq-before-backslash`.
mark_check "SQ3: a backslash inside a single-quoted span is literal" "1	cd /tmp" \
  "$(printf '%s\n' 'x='"'"'a\'"'"'$(' 'cd /tmp' ')')"
# `$$` followed by a QUOTE is ambiguous and reports the span OPEN (security
# review round 27). bash reads the PID then a plain span; zsh reads `$` then
# an ANSI-C span, and round 25's plain step-over traded a bash fail-open for
# a zsh one -- the real `main-tree-edit-gate` went 2 -> 0 on the zsh shape.
# Reporting OPEN keeps the body inside the substitution, so its `cd` is child
# context under either reading. SQ10 is the shape that regressed and the one
# `so-pid-step-over` reds; SQ4 cannot pin the ambiguity RULE, because under
# both readings its own input ends OPEN -- it is the whole-arm control, and
# `so-pid-arm-whole` is its mutant (test review round 29 measured SQ4 green
# under the sixteen `so-*` mutants THAT HEAD CARRIED, the c1b shape -- a
# historical figure, not a running tally: the set is larger now).
mark_of "SQ4: the \$\$ arm exists at all (a whole-arm control -- both readings end OPEN here)" "cd /tmp" "1" \
  "$(printf '%s\n' 'x=$$'"'"'a\'"'"'$(' 'cd /tmp' ')')"
mark_of "SQ10: the zsh reading of an ambiguous \$\$ quote does not move the caller either" "cd sub" "1" \
  "$(printf '%s\n' "x=\$\$'a\\'b'\$(" 'cd sub' ')')"
# The two quote-OPENING arms, which no case notices either (test review
# round 26): both are on origin/main, both fail-open-directed, and both are
# cited as the rationale for arms around them -- the single-quote arm
# implements the founding measurement written directly above it, and the
# ANSI-C arm is what SQ4 steps over. Deleting either leaves the suite green
# without these. The observable is the LAST segment -- the `cd` -- because
# the body segment before it is marked either way.
# Mutants `so-sq-open-arm` and `so-ansic-arm`.
mark_last "SQ5: a ) inside a single-quoted span is data, not a closer" "1	cd /tmp" \
  "$(printf '%s\n' "x=\$(echo 'a)b'" 'cd /tmp' ')')"
mark_last "SQ6: the ANSI-C twin, where an escaped quote does not end the span" "1	cd /tmp" \
  "$(printf '%s\n' "x=\$(echo \$'a\\')b'" 'cd /tmp' ')')"
# Round 26 (security): round 25 stopping the `#` arm inside quotes exposed the
# other half of the same desync -- `subst_open` kept the OUTER quote state
# inside `$( )`, so a `#` comment carrying an unbalanced `)` reported the
# span CLOSED and the verb line was swallowed as data. All three shells run
# it and origin/main matched: 474 records. The walk saves and restores `q`
# per frame now, and inside double quotes only a `$(`, a backtick and a `\`
# are structural. Mutants `so-frame-quote-save` and `so-dq-structural`.
check "SQ7: a # comment with an unbalanced ) inside a --body substitution" 0 "$MERGE" \
  "$(printf '%s\n' 'gh pr comment 1 --body "$(' '# 1) first' 'gh pr merge 1' ')"')"
mark_last "SQ8: a ) inside a double-quoted span inside \$( ) is data" "1	cd /tmp" \
  "$(printf '%s\n' 'x=$(echo "a #)"' 'cd /tmp' ')')"
# The RESTORE half of the per-frame save: once the inner `$( )` closes, the
# walk must be back INSIDE the outer double quote, or the `#)` after it
# reads as a comment and the trailing `$(` opens a span the join then ends
# early -- `cd /tmp` becomes a TOP-LEVEL segment marked 0 although all three
# shells run it in the child. Mutant `so-frame-quote-save`.
mark_of "SQ9: the quote state is restored when an inner \$( ) closes" "cd /tmp" "1" \
  "$(printf '%s\n' 'echo "$(true) #)"$(' 'cd /tmp' ')')"

# The escaped character before the `#` is WORD GLUE here too (spec review
# round 29): round 23 gave this walk the `)` class member without the glue
# record `last_heredoc_opener` has kept since round 17, so `echo \)#b $(`
# read a comment where all three shells keep the substitution open, and the
# `cd` on the next line was marked TOP-LEVEL -- the resolution base moving
# for every gate that resolves a target. SO-ctl2 is the real comment.
# Mutant `so-bs-glue`.
mark_of "SO7: an escaped ) before the # is glue, so the span stays open" "cd sub" "1" \
  "$(printf '%s\n' 'echo \)#b $(' 'cd sub' ')')"
# SO-ctl2's input is a PARSE ERROR in bash -- a `)` in that position -- so it
# pins the reading of a shape no shell executes (test review round 30). It is
# kept because the reading is what `so-hash-class-rparen` measures, and the
# direction is safe (nothing runs); SO-ctl3 below is the executable spelling
# of the same control.
mark_of "SO-ctl2: an UNESCAPED ) before the # is a comment (control, a parse-error shape)" "cd sub" "0" \
  "$(printf '%s\n' 'echo a )#b $(' 'cd sub' ')')"

# A paren OUTSIDE every substitution has a KIND too, and this walk tracked
# none: both frame arms are gated on `depth > 0`, so at depth 0 the `)` of an
# `a=( )` reached the `#` test as a raw previous character, the scan ended,
# and the `$(` later on the SAME line was never seen (code review round 30).
# Measured in a fixture repo: BOTH bashes open that substitution and run the
# `cd` in its child -- logged from `child/` through a side channel, since a
# marker inside `$( )` is captured -- and then write the tracked file in the
# PARENT, while `main-tree-edit-gate` answered rc=0. zsh takes the OTHER
# reading -- it runs `cd child` in the parent and then dies on the line-3
# `)` -- so mark 1 is right for the two bashes and is the refusing direction
# for zsh, which is the order this file settles a disagreement in. (An
# earlier revision of this comment said zsh parse-errors and therefore runs
# nothing; it runs the `cd` first, measured through a log-file side channel.)
# SO-ctl3 is the kind-0 twin and it is a REAL comment: all three shells run
# its `cd child` in the PARENT shell before the same line-3 error, which is
# exactly what mark 0 says. Mutant `so-depth0-frame`.
mark_of "SO8: the ) of an a=( ) at depth 0 glues the #, so the \$( opens" "cd child" "1" \
  "$(printf '%s\n' 'a=(x)#b $(' 'cd child' ')')"
mark_of "SO-ctl3: the ) of a bare ( ) at depth 0 still starts a comment" "cd child" "0" \
  "$(printf '%s\n' '(echo hi)#b $(' 'cd child' ')')"

# THE GLUE RECORD IS FOR AN ESCAPED `)` ALONE, and CP-BS2 is the control that
# holds it there. Rounds 30 and 31 measured what widening it costs: bash 5.x
# and zsh glue `\ #` while bash 3.2`s `$( )` pre-scan reads a comment, and
# bash 3.2 is the only shell that runs the shape that separates them, so the
# wide reading took `x=$(echo \ #b )` / `cd ..` / `)` / a write from rc=2 to
# rc=0. Both attempts to serve both readings measured new fail-opens of their
# own, so that class now reads exactly as origin/main reads it and
# go-to-k/cdkd#3303 owns it. CP-BS2 pins the OTHER half: an escaped `)` is
# glue in all three shells, so this line must read as origin/main reads it --
# bodies first, and a `cd` that IS honoured. Mutant `so-bs-glue` reds SO7,
# `so-bs-glue-wide` (the widened record) reds this one.
mark_of "CP-BS2: an escaped ) is glue, and the cd after the span is still honoured" "cd /tmp" "0" \
  "$(printf '%s\n' 'x=$( echo W > tracked ; echo \)#b )' 'cd /tmp' 'echo z > f')"
# The other side of the same record, and the shape that prices widening it.
# An escaped SPACE before the `#` must NOT be glue: the `#` opens a comment,
# the span stays open, and the `cd` on the next line is child context -- which
# is what origin/main answers and what bash 3.2, the only shell that runs this
# shape, does. Under the widened record the span closes on line 1 and that
# `cd` is marked 0, which is the rc 2 -> 0 rounds 30 and 31 measured through
# the real gate. Mutant `so-bs-glue-wide`.
mark_of "SO9: an escaped SPACE before a # is NOT glue, so the cd stays child context" "cd .." "1" \
  "$(printf '%s\n' 'x=$(echo \ #b )' 'cd ..' ')')"

# --- gate_segments_marked's SEGMENT-COUNT bound (go-to-k/cdkd#2650) ----------
# The marking forks `printf | awk` PER SEGMENT, so its cost is linear in the
# segment count. Measured before the bound: `( cd /tmpN ) ;` x 2000 took 11 s,
# PAST the 10 s PreToolUse timeout -- and a killed hook cannot emit exit 2,
# which disarms every gate at once. The bound makes the marking CONSERVATIVE
# past the cap rather than absent: every segment marked 1, no `cd` honoured,
# `main-tree-edit-gate` blocks. Both directions are asserted, because a bound
# that only ever fires is a disabled feature and one that never fires is
# decoration.
mark_n() { # count -> the two tallies, space-separated
  local n="$1" b="" i out
  for i in $(seq 1 "$n"); do b="$b echo s$i ;"; done
  out=$(gate_segments_marked "$b")
  printf '%s %s' "$(printf '%s\n' "$out" | grep -c '^1	')" "$(printf '%s\n' "$out" | grep -c '^0	')"
}
# THE CAP VALUE IS PINNED FIRST. Every assertion below derives its expectation
# from `$GATE_MARK_MAXSEG`, so with the cap set to 3 they all still passed --
# the bound was fenced in shape and not in size, and a bound small enough to
# fire on ordinary commands is a disabled feature wearing a passing test.
if [ "$GATE_MARK_MAXSEG" = 200 ]; then
  pass=$((pass + 1)); printf 'OK   marking bound: the cap is 200\n'
else
  fail=$((fail + 1)); printf 'FAIL marking bound: cap is %s, expected 200\n' "$GATE_MARK_MAXSEG"
  fail_log="${fail_log}FAIL marking bound: GATE_MARK_MAXSEG is $GATE_MARK_MAXSEG; the cases below derive their expectations from it, so they cannot see the value change\n"
fi
if [ "$(mark_n "$GATE_MARK_MAXSEG")" = "0 $GATE_MARK_MAXSEG" ]; then
  pass=$((pass + 1)); printf 'OK   marking bound: AT the cap every plain segment is still marked precisely\n'
else
  fail=$((fail + 1)); printf 'FAIL marking bound: at the cap, got [%s]\n' "$(mark_n "$GATE_MARK_MAXSEG")"
  fail_log="${fail_log}FAIL marking bound: at the cap the precise path must still run; got [$(mark_n "$GATE_MARK_MAXSEG")]\n"
fi
_over=$((GATE_MARK_MAXSEG + 1))
if [ "$(mark_n "$_over")" = "$_over 0" ]; then
  pass=$((pass + 1)); printf 'OK   marking bound: ONE past the cap every segment is marked conservatively\n'
else
  fail=$((fail + 1)); printf 'FAIL marking bound: one past the cap, got [%s]\n' "$(mark_n "$_over")"
  fail_log="${fail_log}FAIL marking bound: past the cap every segment must be marked 1 (no cd honoured); got [$(mark_n "$_over")]\n"
fi
mark_lat_cmd=""
for _i in $(seq 1 2000); do mark_lat_cmd="$mark_lat_cmd ( cd /tmp$_i ) ;"; done
mark_lat_start=$(date +%s)
gate_segments_marked "$mark_lat_cmd" > /dev/null
mark_lat_secs=$(( $(date +%s) - mark_lat_start ))
# BUDGET 8s, NOT 4s, and the number is chosen from the thing that matters: the
# PreToolUse timeout is 10s and a killed hook cannot emit exit 2. At 4s this
# case went RED twice in five runs while other agents were busy on the same
# machine -- a stable 2s standalone -- and a fence that fails on load is a
# fence people learn to ignore. `date +%s` also has whole-second granularity,
# so a 2s measurement carries +/-1s of quantisation before any contention.
if [ "$mark_lat_secs" -le 8 ]; then
  pass=$((pass + 1))
  printf 'OK   latency: 2000 subshell segments through gate_segments_marked in %ss (budget 8s)\n' "$mark_lat_secs"
else
  fail=$((fail + 1))
  printf 'FAIL latency: 2000 subshell segments took %ss, budget 8s\n' "$mark_lat_secs"
  fail_log="${fail_log}FAIL latency: gate_segments_marked took ${mark_lat_secs}s on 2000 segments -- this measured 11s before the bound, past the 10s PreToolUse timeout\n"
fi

# --- gate_strip_prefix: ENGINE PARITY, not spelling -------------------------
#
# These are the only DIRECT cases this function has, and they exist because it
# had none when a defect in it reached CI. `gate_strip_prefix` decides the
# command word for every gate that resolves one, and the three patterns it uses
# to strip leaders were written with escapes inside bracket expressions. A
# backslash there is an ordinary MEMBER under POSIX, and the two bash engines
# read the result differently, so the SAME command produced different verdicts
# under 3.2 and 5.x -- silently, and always in the fail-open direction.
#
# Why HERE rather than in a gate's suite: this file sources the library
# IN-PROCESS, so `run-tests.sh`'s `/bin/bash` pass runs the code under 3.2 with
# no `HOOK_BASH` plumbing at all. That makes these the cheapest possible fence
# for the class, and the one a future change to this function will trip first.
#
# Each case pins the resolved verb, which is what a gate actually consumes.
# Reverting any of the three patterns to its inline escaped form reddens this
# block under one engine and leaves it green under the other -- which is the
# signature of the bug, and the reason a single-engine run cannot be trusted
# here.
strip_is() { # name, expected result, input
  local name="$1" want="$2" in_="$3" got
  got="$(gate_strip_prefix "$in_")"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$name"
  else
    fail=$((fail + 1)); printf 'FAIL %s (want [%s], got [%s])\n' "$name" "$want" "$got"
    fail_log+="FAIL $name\n  input: $in_\n  want:  $want\n  got:   $got\n"
  fi
}

# A command word bash does NOT read as `cd`: `\\cd` is `\cd` after one round of
# quote removal, which is not the builtin. Measured under both engines: the
# shell stays put. With the escaped bracket class, 3.2 stripped the backslash
# and handed the gates a `cd` that never ran.
strip_is 'a doubled backslash is not stripped off the verb' '\\cd /tmp' '\\cd /tmp'
# NOT A FENCE, and labelled so rather than deleted. None of the three patterns
# looks inside a word, so this passes under an identity function and under
# every revert probed -- it pins today's behaviour for a shape a future
# mid-word rule would change, and claims nothing about the current one. The
# discriminating twin is the LEADING-backslash case above it.
strip_is 'a doubled backslash mid-word survives too (pin, not a fence)' 'c\\d /tmp' 'c\\d /tmp'
# A single backslash IS quote removal, and bash does run this as cd.
strip_is 'a single backslash before the verb is bash quoting' '\cd /tmp' '\cd /tmp'

# Case-arm labels. The escaped form of this class made 5.x strip the label and
# 3.2 leave it, so the verb behind it was invisible to every gate under 3.2.
strip_is 'a plain case-arm label is stripped' 'pkill -f node' 'x) pkill -f node'
strip_is 'a label containing an escaped paren is stripped' 'pkill -f node' 'x\) pkill -f node'
strip_is 'a label that is only an escaped glob char is stripped' 'git commit -m z' '\?) git commit -m z'
strip_is 'a case opener plus its first arm is stripped' 'pkill -f node' 'case y in x) pkill -f node'

# Grouping punctuation. Same class, the two loops at the end of the function.
strip_is 'a leading subshell paren is stripped' 'cd /tmp' '( cd /tmp'
strip_is 'a leading brace group is stripped' 'cd /tmp' '{ cd /tmp'
strip_is 'nested openers are stripped to stability' 'cd /tmp' '( { ( cd /tmp'
strip_is 'a trailing closer is stripped' 'cd /tmp' 'cd /tmp )'
strip_is 'a trailing brace is stripped' 'cd /tmp' 'cd /tmp }'
# The negative controls: nothing here is a leader, so nothing may be removed.
# Without these the block would pass just as well if the function returned its
# input unchanged, which is exactly one of the two failure directions.
strip_is 'an ordinary command is returned verbatim' 'cd /tmp' 'cd /tmp'
strip_is 'a paren inside the argument is not a leader' 'echo a(b' 'echo a(b'
strip_is 'a bare closer with no label is not an arm' ') cmd' ') cmd'
# The CLOSE pattern's own discriminator. A trailing backslash is a line
# continuation, not grouping punctuation -- but the escaped form `[\)\}]`
# has a BACKSLASH as a set member, so it strips one. Both engines agree on
# that, which is why this case is here and not in the parity block above:
# without it, reverting the close pattern alone leaves this file green.
strip_is 'a trailing backslash is not grouping punctuation' 'echo hi\\' 'echo hi\\'

# --- gate_segments_marked: RECURSION DEPTH IS A BOUND, and its absence was a
# --- denial of service on every gate at once ---------------------------------
#
# `bash -c "<list>"` recurses, and every level used to restart with a fresh
# `GATE_MARK_MAXSEG` budget while contributing exactly ONE segment to its
# parent. So `GATE_MARK_MAXSEG` counted 1 however deep the nesting went, and
# `GATE_EDIT_MAXBYTES` (4096, applied by the hook to the whole command) buys
# hundreds of levels. Cost is quadratic in length: measured through the real
# hook, `sh -c ` repeated 300 / 500 / 680 times -- 1807 / 3007 / 4087 bytes,
# all UNDER the byte cap -- cost 5.7 s, 12.7 s and 24.1 s, against 0.04 s flat
# on origin/main.
#
# That is not a slow test, it is a gate bypass: the PreToolUse timeout is 10 s,
# a KILLED hook cannot emit exit 2, and every gate sourcing this library goes
# quiet together. `GATE_MARK_MAXDEPTH` (default 4) bounds it; past the limit the
# body is marked 1 without descending, which is the same conservative reading a
# scanned body gets, since `bash -c` runs a child that cannot move this shell.
#
# The budget is deliberately far under the 10 s timeout AND far over the
# measured cost, so this fails on a return of the quadratic and not on a slow
# machine.
__deep=$(awk 'BEGIN{ s=""; for (i=0;i<680;i++) s = s "sh -c "; print s "cd /tmp" }')
__t0=$(date +%s)
gate_segments_marked "$__deep" >/dev/null 2>&1
__t1=$(date +%s)
__deep_secs=$((__t1 - __t0))
if [ "$__deep_secs" -le 5 ]; then
  pass=$((pass + 1))
  printf 'OK   latency: 680 nested `sh -c` levels (4087 B) in %ss (budget 5s)\n' "$__deep_secs"
else
  fail=$((fail + 1))
  printf 'FAIL latency: 680 nested `sh -c` levels took %ss, budget 5s\n' "$__deep_secs"
  fail_log="${fail_log}FAIL latency: gate_segments_marked took ${__deep_secs}s on 680 nested levels -- this measured 24s before GATE_MARK_MAXDEPTH, past the 10s PreToolUse timeout, which disarms every gate sourcing this library\n"
fi

# The bound must not change the ANSWER for ordinary nesting, only refuse to keep
# descending past the limit. One level in, the body's `cd` is still reported
# subshell-derived -- which it is, because `bash -c` runs a child.
__one=$(gate_segments_marked 'bash -c "cd /tmp" ; echo hi > f' | head -1)
if [ "$__one" = "$(printf '1\tcd /tmp')" ]; then
  pass=$((pass + 1)); printf 'OK   a single bash -c level still marks its body subshell-derived\n'
else
  fail=$((fail + 1)); printf 'FAIL a single bash -c level: got [%s]\n' "$__one"
  fail_log="${fail_log}FAIL single bash -c level marking\n  got: $__one\n"
fi

# --- a verb INSIDE a multi-line substitution whose comment holds an apostrophe -
#
# Real bash RUNS this `git commit` -- verified with a stub `git` on PATH, not
# reasoned about. An in-body `ignore_q` retry in `drain_extra` made the matcher
# answer NO MATCH for both spellings while `origin/main` answered MATCH, so
# `branch-gate` went rc 2 -> 0 and a commit to `main` was ungated. The retry is
# gone; these pin both spellings so it cannot come back, and the single-line
# form is the control that was never broken.
#
# Built with `printf` rather than written inline: the apostrophe is the whole
# subject of the case, and this file is read by people who will copy the shape.
__ap_multi=$(printf 'x=$(\ngit commit -m y # don%st\n)\n' "'")
__ap_btick=$(printf 'x=`\ngit commit -m y # don%st\n`\n' "'")
__ap_one=$(printf 'x=$(git commit -m y # don%st)\n' "'")
check 'a verb inside a multi-line $( ) whose comment holds an apostrophe' 0 \
  "$GATE_RE_GIT_COMMIT" "$__ap_multi"
check 'the same, backtick spelling' 0 \
  "$GATE_RE_GIT_COMMIT" "$__ap_btick"
check 'the single-line control, which was never broken' 0 \
  "$GATE_RE_GIT_COMMIT" "$__ap_one"

# --- go-to-k/cdkd#2710: a `#` comment inside a multi-line $( ) whose
# --- apostrophe used to swallow the closer -------------------------------
#
# Bash does NOT read quotes inside a `#` comment, so the apostrophe is an
# ordinary character and real git RUNS this commit. `close_paren` opened a
# span on it, the span never closed, the real `)` was swallowed, and the verb
# AFTER the substitution was never reached -- `no match` on origin/main.
# Fixed here; the issue is closed by this PR rather than carried as a residual.
__i2710=$(printf 'git -c user.email=t@t -c user.name=t -C $(\n# it%ss fine\necho .\n) commit -m y\n' "'")
check 'go-to-k/cdkd#2710: apostrophe in a comment inside a multi-line $( )' 0 \
  "$GATE_RE_GIT_COMMIT" "$__i2710"

# --- the two paren-count spellings must agree ACROSS the threshold -----------
#
# `gate_segments_marked` counts a segment's parens with an in-shell deletion
# below `GATE_MARK_MAXINLINE` and with one `awk` fork above it, because the
# deletion is O(n^2) on bash 3.2 -- the only bash CI runs. Two spellings of one
# predicate is exactly the shape that goes wrong silently, so the equality is
# asserted here, straddling the threshold, under whichever engine runs this
# file. Without it, a segment could be judged nested on one side of 1024 bytes
# and top-level on the other.
__pc_fail=0
for __n in 100 1000 1024 1028 2000 4000; do
  __s=$(awk -v n="$__n" 'BEGIN{x="";for(i=0;i<n/4;i++)x=x "(a) ";print x}')
  __a="${__s//[^(]}"
  __inline=${#__a}
  __fork=$(printf '%s' "$__s" | awk '{n+=gsub(/\(/,"")} END{print n+0}')
  [ "$__inline" = "$__fork" ] || __pc_fail=1
done
if [ "$__pc_fail" = 0 ]; then
  pass=$((pass + 1)); printf 'OK   paren count: inline and awk agree across GATE_MARK_MAXINLINE\n'
else
  fail=$((fail + 1)); printf 'FAIL paren count: inline and awk disagree across GATE_MARK_MAXINLINE\n'
  fail_log="${fail_log}FAIL paren count parity across the inline/fork threshold\n"
fi

# THE FLOOR IS A COLLAPSE DETECTOR, NOT THE CASE COUNT -- and it is set BELOW
# what any context currently reports, on purpose.
#
# It used to be calibrated to the number a particular invocation printed, and
# that was measured wrong twice: 605 (the standalone count) reddened CI, and so
# did 557, which came from this file's own failure message printing one MORE
# than the number it compared. Both failures were about the floor, not about
# coverage. The message is corrected below.
#
# Measured 2026-09-07 in three contexts under bash 5.3 AND 3.2 -- standalone
# from this directory, from the repo root, and the exact
# `HOOK_BASH=<shell> <shell> <suite>` form with the repo-root cwd that
# `run-tests.sh` invokes (read it there; it is one line) -- and all three
# report the same count. That is a statement about those three runs and NOT a
# refutation of the historical 605/556 split, which nothing here reproduced:
# `run-tests.sh` itself prints only `ok` / `FAIL` per suite, never the tally,
# so its context cannot be observed any other way than by replaying its
# invocation, which is what was done.
#
# The floor is left well under the observed number rather than pinned to it.
# Pinning turns every added case into an edit here and every environment
# difference into a red suite for a reason that has nothing to do with what
# this file tests -- which is exactly how it was got wrong twice.
#
# So it does not move when cases are ADDED, either. A round that added sixteen
# raised it by sixteen and had to be talked back down: that is the pinning
# behaviour this paragraph argues against, wearing the other sign. The value
# changes only when the SHAPE of the suite does -- a whole block deleted, or the
# skipping-fixture condition changing -- and never as bookkeeping for new cases.
CASE_FLOOR=556
__ran=$((pass + fail))
if [ "$__ran" -lt "$CASE_FLOOR" ]; then
  # THE COUNT IS CAPTURED BEFORE `fail` IS INCREMENTED. Interpolating
  # `pass + fail` after the increment reported one MORE case than the predicate
  # compared, so the message read `only 557 ... expected at least 557` -- a
  # failure that looks like an equality bug in the check. Someone reading it
  # raises the floor to the number shown, the suite reds again for the same
  # reason, and the real count is never learned. Measured; it cost a full
  # suite run.
  fail=$((fail + 1))
  fail_log+="FAIL case floor: only $__ran cases ran, expected at least $CASE_FLOOR\n"
  printf 'FAIL case floor: only %s cases ran, expected at least %s\n' "$__ran" "$CASE_FLOOR"
fi
echo
# --- gate_utf8_lenient: the RFC 3629 well-formedness table -------------------
#
# This decoder decides what text the English-only class test SEES, so an
# over-permissive row is a bypass (a surrogate- or overlong-encoded sequence
# decoded into a character the class then reads as ordinary text) and an
# under-permissive one is a false block. It is asserted here rather than
# through a gate because a gate can only show the VERDICT, and every row below
# collapses to the same verdict.
#
# Two spellings were measured and rejected before this one, both LOSING the
# evidence: `utf8::decode` refuses the whole string on a single malformed byte,
# and `Encode::decode` swallows the bytes FOLLOWING a bad lead byte as one
# malformed run -- `\xff\xe6\x97\xa5` came back as a single U+FFFD with the
# Japanese character gone.
cp_of() { # <perl byte-string expression> -> "U+XXXX U+XXXX ..."
  perl -0777 -e "$GATE_PERL_WORD"'
    my $b = eval $ARGV[0];
    print join(" ", map { sprintf("U+%04X", ord($_)) } split //, gate_utf8_lenient($b));
  ' "$1" 2>/dev/null
}
utf8_case() { # <name> <perl expr> <expected code points>
  local name="$1" expr="$2" want="$3" got
  got=$(cp_of "$expr")
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   utf8: %s\n' "$name"
  else
    fail=$((fail + 1)); printf 'FAIL utf8: %s (want "%s", got "%s")\n' "$name" "$want" "$got"
    fail_log+="FAIL utf8: $name\n  want: $want\n  got : $got\n"
  fi
}
F=U+FFFD
utf8_case 'ascii'                   '"AB"'                 'U+0041 U+0042'
utf8_case 'NUL survives'            '"\x00"'               'U+0000'
utf8_case 'valid 2-byte'            '"\xc3\xa9"'           'U+00E9'
utf8_case 'valid 3-byte CJK'        '"\xe6\x97\xa5"'       'U+65E5'
utf8_case 'valid 4-byte'            '"\xf0\x9f\x98\x80"'   'U+1F600'
utf8_case 'max valid code point'    '"\xf4\x8f\xbf\xbf"'   'U+10FFFF'
utf8_case 'above U+10FFFF refused'  '"\xf4\x90\x80\x80"'   "$F $F $F $F"
utf8_case 'F5 lead refused'         '"\xf5\x80\x80\x80"'   "$F $F $F $F"
utf8_case 'FE/FF refused'           '"\xfe\xff"'           "$F $F"
utf8_case 'overlong 2-byte refused' '"\xc0\x80"'           "$F $F"
utf8_case 'C1 lead refused'         '"\xc1\xbf"'           "$F $F"
utf8_case 'overlong 3-byte refused' '"\xe0\x80\x80"'       "$F $F $F"
utf8_case 'overlong 4-byte refused' '"\xf0\x80\x80\x80"'   "$F $F $F $F"
utf8_case 'surrogate refused'       '"\xed\xa0\x80"'       "$F $F $F"
utf8_case 'lone continuation'       '"\x80"'               "$F"
utf8_case 'truncated 3-byte'        '"\xe6\x97"'           "$F $F"
utf8_case 'truncated at EOS'        '"\xe6"'               "$F"
# The two orderings that motivated the decoder: a valid character must survive
# a stray byte on EITHER side. One U+FFFD per un-decodable byte, so the count
# discriminates the per-RUN spelling that swallowed three bytes after the bad one.
utf8_case 'stray byte BEFORE a character' '"\xff\xe6\x97\xa5"' "$F U+65E5"
utf8_case 'stray byte AFTER a character'  '"\xe6\x97\xa5\xff"' "U+65E5 $F"

# --- the `$GW` value class, on the shapes that MOTIVATED it -----------------
#
# `command-match.sh`'s prelude records three MEASURED fail-open holes the old
# value class `(["']?)([^"'\s]+)\1` had, and the two below were exercised ONLY
# by `issue-deferral-criteria-gate`'s suite. go-to-k/cdkd#2717 deleted that gate,
# so deleting its suite took the only regression coverage for a documented
# fail-open with it -- the surviving consumer, `pr-body-item-number-gate`,
# extracts neither shape (its own header records bare `-F` as a deliberate
# non-goal).
#
# So they are asserted HERE, against the constant, which outlives any one gate.
# Through a gate they could only show a VERDICT; here they show what was
# EXTRACTED, which is the thing the holes were about -- the old class extracted
# nothing and the gate then judged an empty body.
# The pattern arrives through the ENVIRONMENT, not spliced into the perl source.
# Splicing it needs the shell to survive two quoting layers around a regex that
# contains both quote characters; the first attempt did that and every case
# extracted the empty string -- which is exactly what the HOLE these cases pin
# looks like, so the harness would have been indistinguishable from the defect.
gw_extract() { # <perl pattern, `GW` naming the class> <command text>
  GW_PAT="$1" perl -0777 -ne "$GATE_PERL_WORD"'
    my $re = $ENV{GW_PAT};
    $re =~ s/\bGW\b/$GW/g;
    while (/$re/g) { print gate_unq($1), "\n"; }
  ' <<GW_EOF
$2
GW_EOF
}
gw_case() { # <name> <pattern> <command> <expected first extraction>
  local name="$1" pat="$2" cmd="$3" want="$4" got
  got=$(gw_extract "$pat" "$cmd" | head -1)
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   $GW: %s\n' "$name"
  else
    fail=$((fail + 1)); printf 'FAIL $GW: %s (want "%s", got "%s")\n' "$name" "$want" "$got"
    fail_log+="FAIL \$GW: $name\n  want: $want\n  got : $got\n"
  fi
}
# gh's OWN documented spelling puts the quote INSIDE the value, after `body=`.
# The old class fell through to `\S+` and captured `body='a`.
gw_case 'quote INSIDE the value, after body=' \
  '-f[=\s]+body=(GW)' \
  "gh api repos/o/r/issues -f body='next: not this session'" \
  'next: not this session'
# A quoted path containing a SPACE: the bare class cannot span the space, and
# with the optional quote group unset it cannot start on the quote either, so
# NOTHING was extracted.
gw_case 'quoted path with a SPACE' \
  '--body-file[=\s]+(GW)' \
  'gh issue create --body-file "/tmp/dir with space/b.md"' \
  '/tmp/dir with space/b.md'
# Bare `-F <path>` (gh's short --body-file). Not extracted by any surviving
# gate, deliberately -- but the CLASS must still span it, or the next consumer
# that scopes to the gh segment inherits the hole.
gw_case 'bare -F <path>' \
  '-F[=\s]+(GW)' \
  'gh issue create -F /tmp/body.md' \
  '/tmp/body.md'

# --- the SPLIT_CHARS fast path must equal the substr fallback ---------------
#
# `substr(s, k, 1)` is O(n) per call in the awk macOS ships, so every
# per-character loop in the matcher was quadratic: measured through
# `gh-body-english-gate`, a 200k-escape command took 208.74 s on the previous
# code and 9.57 s now, against a 10 s PreToolUse timeout that a gate experiences
# as a SILENT PASS. The loops now index a `split(s, arr, "")` array instead.
#
# POSIX leaves an EMPTY field separator UNDEFINED, so the array is used only
# where a BEGIN probe measures that it splits into characters, and every loop
# keeps the `substr` arm. That makes two code paths where there was one, and
# this asserts they agree: for each input the two segmentations must be
# BYTE-IDENTICAL. Without it a CI awk taking the fallback would be running an
# untested matcher.
split_parity() { # <name> <command>
  local name="$1" cmd="$2" fast slow fast_s slow_s lib fallback
  lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/command-match.sh"
  fallback="$(mktemp)"
  # Force the probe OFF. The anchor is asserted so a drifted probe fails here
  # rather than silently comparing the fast path against itself.
  if ! grep -q 'if (split("ab", __probe, "") == 2' "$lib"; then
    fail=$((fail + 1)); printf 'FAIL split parity: probe anchor drifted\n'
    fail_log+="FAIL split parity: probe anchor drifted\n"
    rm -f "$fallback"; return
  fi
  sed 's|if (split("ab", __probe, "") == 2.*|SPLIT_CHARS = 0|' "$lib" > "$fallback"
  # BOTH awk programs, not just the segmenter. `strip_noncommand_spans` carries
  # its own copy of the `split(s, arr, "")` fast path, and the library never
  # calls it, so this fence -- whose stated job is that a CI awk taking the
  # fallback is not running an untested matcher -- reached only half the code
  # it names. Compared through `od` so a difference in whitespace or a NUL
  # cannot read as equal.
  fast=$(gate_segments "$cmd" | od -An -c | tr -s ' ')
  slow=$(bash -c '. "$1"; gate_segments "$2"' _ "$fallback" "$cmd" | od -An -c | tr -s ' ')
  fast_s=$(strip_noncommand_spans "$cmd" | od -An -c | tr -s ' ')
  slow_s=$(bash -c '. "$1"; strip_noncommand_spans "$2"' _ "$fallback" "$cmd" | od -An -c | tr -s ' ')
  rm -f "$fallback"
  if [ "$fast" != "$slow" ]; then
    fail=$((fail + 1)); printf 'FAIL split parity (segments): %s\n' "$name"
    fail_log+="FAIL split parity (segments): $name\n  command: $cmd\n"
    return
  fi
  if [ "$fast_s" != "$slow_s" ]; then
    fail=$((fail + 1)); printf 'FAIL split parity (strip): %s\n' "$name"
    fail_log+="FAIL split parity (strip): $name\n  command: $cmd\n"
    return
  fi
  # Both comparisons returned above on failure, so reaching here IS the pass.
  pass=$((pass + 1)); printf 'OK   split parity: %s\n' "$name"
}
split_parity 'plain command'          'git -C /a/b commit -m x'
split_parity 'quoted span with a space' 'gh issue create --body "a b c"'
split_parity 'apostrophe in a body'   "gh issue create --body \"don't merge\""
split_parity 'command substitution'   'git -C $(git rev-parse --show-toplevel) commit -m x'
split_parity 'backtick substitution'  'git -C `pwd` commit -m x'
split_parity 'separators'             'ls && git commit -m a; echo done | cat'
split_parity 'escaped separator'      'echo a\; git commit -m x'
split_parity 'heredoc body'           "$(printf 'cat > f <<EOF\nbody ; text\nEOF\ngh issue create --body-file f')"
split_parity 'unbalanced apostrophe'  "echo don't; git commit -m y"
split_parity 'process substitution'   'diff <(git commit) /dev/null'
split_parity 'ANSI-C span'            "gh issue create --body \$'a\\x20b'"

# --- gate_perl_word_ok must reject a STALE prelude ---------------------------
#
# The guard exists to catch a library that is present but does not WORK, and the
# case it is most likely to meet is a SIBLING REPO one revision behind -- this
# prelude is copied between three repos on purpose. A four-dimension probe was
# measured certifying exactly that: the pre-`ebf5ac39` prelude (no mid-word
# ANSI-C arm, `gate_unq` decoding instead of returning bytes) passed every
# assertion, because all four inputs were pure ASCII at word position 0.
#
# Each case deletes ONE dimension from the REAL prelude and requires a
# rejection. A dimension whose deletion still passes is one the probe does not
# actually certify. Driven from a single python block rather than per-case shell
# arguments: the mutations are regex literals full of quotes and backslashes,
# and threading them through shell quoting broke the file twice.
__pr_out=$(python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/testdata/probe-rejects.py" \
             "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/command-match.sh" 2>&1)
__pr_rc=$?
printf '%s\n' "$__pr_out"
__pr_ok=$(printf '%s\n' "$__pr_out" | grep -c '^OK   probe-rejects:')
__pr_bad=$(printf '%s\n' "$__pr_out" | grep -c '^FAIL probe-rejects:')
# The COUNT is asserted, not just the failures: a script that dies early prints
# nothing and would otherwise read as six silent passes.
if [ "$__pr_rc" != 0 ] || [ "$__pr_ok" -ne 7 ] || [ "$__pr_bad" -ne 0 ]; then
  fail=$((fail + 1))
  printf 'FAIL probe-rejects: expected 7 OK / 0 FAIL, got %s / %s (rc=%s)\n' "$__pr_ok" "$__pr_bad" "$__pr_rc"
  fail_log+="FAIL probe-rejects: expected 7 OK / 0 FAIL, got $__pr_ok / $__pr_bad\n"
else
  pass=$((pass + __pr_ok))
fi

# --- a mis-closed substitution span must not HIDE the verb inside it ---------
#
# `close_paren` / the backtick scan decide where a `$( )` or `` ` ` `` span ends.
# An EARLY closer is worse than none: `return 0` falls back to the stack, which
# is benign, but a wrong index truncates the body and resumes with the enclosing
# quote still open, so the REST of the real body is parsed as quoted prose and
# the verb inside it never starts a segment.
#
# All three shapes below were UNGATED before the helpers learned about quotes
# and backslashes, and all twelve hook suites stayed green throughout -- nothing
# pinned a MIS-closed span, only balanced ones. Unbalanced parens inside quotes
# are ordinary: grep counting a paren, sed substituting one, awk -F with one.
check 'a paren inside a quoted string in the body does not end the span' 0 \
  "$COMMIT" "$(printf 'echo "$(echo %s)%s ; git commit -m x)"' "'" "'")"
check 'a backslash-escaped paren does not end the span' 0 \
  "$COMMIT" 'echo "$(echo \) ; git commit -m x)"'
check 'a backslash-escaped backtick does not end the span' 0 \
  "$COMMIT" 'echo "`echo \` ; git commit -m x`"'
# An ANSI-C span is the OPPOSITE of a plain single-quoted one: inside `$'...'`
# a backslash ESCAPES, so `\'` does NOT close it. Teaching close_paren that a
# backslash is literal inside single quotes -- right for `'...'` -- opened this
# one, and it is the rule the `$GW` prelude in the same library already states.
# Measured on this shape: origin/main gated it, the fix for the plain case left
# it OPEN, and the ANSI-C state closes it again.
check 'an escaped quote inside an ANSI-C span does not end it' 0 \
  "$COMMIT" "$(printf 'echo "$(printf $%sa\\%sb%s ; git commit -m x)"' "'" "'" "'")"
# An ANSI-C span is the OPPOSITE of a plain single-quoted one: inside it a
# backslash ESCAPES, so a backslash-quote does NOT close it. The sigil has to be
# found by scanning FORWARD from the dollar, because a one-character look-back
# cannot tell a real sigil from an ESCAPED dollar or from the second half of
# `$$`. Measured across the three revisions: before the ANSI-C state the first
# case below was OPEN; the look-back spelling closed it and opened the other
# two; the forward scan gates all three.
check 'an ESCAPED dollar before plain quotes is not an ANSI-C span' 0 \
  "$COMMIT" "$(printf 'echo "$(printf \\$%sa\\%s ; git commit -m x)"' "'" "'")"
check 'the second dollar of $$ before plain quotes is not one either' 0 \
  "$COMMIT" "$(printf 'echo "$(printf $$%sa\\%s ; git commit -m x)"' "'" "'")"
# The SIBLING quote machine, `flush_line`, needed the same ANSI-C state: it
# opened a PLAIN span on the quote, the escaped quote inside closed it early,
# and a SECOND substitution then split the line in the wrong place. One machine
# being right is what let this survive the round that fixed the other -- and it
# was open on origin/main too, for both the commit verb and the `git checkout`
# data-loss gate.
check 'an ANSI-C span before a second substitution does not split it' 0 \
  "$COMMIT" "$(printf 'echo "$(printf %%s $%sa\\%sb%s $(echo a) ; git commit -m x)"' "'" "'" "'")"
check 'the same body does not hide a git checkout either' 0 \
  "$GATE_RE_GIT_CHECKOUT" "$(printf 'echo "$(printf %%s $%sa\\%sb%s $(echo a) ; git checkout -- src/x.ts)"' "'" "'" "'")"
# `$$` is the PID, and what follows it is a PLAIN span where the escaped quote
# CLOSES. `close_paren` steps over the second dollar; the ANSI-C arm added to
# `flush_line` did not, so it opened a span that never closed and the rest of
# the line -- separators included -- became data. Both shapes RUN under real
# bash, and both walked past their gate: rc=2 -> 0 for the commit verb, and the
# checkout gate never looked at all.
check 'a $$ before plain quotes does not open an ANSI-C span (commit)' 0 \
  "$COMMIT" "$(printf 'echo $(echo a)$$%s\\%s ; git commit -m x' "'" "'")"
check 'a $$ before plain quotes does not open one for checkout either' 0 \
  "$GATE_RE_GIT_CHECKOUT" "$(printf 'echo $(echo a)$$%s\\%s ; git checkout -- src/x.ts' "'" "'")"
# The control: a balanced span must still be seen, or the three above would be
# satisfied by a matcher that simply matches everything.
check 'a balanced substitution body is still seen' 0 \
  "$COMMIT" 'echo "$(git commit -m x)"'
# And the negative twin: no verb in the body means no match, so the cases above
# are not passing because the whole command matches regardless.
check 'a mis-closed span with NO verb in it does not match' 1 \
  "$COMMIT" "$(printf 'echo "$(echo %s)%s ; echo done)"' "'" "'")"

# --- gate_missing_const: the shape guard's own cases -----------------------
#
# This helper had no cases at all until review round 18 pointed out that its
# two bugfixes -- the name-shape rejection and the whitespace-only label --
# were unasserted, in the PR whose thesis is that unasserted text is how a
# defect survives revisions. It is not driven through a hook here because the
# question is the helper's own answer, not any gate's exit code.
# THE CALL RUNS IN A SUBSHELL WITH A COMPLETION SENTINEL, and that is not
# defensive styling. A malformed name reaches `${!name}`, which bash treats as a
# FATAL error in a non-interactive shell: the frame dies, `|| true` never runs
# because there is no command left to run it, and NEITHER counter is
# incremented -- the case does not fail, it VANISHES. Measured on the first
# revision of this block: reverting the shape guard reported `Pass: 632 Fail: 1`
# where the file has ten cases here, eight of them silently gone, and deleting
# the one surviving case made the whole suite GREEN over a live regression.
# A test that cannot fail is worse than no test: it reads as coverage.
#
# So the subshell isolates the death, and the sentinel proves the call returned.
# No sentinel means the helper killed its shell, which is itself a failure --
# `gate_missing_const` runs at every hook load and must never do that.
__gmc() { # <expected GATE_MISSING_CONSTS> <desc> <name...>
  local want="$1" desc="$2"; shift 2
  local got
  got=$(GATE_MISSING_CONSTS=""; gate_missing_const "$@" >/dev/null 2>&1; printf '%s|RAN' "$GATE_MISSING_CONSTS")
  case "$got" in
    *'|RAN')
      got="${got%|RAN}"
      if [ "$got" = "$want" ]; then
        pass=$((pass + 1)); printf 'ok   %s\n' "$desc"
      else
        fail=$((fail + 1))
        fail_log="${fail_log}FAIL $desc: wanted [$want] got [$got]\n"
      fi
      ;;
    *)
      fail=$((fail + 1))
      fail_log="${fail_log}FAIL $desc: gate_missing_const KILLED its shell -- it runs at every hook load and must not\n"
      ;;
  esac
}
__gmc_ran=$((pass + fail))

# A name bash would not accept is REPORTED, not expanded. `${!n}` on a name
# carrying an array subscript EXECUTES it, and a quoted-together argument makes
# bash 5.x abort the loop so every later name goes unchecked -- measured, that
# turned a `branch-gate` refusal into rc=1, a PASS.
__gmc 'GATE_A GATE_B(not-a-variable-name)' 'a quoted-together pair is reported, not looked up' 'GATE_A GATE_B'
__gmc '9BAD(not-a-variable-name)' 'a name starting with a digit is reported' '9BAD'
# The label keeps the WHOLE offending name -- a truncated one would not tell the
# author which argument to fix.
__gmc 'GATE_A[$(exit 7)](not-a-variable-name)' 'a name carrying a subscript is reported verbatim, and nothing runs' 'GATE_A[$(exit 7)]'

# The malformed label may not swallow a name that follows it. The dedup keyed on
# a space-delimited list, and a label containing a space matched a later name
# inside itself; keying on newline moved the collision to newline-carrying
# names, so the label is flattened AND the delimiter is a newline.
__gmc 'GATE_A GATE_B(not-a-variable-name) GATE_A' 'a space-carrying label does not swallow a later name' 'GATE_A GATE_B' 'GATE_A'
__gmc 'GATE_A GATE_B(not-a-variable-name) GATE_A' 'a newline-carrying label does not swallow one either' "$(printf 'GATE_A\nGATE_B')" 'GATE_A'

# WHITESPACE-only, not space-only: flattening turns a newline into a space, so
# the `(empty)` fallback has to test the whole class or a tab- or CR-only name
# still reports as invisible whitespace.
__gmc '(empty)(not-a-variable-name)' 'an empty name reports as (empty)' ''
__gmc '(empty)(not-a-variable-name)' 'a newline-only name reports as (empty)' "$(printf '\n')"
__gmc '(empty)(not-a-variable-name)' 'a tab-only name reports as (empty)' "$(printf '\t')"
__gmc '(empty)(not-a-variable-name)' 'a space-only name reports as (empty)' ' '

# And the control: a well-formed name the library DOES define reports nothing,
# so the cases above are not passing because everything is reported.
__gmc '' 'a defined constant is not reported' 'GATE_FLAGS'

# THE FOUR CONTRACTS THE HELPER STATES AND NOTHING ASSERTED. Review round 22
# broke each in turn and the whole repo stayed green -- the same
# asserted-by-CONSTRUCTION shape this file has been closing all PR, one layer
# in. Each case below was verified by making the mutation it names.

# 1. The truncation guard. `[ -z "${GATE_LIB_BASE_CONSTS:-}" ]` -> `if false`
#    left 650/0: with the list empty the shipped code returns 1 naming
#    GATE_LIB_BASE_CONSTS, the mutant returns 0 reporting NOTHING -- the "base
#    half passes vacuously" its own comment names.
__gmc_saved_base="$GATE_LIB_BASE_CONSTS"
GATE_LIB_BASE_CONSTS=""
__gmc 'GATE_LIB_BASE_CONSTS' 'an empty base list is itself reported, not silently skipped' 'GATE_FLAGS'
GATE_LIB_BASE_CONSTS="$__gmc_saved_base"

# 2. NON-EMPTY rather than merely SET. `${!n:-}` -> `${!n+x}` left everything
#    green, and this PR's own `${BASE:-}` change is what produces the state:
#    with `GATE_FLAGS=` gone, `GATE_GH_C="${GATE_FLAGS:-}"` is set-but-EMPTY,
#    and an empty ERE matches everything -- the gate fires on every command
#    instead of refusing.
__gmc_probe_empty=""
__gmc '__gmc_probe_empty' 'a name that is SET but empty is reported, not accepted' '__gmc_probe_empty'

# 3. Plain duplicate. The two cases above exercise the label COLLISION; the
#    ordinary "same name twice" path was untested, and breaking the membership
#    test left it green.
__gmc 'GATE_NOPE' 'the same missing name twice is reported once' 'GATE_NOPE' 'GATE_NOPE'

# 4. `local LC_ALL=C`, the helper's only shell-divergence guard: the shape test
#    is a `case` glob and `[!A-Za-z0-9_]` is a RANGE, so what falls inside it is
#    locale-dependent -- under a UTF-8 locale bash 3.2.57 ACCEPTS an accented
#    name as an identifier while 5.3.9 rejects it.
#
#    THE CASE ESTABLISHES THE LOCALE, it does not inherit one, and that is the
#    correction review round 22 forced. The first version simply called the
#    helper: measured under the ambient `LANG=en_US.UTF-8` that `run-tests.sh`
#    and CI actually pass down, deleting the guard left the suite GREEN -- the
#    case reddened in 1 of 8 environment x shell cells and none that the runner
#    produces. Exporting `LC_ALL` for the call is what makes the guard
#    observable, because that is the variable it shadows.
#
#    The POSITIVE CONTROL is not optional: on a box with no UTF-8 locale the
#    export is inert and this case would pass for the wrong reason forever, the
#    `feedback_lint_must_prove_it_sees_input` shape. If none is available the
#    case FAILS and says so, rather than going quiet.
#
#    The name is built with `printf` rather than written as a literal so
#    `check-pr-non-english-text.ts` stays quiet.
__gmc_utf8=""
for __l in en_US.UTF-8 C.UTF-8 en_GB.UTF-8 UTF-8; do
  if [ "$(LC_ALL="$__l" locale charmap 2>/dev/null)" = "UTF-8" ]; then __gmc_utf8="$__l"; break; fi
done
if [ -z "$__gmc_utf8" ]; then
  # BOTH counters move: `fail` because the control could not discriminate, and
  # `pass` because the accented case below did not run and the block guard
  # counts cases, not verdicts. Without the second the guard ALSO fires
  # ("a case vanished"), which misdirects on the one box this control exists
  # for -- a C-only runner -- by blaming the harness for the environment.
  fail=$((fail + 1))
  pass=$((pass + 1))
  fail_log="${fail_log}FAIL no UTF-8 locale available, so the LC_ALL guard case cannot discriminate -- it would pass whether or not the guard exists\n"
else
  pass=$((pass + 1)); printf 'ok   a UTF-8 locale (%s) is available, so the next case can discriminate\n' "$__gmc_utf8"
  __gmc_accent="$(printf 'GATE_\303\251BAD')"
  LC_ALL="$__gmc_utf8" __gmc "$__gmc_accent(not-a-variable-name)" \
    'an accented name is rejected under a UTF-8 locale, on either shell' "$__gmc_accent"
fi

# A FLOOR ON THIS BLOCK ALONE, and the end marker is taken HERE, before the
# shape cases below. `CASE_FLOOR` is evaluated in the middle of the file,
# upstream of this block, so a block that shrinks below it is invisible -- which
# is exactly how eight vanished cases went unnoticed. The first revision of this
# floor took the end marker AFTER the shape loop, so it counted 12 against a
# `-lt 10` test and carried two cases of slack: measured, deleting TWO `__gmc`
# cases left it printing `ran all 10 cases` over a green suite. A floor that
# spans two populations is not a floor.
#
# `-ne`, not `-lt`, and that is the second half. A one-sided floor re-opens the
# same slack the moment the block GROWS: measured, adding an 11th case makes it
# print `ran all 11` green, and deleting an original then reports `ran all 10`
# green -- the identical failure arriving by the other direction. Equality
# forces whoever adds a case to bump the count with it, which is the only
# spelling that cannot drift.
__gmc_count=$((pass + fail - __gmc_ran))
if [ "$__gmc_count" -ne 15 ]; then
  fail=$((fail + 1))
  fail_log="${fail_log}FAIL gate_missing_const block ran $__gmc_count cases, expected exactly 15 -- a case vanished, or one was added without bumping the count\n"
else
  pass=$((pass + 1)); printf 'ok   gate_missing_const block ran all %s cases\n' "$__gmc_count"
fi
# =============================================================================
# gate_target_is_foreign (go-to-k/cdkd#3351)
# =============================================================================
#
# Extracted from verify-pr-gate.sh so integ-schema-migration-gate could reuse it
# rather than grow a second copy -- `.claude/rules/hooks.md` records that
# hand-copied gate parsers reintroduced one hole at 24 sites.
#
# THE FIRST CASE IS THE POINT OF FENCING IT HERE. "target IS this repo, so the
# strict path applies" is UNCONSTRUCTIBLE from either consuming gate's suite:
# both build throwaway `git init` fixtures, which are foreign by construction,
# and the real cdkd checkout always declares `integ-schema-migration`, so the
# schema gate can never reach a non-foreign `mode = none`. A green suite over
# there therefore says nothing about the arm that keeps cdkd itself gated.
__gtf_start=$((pass + fail))
# THIS FILE IS ONE LEVEL DEEPER THAN THE GATE SUITES. They live in
# `.claude/hooks/`, so their `dirname/../..` is the repo root; this one lives in
# `.claude/hooks/lib/`, where the same spelling lands on `.claude`. Copying it
# made BOTH paths unresolvable, `gate_git_common_dir` failed on each, and the
# fail-closed `return 1` satisfied the "NOT foreign" case for entirely the wrong
# reason -- it went green while measuring nothing. Only the `-> foreign` case
# reds on that, which is why the two are kept as a PAIR.
__gtf_hooks_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
__gtf_repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
__gtf_tmp="$(mktemp -d)"
git init -q "$__gtf_tmp/foreign" 2>/dev/null
# A remote from creation: since go-to-k/cdkd#3351 foreignness is decided on the
# repo SLUG, so a fixture with no remote is unidentifiable and correctly refuses.
git -C "$__gtf_tmp/foreign" remote add origin https://github.com/go-to-k/cdk-local.git 2>/dev/null

# Guard the fixture itself: if either path stops resolving to a git repo, every
# case below degrades into the vacuous pass described above.
if ! git -C "$__gtf_repo_dir" rev-parse --git-dir >/dev/null 2>&1 \
  || [ ! -d "$__gtf_hooks_dir" ]; then
  fail=$((fail + 1))
  fail_log="${fail_log}FAIL gate_target_is_foreign fixture: repo=$__gtf_repo_dir hooks=$__gtf_hooks_dir did not resolve -- the cases below would pass vacuously\n"
  printf 'FAIL gate_target_is_foreign fixture did not resolve\n'
fi

__gtf() { # name, want-rc, hook_dir, target_dir, command
  local name="$1" want="$2" got
  GH_REPO="" gate_target_is_foreign "$3" "$4" "$5" "$GATE_RE_GH_PR_MERGE"
  got=$?
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$name"
  else
    fail=$((fail + 1))
    fail_log="${fail_log}FAIL $name (want rc $want, got $got)\n"
    printf 'FAIL %s (want rc %s, got %s)\n' "$name" "$want" "$got"
  fi
}

__gtf "target IS this repo -> NOT foreign (the strict path is kept)" 1 \
  "$__gtf_hooks_dir" "$__gtf_repo_dir" "gh pr merge 1 --squash"
__gtf "a different repo -> foreign" 0 \
  "$__gtf_hooks_dir" "$__gtf_tmp/foreign" "gh pr merge 1 --squash"
# FAIL CLOSED: an identity that cannot be resolved is never foreign, so the
# caller keeps whatever it does for its own repo.
__gtf "target is not a git repo -> NOT foreign (fail closed)" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp" "gh pr merge 1 --squash"
__gtf "hook dir is not a git repo -> NOT foreign (fail closed)" 1 \
  "$__gtf_tmp" "$__gtf_tmp/foreign" "gh pr merge 1 --squash"

# THE HOOK-SIDE SLUG ARM, which the case above does NOT reach -- there
# `gate_git_common_dir` returns first, so the `gate_repo_slug` failure is never
# exercised. Measured: deleting that arm's `return 1` left THIS suite, the
# schema gate's and verify-pr-gate's all green while a hook checkout with no
# `origin` began classifying a real clone of this repo as foreign, which for
# `integ-schema-migration-gate` is `exit 0` on a genuine schema bump.
# A repo, so the common-dir comparison succeeds; no remote, so the slug does not.
git init -q "$__gtf_tmp/hooknoremote" 2>/dev/null
__gtf "hook repo with NO origin -> NOT foreign (fail closed)" 1 \
  "$__gtf_tmp/hooknoremote" "$__gtf_tmp/foreign" "gh pr merge 1 --squash"
# The ALLOWLIST half: a foreign target stops being foreign the moment the
# command can name some OTHER repo, because then the target directory no longer
# says which repo the merge lands on.
__gtf "foreign + --repo -> NOT foreign (the command names another repo)" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/foreign" "gh pr merge 1 --repo go-to-k/cdkd"
__gtf "foreign + clustered -R -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/foreign" "gh pr merge 1 -sdR go-to-k/cdkd"
__gtf "foreign + a PR URL selector -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/foreign" "gh pr merge https://github.com/go-to-k/cdkd/pull/1"
__gtf "foreign + an unreadable argument -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/foreign" 'gh pr merge "$N" --squash'

# --- The retract arms that red on NOTHING without these ----------------------
#
# Measured in go-to-k/cdkd#3351's review: deleting `-R*` from the case label, or
# the `GH_REPO` env test, or the `GH_REPO`-in-text test, or the `xargs` test,
# left this block GREEN. Each is covered by `verify-pr-gate.test.sh`, but the
# stated reason for extracting the predicate was that it be fenced ONCE, here --
# and an equality guard reading "exactly N cases" implies exactly that.
#
# BARE `-R` is its own case because the cluster pattern does not cover it:
# `-[!-]*R*` requires a character between the dash and the R, so `-R <slug>`
# and the glued `-Rgo-to-k/cdkd` are matched only by the `-R*` label.
__gtf "foreign + a BARE -R -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/foreign" "gh pr merge 1 -R go-to-k/cdkd"
__gtf "foreign + a GLUED -R<slug> -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/foreign" "gh pr merge 1 -Rgo-to-k/cdkd"
__gtf "foreign + GH_REPO in the command text -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/foreign" "GH_REPO=go-to-k/cdkd gh pr merge 1 --squash"
__gtf "foreign + an EARLIER-SEGMENT GH_REPO export -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/foreign" "export GH_REPO=go-to-k/cdkd; gh pr merge 1 --squash"
__gtf "foreign + arguments piped through xargs -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/foreign" "printf 1 | xargs gh pr merge --squash"

# `GH_REPO` in the ENVIRONMENT, which no command text can show. Set only around
# this one call so the rest of the block is unaffected.
if GH_REPO=go-to-k/cdkd gate_target_is_foreign \
     "$__gtf_hooks_dir" "$__gtf_tmp/foreign" "gh pr merge 1 --squash" "$GATE_RE_GH_PR_MERGE"; then
  fail=$((fail + 1))
  fail_log="${fail_log}FAIL GH_REPO in the environment must retract the relaxation\n"
  printf 'FAIL foreign + GH_REPO in the ENVIRONMENT -> should NOT be foreign\n'
else
  pass=$((pass + 1)); printf 'OK   foreign + GH_REPO in the ENVIRONMENT -> NOT foreign\n'
fi

# --- REPO identity, not DIRECTORY identity (go-to-k/cdkd#3351 review) --------
#
# `--git-common-dir` alone says "a different checkout", which is not "a
# different repository". Every case below was MEASURED relaxing before the slug
# conjunct landed, and each is a total bypass of any gate that exits 0 on this
# answer -- none of them carries a flag, an env var or a URL, so the allowlist
# cannot see any of them.
__gtf_slug="$(git -C "$__gtf_repo_dir" config --get remote.origin.url 2>/dev/null)"

# A SECOND CLONE of this very repo. Directory differs, repository does not.
git init -q "$__gtf_tmp/clone2" 2>/dev/null
git -C "$__gtf_tmp/clone2" remote add origin "$__gtf_slug" 2>/dev/null
__gtf "a second clone of THIS repo -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/clone2" "gh pr merge 1 --squash"

# The ordinary fork setup: gh prefers `upstream` over `origin`, so this checkout
# resolves THIS repo's pull requests while `origin` names the sibling.
git init -q "$__gtf_tmp/fork" 2>/dev/null
git -C "$__gtf_tmp/fork" remote add origin https://github.com/go-to-k/cdk-local.git 2>/dev/null
git -C "$__gtf_tmp/fork" remote add upstream "$__gtf_slug" 2>/dev/null
__gtf "a sibling with an upstream remote naming THIS repo -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/fork" "gh pr merge 1 --squash"

# Same remote, SSH spelling: the slug normaliser must see through the scheme,
# or the conjunct is one `git remote add` away from being bypassed again.
git init -q "$__gtf_tmp/ssh" 2>/dev/null
git -C "$__gtf_tmp/ssh" remote add origin https://github.com/go-to-k/cdk-local.git 2>/dev/null
git -C "$__gtf_tmp/ssh" remote add upstream git@github.com:go-to-k/cdkd.git 2>/dev/null
__gtf "an upstream remote in SSH spelling -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/ssh" "gh pr merge 1 --squash"

# --- The spellings gh resolves that a URL parser does not (round-2 blockers) --
#
# Each was MEASURED exiting 0 on the real v10-bump PR with no `-R`, no
# `GH_REPO` and no URL selector. They are cases rather than a widened parser
# because the parser is the thing that kept losing: what closes the class is the
# REFUSAL on a remote that does not read, and `unreadable` below is its fence.
__gtf_case_variant="$(printf '%s' "$__gtf_slug" | tr 'a-z' 'A-Z')"
git init -q "$__gtf_tmp/casevar" 2>/dev/null
git -C "$__gtf_tmp/casevar" remote add origin "$__gtf_case_variant" 2>/dev/null
__gtf "a CASE-variant spelling of THIS repo -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/casevar" "gh pr merge 1 --squash"

# `insteadOf` rewriting: git resolves the shortcut, so the gate asks git.
git init -q "$__gtf_tmp/insteadof" 2>/dev/null
git -C "$__gtf_tmp/insteadof" remote add origin "cdkd:cdkd" 2>/dev/null
git -C "$__gtf_tmp/insteadof" config "url.${__gtf_slug%.git}.insteadOf" "cdkd:cdkd" 2>/dev/null
__gtf "an insteadOf shortcut expanding to THIS repo -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/insteadof" "gh pr merge 1 --squash"

# `pushurl`: gh falls back to it, and `^remote\..*\.url$` cannot match it.
git init -q "$__gtf_tmp/pushurl" 2>/dev/null
git -C "$__gtf_tmp/pushurl" remote add origin "/srv/mirror/thing" 2>/dev/null
git -C "$__gtf_tmp/pushurl" config remote.origin.pushurl "$__gtf_slug" 2>/dev/null
__gtf "a pushurl naming THIS repo -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/pushurl" "gh pr merge 1 --squash"

# `gh repo set-default` writes `gh-resolved`, which gh prefers over every URL.
git init -q "$__gtf_tmp/ghresolved" 2>/dev/null
git -C "$__gtf_tmp/ghresolved" remote add origin https://github.com/go-to-k/cdk-local.git 2>/dev/null
git -C "$__gtf_tmp/ghresolved" config remote.origin.gh-resolved go-to-k/cdkd 2>/dev/null
__gtf "gh-resolved pointing at THIS repo -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/ghresolved" "gh pr merge 1 --squash"

# --- Round 3: the URL set gh reads is not the one a hook reconstructs --------
#
# Each measured relaxing the gate on the real v10-bump PR. They are why the
# enumeration now comes from `git remote -v` -- the source gh itself parses --
# rather than from a hand-built set.

# `set-url --add`: `ls-remote --get-url` prints only the FIRST url, so a
# browser-copied decoy in front hid the real one.
git init -q "$__gtf_tmp/addurl" 2>/dev/null
git -C "$__gtf_tmp/addurl" remote add origin "${__gtf_slug%.git}/tree/main" 2>/dev/null
git -C "$__gtf_tmp/addurl" remote set-url --add origin "$__gtf_slug" 2>/dev/null
__gtf "a SECOND url added to one remote -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/addurl" "gh pr merge 1 --squash"

# `pushInsteadOf` rewrites the PUSH url with no `pushurl` key to read.
git init -q "$__gtf_tmp/pushio" 2>/dev/null
git -C "$__gtf_tmp/pushio" remote add origin https://example.com/decoy/repo 2>/dev/null
git -C "$__gtf_tmp/pushio" config "url.${__gtf_slug}.pushInsteadOf" https://example.com/decoy/repo 2>/dev/null
__gtf "a pushInsteadOf rewrite naming THIS repo -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/pushio" "gh pr merge 1 --squash"

# gh parses the URL and DECODES the path; a percent-encoded owner is a working
# remote that a byte compare reads as a different repository.
git init -q "$__gtf_tmp/pctenc" 2>/dev/null
git -C "$__gtf_tmp/pctenc" remote add origin https://github.com/go%2Dto%2Dk/cdkd.git 2>/dev/null
__gtf "a PERCENT-ENCODED owner -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/pctenc" "gh pr merge 1 --squash"

# `gh-resolved` was the one comparison left unfolded.
git init -q "$__gtf_tmp/ghrescase" 2>/dev/null
git -C "$__gtf_tmp/ghrescase" remote add origin https://github.com/go-to-k/cdk-local.git 2>/dev/null
git -C "$__gtf_tmp/ghrescase" config remote.origin.gh-resolved Go-To-K/CDKD 2>/dev/null
# A `gh-resolved` carrying a HOST ALIAS. The hook slug is folded by
# `gate_slug_from_url` and a `gh-resolved` value never passes through it, so
# folding one side alone DESTROYS a match -- measured, this case answered
# NOT-foreign before the go-to-k/cdkd#3385 fold and FOREIGN with the fold applied
# to the hook side only. It is the same class as the MIXED-CASE case below:
# whatever normalises a slug must be applied to this comparison too.
git init -q "$__gtf_tmp/ghresalias" 2>/dev/null
git -C "$__gtf_tmp/ghresalias" remote add origin https://github.com/go-to-k/cdk-local.git 2>/dev/null
git -C "$__gtf_tmp/ghresalias" config remote.origin.gh-resolved ssh.github.com/go-to-k/cdkd 2>/dev/null
__gtf "a gh-resolved naming an ALIAS host -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/ghresalias" "gh pr merge 1 --squash"

git init -q "$__gtf_tmp/ghreswww" 2>/dev/null
git -C "$__gtf_tmp/ghreswww" remote add origin https://github.com/go-to-k/cdk-local.git 2>/dev/null
git -C "$__gtf_tmp/ghreswww" config remote.origin.gh-resolved www.github.com/go-to-k/cdkd 2>/dev/null
__gtf "a gh-resolved naming www.github.com -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/ghreswww" "gh pr merge 1 --squash"

# ANY host, not just the two aliases: gh IGNORES the host segment of a 3-part
# `gh-resolved` and takes it from the remote instead. Measured -- with `origin`
# at cdk-local, a `gh-resolved` of `nope.github.com/go-to-k/cdkd`,
# `gitlab.com/go-to-k/cdkd` and even
# `totally.bogus.example/go-to-k/cdkd` ALL resolve to go-to-k/cdkd in gh. So
# these must read as THIS repo (rc 1), and folding only the two aliases would
# leave every one of them relaxing.
git init -q "$__gtf_tmp/ghresnope" 2>/dev/null
git -C "$__gtf_tmp/ghresnope" remote add origin https://github.com/go-to-k/cdk-local.git 2>/dev/null
git -C "$__gtf_tmp/ghresnope" config remote.origin.gh-resolved nope.github.com/go-to-k/cdkd 2>/dev/null
__gtf "a gh-resolved at a NON-alias host -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/ghresnope" "gh pr merge 1 --squash"

git init -q "$__gtf_tmp/ghresforeignhost" 2>/dev/null
git -C "$__gtf_tmp/ghresforeignhost" remote add origin https://github.com/go-to-k/cdk-local.git 2>/dev/null
git -C "$__gtf_tmp/ghresforeignhost" config remote.origin.gh-resolved gitlab.com/go-to-k/cdkd 2>/dev/null
__gtf "a gh-resolved at a NON-GitHub host -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/ghresforeignhost" "gh pr merge 1 --squash"

# The CONTROL that keeps all of those honest: dropping the host must not make
# a DIFFERENT repo match. Same shape, a repo this gate does not own.
git init -q "$__gtf_tmp/ghresother" 2>/dev/null
git -C "$__gtf_tmp/ghresother" remote add origin https://github.com/go-to-k/cdk-local.git 2>/dev/null
git -C "$__gtf_tmp/ghresother" config remote.origin.gh-resolved github.com/go-to-k/some-other-repo 2>/dev/null
__gtf "a gh-resolved naming ANOTHER repo -> foreign" 0 \
  "$__gtf_hooks_dir" "$__gtf_tmp/ghresother" "gh pr merge 1 --squash"

# The REFUSAL MESSAGE must name the value AS CONFIGURED. Everything in that loop
# normalises the value -- case-folds it, drops its host -- so interpolating the
# working copy reported "pointing a remote at go-to-k/cdkd" for a `gh-resolved`
# of `gitlab.com/go-to-k/cdkd`, hiding the segment that made it match from the
# one reader who needs it: someone hunting for the setting to change. Nothing
# asserted any `GATE_FOREIGN_RETRACT` text before this case.
GH_REPO="" gate_target_is_foreign "$__gtf_hooks_dir" "$__gtf_tmp/ghresforeignhost" \
  "gh pr merge 1 --squash" "$GATE_RE_GH_PR_MERGE"
# BOTH halves: the value as configured AND the config key naming which remote
# to edit. The message is the reader's only route to the setting, so asserting
# one half would let the other regress silently.
case "$GATE_FOREIGN_RETRACT" in
  *remote.origin.gh-resolved*gitlab.com/go-to-k/cdkd*)
    pass=$((pass + 1)); printf 'OK   the gh-resolved refusal names the KEY and the value AS CONFIGURED\n' ;;
  *)
    fail=$((fail + 1))
    fail_log="${fail_log}FAIL gh-resolved refusal text: want 'remote.origin.gh-resolved' and the raw 'gitlab.com/go-to-k/cdkd', got '$GATE_FOREIGN_RETRACT'\n"
    printf 'FAIL gh-resolved refusal is missing the config key or the configured value\n' ;;
esac

__gtf "a MIXED-CASE gh-resolved -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/ghrescase" "gh pr merge 1 --squash"

# `gh-resolved = base` is gh's "no override" value and must NOT refuse.
git init -q "$__gtf_tmp/ghbase" 2>/dev/null
git -C "$__gtf_tmp/ghbase" remote add origin https://github.com/go-to-k/cdk-local.git 2>/dev/null
git -C "$__gtf_tmp/ghbase" config remote.origin.gh-resolved base 2>/dev/null
__gtf "gh-resolved = base -> foreign (it names no override)" 0 \
  "$__gtf_hooks_dir" "$__gtf_tmp/ghbase" "gh pr merge 1 --squash"

# --- Round 4: percent-encoding smuggles past the trims, and gh's 3-part form --
#
# Every character the normaliser strips can be delivered ENCODED. gh decodes the
# path FIRST and trims after, so a decode placed after the trims lets the
# stripped byte survive: `.../cdkd%2Egit` normalised to `...cdkd.git`, compared
# unequal, and the gate exited 0 on the real v10-bump PR. One encoded byte
# reopened the round-2 second-clone blocker, which is why the ORDER is fenced
# here rather than the individual spellings.
__gtf_enc=0
for __gtf_u in \
  "${__gtf_slug%.git}%2Egit" \
  "${__gtf_slug%.git}%2F" \
  "${__gtf_slug}%2f"; do
  __gtf_enc=$((__gtf_enc + 1))
  git init -q "$__gtf_tmp/enc$__gtf_enc" 2>/dev/null
  git -C "$__gtf_tmp/enc$__gtf_enc" remote add origin "$__gtf_u" 2>/dev/null
  __gtf "a PERCENT-ENCODED trim ($__gtf_u) -> NOT foreign" 1 \
    "$__gtf_hooks_dir" "$__gtf_tmp/enc$__gtf_enc" "gh pr merge 1 --squash"
done

# gh's `ghrepo.FromFullName` accepts HOST/OWNER/REPO as well as OWNER/REPO.
git init -q "$__gtf_tmp/ghres3" 2>/dev/null
git -C "$__gtf_tmp/ghres3" remote add origin https://github.com/go-to-k/cdk-local.git 2>/dev/null
git -C "$__gtf_tmp/ghres3" config remote.origin.gh-resolved "${__gtf_hook_slug:-github.com/go-to-k/cdkd}" 2>/dev/null
__gtf "a 3-PART gh-resolved -> NOT foreign" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/ghres3" "gh pr merge 1 --squash"

# A checkout with more remotes than the walk will examine must FAIL CLOSED
# rather than run past the hook's 10 s budget -- a killed hook is silent, and
# silence lets the merge through.
git init -q "$__gtf_tmp/manyremotes" 2>/dev/null
__gtf_n=0
while [ "$__gtf_n" -lt 205 ]; do
  git -C "$__gtf_tmp/manyremotes" remote add "zz$__gtf_n" "https://example.com/filler/r$__gtf_n" 2>/dev/null
  __gtf_n=$((__gtf_n + 1))
done
__gtf "more remotes than the walk examines -> NOT foreign (fail closed)" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/manyremotes" "gh pr merge 1 --squash"

# --- The HOOK side reads every remote too (round 6) --------------------------
#
# A contributor working from a FORK -- `origin` = their fork, `upstream` = this
# repo, the ordinary open-source setup on a public repo -- computed a hook slug
# no canonical clone matched, so a real clone of THIS repo classified as foreign
# and the gate relaxed. Measured rc 0 before this.
mkdir -p "$__gtf_tmp/forkhook/.claude/hooks/lib" 2>/dev/null
git init -q "$__gtf_tmp/forkhook" 2>/dev/null
git -C "$__gtf_tmp/forkhook" remote add origin https://github.com/contributor/cdkd.git 2>/dev/null
git -C "$__gtf_tmp/forkhook" remote add upstream "$__gtf_slug" 2>/dev/null
git init -q "$__gtf_tmp/canonical" 2>/dev/null
git -C "$__gtf_tmp/canonical" remote add origin "$__gtf_slug" 2>/dev/null
__gtf "a FORK hook checkout still recognises a canonical clone -> NOT foreign" 1 \
  "$__gtf_tmp/forkhook/.claude/hooks" "$__gtf_tmp/canonical" "gh pr merge 1 --squash"
# ...and a genuine sibling still relaxes from that same fork checkout, so the
# widening did not simply refuse everything.
git init -q "$__gtf_tmp/forksib" 2>/dev/null
git -C "$__gtf_tmp/forksib" remote add origin https://github.com/go-to-k/cdk-local.git 2>/dev/null
__gtf "a FORK hook checkout still relaxes a real sibling -> foreign" 0 \
  "$__gtf_tmp/forkhook/.claude/hooks" "$__gtf_tmp/forksib" "gh pr merge 1 --squash"

# THE FENCE FOR THE STRUCTURAL FIX. A remote that exists but does not normalise
# must refuse -- that, not the list of shapes above, is what makes the class
# terminate. Deleting the refusal reds THIS case and none of the others.
git init -q "$__gtf_tmp/unreadable" 2>/dev/null
git -C "$__gtf_tmp/unreadable" remote add origin "/srv/local/mirror" 2>/dev/null
__gtf "an UNREADABLE remote -> NOT foreign (fail closed)" 1 \
  "$__gtf_hooks_dir" "$__gtf_tmp/unreadable" "gh pr merge 1 --squash"

# A target with NO remote still RELAXES, and that asymmetry is deliberate.
# Requiring the target to resolve to a slug was tried and REGRESSED
# go-to-k/cdkd#3209: `verify-pr-gate`'s foreign fixtures are bare `git init`
# directories, so the rule put cdkd's own sentinel requirement back onto a
# foreign checkout -- the unclearable refusal that issue exists to remove
# (measured: its two relative-invocation cases went 0/0 -> 2/2).
# The hazard is a remote NAMING this repo, not the absence of remotes: with no
# remote and no flag gh resolves nothing at all, and every flagged or
# env-driven spelling is the allowlist's job.
git init -q "$__gtf_tmp/noremote" 2>/dev/null
__gtf "a target with NO remote -> foreign (gh can resolve nothing there)" 0 \
  "$__gtf_hooks_dir" "$__gtf_tmp/noremote" "gh pr merge 1 --squash"

rm -rf "$__gtf_tmp"
# Equality, not a floor, for the reason every other block here uses equality:
# a floor goes green when a case is deleted.
__gtf_ran=$((pass + fail - __gtf_start))
if [ "$__gtf_ran" -ne 42 ]; then
  fail=$((fail + 1))
  fail_log="${fail_log}FAIL gate_target_is_foreign block ran $__gtf_ran cases, expected exactly 42 -- a case vanished, or one was added without bumping the count\n"
else
  pass=$((pass + 1)); printf 'ok   gate_target_is_foreign block ran all %s cases\n' "$__gtf_ran"
fi


# --- gate_slug_from_url, directly -------------------------------------------
#
# It had NO direct case: it was reached only transitively, so a normalisation
# arm could break while every caller-level case stayed green. Each spelling
# below is one gh accepts.
__gsu() { # name, want-slug ('' = must refuse), url
  local got
  if got=$(gate_slug_from_url "$3" 2>/dev/null); then :; else got=''; fi
  if [ "$got" = "$2" ]; then
    pass=$((pass + 1)); printf 'OK   slug: %s\n' "$1"
  else
    fail=$((fail + 1))
    fail_log="${fail_log}FAIL slug: $1 (want '$2', got '$got')\n"
    printf 'FAIL slug: %s (want %s, got %s)\n' "$1" "${2:-<refuse>}" "${got:-<refuse>}"
  fi
}
__gsu_start=$((pass + fail))
__gsu "https"              github.com/go-to-k/cdkd https://github.com/go-to-k/cdkd.git
__gsu "no .git suffix"     github.com/go-to-k/cdkd https://github.com/go-to-k/cdkd
__gsu "scp-like"           github.com/go-to-k/cdkd git@github.com:go-to-k/cdkd.git
__gsu "ssh scheme"         github.com/go-to-k/cdkd ssh://git@github.com/go-to-k/cdkd.git
__gsu "case folded"        github.com/go-to-k/cdkd https://GitHub.com/GO-TO-K/CDKD.git
__gsu "trailing slash"     github.com/go-to-k/cdkd https://github.com/go-to-k/cdkd.git/
__gsu "query tail"         github.com/go-to-k/cdkd https://github.com/go-to-k/cdkd.git?x=1
__gsu "fragment tail"      github.com/go-to-k/cdkd https://github.com/go-to-k/cdkd.git#f
__gsu "trailing space"     github.com/go-to-k/cdkd "https://github.com/go-to-k/cdkd.git "
__gsu "doubled slash"      github.com/go-to-k/cdkd https://github.com//go-to-k//cdkd.git
__gsu "user@host"          github.com/go-to-k/cdkd https://u@github.com/go-to-k/cdkd.git
# TWO `@`s: Go's net/url -- what gh parses remotes with -- takes userinfo at the
# LAST one. A shortest-match strip left `b@github.com` in the host, compared
# unequal, and the gate exited 0 on the real v10-bump PR. The second spelling is
# an ACCIDENT class, not only an attack: an email as the HTTPS username.
__gsu "two @ (last wins)"  github.com/go-to-k/cdkd https://a@b@github.com/go-to-k/cdkd.git
__gsu "email as username"  github.com/go-to-k/cdkd https://alice@example.com@github.com/go-to-k/cdkd.git
__gsu "scp-like two @"     github.com/go-to-k/cdkd user@corp.com@github.com:go-to-k/cdkd.git
__gsu "empty userinfo @@"  github.com/go-to-k/cdkd https://@@github.com/go-to-k/cdkd.git
__gsu "user:pass@"         github.com/go-to-k/cdkd https://u:p@github.com/go-to-k/cdkd.git
__gsu "port"               github.com/go-to-k/cdkd https://github.com:443/go-to-k/cdkd.git
__gsu "deep path kept whole" gitlab.com/a/x/repo https://gitlab.com/a/x/repo.git
# An UPPER-CASE `.GIT` suffix. The fold happens after the strip, so it used to
# survive into the slug and the same repo keyed two ways. The whole-URL variant
# is what this file's `a CASE-variant spelling of THIS repo` case feeds, and
# that case is GREEN IN CI (which checks out a suffix-less URL) and RED in a
# local clone -- so these direct cases are what actually hold the behaviour.
# gh DROPS all three (measured): it does not strip an upper-case suffix either,
# so `go-to-k/CDKD.GIT` is a repo name it fails to resolve, and the wholly
# upper-cased URL is not even a known host to it. These are therefore
# OVER-normalisations, kept because they make the same repository key ONCE --
# and over-normalising is the strict direction here, since a spurious match
# means "this IS my repo" and refuses. Do not read them as a claim that gh
# accepts these spellings.
__gsu "upper .GIT suffix"    github.com/go-to-k/cdkd https://github.com/go-to-k/CDKD.GIT   # gh: DROPS
__gsu "whole URL upper"      github.com/go-to-k/cdkd HTTPS://GITHUB.COM/GO-TO-K/CDKD.GIT   # gh: DROPS
__gsu "mixed .Git suffix"    github.com/go-to-k/cdkd https://github.com/go-to-k/cdkd.Git   # gh: DROPS
# A repo whose NAME contains a dot keeps it: the strip is anchored to the
# suffix, not to "the last dot segment".
__gsu "dotted repo name"     github.com/go-to-k/my.repo https://github.com/go-to-k/my.repo.git
__gsu "dotted name no suffix" github.com/go-to-k/my.repo https://github.com/go-to-k/my.repo
# gh's TWO github.com host ALIASES (go-to-k/cdkd#3385). Keeping the host
# verbatim made the same repository key two ways, so a checkout whose remote
# named THIS repo through one of them read as FOREIGN and `verify-pr-gate`
# dropped the go-to-k/cdkd#2686 binding in a checkout that is cdkd.
#
# The right-hand column records whether GH ITSELF resolves that spelling,
# measured 2026-09-18 on gh 2.92.0 -- because the normalisation is deliberately
# NOT per-scheme while gh is, and the difference must be visible rather than
# read as a claim about gh. Every over-normalised row is a spelling gh DROPS,
# and in a predicate that asks "does ANY remote name this repo" a spurious match
# only ever ADDS the binding requirement.
__gsu "ssh.github.com scp"   github.com/go-to-k/cdkd git@ssh.github.com:go-to-k/cdkd.git          # gh: resolves
__gsu "ssh.github.com ssh://" github.com/go-to-k/cdkd ssh://git@ssh.github.com/go-to-k/cdkd.git   # gh: resolves
__gsu "ssh.github.com :443"  github.com/go-to-k/cdkd ssh://git@ssh.github.com:443/go-to-k/cdkd.git # gh: resolves
__gsu "www.github.com https" github.com/go-to-k/cdkd https://www.github.com/go-to-k/cdkd.git      # gh: resolves
__gsu "www.github.com scp"   github.com/go-to-k/cdkd git@www.github.com:go-to-k/cdkd.git          # gh: resolves
__gsu "ssh.github.com https" github.com/go-to-k/cdkd https://ssh.github.com/go-to-k/cdkd.git      # gh: DROPS -- over-normalised, over-refuses
__gsu "WWW upper https"      github.com/go-to-k/cdkd https://WWW.GitHub.com/go-to-k/cdkd.git      # gh: DROPS -- over-normalised, over-refuses
# NOT aliased, and that is agreeing with gh rather than an oversight: these
# resolve NOWHERE in gh, so a checkout whose only cdkd-naming remote sits at one
# of them really is a sibling, and relaxing there is correct.
__gsu "nope.github.com kept" nope.github.com/go-to-k/cdkd https://nope.github.com/go-to-k/cdkd.git
__gsu "gist.github.com kept" gist.github.com/go-to-k/cdkd https://gist.github.com/go-to-k/cdkd.git
__gsu "a.b.github.com kept"  a.b.github.com/go-to-k/cdkd https://a.b.github.com/go-to-k/cdkd.git
# The suffix must ANCHOR: a host merely CONTAINING the alias text is not one.
__gsu "evil suffix not alias" ssh.github.com.evil.example/go-to-k/cdkd https://ssh.github.com.evil.example/go-to-k/cdkd.git
__gsu "notwww not alias"     notwww.github.com/go-to-k/cdkd https://notwww.github.com/go-to-k/cdkd.git
# The remaining anchoring direction: a TRAILING dot is a distinct host and must
# not fold (prefix and suffix are covered above, this is the third edge).
__gsu "trailing dot not alias" ssh.github.com./go-to-k/cdkd https://ssh.github.com./go-to-k/cdkd.git
# The one input where `${path%.*}` yields an EMPTY segment. It must refuse, not
# key an empty repo name.
__gsu "bare .GIT refuses"    '' https://github.com/go-to-k/.GIT
# The fold runs AFTER the case-fold, so an UPPER-CASE alias must fold too. Only
# the `www` arm exercised that ordering; this is the `ssh` twin.
__gsu "UPPER ssh alias folds" github.com/go-to-k/cdkd git@SSH.GitHub.Com:go-to-k/cdkd.git
# scp form with NO userinfo, and the `git://` scheme -- two spellings git
# accepts that had no alias case at all.
__gsu "scp alias no userinfo" github.com/go-to-k/cdkd ssh.github.com:go-to-k/cdkd.git
__gsu "git:// scheme alias"   github.com/go-to-k/cdkd git://ssh.github.com/go-to-k/cdkd.git
# Alias + upper .GIT + trailing slash together: the three normalisations must
# compose, not just work one at a time.
__gsu "alias + .GIT + slash"  github.com/go-to-k/cdkd https://WWW.github.com/go-to-k/CDKD.GIT/
# REFUSALS: a local path names no forge, and a single-segment path is not a repo.
__gsu "local path refuses"   '' /srv/local/mirror
__gsu "no host refuses"      '' cdkd:cdkd
__gsu "single segment refuses" '' https://github.com/cdkd
__gsu "empty refuses"        '' ''
__gsu_ran=$((pass + fail - __gsu_start))
if [ "$__gsu_ran" -ne 45 ]; then
  fail=$((fail + 1))
  fail_log="${fail_log}FAIL gate_slug_from_url block ran $__gsu_ran cases, expected exactly 45\n"
else
  pass=$((pass + 1)); printf 'ok   gate_slug_from_url block ran all %s cases\n' "$__gsu_ran"
fi


__gmc_tail_start=$((pass + fail))

# THE TWO MESSAGES THIS HELPER EMITS, held to the same shape rule as the hook
# refusals. Both fire while EVERY Bash call is refused, so an indented recipe
# line in either would offer a command that cannot be run -- the defect that
# took three revisions to close in the hook-side twin. `main-tree-edit-gate`'s
# suite asserts the shape for the two refusals that hook OWNS; these two belong
# here, where the helper lives, and review round 19 found the soft one outside
# every scan. The assertion is TOTAL -- no line may begin with whitespace --
# because the enumerating version was walked past by six spellings.
# CONTENT, not only shape. Review round 20 measured that deleting the soft
# note's three prose lines left this suite at 644/0 AND `restore-backup.test.sh`
# at 17/0 -- its only content assertion is satisfied by the first line alone. A
# shape fence over an empty message passes; these needles are what make the
# shape fence be about something. The last one is the route: the soft note ended
# "Restore or finish the library" full stop, which is the same unfollowable
# advice the hard arm took three revisions to shed -- prose rather than an
# indented recipe, so the shape scan could never have caught it.
__msg_hard=$( (gate_require_const GATE_NO_SUCH_CONST_PROBE) 2>&1 >/dev/null || true )
__msg_soft=$( gate_require_const_soft GATE_NO_SUCH_CONST_PROBE 2>&1 >/dev/null || true )
for __m in hard soft; do
  eval "__msg_body=\$__msg_$__m"
  if [ -z "$__msg_body" ]; then
    fail=$((fail + 1))
    fail_log="${fail_log}FAIL the $__m arm of gate_require_const emitted nothing -- the shape case would pass over a message it never saw\n"
  elif printf '%s\n' "$__msg_body" | grep -qE '^[[:space:]]'; then
    fail=$((fail + 1))
    fail_log="${fail_log}FAIL the $__m refusal indents a line; every Bash call is refused in that state, so a recipe cannot be run -- advise a TOOL in running prose\n"
  else
    pass=$((pass + 1)); printf 'ok   the %s refusal indents no line\n' "$__m"
  fi
done

# ONE NEEDLE PER LINE of the note's body, verified by deleting each line and
# watching exactly one case redden. The first attempt had four needles for five
# lines and one of them sat on the line ABOVE the one it was meant to cover, so
# deleting the last line left the suite green -- the needle asserted a line it
# was not about, which is the defect this block exists to prevent one level up.
for __n in "so this NON-BLOCKING hook is skipping rather than refusing" \
           "recognise the command" \
           "did not happen" \
           "no Bash spelling" \
           "refuse every Bash call in this state"; do
  case "$__msg_soft" in
    *"$__n"*) pass=$((pass + 1)); printf 'ok   the soft note says: %s\n' "$__n" ;;
    *) fail=$((fail + 1))
       fail_log="${fail_log}FAIL the soft note must say: $__n\n" ;;
  esac
done

# A CARDINALITY GUARD ON THE TAIL, for the same reason the block above has one
# and by the same measurement. `CASE_FLOOR` is evaluated far upstream and the
# block floor ends before these run, so nothing counted the two shape cases or
# the five needles: measured, dropping `soft` from the shape loop reports 648/0
# in silence -- the round-19 soft-shape fence gone -- and dropping the last
# needle does the same. Cases asserted by construction rather than by mutation
# is the defect this whole file has been chasing; these were the last instance
# of it in here.
__gmc_tail=$((pass + fail - __gmc_tail_start))
if [ "$__gmc_tail" -ne 7 ]; then
  fail=$((fail + 1))
  fail_log="${fail_log}FAIL the helper-message block ran $__gmc_tail cases, expected exactly 7 (2 shape + 5 needles) -- a case vanished, or one was added without bumping the count\n"
else
  pass=$((pass + 1)); printf 'ok   the helper-message block ran all 7 cases\n'
fi

echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
