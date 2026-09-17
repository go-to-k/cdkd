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
#
# WHY THE SUBJECT IS AN INSTALLED COPY, NOT THE FILE IN THIS DIRECTORY
# (go-to-k/cdkd#3209). The gate now asks whether the TARGET repo is the repo
# the HOOK FILE lives in, and requires the `.markgate-verify-pr-sha` binding
# only then. Run from `.claude/hooks/`, the subject's repo is always cdkd and
# every throwaway fixture below is FOREIGN to it -- so every sha-binding case
# would silently switch to exercising the relaxed path, and the cases pinning
# go-to-k/cdkd#2686 would pass for the wrong reason. `install_hook <dir>` copies
# the real subject (plus the shared library it sources) into a fixture, so a
# case states its repo identity by CHOOSING WHICH COPY IT RUNS. The copy is made
# at run time from the real path and the copy is fatal if it fails, so the
# subject can never be stale; what it does not cover is the real file's own
# location, which is the same three lines of `${BASH_SOURCE[0]%/*}` either way.

set -u

# HERMETIC ENVIRONMENT. The gate reads `GH_REPO` from its own env, and this
# suite runs the subject as a child, so it inherits whatever the caller
# exported. Measured: with `GH_REPO=x` exported the suite reported 69/10 —
# every relaxation case refused, for a reason no case names. `GH_HOST` is the
# same shape (gh's other repo-resolution variable) and is unset for the same
# reason. The env-clause case below sets `GH_REPO` back, deliberately and for
# one invocation only.
unset GH_REPO GH_HOST

HOOK_REAL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify-pr-gate.sh"
LIB_REAL="$(dirname "$HOOK_REAL")/lib/command-match.sh"
[ -f "$HOOK_REAL" ] || { echo "subject missing: $HOOK_REAL" >&2; exit 1; }
[ -f "$LIB_REAL" ] || { echo "shared library missing: $LIB_REAL" >&2; exit 1; }

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# install_hook <dir> -> prints the path of the installed copy.
# The copy lands at `<dir>/.claude/hooks/`, mirroring the real layout, so the
# hook's own `${BASH_SOURCE[0]%/*}/lib/command-match.sh` resolves.
# The `exit 1`s here only leave the COMMAND SUBSTITUTION the callers wrap this
# in, so each caller re-checks with `require_hook` below: an empty `$HOOK` would
# otherwise run as an empty command word, and `127` is not an exit code any case
# expects, which reds them all for a reason none of them names.
install_hook() {
  local dest="$1/.claude/hooks"
  mkdir -p "$dest/lib" || { echo "install_hook: mkdir failed for $dest" >&2; exit 1; }
  cp "$HOOK_REAL" "$dest/verify-pr-gate.sh" || { echo "install_hook: cp hook failed" >&2; exit 1; }
  cp "$LIB_REAL" "$dest/lib/command-match.sh" || { echo "install_hook: cp lib failed" >&2; exit 1; }
  chmod +x "$dest/verify-pr-gate.sh" || { echo "install_hook: chmod failed" >&2; exit 1; }
  printf '%s\n' "$dest/verify-pr-gate.sh"
}

require_hook() {
  [ -n "$1" ] && [ -x "$1" ] && return 0
  echo "install_hook produced no runnable subject ('$1') -- every case below would" >&2
  echo "report exit 127 rather than the gate's verdict." >&2
  exit 1
}

side_repo="$TMPDIR/side-repo"
main_repo="$TMPDIR/main-repo"
git init -q -b feature/x "$side_repo"
# A REMOTE, because since go-to-k/cdkd#3351 repo identity is settled on the slug
# and a checkout with none cannot be identified at all. Every real cdkd worktree
# has an `origin`; a bare `git init` was standing in for one and made the
# fixture unrepresentative of the thing it models.
git -C "$side_repo" remote add origin https://github.com/go-to-k/cdkd.git
git -C "$side_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
# A SECOND commit, so the "foreign" sha below is a REAL object in this repo and
# an ANCESTOR of HEAD -- which is exactly what a previous lane's sentinel holds.
# With `0000...0000` the two relaxations that reproduce the original defect
# (accept any resolvable commit; accept any ancestor of HEAD) both passed 32/32
# green: the fixture did not resemble the attack (go-to-k/cdkd#2686 test review).
side_prev=$(git -C "$side_repo" rev-parse HEAD)
git -C "$side_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m second
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

# The DEFAULT subject lives in `side_repo`, so every case below targeting
# `side_repo` (or a linked worktree of it) is a SAME-REPO case and still owes
# the sha binding -- which is what the pre-#3209 suite was written to test and
# what go-to-k/cdkd#2686 must not regress. `main_repo` is a separate repository,
# so it is FOREIGN to this copy; no case targeting it asserts the binding (they
# assert cwd resolution and matcher behaviour), and each is annotated where that
# now matters.
HOOK="$(install_hook "$side_repo")"
require_hook "$HOOK"

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

# run_case <name> <expect_exit> <mg_verdict> <expect_cwd> <stdin_json> [hook]
#
# The optional sixth argument names WHICH installed copy of the subject to run,
# and therefore which repository the gate considers its own (go-to-k/cdkd#3209).
# It defaults to `$HOOK`, the copy in `side_repo`.
run_case() {
  local name="$1"; local want="$2"; local verdict="$3"; local expect_cwd="$4"; local payload="$5"
  local hook="${6:-$HOOK}"
  : > "$CWD_TRACE_FILE"
  local got
  printf '%s' "$payload" | MARKGATE_MOCK_VERDICT="$verdict" "$hook" >/dev/null 2>&1
  got=$?

  local cwd_ok=1
  if [ -n "$expect_cwd" ]; then
    # Compare PHYSICAL paths on both sides. The hook `cd -P`s (so a `..` after a
    # symlink cannot land it in a different tree than git's chdir), and on macOS
    # `/var` is a symlink to `/private/var` -- so the trace holds the resolved
    # path while the fixture variable holds the logical one. This used to match
    # only by coincidence (go-to-k/cdkd#2686 round-3 review).
    local want_phys; want_phys=$(cd "$expect_cwd" 2>/dev/null && pwd -P)
    if ! grep -qFx "${want_phys:-$expect_cwd}" "$CWD_TRACE_FILE" 2>/dev/null; then
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

# 9a-9f. A FLAG BETWEEN `pr` AND THE VERB (go-to-k/cdkd#3242).
#
# `gh` takes `-R` / `--repo` in either slot and resolves the repo from it
# identically -- measured on gh 2.92.0 from a directory that is not a repo,
# `gh pr -R go-to-k/cdkd view 3214` answered the cdkd PR. This gate saw only the
# slot LEFT of `pr`, so moving the flag three words right dropped it entirely:
# measured through the real hook in the cdkd worktree with the markers stale,
# `gh pr merge 3242 --squash` gave rc=2 and `gh pr -R go-to-k/cdkd merge 3242
# --squash` gave rc=0. Every one of these passes (rc=0) against the pre-#3242
# library and blocks here; case 9 above is their unshifted control.
#
# EACH ASSERTS THE TARGET DIR TOO, not just the refusal. The flag value is an
# owner/repo SLUG sitting exactly where `-C` puts a PATH, so a resolver that
# started reading it would send `markgate verify` to a directory that is not
# this worktree -- the go-to-k/cdkd#2027 wrong-tree class, which an exit code
# alone cannot distinguish from the gate working.
run_case "gh pr -R <slug> merge: gated, and the slug is not a target dir" 2 stale "$main_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr -R go-to-k/cdkd merge 42 --squash"}}' "$main_repo")"
run_case "gh pr --repo <slug> merge: gated" 2 stale "$main_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr --repo go-to-k/cdkd merge 42 --squash"}}' "$main_repo")"
run_case "gh pr -R=<slug> merge: gated" 2 stale "$main_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr -R=go-to-k/cdkd merge 42 --squash"}}' "$main_repo")"
run_case "gh pr -R<slug> merge (glued): gated" 2 stale "$main_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr -Rgo-to-k/cdkd merge 42 --squash"}}' "$main_repo")"
run_case "gh pr -R <slug> create: gated" 2 stale "$main_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr -R go-to-k/cdkd create --title x"}}' "$main_repo")"
# ...and the cd-prefixed spelling still steers the marker store, so the two
# resolutions compose rather than one disabling the other.
run_case "cd <side> && gh pr -R <slug> merge: side still wins" 2 stale "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd %s && gh pr -R go-to-k/cdkd merge 42"}}' "$main_repo" "$side_repo")"
# POLARITY. The absorber lets ANY token follow the first flag, so the only thing
# keeping read-only gh work out of this gate is that the verb alternation holds
# `create|merge` alone. If that ever widens, these red.
run_case "gh pr -R <slug> view passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr -R go-to-k/cdkd view 42"}}' "$side_repo")"
run_case "gh pr -R <slug> list passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr -R go-to-k/cdkd list"}}' "$side_repo")"
run_case "gh pr -R <slug> edit passes through (not this gate's verb)" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr -R go-to-k/cdkd edit 42"}}' "$side_repo")"

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

# The foreign sha is the PREVIOUS commit of this same repo: a real object, an
# ancestor of HEAD, and reachable -- the shape a stale lane sentinel actually
# has. A non-object like `0000...0000` lets "accept any commit that resolves"
# and "accept any ancestor" pass, and those ARE the defect.
printf '%s' "$side_prev" > "$side_repo/.markgate-verify-pr-sha"
run_case "fresh marker + a REAL earlier commit REFUSED (pr create)" 2 fresh "" "$side_payload"
run_case "fresh marker + a REAL earlier commit REFUSED (pr merge)" 2 fresh "" "$merge_payload"

# And a sha that is not an object at all, so neither shape is the only one
# covered.
printf '%s' "0000000000000000000000000000000000000000" > "$side_repo/.markgate-verify-pr-sha"
run_case "fresh marker + a NON-OBJECT sha REFUSED" 2 fresh "" "$side_payload"

# The message must NOT say "stale": the marker is fresh, and sending the reader
# to /check for a problem no child has is how a real block gets worked around.
printf '%s' "$side_prev" > "$side_repo/.markgate-verify-pr-sha"
foreign_msg=$(printf '%s' "$side_payload" | MARKGATE_MOCK_VERDICT=fresh "$HOOK" 2>&1 >/dev/null)
# The LABELS must be on the right shas, not merely present: grepping that
# `$real_sha` appears somewhere passed a full swap of both lines (measured).
if printf '%s' "$foreign_msg" | grep -q 'bound to a different commit' \
   && printf '%s' "$foreign_msg" | grep -qE "HEAD is: +$real_sha" \
   && printf '%s' "$foreign_msg" | grep -qE "marker bound to: +$side_prev" \
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

# The sentinel is read from the repo TOP, not the cwd. `gh pr create` run from a
# subdirectory must still find it -- the hook's own comment claims this and
# nothing tested it: reading from the cwd instead passed 32/32 (measured,
# go-to-k/cdkd#2686 test review).
printf '%s' "$real_sha" > "$side_repo/.markgate-verify-pr-sha"
mkdir -p "$side_repo/sub/deeper"
sub_payload='{"cwd":"'"$side_repo"'/sub/deeper","tool_input":{"command":"gh pr create"}}'
run_case "sentinel found from a SUBDIRECTORY" 0 fresh "" "$sub_payload"
# And the mismatch is still caught from there, or the case above is satisfied by
# a gate that stopped reading the sentinel at all.
printf '%s' "$side_prev" > "$side_repo/.markgate-verify-pr-sha"
run_case "mismatch still caught from a SUBDIRECTORY" 2 fresh "" "$sub_payload"
printf '%s' "$real_sha" > "$side_repo/.markgate-verify-pr-sha"

# The sha followed by junk. What refuses it is reading the file WHOLE: a capped
# read would see only the sha. (There is no read cap; the 128-byte gate is on
# SIZE, and the case below pins that separately.)
{ printf '%s' "$real_sha"; printf '%*s' 60 ''; printf 'TAILJUNK'; } \
  > "$side_repo/.markgate-verify-pr-sha"
run_case "sha followed by junk is REFUSED (whole-file read)" 2 fresh "" "$side_payload"

# THE SIZE CAP, which a reviewer proved is load-bearing on its own: the sha
# followed by 100 spaces strips back to a well-formed sha, so ONLY the size gate
# refuses it. Nothing covered this while the code claimed the cap changed no
# verdict.
{ printf '%s' "$real_sha"; printf '%*s' 100 ''; } > "$side_repo/.markgate-verify-pr-sha"
run_case "sha padded past the SIZE CAP is REFUSED" 2 fresh "" "$side_payload"

# The HEX and LENGTH checks are redundant with the comparison -- `head_sha` is
# always lowercase 40-hex, so a malformed value can never compare equal. What
# they buy is a legible REASON, so that is what these two assert: the block must
# name the sentinel as malformed rather than printing the junk or claiming it is
# unset. Inputs chosen so exactly one check catches each.
printf '%s' "0123456789abcdef0123456789abcdef0123456z" > "$side_repo/.markgate-verify-pr-sha"
run_case "40 chars with a non-hex byte REFUSED" 2 fresh "" "$side_payload"
nonhex_msg=$(printf '%s' "$side_payload" | MARKGATE_MOCK_VERDICT=fresh "$HOOK" 2>&1 >/dev/null)
if printf '%s' "$nonhex_msg" | grep -q 'present but unreadable or malformed'; then
  pass=$((pass + 1)); printf 'OK   a malformed sentinel is named as such, not as unset\n'
else
  fail=$((fail + 1)); fail_log+="FAIL malformed-sentinel label: $nonhex_msg\n"
  printf 'FAIL malformed-sentinel label\n'
fi

printf '%s' "$(printf '%s' "$real_sha" | cut -c1-12)" > "$side_repo/.markgate-verify-pr-sha"
run_case "an all-hex ABBREVIATED sha REFUSED" 2 fresh "" "$side_payload"
abbrev_msg=$(printf '%s' "$side_payload" | MARKGATE_MOCK_VERDICT=fresh "$HOOK" 2>&1 >/dev/null)
if printf '%s' "$abbrev_msg" | grep -q 'present but unreadable or malformed'; then
  pass=$((pass + 1)); printf 'OK   a short all-hex sentinel is named malformed, not printed raw\n'
else
  fail=$((fail + 1)); fail_log+="FAIL abbreviated-sentinel label: $abbrev_msg\n"
  printf 'FAIL abbreviated-sentinel label\n'
fi

# A MISSING sentinel must still read as unset, or the label above is satisfied
# by a hook that calls everything malformed.
rm -f "$side_repo/.markgate-verify-pr-sha"
missing_msg=$(printf '%s' "$side_payload" | MARKGATE_MOCK_VERDICT=fresh "$HOOK" 2>&1 >/dev/null)
if printf '%s' "$missing_msg" | grep -q '<unset>' \
   && ! printf '%s' "$missing_msg" | grep -q 'malformed'; then
  pass=$((pass + 1)); printf 'OK   a MISSING sentinel is named unset, not malformed\n'
else
  fail=$((fail + 1)); fail_log+="FAIL missing-sentinel label: $missing_msg\n"
  printf 'FAIL missing-sentinel label\n'
fi
printf '%s' "$real_sha" > "$side_repo/.markgate-verify-pr-sha"

# An UNREADABLE HEAD must block, and this is why the `[ -n "$head_sha" ]` guard
# is not redundant: in a repo with no commits `git rev-parse HEAD` fails, so
# `head_sha` is empty -- and with no sentinel `recorded_sha` is empty too.
# Without the guard the comparison is `"" = ""`, which PASSES. A fail-open, in
# the gate whose whole job is refusing. Measured: dropping the guard left the
# suite at 30/30 green.
empty_repo="$TMPDIR/empty-repo"
git init -q -b main "$empty_repo"
touch "$empty_repo/.markgate.yml"
# The subject for these cases is installed INSIDE `empty_repo`, so the target is
# the gate's OWN repo and the binding is still owed (go-to-k/cdkd#3209). Run
# against `side_repo`'s copy these would be foreign-target cases, which clear on
# the marker alone -- so the guard below would look unfenced.
HOOK_EMPTY="$(install_hook "$empty_repo")"
require_hook "$HOOK_EMPTY"
empty_payload='{"cwd":"'"$empty_repo"'","tool_input":{"command":"gh pr create"}}'
run_case "fresh marker + UNREADABLE head REFUSED" 2 fresh "" "$empty_payload" "$HOOK_EMPTY"

# ...and must say WHY. With both shas empty the old `!=` guard was false, so a
# FRESH marker fell through to "the marker is stale (or missing)" -- the exact
# misdirection the branch exists to prevent (measured; both reviews found it).
empty_msg=$(printf '%s' "$empty_payload" | MARKGATE_MOCK_VERDICT=fresh "$HOOK_EMPTY" 2>&1 >/dev/null)
if printf '%s' "$empty_msg" | grep -q 'bound to a different commit' \
   && ! printf '%s' "$empty_msg" | grep -q 'marker is stale'; then
  pass=$((pass + 1)); printf 'OK   unreadable-head block names the binding, not staleness\n'
else
  fail=$((fail + 1)); fail_log+="FAIL unreadable-head message: $empty_msg\n"
  printf 'FAIL unreadable-head block message\n'
fi

# And the degenerate match the bare `git rev-parse HEAD` spelling would allow:
# in a repo with no commits it prints the literal string `HEAD` on STDOUT, so a
# sentinel containing `HEAD` would COMPARE EQUAL and the gate would pass. With
# `--verify` the read yields nothing and the `-n` guard refuses. Contrived, but
# it is what makes the spelling testable rather than a matter of taste.
printf '%s' "HEAD" > "$empty_repo/.markgate-verify-pr-sha"
run_case "sentinel literally 'HEAD' in an empty repo REFUSED" 2 fresh "" "$empty_payload" "$HOOK_EMPTY"
rm -f "$empty_repo/.markgate-verify-pr-sha"

# STALE + matching sha still blocks: the two conditions are ANDed.
run_case "stale marker + MATCHING sha still REFUSED" 2 stale "" "$side_payload"

# --- REPO IDENTITY: WHOSE repo owes the binding? (go-to-k/cdkd#3209) ---------
#
# The sentinel is a cdkd-only device. cdk-local and cdk-real-drift both carry a
# `.markgate.yml` (so they are inside this gate's opt-in scope) and NEITHER has
# ever written `.markgate-verify-pr-sha`, so a mirror PR in either -- the one
# `references/retro.md` 10-c MANDATES a cdkd session to open -- was refused by a
# block no legitimate action could clear. The binding is now required only when
# the target repo is the repo the HOOK FILE lives in; `markgate verify
# verify-pr` is still required everywhere, so cdkd's POLICY still reaches a
# sibling while cdkd's MECHANISM stops being demanded of a repo that has none.
#
# Every case here is FRESH unless it says otherwise, exactly as the block above:
# the marker state cannot separate them, so whatever does is the identity test.

# `--git-common-dir`, canonicalised, is the value the gate compares. Asserting
# the fixtures' identities OUT LOUD keeps the cases from going vacuous: a
# "foreign" repo that quietly shared a common dir, or a worktree that quietly
# did not, would still produce the expected exit codes for the WRONG reason.
common_of() {
  local __c
  __c=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  (cd "$__c" 2>/dev/null && pwd -P)
}

foreign_repo="$TMPDIR/foreign-repo"
git init -q -b feature/z "$foreign_repo"
# A SIBLING's remote. It is INERT for the verdict -- measured: removing it
# changes no case, because a target with NO remote relaxes anyway. It is here so
# the fixture RESEMBLES a real sibling checkout, not because the slug test needs
# it; `side_repo`'s remote IS load-bearing (removing that one reds 18 cases).
# Said plainly because the first version of this comment claimed the opposite.
git -C "$foreign_repo" remote add origin https://github.com/go-to-k/cdk-local.git
git -C "$foreign_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
touch "$foreign_repo/.markgate.yml"
# NO sentinel -- this IS the siblings' state, not a contrivance.
rm -f "$foreign_repo/.markgate-verify-pr-sha"
foreign_payload='{"cwd":"'"$foreign_repo"'","tool_input":{"command":"gh pr create --title x"}}'

# A LINKED WORKTREE of the subject's own repo. This is the go-to-k/cdkd#559
# property: markgate markers are per-worktree, but repo IDENTITY is deliberately
# worktree-invariant, so a cdkd worktree must stay a SAME-repo target and keep
# owing the binding. Swapping `--git-common-dir` for `--git-dir` in the gate is
# exactly the mutation this case exists to catch.
side_wt="$TMPDIR/side-worktree"
git -C "$side_repo" worktree add -q -b wt-lane "$side_wt" >/dev/null 2>&1
touch "$side_wt/.markgate.yml"
rm -f "$side_wt/.markgate-verify-pr-sha"
wt_payload='{"cwd":"'"$side_wt"'","tool_input":{"command":"gh pr create --title x"}}'
wt_head=$(git -C "$side_wt" rev-parse HEAD 2>/dev/null || echo "")

# The subject installed OUTSIDE any git repo: its own repo is unresolvable, so
# the gate must FAIL CLOSED and keep demanding the sentinel.
vendor_dir="$TMPDIR/vendored"
mkdir -p "$vendor_dir"
HOOK_VENDORED="$(install_hook "$vendor_dir")"
require_hook "$HOOK_VENDORED"

identity_ok=1
identity_why=""
if [ ! -d "$side_wt" ]; then
  identity_ok=0; identity_why="the linked worktree fixture was not created"
elif [ "$(common_of "$side_repo")" = "$(common_of "$foreign_repo")" ]; then
  identity_ok=0; identity_why="the 'foreign' repo shares the subject's common dir"
elif [ "$(common_of "$side_wt")" != "$(common_of "$side_repo")" ]; then
  identity_ok=0; identity_why="the linked worktree does not share the subject's common dir"
elif git -C "$vendor_dir/.claude/hooks" rev-parse --git-dir >/dev/null 2>&1; then
  identity_ok=0; identity_why="the 'vendored' copy resolves to a git repo ($TMPDIR is inside one)"
elif [ -z "$wt_head" ]; then
  identity_ok=0; identity_why="the linked worktree has no readable HEAD"
fi
if [ "$identity_ok" -eq 1 ]; then
  pass=$((pass + 1)); printf 'OK   identity fixtures hold their premises\n'
else
  fail=$((fail + 1)); fail_log+="FAIL identity fixtures: $identity_why\n"
  printf 'FAIL identity fixtures: %s\n' "$identity_why"
fi

# 1. SAME repo, fresh, sentinel == HEAD -> pass. The CONTROL for this whole
#    section: without it every refusal below is satisfied by a gate that stopped
#    passing anything.
printf '%s' "$real_sha" > "$side_repo/.markgate-verify-pr-sha"
run_case "identity SAME + fresh + matching sentinel passes" 0 fresh "" "$side_payload"

# 2. SAME repo, fresh, sentinel ABSENT -> still BLOCKS. This is the
#    go-to-k/cdkd#2686 property, and the one the relaxation could most easily
#    take with it.
rm -f "$side_repo/.markgate-verify-pr-sha"
run_case "identity SAME + fresh + NO sentinel still REFUSED" 2 fresh "" "$side_payload"

# 3. SAME repo, fresh, sentinel present but a DIFFERENT sha -> still blocks.
printf '%s' "$side_prev" > "$side_repo/.markgate-verify-pr-sha"
run_case "identity SAME + fresh + FOREIGN sha still REFUSED" 2 fresh "" "$side_payload"
printf '%s' "$real_sha" > "$side_repo/.markgate-verify-pr-sha"

# 4. FOREIGN repo, fresh, sentinel absent -> PASSES. The defect this change
#    fixes: the mirror PR in a sibling repo becomes openable.
run_case "identity FOREIGN + fresh + NO sentinel PASSES" 0 fresh "$foreign_repo" "$foreign_payload"

# 5. FOREIGN repo, STALE marker -> still blocks. cdkd's POLICY is not relaxed,
#    only its sentinel MECHANISM, and a refusal here is one the target repo's
#    own `/verify-pr` can clear.
run_case "identity FOREIGN + STALE marker still REFUSED" 2 stale "$foreign_repo" "$foreign_payload"

# ...and it must be refused as STALE, not as a binding problem: sending a
# sibling lane to a sentinel it cannot write is the whole defect.
foreign_stale_msg=$(printf '%s' "$foreign_payload" | MARKGATE_MOCK_VERDICT=stale "$HOOK" 2>&1 >/dev/null)
if printf '%s' "$foreign_stale_msg" | grep -q 'marker is stale' \
   && ! printf '%s' "$foreign_stale_msg" | grep -q 'bound to a different commit'; then
  pass=$((pass + 1)); printf 'OK   foreign-target refusal names staleness, not the binding\n'
else
  fail=$((fail + 1)); fail_log+="FAIL foreign-target stale message: $foreign_stale_msg\n"
  printf 'FAIL foreign-target stale message\n'
fi

# 6. IDENTITY UNRESOLVABLE -> blocks. The subject runs from outside any git
#    repo, so its own common dir cannot be read; an unresolvable identity must
#    never take the relaxed path.
run_case "identity UNRESOLVABLE fails CLOSED (sentinel still required)" 2 fresh "" \
  "$foreign_payload" "$HOOK_VENDORED"

# ...with the control that proves the vendored copy is still a working gate
# rather than a crash: give the target a matching sentinel and it passes.
git -C "$foreign_repo" rev-parse HEAD > "$foreign_repo/.markgate-verify-pr-sha"
run_case "identity UNRESOLVABLE + matching sentinel passes" 0 fresh "" \
  "$foreign_payload" "$HOOK_VENDORED"
rm -f "$foreign_repo/.markgate-verify-pr-sha"

# 7. A LINKED WORKTREE of the subject's repo is the SAME repo: per-worktree
#    marker isolation (go-to-k/cdkd#559) is untouched, and the binding is still
#    owed there. Fresh marker, no sentinel in the worktree root -> blocks.
run_case "identity WORKTREE of own repo still owes the sentinel" 2 fresh "$side_wt" "$wt_payload"

# ...and the control: the worktree's OWN sentinel clears it, so the refusal
# above is the binding and not the worktree being unreadable.
printf '%s' "$wt_head" > "$side_wt/.markgate-verify-pr-sha"
run_case "identity WORKTREE with its own matching sentinel passes" 0 fresh "$side_wt" "$wt_payload"
rm -f "$side_wt/.markgate-verify-pr-sha"

# --- The identity is the RESOLVED TARGET's, not the payload cwd's ------------
#
# Nothing above separates the two: every case so far runs in the directory it
# judges, or is stale (refused before identity matters). A mutant reading
# `${hook_cwd:-$PWD}` instead of `$target_dir` therefore survived the WHOLE
# suite -- and it is a live bypass in exactly the two spellings CLAUDE.md
# prescribes: `gh -C <own repo>` and `cd <own repo> && gh ...` issued from a
# sibling checkout would take the relaxed path and drop the binding. Both
# directions, both spellings, all FRESH so only the identity can separate them.
rm -f "$side_repo/.markgate-verify-pr-sha"
run_case "cwd FOREIGN, gh -C targets own repo: binding still owed" 2 fresh "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh -C %s pr create --title x"}}' "$foreign_repo" "$side_repo")"
run_case "cwd FOREIGN, cd into own repo: binding still owed" 2 fresh "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd %s && gh pr create --title x"}}' "$foreign_repo" "$side_repo")"
printf '%s' "$real_sha" > "$side_repo/.markgate-verify-pr-sha"
# ...and the mirror image, which is what stops the two cases above from being
# satisfied by a gate that simply stopped relaxing.
run_case "cwd OWN repo, gh -C targets a foreign repo: relaxed" 0 fresh "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh -C %s pr create --title x"}}' "$side_repo" "$foreign_repo")"
run_case "cwd OWN repo, cd into a foreign repo: relaxed" 0 fresh "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd %s && gh pr create --title x"}}' "$side_repo" "$foreign_repo")"

# --- A command that names ANOTHER repo must not take the relaxed path --------
#
# The relaxation is sound only while "the directory the command runs in" and
# "the repo the PR lives in" are the same thing. Every spelling below decouples
# them, and each was MEASURED to reach gh: the first two took a foreign target
# from 2 to 0 before any guard existed, and the other five defeated the
# denylist that closed those two. They are cases rather than a list in a comment
# because the guard that replaced it is an allowlist -- it must keep refusing
# all of them AND keep clearing the ordinary command, and only the pair of
# directions says it does.
foreign_gh() {
  printf '{"cwd":"%s","tool_input":{"command":"%s"}}' "$foreign_repo" "$1"
}
run_case "FOREIGN + gh pr merge --repo: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh pr merge 42 --squash --repo go-to-k/cdkd')"
run_case "FOREIGN + gh -R before the verb: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh -R go-to-k/cdkd pr merge 42 --squash')"
run_case "FOREIGN + a QUOTED -R value: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh -R \"go-to-k/cdkd\" pr merge 42 --squash')"
run_case "FOREIGN + --repo=<slug>: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh pr merge 42 --squash --repo=go-to-k/cdkd')"
run_case "FOREIGN + a GLUED -R<slug>: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh pr merge 42 --squash -Rgo-to-k/cdkd')"
# The flag NAME quoted, which is what defeated the stripped-text denylist: the
# whole span was deleted, flag and all.
run_case "FOREIGN + a QUOTED -R FLAG NAME: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh pr merge 42 --squash \"--repo\" go-to-k/cdkd')"
run_case "FOREIGN + a SPLIT flag name --re\"po\": NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh pr merge 42 --squash --re\"po\" go-to-k/cdkd')"
# `GH_REPO` needs no flag at all, and gh honours it over the local repo. Three
# carriers: a leading assignment (stripped before the segment is read), an
# `env` prefix with the assignment QUOTED (invisible to any stripped-text
# test), and an `export` in an EARLIER segment (which a per-segment walk never
# visits).
run_case "FOREIGN + a leading GH_REPO= assignment: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'GH_REPO=go-to-k/cdkd gh pr merge 42 --squash')"
run_case "FOREIGN + an env GH_REPO= prefix: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'env GH_REPO=go-to-k/cdkd gh pr merge 42 --squash')"
run_case "FOREIGN + export GH_REPO in an EARLIER segment: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'export GH_REPO=go-to-k/cdkd; gh pr merge 42 --squash')"
# A URL selector needs no flag and no variable: gh resolves the repo from it.
run_case "FOREIGN + a PR URL selector: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh pr merge https://github.com/go-to-k/cdkd/pull/42 --squash')"
# ...and QUOTED, which is how an agent pastes one. The first version of this
# guard exempted any token carrying a quote character from the URL test, so
# both of these resolved FOREIGN and PASSED -- the whole cross-repo merge hole,
# still open through one pair of quotes (measured rc=0 against the real hook
# while the bare form above returned 2).
run_case "FOREIGN + a DOUBLE-QUOTED PR URL selector: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh pr merge \"https://github.com/go-to-k/cdkd/pull/42\" --squash')"
run_case "FOREIGN + a SINGLE-QUOTED PR URL selector: NOT relaxed" 2 fresh "" \
  "$(foreign_gh "gh pr merge 'https://github.com/go-to-k/cdkd/pull/42' --squash")"
# A scheme-less `github.com/<o>/<r>/pull/<n>`. This pins an OVER-REFUSAL, not a
# live selector shape: measured on gh 2.92.0, gh does NOT accept it -- with no
# scheme it falls back to treating the argument as a branch and errors out. The
# `*/pull/[0-9]*` half of the test refuses it anyway, which is the fail-closed
# direction, and the case exists so that stays deliberate rather than becoming a
# surprise when someone narrows the pattern to `*://*`.
run_case "FOREIGN + a scheme-less /pull/<n> (over-refusal, pinned): NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh pr merge github.com/go-to-k/cdkd/pull/42 --squash')"

# A SELECTOR CAN CARRY TRAILING WHITESPACE AND GH STILL RESOLVES IT. gh
# `url.Parse`s the argument and PREFIX-matches `^/OWNER/REPO/pull/(\d+)`, so
# anything after the number is ignored. Measured on gh 2.92.0 from a non-repo
# directory -- `gh pr view <sel> --json url` returned cdkd's PR for every one of
# these, and each took the RELAXED path while the test read the whole token.
run_case "FOREIGN + a selector with ONE TRAILING SPACE: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh pr merge \"https://github.com/go-to-k/cdkd/pull/42 \" --squash')"
run_case "FOREIGN + a selector with a QUERY carrying a space: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh pr merge \"https://github.com/go-to-k/cdkd/pull/42?x=a b\" --squash')"
run_case "FOREIGN + a selector with an EXTRA PATH and a word: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh pr merge \"https://github.com/go-to-k/cdkd/pull/42/files x\" --squash')"
run_case "FOREIGN + a selector with a trailing NBSP: NOT relaxed" 2 fresh "" \
  "$(foreign_gh "$(printf 'gh pr merge \\"https://github.com/go-to-k/cdkd/pull/42\302\240\\" --squash')")"
# A LEADING space / tab / newline needs nothing here: gh itself refuses those
# (it stops treating the argument as a URL and falls through to a branch), so
# the gate is not the thing standing between them and a cross-repo merge.
#
# The CONTROLS for the first-word test. Both were measured to stay exempt, and
# they are what separates "a URL inside PROSE" from "a selector": prose starts
# with a word that is not a URL.
run_case "FOREIGN + a URL mid-body with a TRAILING SPACE: still relaxed" 0 fresh "" \
  "$(foreign_gh 'gh pr create --title x --body \"see https://github.com/go-to-k/cdkd/issues/3209 \"')"
run_case "FOREIGN + a URL mid-body in a GLUED --body=: still relaxed" 0 fresh "" \
  "$(foreign_gh 'gh pr create --title x --body=\"see https://github.com/go-to-k/cdkd/issues/3209\"')"
# ...and the over-refusal the first-word test buys, pinned so it stays a
# decision: a body whose FIRST word is a URL now refuses. Fail-closed.
run_case "FOREIGN + a body STARTING with a URL (over-refusal, pinned): NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh pr create --title x --body \"https://github.com/go-to-k/cdkd is the link\"')"

# gh's `-R` is an ordinary cobra short flag, so it CLUSTERS. Measured
# 2026-09-16: `gh pr view -cR go-to-k/cdkd 3214` and `-cRgo-to-k/cdkd` both
# resolve the cdkd PR from a non-repo directory. A prefix-only `-R*` test let
# every one of these through.
run_case "FOREIGN + a CLUSTERED -sdR <slug>: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh pr merge 42 -sdR go-to-k/cdkd')"
run_case "FOREIGN + a CLUSTERED -sR <slug>: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh pr merge 42 -sR go-to-k/cdkd')"
run_case "FOREIGN + a CLUSTERED and GLUED -sR<slug>: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh pr merge 42 -sRgo-to-k/cdkd')"
# The controls for the cluster pattern: ordinary short flags with no `R` must
# keep relaxing, or the pattern is just "refuse every short flag".
run_case "FOREIGN + ordinary short flags (-s -d): still relaxed" 0 fresh "" \
  "$(foreign_gh 'gh pr merge 42 -s -d')"
run_case "FOREIGN + a GLUED short flag with no R (-sd): still relaxed" 0 fresh "" \
  "$(foreign_gh 'gh pr merge 42 -sd')"
# Anything the reader cannot resolve is treated as naming another repo.
# The `$` is BARE here, not backslash-escaped: `\$` is an invalid JSON escape,
# `jq` aborts, the hook reads an EMPTY command and exits 0 — a case that reports
# the verdict it was written to reject, for a reason that has nothing to do with
# the subject. Measured while writing it.
run_case "FOREIGN + an unexpanded \$VAR argument: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh pr merge 42 --squash $FLAGS go-to-k/cdkd')"
run_case "FOREIGN + a BACKSLASH-escaped flag: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh pr merge 42 --squash \\\\--repo go-to-k/cdkd')"
# An UNBALANCED quote cannot be split into words at all, so `gate_argv` reports
# a TRUNCATION rather than a short command line. Without the `|| return 1` on
# that call the truncated token list is walked as if it were the whole command
# and the rest -- which may hold the repo override -- is never examined.
run_case "FOREIGN + an UNBALANCED quote: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'gh pr merge 42 --squash \"--repo go-to-k/cdkd')"

# The CONTROLS, and they are what keeps the guard from being "refuse every
# foreign target" -- which would satisfy every case above and re-break the whole
# change.
run_case "FOREIGN + no repo flag: still relaxed" 0 fresh "" \
  "$(foreign_gh 'gh pr merge 42 --squash')"
run_case "FOREIGN + gh pr create with ordinary flags: still relaxed" 0 fresh "" \
  "$(foreign_gh 'gh pr create --title x --body-file /tmp/pr-body.md')"
# A quoted mention of the flag inside an argument body is not the flag.
run_case "FOREIGN + '--repo' only inside a quoted body: still relaxed" 0 fresh "" \
  "$(foreign_gh 'gh pr create --title x --body \"pass --repo to target another repo\"')"
# ...and a URL inside a quoted body is not a selector. The `://` test applies
# only to a token typed bare, or an ordinary PR body would refuse.
run_case "FOREIGN + a URL only inside a quoted body: still relaxed" 0 fresh "" \
  "$(foreign_gh 'gh pr create --title x --body \"see https://github.com/go-to-k/cdkd/issues/3209\"')"
# A path that merely CONTAINS the letters is not the flag either.
run_case "FOREIGN + a --body-file path containing -R: still relaxed" 0 fresh "" \
  "$(foreign_gh 'gh pr create --title x --body-file /tmp/notes-Review.md')"
# A `-R` in a NON-matching segment is somebody else'\''s command.
run_case "FOREIGN + -R in an unrelated earlier segment: still relaxed" 0 fresh "" \
  "$(foreign_gh 'grep -R needle src; gh pr merge 42 --squash')"

# --- `xargs` INJECTS argv, so the command text is not what gh receives -------
#
# Of everything `gate_strip_prefix` strips ahead of the verb, `xargs` is the
# only member that reads stdin and APPENDS it as arguments; the rest exec the
# command with the argv written in the text. Measured: gh resolved a piped PR
# URL from a non-repo directory, and all three forms below relaxed -- on this
# branch AND on the commit before the allowlist existed, so it is a standing
# hole rather than a regression.
run_case "FOREIGN + a selector PIPED through xargs: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'printf https://github.com/go-to-k/cdkd/pull/42 | xargs gh pr merge --squash')"
run_case "FOREIGN + xargs -n1: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'printf https://github.com/go-to-k/cdkd/pull/42 | xargs -n1 gh pr merge --squash')"
run_case "FOREIGN + xargs reading a FILE: NOT relaxed" 2 fresh "" \
  "$(foreign_gh 'xargs gh pr merge --squash < url.txt')"
# The CONTROL: the ordinary command, with no wrapper, still relaxes -- or the
# three above are satisfied by a gate that stopped relaxing anything.
run_case "FOREIGN + no xargs wrapper: still relaxed" 0 fresh "" \
  "$(foreign_gh 'gh pr merge 42 --squash')"
# ...and `xargs` AFTER the verb is an argument, not the wrapper: the word only
# injects argv when the command reached the verb through it.
run_case "FOREIGN + the word xargs as an ARGUMENT: still relaxed" 0 fresh "" \
  "$(foreign_gh 'gh pr create --title xargs --body-file /tmp/pr-body.md')"

# --- `GH_REPO` in the HOOK's OWN environment ---------------------------------
#
# gh honours it over the local repo, and a PreToolUse hook inherits the
# session's environment, so the guard reads its own env as well as the command
# text. Nothing exercised that clause: deleting it left the suite green, and the
# suite ITSELF was inheriting the caller's `GH_REPO` (69/10 when one was
# exported). Set for THIS invocation only; the suite unsets it at the top.
gh_repo_env_rc=$(printf '%s' "$(foreign_gh 'gh pr merge 42 --squash')" \
  | GH_REPO=go-to-k/cdkd MARKGATE_MOCK_VERDICT=fresh "$HOOK" >/dev/null 2>&1; echo $?)
gh_repo_env_msg=$(printf '%s' "$(foreign_gh 'gh pr merge 42 --squash')" \
  | GH_REPO=go-to-k/cdkd MARKGATE_MOCK_VERDICT=fresh "$HOOK" 2>&1 >/dev/null)
if [ "$gh_repo_env_rc" = "2" ] \
   && printf '%s' "$gh_repo_env_msg" | grep -q "GH_REPO is set in this session's environment"; then
  pass=$((pass + 1)); printf 'OK   GH_REPO in the HOOK env retracts the relaxation, and says so\n'
else
  fail=$((fail + 1))
  fail_log+="FAIL GH_REPO env clause: rc=$gh_repo_env_rc msg=$gh_repo_env_msg\n"
  printf 'FAIL GH_REPO env clause (rc=%s)\n' "$gh_repo_env_rc"
fi

# --- What the RETRACTED path TELLS the reader --------------------------------
#
# This is the one place the ordinary message is actively misleading: the target
# is a FOREIGN repo, it has no `.markgate-verify-pr-sha` and must not be given
# one, yet without the dedicated branch the reader is sent to `/verify-pr` and
# to that sentinel. With `GH_REPO` exported in a shell profile EVERY sibling PR
# lands here, so it is not a corner.
retract_msg=$(printf '%s' "$(foreign_gh 'gh pr merge 42 --squash --repo go-to-k/cdkd')" \
  | MARKGATE_MOCK_VERDICT=fresh "$HOOK" 2>&1 >/dev/null)
if printf '%s' "$retract_msg" | grep -q 'which is NOT this repo' \
   && printf '%s' "$retract_msg" | grep -q 'names a repository of its own' \
   && printf '%s' "$retract_msg" | grep -q "the PR named by NUMBER, not by URL" \
   && printf '%s' "$retract_msg" | grep -q 'Do NOT write' \
   && ! printf '%s' "$retract_msg" | grep -q 'marker bound to:' \
   && ! printf '%s' "$retract_msg" | grep -q 'second-lane case' \
   && ! printf '%s' "$retract_msg" | grep -q 'Required action'; then
  pass=$((pass + 1)); printf 'OK   the retracted path prints repo-override guidance, not the sentinel text\n'
else
  fail=$((fail + 1))
  fail_log+="FAIL retracted-path message: $retract_msg\n"
  printf 'FAIL retracted-path message\n'
fi
# A STALE marker and a retracted relaxation are INDEPENDENT, and the staleness
# branch prints only the first. Without the second-reason note the reader clears
# the marker and is blocked again by a different message, with nothing having
# said the other reason was there all along.
retract_stale_msg=$(printf '%s' "$(foreign_gh 'gh pr merge 42 --squash --repo go-to-k/cdkd')" \
  | MARKGATE_MOCK_VERDICT=stale "$HOOK" 2>&1 >/dev/null)
if printf '%s' "$retract_stale_msg" | grep -q 'marker is stale' \
   && printf '%s' "$retract_stale_msg" | grep -q 'A SECOND REASON' \
   && printf '%s' "$retract_stale_msg" | grep -q 'the PR named by NUMBER, not by URL'; then
  pass=$((pass + 1)); printf 'OK   a STALE marker + a retracted relaxation names BOTH reasons\n'
else
  fail=$((fail + 1))
  fail_log+="FAIL stale+retracted message: $retract_stale_msg\n"
  printf 'FAIL stale+retracted message\n'
fi
# ...and a plain STALE refusal must NOT carry the second-reason note, or the
# case above is satisfied by a hook that prints it unconditionally.
plain_stale_msg=$(printf '%s' "$(foreign_gh 'gh pr merge 42 --squash')" \
  | MARKGATE_MOCK_VERDICT=stale "$HOOK" 2>&1 >/dev/null)
if printf '%s' "$plain_stale_msg" | grep -q 'marker is stale' \
   && ! printf '%s' "$plain_stale_msg" | grep -q 'A SECOND REASON'; then
  pass=$((pass + 1)); printf 'OK   a PLAIN stale refusal carries no second-reason note\n'
else
  fail=$((fail + 1))
  fail_log+="FAIL plain-stale message: $plain_stale_msg\n"
  printf 'FAIL plain-stale message\n'
fi

# ...and the ORDINARY foreign-sha refusal must still print the sentinel text,
# or the case above is satisfied by a hook that stopped printing it anywhere.
printf '%s' "$side_prev" > "$side_repo/.markgate-verify-pr-sha"
ordinary_msg=$(printf '%s' "$side_payload" | MARKGATE_MOCK_VERDICT=fresh "$HOOK" 2>&1 >/dev/null)
printf '%s' "$real_sha" > "$side_repo/.markgate-verify-pr-sha"
if printf '%s' "$ordinary_msg" | grep -q 'marker bound to:' \
   && printf '%s' "$ordinary_msg" | grep -q 'Required action' \
   && ! printf '%s' "$ordinary_msg" | grep -q 'which is NOT this repo'; then
  pass=$((pass + 1)); printf 'OK   the ORDINARY binding refusal still prints the sentinel text\n'
else
  fail=$((fail + 1))
  fail_log+="FAIL ordinary-refusal message: $ordinary_msg\n"
  printf 'FAIL ordinary-refusal message\n'
fi

# --- The identity is computed BEFORE this process changes its cwd ------------
#
# `.claude/settings.json` invokes the hook as
# `${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/verify-pr-gate.sh`, so in production
# the script's own path is RELATIVE whenever that variable is unset, and the
# identity block runs BEFORE the hook's `cd -P "$target_dir"` so that path still
# resolves.
#
# WHAT ACTUALLY DISCRIMINATES, which a first attempt got wrong in both halves:
# a relative invocation whose process cwd IS the target proves nothing, because
# `./.claude/hooks` resolves identically before and after the `cd`. The target
# has to be a DIFFERENT directory. And the direction is the opposite of the
# obvious one -- moving the block below the `cd` makes the hook's own repo
# UNRESOLVABLE from inside the foreign target, so it FAILS CLOSED and a case
# that should relax refuses. Measured: with the block moved, the pair below goes
# 0/0 -> 2/2 while every other case stays green.
rel_a=$(cd "$side_repo" && printf '{"cwd":"%s","tool_input":{"command":"gh -C %s pr create"}}' "$side_repo" "$foreign_repo" \
  | MARKGATE_MOCK_VERDICT=fresh ./.claude/hooks/verify-pr-gate.sh >/dev/null 2>&1; echo $?)
rel_b=$(cd "$side_repo" && printf '{"cwd":"%s","tool_input":{"command":"cd %s && gh pr create"}}' "$side_repo" "$foreign_repo" \
  | MARKGATE_MOCK_VERDICT=fresh ./.claude/hooks/verify-pr-gate.sh >/dev/null 2>&1; echo $?)
if [ "$rel_a" = "0" ] && [ "$rel_b" = "0" ]; then
  pass=$((pass + 1)); printf 'OK   a RELATIVE invocation resolves its own repo BEFORE the cd -P\n'
else
  fail=$((fail + 1))
  fail_log+="FAIL relative invocation: gh -C gave $rel_a, cd && gave $rel_b (want 0 and 0)\n"
  printf 'FAIL relative invocation (%s / %s)\n' "$rel_a" "$rel_b"
fi

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
