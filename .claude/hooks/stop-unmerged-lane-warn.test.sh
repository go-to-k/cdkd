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
# Every call starts from a CLEAN nudge record unless a case opts out with
# `run_hook_keep`. Since go-to-k/cdkd#2391 the hook nudges the model at most
# once per subject per session and downgrades a repeat to the user channel, so
# without this reset the cases below would each depend on how many earlier ones
# happened to share their branch -- and the six that assert `ctx` would pass or
# fail on their POSITION in the file rather than on the hook's behaviour.
# Measured: with the reset removed, five of them flip to `sys`.
clear_nudge_records() {
  find "$SANDBOX" -name 'stop-nudge-lane' -type f -delete 2>/dev/null || true
}

run_hook() {
  clear_nudge_records
  run_hook_keep "$@"
}

# The same call WITHOUT the reset -- for the cadence cases, which are precisely
# about what a second invocation does.
# `CLAUDE_CODE_SESSION_ID` is passed EXPLICITLY on every run, defaulting to
# empty, so the fallback path is deterministic: this suite runs inside a real
# Claude Code session, whose ambient value would otherwise leak in and decide
# what the no-`session_id` cases measure.
ENV_SID=""

run_hook_keep() {
  local dir="$1" hook="$2" stdin="${3-}"
  [ "$#" -ge 3 ] || stdin='{}'
  printf '%s' "$stdin" | (cd "$dir" && CLAUDE_CODE_SESSION_ID="$ENV_SID" bash "$hook")
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

# `text_of <output>` -> whichever channel's message the payload carried.
text_of() {
  printf '%s' "$1" | python3 -c '
import json, sys
raw = sys.stdin.read()
if not raw.strip():
    print(""); raise SystemExit
d = json.loads(raw)
print(d.get("hookSpecificOutput", {}).get("additionalContext") or d.get("systemMessage") or "")
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

# bash 3.2 is NOT exercised on the HOOK by running THIS FILE under /bin/bash.
# The hook's shebang is `#!/usr/bin/env bash`, which resolves through PATH and
# finds whatever bash is first there -- Homebrew 5.x on a dev Mac -- so
# `/bin/bash <suite>` measured the SUITE under 3.2 and the SUBJECT under 5.x.
# `HOOK_BASH=/bin/bash` puts a `bash` shim first on PATH, so the shebang, the
# explicit `bash "$HOOK"` calls and any `bash` the hook itself spawns all run
# that interpreter instead. Run the suite BOTH ways; the tallies must match.
if [ -n "${HOOK_BASH:-}" ]; then
  # Resolved to an ABSOLUTE path first. `HOOK_BASH=bash` would otherwise make
  # `ln -sf bash <shim>/bash` a symlink pointing at ITSELF, and every hook
  # invocation would then die on ELOOP -- a suite-wide red with a cause nowhere
  # near the hook.
  HOOK_BASH_BIN="$(command -v "$HOOK_BASH" 2>/dev/null || printf '%s' "$HOOK_BASH")"
  case "$HOOK_BASH_BIN" in /*) ;; *) HOOK_BASH_BIN="$PWD/$HOOK_BASH_BIN" ;; esac
  HOOK_BASH_SHIM="$SANDBOX/bash32-shim"
  mkdir -p "$HOOK_BASH_SHIM"
  ln -sf "$HOOK_BASH_BIN" "$HOOK_BASH_SHIM/bash"
  PATH="$HOOK_BASH_SHIM:$PATH"
  export PATH
fi

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
check "a continuation does not re-arm, but still reaches the user" "sys" "$(channel_of "$out")"
check "...and the user is still told which lane" "2" "$(lanes_in "$out")"
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
check "the string \"true\" does count as one" "sys" "$(channel_of "$out")"

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

# --- CADENCE (go-to-k/cdkd#2391). `stop_hook_active` stops a nudge spinning
# INSIDE one turn; nothing stopped it firing again at every later turn-end for
# as long as the lane existed. Every case here fails against the pre-#2391
# hook, which had no record to consult and answered `ctx` unconditionally.
#
# These build their OWN lanes rather than reusing the ones above. An earlier
# draft borrowed `wt with space`, which by this point in the file has been
# removed -- so the case measured the not-my-lane branch and passed or failed on
# where it sat in the file, exactly the order-dependence `clear_nudge_records`
# exists to remove. They are also the only cases that must NOT reset the
# record, so they call `run_hook_keep`.
git -C "$REPO" worktree add -q "$REPO/wt-cad-a" -b feat/cad-a HEAD
git -C "$REPO/wt-cad-a" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
git -C "$REPO" worktree add -q "$REPO/wt-cad-b" -b feat/cad-b HEAD
git -C "$REPO/wt-cad-b" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work

A1="{\"cwd\": \"$REPO/wt-cad-a\", \"session_id\": \"sess-one\"}"
A2="{\"cwd\": \"$REPO/wt-cad-a\", \"session_id\": \"sess-two\"}"
B1="{\"cwd\": \"$REPO/wt-cad-b\", \"session_id\": \"sess-one\"}"

clear_nudge_records
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "first sight of a lane nudges the model" "ctx" "$(channel_of "$out")"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "the same lane again does NOT force a second turn" "sys" "$(channel_of "$out")"
# The downgrade must not be a MUTE. Choosing `systemMessage` over silence is the
# whole point -- the human keeps seeing the lane -- and a hook that simply
# exited would also read as "not ctx" and pass the line above.
if printf '%s' "$out" | grep -q 'feat/cad-a'; then
  pass=$((pass + 1)); printf 'OK   ...but the user is still told which lane\n'
else
  fail=$((fail + 1)); fail_log+="FAIL the downgraded warning still names the lane\n"; printf 'FAIL the downgraded warning still names the lane\n'
fi

# A different LANE is a different subject, so it re-arms. Without this the first
# lane of a session would silence every later one -- strictly worse than the
# bounded cost being paid here. The two lanes keep SEPARATE records, since each
# lives in its own worktree git dir, so this cannot be satisfied by a single
# shared slot.
out=$(run_hook_keep "$REPO" "$RUN" "$B1")
check "a different lane in the same session nudges again" "ctx" "$(channel_of "$out")"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "...and the first lane stays quiet, records being per-worktree" "sys" "$(channel_of "$out")"

# A different SESSION gets its own one nudge. It also overwrites the record --
# one file per worktree, not one per session, so nothing accumulates in the git
# dir with no one to clean it up. The cost is that the earlier session re-arms
# once, which is an EXTRA nudge rather than a missed one; that direction is the
# reason the trade is acceptable, so it is pinned rather than left to be
# rediscovered as a bug.
out=$(run_hook_keep "$REPO" "$RUN" "$A2")
check "a DIFFERENT session gets its own one nudge" "ctx" "$(channel_of "$out")"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "...and a concurrent session's write costs an extra nudge, not a lost one" "ctx" "$(channel_of "$out")"

# --- PUSH STATE. It is in the SUBJECT (so unpushed -> pushed re-arms exactly
# once) and in the TEXT (so the message names which half of the work is left) --
# but NOT in the channel decision. go-to-k/cdkd#2391 proposed making it the
# discriminator; that would go quiet on a branch pushed with NO PR, which is a
# real failure and one of the two this hook exists to catch.
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "an unpushed lane says so in the text" "yes" "$(printf '%s' "$out" | grep -qF 'no upstream yet' && echo yes || echo no)"

# `remote.origin.fetch` is load-bearing, not boilerplate: without the refspec
# git refuses `@{u}` with "upstream branch ... not stored as a remote-tracking
# branch", the hook reads that as unpushed, and the two cases below pass or fail
# for a reason that has nothing to do with the cadence. Measured on the first
# attempt, which is how this comment came to exist.
git -C "$REPO" config remote.origin.url "$REPO"
git -C "$REPO" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git -C "$REPO" update-ref "refs/remotes/origin/feat/cad-a" "$(git -C "$REPO" rev-parse feat/cad-a)"
git -C "$REPO" config "branch.feat/cad-a.remote" origin
git -C "$REPO" config "branch.feat/cad-a.merge" refs/heads/feat/cad-a
check "the fixture really did give the lane an upstream" "0" "$(git -C "$REPO/wt-cad-a" rev-list --count '@{u}..' 2>/dev/null || echo MISSING)"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "pushing the lane re-arms the nudge once" "ctx" "$(channel_of "$out")"
check "...and the text switches to the pushed-but-maybe-no-PR wording" "yes" "$(printf '%s' "$out" | grep -qF 'pushed branch with NO PR' && echo yes || echo no)"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "...and a pushed lane stops nagging again after that one" "sys" "$(channel_of "$out")"

# --- The MIDDLE push arm: an upstream EXISTS and N commits are not on it. The
# two cases above only reach the OUTER two -- no upstream at all, and fully
# pushed -- so this branch had no case and corrupting its text left the suite
# green. It is also the arm an ordinary lane spends most of its life in: the
# first push happens early, and every commit after it lands here.
git -C "$REPO/wt-cad-a" -c user.email=t@t -c user.name=t commit -q --allow-empty -m 'work after the push'
check "the fixture really did leave one commit unpushed" "1" \
  "$(git -C "$REPO/wt-cad-a" rev-list --count '@{u}..' 2>/dev/null || echo MISSING)"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "the middle push arm names how many commits are unpushed" "yes" \
  "$(printf '%s' "$out" | grep -qF '1 commit(s) not yet pushed' && echo yes || echo no)"

# --- ...and `pushed -> unpushed` must NOT re-arm, which is the whole reason the
# predicate is DIRECTED. That transition is what an ordinary COMMIT looks like,
# so an undirected `prev_subject != subject` test re-armed on every commit and
# again on every push -- two forced continuations per cycle, forever. The fix
# had no case: every cadence case above moves the other way.
check "...and a new commit on a pushed lane does NOT re-arm" "sys" "$(channel_of "$out")"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "...still quiet on the repeat" "sys" "$(channel_of "$out")"

# The continuation flag outranks the cadence: the harness has already resumed
# once inside this turn, so even a freshly-armed subject must stay silent rather
# than swap channels and print the same wall of text twice.
clear_nudge_records
out=$(run_hook_keep "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-cad-b\", \"session_id\": \"sess-three\", \"stop_hook_active\": true}")
check "a resumed turn does not arm, even with a fresh subject" "sys" "$(channel_of "$out")"
# Going fully silent here was the old behaviour and it was wrong: the lane can
# be COMMITTED during the continuation, so this pass may be the first time the
# condition holds at all. A bare `systemMessage` does not continue a turn.
check "...and the user is told about it on that pass" "yes" \
  "$(printf '%s' "$out" | grep -qF 'feat/cad-b' && echo yes || echo no)"
# ...and that pass must not WRITE the record either. It reached the user only,
# so nothing the model could act on happened; recording the subject as OBSERVED
# turns "suppress this pass" into "suppress this subject for good" -- and since
# a lane can be COMMITTED during the continuation, the suppressed pass is
# routinely the FIRST sighting of that subject. Measured against the hook before
# the guard: resumed -> sys, then the next ordinary turn -> sys, where the
# cadence promises ctx for the first turn on which a subject is nudgeable.
check "...and writes NO record on that pass" "absent" \
  "$([ -e "$(git -C "$REPO/wt-cad-b" rev-parse --absolute-git-dir)/stop-nudge-lane" ] && echo present || echo absent)"
out=$(run_hook_keep "$REPO" "$RUN" '{"cwd": "'"$REPO"'/wt-cad-b", "session_id": "sess-three"}')
check "...so the next ordinary turn is that lane's FIRST nudge" "ctx" "$(channel_of "$out")"

# ...and an EXISTING record is left byte-identical. Absence alone would also be
# satisfied by a hook that had stopped recording altogether; this names the
# property directly. The stored subject is a DIFFERENT lane on purpose, so a
# rewrite changes the bytes rather than reproducing them.
CAD_B_RECORD="$(git -C "$REPO/wt-cad-b" rev-parse --absolute-git-dir)/stop-nudge-lane"
clear_nudge_records
printf 'sess-three\tfeat/cad-a:pushed\t111\n' >"$CAD_B_RECORD"
before_record=$(cat "$CAD_B_RECORD")
out=$(run_hook_keep "$REPO" "$RUN" '{"cwd": "'"$REPO"'/wt-cad-b", "session_id": "sess-three", "stop_hook_active": true}')
check "a resumed pass leaves an EXISTING lane record byte-identical" "$before_record" "$(cat "$CAD_B_RECORD")"

# --- The session id has TWO sources, and until 2026-08-31 only one of them was
# normalised. The payload's `session_id` was folded free of TAB and NEWLINE; the
# `CLAUDE_CODE_SESSION_ID` fallback landed AFTER that, raw. A tab or a newline
# there reaches the record, adds a field (or a whole second line), shifts the
# read-back, and `prev_sid` never matches again -- unbounded `additionalContext`
# on every turn, against the harness block cap, from the one input path with
# ZERO coverage: every case above passes an explicit `session_id`. Each case
# asserts the SECOND turn downgrades; asserting only that the first fires would
# pass against the broken hook too.
env_sid_case() {
  local label="$1" value="$2"
  clear_nudge_records
  ENV_SID="$value"
  local out
  out=$(run_hook_keep "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-cad-a\"}")
  check "the env session-id fallback arms once [$label]" "ctx" "$(channel_of "$out")"
  out=$(run_hook_keep "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-cad-a\"}")
  check "...and the cadence still BOUNDS it [$label]" "sys" "$(channel_of "$out")"
  ENV_SID=""
}
env_sid_case "plain" "env-sess-plain"
env_sid_case "leading tab" "$(printf '\tenv-sess-lead')"
env_sid_case "embedded tab" "$(printf 'env\tsess-mid')"
env_sid_case "embedded newline" "$(printf 'env\nsess-nl')"

# --- MALFORMED RECORDS. The record was parsed with `IFS=<TAB> read -r a b _`,
# the exact spelling stop-warn.sh replaced over a MEASURED bug: a TAB is IFS
# WHITESPACE, so `read` folds a RUN of them into ONE separator and an EMPTY
# subject field hands `prev_subject` the NEXT field along. When that field
# happens to parse as `<branch>:<state>` the predicate matches it and the lane
# goes QUIET -- a malformed record SILENCING the nudge, the one direction this
# must not fail in. `stop-warn.test.sh` fenced this three ways; this 77-case
# suite had no malformed-record case at all, so only the twin that already had
# the fix could detect its own regression.
CAD_A_RECORD="$(git -C "$REPO/wt-cad-a" rev-parse --absolute-git-dir)/stop-nudge-lane"
clear_nudge_records
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "the malformed-record fixture starts from a real arm" "ctx" "$(channel_of "$out")"
REAL_SUBJECT=$(awk -F'\t' 'NR==1{print $2}' "$CAD_A_RECORD")
check "...and the record really carries a subject to corrupt" "yes" \
  "$([ -n "$REAL_SUBJECT" ] && echo yes || echo no)"

# The DISCRIMINATING spelling: subject empty, and the field after it is a
# well-formed subject. Under the fold that field IS read as the subject and the
# nudge is suppressed.
printf 'sess-one\t\t%s\n' "$REAL_SUBJECT" >"$CAD_A_RECORD"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "an EMPTY subject field does not let the next field silence the lane" "ctx" "$(channel_of "$out")"
# ...and the plainer malformed spellings. These are CONTROLS, not fences: they
# arm under the fold too (the field they hand `prev_subject` is a timestamp,
# which never parses as this lane's `<branch>:<state>`), and they are here so
# the discriminating case above cannot be satisfied by a hook that simply
# stopped reading the record at all.
printf 'sess-one\t\t111\n' >"$CAD_A_RECORD"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "a record whose subject field is empty arms" "ctx" "$(channel_of "$out")"
printf 'sess-one\n' >"$CAD_A_RECORD"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "a record with no TAB at all arms" "ctx" "$(channel_of "$out")"
: >"$CAD_A_RECORD"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "an EMPTY record file arms" "ctx" "$(channel_of "$out")"
# ...and the control: a WELL-FORMED repeat still goes quiet, so the four cases
# above are not satisfied by a hook that simply stopped reading the record.
printf 'sess-one\t%s\t111\n' "$REAL_SUBJECT" >"$CAD_A_RECORD"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "...while a well-formed repeat still goes quiet" "sys" "$(channel_of "$out")"

# --- A nudge that cannot be RECORDED cannot be bounded. `[ "$persisted" = "1" ]
# || arm=0` had NO case in this suite -- deleting it left all 77 green -- while
# the same line in stop-warn.sh reddens one. Two shapes reach it, and the second
# is only reachable because `mv` reports success on it.
clear_nudge_records
CAD_A_GITDIR="$(git -C "$REPO/wt-cad-a" rev-parse --absolute-git-dir)"
chmod a-w "$CAD_A_GITDIR"
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
chmod u+w "$CAD_A_GITDIR"
check "an unwritable git dir downgrades to the user channel" "sys" "$(channel_of "$out")"
check "...but the lane is still named to the user" "yes" \
  "$(printf '%s' "$out" | grep -qF 'feat/cad-a' && echo yes || echo no)"

# --- The record path is a DIRECTORY. `mv -f <file> <dir>` returns SUCCESS -- it
# moves the tmp INSIDE the directory -- so the write was certified, the readback
# next turn found nothing, and EVERY turn re-armed `additionalContext` against
# the harness block cap while the git dir grew one orphan tmp per turn. That is
# the unbounded cadence this whole mechanism exists to remove, arriving through
# the success check. Measured with `mv` alone: `ctx ctx ctx`.
clear_nudge_records
mkdir -p "$CAD_A_RECORD"
dir_channels=""
for _ in 1 2 3; do
  out=$(run_hook_keep "$REPO" "$RUN" "$A1")
  dir_channels="${dir_channels}$(channel_of "$out") "
done
dir_orphans=$(find "$CAD_A_RECORD" -type f 2>/dev/null | wc -l | tr -d ' ')
rm -f "$CAD_A_RECORD"/* 2>/dev/null || true
rmdir "$CAD_A_RECORD" 2>/dev/null || true
check "a record path that is a DIRECTORY never arms the model channel" "sys sys sys " "$dir_channels"
check "...and leaves no orphan tmp behind in the git dir" "0" "$dir_orphans"

# The env fallback's SOURCE, keyed on the RECORD rather than on the reset. The
# four cases above clear the record before each value, so they fence the tab /
# newline FOLD and not the `CLAUDE_CODE_SESSION_ID` line they name: with that
# source removed every run reads `shared`, and a cleared record makes each
# value's FIRST run arm regardless. Driving A, B, A through ONE record is what
# separates them.
clear_nudge_records
env_src=""
for esid in 'src-a' 'src-b' 'src-a'; do
  ENV_SID="$esid"
  out=$(run_hook_keep "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-cad-a\"}")
  env_src="${env_src}$(channel_of "$out") "
done
ENV_SID=""
check "each env-supplied session gets its own nudge" "ctx ctx ctx " "$env_src"

# ...and NEITHER source present, so `sid` falls back to `shared`. That bucket
# has to be bounded like any other. (This does NOT discriminate the `shared`
# default itself: the record is parsed by parameter expansion, so an empty sid
# round-trips and compares equal without it. Measured -- deleting the default
# leaves this green. It is here for the cadence property, not as that fence.)
clear_nudge_records
noid=""
for _ in 1 2 3 4; do
  out=$(run_hook_keep "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-cad-a\"}")
  noid="${noid}$(channel_of "$out") "
done
check "a session with no id at all is still bounded after one nudge" "ctx sys sys sys " "$noid"

# --- A failed record write must say nothing on the hook's REAL stderr. The
# redirect is `2>/dev/null >"$tmp"`, in that order, and the order is the point:
# redirections apply left to right, and the open that FAILS is the fd-1 open of
# `$tmp`. Written `>"$tmp" 2>/dev/null` that open happens while fd 2 is still
# the real stderr, so "Permission denied" is printed there from an ADVISORY
# hook, on every turn. Nothing in this suite captured the hook's stderr.
clear_nudge_records
chmod a-w "$CAD_A_GITDIR"
stderr_on_ro=$(printf '%s' "$A1" | (cd "$REPO" && CLAUDE_CODE_SESSION_ID="" bash "$RUN" 2>&1 >/dev/null))
chmod u+w "$CAD_A_GITDIR"
check "an unwritable git dir prints nothing on the hook's real stderr" "" "$stderr_on_ro"

# --- The user text's CLOSING CLAUSE is per downgrade path. "The agent has
# already been told" is true on exactly ONE of the three: on the RESUMED path
# this pass may be the first time the condition holds at all, and on the
# UNPERSISTABLE-RECORD path `arm` is forced 0 every turn, so the agent is never
# told and the user was assured otherwise forever. One string across all three
# re-committed, in the user's own voice, the defect the channel split exists to
# fix. The sibling `stop-cleanup-warn.sh` in the other repo omits the claim
# entirely; this one states the truth per path instead.
TOLD='already been told'
# 1. repeat subject -- the one path where the claim is TRUE.
clear_nudge_records
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
check "the repeat-subject downgrade DOES say the agent was told" "yes" \
  "$(printf '%s' "$out" | grep -qF "$TOLD" && echo yes || echo no)"
# 2. resumed pass -- the agent was not interrupted on this pass.
clear_nudge_records
out=$(run_hook_keep "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-cad-a\", \"session_id\": \"sess-voice-res\", \"stop_hook_active\": true}")
check "the RESUMED downgrade does not claim the agent was told" "no" \
  "$(printf '%s' "$out" | grep -qF "$TOLD" && echo yes || echo no)"
check "...and says why it is on this channel instead" "yes" \
  "$(printf '%s' "$out" | grep -qF 'continued once' && echo yes || echo no)"
# 3. unpersistable record -- the agent is NEVER told on this path.
clear_nudge_records
chmod a-w "$CAD_A_GITDIR"
out=$(run_hook_keep "$REPO" "$RUN" "{\"cwd\": \"$REPO/wt-cad-a\", \"session_id\": \"sess-voice-nop\"}")
chmod u+w "$CAD_A_GITDIR"
check "the UNPERSISTABLE downgrade does not claim the agent was told" "no" \
  "$(printf '%s' "$out" | grep -qF "$TOLD" && echo yes || echo no)"
check "...and says the nudge could not be recorded" "yes" \
  "$(printf '%s' "$out" | grep -qF 'could not record' && echo yes || echo no)"


# --- The cadence record must not OUTLIVE the condition. When no worktree is
# ahead of `origin/main` any more, the stored subject is stale, and returning
# to the same branch in the same push state reproduces it exactly -- so the
# next genuine first-sighting is DOWNGRADED. That is a MISSED nudge, the unsafe
# direction. Reachable through the very remedy this hook prints: nudge, repeat,
# `git switch --detach origin/main`, re-attach, commit. Its sibling
# `stop-warn.sh` has always dropped its record on the clean-tree exit.
#
# A SEPARATE sandbox repo, because the property is repo-GLOBAL ("no lane
# anywhere is ahead") and the fixtures above leave other lanes standing.
CLR_REPO="$SANDBOX/clear-repo"
mkdir -p "$CLR_REPO/.claude/hooks"
cp "$HOOK" "$CLR_REPO/.claude/hooks/"
CLR_RUN="$CLR_REPO/.claude/hooks/$(basename "$HOOK")"
git -C "$CLR_REPO" init -q .
git -C "$CLR_REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$CLR_REPO" update-ref refs/remotes/origin/main HEAD
git -C "$CLR_REPO" worktree add -q "$CLR_REPO/wt-clr" -b feat/clr HEAD
git -C "$CLR_REPO/wt-clr" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
CLR_PAYLOAD="{\"cwd\": \"$CLR_REPO/wt-clr\", \"session_id\": \"sess-clr\"}"
out=$(run_hook_keep "$CLR_REPO" "$CLR_RUN" "$CLR_PAYLOAD")
check "the clearing fixture arms once" "ctx" "$(channel_of "$out")"
out=$(run_hook_keep "$CLR_REPO" "$CLR_RUN" "$CLR_PAYLOAD")
check "...and the repeat is downgraded" "sys" "$(channel_of "$out")"
# The condition CLEARS: the lane is no longer ahead of origin/main.
git -C "$CLR_REPO/wt-clr" reset -q --hard origin/main
out=$(run_hook_keep "$CLR_REPO" "$CLR_RUN" "$CLR_PAYLOAD")
check "...the hook is silent once nothing is ahead" "" "$out"
check "...and the stale record is gone" "absent" \
  "$([ -e "$(git -C "$CLR_REPO/wt-clr" rev-parse --absolute-git-dir)/stop-nudge-lane" ] && echo present || echo absent)"
# ...and the same subject is a FIRST sighting again.
git -C "$CLR_REPO/wt-clr" -c user.email=t@t -c user.name=t commit -q --allow-empty -m 'work again'
out=$(run_hook_keep "$CLR_REPO" "$CLR_RUN" "$CLR_PAYLOAD")
check "...so the SAME subject nudges the model again" "ctx" "$(channel_of "$out")"
git -C "$CLR_REPO" worktree remove --force "$CLR_REPO/wt-clr"


# --- The two channels must not carry the SAME text. Every word of the own-lane
# warning is an INSTRUCTION ("you are not done: rebase, run the gates, open the
# PR, merge"), and on the downgrade paths it was reaching the human verbatim --
# go-to-k/cdkd#2389's defect reproduced inside its own fix, and now on three
# paths (a repeat subject, a resumed pass, an unpersistable record) rather than
# one. The user text states the same FACT without addressing the reader as the
# agent, which is why the push-state wording is split into a fact and a todo.
clear_nudge_records
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
ctx_text=$(text_of "$out")
out=$(run_hook_keep "$REPO" "$RUN" "$A1")
sys_text=$(text_of "$out")
check "the model and user channels carry DIFFERENT text" "differ" \
  "$([ "$ctx_text" = "$sys_text" ] && echo same || echo differ)"
check "...the MODEL text carries the instruction" "yes" \
  "$(printf '%s' "$ctx_text" | grep -qF 'rebase, run the gates, open the PR, merge' && echo yes || echo no)"
check "...and the USER text does NOT address the reader as the agent" "no" \
  "$(printf '%s' "$sys_text" | grep -qF 'rebase, run the gates, open the PR, merge' && echo yes || echo no)"
check "...while still naming the lane and its push state" "yes" \
  "$(printf '%s' "$sys_text" | grep -qF "worktree is on 'feat/cad-a'" && echo yes || echo no)"

git -C "$REPO" worktree remove --force "$REPO/wt-cad-a"
git -C "$REPO" worktree remove --force "$REPO/wt-cad-b"
clear_nudge_records


# A FLOOR on the case total. Every `for` loop above expands a LIST, and emptying
# one -- or deleting a case -- removes assertions SILENTLY while the tally still
# reads `fail: 0`. No suite in this repo had one, so the only thing standing
# between a gutted loop and a green run was somebody noticing the number move.
# Raise it when cases are added; never lower it to make a red run green.
CASE_FLOOR=101
if [ "$((pass + fail))" -lt "$CASE_FLOOR" ]; then
  fail=$((fail + 1))
  fail_log+="FAIL case floor: only $((pass + fail)) cases ran, expected at least 101\n"
  printf 'FAIL case floor: only %s cases ran, expected at least %s\n' "$((pass + fail))" "$CASE_FLOOR"
fi
printf '\nPass: %d  Fail: %d\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then
  printf '%b' "$fail_log" >&2
  exit 1
fi
