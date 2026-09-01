#!/usr/bin/env bash
# stop-warn.test.sh
#
# Smoke suite for `stop-warn.sh`. It had none until go-to-k/cdkd#2396: the hook
# was seven lines of `git status` plus a `printf`, and `.claude/rules/hooks.md`
# listed it as one of the two hooks with no suite of its own. #2396 gave it a
# channel decision and a cadence rule, which is behaviour, and behaviour that
# only exists in a comment is behaviour nobody can regress against.
#
# What the cases are ABOUT, so a later reader does not have to infer it:
#   - the CHANNEL. `additionalContext` reaches the model and CONTINUES the turn;
#     `systemMessage` reaches only the user and lets it end. The warning's text
#     is addressed to the agent, so the first is what it needs -- and this hook
#     cannot use it unconditionally, because its condition (a dirty tree) holds
#     for most of a session.
#   - the CADENCE. One nudge per subject, where the subject is whether a commit
#     is POSSIBLE, re-armed only in the direction that opens a new action. The
#     `commitable -> blocked` row is the one that matters most and is the
#     easiest to get wrong: editing anything in the gate's scope invalidates the
#     marker, so re-arming there would restore the every-turn cadence the rule
#     exists to bound.
set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stop-warn.sh"

pass=0
fail=0
fail_log=""

check() {
  local name="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    pass=$((pass + 1))
    printf 'OK   %s\n' "$name"
  else
    fail=$((fail + 1))
    fail_log="${fail_log}FAIL $name: want '$want', got '$got'\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# `pwd -P` for the same reason the sibling suite documents: on macOS `mktemp -d`
# hands back `/var/folders/...` while the hook canonicalises its own root with
# `cd ... && pwd`, so an uncanonicalised sandbox compares two spellings of one
# directory and any case resting on that equality passes regardless.
SANDBOX="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$SANDBOX"' EXIT

REPO="$SANDBOX/repo"
mkdir -p "$REPO/.claude/hooks"
cp "$HOOK" "$REPO/.claude/hooks/"
RUN="$REPO/.claude/hooks/stop-warn.sh"

git -C "$REPO" init -q .
# The sandbox carries its own copy of the hook under `.claude/`, which would
# otherwise leave `git status --porcelain` non-empty FOREVER -- so the clean-tree
# case would arm the nudge and every later case would be reading a state one step
# ahead of the one it names. Measured: without this line three cases fail and a
# fourth passes for the wrong reason.
# `mkdir -p` is required, not defensive: this git does NOT create `.git/info/`
# on `init`, so the redirect below fails silently (no `set -e` here) and the
# exclude never exists. That is how the first attempt still saw `?? .claude/`.
mkdir -p "$REPO/.git/info"
printf '.claude/\n' >"$REPO/.git/info/exclude"
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

# The markgate stand-in. The hook prefers a `markgate` on PATH over `mise exec`,
# so a shim first on PATH is what it will pick up. Its verdict is a file rather
# than an env var so a case can flip it between two invocations without
# re-exporting anything.
BIN="$SANDBOX/bin"
mkdir -p "$BIN"
VERDICT="$SANDBOX/verdict"
cat >"$BIN/markgate" <<SHIM
#!/usr/bin/env bash
# Only ever asked \`verify check\`; anything else is a case that has drifted.
[ "\$1" = "verify" ] && [ "\$2" = "check" ] || exit 3
[ "\$(cat "$VERDICT" 2>/dev/null)" = "fresh" ]
SHIM
chmod +x "$BIN/markgate"
PATH="$BIN:$PATH"
export PATH

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

# Every call starts from a CLEAN nudge record unless a case opts out with
# `run_hook_keep`. The sibling lane suite has had this since go-to-k/cdkd#2391
# and this one did not, so each of its `ctx` assertions passed or failed on its
# POSITION in the file rather than on the hook's behaviour: inserting one extra
# dirty-tree run anywhere above flipped every later first-sight case to `sys`.
# The record is per-worktree, so the sweep is over the whole sandbox rather than
# over one path -- the worktree case below has a second one.
clear_nudge_records() {
  find "$SANDBOX" -name 'stop-nudge-warn' -type f -delete 2>/dev/null || true
}

# `stdin` defaults to `{}` rather than being left unfed: unfed, the hook's `cat`
# inherits this script's stdin and a case can HANG instead of failing -- and a
# Stop hook that hangs never lets a turn end.
run_hook() {
  clear_nudge_records
  run_hook_keep "$@"
}

# The same call WITHOUT the reset -- for the cadence cases, which are precisely
# about what a SECOND invocation does. `run_hook_dir` runs a copy of the hook
# from another worktree, keeping the record.
run_hook_keep() {
  run_hook_dir "$REPO" "$RUN" "$@"
}

# `CLAUDE_CODE_SESSION_ID` is passed EXPLICITLY on every run, defaulting to
# empty, so the fallback path is deterministic: this suite runs inside a real
# Claude Code session, whose ambient value would otherwise leak in and decide
# what the no-`session_id` cases measure.
ENV_SID=""

run_hook_dir() {
  local dir="$1" hook="$2" stdin="${3-}"
  [ "$#" -ge 3 ] || stdin='{}'
  printf '%s' "$stdin" | (cd "$dir" && CLAUDE_CODE_SESSION_ID="$ENV_SID" bash "$hook")
  printf '%s' "$?" >"$RC_FILE"
}

rc_of() { cat "$RC_FILE"; }

channel_of() {
  printf '%s' "$1" | python3 -c '
import json, sys
raw = sys.stdin.read()
if not raw.strip():
    print("none")
    sys.exit()
try:
    d = json.loads(raw)
except ValueError:
    print("unparseable")
    sys.exit()
ctx = bool(d.get("hookSpecificOutput", {}).get("additionalContext"))
sysm = bool(d.get("systemMessage"))
print("BOTH" if ctx and sysm else "ctx" if ctx else "sys" if sysm else "none")
'
}

text_of() {
  printf '%s' "$1" | python3 -c '
import json, sys
raw = sys.stdin.read()
if not raw.strip():
    print("")
    sys.exit()
d = json.loads(raw)
print(d.get("hookSpecificOutput", {}).get("additionalContext") or d.get("systemMessage") or "")
'
}

record_path() {
  printf '%s\n' "$(git -C "$REPO" rev-parse --absolute-git-dir)/stop-nudge-warn"
}

S1='{"session_id": "sess-one"}'
S2='{"session_id": "sess-two"}'

# --- SILENT on a clean tree. The expensive half to get right: a warning on
# every turn-end of a clean session is indistinguishable from noise. ---
printf 'stale\n' >"$VERDICT"
out=$(run_hook "$S1")
check "silent when the tree is clean" "" "$out"
check "...and silent means exit 0, not a crash" "0" "$(rc_of)"

# --- DIRTY, commit blocked. First turn-end of the spell: the model has not been
# told, and the action it is being told about (`/check`) is one it can take. ---
printf 'work\n' >"$REPO/file.txt"
out=$(run_hook "$S1")
check "a dirty tree with a stale marker reaches the MODEL" "ctx" "$(channel_of "$out")"
check "...and says which command unblocks the commit" "yes" \
  "$(printf '%s' "$(text_of "$out")" | grep -qF 'Run /check' && echo yes || echo no)"
check "...and shows what is dirty" "yes" \
  "$(printf '%s' "$(text_of "$out")" | grep -qF 'file.txt' && echo yes || echo no)"

# --- The same subject again. This is the whole point of the cadence rule: the
# model has already been told and chose to stop, so a second forced turn buys
# nothing. It must still reach the USER, which is why the downgrade target is
# `systemMessage` and not silence -- a hook that simply exited would also read
# as "not ctx" and satisfy a channel assertion alone. ---
out=$(run_hook_keep "$S1")
check "the same subject does NOT force a second turn" "sys" "$(channel_of "$out")"
check "...but the user is still shown the warning" "yes" \
  "$(printf '%s' "$(text_of "$out")" | grep -qF 'Uncommitted changes' && echo yes || echo no)"

# --- Editing more of the same dirty tree is NOT a new subject. The subject is
# deliberately not the CONTENT of the dirty set: ordinary work changes that on
# every turn, and keying on it would leave the cadence exactly as unbounded as
# it was before the rule existed. ---
printf 'more\n' >>"$REPO/file.txt"
printf 'second\n' >"$REPO/other.txt"
out=$(run_hook_keep "$S1")
check "editing more files is not a new subject" "sys" "$(channel_of "$out")"

# --- blocked -> commitable RE-ARMS. `/check` just passed, so `git commit` is an
# action that was not available a turn ago. This is the one transition worth a
# forced turn. ---
printf 'fresh\n' >"$VERDICT"
out=$(run_hook_keep "$S1")
check "the marker turning fresh re-arms the nudge" "ctx" "$(channel_of "$out")"
check "...and the text switches to commit-allowed" "yes" \
  "$(printf '%s' "$(text_of "$out")" | grep -qF 'commit allowed' && echo yes || echo no)"
out=$(run_hook_keep "$S1")
check "...and then stops nagging again" "sys" "$(channel_of "$out")"

# --- commitable -> blocked does NOT re-arm, and this is the case the rule was
# written for. Editing any file in the check gate's scope invalidates the
# marker, so this transition is what ORDINARY WORK looks like; a symmetric key
# would re-arm on it and hand back the every-turn cadence. A hook that keyed on
# "the subject changed" rather than on the DIRECTION of the change passes every
# other case in this file and fails only this one. ---
printf 'stale\n' >"$VERDICT"
out=$(run_hook_keep "$S1")
check "the marker going stale again does NOT re-arm" "sys" "$(channel_of "$out")"

# --- A different session gets its own single nudge: the record is keyed by
# session id, so a fresh session is never silenced by its predecessor. ---
out=$(run_hook_keep "$S2")
check "a different session gets its own one nudge" "ctx" "$(channel_of "$out")"

# --- Committing ends the spell, and the record must go with it. Without the
# delete, a session that commits and then starts new work would stay on the
# user channel for the rest of its life -- silent about exactly the state this
# hook exists to catch. ---
git -C "$REPO" add -A
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q -m work
out=$(run_hook_keep "$S1")
check "a clean tree is silent again" "" "$out"
check "...and the nudge record is gone" "absent" \
  "$([ -e "$(record_path)" ] && echo present || echo absent)"
printf 'third\n' >"$REPO/third.txt"
out=$(run_hook_keep "$S1")
check "so the NEXT dirty spell starts armed" "ctx" "$(channel_of "$out")"

# --- `stop_hook_active`: the harness already resumed this turn on a hook's
# account. Repeating anything here spins the turn, so the hook stands down
# entirely rather than swapping channels and printing the same lines twice. ---
# Going fully silent on a resumed turn was the first draft and it was wrong: the
# tree can become dirty DURING the continuation, so that pass may be the first
# time the condition holds at all, and the user would never be told. A bare
# `systemMessage` does not continue a turn, so it costs nothing.
out=$(run_hook '{"session_id": "sess-nine", "stop_hook_active": true}')
check "a resumed turn does not arm, even with a fresh subject" "sys" "$(channel_of "$out")"
check "...but the user is still told on that pass" "yes" \
  "$(printf '%s' "$(text_of "$out")" | grep -qF 'Uncommitted changes' && echo yes || echo no)"
check "...and still exits 0" "0" "$(rc_of)"
# The string "false" is truthy in Python, so a naive read of the flag would
# silence the hook permanently against a harness that spells it that way.
out=$(run_hook '{"session_id": "sess-ten", "stop_hook_active": "false"}')
check 'the string "false" does not count as a continuation' "ctx" "$(channel_of "$out")"
out=$(run_hook_keep '{"session_id": "sess-ten", "stop_hook_active": "true"}')
check 'the string "true" does count as one' "sys" "$(channel_of "$out")"

# --- Malformed and absent payloads. The hook must still WARN (the tree really
# is dirty) and must not crash; an unattributable session falls back to a shared
# key, which costs at most one extra nudge. ---
# "not none" was all these used to ask, which ANY output satisfies -- including
# a hook that had crashed into a `systemMessage` fragment, or one that answered
# `unparseable`. Each half is now named: the CHANNEL (a first sighting under a
# cleared record arms, exactly as a well-formed payload does, so losing the
# `except ValueError` fallback and reading `sid` as empty would still show here),
# the TEXT (the warning is the actual warning, not a stray field), and a REPEAT
# on the same unreadable payload, which pins that the fallback key is STABLE --
# a fallback that varied per call would re-arm forever and is invisible from one
# invocation.
out=$(run_hook 'not json at all')
check "an unparseable event still reaches the model on first sight" "ctx" "$(channel_of "$out")"
check "...and the text is the warning itself" "yes" \
  "$(printf '%s' "$(text_of "$out")" | grep -qF 'Uncommitted changes' && echo yes || echo no)"
check "...and still exits 0" "0" "$(rc_of)"
out=$(run_hook_keep 'not json at all')
check "...and its fallback session key is stable, so it settles" "sys" "$(channel_of "$out")"
out=$(run_hook '')
check "empty stdin still reaches the model on first sight" "ctx" "$(channel_of "$out")"
check "...and it too says what is wrong" "yes" \
  "$(printf '%s' "$(text_of "$out")" | grep -qF 'Uncommitted changes' && echo yes || echo no)"

# --- Output must be VALID JSON on every path. The pre-#2396 hook built its
# payload with a hand-rolled `printf` that sliced a python-escaped string, so a
# missing python3 printed a truncated object rather than nothing. ---
out=$(run_hook '{"session_id": "sess-json"}')
check "the payload parses as JSON" "yes" \
  "$([ "$(channel_of "$out")" = "unparseable" ] && echo no || echo yes)"

# --- No python3: say NOTHING rather than emit a fragment, and exit 0 rather
# than 127 -- an ERROR reported on every single turn from a hook whose whole job
# is advisory. `command -v python3` is the hook's own guard, and reaching it is
# the hard part of the case.
#
# An EMPTIED PATH does not reach it. `bash` itself becomes unfindable (so the
# subshell dies before the hook starts -- measured, it printed
# `bash: command not found` while reporting OK), and even with `$BASH` named
# absolutely the hook dies earlier still: `dirname` is gone, `REPO` is empty,
# and `cd ""` takes the `exit 0` above. Either way the case passes on an empty
# output that proves nothing about the guard, and DELETING the guard left this
# suite fully green.
#
# So the stub PATH carries every external the hook reaches for and only omits
# `python3`: `dirname` and `git` to get past the resolution above, `sed` / `date`
# / `rm` / `mv` / `cat` so that a hook WITHOUT the guard runs on to its final
# `python3 -c` and exits 127 there rather than failing earlier for an unrelated
# reason. `markgate` is deliberately absent, which is a legitimate state (the
# hook falls back to `mise`, then to no verifier at all).
STUBBIN="$SANDBOX/no-python"
mkdir -p "$STUBBIN"
for c in bash env dirname git sed date rm mv cat; do
  ln -sf "$(command -v "$c")" "$STUBBIN/$c"
done
out=$(printf '%s' '{}' | (cd "$REPO" && PATH="$STUBBIN" bash "$RUN") 2>/dev/null; printf '%s' "$?" >"$RC_FILE")
check "no python3 means silence, not a broken payload" "" "$out"
check "...and exits 0 rather than 127" "0" "$(rc_of)"

# --- Outside a git repository at all: nothing to report, and no error. ---
mkdir -p "$SANDBOX/notarepo/.claude/hooks"
cp "$HOOK" "$SANDBOX/notarepo/.claude/hooks/"
out=$(printf '%s' '{}' | (cd "$SANDBOX/notarepo" && bash "$SANDBOX/notarepo/.claude/hooks/stop-warn.sh"))
check "a non-repo directory is silent" "" "$out"

# --- The cdkd#563 quoted-body false-positive pair. This hook takes no command
# and cannot be triggered by one, which is exactly why the pair is here: it
# pins that property rather than leaving it to be assumed. ---
out=$(run_hook '{"session_id": "sess-quoted"}')
check "the quoted-body control arms as any first sight does" "ctx" "$(channel_of "$out")"
out=$(run_hook_keep '{"session_id": "sess-quoted", "prompt": "git commit -m \"gh pr merge 5\""}')
check "an unrelated field carrying a gated command changes nothing" "sys" "$(channel_of "$out")"

# --- Registration. The suite invokes the hook directly, so it would stay green
# against a hook that had been unregistered from settings.json entirely. ---
SETTINGS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/settings.json"
check "the hook is still registered as a Stop hook" "yes" \
  "$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
cmds = [h.get("command", "") for e in d.get("hooks", {}).get("Stop", []) for h in e.get("hooks", [])]
print("yes" if any("stop-warn.sh" in c for c in cmds) else "no")
' "$SETTINGS")"

# --- The record holds the last OBSERVED subject, not the last NUDGED one, and
# that distinction is a whole bug rather than a nicety. Writing it only when
# arming froze `prev_subject` at `commitable`, so the SECOND `/check` pass of one
# dirty spell -- a moment when committing genuinely became possible again -- was
# silent. Measured on the first draft: `fresh -> ctx, stale -> sys, fresh -> sys`,
# where the table promises `ctx`. This is the case that pins the fix; it passes
# against a hook that records on both arms and fails against one that does not.
# Re-establish S1 as the recorded session first: the cases just above ran under
# a different session id, so a bare S1 run here would arm for that reason and
# measure nothing about the transition this block is about.
printf 'stale\n' >"$VERDICT"
out=$(run_hook "$S1")
check "re-entering with a new session arms, as always" "ctx" "$(channel_of "$out")"
out=$(run_hook_keep "$S1")
check "...and settles again on the same subject" "sys" "$(channel_of "$out")"
printf 'fresh\n' >"$VERDICT"
out=$(run_hook_keep "$S1")
check "the marker turning fresh AGAIN re-arms" "ctx" "$(channel_of "$out")"
printf 'stale\n' >"$VERDICT"
out=$(run_hook_keep "$S1")
check "...and going stale again still does not" "sys" "$(channel_of "$out")"
printf 'fresh\n' >"$VERDICT"
out=$(run_hook_keep "$S1")
check "...and the NEXT fresh pass arms too, not just the first" "ctx" "$(channel_of "$out")"

# --- A nudge that cannot be RECORDED cannot be bounded, and an unbounded one is
# exactly what the cadence exists to remove -- so an unwritable git dir costs the
# MODEL channel, not the warning. Without this the hook degrades to a forced
# continuation on every single turn, silently.
printf 'stale\n' >"$VERDICT"
rm -f "$(record_path)"
chmod a-w "$(git -C "$REPO" rev-parse --absolute-git-dir)"
out=$(run_hook '{"session_id": "sess-ro"}')
chmod u+w "$(git -C "$REPO" rev-parse --absolute-git-dir)"
check "an unwritable git dir downgrades to the user channel" "sys" "$(channel_of "$out")"
check "...but the user is still warned" "yes" \
  "$(printf '%s' "$(text_of "$out")" | grep -qF 'Uncommitted changes' && echo yes || echo no)"

# --- A MALFORMED record falls to ARM, which is the safe direction: an extra
# nudge costs one forced turn, a missed one costs the whole guardrail. The
# record is written tmp-then-`mv`, so a half-line should not be reachable -- but
# a concurrent session, a truncating filesystem or a hand-edit can all produce
# one, and the hook must not read a subject out of a line that has none. Only
# the `[ -z "$prev_subject" ]` arm of the predicate answers these; deleting it
# left the suite green before they existed.
printf 'stale\n' >"$VERDICT"
MAL='{"session_id": "sess-mal"}'
TAB=$(printf '\t')

clear_nudge_records
printf 'sess-mal%s%s123\n' "$TAB" "$TAB" >"$(record_path)"
out=$(run_hook_keep "$MAL")
check "a record with an EMPTY subject arms" "ctx" "$(channel_of "$out")"

clear_nudge_records
printf 'sess-mal\n' >"$(record_path)"
out=$(run_hook_keep "$MAL")
check "a record with too FEW fields arms" "ctx" "$(channel_of "$out")"

# The control, and it is a deliberate assertion of the CURRENT design rather
# than of the three above: the timestamp field is recorded but never read, so a
# garbage third field is not a malformed record and must NOT buy an extra nudge.
# Without this the three cases above would also be satisfied by a hook that
# armed on anything it found surprising, which is a different rule.
clear_nudge_records
printf 'sess-mal%sblocked%snot-a-number\n' "$TAB" "$TAB" >"$(record_path)"
out=$(run_hook_keep "$MAL")
check "a garbage TIMESTAMP is not malformed: the field is never read" "sys" "$(channel_of "$out")"

# --- The record is PER-WORKTREE, resolved with `rev-parse --absolute-git-dir`.
# A linked worktree resolves to `.git/worktrees/<name>`, so two lanes in one
# checkout never silence each other and removing a worktree takes its record
# with it. Every case above runs in ONE tree, so swapping the resolution to
# `--git-common-dir` -- which sends every worktree to the main tree's single
# file -- left the suite green.
git -C "$REPO" worktree add -q "$SANDBOX/wt-iso" -b feat/iso HEAD
mkdir -p "$SANDBOX/wt-iso/.claude/hooks"
cp "$HOOK" "$SANDBOX/wt-iso/.claude/hooks/"
printf 'lane work\n' >"$SANDBOX/wt-iso/wt-work.txt"
WT_RUN="$SANDBOX/wt-iso/.claude/hooks/stop-warn.sh"

clear_nudge_records
out=$(run_hook_keep "$S1")
check "the main tree arms on first sight, as always" "ctx" "$(channel_of "$out")"
out=$(run_hook_keep "$S1")
check "...and settles" "sys" "$(channel_of "$out")"
# SAME session id, SAME subject, DIFFERENT worktree: this must arm, because the
# lane has its own record and has never been nudged.
out=$(run_hook_dir "$SANDBOX/wt-iso" "$WT_RUN" "$S1")
check "a linked worktree keeps its OWN record, so it arms" "ctx" "$(channel_of "$out")"
check "...and the record landed in the worktree's git dir, not the main one" "present" \
  "$([ -e "$(git -C "$SANDBOX/wt-iso" rev-parse --absolute-git-dir)/stop-nudge-warn" ] && echo present || echo absent)"
out=$(run_hook_dir "$SANDBOX/wt-iso" "$WT_RUN" "$S1")
check "...and then settles there too" "sys" "$(channel_of "$out")"
git -C "$REPO" worktree remove --force "$SANDBOX/wt-iso"
git -C "$REPO" branch -q -D feat/iso

# --- A RESUMED pass must not WRITE the record. It reached the user only, so
# nothing the model could act on happened; recording the subject as OBSERVED
# turns "suppress this pass" into "suppress this subject for good". And the
# condition can become true DURING the continuation -- which is the whole reason
# the resumed arm stops short of silence -- so the pass being suppressed is
# routinely the FIRST sighting of that subject.
#
# Measured against the hook before this guard: `{active, blocked} -> sys` and
# then the very next ordinary turn `{blocked} -> sys`, where the cadence promises
# `ctx` for the first turn on which a subject is nudgeable at all. No case
# asserted it, in either suite.
clear_nudge_records
out=$(run_hook_keep '{"session_id": "sess-resumed", "stop_hook_active": true}')
check "a resumed pass reaches the user" "sys" "$(channel_of "$out")"
check "...and writes NO record" "absent" \
  "$([ -e "$(record_path)" ] && echo present || echo absent)"
out=$(run_hook_keep '{"session_id": "sess-resumed"}')
check "...so the next ordinary turn is that subject's FIRST nudge" "ctx" "$(channel_of "$out")"

# ...and an EXISTING record is left byte-identical, not rewritten with the same
# content. Absence alone would also be satisfied by a hook that had stopped
# recording altogether -- which the cadence cases above catch, but only as a
# scatter of unrelated failures. This one names the property directly.
clear_nudge_records
printf 'sess-resumed%scommitable%s111\n' "$TAB" "$TAB" >"$(record_path)"
before_record=$(cat "$(record_path)")
out=$(run_hook_keep '{"session_id": "sess-resumed", "stop_hook_active": true}')
check "a resumed pass leaves an EXISTING record byte-identical" "$before_record" "$(cat "$(record_path)")"

# --- The session id has TWO sources, and until 2026-08-31 only one of them was
# normalised. The payload's `session_id` was folded free of TAB and NEWLINE; the
# `CLAUDE_CODE_SESSION_ID` fallback landed AFTER that, raw. A tab or a newline
# there reaches the record, adds a field (or a whole second line), shifts the
# read-back, and `prev_sid` never matches again -- so every turn re-arms, which
# is unbounded `additionalContext` against the harness block cap, from the one
# input path with ZERO coverage: every case above passes an explicit
# `session_id`. Each case asserts the SECOND turn downgrades; asserting only
# that the first fires would pass against the broken hook too.
printf 'stale\n' >"$VERDICT"
env_sid_case() {
  local label="$1" value="$2"
  clear_nudge_records
  ENV_SID="$value"
  local out
  out=$(run_hook_keep '{}')
  check "the env session-id fallback arms once [$label]" "ctx" "$(channel_of "$out")"
  out=$(run_hook_keep '{}')
  check "...and the cadence still BOUNDS it [$label]" "sys" "$(channel_of "$out")"
  ENV_SID=""
}
env_sid_case "plain" "env-sess-plain"
env_sid_case "leading tab" "$(printf '\tenv-sess-lead')"
env_sid_case "embedded tab" "$(printf 'env\tsess-mid')"
env_sid_case "embedded newline" "$(printf 'env\nsess-nl')"

# --- The two channels must not carry the SAME text. `additionalContext` is read
# by the model, `systemMessage` by a human, and the warning is an INSTRUCTION
# ("Run /check to allow commit"). Shipping one string sends that instruction to
# the party who cannot act on it -- go-to-k/cdkd#2389's defect, reproduced
# inside its own fix and on THREE downgrade paths (a repeat subject, a resumed
# pass, an unpersistable record) where the original had one.
clear_nudge_records
out=$(run_hook_keep "$S1")
ctx_text=$(text_of "$out")
out=$(run_hook_keep "$S1")
sys_text=$(text_of "$out")
check "the model and user channels carry DIFFERENT text" "differ" \
  "$([ "$ctx_text" = "$sys_text" ] && echo same || echo differ)"
check "...the MODEL text carries the instruction" "yes" \
  "$(printf '%s' "$ctx_text" | grep -qF 'Run /check' && echo yes || echo no)"
check "...and the USER text does NOT address the reader as the agent" "no" \
  "$(printf '%s' "$sys_text" | grep -qF 'Run /check' && echo yes || echo no)"
check "...while still telling the user what is true" "yes" \
  "$(printf '%s' "$sys_text" | grep -qF 'Uncommitted changes' && echo yes || echo no)"

printf '\nPass: %d  Fail: %d\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then
  printf '%b' "$fail_log" >&2
  exit 1
fi
