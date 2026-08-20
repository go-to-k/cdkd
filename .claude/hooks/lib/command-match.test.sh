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

# A fully-quoted cd path resolves to NOTHING so the caller falls back to the
# payload cwd. Recovering it from raw text was tried and removed: the raw
# command still holds quoted `cd` mentions the neutralised pass ignored, and
# pairing the two by order resolved the WRONG directory.
cd_check "a fully-quoted cd path is not resolved (documented fallback)" "" \
  'cd "/tmp/a b" && gh pr merge 1' "$MERGE"

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

echo
echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
