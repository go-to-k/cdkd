#!/usr/bin/env bash
# stop-unmerged-lane-warn.sh
#
# Stop hook. `stop-warn.sh` next to it catches UNCOMMITTED work in the main
# tree. This catches the other, quieter half: a feature worktree whose branch
# is COMMITTED but still ahead of `origin/main` -- a lane that is finished as
# far as the editor is concerned and unfinished as far as the repo is.
#
# Why this is a hook rather than another sentence. CLAUDE.md already says a
# NOT-CLOSEABLE verdict is a to-do list and not a stopping point, and already
# says that if you cannot name a signal that will re-invoke you then you are
# STOPPED rather than WAITING. Both were violated repeatedly in one session on
# 2026-08-26: turns ended with `Mode: WAITING` next to `Waiting on: none`, and
# with `Verdict: NOT CLOSEABLE` in the same report as the stop. A rule that is
# already in the text and gets violated anyway is not made load-bearing by a
# third spelling of it (`/work-issues` section 10-b says to escalate rather
# than restate), so this computes the verdict from the REPO instead of from the
# agent's own self-report -- which is the part that was wrong.
#
# Deliberately does NOT call `gh`: a Stop hook runs on every turn, and a network
# round-trip per turn is a cost this warning does not justify. Branch state
# alone separates "there is unmerged work here" from "there is not".
set -u

# The Stop event's JSON arrives on stdin, and is consumed here rather than
# lazily: the payload has to be drained whether or not this hook goes on to use
# it. Three fields are PARSED out of it further down, once a lane has actually
# been found -- `stop_hook_active` (has the harness already continued this
# turn?), `cwd` (which worktree is the session in?) and `session_id` (whose
# nudge record is this?). Same `cat` form every
# other hook here uses -- Claude Code writes the payload and closes the pipe,
# so this does not block.
input=$(cat 2>/dev/null || true)

# BASH_SOURCE resolves to whichever checkout this copy of the hook lives in --
# in a linked worktree that is the LANE, not the main tree. That is fine as a
# place to run `git` from (every worktree shares one object store and one
# `origin/main`), but it must NOT be used to decide which worktree to skip: the
# session ending inside its own lane is the case this hook exists for, and an
# earlier revision skipped exactly that one. Measured from a lane 5 commits
# ahead: the hook printed nothing. The main tree is excluded by BRANCH below
# (`main`/`master`), which is the property that actually identifies it.
#
# BASH_SOURCE is not banned here, only that USE of it. The same value is the
# fallback for `session_root` further down, where it answers the opposite
# question -- which worktree IS the session's -- and being the lane is exactly
# what makes it the right answer there.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO" 2>/dev/null || exit 0

# Cheap: no fetch. A stale `origin/main` can only OVER-report: `rev-list --count
# origin/main..$br` only grows as `origin/main` ages, so a branch whose work has
# already merged keeps reading as ahead. That is the safe direction -- the
# failure that matters is MISSING a real lane, and staleness cannot cause it.
# (An earlier revision of this comment said UNDER-report while its own
# parenthetical described over-reporting; the parenthetical was the true half.)
git rev-parse --verify origin/main >/dev/null 2>&1 || exit 0

# `lane_paths` carries the same rows as `lanes` in a machine-readable form --
# BRANCH, TAB, worktree path -- so the session's OWN lane can be picked out of
# them below. The branch comes FIRST because it is the field that is safe to
# bound a split by: git refnames may not contain a tab, a space or a backslash,
# while a worktree PATH may contain all three. Splitting at the first tab
# therefore yields the whole path, however it is spelled. These are taken verbatim: measured on macOS 2026-08-30, git
# canonicalises what it hands back, so `git worktree list` reports
# `/private/var/...` even for a worktree ADDED as `/var/...` or through a
# symlink, and `rev-parse --show-toplevel` does the same. The uncanonical
# spelling in this hook comes from somewhere else entirely -- the `cd ... && pwd`
# that builds `REPO` from BASH_SOURCE -- which is why `session_root` below is
# canonicalised and these rows are not.
lanes=""
lane_paths=""
# EVERY worktree, not only the lanes: the no-lane exit below has to be able
# to clear a cadence record wherever one was left.
all_worktrees=""
while IFS= read -r wt; do
  [ -n "$wt" ] || continue
  all_worktrees="${all_worktrees}${wt}
"
  br=$(git -C "$wt" branch --show-current 2>/dev/null) || continue
  [ -n "$br" ] || continue
  case "$br" in main | master) continue ;; esac
  ahead=$(git -C "$wt" rev-list --count "origin/main..$br" 2>/dev/null) || continue
  [ "${ahead:-0}" -gt 0 ] || continue
  lanes="${lanes}  ${br}  (${ahead} commit(s) ahead, worktree ${wt##*/})
"
  lane_paths="${lane_paths}${br}	${wt}
"
done < <(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0, 10)}')

if [ -z "$lanes" ]; then
  # The condition has CLEARED: no worktree in this repo is ahead of
  # `origin/main`. Drop every cadence record, so the NEXT lane starts ARMED.
  #
  # Without this the record outlived the condition, and the miss is reachable
  # by the very remedy this hook prints. Measured: nudge (ctx), repeat (sys),
  # `git switch --detach origin/main` so nothing is a lane, re-attach and
  # commit again in the SAME session -> `sys`, never `ctx`. The subject is
  # `<branch>:<push state>`, so returning to the same branch in the same push
  # state reproduces the stored subject exactly and the nudge is SWALLOWED --
  # a MISSED nudge, which this file and `.claude/rules/hooks-stop.md` both call the
  # unsafe direction. `stop-warn.sh` in the sibling repo has always dropped its
  # record on the clean-tree exit for exactly this reason.
  #
  # EVERY worktree's record is dropped, including other sessions'. "No lane is
  # ahead" is a REPO-GLOBAL fact, so no session has anything left to be quiet
  # about; and the cost of being wrong is one EXTRA nudge, which is the trade
  # the record's own concurrent-clobber comment already accepts.
  #
  # The git dir is derived without forking -- a main worktree has `.git` as a
  # DIRECTORY, a linked one has it as a FILE holding `gitdir: <path>`. This
  # runs on the silent path, which is most turns, so a `git rev-parse` per
  # worktree here would be a per-turn cost paid by every clean session.
  while IFS= read -r wt; do
    [ -n "$wt" ] || continue
    wt_git_dir=""
    if [ -d "$wt/.git" ]; then
      wt_git_dir="$wt/.git"
    elif [ -f "$wt/.git" ]; then
      IFS=' ' read -r _ wt_git_dir <"$wt/.git" 2>/dev/null || wt_git_dir=""
    fi
    # git writes an ABSOLUTE `gitdir:`; a relative one would resolve against
    # this hook's own cwd and the `rm -f` would simply find nothing, which is
    # the safe direction (an extra nudge, never a missed one).
    [ -n "$wt_git_dir" ] || continue
    rm -f "$wt_git_dir/stop-nudge-lane" 2>/dev/null || true
  done <<CLEAR_RECORDS_EOF
$all_worktrees
CLEAR_RECORDS_EOF
  exit 0
fi

# Everything past here builds a payload with `python3`. Without it the script
# would end on a `command not found` and exit 127 -- on every turn, for a hook
# whose entire job is advisory. Say nothing instead.
command -v python3 >/dev/null 2>&1 || exit 0

# Everything below decides WHICH CHANNEL the warning leaves by, and the two are
# not interchangeable -- on the Stop event they differ in whether the turn ends.
#
#   hookSpecificOutput.additionalContext -- delivered to the MODEL, and the turn
#     CONTINUES so it can act. The installed Claude Code (2.1.251) states both
#     halves as one sentence: "additionalContext is non-error feedback delivered
#     to the model; the conversation continues so the model can act on it".
#   systemMessage -- shown to the USER only ("Display a message to the user (all
#     hooks)"), and the turn ends normally.
#
# There is no third option that reaches the model without continuing the turn,
# which is the whole reason this hook has to choose. It used to emit
# `systemMessage` unconditionally, so every word of a message written AT THE
# AGENT ("you are not done", "the honest label is STOPPED") reached only the
# party that cannot act on it (go-to-k/cdkd#2389).
#
# The split is by OWNERSHIP, because that is what decides whether a continuation
# buys anything:
#
#   this session's own worktree is a lane -> additionalContext. This is the
#     failure the hook exists for -- ending the turn with your own branch
#     committed and no PR -- and a nudge the model may simply stop over is
#     exactly what did not work.
#   only OTHER worktrees are lanes -> systemMessage. The model cannot act on
#     someone else's lane, so continuing the turn would buy a second reply that
#     can only say "not mine". Measured while fixing this: four forced
#     continuations in one session over ONE lane belonging to another session,
#     each producing a reply whose entire content was that it was not this
#     session's to touch. And because this repo SQUASH-merges, a merged branch
#     reads as ahead forever, so one un-removed worktree would have made that
#     permanent.
parsed=$(HOOK_INPUT="$input" ENV_SID="${CLAUDE_CODE_SESSION_ID:-}" python3 -c '
import json, os

try:
    data = json.loads(os.environ.get("HOOK_INPUT") or "{}")
except ValueError:
    data = {}
if not isinstance(data, dict):
    data = {}

# The harness sends a JSON boolean. A STRING "false" is truthy in Python, and
# reading it as "already continued" would silence the hook permanently, so the
# textual spellings are folded down here rather than trusted.
flag = data.get("stop_hook_active")
if isinstance(flag, str):
    flag = flag.strip().lower() not in ("", "false", "0", "no")
print("1" if flag else "0")
print(data.get("cwd") or "")

# BOTH sources are read here and normalised ONCE. The env fallback used to sit
# AFTER this block, raw, so a TAB or a NEWLINE in `CLAUDE_CODE_SESSION_ID`
# reached the record, added a field, shifted the read-back, and `prev_sid` never
# matched again -- unbounded `additionalContext` on every turn, against the
# harness block cap, from the one input path no suite covered.
sid = data.get("session_id") or os.environ.get("ENV_SID") or "shared"
sid = str(sid)
for ch in ("\t", "\n", "\r"):
    sid = sid.replace(ch, " ")
print(sid or "shared")
')
active=$(printf '%s\n' "$parsed" | sed -n 1p)
hook_cwd=$(printf '%s\n' "$parsed" | sed -n 2p)
sid=$(printf '%s\n' "$parsed" | sed -n 3p)
# Defence in depth only: the block above cannot print an empty third line.
[ -n "$sid" ] || sid="shared"

# Already continued once this turn on a hook's account. Arming again would spin
# the turn instead of ending it -- but going fully SILENT here was wrong: a lane
# can be COMMITTED during the continuation, in which case this pass is the first
# time the condition holds at all and the user would never be told. A bare
# `systemMessage` does not continue a turn, so it costs nothing. `resumed` is
# consumed where the channel is decided, below.
resumed=0
[ "$active" = "1" ] && resumed=1

# Where is the SESSION? `cwd` from the event payload, resolved to its worktree
# root. Falling back to this hook copy's own checkout is correct rather than
# merely convenient: in a linked worktree BASH_SOURCE IS the lane. Note the
# POLARITY -- an earlier revision used that same path to SKIP a worktree and so
# went blind to the one case that matters (go-to-k/cdkd#2279); here it IDENTIFIES
# the lane instead.
session_root=""
[ -n "$hook_cwd" ] && session_root=$(git -C "$hook_cwd" rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$session_root" ] || session_root="$REPO"
# `pwd -P` is the load-bearing half. The `git` answers above are already
# canonical, but the BASH_SOURCE fallback is not: `REPO` is built with `cd ...
# && pwd`, which keeps the spelling it was reached by, so a session launched
# through a symlinked worktree path compares a symlink against git's real path
# and never matches -- silently taking the not-mine branch for its OWN lane.
session_root=$(cd "$session_root" 2>/dev/null && pwd -P) || session_root=$(pwd -P)

# Plain shell rather than awk. Every awk spelling of this comparison mangles
# some path: `-v root=...` expands backslash escapes in the value, and `-F'\t'`
# splits a path containing a tab into the wrong field. Both are the same class
# as the space truncation fixed above, and parameter expansion has neither.
TAB=$(printf '\t')
self_branch=""
while IFS= read -r row; do
  [ -n "$row" ] || continue
  row_branch=${row%%"$TAB"*}
  row_path=${row#*"$TAB"}
  if [ "$row_path" = "$session_root" ]; then
    self_branch="$row_branch"
    break
  fi
done <<LANE_ROWS
$lane_paths
LANE_ROWS

# Declared here, outside the branch: the not-mine arm never composes a user
# text with a tail, and `set -u` aborts on the substitution below otherwise.
user_tail=""
if [ -n "$self_branch" ]; then
  # Whether the branch has been PUSHED is NOT used to decide the channel -- the
  # discriminator go-to-k/cdkd#2391 proposed. It would have gone quiet on a
  # branch that is pushed with NO PR, which is a real failure and one of the two
  # this hook exists to catch. It earns its keep in the TEXT instead, where it
  # names which half of the remaining work is left. No upstream at all reads as
  # unpushed, which is what it is.
  # Split into a FACT and a TODO. The fact is true for anyone reading; the todo
  # is an instruction only the agent can act on, and the two go down different
  # channels below.
  unpushed=$(git -C "$session_root" rev-list --count '@{u}..' 2>/dev/null || echo "")
  if [ -z "$unpushed" ]; then
    push_state="unpushed"
    push_fact="It has no upstream yet, so nothing has been submitted."
    push_todo="Push it, open the PR, then merge."
  elif [ "$unpushed" -gt 0 ]; then
    push_state="unpushed"
    push_fact="It has ${unpushed} commit(s) not yet pushed, so nothing carrying them has been submitted."
    push_todo="Push, open or update the PR, then merge."
  else
    push_state="pushed"
    push_fact="It is fully pushed, so a PR may already be in flight."
    push_todo="A pushed branch with NO PR is exactly the failure this catches. Check, and open one if there is none."
  fi
  push_line="$push_fact $push_todo"
  model_msg="WARNING: YOUR OWN lane is unmerged -- a NOT-CLOSEABLE verdict is a TO-DO LIST, not a stopping point.
This session's worktree is on '$self_branch', which is committed but not on origin/main, so you are not
done: rebase, run the gates, open the PR, merge. $push_line
If you are ending the turn with nothing that will re-invoke you, the honest label is STOPPED, not WAITING.
One false positive is expected and is cheap to clear: this repo SQUASH-merges, so a merged branch never
becomes an ancestor of origin/main and keeps reading as ahead. If '$self_branch' is already merged, the
remaining work is to remove its worktree and delete the branch -- not to open another PR. When this tree
is one you must NOT remove (an outer tool owns it, or you were launched inside it), clear the lane by
LEAVING the branch: switch back to the one the tree was handed to you on, as-is, then delete the lane
branch. Detaching ('git switch --detach origin/main') also clears it -- a worktree with no current
branch is not a lane -- but it leaves the outer tool showing a detached workspace it created on a
branch, so it is the fallback for a tree that was launched detached, not the default.
Every unmerged lane in this checkout:"
  # The USER text for the same condition. Every word of `model_msg` above is an
  # instruction to the agent, and until 2026-08-31 that exact wall of text was
  # what the DOWNGRADE paths sent to the human -- go-to-k/cdkd#2389's defect
  # reproduced inside its own fix, and now on three paths (a repeat subject, a
  # resumed pass, an unpersistable record) rather than one.
  # The CLOSING CLAUSE is per DOWNGRADE PATH. "The agent has already been told"
  # is true on exactly ONE of the three: on the RESUMED path this pass may be
  # the first time the condition holds at all, and on the UNPERSISTABLE-RECORD
  # path `arm` is forced 0 on EVERY turn, so the agent is never told and the
  # user was being assured otherwise forever. One string across all three
  # re-committed, in the user's own voice, the very defect the channel split
  # exists to fix. The default below is the repeat-subject path; the two
  # overrides sit at the lines that force `arm=0`.
  user_tail="The agent has already been told about this lane in this session, so this is a status line for you rather than a task."
  user_msg="NOTE: this session's worktree is on '$self_branch', which is committed but not on origin/main.
$push_fact
__USER_TAIL__ If '$self_branch' is in fact already merged,
what is left is to remove its worktree and delete the branch -- this repo SQUASH-merges, so a merged branch
keeps reading as ahead forever.
Every unmerged lane in this checkout:"
  channel="ctx"
else
  model_msg="NOTE: unmerged lane(s) exist in this checkout, none of them this session's.
This session's worktree is not among them, so there is likely nothing here for it to do; they belong to
other sessions, or are already merged (this repo SQUASH-merges, so a merged branch never becomes an
ancestor of origin/main and keeps reading as ahead -- clearing one means removing its worktree and
deleting the branch, not opening another PR).
Lanes:"
  # This arm is already written for whoever reads it: it says there is nothing
  # here for this session to do. One string is correct, so both channels take
  # it -- and that is NOT the collapse the self-lane arm above forbids, which is
  # about a text written AT the agent reaching a person.
  #
  # `model_msg` is nevertheless the one that is never READ on this arm: the
  # `channel="sys"` below is unconditional, so the emit block always takes
  # `user_msg`. Assigning it anyway is deliberate -- the emit block expands
  # `$model_msg` on its ctx branch, so leaving it unset here would abort under
  # `set -u` the first time this arm ever learned to arm. It is a guard, not
  # leftover code, which is why it is named as one rather than deleted.
  user_msg="$model_msg"
  channel="sys"
fi

# CADENCE. `stop_hook_active` above stops a nudge from SPINNING inside one
# turn, and that is all it does. Across turns the condition persists, so an
# unconditional `additionalContext` costs one forced model turn at every single
# turn-end for as long as the lane exists -- including the two states where
# there is nothing left to do: the PR is open and CI is running (the session is
# legitimately WAITING), and the lane was squash-merged with its worktree left
# behind, which reads as ahead FOREVER. go-to-k/cdkd#2391 measured both.
#
# So the model is nudged at most once per distinct SUBJECT, and a repeat of the
# same subject falls back to `systemMessage`: the user still sees it, the turn
# ends. The subject is the branch plus whether it is pushed, so:
#
#   a lane never nudged in this session -> nudge
#   the same lane, unpushed -> pushed   -> nudge (a PR should exist now, and a
#                                          pushed branch with none is the
#                                          failure this hook is for)
#   the same lane, same push state      -> quiet
#   a DIFFERENT lane                    -> nudge (it is a different subject)
#
# The commit COUNT is deliberately not in the key: it changes every time the
# model commits, which would re-arm the nudge on ordinary work and leave the
# cadence as unbounded as it started.
#
# The record lives in the PER-WORKTREE git dir, so lanes never share one and
# removing a worktree takes its record with it -- the same resolution markgate
# uses for its marker store. One file rewritten in place, not one per session:
# a per-session file would accumulate with nobody to clean it up. A concurrent
# session in the same worktree can therefore clobber it, which costs an EXTRA
# nudge rather than a missed one, the safe direction.
if [ "$channel" = "ctx" ]; then
  git_dir=$(git -C "$session_root" rev-parse --absolute-git-dir 2>/dev/null || true)
  arm=1
  persisted=0
  if [ -n "$git_dir" ]; then
    state_file="${git_dir}/stop-nudge-lane"
    subject="${self_branch}:${push_state}"
    prev_sid=""
    prev_subject=""
    if [ -r "$state_file" ]; then
      # Split by parameter expansion rather than `IFS=<TAB> read -r a b _`, the
      # spelling stop-warn.sh replaced over a MEASURED bug. A TAB is IFS
      # WHITESPACE, so `read` folds a RUN of them into one separator: a record
      # whose subject field is empty (`<sid><TAB><TAB><epoch>`) hands
      # `prev_subject` the NEXT field, and the predicate below then compares a
      # timestamp -- or, when that field happens to look like `<branch>:<state>`,
      # matches it and goes QUIET. A malformed record SILENCING the nudge is the
      # one direction this must not fail in. `stop-warn.sh` fences this three
      # ways and the lane twin had no malformed-record case at all, so only the
      # hook that already had the fix could detect its own regression.
      # `|| true` on the read: a record with no trailing newline is a partial
      # line and returns non-zero while still assigning what it read.
      prev_line=""
      IFS= read -r prev_line <"$state_file" 2>/dev/null || true
      case "$prev_line" in
        *"$TAB"*)
          prev_sid="${prev_line%%"$TAB"*}"
          prev_rest="${prev_line#*"$TAB"}"
          prev_subject="${prev_rest%%"$TAB"*}"
          ;;
        *) prev_sid="$prev_line" ;;
      esac
    fi
    prev_branch=${prev_subject%:*}
    prev_push=${prev_subject##*:}

    # The predicate is DIRECTED, and an undirected equality test was a real bug
    # rather than a simplification. `pushed -> unpushed` is what an ordinary
    # COMMIT looks like, so `prev_subject != subject` re-armed on every commit
    # and again on every push: measured on one lane as
    # `commit ctx, repeat sys, push ctx, repeat sys, commit ctx, push ctx, ...`
    # -- two forced continuations per commit/push cycle, forever, which is the
    # per-commit cadence the comment above explicitly disclaims.
    #
    # So: a new session, a lane never seen, a DIFFERENT branch, or the one
    # transition that opens an action the model did not have (`unpushed ->
    # pushed`, after which a PR should exist and its absence is the failure this
    # hook is for). Never `pushed -> unpushed`.
    if [ "$prev_sid" = "$sid" ] && [ -n "$prev_subject" ] && [ "$prev_branch" = "$self_branch" ]; then
      if [ "$prev_push" = "unpushed" ] && [ "$push_state" = "pushed" ]; then
        arm=1
      else
        arm=0
      fi
    fi

    # Written on BOTH arms: the record holds the last OBSERVED subject, not the
    # last NUDGED one. Recording only on the arm would freeze `prev_push` at
    # `pushed` and silence the next genuine `unpushed -> pushed`.
    #
    # `$resumed` is the one exception, and it is the same defect in the other
    # direction: that pass reaches the user only, so nothing the model could act
    # on happened. Recording the subject there turns "suppress this pass" into
    # "suppress this subject for good" -- and a lane can be COMMITTED during the
    # continuation, which is exactly the case the resumed arm stops short of
    # silence for, so the very next ordinary turn would read its own first
    # sighting as a repeat.
    # `2>/dev/null` precedes the write redirect so a failed redirect is not
    # reported on the hook's real stderr.
    tmp="${state_file}.$$"
    if [ "$resumed" = "1" ]; then
      : # observed nothing the model could act on; leave the record alone
    elif printf '%s\t%s\t%s\n' "$sid" "$subject" "$(date +%s)" 2>/dev/null >"$tmp"; then
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

  # A nudge that cannot be RECORDED cannot be bounded, and an unbounded one is
  # what this mechanism exists to remove -- so an unresolvable or unwritable git
  # dir costs the MODEL channel, not the warning.
  if [ "$persisted" != "1" ]; then
    arm=0
    user_tail="The agent has NOT been told: this hook could not record the nudge here (unresolvable or unwritable git dir), so it stays on this channel every turn."
  fi
  # LAST, so it wins the wording: a resumed pass never writes the record either,
  # so `persisted` is 0 on every one of them and the clause above would
  # otherwise mislabel every continuation as an unwritable git dir.
  if [ "$resumed" = "1" ]; then
    arm=0
    user_tail="The turn has already been continued once, so the agent is not being interrupted again on this pass."
  fi
  [ "$arm" = "1" ] || channel="sys"
fi

# The tail is substituted at EMIT time, not built into `user_msg` above: the
# downgrade paths that decide which tail is true are evaluated after the text is
# composed, so an already-expanded string could not be corrected.
user_msg="${user_msg/__USER_TAIL__/$user_tail}"

if [ "$channel" = "ctx" ]; then
  msg="$model_msg"
else
  msg="$user_msg"
fi

MSG="$msg
$lanes" CHANNEL="$channel" python3 -c '
import json, os

msg = os.environ["MSG"]
if os.environ["CHANNEL"] == "ctx":
    payload = {"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": msg}}
else:
    payload = {"systemMessage": msg}
print(json.dumps(payload))
'
