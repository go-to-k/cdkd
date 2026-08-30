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

# `stdin` defaults to `{}` rather than being left unfed: unfed, the hook's `cat`
# inherits this script's stdin and a case can HANG instead of failing -- and a
# Stop hook that hangs never lets a turn end.
run_hook() {
  local stdin="${1-}"
  [ "$#" -ge 1 ] || stdin='{}'
  printf '%s' "$stdin" | (cd "$REPO" && bash "$RUN")
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
out=$(run_hook "$S1")
check "the same subject does NOT force a second turn" "sys" "$(channel_of "$out")"
check "...but the user is still shown the warning" "yes" \
  "$(printf '%s' "$(text_of "$out")" | grep -qF 'Uncommitted changes' && echo yes || echo no)"

# --- Editing more of the same dirty tree is NOT a new subject. The subject is
# deliberately not the CONTENT of the dirty set: ordinary work changes that on
# every turn, and keying on it would leave the cadence exactly as unbounded as
# it was before the rule existed. ---
printf 'more\n' >>"$REPO/file.txt"
printf 'second\n' >"$REPO/other.txt"
out=$(run_hook "$S1")
check "editing more files is not a new subject" "sys" "$(channel_of "$out")"

# --- blocked -> commitable RE-ARMS. `/check` just passed, so `git commit` is an
# action that was not available a turn ago. This is the one transition worth a
# forced turn. ---
printf 'fresh\n' >"$VERDICT"
out=$(run_hook "$S1")
check "the marker turning fresh re-arms the nudge" "ctx" "$(channel_of "$out")"
check "...and the text switches to commit-allowed" "yes" \
  "$(printf '%s' "$(text_of "$out")" | grep -qF 'commit allowed' && echo yes || echo no)"
out=$(run_hook "$S1")
check "...and then stops nagging again" "sys" "$(channel_of "$out")"

# --- commitable -> blocked does NOT re-arm, and this is the case the rule was
# written for. Editing any file in the check gate's scope invalidates the
# marker, so this transition is what ORDINARY WORK looks like; a symmetric key
# would re-arm on it and hand back the every-turn cadence. A hook that keyed on
# "the subject changed" rather than on the DIRECTION of the change passes every
# other case in this file and fails only this one. ---
printf 'stale\n' >"$VERDICT"
out=$(run_hook "$S1")
check "the marker going stale again does NOT re-arm" "sys" "$(channel_of "$out")"

# --- A different session gets its own single nudge: the record is keyed by
# session id, so a fresh session is never silenced by its predecessor. ---
out=$(run_hook "$S2")
check "a different session gets its own one nudge" "ctx" "$(channel_of "$out")"

# --- Committing ends the spell, and the record must go with it. Without the
# delete, a session that commits and then starts new work would stay on the
# user channel for the rest of its life -- silent about exactly the state this
# hook exists to catch. ---
git -C "$REPO" add -A
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q -m work
out=$(run_hook "$S1")
check "a clean tree is silent again" "" "$out"
check "...and the nudge record is gone" "absent" \
  "$([ -e "$(record_path)" ] && echo present || echo absent)"
printf 'third\n' >"$REPO/third.txt"
out=$(run_hook "$S1")
check "so the NEXT dirty spell starts armed" "ctx" "$(channel_of "$out")"

# --- `stop_hook_active`: the harness already resumed this turn on a hook's
# account. Repeating anything here spins the turn, so the hook stands down
# entirely rather than swapping channels and printing the same lines twice. ---
out=$(run_hook '{"session_id": "sess-nine", "stop_hook_active": true}')
check "a resumed turn is silent even with a fresh subject" "" "$out"
check "...and still exits 0" "0" "$(rc_of)"
# The string "false" is truthy in Python, so a naive read of the flag would
# silence the hook permanently against a harness that spells it that way.
out=$(run_hook '{"session_id": "sess-ten", "stop_hook_active": "false"}')
check 'the string "false" does not count as a continuation' "ctx" "$(channel_of "$out")"
out=$(run_hook '{"session_id": "sess-ten", "stop_hook_active": "true"}')
check 'the string "true" does count as one' "" "$out"

# --- Malformed and absent payloads. The hook must still WARN (the tree really
# is dirty) and must not crash; an unattributable session falls back to a shared
# key, which costs at most one extra nudge. ---
out=$(run_hook 'not json at all')
check "an unparseable event still produces a warning" "yes" \
  "$([ "$(channel_of "$out")" = "none" ] && echo no || echo yes)"
check "...and still exits 0" "0" "$(rc_of)"
out=$(run_hook '')
check "empty stdin still produces a warning" "yes" \
  "$([ "$(channel_of "$out")" = "none" ] && echo no || echo yes)"

# --- Output must be VALID JSON on every path. The pre-#2396 hook built its
# payload with a hand-rolled `printf` that sliced a python-escaped string, so a
# missing python3 printed a truncated object rather than nothing. ---
out=$(run_hook '{"session_id": "sess-json"}')
check "the payload parses as JSON" "yes" \
  "$([ "$(channel_of "$out")" = "unparseable" ] && echo no || echo yes)"

# --- No python3: say NOTHING rather than emit a fragment. `command -v` is the
# hook's own guard, so an empty PATH is the honest way to exercise it. ---
# `$BASH` rather than `bash`: with PATH emptied, `bash` itself is not findable,
# the subshell dies before the hook starts, and the case passes on an empty
# output that proves nothing. Measured -- it did exactly that on the first run,
# printing `bash: command not found` while reporting OK.
out=$(printf '%s' '{}' | (cd "$REPO" && PATH="/nonexistent" "$BASH" "$RUN") 2>/dev/null)
check "no python3 means silence, not a broken payload" "" "$out"

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
out=$(run_hook '{"session_id": "sess-quoted", "prompt": "git commit -m \"gh pr merge 5\""}')
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

printf '\nPass: %d  Fail: %d\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then
  printf '%b' "$fail_log" >&2
  exit 1
fi
