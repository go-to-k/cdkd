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

# The hook now READS the Stop event's JSON from stdin, so every invocation has
# to feed it one. Left unfed, `cat` inherits this script's stdin and a case can
# hang instead of failing -- and a Stop hook that hangs never lets a turn end.
run_hook() {
  local dir="$1" hook="$2" stdin="${3-}"
  [ "$#" -ge 3 ] || stdin='{}'
  printf '%s' "$stdin" | (cd "$dir" && bash "$hook")
  # The exit STATUS, parked in a file because every call site is a `$(...)`
  # subshell. Silence is not the same as success here: on `Stop` a non-zero exit
  # is a hook ERROR, and the five cases below that assert empty output would all
  # pass against a hook that crashed before printing. Measured: turning the
  # three silent `exit 0`s into `exit 1` left the suite green.
  printf '%s' "$?" > "$RC_FILE"
}

# `rc_of` -> the status of the most recent run_hook call.
rc_of() { cat "$RC_FILE"; }

# `lanes_in <output>` -> how many branch lines the payload named, whichever
# channel carried it. Deliberately channel-AGNOSTIC: the cases below split into
# two groups, and only one of them is about the channel. Every count assertion
# is about which BRANCHES got enumerated, and folding the channel into it would
# make each of those fail for two unrelated reasons at once.
lanes_in() {
  printf '%s' "$1" | python3 -c '
import json, sys
raw = sys.stdin.read()
if not raw.strip():
    print(0); raise SystemExit
d = json.loads(raw)
msg = d.get("hookSpecificOutput", {}).get("additionalContext") or d.get("systemMessage") or ""
print(sum(1 for line in msg.splitlines() if line.startswith("  ")))
'
}

# `channel_of <output>` -> ctx | sys | none | BOTH.
#
# On the Stop event the channel IS the behaviour, not a formatting detail:
# `additionalContext` is delivered to the model and CONTINUES the turn, while
# `systemMessage` is shown to the user and lets it end. `BOTH` is reported
# rather than silently preferring one, because a payload carrying both fields
# would continue the turn AND print to the user -- neither of the two designs
# below, and something a test that reads only its own key cannot see.
channel_of() {
  printf '%s' "$1" | python3 -c '
import json, sys
raw = sys.stdin.read()
if not raw.strip():
    print("none"); raise SystemExit
d = json.loads(raw)
ctx = bool(d.get("hookSpecificOutput", {}).get("additionalContext"))
sysm = bool(d.get("systemMessage"))
print("BOTH" if ctx and sysm else "ctx" if ctx else "sys" if sysm else "none")
'
}

# `pwd -P` is load-bearing, not tidiness. On macOS `mktemp -d` hands back a
# path under `/var/folders/...` whose real location is `/private/var/...`, and
# the hook derives its own root with `cd ... && pwd`, which canonicalises. Git,
# meanwhile, records a worktree under whatever path it was CREATED with. So an
# uncanonicalised sandbox makes the hook's root and git's listing two spellings
# of one directory that never compare equal -- and any case whose subject is an
# equality between those two paths passes no matter what the hook does. That is
# how the self-lane case below was measured VACUOUS on its first attempt: the
# defect it was written for (a skip keyed on the hook's own checkout) could be
# reintroduced and the suite stayed green.
SANDBOX="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$SANDBOX"' EXIT

RC_FILE="$SANDBOX/rc"

REPO="$SANDBOX/repo"
mkdir -p "$REPO/.claude/hooks"
cp "$HOOK" "$REPO/.claude/hooks/"
RUN="$REPO/.claude/hooks/$(basename "$HOOK")"

git -C "$REPO" init -q .
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$REPO" update-ref refs/remotes/origin/main HEAD

# --- SILENT: nothing unmerged. The expensive half to get right, because a
# false alarm every turn is indistinguishable from noise. ---
out=$(run_hook "$REPO" "$RUN")
check "silent when no worktree exists" "" "$out"
check "...and silent means exit 0, not a crash" "0" "$(rc_of)"

# --- SILENT: a worktree that is level with origin/main is not a lane. ---
git -C "$REPO" worktree add -q "$REPO/wt-level" -b feat/level HEAD
out=$(run_hook "$REPO" "$RUN")
check "silent for a worktree with no commits of its own" "" "$out"

# --- SILENT: a DETACHED worktree has no branch to report. It is committed
# AHEAD on purpose: added at HEAD and left alone, the ahead-count check already
# excludes it and the `[ -n "$br" ]` guard this case is named for is never what
# makes it pass -- measured, deleting that guard left the suite green. Ahead and
# branchless, the guard is the only thing standing between this and a lane line
# with an empty branch name. Same trap the `main`/`master` case below documents.
git -C "$REPO" worktree add -q "$REPO/wt-detached" --detach HEAD
git -C "$REPO/wt-detached" -c user.email=t@t -c user.name=t commit -q --allow-empty -m 'detached work'
out=$(run_hook "$REPO" "$RUN")
check "silent for a detached worktree that is ahead" "" "$out"

# --- FIRES: one lane with a commit of its own. ---
git -C "$REPO/wt-level" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
out=$(run_hook "$REPO" "$RUN")
check "names the one lane that is ahead" "1" "$(lanes_in "$out")"

# --- FIRES: counts each lane separately, and still ignores the detached one. ---
git -C "$REPO" worktree add -q "$REPO/wt-two" -b feat/two HEAD
git -C "$REPO/wt-two" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
out=$(run_hook "$REPO" "$RUN")
check "names both lanes, not the detached worktree" "2" "$(lanes_in "$out")"

# --- FIRES: run from INSIDE a lane worktree, that lane must still be named. ---
# The case the hook exists for, and the one every case above misses: they all
# `cd "$REPO"` (the main tree), so a skip keyed on the hook's OWN checkout was
# invisible to all seven of them. An earlier revision derived the skip from
# `BASH_SOURCE` and went silent for exactly this run. The main tree is excluded
# by BRANCH, so removing that skip costs nothing here -- which this case pins
# from the other side, by asserting the count is 2 rather than 3.
mkdir -p "$REPO/wt-two/.claude/hooks"
cp "$HOOK" "$REPO/wt-two/.claude/hooks/"
out=$(run_hook "$REPO/wt-two" "$REPO/wt-two/.claude/hooks/$(basename "$HOOK")")
check "names its OWN lane when run from inside it" "2" "$(lanes_in "$out")"
# Bind to the SELF line, not to the enumeration. The payload lists every lane,
# so `grep feat/two` is satisfied by the listing no matter which branch the
# message calls the session's own -- measured, forcing that line to name
# `feat/level` instead left the suite green. `-F` plus the trailing comma so
# `feat/two-x` cannot satisfy it either.
if printf '%s' "$out" | grep -qF "This session's worktree is on 'feat/two',"; then
  pass=$((pass + 1)); printf 'OK   the self-lane is the one the message names\n'
else
  fail=$((fail + 1)); fail_log+="FAIL the message names the wrong self-lane\n"; printf 'FAIL the self-lane is the one the message names\n'
fi

# --- SILENT: the main tree ON `main`, ahead of origin/main, is NOT a lane.
# Without this the `main`/`master` filter is unfenced: everywhere else in this
# sandbox the main tree is LEVEL with origin/main, so the ahead-count check
# already excludes it and deleting the branch filter changes nothing. Measured:
# with this case absent, dropping `case "$br" in main|master) continue` left the
# suite green. Direct commits on `main` are a different problem with its own
# gate; this hook reports unmerged LANES.
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m 'on main'
out=$(run_hook "$REPO" "$RUN")
check "the main tree on main is not a lane even when ahead" "2" "$(lanes_in "$out")"

# --- The BRANCH filter, not the path, is what excludes the main tree. Put the
# main tree on a feature branch that is ahead and it must be named like any
# other lane; otherwise the two filters mask each other and neither is fenced.
git -C "$REPO" checkout -q -b feat/main-tree-lane
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
out=$(run_hook "$REPO" "$RUN")
check "the main tree on a feature branch is a lane too" "3" "$(lanes_in "$out")"
git -C "$REPO" checkout -q -
git -C "$REPO" branch -q -D feat/main-tree-lane

# --- The payload has to be valid JSON, or the harness swallows it silently. ---
if printf '%s' "$out" | python3 -c 'import json,sys; json.loads(sys.stdin.read())' 2>/dev/null; then
  pass=$((pass + 1)); printf 'OK   payload is valid JSON\n'
else
  fail=$((fail + 1)); fail_log+="FAIL payload is not valid JSON\n"; printf 'FAIL payload is valid JSON\n'
fi

# --- SILENT, and exit 0, when `python3` is not installed. Everything past the
# lane check is built by `python3`, so without the guard the script ends on a
# `command not found` and returns 127 -- an ERROR reported on every single turn,
# from a hook whose entire job is advisory. A PATH holding only the other
# binaries it uses is what makes this measurable; with python3 present the guard
# can be deleted and the suite stays green. ---
# The list is every external the hook reaches for BEFORE the guard, `bash` and
# `env` included -- `PATH=... bash` resolves `bash` through the replaced PATH
# too, and the shebang is `env bash`. Each of them was added because its absence
# produced a DIFFERENT failure than the one under test, which is the trap here:
# a stub PATH that is too small makes the case pass for the wrong reason.
STUBBIN="$SANDBOX/no-python"
mkdir -p "$STUBBIN"
for c in bash env dirname git awk sed cat; do
  ln -sf "$(command -v "$c")" "$STUBBIN/$c"
done
out=$( (cd "$REPO" && printf '%s' '{}' | PATH="$STUBBIN" bash "$RUN"); printf '%s' "$?" > "$RC_FILE")
check "silent when python3 is unavailable" "" "$out"
check "...and exits 0 rather than 127" "0" "$(rc_of)"

# --- SILENT: no `origin/main` at all (a fresh clone before the first fetch)
# must not error or spam. ---
BARE="$SANDBOX/norem"
mkdir -p "$BARE/.claude/hooks"
cp "$HOOK" "$BARE/.claude/hooks/"
git -C "$BARE" init -q .
git -C "$BARE" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
out=$(run_hook "$BARE" "$BARE/.claude/hooks/$(basename "$HOOK")")
check "silent when origin/main is unresolvable" "" "$out"
check "...and that too is exit 0" "0" "$(rc_of)"

# Re-run against the two-lane sandbox: the case above left `$out` empty (it ran
# in the no-remote repo), and an assertion about the payload's SHAPE cannot be
# made against no payload.
out=$(run_hook "$REPO" "$RUN")
check "still names both lanes on re-run" "2" "$(lanes_in "$out")"

# --- CHANNEL: the session's OWN lane reaches the MODEL. `additionalContext` is
# the only field that does, and it continues the turn so the model can act --
# which is the failure this hook was written for, an agent ending the turn with
# its own branch committed and no PR. For months this was `systemMessage`, which
# the installed Claude Code describes as "Display a message to the user (all
# hooks)": a message written at the AGENT reached only the party who cannot act
# on it (go-to-k/cdkd#2389). ---
out=$(run_hook "$REPO/wt-two" "$REPO/wt-two/.claude/hooks/$(basename "$HOOK")")
check "own lane goes to the model" "ctx" "$(channel_of "$out")"
check "own lane payload still enumerates every lane" "2" "$(lanes_in "$out")"
if printf '%s' "$out" | python3 -c '
import json, sys
d = json.loads(sys.stdin.read())
sys.exit(0 if d["hookSpecificOutput"]["hookEventName"] == "Stop" else 1)
'; then
  pass=$((pass + 1)); printf 'OK   the hookEventName is Stop\n'
else
  fail=$((fail + 1)); fail_log+="FAIL the hookEventName is not Stop\n"; printf 'FAIL the hookEventName is Stop\n'
fi

# --- CHANNEL: lanes that belong to SOMEONE ELSE go to the user instead. The
# model cannot act on another session's worktree, so continuing the turn buys
# one extra reply that can only say "not mine" -- measured four times in one
# session while fixing #2389, over a single lane owned by another session. This repo
# SQUASH-merges, so a merged branch reads as ahead forever and one un-removed
# worktree would have made that permanent. ---
out=$(run_hook "$REPO" "$RUN")
check "other sessions' lanes go to the user" "sys" "$(channel_of "$out")"
check "the user-facing payload still enumerates them" "2" "$(lanes_in "$out")"

# --- The OWNERSHIP test reads `cwd` out of the event payload, not just the path
# the hook was launched from. Run from the main tree while `cwd` names the lane:
# without reading `cwd` this answers `sys`, so the two cases above cannot see
# the difference on their own -- each of them has the launch path and `cwd`
# agreeing, which is exactly the pair that makes either signal look sufficient.
out=$(run_hook "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-two\"}")
check "cwd naming a lane makes it the session's own" "ctx" "$(channel_of "$out")"

# --- ...and the same field pointing at a NON-lane worktree must NOT. Otherwise
# "cwd is set" rather than "cwd is a lane" would be what flips the channel, and
# the case above would pass under a hook that simply believes any cwd. ---
out=$(run_hook "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-detached\"}")
check "cwd naming a non-lane worktree stays user-facing" "sys" "$(channel_of "$out")"

# --- The session reached through a SYMLINKED spelling of its lane is still the
# owner of that lane. No `cwd` in the payload, so the BASH_SOURCE fallback is
# what has to answer -- and that path is built with `cd ... && pwd`, which keeps
# the spelling it was reached BY, while git reports the real one. Without the
# canonicalisation this compares a symlink to a real path, never matches, and
# quietly hands the agent its own lane on the user-only channel.
#
# Every other case here is blind to that: git canonicalises both of ITS answers
# (measured -- a worktree ADDED as `/var/...` is still listed as
# `/private/var/...`), so the two sides agree no matter what, and dropping the
# canonicalisation leaves the suite green. ---
ln -s "$REPO/wt-two" "$SANDBOX/wt-two-link"
out=$(run_hook "$SANDBOX/wt-two-link" "$SANDBOX/wt-two-link/.claude/hooks/$(basename "$HOOK")")
check "a symlinked lane path is still the session's own lane" "ctx" "$(channel_of "$out")"

# --- SILENT on the continuation pass. `additionalContext` CONTINUES the turn,
# so a hook that keeps emitting it turns one nudge into a spin: the model is
# pushed back to work, reaches Stop again with the same unmerged lane, and is
# pushed again. The harness marks that second pass with `stop_hook_active`, and
# standing down on it is what bounds this hook to a single forced continuation.
# Without this case the loop is unfenced -- every case above passes `{}`, where
# the flag is absent, so the branch could be deleted and the suite stay green. ---
out=$(run_hook "$REPO/wt-two" "$REPO/wt-two/.claude/hooks/$(basename "$HOOK")" '{"stop_hook_active": true}')
check "silent once the harness reports a continuation already happened" "" "$out"
check "...standing down is exit 0, not a crash" "0" "$(rc_of)"

# --- ...and NOT silent when the flag is present but false, which is the shape
# every ordinary turn actually sends. A truthiness check that reads the KEY
# rather than its VALUE would go permanently silent here, and the case above
# cannot see that -- it only ever sends `true`. ---
out=$(run_hook "$REPO/wt-two" "$REPO/wt-two/.claude/hooks/$(basename "$HOOK")" '{"stop_hook_active": false}')
check "fires when the continuation flag is present but false" "2" "$(lanes_in "$out")"
check "...and still reaches the model, not just the user" "ctx" "$(channel_of "$out")"

# --- A worktree path containing a SPACE is still a lane. `git worktree list
# --porcelain` prints `worktree <path>` with the path unquoted and unescaped, so
# reading it with `$2` truncates at the first space; `git -C <truncated>` then
# fails and the lane is dropped from BOTH the enumeration and the ownership
# comparison -- the hook goes silent about a lane that exists, which is the one
# failure direction it must never have. Documented as a fixed class in three
# sibling hooks here; this one was never converted. ---
git -C "$REPO" worktree add -q "$REPO/wt with space" -b feat/spaced HEAD
git -C "$REPO/wt with space" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
out=$(run_hook "$REPO" "$RUN")
check "a worktree path with a space is still enumerated" "3" "$(lanes_in "$out")"
if printf '%s' "$out" | grep -q 'feat/spaced'; then
  pass=$((pass + 1)); printf 'OK   the spaced lane is named\n'
else
  fail=$((fail + 1)); fail_log+="FAIL the spaced lane is not named\n"; printf 'FAIL the spaced lane is named\n'
fi

# --- ...and it can be the session's OWN lane. Enumeration and ownership read
# the same path through two different paths in the script, so a truncation that
# still enumerates could break only the comparison. ---
out=$(run_hook "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt with space\"}")
check "a spaced path can be the session's own lane" "ctx" "$(channel_of "$out")"
git -C "$REPO" worktree remove --force "$REPO/wt with space"
git -C "$REPO" branch -q -D feat/spaced

# --- A worktree path containing a BACKSLASH or a TAB is still matched. Both
# are legal in a path and neither is legal in a git refname, which is why the
# row is `branch<TAB>path` and split at the FIRST tab -- the branch side cannot
# contain one, so whatever follows is the whole path however it is spelled.
# These fence the two awk spellings that were tried and rejected: `-v root=...`
# expands backslash escapes in the value (the backslash case), and `-F'\t'`
# puts a tabbed path in the wrong field (the tab case). Neither was visible to
# any other case -- both mismatch quietly and fall through to the not-mine
# branch, which is the safe direction and therefore the silent one. ---
#
# The payload is built with `json.dumps`, not `printf`: a literal backslash or
# tab inside a JSON string is not valid JSON, so hand-formatting one makes the
# hook fall back to BASH_SOURCE and the case then passes or fails for a reason
# that has nothing to do with the path. Measured -- both cases failed that way
# on their first attempt. A real harness escapes these; the fixture must too.
odd_n=0
for odd in 'bs\path' "$(printf 'tab\tpath')"; do
  odd_n=$((odd_n + 1))
  git -C "$REPO" worktree add -q "$REPO/$odd" -b "feat/odd-$odd_n" HEAD
  git -C "$REPO/$odd" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
  payload=$(CWD="$REPO/$odd" python3 -c 'import json, os; print(json.dumps({"cwd": os.environ["CWD"]}))')
  out=$(run_hook "$REPO" "$RUN" "$payload")
  check "a path with a backslash or tab is the session's own lane [$odd_n]" "ctx" "$(channel_of "$out")"
  git -C "$REPO" worktree remove --force "$REPO/$odd"
  git -C "$REPO" branch -q -D "feat/odd-$odd_n"
done

# --- `stop_hook_active` as the STRING "false" must not silence the hook. Python
# treats any non-empty string as truthy, so the naive read makes this the same
# as `true` -- and since a hook that goes quiet still exits 0, the failure looks
# exactly like "no lanes" forever. The boolean cases above cannot see it. ---
out=$(run_hook "$REPO" "$RUN" '{"stop_hook_active": "false"}')
check "the string \"false\" does not count as a continuation" "2" "$(lanes_in "$out")"
out=$(run_hook "$REPO" "$RUN" '{"stop_hook_active": "true"}')
check "the string \"true\" does count as one" "" "$out"

# --- Malformed / absent stdin must not take the warning down with it. The hook
# reads stdin only to find one flag; a harness that sends nothing parseable is
# not a reason to go quiet about an unmerged lane. ---
# The channel is asserted alongside the count, not just the count: an
# unparseable payload yields no `cwd`, and a hook that fell back to claiming the
# FIRST lane as the session's own would still enumerate two and pass on the
# count alone -- measured, that mutation left the suite green.
out=$(run_hook "$REPO" "$RUN" 'not json at all')
check "fires when the event JSON is unparseable" "2" "$(lanes_in "$out")"
check "...and does not claim a lane it cannot attribute" "sys" "$(channel_of "$out")"
out=$(run_hook "$REPO" "$RUN" '')
check "fires when stdin is empty" "2" "$(lanes_in "$out")"
check "...and likewise claims nothing" "sys" "$(channel_of "$out")"

# --- The realistic `cwd`: a session sits SOMEWHERE INSIDE its worktree, rarely
# at the root. Resolution is via `rev-parse --show-toplevel`, so a subdirectory
# must attribute the same as the root; a naive string compare would not. ---
mkdir -p "$REPO/wt-two/src/deep"
out=$(run_hook "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-two/src/deep\"}")
check "a subdirectory of a lane attributes to that lane" "ctx" "$(channel_of "$out")"

# --- `cwd` in no git repository at all, and `cwd` in the MAIN tree: both are
# "not a lane of mine", and neither may error out. ---
out=$(run_hook "$REPO" "$RUN" "{\"cwd\": \"$SANDBOX\"}")
check "cwd outside any repo stays user-facing" "sys" "$(channel_of "$out")"
check "...and still exits 0" "0" "$(rc_of)"
out=$(run_hook "$REPO" "$RUN" "{\"cwd\": \"$REPO\"}")
check "cwd in the main tree stays user-facing" "sys" "$(channel_of "$out")"

printf '\nPass: %d  Fail: %d\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then
  printf '%b' "$fail_log" >&2
  exit 1
fi
