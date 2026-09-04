#!/usr/bin/env bash
# Smoke tests for issue-deferral-criteria-gate.sh
#
# The gate blocks `gh issue create` when the body's `Session-fit: next` line
# defers the work for a PR-SHAPED reason ("needs its own PR", "separate PR",
# "unreviewable", ...). Asserts, in both directions:
#
#   - BLOCK for every PR-shaped spelling in the vocabulary, inline and
#     file-borne
#   - PASS  for every LEGITIMATE `next` reason, including one that mentions a
#     PR without being PR-SHAPED (an upstream PR is external input, which IS a
#     criterion) -- the gate keys on the reasoning, not on the token `PR`
#   - PASS  for `Session-fit: now`, whatever its reason says, and for a body
#     with no `Session-fit` line at all: this gate has exactly one job and
#     other gates own filing hygiene
#   - PASS  for `gh issue edit` / `gh issue comment` carrying the same text --
#     re-classification is the outcome the gate steers toward
#   - PASS  outside an opted-in repo (issue #1259's scoping)
#   - correct in BOTH directions on the `git commit -F <msg> && gh issue create
#     --body-file <body>` shape, which is where issue-dup-check-gate.sh had a
#     measured FAIL-OPEN: `-F` is `git commit`'s flag as well as gh's short
#     `--body-file`, so an unscoped extraction reads the COMMIT MESSAGE. Here
#     the polarity is inverted -- an unscoped read manufactures a FALSE BLOCK
#     from a neighbouring segment -- so both orderings are pinned.
#
# MUTATION-PROBED rather than asserted (measured 2026-09-05, 64 cases). A tally
# says how many cases ran, not what any of them fences, so each fence below was
# broken in the real hook and the survivors counted:
#
#   always-`exit 0` stub                     fails 35   (nothing passes vacuously)
#   always-`exit 2` stub                     fails 33   (nor does anything block
#                                                        vacuously)
#   `next` polarity test -> `if true`        fails  2   -- exactly the two
#                                                        `Session-fit: now` cases
#   continuation boundary -> `if false`      fails  1   -- exactly the sibling
#                                                        field-line case, so the
#                                                        boundary is load-bearing
#                                                        and not decoration
#   segment scoping reverted (scan `$cmd`)   fails  4   -- both neighbouring-
#                                                        segment cases, plus the
#                                                        subshell and command-
#                                                        substitution spellings

set -u

HOOK="$(cd "$(dirname "$0")" && pwd)/issue-deferral-criteria-gate.sh"
PASS=0
FAIL=0

# `HOOK_BASH` makes the SUBJECT follow the harness. Running the suite under
# macOS bash 3.2 does NOT run the hook under it -- the hook is
# `#!/usr/bin/env bash`, which resolves through PATH and finds the 5.x there --
# and that gap is exactly how the issue #1477 breakage stayed invisible.
# run-tests.sh exports the variable for every suite; honouring it here is what
# puts this hook's `shopt -p nocasematch` probe, its `[[ =~ ]]` uses and its
# process substitutions under 3.2 for real.
invoke_hook() { # <hook path>; reads stdin
  if [ -n "${HOOK_BASH:-}" ]; then "$HOOK_BASH" "$1"; else "$1"; fi
}
invoke_hook_env() { # <VAR=value> <hook path>; reads stdin
  if [ -n "${HOOK_BASH:-}" ]; then env "$1" "$HOOK_BASH" "$2"; else env "$1" "$2"; fi
}
# Two fixture trees, because the gate is repo-opt-in (issue #1259's scoping):
#   $TMPROOT  -- a git repo carrying `.markgate.yml`, so the gate fires
#   $NOOPTIN  -- a git repo without it, so the gate must stay silent
# Real repos rather than mocks: the opt-in decision is exactly what
# `git rev-parse --show-toplevel` reports, so mocking it would test nothing.
TMPBASE=$(mktemp -d)
trap 'rm -rf "$TMPBASE"' EXIT
TMPROOT="$TMPBASE/optin"
NOOPTIN="$TMPBASE/no-optin"
for d in "$TMPROOT" "$NOOPTIN"; do
  mkdir -p "$d"
  git -C "$d" init -q 2>/dev/null
done
printf 'gates: {}\n' > "$TMPROOT/.markgate.yml"

# run <name> <command> <cwd> <expected-exit>
run() {
  local name="$1" command="$2" cwd="$3" expect="$4"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | invoke_hook "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ]; then
    echo "PASS: $name (exit $rc)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected $expect)"
    echo "$out" | sed 's/^/      /' | head -5
    FAIL=$((FAIL + 1))
  fi
}

# run_msg <name> <command> <cwd> <expected-exit> <substring the stderr must carry>
# The refusal QUOTES the offending line back, and that is the half a bare exit
# code cannot see: a gate that blocks while naming the wrong line teaches the
# reader to distrust it.
run_msg() {
  local name="$1" command="$2" cwd="$3" expect="$4" needle="$5"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | invoke_hook "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ] && printf '%s' "$out" | grep -qF "$needle"; then
    echo "PASS: $name (exit $rc, message matched)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected $expect carrying '$needle')"
    printf '%s\n' "$out" | sed 's/^/      /' | head -6
    FAIL=$((FAIL + 1))
  fi
}

# run_env <name> <VAR=value> <command> <cwd> <expected-exit>
run_env() {
  local name="$1" env_assign="$2" command="$3" cwd="$4" expect="$5"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | invoke_hook_env "$env_assign" "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ]; then
    echo "PASS: $name (exit $rc)"; PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected $expect)"; FAIL=$((FAIL + 1))
  fi
}

run_nonbash() {
  local payload out rc
  payload=$(jq -n '{tool_name:"Edit", tool_input:{file_path:"/tmp/x"}}')
  out=$(printf '%s' "$payload" | invoke_hook "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$2" ]; then echo "PASS: $1 (exit $rc)"; PASS=$((PASS + 1))
  else echo "FAIL: $1 (exit $rc, expected $2)"; FAIL=$((FAIL + 1)); fi
}

# --- fixtures ---------------------------------------------------------------
# Every body carries the full four-field block, because that is the shape a
# real filing has: a fixture holding only the `Session-fit` line would not
# exercise the continuation boundary at all, and the boundary is what keeps
# `Severity:` from being read as part of the reason.
mkbody() { # <path> <session-fit line>
  {
    printf 'The mapper drops a nested key on update.\n\n'
    printf '%s\n' "$2"
    printf 'Severity: medium -- the property is silently not applied\n'
    printf 'Effort: small (S) -- edit plus unit tests\n'
    printf 'Estimate: ~30 min -- the unit fixture already exists\n'
    printf 'Dup-check: searched open issues for `nested key` -- none covers it\n'
  } > "$1"
}

OWNPR="$TMPROOT/own-pr.md"
SEPPR="$TMPROOT/separate-pr.md"
SURFACE="$TMPROOT/surface.md"
UNREV="$TMPROOT/unreviewable.md"
SHAREPR="$TMPROOT/share-pr.md"
OWNREVIEW="$TMPROOT/own-review.md"
FIXTURE="$TMPROOT/fixture.md"
UPSTREAM="$TMPROOT/upstream.md"
NOWPR="$TMPROOT/now-pr.md"
NOFIT="$TMPROOT/no-fit.md"
WRAPPED="$TMPROOT/wrapped.md"
SIBLING="$TMPROOT/sibling.md"
CAPS="$TMPROOT/caps.md"

mkbody "$OWNPR"   'Session-fit: next (not this session) -- this needs its own PR'
mkbody "$SEPPR"   'Session-fit: next (not this session) -- a separate PR, so the diff stays small'
mkbody "$SURFACE" 'Session-fit: next (not this session) -- an independent review surface'
mkbody "$UNREV"   'Session-fit: next (not this session) -- bundling it here makes the diff unreviewable'
mkbody "$SHAREPR" 'Session-fit: next (not this session) -- a schema bump must not share a PR with a fix'
mkbody "$OWNREVIEW" 'Session-fit: next (not this session) -- it deserves its own review'
# The legitimate criteria, verbatim from .claude/rules/session-report.md.
mkbody "$FIXTURE" 'Session-fit: next (not this session) -- a NEW integ fixture must be written'
# A `next` whose reason MENTIONS a PR without being PR-SHAPED: an upstream PR
# is external input, which IS a criterion. This is the control that keeps the
# vocabulary closed -- widen the regex to any mention of `PR` and this fails.
mkbody "$UPSTREAM" 'Session-fit: next (not this session) -- blocked on upstream PR aws/aws-cdk#123 landing'
# `now` is never argued with, whatever the reason says.
mkbody "$NOWPR"   'Session-fit: now -- it lands in files this session has open; it will get its own PR'
# No `Session-fit` line at all: other gates own filing hygiene, this one has
# exactly one job.
{
  printf 'The mapper drops a nested key on update.\n\n'
  printf 'Fixing it needs its own PR because the diff touches two subsystems.\n'
} > "$NOFIT"
# The reason WRAPS. A 76-column issue body routinely puts the PR-shaped half on
# the following line, and a line-only scan reads the first half and passes.
{
  printf 'The mapper drops a nested key on update.\n\n'
  printf 'Session-fit: next (not this session) -- this touches a different\n'
  printf 'subsystem entirely and so needs its own PR\n'
  printf 'Severity: low -- internal tidiness\n'
} > "$WRAPPED"
# The complement of the case above: the PR-shaped words sit on a SIBLING FIELD
# line, which is nobody's `Session-fit` reason. Folding the following lines in
# unconditionally turns this into a false block.
{
  printf 'The mapper drops a nested key on update.\n\n'
  printf 'Session-fit: next (not this session) -- a NEW integ fixture must be written\n'
  printf 'Notes: it will land as its own PR once the fixture exists\n'
} > "$SIBLING"
mkbody "$CAPS"    'SESSION-FIT: NEXT (NOT THIS SESSION) -- IT NEEDS ITS OWN PR'

# A commit message that QUOTES a PR-shaped deferral -- the realistic shape,
# since the commit introducing this gate has to describe what it refuses.
COMMITMSG="$TMPBASE/commit-msg.txt"
{
  printf 'chore(hooks): refuse PR-shaped Session-fit deferrals\n\n'
  printf 'The line this gate refuses looks like:\n\n'
  printf 'Session-fit: next (not this session) -- this needs its own PR\n'
} > "$COMMITMSG"
CLEANMSG="$TMPBASE/clean-msg.txt"
printf 'chore(hooks): add a gate\n' > "$CLEANMSG"

# --- BLOCK: every PR-shaped spelling ---------------------------------------
run "inline --body: its own PR"        "gh issue create --title t --body 'Bug. Session-fit: next -- this needs its own PR'" "$TMPROOT" 2
run "body-file: its own PR"            "gh issue create --title t --body-file $OWNPR"     "$TMPROOT" 2
run "body-file: separate PR"           "gh issue create --title t --body-file $SEPPR"     "$TMPROOT" 2
run "body-file: independent review surface" "gh issue create --body-file $SURFACE"        "$TMPROOT" 2
run "body-file: unreviewable"          "gh issue create --body-file $UNREV"               "$TMPROOT" 2
run "body-file: must not share a PR"   "gh issue create --body-file $SHAREPR"             "$TMPROOT" 2
run "body-file: its own review"        "gh issue create --body-file $OWNREVIEW"           "$TMPROOT" 2
run "inline --body: sharing a PR"      "gh issue create --body 'Session-fit: next -- sharing a PR with the fix would hide it'" "$TMPROOT" 2
run "matching is case-insensitive"     "gh issue create --body-file $CAPS"                "$TMPROOT" 2
run "the reason may WRAP onto the next line" "gh issue create --body-file $WRAPPED"       "$TMPROOT" 2

# --- PASS: every legitimate deferral ---------------------------------------
run "a NEW integ fixture must be written" "gh issue create --body-file $FIXTURE"          "$TMPROOT" 0
run "external input: an upstream PR"      "gh issue create --body-file $UPSTREAM"         "$TMPROOT" 0
run "Session-fit: now mentioning its own PR" "gh issue create --body-file $NOWPR"         "$TMPROOT" 0
run "inline now mentioning its own PR"    "gh issue create --body 'Session-fit: now -- and it gets its own PR'" "$TMPROOT" 0
run "no Session-fit line at all"          "gh issue create --body-file $NOFIT"            "$TMPROOT" 0
run "inline body, no Session-fit line"    "gh issue create --body 'Needs its own PR, obviously.'" "$TMPROOT" 0
run "PR words on a SIBLING field line"    "gh issue create --body-file $SIBLING"          "$TMPROOT" 0

# --- verbs deliberately NOT gated -------------------------------------------
# Re-classifying an already-filed issue is the outcome this gate steers toward,
# so the verbs that do it must never be taxed.
run "gh issue edit passes"        "gh issue edit 12 --body-file $OWNPR"      "$TMPROOT" 0
run "gh issue comment passes"     "gh issue comment 12 --body-file $OWNPR"   "$TMPROOT" 0
run "gh pr create passes"         "gh pr create --body-file $OWNPR"          "$TMPROOT" 0
run "gh issue list passes"        "gh issue list --state open --search foo"  "$TMPROOT" 0

# --- the REST mint ---------------------------------------------------------
run "gh api issues POST, PR-shaped" "gh api repos/go-to-k/cdkd/issues -f title=t -f 'body=Session-fit: next -- needs its own PR'" "$TMPROOT" 2
run "gh api issues POST, legitimate" "gh api repos/go-to-k/cdkd/issues -f title=t -f 'body=Session-fit: next -- a NEW integ fixture must be written'" "$TMPROOT" 0
run "gh api comments is not a mint"  "gh api repos/go-to-k/cdkd/issues/5/comments -f 'body=Session-fit: next -- own PR'" "$TMPROOT" 0

# --- spellings the line-start-anchored ancestors leaked ---------------------
run "chained after && blocks"      "git push && gh issue create --body-file $OWNPR"   "$TMPROOT" 2
run "chained after ; blocks"       "echo done; gh issue create --body-file $OWNPR"    "$TMPROOT" 2
run "subshell blocks"              "(gh issue create --body-file $OWNPR)"             "$TMPROOT" 2
run "command substitution blocks"  "URL=\$(gh issue create --body-file $OWNPR)"       "$TMPROOT" 2
run "gh -R <repo> issue create blocks" "gh -R go-to-k/cdkd issue create --body-file $OWNPR" "$TMPROOT" 2

# --- the scans are scoped to the gh SEGMENT ---------------------------------
# `-F` is `git commit`'s flag as well as gh's short `--body-file`, so an
# unscoped extraction reads the COMMIT MESSAGE. In issue-dup-check-gate.sh that
# was a measured FAIL-OPEN; here the polarity is inverted and the same defect
# manufactures a FALSE BLOCK from a neighbouring segment. Both orderings, and
# both directions, because scoping only "after the verb" fixes just one of them.
run "PR-shaped text in a NEIGHBOURING segment passes" \
  "git commit -F $COMMITMSG && gh issue create --body-file $FIXTURE" "$TMPROOT" 0
run "neighbouring segment, gh first, passes" \
  "gh issue create --body-file $FIXTURE && git commit -F $COMMITMSG" "$TMPROOT" 0
# The other direction: a clean neighbour must not shadow the real body. This is
# the dup-check FAIL-OPEN shape with a violating issue body -- it must BLOCK.
run "clean commit -F before a PR-shaped body still blocks" \
  "git commit -F $CLEANMSG && gh issue create --body-file $OWNPR" "$TMPROOT" 2
run "clean commit -F after a PR-shaped body still blocks" \
  "gh issue create --body-file $OWNPR && git commit -F $CLEANMSG" "$TMPROOT" 2

# --- repo opt-in scope (issue #1259) ---------------------------------------
cp "$OWNPR" "$NOOPTIN/own-pr.md"
run "no .markgate.yml: not gated"     "gh issue create --body-file $NOOPTIN/own-pr.md" "$NOOPTIN" 0
run "outside any git repo: not gated" "gh issue create --body-file $OWNPR"             "$TMPBASE" 0
run "-R sibling from an opted-in cwd" "gh -R go-to-k/cdk-local issue create --body-file $OWNPR" "$TMPROOT" 2

# --- relative paths and the `cd` chain -------------------------------------
run "relative body-file via payload cwd" "gh issue create --body-file own-pr.md"                  "$TMPROOT" 2
run "relative body-file via leading cd"  "cd $TMPROOT && gh issue create --body-file own-pr.md"   "/"        2
# `cmd_last_cd_target` breaks at the verb it is given, so a bare `gh` would stop
# at the first gh segment and miss the `cd` -- exactly the search-then-file chain
# the filing flow prescribes.
run "search, cd, then file (PR-shaped)"  "gh issue list --state open --search x && cd $TMPROOT && gh issue create --body-file own-pr.md" "$TMPBASE" 2
run "search, cd, then file (legitimate)" "gh issue list --state open --search x && cd $TMPROOT && gh issue create --body-file fixture.md" "$TMPBASE" 0

# --- more body-file spellings ----------------------------------------------
run "--body-file=<p> form"      "gh issue create --body-file=$OWNPR"       "$TMPROOT" 2
run "--body-file=<p> legitimate" "gh issue create --body-file=$FIXTURE"    "$TMPROOT" 0
run "quoted --body-file path"   "gh issue create --body-file \"$OWNPR\""   "$TMPROOT" 2
run "-F body=@ form"            "gh issue create -F body=@$OWNPR"          "$TMPROOT" 2
run "bare -F <file> form"       "gh issue create -F $OWNPR"                "$TMPROOT" 2
run "--raw-field body=@ form"   "gh issue create --raw-field body=@$OWNPR" "$TMPROOT" 2

# --- the unreadable-path window --------------------------------------------
# Unlike issue-dup-check-gate.sh, an unreadable body file must NOT block: that
# gate demands a line be PRESENT, so "cannot read" is evidence of a miss, while
# this one objects to content it FINDS and a refusal would be unclearable. The
# named-but-absent path falls back to the WHOLE command, which is what makes the
# heredoc shape below work.
run "unreadable body-file, nothing offending" "gh issue create --body-file $TMPROOT/nope.md" "$TMPROOT" 0
run "unexpanded \$VAR path, nothing offending" "gh issue create --body-file \"\$BODY\""      "$TMPROOT" 0
run "unexpanded \$VAR path, PR-shaped inline"  "gh issue create --body-file \"\$BODY\" --title 'x' # Session-fit: next -- own PR" "$TMPROOT" 2

# --- heredoc -> file -> --body-file in ONE command --------------------------
# The file does not exist at PreToolUse time. This is the repo's mandated
# publishing shape, so a PR-shaped body written that way must still be caught,
# and a legitimate one must still pass.
HD_BAD="cat > $TMPROOT/hd.md <<'EOF'
The mapper drops a nested key.

Session-fit: next (not this session) -- this needs its own PR
EOF
gh issue create --body-file $TMPROOT/hd.md"
HD_OK="cat > $TMPROOT/hd2.md <<'EOF'
The mapper drops a nested key.

Session-fit: next (not this session) -- a NEW integ fixture must be written
EOF
gh issue create --body-file $TMPROOT/hd2.md"
run "heredoc body is PR-shaped"  "$HD_BAD" "$TMPROOT" 2
run "heredoc body is legitimate" "$HD_OK"  "$TMPROOT" 0

# --- mandated quoted-body false-positive cases (cdkd#563) -------------------
# A command that merely NAMES the trigger must not fire the gate.
run "quoted mention in commit message" "git commit -m 'docs: explain gh issue create --body-file flow'" "$TMPROOT" 0
run "quoted mention in echo"           "echo 'run: gh issue create --body-file own-pr.md'"             "$TMPROOT" 0

# --- the escape hatch, both channels ---------------------------------------
run_env "bypass via the process env" "CDKD_SKIP_DEFERRAL_CRITERIA_GATE=1" \
  "gh issue create --body-file $OWNPR" "$TMPROOT" 0
# The TEXT channel is the only one an agent's Bash call can actually deliver
# (a PreToolUse hook is spawned with the session env), and it is the spelling
# the refusal advertises -- go-to-k/cdkd#2368, where the advertised remediation
# silently did nothing and the suite certified the failure.
run "bypass via a leading assignment in the command" \
  "CDKD_SKIP_DEFERRAL_CRITERIA_GATE=1 gh issue create --body-file $OWNPR" "$TMPROOT" 0
# A QUOTED mention of the bypass is not a bypass.
run "quoted mention of the bypass does not bypass" \
  "gh issue create --title 'CDKD_SKIP_DEFERRAL_CRITERIA_GATE=1 is the hatch' --body-file $OWNPR" "$TMPROOT" 2

# --- the refusal names the offending line ----------------------------------
run_msg "refusal quotes the offending reason" "gh issue create --body-file $OWNPR" "$TMPROOT" 2 \
  "this needs its own PR"
run_msg "refusal names the rule file" "gh issue create --body-file $OWNPR" "$TMPROOT" 2 \
  ".claude/rules/session-report.md"
run_msg "refusal lists the legitimate next criteria" "gh issue create --body-file $OWNPR" "$TMPROOT" 2 \
  "a NEW integ fixture must be WRITTEN"
run_msg "refusal names the bypass" "gh issue create --body-file $OWNPR" "$TMPROOT" 2 \
  "CDKD_SKIP_DEFERRAL_CRITERIA_GATE=1"

# --- the library guard must FAIL CLOSED ------------------------------------
lib_fail_closed() {
  local tmp out rc
  tmp=$(mktemp -d)
  cp "$HOOK" "$tmp/gate.sh"          # no lib/ beside it
  chmod +x "$tmp/gate.sh"
  out=$(jq -n --arg d "$TMPROOT" '{tool_name:"Bash", tool_input:{command:"gh issue create --body-file /nope.md"}, cwd:$d}' \
        | invoke_hook "$tmp/gate.sh" 2>&1) && rc=0 || rc=$?
  rm -rf "$tmp"
  if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qF "command-match.sh"; then
    echo "PASS: unloadable library fails CLOSED (exit $rc)"; PASS=$((PASS + 1))
  else
    echo "FAIL: unloadable library should exit 2 naming the library (got $rc)"; FAIL=$((FAIL + 1))
  fi
}
lib_fail_closed

# --- the hook is actually REGISTERED ---------------------------------------
# The suite invokes the hook directly, so it would not otherwise notice the
# hook being dropped from .claude/settings.json.
registration_check() {
  local settings
  settings="$(cd "$(dirname "$0")/../.." && pwd)/.claude/settings.json"
  if [ -f "$settings" ] && grep -q 'issue-deferral-criteria-gate.sh' "$settings"; then
    echo "PASS: registered in .claude/settings.json"; PASS=$((PASS + 1))
  else
    echo "FAIL: not registered in .claude/settings.json"; FAIL=$((FAIL + 1))
  fi
}
registration_check

run "empty command passes" "" "$TMPROOT" 0
run_nonbash "non-Bash tool passes" 0

echo ""
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" -eq 0 ]
