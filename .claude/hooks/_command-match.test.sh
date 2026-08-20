#!/usr/bin/env bash
# Smoke test for _command-match.sh, the shared segment matcher every gate uses.
# Run from the repo root: `bash .claude/hooks/_command-match.test.sh`
#
# The cases are the spellings go-to-k/cdkd#2129 measured running UNGATED
# against the old line-start-anchored regexes, plus the negatives that must stay
# out (a verb inside a string, a different verb, a lookalike).

set -u

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_command-match.sh"

pass=0; fail=0

# want_match <expect 0|1> <label> <command> <regex>
want_match() {
  local want="$1" label="$2" cmd="$3" re="$4" got
  if gate_matches "$cmd" "$re"; then got=0; else got=1; fi
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL %s (want %s got %s) :: %s\n' "$label" "$want" "$got" "$cmd"
  fi
}

# want_dir <expected> <label> <command> <fallback> <regex>
want_dir() {
  local want="$1" label="$2" cmd="$3" fallback="$4" re="$5" got
  got=$(gate_target_dir "$cmd" "$fallback" "$re")
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$label"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n  want: %s\n  got:  %s\n' "$label" "$want" "$got"
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

printf '\npass: %s  fail: %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
