#!/usr/bin/env bash
# Smoke test for post-merge-sync-reminder.sh.
#
# WHY IT EXISTS AT ALL. This hook was the ONE registered hook in the repo with
# no suite (`.claude/rules/hooks.md` said so in as many words), and the cost was
# measured rather than argued: it hand-rolled a `gh ... pr merge` ERE that went
# silent on every spelling carrying a flag between the group word and the verb,
# and nothing could have said so. go-to-k/cdkd#3266 moved it onto the shared
# `GATE_RE_GH_PR_MERGE` and this file is the other half of that change --
# without it, the next edit to the matching line has the same blind spot.
#
# The hook is a PostToolUse INFORMER: it refuses nothing, always exits 0, and
# its only observable is whether it prints the `additionalContext` reminder. So
# every case below reads STDOUT, not the exit code -- an exit code here cannot
# distinguish "fired" from "did not".
#
# Run from the repo root: `bash .claude/hooks/post-merge-sync-reminder.test.sh`.
# `HOOK_BASH` is honoured: the SUITE running under bash 3.2 does not run the
# HOOK under it (the hook is `#!/usr/bin/env bash` and resolves through PATH),
# so the subject follows the harness via a shim.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/post-merge-sync-reminder.sh"
HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TMPDIR_T="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_T"; }
trap cleanup EXIT

# Make the HOOK run under the same bash as this harness (see the header).
HOOK_BASH="${HOOK_BASH:-bash}"
SHIM="$TMPDIR_T/shim"
mkdir -p "$SHIM"
ln -sf "$(command -v "$HOOK_BASH" || echo /bin/bash)" "$SHIM/bash"
RUN_PATH="$SHIM:$PATH"

pass=0
fail=0
fail_log=""

# run_case <expect: fires|quiet> <desc> <command> [exit_code] [stderr]
# EVERY case asserts the EXIT CODE as well as the output, and that is not
# belt-and-braces. This hook's header says "always exit 0 — PostToolUse cannot
# block", and a PostToolUse hook that exits 2 does NOT become a gate: it
# surfaces as a hook error on a command that already ran. Nothing else here
# would notice. Measured (go-to-k/cdkd#3273 review): with the trailing `exit 0`
# rewritten to `exit 2` this suite stayed green at 38/38, because `run_case`
# read only stdout. It reds now.
run_case() {
  local expect="$1" desc="$2" cmd="$3" ec="${4:-0}" errtext="${5:-}" out got rc
  local payload
  payload=$(jq -nc --arg c "$cmd" --arg ec "$ec" --arg e "$errtext" \
    '{tool_name:"Bash",tool_input:{command:$c},
      tool_response:{exit_code:($ec|tonumber),stderr:$e}}')
  out=$(printf '%s' "$payload" | PATH="$RUN_PATH" "$HOOK_BASH" "$HOOK" 2>/dev/null)
  rc=$?
  case "$out" in
    *'"hookEventName":"PostToolUse"'*) got=fires ;;
    *) got=quiet ;;
  esac
  if [ "$got" = "$expect" ] && [ "$rc" -eq 0 ]; then
    pass=$((pass + 1))
    printf 'ok   (%s) %s\n' "$got" "$desc"
  else
    fail=$((fail + 1))
    fail_log="$fail_log
  FAIL (got $got rc=$rc, want $expect rc=0) $desc"
    printf 'FAIL (got %s rc=%s, want %s rc=0) %s\n' "$got" "$rc" "$expect" "$desc"
  fi
}

# --- The shape the hook was written for. ---------------------------------
run_case fires "bare gh pr merge" 'gh pr merge 123 --squash --delete-branch'
run_case fires "gh pr merge with no flags" 'gh pr merge 123'
run_case fires "gh pr merge --auto" 'gh pr merge --auto 123'

# --- A FLAG IN EITHER SLOT (go-to-k/cdkd#3266). --------------------------
# The retired inline ERE absorbed `-X <value>` only to the LEFT of the group
# word, so the four below were SILENT while every blocking gate fired on them.
# Each of these fails against the pre-#3266 hook except the first, which is the
# control saying the left slot already worked.
run_case fires "left-slot repo flag, separate value" \
  'gh -R go-to-k/cdkd pr merge 123 --squash'
run_case fires "between-slot repo flag, separate value" \
  'gh pr -R go-to-k/cdkd merge 123 --squash'
run_case fires "between-slot repo flag, --repo=value" \
  'gh pr --repo=go-to-k/cdkd merge 123'
run_case fires "between-slot repo flag, glued short" \
  'gh pr -Rgo-to-k/cdkd merge 123'
run_case fires "a verb quoted behind a flag value (go-to-k/cdkd#3284)" \
  'gh pr --json url "merge" 123'

# --- COMMAND POSITION, which is what the shared matcher buys. ------------
# The inline ERE carried pipe / semicolon / ampersand / backtick / close-paren
# as extra verb terminators; `gate_matches` tests one SEGMENT at a time and a
# segment ends AT the separator, so dropping them costs nothing. These are the
# cases that say so -- if the segmenter stopped splitting, they go quiet.
run_case fires "chained after a && " 'git push && gh pr merge 123 --squash'
run_case fires "chained after a ; " 'echo done; gh pr merge 123'
run_case fires "inside a subshell" '(gh pr merge 123 --squash)'
run_case fires "after a cd" 'cd /tmp && gh pr merge 123'
run_case fires "piped-from segment" 'echo x | gh pr merge 123'

# --- The FALSE-POSITIVE class the hook exists to avoid (2026-05-23). -----
# A quoted MENTION is data, not a command. Both shapes below are the ones that
# actually fired before the hook was anchored: a commit message body carrying
# the phrase, and a JSON literal carrying it.
run_case quiet "quoted mention in a commit message body" \
  'git commit -m "next step: gh pr merge 123"'
run_case quiet "quoted mention in a JSON literal" \
  'echo "{\"command\":\"x && gh pr merge 1\"}"'
run_case quiet "quoted mention in an issue body" \
  'gh issue create --body "remember to gh pr merge 123 later"'
run_case quiet "heredoc body carrying the phrase" \
  'cat > /tmp/m <<EOF
gh pr merge 123
EOF'

# --- Scope: other gh verbs and other tools are not this hook's business. -
run_case quiet "gh pr create" 'gh pr create --title x --body y'
run_case quiet "gh pr view" 'gh pr view 123'
run_case quiet "gh pr checks" 'gh pr checks 123 --watch'
run_case quiet "git merge is not gh pr merge" 'git merge origin/main'
run_case quiet "unrelated command" 'ls -la'
# POLARITY for the widened absorber: a flagged READ verb must stay quiet, or
# the between-slot cases above are satisfied by a matcher that fires on
# anything after a flag.
run_case quiet "between-slot repo flag on a READ verb" \
  'gh pr -R go-to-k/cdkd view 123'
run_case quiet "between-slot repo flag on pr list" \
  'gh pr --repo=go-to-k/cdkd list'

# --- The hook's OWN guards, which no matcher case can reach. -------------
# A merge that FAILED must not produce a "sync now" reminder.
run_case quiet "non-zero exit code" 'gh pr merge 123 --squash' 1
run_case quiet "stderr says not mergeable" 'gh pr merge 123 --squash' 0 'PR #123 is not mergeable'
run_case quiet "stderr says merge queue" 'gh pr merge 123 --squash' 0 'PR #123 is in the merge queue'
# ...and the control: the SAME command with an empty stderr fires, so the two
# above are testing the stderr branch and not something else.
run_case fires "empty stderr and exit 0 still fires (control)" 'gh pr merge 123 --squash' 0 ''
# Non-Bash tools are out of scope (PostToolUse fires on every tool by default).
non_bash_out=$(jq -nc '{tool_name:"Read",tool_input:{command:"gh pr merge 1"},
  tool_response:{exit_code:0,stderr:""}}' \
  | PATH="$RUN_PATH" "$HOOK_BASH" "$HOOK" 2>/dev/null)
if [ -z "$non_bash_out" ]; then
  pass=$((pass + 1)); printf 'ok   (quiet) a non-Bash tool_name is ignored\n'
else
  fail=$((fail + 1))
  fail_log="$fail_log
  FAIL a non-Bash tool_name is ignored"
  printf 'FAIL a non-Bash tool_name is ignored\n'
fi

# --- The REMINDER'S CONTENT, because a fired hook that says nothing useful
#     is indistinguishable from a working one by every case above. Each needle
#     is a separate case so deleting one line reds exactly one.
reminder=$(jq -nc '{tool_name:"Bash",tool_input:{command:"gh pr merge 1 --squash"},
  tool_response:{exit_code:0,stderr:""}}' \
  | PATH="$RUN_PATH" "$HOOK_BASH" "$HOOK" 2>/dev/null)
want_text() {
  local desc="$1" needle="$2"
  case "$reminder" in
    *"$needle"*) pass=$((pass + 1)); printf 'ok   (text) %s\n' "$desc" ;;
    *) fail=$((fail + 1))
       fail_log="$fail_log
  FAIL reminder is missing: $needle"
       printf 'FAIL (text) %s\n' "$desc" ;;
  esac
}
want_text "names the pull step" 'git pull --ff-only origin main'
want_text "names the rebuild step" 'vp run build'
want_text "says releases are batched" 'Releases are BATCHED'
want_text "warns against merging the release PR" 'never merge the release PR'
# It must be VALID JSON, or the harness drops it silently and the operator sees
# nothing at all -- the same failure as not firing.
if printf '%s' "$reminder" | jq -e '.hookSpecificOutput.additionalContext' >/dev/null 2>&1; then
  pass=$((pass + 1)); printf 'ok   (text) the payload is well-formed hook JSON\n'
else
  fail=$((fail + 1))
  fail_log="$fail_log
  FAIL the payload is not well-formed hook JSON"
  printf 'FAIL the payload is not well-formed hook JSON\n'
fi

# --- FAIL-SOFT on an unloadable library. ---------------------------------
# This hook is NON-BLOCKING, so it must SKIP rather than refuse -- the opposite
# of the blocking gates. Staged as a hooks dir whose library is truncated.
STAGE="$TMPDIR_T/stage"
mkdir -p "$STAGE/lib"
cp "$HOOK" "$STAGE/post-merge-sync-reminder.sh"
: > "$STAGE/lib/command-match.sh"
soft_out=$(jq -nc '{tool_name:"Bash",tool_input:{command:"gh pr merge 1 --squash"},
  tool_response:{exit_code:0,stderr:""}}' \
  | PATH="$RUN_PATH" "$HOOK_BASH" "$STAGE/post-merge-sync-reminder.sh" 2>/dev/null)
soft_rc=$?
if [ "$soft_rc" -eq 0 ] && [ -z "$soft_out" ]; then
  pass=$((pass + 1)); printf 'ok   (quiet) an unloadable library SKIPS, it does not refuse\n'
else
  fail=$((fail + 1))
  fail_log="$fail_log
  FAIL unloadable library: rc=$soft_rc out=$soft_out"
  printf 'FAIL an unloadable library must skip (rc=%s)\n' "$soft_rc"
fi
# ...and the CONSTANT half: a library that defines every FUNCTION but not the
# constant this hook reads must also skip, saying what is missing. Without this
# case the `gate_require_const_soft GATE_RE_GH_PR_MERGE` call added by
# go-to-k/cdkd#3266 can be deleted with the suite staying green -- the failure
# mode `.claude/rules/hooks.md` records for 27 of the 31 sourcing hooks.
STAGE2="$TMPDIR_T/stage2"
mkdir -p "$STAGE2/lib"
cp "$HOOK" "$STAGE2/post-merge-sync-reminder.sh"
sed 's/^GATE_RE_GH_PR_MERGE=.*$/GATE_RE_GH_PR_MERGE=""/' \
  "$HOOKS_DIR/lib/command-match.sh" > "$STAGE2/lib/command-match.sh"
const_out=$(jq -nc '{tool_name:"Bash",tool_input:{command:"gh pr merge 1 --squash"},
  tool_response:{exit_code:0,stderr:""}}' \
  | PATH="$RUN_PATH" "$HOOK_BASH" "$STAGE2/post-merge-sync-reminder.sh" 2>/dev/null)
const_rc=$?
const_err=$(jq -nc '{tool_name:"Bash",tool_input:{command:"gh pr merge 1 --squash"},
  tool_response:{exit_code:0,stderr:""}}' \
  | PATH="$RUN_PATH" "$HOOK_BASH" "$STAGE2/post-merge-sync-reminder.sh" 2>&1 >/dev/null)
if [ "$const_rc" -eq 0 ] && [ -z "$const_out" ]; then
  pass=$((pass + 1)); printf 'ok   (quiet) a missing CONSTANT skips rather than refusing\n'
else
  fail=$((fail + 1))
  fail_log="$fail_log
  FAIL missing constant: rc=$const_rc out=$const_out"
  printf 'FAIL a missing constant must skip (rc=%s)\n' "$const_rc"
fi
# THE CASE ABOVE IS A CONFLUENCE POINT ON ITS OWN, and the two below are what
# make this block discriminate. Measured by deleting the constant's NAME from
# the `gate_require_const_soft` call: the hook still exits 0 with empty stdout,
# because `gate_matches` with an empty pattern makes bash abort the `=~` with
# `invalid regular expression ... empty (sub)expression` and the function then
# returns 1. Same exit code, same silence, an entirely different reason -- so
# quiet-and-rc-0 cannot say whether the guard fired. These two read WHICH.
case "$const_err" in
  *GATE_RE_GH_PR_MERGE*)
    pass=$((pass + 1)); printf 'ok   (text) the skip names the missing constant\n' ;;
  *)
    fail=$((fail + 1))
    fail_log="$fail_log
  FAIL the skip does not name GATE_RE_GH_PR_MERGE: $const_err"
    printf 'FAIL the skip does not name the missing constant\n' ;;
esac
case "$const_err" in
  *'invalid regular expression'*)
    fail=$((fail + 1))
    fail_log="$fail_log
  FAIL the hook reached the matcher with an empty constant: $const_err"
    printf 'FAIL the hook reached the matcher with an empty constant\n' ;;
  *)
    pass=$((pass + 1)); printf 'ok   (text) the guard stops BEFORE the matcher is reached\n' ;;
esac

# --- CASE FLOOR. A collapse detector, not a tally: a `run_case` helper that
#     stopped invoking the hook would report a clean run over nothing.
CASE_FLOOR=30
total=$((pass + fail))
if [ "$total" -lt "$CASE_FLOOR" ]; then
  fail=$((fail + 1))
  printf 'FAIL only %s cases ran, floor %s -- the harness collapsed\n' "$total" "$CASE_FLOOR"
fi

printf -- '----\npassed=%s failed=%s\n' "$pass" "$fail"
if [ "$fail" -ne 0 ]; then
  printf '%s\n' "$fail_log"
  exit 1
fi
exit 0
