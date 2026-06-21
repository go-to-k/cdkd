#!/usr/bin/env bash
# main-tree-dirty-detector.sh — PostToolUse hook (matcher: Bash).
#
# REACTIVE backstop for the one gap the PreToolUse `main-tree-edit-gate.sh`
# cannot close: a Bash command that writes to a tracked file via a
# VARIABLE-indirected path (e.g. `mv "$tmp" "$LEDGER"`,
# `cp x "$OUT"`, `echo .. > "$f"`). The PreToolUse gate resolves
# targets statically and cannot expand shell variables, so the exact
# shape of the 2026-06-21 incident — `/run-integ` rewriting the
# committed ledger via `mv "$tmp" "$LEDGER"` in the main tree on
# `main` — would slip past it. This hook runs AFTER the command and,
# if the MAIN worktree is on `main`/`master` and now has dirty
# TRACKED files, surfaces a loud non-blocking warning so the operator
# fixes it immediately (move the edit into a feature worktree) instead
# of letting it accumulate and block the next `git pull --ff-only`.
#
# Pairs with: main-tree-edit-gate.sh (PreToolUse, blocks tool-based +
# literal-path edits) and the worktree-first process in CLAUDE.md.
# See memory feedback_main_tree_tracked_edit_gate.md.
#
# Noise control: only runs the git check when the command contains a
# write-ish token (redirect / tee / mv / cp / sed -i / dd). Read-only
# commands (grep, ls, git status, ...) exit immediately. Always
# exit 0 — PostToolUse cannot block, this only informs.

set -u

input=$(cat 2>/dev/null || true)

tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
[[ "$tool" == "Bash" ]] || exit 0

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[[ -n "$cmd" ]] || exit 0

# Only proceed when the command plausibly wrote a file. This both
# reduces per-Bash overhead and ties the warning to its likely cause.
if ! printf '%s' "$cmd" | grep -qE '(>>?|[^|]\|[[:space:]]*tee\b|[[:space:]]tee\b|\bmv\b|\bcp\b|sed[[:space:]]+-i|\bdd\b|\btruncate\b)'; then
  exit 0
fi

hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
probe_dir="${hook_cwd:-$PWD}"
[[ -d "$probe_dir" ]] || probe_dir="$PWD"

# Resolve the MAIN worktree (first entry of `git worktree list`).
main_tree=$(git -C "$probe_dir" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')
[[ -n "$main_tree" ]] || exit 0

# Only care when the main tree is on main/master.
branch=$(git -C "$main_tree" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
[[ "$branch" == "main" || "$branch" == "master" ]] || exit 0

# Dirty TRACKED files? `git status --porcelain` lists `??` for
# untracked (ignored files are not shown at all). Any non-`??` entry
# is a tracked change (modified / added / deleted / renamed).
dirty=$(git -C "$main_tree" status --porcelain 2>/dev/null | grep -vE '^\?\?' || true)
[[ -n "$dirty" ]] || exit 0

# Compose a compact file list (cap to keep the message readable).
files=$(printf '%s\n' "$dirty" | sed -E 's/^.. //' | head -8 | paste -sd ',' -)
extra=$(printf '%s\n' "$dirty" | wc -l | tr -d ' ')

msg="WARNING (main-tree-dirty-detector): the MAIN worktree ($main_tree) is on \`$branch\` and now has uncommitted changes to $extra tracked file(s): $files. "
msg+="This is the gap the PreToolUse main-tree-edit-gate cannot catch (variable-indirected Bash writes like \`mv \\\"\$tmp\\\" \\\"\$LEDGER\\\"\`). "
msg+="Tracked files must NOT be edited in the main tree on \`$branch\` — uncommitted edits there block \`git pull --ff-only\` and are a shared-resource hazard for parallel agents. "
msg+="Fix NOW: move the change into a feature worktree (git worktree add .claude/worktrees/<b> -b <b> origin/main), copy the edited file(s) over, then \`git -C $main_tree checkout -- <file>\` to restore the main tree. For /run-integ specifically, point the ledger write at the worktree copy of docs/_generated/integ-last-run.tsv."

# Emit non-blocking additionalContext (jq -Rs to JSON-encode safely).
ctx=$(printf '%s' "$msg" | jq -Rs .)
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":%s}}\n' "$ctx"
exit 0
