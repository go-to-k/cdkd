#!/usr/bin/env bash
# worktree-owner-gate.sh
#
# PreToolUse hook. Gives each LINKED git worktree a single owning
# session. The first session to edit a file in a worktree claims it;
# a different session editing the same worktree is blocked with the
# owner's id and the exact release command.
#
# WHY (incident 2026-08-09): the repo convention is "one lane, one
# worktree", which nothing enforced at the SESSION level. Two sessions
# both `cd`-ed into `.claude/worktrees/fix-1387-globaltable-gsi-throughput`
# and worked the same PR. Session B saw ~228 lines of uncommitted
# changes it had not written, could not attribute them, and reverted
# them; they were session A's tested fix. Both sessions then serialized
# their remaining lanes behind each other to avoid a repeat.
#
# The convention was never the problem — the collision was invisible.
# `git worktree list` shows which worktrees EXIST, not which are being
# actively driven by another agent, and a session that starts (or
# resumes, or has its cwd silently reset) inside an existing worktree
# has no signal that it is trespassing.
#
# Scope: file-writing tools only (Edit / Write / NotebookEdit). Bash is
# deliberately NOT gated — a shell command's write targets cannot be
# resolved statically, and the read-only commands that dominate Bash
# usage (git status, ls, grep) must never be blocked. The reactive
# `main-tree-dirty-detector.sh` PostToolUse hook covers the Bash-write
# case in the same spirit.
#
# Ownership record: `<worktree git dir>/session-owner` holding
# `<session id> <UTC claim time>`. Per-worktree by construction, so it
# cannot collide across lanes.
#
# TTL: an owner older than OWNER_TTL_HOURS is treated as abandoned and
# silently taken over. Sessions end without cleanup all the time, and a
# stale lock that requires manual clearing is a worse failure than the
# one being prevented.
#
# Release / takeover: delete the file the message names.
#
# Failure policy: fail OPEN. Anything unresolvable (no session id in
# the payload, path outside a worktree, unreadable sentinel) passes
# through. This hook exists to catch an honest mistake, not to be a
# security boundary — a false block on a legitimate edit costs more
# than the rare miss.

set -u

OWNER_TTL_HOURS=${CDKD_WORKTREE_OWNER_TTL_HOURS:-12}

input=$(cat 2>/dev/null || true)

session=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
file_path=$(printf '%s' "$input" | jq -r '
  .tool_input.file_path // .tool_input.notebook_path // ""
' 2>/dev/null || echo "")

# No session id => the payload shape is not what this hook assumes.
# Pass through rather than guess; the hook is inert instead of wrong.
[ -n "$session" ] || exit 0

# Escape hatch for a deliberate hand-off.
[ "${CDKD_SKIP_WORKTREE_OWNER_GATE:-}" = "1" ] && exit 0

target="${file_path:-$hook_cwd}"
[ -n "$target" ] || exit 0

# Resolve the directory to ask git about (the file may not exist yet on
# a Write, so use its parent).
if [ -d "$target" ]; then
  probe_dir="$target"
else
  probe_dir=$(dirname "$target")
fi
[ -d "$probe_dir" ] || exit 0

git_dir=$(git -C "$probe_dir" rev-parse --absolute-git-dir 2>/dev/null || echo "")
[ -n "$git_dir" ] || exit 0

# Only LINKED worktrees are gated. A linked worktree's git dir is
# `<common>/worktrees/<name>`; the main tree's is plain `.git` and is
# already covered by main-tree-edit-gate.sh / main-tree-branch-gate.sh.
case "$git_dir" in
  */worktrees/*) : ;;
  *) exit 0 ;;
esac

# Repo opt-in, matching branch-gate.sh: only repos carrying the
# markgate convention participate.
top=$(git -C "$probe_dir" rev-parse --show-toplevel 2>/dev/null || echo "")

# A path INSIDE the git dir has no work tree, so `--show-toplevel` fails
# there and the opt-in check below used to fall through to a pass. The one
# path that matters is the `session-owner` sentinel itself — which is the
# LOCK. So the lock was the single file the lock did not protect, and
# "take another session's worktree" was a one-line Write to it.
#
# That is not hypothetical: on 2026-08-10 a session found a sentinel owned
# by another session, guessed the owner was dead, Wrote its own id over the
# sentinel, and worked a worktree another live agent was driving. The
# blocking branch below did its job for every ordinary file and was simply
# routed around here.
#
# Recover the worktree root from `<git dir>/gitdir` (which points at the
# linked worktree's `.git` file) so the opt-in still consults the WORKTREE's
# own `.markgate.yml`, matching the non-sentinel path.
if [ -z "$top" ] && [ -f "$git_dir/gitdir" ]; then
  linked_dotgit=$(cat "$git_dir/gitdir" 2>/dev/null || echo "")
  [ -n "$linked_dotgit" ] && top=$(dirname "$linked_dotgit")
fi
[ -n "$top" ] && [ -f "$top/.markgate.yml" ] || exit 0

# Is this write targeting the sentinel itself? Used only to tailor the
# refusal message — the ownership logic below is deliberately identical,
# so claiming an unowned or stale worktree by writing the file still works.
sentinel_write=0
case "$target" in
  */worktrees/*/session-owner) sentinel_write=1 ;;
esac

sentinel="$git_dir/session-owner"
worktree_name=$(basename "$git_dir")

claim() {
  printf '%s %s\n' "$session" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$sentinel" 2>/dev/null || true
}

if [ ! -f "$sentinel" ]; then
  claim
  exit 0
fi

owner=$(awk '{print $1}' "$sentinel" 2>/dev/null || echo "")
claimed_at=$(awk '{print $2}' "$sentinel" 2>/dev/null || echo "")

# Unreadable / malformed sentinel: reclaim rather than block.
[ -n "$owner" ] || { claim; exit 0; }

[ "$owner" = "$session" ] && exit 0

# Stale owner => take over silently.
if [ -n "$claimed_at" ]; then
  now_epoch=$(date -u +%s)
  # BSD date (macOS) and GNU date disagree on parse flags; try both and
  # treat an unparseable stamp as "not stale" (conservative: keep the
  # lock rather than silently stealing it).
  claim_epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$claimed_at" +%s 2>/dev/null \
    || date -u -d "$claimed_at" +%s 2>/dev/null || echo "")
  if [ -n "$claim_epoch" ]; then
    age_h=$(( (now_epoch - claim_epoch) / 3600 ))
    if [ "$age_h" -ge "$OWNER_TTL_HOURS" ]; then
      claim
      echo "worktree-owner-gate: took over '$worktree_name' from an owner idle ${age_h}h." >&2
      exit 0
    fi
  fi
fi

if [ "$sentinel_write" = "1" ]; then
  echo "Blocked by worktree-owner-gate: refusing to overwrite the ownership sentinel of '$worktree_name'." >&2
else
  echo "Blocked by worktree-owner-gate: '$worktree_name' is owned by another session." >&2
fi
echo "  worktree:      $top" >&2
echo "  owner session: $owner (claimed $claimed_at)" >&2
echo "  your session:  $session" >&2
echo "  target:        $target" >&2
echo "" >&2
echo "Two sessions editing one worktree is how uncommitted work gets destroyed" >&2
echo "(2026-08-09: a session reverted another's finished, tested fix because it" >&2
echo "could not attribute the diff)." >&2
echo "" >&2

if [ "$sentinel_write" = "1" ]; then
  echo "This file IS the lock. Writing it is taking the worktree, not editing a file." >&2
  echo "" >&2
fi

echo "The claim above is younger than the ${OWNER_TTL_HOURS}h TTL, so the owning session is" >&2
echo "presumed LIVE. You cannot tell a live session from a dead one by looking:" >&2
echo "a recent claim, a stale-looking diff, and a /clear you did not observe all" >&2
echo "produce the same evidence. Do NOT infer that the owner is gone (2026-08-10:" >&2
echo "a session did exactly that, took this sentinel, and worked a lane another" >&2
echo "live agent was driving)." >&2
echo "" >&2
echo "Use your OWN worktree for this lane:" >&2
echo "  git worktree add .claude/worktrees/<branch> -b <branch> origin/main" >&2
echo "" >&2
echo "If you believe the owner is finished, ASK THE MAINTAINER FIRST -- especially" >&2
echo "when the worktree has uncommitted changes (check: git -C \"$top\" status --short)." >&2
echo "Only after they confirm, hand off deliberately:" >&2
echo "  rm \"$sentinel\"          # or re-run with CDKD_SKIP_WORKTREE_OWNER_GATE=1" >&2
exit 2
