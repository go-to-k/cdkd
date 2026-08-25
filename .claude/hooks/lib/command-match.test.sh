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

# A `-C` embedded in a quoted FLAG VALUE must not become the target. Measured on
# origin/main: `git -c core.pager="less -C /evil" commit` resolved `/evil`, and
# through branch-gate on `main` that turned rc=2 into rc=0 -- a bypass driven by
# a flag value. Pre-existing, found by a sibling repo's review of the same code.
want_dir "/fallback" "-C inside a quoted flag value is not a target" \
  'git -c core.pager="less -C /evil" commit -m y' /fallback "$C"
want_dir "/w/t" "a real -C after -c k=v still resolves" \
  'git -c k=v -C /w/t commit -m x' /fallback "$C"

echo
echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
