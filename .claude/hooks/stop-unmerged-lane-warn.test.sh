#!/usr/bin/env bash
# Smoke test for stop-unmerged-lane-warn.sh.
#
# Run from BESIDE the hook (`bash .claude/hooks/stop-unmerged-lane-warn.test.sh`):
# the path below is `${BASH_SOURCE[0]}`-relative, so a copy run from a scratch
# directory resolves a hook that is not there and every case fails with 127.
#
# Both polarities are exercised. A Stop hook that only ever proves it FIRES
# cannot notice itself starting to fire on every turn, and a warning that cries
# wolf on a clean tree is one people learn to scroll past -- which is the same
# outcome as not having it.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stop-unmerged-lane-warn.sh"

pass=0
fail=0
fail_log=""

check() {
  local name="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
    printf 'OK   %s\n' "$name"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want '$want', got '$got'\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# `lanes_in <output>` -> how many branch lines the payload named.
lanes_in() {
  printf '%s' "$1" | python3 -c '
import json, sys
raw = sys.stdin.read()
if not raw.strip():
    print(0); raise SystemExit
msg = json.loads(raw)["systemMessage"]
print(sum(1 for line in msg.splitlines() if line.startswith("  ")))
'
}

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

REPO="$SANDBOX/repo"
mkdir -p "$REPO/.claude/hooks"
cp "$HOOK" "$REPO/.claude/hooks/"
RUN="$REPO/.claude/hooks/$(basename "$HOOK")"

git -C "$REPO" init -q .
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$REPO" update-ref refs/remotes/origin/main HEAD

# --- SILENT: nothing unmerged. The expensive half to get right, because a
# false alarm every turn is indistinguishable from noise. ---
out=$(cd "$REPO" && bash "$RUN")
check "silent when no worktree exists" "" "$out"

# --- SILENT: a worktree that is level with origin/main is not a lane. ---
git -C "$REPO" worktree add -q "$REPO/wt-level" -b feat/level HEAD
out=$(cd "$REPO" && bash "$RUN")
check "silent for a worktree with no commits of its own" "" "$out"

# --- SILENT: a DETACHED worktree has no branch to report. ---
git -C "$REPO" worktree add -q "$REPO/wt-detached" --detach HEAD
out=$(cd "$REPO" && bash "$RUN")
check "silent for a detached worktree" "" "$out"

# --- FIRES: one lane with a commit of its own. ---
git -C "$REPO/wt-level" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
out=$(cd "$REPO" && bash "$RUN")
check "names the one lane that is ahead" "1" "$(lanes_in "$out")"

# --- FIRES: counts each lane separately, and still ignores the detached one. ---
git -C "$REPO" worktree add -q "$REPO/wt-two" -b feat/two HEAD
git -C "$REPO/wt-two" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
out=$(cd "$REPO" && bash "$RUN")
check "names both lanes, not the detached worktree" "2" "$(lanes_in "$out")"

# --- The payload has to be valid JSON, or the harness swallows it silently. ---
if printf '%s' "$out" | python3 -c 'import json,sys; json.loads(sys.stdin.read())' 2>/dev/null; then
  pass=$((pass + 1)); printf 'OK   payload is valid JSON\n'
else
  fail=$((fail + 1)); fail_log+="FAIL payload is not valid JSON\n"; printf 'FAIL payload is valid JSON\n'
fi

# --- SILENT: no `origin/main` at all (a fresh clone before the first fetch)
# must not error or spam. ---
BARE="$SANDBOX/norem"
mkdir -p "$BARE/.claude/hooks"
cp "$HOOK" "$BARE/.claude/hooks/"
git -C "$BARE" init -q .
git -C "$BARE" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
out=$(cd "$BARE" && bash "$BARE/.claude/hooks/$(basename "$HOOK")")
check "silent when origin/main is unresolvable" "" "$out"

printf '\nPass: %d  Fail: %d\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then
  printf '%b' "$fail_log" >&2
  exit 1
fi
