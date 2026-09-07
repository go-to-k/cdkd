#!/usr/bin/env bash
# Smoke test for verify-pr-gate.sh.
#
# Exercises the cwd-aware command-matching against fixture git
# working trees and asserts that the markgate verify runs against
# the RESOLVED target directory — not the script's location. This
# is the post-#559 contract: markers land in the worktree where
# `gh pr create` / `gh pr merge` actually runs, not always in the
# main tree.
#
# Run from the repo root: `bash .claude/hooks/verify-pr-gate.test.sh`.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify-pr-gate.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

side_repo="$TMPDIR/side-repo"
main_repo="$TMPDIR/main-repo"
git init -q -b feature/x "$side_repo"
git -C "$side_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git init -q -b main "$main_repo"
git -C "$main_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

# Repo opt-in signal (mirrors branch-gate.test.sh): the gate only fires in a
# repo carrying a `.markgate.yml` at its top level, so the fixtures must have
# one or every case would pass through untested.
touch "$side_repo/.markgate.yml" "$main_repo/.markgate.yml"

# The sha sentinel `/verify-pr` writes (go-to-k/cdkd#2686). Every pre-existing
# `fresh` case assumed a fresh marker was sufficient; it is not, and seeding
# these is what keeps those cases testing what they were written for rather
# than the new binding.
git -C "$side_repo" rev-parse HEAD > "$side_repo/.markgate-verify-pr-sha"
git -C "$main_repo" rev-parse HEAD > "$main_repo/.markgate-verify-pr-sha"

SHIM_DIR="$TMPDIR/bin"
mkdir -p "$SHIM_DIR"
CWD_TRACE_FILE="$TMPDIR/cwd-trace"
ARGS_TRACE_FILE=$(mktemp)

cat > "$SHIM_DIR/mise" <<'MISE_EOF'
#!/usr/bin/env bash
if [ "$1" = "exec" ] && [ "$2" = "--" ]; then
  shift 2
  exec "$@"
fi
exit 1
MISE_EOF
chmod +x "$SHIM_DIR/mise"

cat > "$SHIM_DIR/markgate" <<MARKGATE_EOF
#!/usr/bin/env bash
echo "\$PWD" >> "$CWD_TRACE_FILE"
# Record the ARGUMENTS too, not only the cwd. Discarding them left this suite
# unable to see WHICH gate the hook asked about: swapping
# \`markgate verify verify-pr\` for \`markgate verify check\` kept it at 22/22
# GREEN, and that mutant is a live bypass -- verify-pr-gate would pass whenever
# \`/check\` alone is fresh, with \`/verify-pr\` never having run. Found by a
# sibling repo's round-2 test review, which named the class: nothing asserted
# what the gate ASKS ITS VERIFIER.
echo "\$*" >> "$ARGS_TRACE_FILE"
verdict="\${MARKGATE_MOCK_VERDICT:-stale}"
case "\$1" in
  verify)
    [ "\$verdict" = "fresh" ] && exit 0
    exit 1
    ;;
  status)
    if [ "\$verdict" = "fresh" ]; then
      printf 'key:        %s\nstate:      match\n' "\$2"
    else
      printf 'key:        %s\nstate:      stale (digest differs)\n' "\$2"
    fi
    exit 0
    ;;
esac
exit 1
MARKGATE_EOF
chmod +x "$SHIM_DIR/markgate"

export PATH="$SHIM_DIR:$PATH"

pass=0
fail=0
fail_log=""

# run_case <name> <expect_exit> <mg_verdict> <expect_cwd> <stdin_json>
run_case() {
  local name="$1"; local want="$2"; local verdict="$3"; local expect_cwd="$4"; local payload="$5"
  : > "$CWD_TRACE_FILE"
  local got
  printf '%s' "$payload" | MARKGATE_MOCK_VERDICT="$verdict" "$HOOK" >/dev/null 2>&1
  got=$?

  local cwd_ok=1
  if [ -n "$expect_cwd" ]; then
    if ! grep -qFx "$expect_cwd" "$CWD_TRACE_FILE" 2>/dev/null; then
      cwd_ok=0
    fi
  fi

  if [[ "$got" == "$want" ]] && [ "$cwd_ok" -eq 1 ]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got"
    if [ "$cwd_ok" -eq 0 ]; then
      fail_log+="; cwd mismatch (want '$expect_cwd', trace: $(cat "$CWD_TRACE_FILE" 2>/dev/null | tr '\n' '|'))"
    fi
    fail_log+="\n  payload: $payload\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# --- PASS-THROUGH cases (matcher must NOT fire) ---

# 1. Non-PR-create/merge command always passes through.
run_case "git status passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git status"}}' "$side_repo")"

# 2. `gh pr view` not gated.
run_case "gh pr view passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr view 42"}}' "$side_repo")"

# 3. `gh pr edit` not gated.
run_case "gh pr edit passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr edit 42"}}' "$side_repo")"

# 4. Non-git target dir → silent pass.
run_case "non-git target dir allowed" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr create --title x"}}' "$TMPDIR")"

# 5. Empty stdin.
run_case "empty stdin passes through" 0 stale "" ''

# --- CWD-AWARE cases ---

# 6. `gh pr create` from side worktree → markgate runs in side.
#    Load-bearing #559 case.
run_case "gh pr create in side worktree → markgate runs there" 2 stale "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr create --title x"}}' "$side_repo")"

# 7. `gh pr merge` from main worktree → markgate runs in main.
run_case "gh pr merge in main worktree → markgate runs there" 2 stale "$main_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$main_repo")"

# 8. `cd <side> && gh pr merge` from main cwd → markgate in side.
run_case "cd <side> && gh pr merge from main cwd → side wins" 2 stale "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd %s && gh pr merge 42 --auto"}}' "$main_repo" "$side_repo")"

# 9. `gh -C <side> pr merge` from main cwd → markgate in side.
run_case "gh -C <side> pr merge from main cwd → side wins" 2 stale "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh -C %s pr merge 42 --squash"}}' "$main_repo" "$side_repo")"

# 10. Fresh marker in side worktree → pass.
run_case "fresh marker in side worktree passes" 0 fresh "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr create"}}' "$side_repo")"

# 11. `gh pr merge --auto` shape matches.
run_case "gh pr merge --auto matches" 2 stale "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge --auto"}}' "$side_repo")"

# --- LINE-START ANCHORING cases (issue #563) ---
#
# The matcher MUST NOT fire when the literal substrings `gh pr create`
# / `gh pr merge` appear inside a quoted argument body of an unrelated
# command. Per memory rule feedback_hook_command_match_line_start.md,
# applied to verify-pr-gate.sh in issue #563 (mirroring the PR #562
# fix to check-gate.sh).

# 12. `gh issue create --body "...gh pr create..."`: the body mentions
#     `gh pr create` but the line starts with `gh issue create`, not
#     `gh pr create`. MUST pass through.
run_case "gh issue body quoting 'gh pr create' passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh issue create --body \"next step: gh pr create from this branch\""}}' "$side_repo")"

# 13. `echo "...gh pr merge..."`: the body mentions `gh pr merge` but
#     the command starts with `echo`. MUST pass through.
run_case "echo body quoting 'gh pr merge' passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"echo \"after CI green: gh pr merge --squash\""}}' "$side_repo")"

# --- COMMAND-POSITION cases (issue #1455) ---
#
# The line-start anchor these Part-C cases motivated also let a REAL
# invocation through whenever any other command came first. That is not a
# hypothetical shape: `git push && gh pr create` is the natural way to push a
# branch and open its PR in one step, and it is exactly how PR #1451's own
# `gh pr create` slipped past this gate. The verb is now matched in command
# position — line start OR after `&&` / `||` / `;` / `|` — while the
# false-positive cases above keep passing because quoted spans are stripped
# before matching rather than dodged by position.

# 14. `git push && gh pr create` — the shape that motivated the issue.
run_case "git push && gh pr create is caught" 2 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git push && gh pr create --title x --body y"}}' "$side_repo")"

# 15. `; gh pr merge` — chained after an unrelated command.
run_case "chained ; gh pr merge is caught" 2 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"echo done; gh pr merge 1 --squash"}}' "$side_repo")"

# 16. `|| gh pr merge` — chained on failure.
run_case "chained || gh pr merge is caught" 2 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"false || gh pr merge 1 --squash"}}' "$side_repo")"

# 17. A fresh marker still passes through the chained shape — the gate is
#     matching MORE commands, not blocking unconditionally.
run_case "git push && gh pr create passes with a fresh marker" 0 fresh "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git push && gh pr create --title x"}}' "$side_repo")"

# 18. A quoted mention AFTER a chain operator must still pass: this is the
#     case where stripping quoted spans is doing the work, since position
#     alone no longer saves us.
run_case "chained echo quoting 'gh pr merge' still passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git status && echo \"then: gh pr merge --squash\""}}' "$side_repo")"

# --- Repo opt-in scope (mirrors branch-gate.sh) ------------------------------
# A repo with no `.markgate.yml` at its top level is not a markgate repo: the
# gate must pass through rather than demand a marker the repo cannot have.
# Without this the gate blocked commits in unrelated checkouts a session
# happened to touch.
plain_repo="$TMPDIR/plain-repo"
git init -q -b feature/y "$plain_repo"
git -C "$plain_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
run_case "repo without .markgate.yml passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr create --fill"}}' "$plain_repo")"

# --- Unexpanded target (go-to-k/cdkd#2027) -----------------------------------
# The hand-rolled `gh -C` scan this gate used to carry resolved `gh -C "$W"` to
# the literal `<cwd>/$W`, failed the repo probe, and exited 0 -- so the PR gate
# was bypassed by the same worktree spelling the instructions recommend. Both
# cases returned 0 against the pre-fix hook.
run_case "unexpanded gh -C on pr merge REFUSED" 2 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh -C \\"$W\\" pr merge 42 --squash"}}' "$main_repo")"

run_case "unexpanded gh -C on pr create REFUSED" 2 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh -C \\"$W\\" pr create --title x"}}' "$main_repo")"

# An unresolvable `cd` is equally unreadable and equally refused.
run_case "unexpanded cd before gh pr merge REFUSED" 2 fresh "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd \\"$W\\" && gh pr merge 42 --squash"}}' "$main_repo")"

# --- WHICH GATE did the hook ask markgate about? ---------------------------
# The fourth blind spot, and the one no other case here covers. Every assertion
# above is about the exit code or the cwd; none is about the QUESTION asked.
# Mutating `verify verify-pr` to `verify check` leaves all of them green, and
# that mutant passes whenever `/check` alone is fresh -- i.e. it merges a PR
# whose `/verify-pr` checklist was never run.
: > "$ARGS_TRACE_FILE"
MARKGATE_MOCK_VERDICT=fresh
export MARKGATE_MOCK_VERDICT
printf '%s' "$(jq -n --arg c "gh pr create --title t" --arg d "$main_repo" \
  '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')" \
  | bash "$HOOK" >/dev/null 2>&1
# --- SHA BINDING (go-to-k/cdkd#2686) ----------------------------------------
#
# A FRESH marker is not sufficient. `verify-pr` has no `include:` of its own, so
# once set in a worktree it never stales by itself -- it is only MASKED by a
# stale child, and `/check` + `/check-docs` un-mask it. In the IN-PLACE worktree
# mode CLAUDE.md prescribes, lane N then inherits lane N-1's green. Measured
# twice a day apart, in different worktrees.
#
# Every case below is FRESH; only the sentinel varies. That is the point -- the
# marker state cannot tell them apart, so whatever separates them is the
# binding doing the work.
side_payload='{"cwd":"'"$side_repo"'","tool_input":{"command":"gh pr create"}}'
merge_payload='{"cwd":"'"$side_repo"'","tool_input":{"command":"gh pr merge 1 --squash"}}'
real_sha=$(git -C "$side_repo" rev-parse HEAD)

printf '%s' "0000000000000000000000000000000000000000" > "$side_repo/.markgate-verify-pr-sha"
run_case "fresh marker + FOREIGN sha REFUSED (pr create)" 2 fresh "" "$side_payload"
run_case "fresh marker + FOREIGN sha REFUSED (pr merge)" 2 fresh "" "$merge_payload"

# The message must NOT say "stale": the marker is fresh, and sending the reader
# to /check for a problem no child has is how a real block gets worked around.
foreign_msg=$(printf '%s' "$side_payload" | MARKGATE_MOCK_VERDICT=fresh "$HOOK" 2>&1 >/dev/null)
if printf '%s' "$foreign_msg" | grep -q 'bound to a different commit' \
   && printf '%s' "$foreign_msg" | grep -q "$real_sha" \
   && ! printf '%s' "$foreign_msg" | grep -q 'marker is stale'; then
  pass=$((pass + 1)); printf 'OK   foreign-sha block names the binding, not staleness\n'
else
  fail=$((fail + 1)); fail_log+="FAIL foreign-sha message: $foreign_msg\n"
  printf 'FAIL foreign-sha block message\n'
fi

rm -f "$side_repo/.markgate-verify-pr-sha"
run_case "fresh marker + MISSING sentinel REFUSED" 2 fresh "" "$side_payload"

# The CONTROL. Without it every case above is satisfied by a gate that stopped
# passing anything at all.
printf '%s' "$real_sha" > "$side_repo/.markgate-verify-pr-sha"
run_case "fresh marker + MATCHING sha passes" 0 fresh "" "$side_payload"

# A trailing newline must be tolerated: `git rev-parse HEAD > file` writes one,
# and that is the command the skill documents.
printf '%s\n' "$real_sha" > "$side_repo/.markgate-verify-pr-sha"
run_case "sentinel with a trailing newline still matches" 0 fresh "" "$side_payload"

# An UNREADABLE HEAD must block, and this is why the `[ -n "$head_sha" ]` guard
# is not redundant: in a repo with no commits `git rev-parse HEAD` fails, so
# `head_sha` is empty -- and with no sentinel `recorded_sha` is empty too.
# Without the guard the comparison is `"" = ""`, which PASSES. A fail-open, in
# the gate whose whole job is refusing. Measured: dropping the guard left the
# suite at 30/30 green.
empty_repo="$TMPDIR/empty-repo"
git init -q -b main "$empty_repo"
touch "$empty_repo/.markgate.yml"
empty_payload='{"cwd":"'"$empty_repo"'","tool_input":{"command":"gh pr create"}}'
run_case "fresh marker + UNREADABLE head REFUSED" 2 fresh "" "$empty_payload"

# And the degenerate match the bare `git rev-parse HEAD` spelling would allow:
# in a repo with no commits it prints the literal string `HEAD` on STDOUT, so a
# sentinel containing `HEAD` would COMPARE EQUAL and the gate would pass. With
# `--verify` the read yields nothing and the `-n` guard refuses. Contrived, but
# it is what makes the spelling testable rather than a matter of taste.
printf '%s' "HEAD" > "$empty_repo/.markgate-verify-pr-sha"
run_case "sentinel literally 'HEAD' in an empty repo REFUSED" 2 fresh "" "$empty_payload"
rm -f "$empty_repo/.markgate-verify-pr-sha"

# STALE + matching sha still blocks: the two conditions are ANDed.
run_case "stale marker + MATCHING sha still REFUSED" 2 stale "" "$side_payload"

unset MARKGATE_MOCK_VERDICT
if grep -qE '(^| )verify-pr( |$)' "$ARGS_TRACE_FILE"; then
  echo "ok   markgate was asked about the verify-pr gate specifically"
  pass=$((pass + 1))
else
  echo "FAIL markgate was never asked about verify-pr (asked: $(tr '\n' ';' < "$ARGS_TRACE_FILE"))"
  fail=$((fail + 1))
fi

echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
