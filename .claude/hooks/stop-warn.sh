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
git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 0
state_file="${git_dir}/stop-nudge-warn"

status=$(git status --porcelain 2>/dev/null || echo "")
if [ -z "$status" ]; then
  # Clean tree: nothing to say, and the spell is over. Dropping the record here
  # is what makes the NEXT dirty spell start armed -- without it, a session that
  # commits and then starts new work would be silent for the rest of its life.
  rm -f "$state_file" 2>/dev/null || true
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

if [ ${#markgate[@]} -gt 0 ] && "${markgate[@]}" verify check >/dev/null 2>&1; then
  msg="WARNING: Uncommitted changes (/check passed, commit allowed)"
  subject="commitable"
else
  msg="WARNING: Uncommitted changes. Run /check to allow commit (marker invalid)"
  subject="blocked"
fi

# Two fields are read out of the Stop payload: `stop_hook_active` (has the
# harness already continued this turn on a hook's account?) and `session_id`
# (whose record is this?). A STRING "false" is truthy in Python, so the textual
# spellings are folded down rather than trusted.
parsed=$(HOOK_INPUT="$input" python3 -c '
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
print((data.get("session_id") or "").replace("\t", " ").replace("\n", " "))
')
active=$(printf '%s\n' "$parsed" | sed -n 1p)
sid=$(printf '%s\n' "$parsed" | sed -n 2p)
[ -n "$sid" ] || sid="${CLAUDE_CODE_SESSION_ID:-shared}"

# Already nudged once this turn and the model came back to Stop. Saying it
# again would spin the turn instead of ending it, so stand down entirely --
# repeating it on the user channel here would just double the same line.
[ "$active" = "1" ] && exit 0

prev_sid=""
prev_subject=""
if [ -r "$state_file" ]; then
  IFS="$(printf '\t')" read -r prev_sid prev_subject _ <"$state_file" 2>/dev/null || true
fi

# The arm predicate, spelled as the three rows of the table above. Note that
# `commitable -> blocked` is deliberately absent.
if [ "$prev_sid" != "$sid" ] || [ -z "$prev_subject" ]; then
  arm=1
elif [ "$prev_subject" = "blocked" ] && [ "$subject" = "commitable" ]; then
  arm=1
else
  arm=0
fi

if [ "$arm" = "1" ]; then
  # One file rewritten in place, not one file per session: a per-session file
  # would accumulate in the git dir with nobody to clean it up. A concurrent
  # session in the same worktree can therefore clobber this record, which costs
  # an EXTRA nudge rather than a missed one -- the safe direction. Written via
  # tmp + `mv` so a Stop that races another never leaves a half-line behind.
  tmp="${state_file}.$$"
  if printf '%s\t%s\t%s\n' "$sid" "$subject" "$(date +%s)" >"$tmp" 2>/dev/null; then
    mv -f "$tmp" "$state_file" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
  else
    rm -f "$tmp" 2>/dev/null || true
  fi
  channel="ctx"
else
  channel="sys"
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
