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
_gate_hook_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$_gate_hook_dir/gh-body-english-gate.sh" ]; then
  _fc_tmp="$(mktemp -d)"
  mkdir -p "$_fc_tmp/lib"
  cp "$_gate_hook_dir/gh-body-english-gate.sh" "$_fc_tmp/"
  # A library that is otherwise COMPLETE and merely predates the constant. A
  # truncated one would trip the `declare -F` guard instead, and the case would
  # pass for the wrong reason.
  grep -v '^GATE_RE_GH_PROSE_CARRIER=' "$_gate_hook_dir/lib/command-match.sh" \
    > "$_fc_tmp/lib/command-match.sh"
  _fc_payload='{"cwd":"/tmp","tool_name":"Bash","session_id":"fc","tool_input":{"command":"gh issue create --title x --body y"}}'
  printf '%s' "$_fc_payload" | bash "$_fc_tmp/gh-body-english-gate.sh" >/dev/null 2>&1
  _fc_rc=$?
  if [ "$_fc_rc" -eq 2 ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "fail-closed: a library without GATE_RE_GH_PROSE_CARRIER refuses"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n' "fail-closed: a library without GATE_RE_GH_PROSE_CARRIER refuses"
    fail_log+="FAIL fail-closed arm: expected rc=2, got rc=$_fc_rc\n"
  fi
  # Polarity: the SAME fixture with the constant present must pass the command
  # through (rc=0), or the case above would pass on any breakage at all.
  cp "$_gate_hook_dir/lib/command-match.sh" "$_fc_tmp/lib/command-match.sh"
  printf '%s' "$_fc_payload" | bash "$_fc_tmp/gh-body-english-gate.sh" >/dev/null 2>&1
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



# A FLOOR on the case total. Every `for` loop above expands a LIST, and emptying
# one -- or deleting a case -- removes assertions SILENTLY while the tally still
# reads `fail: 0`. No suite in this repo had one, so the only thing standing
# between a gutted loop and a green run was somebody noticing the number move.
# Raise it when cases are added; never lower it to make a red run green.
CASE_FLOOR=386
if [ "$((pass + fail))" -lt "$CASE_FLOOR" ]; then
  fail=$((fail + 1))
  fail_log+="FAIL case floor: only $((pass + fail)) cases ran, expected at least 386\n"
  printf 'FAIL case floor: only %s cases ran, expected at least %s\n' "$((pass + fail))" "$CASE_FLOOR"
fi
echo
echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
