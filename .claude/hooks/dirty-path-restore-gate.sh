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

# Cheap pre-filter so the common case costs nothing. Deliberately matches the
# bare VERBS rather than `git checkout` / `git restore`: a `git -C <path>`
# prefix sits between the two words, so the literal-pair form silently skipped
# every cross-worktree invocation — exactly the shape this repo uses most (a
# gate that never fires is worse than no gate, and this one was caught only
# because the test suite covers the `-C` case).
case "$command" in
  *checkout*|*restore*) ;;
  *) exit 0 ;;
esac

# Resolve the working directory the command runs in, mirroring the other
# cwd-aware gates: the payload cwd, overridden by an explicit `cd <path>`
# prefix or a `git -C <path>` argument.
cwd=$(jq -r '.cwd // empty' <<<"$input_json" 2>/dev/null || true)
[[ -n "$cwd" && -d "$cwd" ]] || cwd="$PWD"

if [[ "$command" =~ (^|[[:space:]\;\&])cd[[:space:]]+\"?([^\"[:space:]\;\&]+)\"? ]]; then
  candidate="${BASH_REMATCH[2]}"
  [[ -d "$candidate" ]] && cwd="$candidate"
fi
if [[ "$command" =~ git[[:space:]]+-C[[:space:]]+\"?([^\"[:space:]]+)\"? ]]; then
  candidate="${BASH_REMATCH[1]}"
  [[ -d "$candidate" ]] && cwd="$candidate"
fi

git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Extract the path arguments of a PATH-SCOPED restore.
#
#   git checkout -- <path>...     the `--` is what makes it a path restore,
#                                 so `git checkout <branch>` never matches
#   git restore [flags] <path>... path-scoped by default
paths=""
if [[ "$command" =~ git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+checkout[[:space:]]+(.*)$ ]]; then
  rest="${BASH_REMATCH[2]}"
  case " $rest " in
    *" -- "*) paths="${rest#*-- }" ;;
    *) exit 0 ;;
  esac
elif [[ "$command" =~ git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+restore[[:space:]]+(.*)$ ]]; then
  rest="${BASH_REMATCH[2]}"
  # The subject is padded (`" $rest "`), so a trailing-space pattern covers the
  # end-of-string case too — the unpadded `*" --staged"` variants would be dead
  # patterns that can never match.
  case " $rest " in
    *" --staged "*|*" -S "*) exit 0 ;;
  esac
  if [[ " $rest " == *" -- "* ]]; then
    paths="${rest#*-- }"
  else
    paths="$rest"
  fi
else
  exit 0
fi

# Stop at the first shell operator so a chained command's tokens are not
# mistaken for paths.
paths="${paths%%&&*}"
paths="${paths%%||*}"
paths="${paths%%;*}"
paths="${paths%%|*}"

[[ -n "${paths// /}" ]] || exit 0

dirty_paths=()
for raw in $paths; do
  [[ "$raw" == -* ]] && continue
  [[ "$raw" == "--" ]] && continue
  p="${raw%\"}"; p="${p#\"}"; p="${p%\'}"; p="${p#\'}"
  [[ -n "$p" ]] || continue
  # `git status --porcelain <path>` prints nothing when the path is clean.
  if status_out=$(git -C "$cwd" status --porcelain -- "$p" 2>/dev/null); then
    [[ -n "$status_out" ]] && dirty_paths+=("$p")
  fi
done

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
