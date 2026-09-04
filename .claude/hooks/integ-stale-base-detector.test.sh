#!/usr/bin/env bash
# Smoke tests for integ-stale-base-detector.sh
#
# The hook is NON-BLOCKING by design (always exit 0), so the exit code carries
# no signal at all and every assertion here is about the MESSAGE. That is the
# opposite of the blocking gates' suites, and it is the whole risk of a warn
# hook: an always-`exit 0` stub passes any suite that only checks exit codes.
# Measured 2026-09-04 against two stubs, both restored afterwards:
#   `exit 0`, printing nothing            -> passed 6, FAILED 5 (the warn cases)
#   always printing the alarming arm      -> passed 5, FAILED 6 (the 6 silence
#                                            cases; the warn cases pass, which
#                                            is why silence is asserted at all)
# Neither direction passes vacuously.
#
# Asserted, in both directions:
#   - WARNS  when the branch is behind origin/main and a fixture is being run
#   - names the IN-SCOPE count when main's advance touches integ-gate paths,
#     and says the marker will probably survive when it does not -- the two
#     arms give opposite advice, so conflating them would make the hook lie
#   - SILENT when up to date, when the command only READS a verify.sh, when
#     the repo never opted in, and for a non-Bash tool

set -u

HOOK="$(cd "$(dirname "$0")" && pwd)/integ-stale-base-detector.sh"
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

RUN_CMD='bash tests/integration/demo/verify.sh'

# warns <name> <command> <cwd> <substring stderr must carry>
warns() {
  local name="$1" command="$2" cwd="$3" needle="$4"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
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
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
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
warns 'behind + in-scope advance: names the scope'  "$RUN_CMD" "$BEHIND_SCOPE" 'touch integ-gate scope'
warns 'behind + in-scope advance: says rebase first' "$RUN_CMD" "$BEHIND_SCOPE" 'Rebase FIRST'
# The two arms must give OPPOSITE advice. A hook that printed the alarming arm
# unconditionally would be ignored within a week.
warns 'behind + docs-only advance: softer arm'      "$RUN_CMD" "$BEHIND_DOCS"  'probably survive'
warns 'behind + docs-only advance: still reports'   "$RUN_CMD" "$BEHIND_DOCS"  'behind origin/main'

silent 'up to date: silent'                         "$RUN_CMD" "$UPTODATE"
silent 'not opted in (no .markgate.yml): silent'    "$RUN_CMD" "$NOOPTIN"
# Reading a fixture is not running one. Without this the hook fires on every
# grep of the integ tree, which is how a warn hook trains people to ignore it.
silent 'grep of a verify.sh: silent'                'grep -n cdkd tests/integration/demo/verify.sh' "$BEHIND_SCOPE"
silent 'cat of a verify.sh: silent'                 'cat tests/integration/demo/verify.sh' "$BEHIND_SCOPE"
silent 'unrelated command: silent'                  'git status --porcelain' "$BEHIND_SCOPE"

# Non-Bash tool: the hook must not read tool_input.command from a Write.
payload=$(jq -n '{tool_name:"Write", tool_input:{file_path:"/x/verify.sh"}, cwd:"/tmp"}')
out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
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
