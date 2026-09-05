#!/usr/bin/env bash
# Smoke tests for integ-stale-base-detector.sh
#
# The hook is NON-BLOCKING by design (always exit 0), so the exit code carries
# no signal at all and every assertion here is about the MESSAGE. That is the
# opposite of the blocking gates' suites, and it is the whole risk of a warn
# hook: an always-`exit 0` stub passes any suite that only checks exit codes.
# RE-MEASURED 2026-09-05 on the 19-case suite, against three stubs, all
# restored afterwards. EVERY number here is from that one run -- the pass and
# the fail halves alike. The first revision of this header quoted 6/5 and 5/6
# and both were wrong; the second quoted 6/6, 4/8, 6/6, taken when the suite
# was 12 cases, and carrying those forward would have left three PASS tallies
# describing a suite that no longer exists. A stale measured number is this
# repo's recurring defect, and the header of a suite whose job is to measure is
# the worst place for one:
#   `exit 0`, printing nothing        -> passed  9, FAILED 10  (every warn case)
#   the ALARMING arm only             -> passed  8, FAILED 11  (silence cases AND
#                                        the soft-arm warn case, which is why
#                                        the two arms are asserted separately)
#   BOTH arms at once                 -> passed 10, FAILED  9  (the silence cases)
# Plus four fence-specific mutations:
#   3-dot `HEAD...origin/main` -> 2-dot    fails 1 -- exactly the
#     lane-has-its-own-commit case. Before that fixture existed the whole suite
#     survived this mutation at 11/11.
#   read-verb test removed                 fails 4 -- exactly the four silence
#     cases, so "a read is not a run" is fenced apart from the change below.
#   read-verb test back to PER-COMMAND     fails 4 -- exactly the four
#     read-verb-in-an-earlier-segment cases, and NOTHING else. That is the
#     2026-09-05 defect reproduced: a read verb anywhere disarmed the whole
#     command, so `git status && bash .../verify.sh` went silent.
#   `(bash|sh)` unanchored                 fails 1 -- exactly the
#     word-ending-in-sh case.
# No direction passes vacuously.
#
# Asserted, in both directions:
#   - WARNS  when the branch is behind origin/main and a fixture is being run
#   - names the IN-SCOPE count when main's advance touches integ-gate paths,
#     and says the marker will probably survive when it does not -- the two
#     arms give opposite advice, so conflating them would make the hook lie
#   - WARNS  when the fixture run sits in a LATER segment than a read verb
#     (`git status && bash .../verify.sh`), which is how a real run is written
#   - SILENT when up to date, when the command only READS a verify.sh (alone or
#     chained with another read), when the repo never opted in, and for a
#     non-Bash tool

set -u

HOOK="$(cd "$(dirname "$0")" && pwd)/integ-stale-base-detector.sh"
# `run-tests.sh` exports HOOK_BASH so the SUBJECT follows the shell under test,
# not just this harness. Invoking "$HOOK" directly ignores it, and the hook then
# only ever runs under the shebang's bash -- the #1477 class, where a bash-4-only
# construct is a runtime error invisible to a bash-5-only run. Proof it was
# inert: with HOOK_BASH=/nonexistent/bash this suite reported 11/11 while the
# deferral suite collapsed to 1/63.
run_hook() {
  if [ -n "${HOOK_BASH:-}" ]; then "$HOOK_BASH" "$HOOK"; else "$HOOK"; fi
}
PASS=0
FAIL=0

TMPBASE=$(mktemp -d)
trap 'rm -rf "$TMPBASE"' EXIT

# Three fixture trees. Real git repos, not mocks: what the hook reads is
# exactly `git rev-list --count HEAD..origin/main` and `git diff --name-only`,
# so a mock would test the mock.
#
#   $BEHIND_SCOPE  -- behind by 1, and that commit touches integ-gate scope
#   $BEHIND_DOCS   -- behind by 1, docs-only advance
#   $UPTODATE      -- HEAD == origin/main
#   $NOOPTIN       -- behind, but no .markgate.yml, so the hook must stay quiet
# $LANE_OWN_SCOPE is the PRODUCTION shape and the only fixture that can see
# which diff form the hook uses: the lane carries its OWN in-scope commit while
# main advanced docs-only. With every lane sitting exactly at the merge base,
# `HEAD...origin/main` and `HEAD..origin/main` are IDENTICAL, so a 2-dot mutation
# survived the whole suite (measured: 11/11). A lane with its own in-scope commit
# is the normal state when an integ is being run, and there the two diverge --
# 3-dot correctly reports main's docs-only advance as harmless, 2-dot blames the
# lane's own provider file and tells you to rebase for nothing.
LANE_OWN_SCOPE="$TMPBASE/lane-own-scope"
BEHIND_SCOPE="$TMPBASE/behind-scope"
BEHIND_DOCS="$TMPBASE/behind-docs"
UPTODATE="$TMPBASE/uptodate"
NOOPTIN="$TMPBASE/no-optin"

# build_repo <dir> <advance-file> <optin:yes|no> <advance:yes|no>
# Leaves HEAD on branch `lane` at the base commit and points
# refs/remotes/origin/main at the (optionally advanced) tip.
build_repo() {
  local d="$1" advance_file="$2" optin="$3" advance="$4"
  mkdir -p "$d"
  git -C "$d" init -q -b main 2>/dev/null
  git -C "$d" config user.email t@t
  git -C "$d" config user.name t
  [ "$optin" = yes ] && printf 'gates: {}\n' > "$d/.markgate.yml"
  mkdir -p "$d/tests/integration/demo"
  printf '#!/bin/sh\n' > "$d/tests/integration/demo/verify.sh"
  printf 'base\n' > "$d/base.txt"
  git -C "$d" add -A >/dev/null
  git -C "$d" commit -qm base
  git -C "$d" branch -f lane HEAD
  if [ "$advance" = yes ]; then
    mkdir -p "$d/$(dirname "$advance_file")"
    printf 'advanced\n' > "$d/$advance_file"
    git -C "$d" add -A >/dev/null
    git -C "$d" commit -qm advance
  fi
  git -C "$d" update-ref refs/remotes/origin/main HEAD
  git -C "$d" checkout -q lane
}

build_repo "$BEHIND_SCOPE" src/provisioning/providers/x-provider.ts yes yes
build_repo "$BEHIND_DOCS"  docs/whatever.md                        yes yes
build_repo "$UPTODATE"     unused                                  yes no
build_repo "$NOOPTIN"      src/provisioning/providers/x-provider.ts no  yes

# Built by hand: build_repo leaves the lane AT the base, and this fixture needs
# the lane AHEAD of it on its own branch.
build_repo "$LANE_OWN_SCOPE" docs/only.md yes yes
mkdir -p "$LANE_OWN_SCOPE/src/provisioning/providers"
printf 'lane\n' > "$LANE_OWN_SCOPE/src/provisioning/providers/lane-provider.ts"
git -C "$LANE_OWN_SCOPE" add -A >/dev/null
git -C "$LANE_OWN_SCOPE" commit -qm "lane's own in-scope commit"

RUN_CMD='bash tests/integration/demo/verify.sh'

# warns <name> <command> <cwd> <substring stderr must carry>
warns() {
  local name="$1" command="$2" cwd="$3" needle="$4"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | run_hook 2>&1) && rc=0 || rc=$?
  # Exit 0 is asserted too: a warn hook that ever blocks would stop an integ
  # the operator deliberately started, which is the failure mode the
  # non-blocking design exists to avoid.
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qF "$needle"; then
    echo "PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected 0 carrying '$needle')"
    printf '%s\n' "$out" | sed 's/^/      /' | head -6
    FAIL=$((FAIL + 1))
  fi
}

# silent <name> <command> <cwd>
silent() {
  local name="$1" command="$2" cwd="$3"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | run_hook 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq 0 ] && [ -z "$out" ]; then
    echo "PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected 0 and NO output)"
    printf '%s\n' "$out" | sed 's/^/      /' | head -6
    FAIL=$((FAIL + 1))
  fi
}

warns 'behind + in-scope advance: warns'            "$RUN_CMD" "$BEHIND_SCOPE" '1 commit(s) behind origin/main'
warns 'behind + in-scope advance: names the scope'  "$RUN_CMD" "$BEHIND_SCOPE" 'in-scope file(s) arrive'
warns 'behind + in-scope advance: says rebase first' "$RUN_CMD" "$BEHIND_SCOPE" 'Rebase FIRST'
# The two arms must give OPPOSITE advice. A hook that printed the alarming arm
# unconditionally would be ignored within a week.
warns 'behind + docs-only advance: softer arm'      "$RUN_CMD" "$BEHIND_DOCS"  'probably survive'
warns 'behind + docs-only advance: still reports'   "$RUN_CMD" "$BEHIND_DOCS"  'behind origin/main'

# 3-dot vs 2-dot. Main's advance is docs-only, so the honest answer is the
# SOFT arm; a 2-dot diff would sweep in the lane's own provider file and print
# the alarming one.
warns 'lane has its own in-scope commit: judges MAIN'\''s advance, not the lane'\''s' \
  "$RUN_CMD" "$LANE_OWN_SCOPE" 'probably survive'

silent 'up to date: silent'                         "$RUN_CMD" "$UPTODATE"
silent 'not opted in (no .markgate.yml): silent'    "$RUN_CMD" "$NOOPTIN"
# Reading a fixture is not running one. Without this the hook fires on every
# grep of the integ tree, which is how a warn hook trains people to ignore it.
silent 'grep of a verify.sh: silent'                'grep -n cdkd tests/integration/demo/verify.sh' "$BEHIND_SCOPE"
silent 'cat of a verify.sh: silent'                 'cat tests/integration/demo/verify.sh' "$BEHIND_SCOPE"
silent 'unrelated command: silent'                  'git status --porcelain' "$BEHIND_SCOPE"

# --- the read verb must disarm its SEGMENT, not the COMMAND (2026-09-05) ----
# Measured against the pre-fix hook: all four of these were SILENT while the
# bare `bash .../verify.sh` warned. The arming grep and the read-verb grep both
# scanned the WHOLE command, so one read verb anywhere `exit 0`ed the lot --
# and every shape below is one a real run writes. A warn hook that goes quiet
# on the commands people actually type is indistinguishable from a working one,
# which is the failure mode this whole file exists to catch.
warns 'read verb in an EARLIER segment still warns (git status)' \
  "git status && $RUN_CMD" "$BEHIND_SCOPE" 'behind origin/main'
warns 'read verb in an EARLIER segment still warns (echo)' \
  "echo start && $RUN_CMD" "$BEHIND_SCOPE" 'behind origin/main'
warns 'read verb in an EARLIER segment still warns (cat)' \
  "cat README.md && $RUN_CMD" "$BEHIND_SCOPE" 'behind origin/main'
# The STANDARD flow, which has no verify.sh at all -- and the four broad-set
# fixtures that use it are exactly the runs that refresh `integ-broad`.
warns 'read verb before the standard cli.js flow still warns' \
  'ls && node ../../../dist/cli.js deploy --all' "$BEHIND_SCOPE" 'behind origin/main'
# Controls, so the four above are not satisfied by "the read-verb test was
# deleted". A read is still a read when it is the only thing that arms, alone
# or chained.
silent 'git diff of a verify.sh: silent'  'git diff tests/integration/demo/verify.sh' "$BEHIND_SCOPE"
silent 'chained reads only: silent'       'git status && cat tests/integration/demo/verify.sh' "$BEHIND_SCOPE"
# `(bash|sh)` was UNANCHORED, so the `sh` alternative matched the tail of an
# unrelated word and `finish verify.sh` armed the hook.
silent 'a word ENDING in sh does not arm' './scripts/finish verify.sh' "$BEHIND_SCOPE"

# Non-Bash tool: the hook must not read tool_input.command from a Write.
payload=$(jq -n '{tool_name:"Write", tool_input:{file_path:"/x/verify.sh"}, cwd:"/tmp"}')
out=$(printf '%s' "$payload" | run_hook 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ] && [ -z "$out" ]; then
  echo "PASS: non-Bash tool: silent"
  PASS=$((PASS + 1))
else
  echo "FAIL: non-Bash tool: silent (exit $rc, output '$out')"
  FAIL=$((FAIL + 1))
fi

echo "----"
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
