#!/usr/bin/env bash
# main-tree-edit-gate.sh
#
# PreToolUse hook (matcher: Edit|Write|Bash). Blocks MUTATING a
# git-tracked file that lives in a worktree currently on `main` /
# `master`. Feature work — including the integ-ledger updates that
# `/run-integ` writes — must happen in a dedicated worktree on a
# feature branch (`.claude/worktrees/<branch>/`), never in the
# main tree on `main`.
#
# WHY this gate exists: the existing `branch-gate.sh` blocks
# `git commit` / `git push` on `main`, and `main-tree-branch-gate.sh`
# blocks `git switch`/`checkout` to a feature branch in the main
# tree. But NEITHER blocks the act of *editing a tracked file* in
# the main tree while on `main`. On 2026-06-21 a `/pick-integ` ->
# `/run-integ` campaign updated the committed ledger
# `docs/_generated/integ-last-run.tsv` IN the main tree on `main`
# over and over, leaving uncommitted changes that blocked the
# user's `git pull --ff-only` and had to be stashed by hand. That
# was the gap. See memory feedback_main_tree_tracked_edit_gate.md.
#
# Detection model (per candidate target file):
#   1. Resolve the file's absolute path.
#   2. Find the worktree it belongs to and that worktree's branch.
#   3. If the branch is `main` / `master` AND the file is tracked
#      (or is a NEW file under a known source dir), BLOCK.
#   Feature worktrees (branch != main/master) always pass, so the
#   sanctioned `.claude/worktrees/<branch>/` flow is never blocked.
#
# Candidate targets by tool:
#   - Edit / Write: `tool_input.file_path` (reliable).
#   - Bash: best-effort scan of `tool_input.command` for LITERAL
#     write targets — `> f`, `>> f`, `tee [-a] f`, `sed -i ... f`,
#     `cp <src> f`, `mv <src> f`. Variable-indirected targets
#     (`mv "$tmp" "$LEDGER"`) CANNOT be statically resolved and are
#     a known gap — the worktree-first process is the real guard
#     for those; this Bash arm is defense-in-depth for literal paths.
#
# Exit 0 = allow, exit 2 = block (message on stderr).

set -u

# Shared command-position matcher. This gate used to resolve a leading `cd`
# with a regex of its own, and go-to-k/cdkd#2614 measured what that cost: the
# verb `cd` was matched as LITERAL text, so `"cd" <main-tree> && echo x > <a
# tracked file>` and its `'cd'` / `\cd` spellings left `base_dir` at the
# payload cwd and the gate exited 0 over the main tree -- while the literal
# spelling exited 2. The token was already being UNQUOTED one line later, so
# the parser expected quoting on the VALUE and not on the verb: the same
# asymmetry go-to-k/cdkd#2333 found in the shared matcher.
#
# `cmd_last_cd_target` is that resolution done once, for every gate. It also
# does two things the local regex did not: it follows EVERY `cd` in command
# position and composes relative ones, and it SKIPS an unexpanded `$VAR` rather
# than resolving it to a path no `git -C` can read.
# shellcheck source=lib/command-match.sh
__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked as
# `bash main-tree-edit-gate.sh` from inside the hooks dir).
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."
if ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null \
  || ! declare -F cmd_last_cd_target >/dev/null; then
  # FAIL CLOSED, as every other blocking gate does: a hook that cannot parse
  # the command cannot say the edit is safe, and `|| exit 0` on an unloadable
  # library is the shape that made twelve sibling gates inert
  # (go-to-k/cdkd#2027).
  echo "Blocked: .claude/hooks/lib/command-match.sh is missing or unloadable," >&2
  echo "so main-tree-edit-gate cannot resolve the command's working directory." >&2
  echo "Restore the file; do not work around the gate." >&2
  exit 2
fi

input=$(cat 2>/dev/null || true)

tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
base_dir="${hook_cwd:-$PWD}"

# --- Collect candidate target file paths -----------------------------------
candidates=()

case "$tool" in
  Edit|Write|MultiEdit)
    fp=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
    [[ -n "$fp" ]] && candidates+=("$fp")
    ;;
  Bash)
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
    [[ -z "$cmd" ]] && exit 0
    # A `cd <dir> &&` BEFORE the write changes the base dir for relative paths.
    # Resolved by the shared matcher, which sees a quoted or escaped `cd`
    # (go-to-k/cdkd#2614) and composes chained relative ones. It prints NOTHING
    # when no `cd` was resolved, which is why `base_dir` is only overwritten on
    # a non-empty answer -- an unresolvable `cd "$WT"` must leave the payload
    # cwd in place rather than becoming an empty base.
    #
    # ONLY THE PREFIX BEFORE THE EARLIEST WRITE IS SCANNED, and only after
    # subshell / substitution spans are removed. `cmd_last_cd_target` follows
    # EVERY `cd` in command position -- the library's own doc names a trailing
    # one hijacking the lookup as the hazard its optional VERB argument exists
    # for, and this gate has no verb to stop the walk. Handing it the whole
    # command re-opened this gate's own founding incident, measured against the
    # pre-go-to-k/cdkd#2614 hook with the payload cwd in the main tree on
    # `main`:
    #
    #   echo hi > <tracked> && cd /tmp            rc=2 -> 0
    #   echo x | tee <tracked> && cd /tmp         rc=2 -> 0
    #   echo hi > <tracked>; x=$(cd /tmp && pwd)  rc=2 -> 0
    #
    # -- cheaper than the quoted-`cd` spelling go-to-k/cdkd#2614 closed, and it
    # fires by ACCIDENT: `$(cd <abs> && pwd)` is an ordinary path-resolution
    # idiom. The same walk also produced the opposite error, a false block on
    # the standing post-merge step from a FEATURE worktree
    # (`echo hi > f && cd <main> && git pull`, rc=0 -> 2). Bounding the scan
    # fixes both directions at once: a `cd` after the write never moved the
    # write, and a `cd` inside `$( )` or `( )` never moved the caller.
    #
    # A KNOWN FALSE-REFUSAL CLASS, named rather than left implicit: a `>` or a
    # `tee` inside a QUOTED argument truncates the prefix and drops a real `cd`
    # after it, so `echo "a > b" && cd <feature-wt> && echo x > <tracked>` from
    # a main-tree cwd BLOCKS. The stripper that would tell a quoted `>` from a
    # real one is not length-preserving, so its offsets cannot be mapped back,
    # and running the whole scan on the stripped text would delete the quoted
    # `"cd"` that go-to-k/cdkd#2614 exists to see. This gate fires on
    # `Edit|Write|Bash`, so the class is written up in
    # .claude/rules/hooks-main-tree-edit.md rather than only here. It is the
    # loud direction, and it is the answer the pre-go-to-k/cdkd#2614 regex also
    # gave, since its `cd` was not leading.
    # `tee` carries NO trailing space here: `tee\t<file>` and a line-ending
    # `tee` are writes too, and requiring the space let them through.
    # Over-truncating is the safe direction -- a shorter prefix resolves FEWER
    # `cd`s, so the base stays the payload cwd and the gate blocks more.
    cd_scan="$cmd"
    for __w in '>' 'tee' 'sed -i'; do
      case "$cd_scan" in *"$__w"*) cd_scan="${cd_scan%%"$__w"*}" ;; esac
    done
    # Each arm computes its OWN closer. An earlier revision picked `__pre` /
    # `__rest` in the `$(` arm and then chose the closing delimiter by
    # re-testing the ORIGINAL string for a backtick pair, so a command carrying
    # both stripped to the wrong closer.
    while :; do
      case "$cd_scan" in
        *'$('*')'*)
          __pre="${cd_scan%%'$('*}"; __rest="${cd_scan#*'$('}"; __rest="${__rest#*')'}" ;;
        *'`'*'`'*)
          __pre="${cd_scan%%'`'*}";  __rest="${cd_scan#*'`'}";  __rest="${__rest#*'`'}" ;;
        *'('*')'*)
          __pre="${cd_scan%%'('*}";  __rest="${cd_scan#*'('}";  __rest="${__rest#*')'}" ;;
        *) break ;;
      esac
      cd_scan="$__pre$__rest"
    done
    cdt=$(cmd_last_cd_target "$cd_scan" "$base_dir" 2>/dev/null || true)
    [[ -n "$cdt" ]] && base_dir="$cdt"
    # Extract LITERAL redirection / write targets. We deliberately
    # skip tokens containing `$` (unexpandable variables) and `*?[`
    # (globs) — we cannot resolve those statically.
    # 1) > target  and  >> target
    while read -r tok; do
      [[ -n "$tok" ]] && candidates+=("$tok")
    done < <(printf '%s\n' "$cmd" | grep -oE '>>?[[:space:]]*[^[:space:]<>|&;()]+' | sed -E 's/^>>?[[:space:]]*//')
    # 2) tee [-a] target...
    while read -r tok; do
      [[ -n "$tok" ]] && candidates+=("$tok")
    done < <(printf '%s\n' "$cmd" | grep -oE 'tee[[:space:]]+(-a[[:space:]]+)?[^[:space:]<>|&;()]+' | sed -E 's/^tee[[:space:]]+(-a[[:space:]]+)?//')
    # 3) sed -i ... LASTTOKEN  (in-place edit; target is the file arg)
    #    Heuristic: the final whitespace-delimited token of a `sed -i` command.
    if printf '%s' "$cmd" | grep -qE 'sed[[:space:]]+-i'; then
      last=$(printf '%s' "$cmd" | awk '{print $NF}')
      candidates+=("$last")
    fi
    ;;
  *)
    exit 0
    ;;
esac

[[ ${#candidates[@]} -eq 0 ]] && exit 0

# --- Helpers ---------------------------------------------------------------
canonicalize_dir() {
  local p="$1"
  if [[ -d "$p" ]]; then (cd "$p" 2>/dev/null && pwd -P) || printf '%s' "${p%/}"
  else printf '%s' "${p%/}"; fi
}

is_protected_path() {
  # echo "BLOCK <reason>" on stderr-worthy hit, else nothing.
  local raw="$1"
  # Strip surrounding quotes.
  raw="${raw%\"}"; raw="${raw#\"}"; raw="${raw%\'}"; raw="${raw#\'}"
  # Skip unresolvable tokens (variables / globs / process-subst).
  case "$raw" in
    *'$'* | *'*'* | *'?'* | *'['* | '/dev/'* | '-') return 1 ;;
  esac
  # Absolutize relative to base_dir.
  local abs="$raw"
  [[ "$abs" != /* ]] && abs="$base_dir/$abs"
  # Directory to query git from = the file's parent (must exist).
  local dir; dir=$(dirname "$abs")
  [[ -d "$dir" ]] || return 1
  # Canonicalize the parent dir (macOS /tmp -> /private/tmp etc.) and
  # rebuild the absolute path so the later `rel` prefix-strip against
  # the (also-canonical) worktree top matches.
  dir=$(canonicalize_dir "$dir")
  abs="$dir/$(basename "$abs")"
  # Which worktree + branch?
  local branch; branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null) || return 1
  [[ "$branch" == "main" || "$branch" == "master" ]] || return 1
  local top; top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || return 1
  top=$(canonicalize_dir "$top")
  # Repo opt-in scope (issue #1259): only repos following the worktree +
  # markgate convention get main-tree edit protection. Unrelated repos
  # (a personal blog on main, a scratch clone) are the user's own
  # single-writer trees; the shared-main-tree hazard does not apply.
  # Opt-in signal: a `.markgate.yml` at the file's worktree top.
  [[ -f "$top/.markgate.yml" ]] || return 1
  # Never gate inside a nested worktree dir (defensive; their branch
  # would not be main/master anyway).
  case "$abs" in
    "$top"/.claude/worktrees/*) return 1 ;;
  esac
  # Tracked file?  -> always protected.
  if git -C "$dir" ls-files --error-unmatch -- "$abs" >/dev/null 2>&1; then
    PROTECT_BRANCH="$branch"; PROTECT_TOP="$top"; PROTECT_KIND="tracked"
    return 0
  fi
  # New (untracked) file under a known source dir -> protected too.
  local rel="${abs#"$top"/}"
  case "$rel" in
    src/* | tests/* | docs/* | scripts/* | .claude/* )
      # (.claude/worktrees/* already excluded above.)
      PROTECT_BRANCH="$branch"; PROTECT_TOP="$top"; PROTECT_KIND="new-source-file"
      return 0
      ;;
  esac
  return 1
}

for c in "${candidates[@]}"; do
  if is_protected_path "$c"; then
    branch_slug="hardening"
    cat >&2 <<EOF
Blocked by main-tree-edit-gate: attempt to modify a $PROTECT_KIND file in a worktree on \`$PROTECT_BRANCH\`.

  target file: $c
  worktree:    $PROTECT_TOP  (on $PROTECT_BRANCH)
  tool:        $tool

Tracked files (source, docs, AND generated/committed data like
docs/_generated/integ-last-run.tsv) must NOT be edited in the main
tree on \`$PROTECT_BRANCH\`. The main tree is a shared resource across
parallel agents, and uncommitted edits there block \`git pull\`.

Do the work in a feature worktree instead:

  git worktree add .claude/worktrees/$branch_slug -b chore/$branch_slug origin/main
  cd .claude/worktrees/$branch_slug
  # ... edit / run / commit here ...
  # open a PR, then:  git worktree remove .claude/worktrees/$branch_slug

For /run-integ campaigns specifically: run the integ from the main
tree if you like (read-only on git), but point the LEDGER write at
the feature worktree's copy of docs/_generated/integ-last-run.tsv.

There is no silent bypass — if you truly must edit in the main tree,
confirm with the user first.
EOF
    exit 2
  fi
done

exit 0
