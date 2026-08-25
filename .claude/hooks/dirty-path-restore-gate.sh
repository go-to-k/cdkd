#!/usr/bin/env bash
# dirty-path-restore-gate.sh — BLOCK `git checkout -- <path>` /
# `git restore <path>` when that path currently has UNCOMMITTED changes.
#
# WHY this exists (incident 2026-08-12, PR #1700): a mutation probe was
# running against `src/provisioning/providers/kinesis-provider.ts`, which
# ALSO carried ~200 lines of finished, unrelated, uncommitted review
# fixes. Undoing the probe with `git checkout -- <file>` reverted the
# file to HEAD and took the review fixes with it. The intent was "undo my
# probe edit"; the effect was "discard every uncommitted change to this
# file". Those two are indistinguishable in the command, and the second
# is silent and irreversible — `git checkout --` writes no reflog entry
# and creates no stash.
#
# RELATIONSHIP TO restore-backup.sh (complements, not rivals):
#   - restore-backup.sh is NON-BLOCKING and makes the operation
#     RECOVERABLE by snapshotting to `.git/wipe-backups/` first.
#   - this gate makes it DELIBERATE. Recovery only helps someone who
#     knows a snapshot exists; in the 2026-08-12 incident the loss read
#     as permanent and cost a scramble to reconstruct from an ad-hoc
#     `/tmp` copy. Blocking converts a reflex into a decision, and the
#     message names the recovery path so the knowledge is not required
#     in advance.
#
# SCOPE — deliberately narrow, so this is not constant friction:
#   - ONLY path-scoped restores (`git checkout -- <path>`,
#     `git restore <path>`). A branch switch (`git checkout main`) or a
#     branch create (`git checkout -b x`) never matches.
#   - ONLY when a named path actually has uncommitted changes. Restoring
#     an unmodified path is a no-op and passes silently, which is what
#     keeps the common "make sure this file is pristine" usage quiet.
#   - `git restore --staged` is allowed: it rewrites the INDEX only and
#     leaves working-tree content alone.
#   - `git reset --hard` / `git clean -f` / `git stash` are NOT gated
#     here. They are whole-tree operations whose blast radius is evident
#     from the command itself, and restore-backup.sh already snapshots
#     them. This gate targets the one spelling whose blast radius is
#     genuinely wider than it looks.
#
# ESCAPE HATCH: CDKD_ALLOW_DIRTY_RESTORE=1 (restore-backup.sh still
# snapshots, so even the bypass stays recoverable).
#
# Failure policy: fail OPEN on anything unexpected. A gate that blocks on
# its own bug is worse than the bug it prevents.

set -euo pipefail

input_json=$(cat)

tool_name=$(jq -r '.tool_name // empty' <<<"$input_json" 2>/dev/null || true)
[[ "$tool_name" == "Bash" ]] || exit 0

command=$(jq -r '.tool_input.command // empty' <<<"$input_json" 2>/dev/null || true)
[[ -n "$command" ]] || exit 0

[[ "${CDKD_ALLOW_DIRTY_RESTORE:-}" == "1" ]] && exit 0

# Cheap pre-filter so the common case costs nothing. It used to test for the
# bare VERBS as substrings, because a `git -C <path>` prefix sits between the
# two words and the literal-pair form silently skipped every cross-worktree
# invocation. The shared matcher (.claude/hooks/lib/command-match.sh, issue #2129)
# absorbs that prefix itself, so the pair can be matched properly again: the
# `-C` shape still fires, and a quoted mention of the verb no longer does.
# shellcheck source=lib/command-match.sh
_gate_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/command-match.sh"
# Fail CLOSED: a gate that cannot evaluate the command must not wave it through.
# `|| exit 0` silently disabled the gate whenever the library was unreadable or
# truncated, while ten of these files carried a comment claiming the opposite
# (go-to-k/cdkd#2130 review). The 18 gates that predate this convergence already
# exit 2 here; these now match them.
if [ ! -r "$_gate_lib" ]; then
  echo "Blocked: .claude/hooks/lib/command-match.sh is missing or unreadable, so this gate cannot evaluate the command." >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$_gate_lib"
# Guard EVERY helper this hook calls, not just the first one. A truncated
# library that still defined `gate_matches` left `gate_target_dir_strict`
# undefined, and an undefined function exits 127 -- which the caller reads as
# "could not resolve" and refuses, so that one fails safe, while an undefined
# `gate_matches` exits 127 into an `if !` and passes. The window is exactly what
# this guard exists to close (go-to-k/cdkd#2027 review round 4).
if ! declare -F gate_matches >/dev/null 2>&1 \
  || ! declare -F gate_target_dir_strict >/dev/null 2>&1 \
  || ! declare -F gate_refuse_unresolved_target >/dev/null 2>&1; then
  echo "Blocked: .claude/hooks/lib/command-match.sh loaded but its API is incomplete (truncated file?)." >&2
  exit 2
fi
gate_matches "$command" "$GATE_RE_GIT_CHECKOUT_RESTORE" || exit 0

# Resolve the working directory the command runs in, mirroring the other
# cwd-aware gates: the payload cwd, overridden by an explicit `cd <path>`
# prefix or a `git -C <path>` argument.
cwd=$(jq -r '.cwd // empty' <<<"$input_json" 2>/dev/null || true)
[[ -n "$cwd" && -d "$cwd" ]] || cwd="$PWD"

# A `cd` in ANY segment before the verb, then a `git -C <path>`, each honoured
# only when it names a directory that exists (unchanged from the hand-rolled
# form this replaces).
# FAIL CLOSED on a target this parser cannot read (go-to-k/cdkd#2027): the
# fallback below would check whether the named path is dirty in the SESSION's
# tree while the discard lands in another one.
if ! candidate=$(gate_target_dir_strict "$command" "$cwd" "$GATE_RE_GIT_CHECKOUT_RESTORE"); then
  gate_refuse_unresolved_target "dirty-path-restore-gate" "$cwd" \
    "" \
    "CDKD_ALLOW_DIRTY_RESTORE=1 still bypasses this gate deliberately."
fi
[[ -d "$candidate" ]] && cwd="$candidate"

git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Defined ABOVE every user, and a liveness check below, because this file has
# already shipped the other way once: a helper defined after its first call
# makes every call `command not found` (127), and in an `&&` chain that reads
# as "no match" -- silently, at rc=0. The same shape took out fence 4 of
# unresolved-target-class.test.sh in an earlier round of this PR.
# Split QUOTE-AWARE, not on whitespace. `for raw in $paths` word-splits, so
# `git checkout -- "sp ace.txt"` yielded `"sp` and `ace.txt"`, neither of which
# is a path git knows, and the gate passed on a dirty file. A path with a space
# is ordinary and the failure direction is the bad one -- a silent discard of
# uncommitted work, which is this gate's entire subject.
split_paths() {
  local text="$1" tok="" ch quote="" i n
  n=${#text}
  for (( i = 0; i < n; i++ )); do
    ch="${text:i:1}"
    # Backslash handling follows the SHELL, which is different in each of the
    # three contexts and was got wrong in two of them across two rounds:
    #   - single-quoted span: never an escape. 'a\b' is a\b.
    #   - double-quoted span: an escape ONLY before $ ` " \ or a newline.
    #     Before anything else the backslash is RETAINED, so "a\b.txt" is the
    #     path a\b.txt -- and emitting ab.txt made the gate pass on a dirty
    #     file of that name. The round that fixed the single-quote case
    #     asserted "the double-quoted spelling was already correct", which
    #     held only for the "a\\b.txt" spelling its one test used.
    #   - outside any span: always an escape.
    if [[ "$ch" == '\' ]]; then
      _nxt="${text:$((i + 1)):1}"
      if [[ "$quote" == "'" ]]; then
        tok="$tok$ch"
      elif [[ "$quote" == '"' ]]; then
        case "$_nxt" in
          '$'|'`'|'"'|'\'|"")
            i=$((i + 1)); tok="$tok$_nxt" ;;
          *) tok="$tok$ch" ;;
        esac
      else
        i=$((i + 1)); tok="$tok$_nxt"
      fi
      continue
    fi
    if [[ -n "$quote" ]]; then
      if [[ "$ch" == "$quote" ]]; then quote=""; else tok="$tok$ch"; fi
    elif [[ "$ch" == '"' || "$ch" == "'" ]]; then
      quote="$ch"
    elif [[ "$ch" == ' ' || "$ch" == $'\t' ]]; then
      [[ -n "$tok" ]] && printf '%s\n' "$tok"
      tok=""
    else
      tok="$tok$ch"
    fi
  done
  [[ -n "$tok" ]] && printf '%s\n' "$tok"
  return 0
}

if ! command -v split_paths >/dev/null 2>&1; then
  echo "Blocked by dirty-path-restore-gate: split_paths is not defined at the point it is used, so every call returns 127 and the gate would pass silently." >&2
  exit 2
fi

# Extract the path arguments of a PATH-SCOPED restore.
#
#   git checkout -- <path>...     the `--` is what makes it a path restore,
#                                 so `git checkout <branch>` never matches
#   git restore [flags] <path>... path-scoped by default
paths=""
pathspec_file_seen=0
# `gate_verb_rest` rather than a local `=~` with a positional BASH_REMATCH
# index. Both halves of that old form were hazards. The hand-rolled `-C` pattern
# it originally used had no quoted alternative, so `git -C "/a b" checkout -- f`
# matched nothing and the gate passed a destructive discard (go-to-k/cdkd#2027
# review, blocker 1). Switching to `$GATE_FLAGS` fixed that but made the tail
# `BASH_REMATCH[4]` -- an index into a SHARED pattern, so widening GATE_FLAGS
# for `git -c user.name="Jane Doe"` shifted it and this gate silently stopped
# blocking `git checkout -- <dirty path>` in 7 of its 18 cases
# (go-to-k/cdkd#2200). The helper strips the matched prefix by LENGTH, so the
# group count is no longer part of the contract.
# EVERY matching segment, and both verbs, rather than "probe checkout, else
# probe restore". The first-match form this replaces had a live regression found
# in review: `git checkout main && git checkout -- f.txt` returned segment 1,
# which has no `--`, so the gate exited 0 and never saw the segment that
# discards the file. Measured old-vs-new on a repo with a dirty `f.txt`, all
# three of these went BLOCK -> pass:
#
#   git checkout main && git checkout -- f.txt
#   git checkout -b wip && git restore -- f.txt
#   git checkout main; git restore -- f.txt
#
# A branch switch chained ahead of a discard is an everyday shape, so the arm
# that finds nothing must FALL THROUGH, never exit.
while IFS= read -r seg; do
  [ -n "$seg" ] || continue
  # `git checkout` is a path restore only when `--` is present; without it the
  # segment is a branch switch and simply contributes nothing.
  case " $seg " in
    *" -- "*) paths="$paths ${seg#*-- }" ;;
  esac
done < <(gate_verb_rest_each "$command" "$GATE_RE_GIT_CHECKOUT")

while IFS= read -r seg; do
  [ -n "$seg" ] || continue
  # The subject is padded (`" $seg "`), so a trailing-space pattern covers the
  # end-of-string case too — the unpadded `*" --staged"` variants would be dead
  # patterns that can never match. `continue`, not `exit 0`: a staged restore in
  # one segment says nothing about a worktree restore in the next.
  #
  # `--staged` alone rewrites the INDEX only, which is why it is skipped. With
  # `--worktree` alongside it, the same command ALSO discards worktree content
  # -- so the skip has to be conditional on `--worktree` being absent. Both
  # spellings were passing on a dirty file: `git restore --staged --worktree f`
  # and `git restore -S -W f`, while `git restore -SW f` and
  # `git restore -W f` correctly blocked. Pre-existing, found reviewing the
  # rewrite of this arm.
  # NOT an enumeration of `-W` clusters. `" -W "|" -SW "|" -WS "` was one, and
  # it was stale on arrival: `git restore -S -qW f` is legal, matches none of
  # them, hits the `-S` arm and skipped -- reverting the file with the gate
  # reporting rc=0. Short flags cluster in any order with any other flag, so
  # the set of spellings is not enumerable. Ask each WORD instead.
  # QUOTE-AWARE, via the same splitter the path scan uses. `for w in $seg`
  # word-split a quoted path, so a FRAGMENT of one could be read as a flag:
  # `git restore "a -Sx.txt" tracked.txt` yielded a word `-Sx.txt`, set
  # seg_has_staged, skipped the segment, and passed on a dirty tracked.txt.
  # That is the word-splitting defect `split_paths` exists to fix, reintroduced
  # forty lines above it. It also removes the unquoted-expansion glob: `$seg`
  # containing `*` used to expand against this process's cwd.
  seg_has_worktree=0
  seg_has_staged=0
  seg_has_pathspec_file=0
  while IFS= read -r w; do
    case "$w" in
      # Git accepts any UNAMBIGUOUS PREFIX of a long option, so an exact-match
      # arm is an enumeration with the same problem the short-flag arm had, one
      # level up: `git restore --staged --worktr f` set staged=1, worktree=0,
      # skipped, and DISCARDED the file with the gate returning 0. All eight
      # spellings from `--w` to `--worktree` are accepted by git and all eight
      # reverted the file. The asymmetry is what hides it -- abbreviating BOTH
      # halves fails safe, because neither flag is recognised here and nothing
      # is skipped.
      #
      # `--st*`, NOT `--s*`: `--source` and `--staged` share the `--s`
      # prefix, so a `--s*` arm reads `--sou` as staged and skips a segment
      # that stages nothing. An explicit `--so*) ;;` arm was written first and
      # a probe showed it fences nothing -- with `--st*` in place, `--so...`
      # already falls through to `--*` and is ignored. The two `--sou` cases
      # in the suite guard the `--s*` WIDENING, which is the change that would
      # actually break this. A bare `--s` is ambiguous and git rejects it, so
      # leaving it unclassified costs nothing -- the command does not run.
      --pathspec-from-file*|--pathspec-file-nul*) seg_has_pathspec_file=1 ;;
      --w*)  seg_has_worktree=1 ;;
      --st*) seg_has_staged=1 ;;
      --*)   ;;
      -*)
        # Scan the cluster CHARACTER BY CHARACTER and stop at the first
        # value-taking letter, because everything after it is that flag's
        # VALUE rather than more flags. `git restore -sSTABLE f` is
        # `-s STABLE`, and a substring test on the whole token read the `S`
        # of STABLE as `--staged`, skipped the segment, and discarded the
        # worktree copy. `-s` is the only value-taking short option
        # `git restore` has.
        _cluster="${w#-}"
        while [ -n "$_cluster" ]; do
          case "${_cluster:0:1}" in
            s) break ;;
            S) seg_has_staged=1 ;;
            W) seg_has_worktree=1 ;;
          esac
          _cluster="${_cluster:1}"
        done
        ;;
    esac
  done < <(split_paths "$seg")
  # `--pathspec-from-file` names its paths in a FILE, so the segment carries
  # none of them and every check below finds nothing to object to -- the gate
  # returned 0 while git discarded every path the file listed. A path set this
  # parser cannot enumerate is exactly the case for refusing rather than
  # passing, which is what the rest of this gate does with a target it cannot
  # read.
  if [ "$seg_has_pathspec_file" -eq 1 ]; then
    pathspec_file_seen=1
    break
  fi
  # `--staged` alone rewrites the INDEX, so it is skipped. With `--worktree`
  # alongside it the same command ALSO discards worktree content, so the skip
  # has to be conditional on `--worktree` being absent.
  if [ "$seg_has_staged" -eq 1 ] && [ "$seg_has_worktree" -eq 0 ]; then
    continue
  fi
  if [[ " $seg " == *" -- "* ]]; then
    paths="$paths ${seg#*-- }"
  else
    paths="$paths $seg"
  fi
done < <(gate_verb_rest_each "$command" "$GATE_RE_GIT_RESTORE")

if [ "$pathspec_file_seen" -eq 1 ]; then
  {
    echo "Blocked by dirty-path-restore-gate: this discards UNCOMMITTED work."
    echo
    echo "The command names its paths with --pathspec-from-file, so they live in a"
    echo "FILE this hook cannot reliably read at PreToolUse time. Every path in that"
    echo "file would be reverted to HEAD, and a gate that cannot enumerate them"
    echo "refuses rather than passing -- the same choice this hook makes for a target"
    echo "directory it cannot resolve."
    echo
    echo "Name the paths on the command line, or set CDKD_ALLOW_DIRTY_RESTORE=1 if"
    echo "discarding them is the intent."
  } >&2
  exit 2
fi

[[ -n "${paths// /}" ]] || exit 0

# NO operator-stripping here any more, and its absence is deliberate. The old
# form matched the RAW command with a greedy `(.*)$`, so the tail ran past
# `&&` / `;` and had to be truncated; that truncation is also what made a
# chained discard look like one command. The tails now come from
# `gate_verb_rest_each`, which yields already-split segments, so there is no
# operator left to strip -- and stripping anyway would silently drop a path
# containing one of those characters.


dirty_paths=()
while IFS= read -r p; do
  [[ "$p" == -* ]] && continue
  [[ "$p" == "--" ]] && continue
  [[ -n "$p" ]] || continue
  # `git status --porcelain <path>` prints nothing when the path is clean.
  if status_out=$(git -C "$cwd" status --porcelain -- "$p" 2>/dev/null); then
    [[ -n "$status_out" ]] && dirty_paths+=("$p")
  fi
done < <(split_paths "$paths")

[[ ${#dirty_paths[@]} -gt 0 ]] || exit 0

git_dir=$(git -C "$cwd" rev-parse --git-dir 2>/dev/null || echo ".git")

{
  echo "Blocked by dirty-path-restore-gate: this discards UNCOMMITTED work."
  echo
  echo "These paths have uncommitted changes and would be reverted to HEAD:"
  for p in "${dirty_paths[@]}"; do
    echo "  - $p"
  done
  echo
  echo "\`git checkout -- <path>\` / \`git restore <path>\` writes no reflog entry"
  echo "and creates no stash, so anything not committed is gone silently."
  echo
  echo "If you are undoing a TEMPORARY edit (a mutation probe, a scratch"
  echo "experiment) on a file that ALSO holds real uncommitted work, this is"
  echo "the wrong tool — it cannot tell the two apart. Use a scratch copy:"
  echo "  cp <file> /tmp/<file>.bak     # BEFORE the probe"
  echo "  cp /tmp/<file>.bak <file>     # to undo ONLY the probe"
  echo
  echo "To recover work an earlier restore already destroyed, restore-backup.sh"
  echo "snapshots every such command:"
  echo "  ls ${git_dir}/wipe-backups/"
  echo "  git -C '${cwd}' apply <snapshot>/tracked.patch"
  echo
  echo "If discarding these changes really is the intent:"
  echo "  CDKD_ALLOW_DIRTY_RESTORE=1 <your command>"
} >&2

exit 2
