#!/usr/bin/env bash
# stop-warn.sh
#
# Stop hook. Fires when the working tree has UNCOMMITTED changes, and says
# whether a commit is currently allowed (the markgate `check` marker is fresh)
# or blocked (stale or missing). `stop-unmerged-lane-warn.sh` next to it covers
# the other half: work that IS committed but never reached `origin/main`.
#
# CHANNEL. Every word of this warning is addressed to the AGENT ("run /check to
# allow commit"), and until go-to-k/cdkd#2396 all of it left as `systemMessage`,
# which reaches the USER ONLY -- the same defect go-to-k/cdkd#2389 reported for
# the lane hook next door, and the reason a `stop-warn says: WARNING ...` line
# kept appearing in the terminal after go-to-k/cdkd#2392 fixed that one. The
# channels are not interchangeable; on the Stop event the choice is behavioural
# rather than cosmetic:
#
#   hookSpecificOutput.additionalContext -> the MODEL, and the turn CONTINUES
#   systemMessage                        -> the USER only, and the turn ends
#   stdout / stderr at exit 0            -> nobody
#
# CADENCE. There is no fourth option that reaches the model WITHOUT continuing
# the turn, and this hook's condition -- a dirty tree -- is true for most of an
# active session. Switching it to `additionalContext` unconditionally would buy
# one forced model turn at every single turn-end; go-to-k/cdkd#2391 reports
# exactly that cost for the rarer lane condition. `stop_hook_active` only stops
# the spin WITHIN one turn, so it is necessary and not sufficient.
#
# So the model is nudged at most once per distinct SUBJECT, and the subject is
# deliberately NOT the content of the dirty set: ordinary editing changes that
# on every turn, which would leave the cadence as unbounded as it started. The
# subject is whether a commit is POSSIBLE, and it re-arms only in the direction
# that opens an action the model did not have before:
#
#   no record for this session   -> nudge  (the first turn-end of a dirty spell)
#   blocked -> commitable        -> nudge  (/check just passed; commit is now
#                                           the action, and it was not before)
#   commitable -> blocked        -> quiet  (an edit invalidated the marker; the
#                                           model is mid-work and has already
#                                           been told once)
#   unchanged                    -> quiet
#
# A symmetric key would get that third row wrong, and wrongly: editing anything
# under the gate's scope invalidates the marker, so `commitable -> blocked` is
# what ordinary work looks like, and re-arming on it would restore the very
# every-turn cadence this rule exists to bound.
#
# The record is DELETED the moment the tree goes clean, so the next dirty spell
# starts armed again. A repeat still leaves as `systemMessage`: the user is
# never cut out of the loop, only the forced turn is.
set -u

input=$(cat 2>/dev/null || true)

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$REPO" 2>/dev/null || exit 0

# Everything below builds its payload with `python3`. Without it this script
# would end on a `command not found`, on every turn, for a hook whose entire
# job is advisory -- and the pre-#2396 version would have printed a truncated,
# unparseable JSON object instead of the warning. Say nothing instead.
command -v python3 >/dev/null 2>&1 || exit 0

# The per-worktree git dir, which is where the cadence record lives: linked
# worktrees resolve to `.git/worktrees/<name>`, so lanes never share a record
# and removing a worktree takes its record with it. Same resolution markgate
# uses for its marker store.
#
# Resolved AFTER the dirty check, not before. `--absolute-git-dir` is not
# ancient, and an `|| exit 0` above the check would let a git that lacks it
# silence the warning entirely -- trading the whole guardrail for the cadence,
# which is the wrong way round. Unresolvable here costs only the MODEL channel
# (see the arm predicate below).
status=$(git status --porcelain 2>/dev/null || echo "")

git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null || true)
state_file=""
[ -n "$git_dir" ] && state_file="${git_dir}/stop-nudge-warn"

if [ -z "$status" ]; then
  # Clean tree: nothing to say, and the spell is over. Dropping the record here
  # is what makes the NEXT dirty spell start armed -- without it, a session that
  # commits and then starts new work would be silent for the rest of its life.
  [ -n "$state_file" ] && rm -f "$state_file" 2>/dev/null
  exit 0
fi

# Prefer direct `markgate` to avoid `mise exec` startup overhead on every
# Stop hook; fall back to `mise exec --` for users who installed via
# `mise install` without shims on PATH.
if command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
elif command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
else
  markgate=()
fi

# TWO texts, not one, and the split is the same defect this hook was written
# for (go-to-k/cdkd#2389 / go-to-k/cdkd#2396) arriving one level down. The
# warning is an INSTRUCTION -- "Run /check to allow commit" -- and on the
# downgrade paths (a repeat subject, a resumed pass, an unpersistable record) it
# was going out verbatim on `systemMessage`, i.e. to the human, who is being
# addressed as the agent and has nothing to do about it. There are three such
# paths now where there was one, so shipping one string would have WIDENED the
# original defect rather than fixed it. The model text keeps the imperative; the
# user text states what is TRUE for a human.
#
# ...and the CLOSING CLAUSE is per PATH, because "the agent has already been
# told" is true on exactly ONE of the three. On the RESUMED path this pass may
# be the first time the condition holds at all (the tree can go dirty inside the
# continuation -- that is why the arm stops short of silence rather than exiting).
# On the UNPERSISTABLE-RECORD path `arm` is forced 0 on EVERY turn, so the agent
# is never told and the user was being assured otherwise forever. One string
# across all three re-committed, in the user's own voice, the error the channel
# split exists to fix.
if [ ${#markgate[@]} -gt 0 ] && "${markgate[@]}" verify check >/dev/null 2>&1; then
  model_msg="WARNING: Uncommitted changes (/check passed, commit allowed)"
  user_base="NOTE: Uncommitted changes here, and /check has passed, so a commit is allowed."
  subject="commitable"
else
  model_msg="WARNING: Uncommitted changes. Run /check to allow commit (marker invalid)"
  user_base="NOTE: Uncommitted changes here, and /check has not passed, so a commit is blocked until it does."
  subject="blocked"
fi
# The default is the REPEAT-SUBJECT path, the only one on which it is true.
user_tail="The agent has already been told; this is for your visibility."

# Two fields are read out of the Stop payload: `stop_hook_active` (has the
# harness already continued this turn on a hook's account?) and `session_id`
# (whose record is this?). A STRING "false" is truthy in Python, so the textual
# spellings are folded down rather than trusted.
parsed=$(HOOK_INPUT="$input" ENV_SID="${CLAUDE_CODE_SESSION_ID:-}" python3 -c '
import json, os

try:
    data = json.loads(os.environ.get("HOOK_INPUT") or "{}")
except ValueError:
    data = {}
if not isinstance(data, dict):
    data = {}

flag = data.get("stop_hook_active")
if isinstance(flag, str):
    flag = flag.strip().lower() not in ("", "false", "0", "no")
print("1" if flag else "0")

# BOTH sources are read here and normalised ONCE, which is the whole point of
# doing it in this block rather than in shell. The fallback used to sit AFTER
# this, raw: a TAB or a NEWLINE in `CLAUDE_CODE_SESSION_ID` then reached the
# record, added a field, shifted the read-back, and `prev_sid` never matched
# again -- unbounded `additionalContext` on every turn, against the harness
# block cap, from the one input path no suite covered. `str()` because a JSON
# `session_id` need not be a string.
sid = data.get("session_id") or os.environ.get("ENV_SID") or "shared"
sid = str(sid)
for ch in ("\t", "\n", "\r"):
    sid = sid.replace(ch, " ")
print(sid or "shared")
')
active=$(printf '%s\n' "$parsed" | sed -n 1p)
sid=$(printf '%s\n' "$parsed" | sed -n 2p)
# Defence in depth only: the block above cannot print an empty second line.
[ -n "$sid" ] || sid="shared"

prev_sid=""
prev_subject=""
if [ -n "$state_file" ] && [ -r "$state_file" ]; then
  # Split by parameter expansion rather than `IFS=<TAB> read -r a b _`. A TAB is
  # IFS WHITESPACE, so `read` folds a run of them into ONE separator: a record
  # whose subject field is empty (`<sid><TAB><TAB><epoch>`) handed `prev_subject`
  # the EPOCH, which is non-empty, is not `blocked`, and therefore took the quiet
  # arm -- a malformed record SILENCING the nudge, the one direction this must
  # not fail in. Measured; the field-count and empty-file spellings already armed
  # for a different reason, which is why the fold survived unnoticed.
  # `|| true` on the read: a record with no trailing newline is a partial line
  # and returns non-zero while still assigning what it read.
  prev_line=""
  IFS= read -r prev_line <"$state_file" 2>/dev/null || true
  REC_TAB=$(printf '\t')
  case "$prev_line" in
    *"$REC_TAB"*)
      prev_sid="${prev_line%%"$REC_TAB"*}"
      prev_rest="${prev_line#*"$REC_TAB"}"
      prev_subject="${prev_rest%%"$REC_TAB"*}"
      ;;
    *) prev_sid="$prev_line" ;;
  esac
fi

# `subject` has a CLOSED value set, so anything else in the record is not a
# subject this hook wrote -- treat it as absent, which arms. The predicate below
# only ever tested the EMPTY spelling, so a record with NON-EMPTY garbage in
# field 2 fell through to the quiet arm and SILENCED the nudge. Measured:
# `<sid><TAB><TAB>111` -> ctx (the empty spelling, already handled) while
# `<sid><TAB>GARBAGE<TAB>111` -> sys, on a first sighting the table promises
# `ctx` for. A malformed record must never buy silence; that is the one
# direction this hook must not fail in.
case "$prev_subject" in
  blocked | commitable) ;;
  *) prev_subject="" ;;
esac

# The arm predicate, spelled as the rows of the table above. `commitable ->
# blocked` is deliberately absent.
if [ "$prev_sid" != "$sid" ] || [ -z "$prev_subject" ]; then
  arm=1
elif [ "$prev_subject" = "blocked" ] && [ "$subject" = "commitable" ]; then
  arm=1
else
  arm=0
fi

# The record tracks the last OBSERVED subject, and is therefore written on BOTH
# arms -- only the CHANNEL branches below. Writing it only when arming was a
# real bug: `prev_subject` then held the last NUDGED subject, so after one
# `blocked -> commitable` the record stayed `commitable` while the tree went
# back to `blocked`, and the next `/check` pass -- a moment when committing
# genuinely became possible again -- was silent. Measured on one dirty spell:
# `fresh -> ctx, stale -> sys, fresh -> sys`, where the table promises `ctx`.
# ...but NOT on a pass the harness has already resumed. That pass reaches the
# user only, so nothing the model could act on happened, and recording the
# subject as OBSERVED turns "suppress this pass" into "suppress this subject
# for good": the condition can become true DURING the continuation, which is
# the whole reason the arm below stops short of silence, and the very next
# ordinary turn then reads its own first sighting as a repeat and downgrades.
# Measured before the guard: `{active, blocked} -> sys` then `{blocked} -> sys`,
# where the cadence promises `ctx` for the first turn a subject is nudgeable.
persisted=0
if [ -n "$state_file" ] && [ "$active" != "1" ]; then
  # One file rewritten in place, not one file per session: a per-session file
  # would accumulate in the git dir with nobody to clean it up. A concurrent
  # session in the same worktree can therefore clobber this record, which costs
  # an EXTRA nudge rather than a missed one -- the safe direction. Written via
  # tmp + `mv` so a Stop that races another never leaves a half-line behind.
  # `2>/dev/null` precedes the write redirect on purpose: applied after it,
  # bash reports the failed redirect on the hook's real stderr.
  tmp="${state_file}.$$"
  if printf '%s\t%s\t%s\n' "$sid" "$subject" "$(date +%s)" 2>/dev/null >"$tmp"; then
    # `mv -f <file> <dir>` returns SUCCESS -- it moves the tmp INSIDE the
    # directory -- so `mv` alone certified a record that was never written.
    # The readback next turn then found nothing, `persisted` was 1 anyway,
    # and every later turn re-armed: the UNBOUNDED model channel this whole
    # cadence exists to remove, arriving through the success check.
    # Measured: `mv -f <file> <dir>` -> rc 0, file inside the directory.
    # So the destination is confirmed to be a regular FILE, and the tmp the
    # non-move left inside it is swept -- otherwise the git dir grows one
    # orphan per turn.
    if mv -f "$tmp" "$state_file" 2>/dev/null && [ -f "$state_file" ]; then
      persisted=1
    else
      rm -f "$tmp" "$state_file/${tmp##*/}" 2>/dev/null || true
    fi
  else
    rm -f "$tmp" 2>/dev/null || true
  fi
fi

# A nudge we cannot RECORD is a nudge we cannot bound: without the record every
# later turn re-arms, which is the unbounded cadence this whole mechanism
# exists to remove. So an unresolvable git dir or an unwritable one costs the
# MODEL channel, not the warning -- the user still gets it, every turn.
if [ "$persisted" != "1" ]; then
  arm=0
  user_tail="The agent has NOT been told: this hook could not record the nudge here (unresolvable or unwritable git dir), so it stays on this channel every turn."
fi

# Already continued once this turn on a hook's account. Arming again would spin
# the turn instead of ending it -- but going fully SILENT here was wrong: the
# tree can become dirty DURING the continuation, in which case this pass is the
# first time the condition holds at all and the user would never be told. A
# bare `systemMessage` does not continue a turn, so it costs nothing.
# LAST, so it wins the wording: a resumed pass never writes the record either,
# so `persisted` is 0 on every one of them and the clause above would otherwise
# mislabel every continuation as an unwritable git dir.
if [ "$active" = "1" ]; then
  arm=0
  user_tail="The turn has already been continued once, so the agent is not being interrupted again on this pass."
fi

if [ "$arm" = "1" ]; then
  channel="ctx"
  msg="$model_msg"
else
  channel="sys"
  msg="$user_base $user_tail"
fi

MSG="$msg
$(printf '%s' "$status" | head -10)" CHANNEL="$channel" python3 -c '
import json, os

msg = os.environ["MSG"]
if os.environ["CHANNEL"] == "ctx":
    payload = {"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": msg}}
else:
    payload = {"systemMessage": msg}
print(json.dumps(payload))
'
