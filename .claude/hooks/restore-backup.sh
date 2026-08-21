#!/usr/bin/env bash
# restore-backup.sh
#
# PreToolUse hook. NON-BLOCKING. Before a command that can destroy
# uncommitted work (`git checkout -- <path>`, `git restore <path>`,
# `git reset --hard`, `git clean -f`, `git stash`), snapshot whatever
# the working tree currently holds into `.git/wipe-backups/` and let
# the command proceed.
#
# WHY this exists (incident 2026-08-09): two sessions were working in
# ONE worktree. Session B found ~228 lines of uncommitted changes it
# did not recognize, could not attribute them, and ran
# `git checkout -- <2 files>` to get back to a known state. Those lines
# were session A's finished, tested bug fix plus its regression tests.
# Nothing in git recorded them — `git checkout --` leaves no reflog
# entry and creates no stash — so the work was simply gone. It was
# recoverable only because session B happened to have saved a diff by
# hand first.
#
# The collision (two sessions, one worktree) is the separate concern of
# worktree-owner-gate.sh. THIS hook targets the second, independent
# failure: a destructive restore is irreversible for uncommitted work.
# Making it reversible is cheap, so nothing here blocks or prompts —
# blocking a legitimate `git checkout --` would be constant friction,
# and the whole point is that the operator does not know the changes
# are precious at the moment they run it.
#
# Deliberately NOT limited to multi-session setups: the same command in
# a single session (a revert-proof probe restore, an "undo my scratch
# edits" reflex) destroys work the same way. Related memory rule:
# feedback_revert_proof_restore_must_not_git_checkout.
#
# Output: `.git/wipe-backups/<UTC timestamp>-<verb>/` containing
#   tracked.patch   — `git diff HEAD` (staged + unstaged, tracked files)
#   untracked.tar   — every untracked, non-ignored file (only when the
#                     command can delete untracked files, i.e. clean)
#   COMMAND         — the command line that triggered the snapshot
# Restore with: git apply .git/wipe-backups/<dir>/tracked.patch
#
# Failure policy: fail OPEN and SILENT on anything unexpected. A backup
# helper that blocks the user's command when the snapshot fails would
# be worse than no helper at all.

__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked as
# `bash verify-pr-gate.sh` from inside the hooks dir), which would look for
# `<script-name>/lib/...`. Fall back to the cwd in that case.
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."
if ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null \
  || ! declare -F cmd_matches_verb >/dev/null \
  || ! declare -F cmd_last_cd_target >/dev/null \
  || ! declare -F strip_noncommand_spans >/dev/null; then
  # Non-blocking hook: without the helper, skip rather than refuse. Missing a
  # backup is a smaller harm than blocking an operation this hook only
  # observes.
  exit 0
fi

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

[ -n "$cmd" ] || exit 0

# ---------------------------------------------------------------- match
# Only the shapes that can DESTROY uncommitted work.
#
#   git checkout -- <path> / git checkout .        (worktree overwrite)
#   git restore <path>                             (worktree overwrite)
#   git reset --hard                               (worktree + index)
#   git clean -f / -fd / -xf                       (deletes untracked)
#   git stash / git stash push                     (moves work aside)
#
# `git checkout <branch>` (no `--`, no pathspec) is a branch switch, not
# a restore, and is covered by main-tree-branch-gate.sh — matching it
# here would snapshot on every ordinary switch. `git restore --staged`
# alone only unstages (worktree untouched), but it is cheap to include
# and a combined `--staged --worktree` IS destructive, so it stays in.
#
# Matching goes through the SHARED command-position matcher
# (.claude/hooks/lib/command-match.sh, issue #1455): heredoc bodies and
# quoted spans are stripped, then the verb is matched at line start OR
# after a `&&` / `||` / `;` / `|` operator. That catches chained
# invocations the old line-start anchor missed, while a quoted mention
# still does not fire (it is removed rather than dodged by position).
# `GATE_FLAGS` rather than a hand-copied flag pattern: the local copy had no
# QUOTED alternative for a flag value, so `git -C "/a b" checkout -- f` matched
# nothing and no snapshot was taken (go-to-k/cdkd#2027 review, blocker 1).
prefix="^git${GATE_FLAGS}[[:space:]]+"
verb=""
# `matched_re` is the ERE that actually fired, and it is what gets handed to the
# resolver below. Passing a verbless prefix instead made `gate_target_dir` stop
# at the FIRST `git <anything>` segment, so
# `git -C /one status && git -C /two checkout -- f.txt` snapshotted /one while
# /two was the tree being wiped -- a snapshot of a tree nobody is destroying is
# the same as no snapshot at all, which is the loss this hook exists to prevent.
matched_re=""
if gate_matches "$cmd" "${prefix}checkout([[:space:]]+-[^[:space:]]+)*[[:space:]]+(--|\.)([[:space:]]|$)"; then
  verb="checkout"; matched_re="${prefix}checkout([[:space:]]+-[^[:space:]]+)*[[:space:]]+(--|\.)([[:space:]]|$)"
elif gate_matches "$cmd" "${prefix}restore([[:space:]]|$)"; then
  verb="restore"; matched_re="${prefix}restore([[:space:]]|$)"
elif gate_matches "$cmd" "${prefix}reset([[:space:]]+-[^[:space:]]+)*[[:space:]]+--hard([[:space:]]|$)"; then
  verb="reset-hard"; matched_re="${prefix}reset([[:space:]]+-[^[:space:]]+)*[[:space:]]+--hard([[:space:]]|$)"
elif gate_matches "$cmd" "${prefix}clean([[:space:]]+-[^[:space:]]*f[^[:space:]]*)"; then
  verb="clean"; matched_re="${prefix}clean([[:space:]]+-[^[:space:]]*f[^[:space:]]*)"
elif gate_matches "$cmd" "${prefix}stash([[:space:]]|$)"; then
  verb="stash"; matched_re="${prefix}stash([[:space:]]|$)"
fi
[ -n "$verb" ] || exit 0

# ------------------------------------------------------- resolve target
# Same resolution order as branch-gate.sh: `git -C <path>` wins, then a
# leading `cd <path> &&`, then the Bash tool's persisted cwd.
# The SHARED resolver, in its FALLING-BACK form -- deliberately NOT the strict
# one the blocking gates use (go-to-k/cdkd#2027). This hook refuses nothing; it
# takes a snapshot so a discard stops being irreversible. On an unexpanded
# `git -C "$W"` the hand-rolled scan this replaces built `<cwd>/$W`, failed the
# repo probe below and exited 0 having snapshotted NOTHING, which is the worst
# of the three options. Snapshotting the payload cwd is the right answer here:
# a snapshot of the wrong tree costs a few KB, a missing one costs the work.
target_dir=$(gate_target_dir "$cmd" "${hook_cwd:-$PWD}" "$matched_re")

git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1 || exit 0

# --------------------------------------------------------------- snapshot
# Nothing uncommitted and nothing untracked => nothing to lose. Note
# `--porcelain` covers both, so a `git clean` against a pristine tree
# correctly writes no snapshot.
status=$(git -C "$target_dir" status --porcelain 2>/dev/null || echo "")
[ -n "$status" ] || exit 0

# Per-worktree git dir, so a snapshot taken in a linked worktree lands
# beside that worktree's own git metadata rather than in the shared
# common dir. (markgate resolves its marker store the same way — see
# memory feedback_markgate_markers_are_per_worktree.)
git_dir=$(git -C "$target_dir" rev-parse --absolute-git-dir 2>/dev/null || echo "")
[ -n "$git_dir" ] || exit 0

ts=$(date -u +%Y%m%dT%H%M%SZ)
dest="$git_dir/wipe-backups/${ts}-${verb}"
mkdir -p "$dest" 2>/dev/null || exit 0

printf '%s\n' "$cmd" > "$dest/COMMAND" 2>/dev/null || true

# `git diff HEAD` captures staged AND unstaged changes to tracked files
# in one applyable patch. On a repo with no commits yet HEAD does not
# resolve; fall back to the plain worktree diff rather than emitting an
# empty file.
if ! git -C "$target_dir" diff HEAD --binary > "$dest/tracked.patch" 2>/dev/null; then
  git -C "$target_dir" diff --binary > "$dest/tracked.patch" 2>/dev/null || true
fi

# Untracked files are only at risk from `git clean`; archiving them on
# every stash/checkout would copy build output on a large tree for no
# reason.
if [ "$verb" = "clean" ]; then
  ( cd "$target_dir" 2>/dev/null &&
    git ls-files --others --exclude-standard -z 2>/dev/null |
      tar -cf "$dest/untracked.tar" --null -T - 2>/dev/null ) || true
fi

# Drop an empty snapshot so the directory does not fill with noise.
if [ ! -s "$dest/tracked.patch" ] && [ ! -s "$dest/untracked.tar" ]; then
  rm -rf "$dest" 2>/dev/null || true
  exit 0
fi

echo "restore-backup: snapshotted the working tree before '$verb'." >&2
echo "  $dest" >&2
# The patch covers the WHOLE tree, so a plain `git apply` fails once any
# other change in it is still present ("patch does not apply"). Both
# forms below were verified against a real wipe-and-recover replay:
# --include re-applies exactly one path and exits 0; --3way restores
# everything recoverable and reports the hunks already in place.
echo "  recover ONE file:  git -C \"$target_dir\" apply --include=<path> \"$dest/tracked.patch\"" >&2
echo "  recover the tree:  git -C \"$target_dir\" apply --3way \"$dest/tracked.patch\"" >&2

exit 0
