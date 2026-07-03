#!/usr/bin/env bash
# main-tree-git-cwd-detector.sh — PostToolUse hook (matcher: Bash).
#
# REACTIVE backstop for the cwd-RACE class documented in memory
# feedback_session_resume_resets_cwd.md (4 hits in a single 2026-07-03
# session). The failure shape: during a feature-worktree task the
# persistent Bash cwd silently resets to the MAIN worktree (session
# resume / compaction / an earlier convenience `cd`), and the next
# bare `git add` / `git commit` / `git push` then runs against the
# MAIN tree instead of the intended `.claude/worktrees/<branch>/`
# worktree. The tells are quiet and easy to misread — "nothing to
# commit", a "non-fast-forward" push, or a commit that lands the
# wrong (or no) files — none of which look like a cwd bug.
#
# The existing `branch-gate.sh` (PreToolUse) blocks `git commit` /
# `git push` when the target tree is on `main`/`master`, but it does
# NOT fire when the main tree happens to be on a non-main branch, and
# a blocked commit's error is itself easy to misattribute to the
# worktree. `main-tree-dirty-detector.sh` catches variable-indirected
# FILE writes but not the git-invocation cwd race. This hook closes
# that specific gap: it warns (non-blocking) whenever a `git
# add`/`commit`/`push` is invoked with an EFFECTIVE git dir that
# resolves to the MAIN worktree WHILE one or more feature worktrees
# under `.claude/worktrees/` are active — the exact signature of a
# cwd-race mid-task.
#
# Effective git dir resolution (so the SANCTIONED pattern never warns):
#   1. `git -C <dir> ...`  -> use <dir>  (the recommended cwd-race-proof
#      form; if it points at a worktree, no warning).
#   2. leading `cd <dir> &&` -> use <dir>.
#   3. otherwise            -> the hook's reported cwd.
# Only bare/`cd`-relative git in the main tree with feature worktrees
# live triggers the warning, keeping noise near zero.
#
# Always exit 0 — PostToolUse cannot block, this only informs.

set -u

input=$(cat 2>/dev/null || true)

tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
[[ "$tool" == "Bash" ]] || exit 0

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[[ -n "$cmd" ]] || exit 0

# Only care about state-mutating git verbs that a cwd-race silently
# misdirects. `git status` / `git log` / `git diff` are read-only and
# harmless in the wrong tree, so we skip them to stay quiet. The
# leading `(^|[&;|(])` anchors `git` at a COMMAND position (start of
# line, or after `&&` / `;` / `|` / `(`), so a compound
# `git add -A && git commit ...` matches while a quoted body like
# `echo "git commit"` does NOT — mirrors the line-start anchoring the
# rest of the hook family uses (feedback_hook_command_match_line_start).
printf '%s' "$cmd" | grep -qE '(^|[&;|(])[[:space:]]*git([[:space:]]+-[^[:space:]]+)*[[:space:]]+(commit|add|push)\b' || exit 0

hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
eff_dir="${hook_cwd:-$PWD}"

# 1) Explicit `git -C <dir>` wins — this is the cwd-race-proof form we
#    WANT people to use, so honor its target rather than the cwd.
if [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
  gc="${BASH_REMATCH[1]}"
  gc="${gc%\"}"; gc="${gc#\"}"; gc="${gc%\'}"; gc="${gc#\'}"
  [[ "$gc" != /* ]] && gc="${hook_cwd:-$PWD}/$gc"
  eff_dir="$gc"
# 2) A leading `cd <dir> &&` redirects relative git to <dir>.
elif [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
  cdt="${BASH_REMATCH[1]}"
  cdt="${cdt%\"}"; cdt="${cdt#\"}"; cdt="${cdt%\'}"; cdt="${cdt#\'}"
  [[ "$cdt" != /* ]] && cdt="${hook_cwd:-$PWD}/$cdt"
  eff_dir="$cdt"
fi

[[ -d "$eff_dir" ]] || exit 0

# Resolve the worktree the effective dir belongs to, and the MAIN
# worktree (first entry of `git worktree list`).
eff_top=$(git -C "$eff_dir" rev-parse --show-toplevel 2>/dev/null) || exit 0
main_tree=$(git -C "$eff_dir" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')
[[ -n "$main_tree" ]] || exit 0

# Canonicalize both for a reliable equality test (macOS symlinked /tmp,
# trailing slashes, ..).
canon() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "${1%/}"; }
eff_top=$(canon "$eff_top")
main_tree=$(canon "$main_tree")

# Only interesting when the git op targets the MAIN worktree itself.
[[ "$eff_top" == "$main_tree" ]] || exit 0

# ...AND a feature worktree is currently active (a task is in flight).
# `.claude/worktrees/<branch>/` is the sanctioned location; if none
# exist, a main-tree git op is just ordinary main-tree work and the
# branch-gate already governs it — stay quiet.
feature_wts=$(git -C "$main_tree" worktree list --porcelain 2>/dev/null \
  | awk '/^worktree /{print $2}' \
  | grep -F "$main_tree/.claude/worktrees/" || true)
[[ -n "$feature_wts" ]] || exit 0

wt_list=$(printf '%s\n' "$feature_wts" | sed -E "s#^$main_tree/##" | head -6 | paste -sd ',' -)

msg="WARNING (main-tree-git-cwd-detector): a \`git add/commit/push\` just ran with its effective git dir resolving to the MAIN worktree ($main_tree) while feature worktree(s) are active: $wt_list. "
msg+="This is the signature of the cwd-RACE class (feedback_session_resume_resets_cwd.md): the persistent Bash cwd silently reset to the main tree mid-task, so the git op targeted the WRONG repo. "
msg+="A \"nothing to commit\", a \"non-fast-forward\" push, or a commit that captured the wrong/no files here is almost certainly THAT, not real git state. "
msg+="Verify: (1) did the edit you intended actually land in the feature worktree? (2) re-run the git op prefixed with \`git -C <feature-worktree>\` (the cwd-race-proof form), NOT a bare git from the main-tree cwd. "
msg+="If you genuinely meant to operate on the main tree, ignore this — but the branch-gate will still block a commit/push on \`main\`/\`master\`."

ctx=$(printf '%s' "$msg" | jq -Rs .)
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":%s}}\n' "$ctx"
exit 0
