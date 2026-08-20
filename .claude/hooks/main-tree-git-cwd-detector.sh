#!/usr/bin/env bash
# main-tree-git-cwd-detector.sh — PostToolUse hook (matcher: Bash).
#
# REACTIVE backstop for the cwd-RACE class documented in memory
# feedback_session_resume_resets_cwd.md (4 hits in a single 2026-07-03
# session). The failure shape: during a feature-worktree task the
# persistent Bash cwd silently resets to the MAIN worktree (session
# resume / compaction / an earlier convenience `cd`), and the next
# command that OMITS an explicit `cd <worktree> &&` then runs against
# the MAIN tree instead of the intended `.claude/worktrees/<branch>/`
# worktree.
#
# The hook covers TWO families of command, which share that mechanism
# but fail in opposite ways:
#
#   1. GIT MUTATIONS — `git add` / `git commit` / `git push`. The tells
#      are quiet and easy to misread: "nothing to commit", a
#      "non-fast-forward" push, or a commit that lands the wrong (or
#      no) files — none of which look like a cwd bug.
#
#   2. VERIFICATION COMMANDS — `vp run <task>` / `vp test run <path>`
#      and `markgate set|verify <gate>` (including the
#      `mise exec -- markgate ...` spelling this repo actually writes).
#      These are worse, because the wrong tree produces no error at
#      all: a build/test/typecheck run against unmodified `main`
#      PASSES, and its verdict attests to NOTHING about the lane. A
#      FALSE GREEN is indistinguishable from a real one, so unlike
#      family 1 there is no symptom to misread — there is no symptom.
#      Same for a marker: `markgate set` from the main tree binds the
#      main tree's content and its per-worktree store, not the lane's.
#
# The name is historical (the hook shipped covering only family 1);
# it is kept so the settings registration, the rules entry and this
# suite's marker string stay stable.
#
# WHY A HOOK AT ALL: the rule is already written down twice —
# `/work-issues` section 6 ("Start every marker and gate command with
# an explicit `cd <worktree> &&` ... a shell cwd does not reliably
# persist between tool calls, so the wrong tree is the default outcome
# rather than a slip") and its "bash cwd silent reset" Gotchas entry,
# which even names the FALSE GREEN as the worst form. On 2026-08-20 an
# orchestrator that had just read both violated it three times in one
# run, twice on family 2 (`vp run build && vp run test` with no `cd`,
# ran the whole suite against the main checkout; and a `cd "$W" && gh
# pr merge` whose `$W` is a VARIABLE, so a gate could not resolve the
# worktree statically and read another worktree's sentinel). Per this
# repo's escalation rule, a rule that was already in the text and got
# violated anyway is escalated to a mechanism rather than restated.
#
# SCOPE is deliberately the EVIDENCE-PRODUCING set, not "read-only
# commands run in the wrong tree". A `grep` or a `cat` against the main
# tree is wrong too, but warning on those makes the detector noise and
# noise makes a detector ignored. What earns a warning is a command
# whose VERDICT is taken as evidence about the lane.
#
# Effective dir resolution (so the SANCTIONED pattern never warns):
#   1. every `cd <dir>` in command position BEFORE the verb (via the
#      shared `cmd_last_cd_target`, so chained relative cds compose and
#      a trailing `cd` cannot hijack the lookup);
#   2. for the GIT family only, an explicit `git -C <dir>` overrides —
#      it is the cwd-race-proof form we want people to use;
#   3. otherwise the hook's reported cwd.
#
# `git -C` is deliberately NOT honoured for the verification family:
# `vp` and `markgate` have no `-C` equivalent, so a compound like
# `git -C <wt> add -A && vp run test` runs the TEST in the cwd
# regardless. Reading the `-C` there would silence the warning — a
# false NEGATIVE, which for a detector is the one unacceptable
# direction, since a missing warning is indistinguishable from nothing
# being wrong.
#
# Always exit 0 — PostToolUse cannot block, this only informs.

# shellcheck source=lib/command-match.sh
__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked
# as `bash main-tree-git-cwd-detector.sh` from inside the hooks dir),
# which would look for `<script-name>/lib/...`. Fall back to the cwd.
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."
if ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null \
  || ! declare -F cmd_matches_verb >/dev/null 2>&1 \
  || ! declare -F cmd_last_cd_target >/dev/null 2>&1 \
  || ! declare -F strip_noncommand_spans >/dev/null 2>&1; then
  # NON-blocking hook: without the helper, skip rather than refuse —
  # matching restore-backup.sh / post-merge-sync-reminder.sh. A missed
  # warning is a smaller harm than refusing an operation this hook only
  # observes. (The BLOCKING gates fail CLOSED instead.)
  exit 0
fi

set -u

input=$(cat 2>/dev/null || true)

tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
[[ "$tool" == "Bash" ]] || exit 0

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[[ -n "$cmd" ]] || exit 0

# ------------------------------------------------------------------ verbs
#
# Family 1: state-mutating git verbs that a cwd-race silently
# misdirects. `git status` / `git log` / `git diff` are read-only and
# harmless in the wrong tree, so they are skipped to stay quiet.
GIT_VERB='git([[:space:]]+-[^[:space:]]+)*[[:space:]]+(commit|add|push)([[:space:]]|$|[|;&])'

# Family 2: verification commands whose verdict is taken as evidence.
#
# `vp run <task>` requires a task token, so a bare `vp run` (which does
# nothing) does not arm it. `vp test run <path>` is the form
# vp-run-test-path-gate steers callers to, so it must be covered too or
# the steer would move traffic OUT of this detector's view.
#
# The `mise exec [args] -- markgate ...` prefix is not optional
# nicety: it is how EVERY marker call in this repo is actually spelled,
# so a matcher seeing only a bare `markgate` would miss the real-world
# shape entirely. Both spellings are asserted by this hook's suite.
# `markgate status` is read-only and stays out.
VERIFY_VERB='(vp[[:space:]]+run[[:space:]]+[^[:space:]]|vp[[:space:]]+test[[:space:]]+run([[:space:]]|$|[|;&])|(mise[[:space:]]+exec[[:space:]]+([^[:space:]]+[[:space:]]+)*)?markgate[[:space:]]+(set|verify)([[:space:]]|$|[|;&]))'

# Cheap literal pre-filter before the shared matcher. This hook is a
# PostToolUse `Bash` hook with no `if:` condition, so it runs on EVERY
# Bash call, and `cmd_matches_verb` costs an awk pass over the whole
# command (twice here, plus twice more for the cd resolution). The
# filter is strictly BROADER than either ERE below — every command
# matching them contains one of these literals — so it can only skip
# commands the matcher would also have rejected.
printf '%s' "$cmd" | grep -qE 'git|vp|markgate' || exit 0

git_hit=0
verify_hit=0
# The shared matcher neutralises heredoc bodies and quoted spans first,
# then requires COMMAND POSITION — so a commit message or PR body that
# quotes `vp run test` does not fire (this repo's own commit messages
# routinely describe the commands they are about).
cmd_matches_verb "$cmd" "$GIT_VERB" && git_hit=1
cmd_matches_verb "$cmd" "$VERIFY_VERB" && verify_hit=1
[[ "$git_hit" == 1 || "$verify_hit" == 1 ]] || exit 0

hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
base="${hook_cwd:-$PWD}"

# --------------------------------------------------------- effective dirs
eff_git="$base"
if [[ "$git_hit" == 1 ]]; then
  cdt="$(cmd_last_cd_target "$cmd" "$base" "$GIT_VERB")"
  [[ -n "$cdt" ]] && eff_git="$cdt"
  # An explicit `git -C <dir>` wins — the cwd-race-proof form.
  if [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
    gc="${BASH_REMATCH[1]}"
    gc="${gc%\"}"; gc="${gc#\"}"; gc="${gc%\'}"; gc="${gc#\'}"
    [[ "$gc" != /* ]] && gc="$eff_git/$gc"
    eff_git="$gc"
  fi
fi

eff_verify="$base"
if [[ "$verify_hit" == 1 ]]; then
  cdt="$(cmd_last_cd_target "$cmd" "$base" "$VERIFY_VERB")"
  [[ -n "$cdt" ]] && eff_verify="$cdt"
fi

# Canonicalize for a reliable equality test (macOS symlinked /tmp,
# trailing slashes, ..).
canon() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "${1%/}"; }

# in_main_tree <dir> — succeeds (setting MAIN_TREE) when <dir> resolves
# to the MAIN worktree of a repo that has opted into the worktree +
# markgate convention (issue #1259: a `.markgate.yml` at the main
# worktree root). A cdkd session regularly touches unrelated personal
# repos where main-tree work is the normal single-writer flow.
MAIN_TREE=""
in_main_tree() {
  local d="$1" top mt
  [[ -d "$d" ]] || return 1
  top=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) || return 1
  mt=$(git -C "$d" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')
  [[ -n "$mt" ]] || return 1
  top=$(canon "$top")
  mt=$(canon "$mt")
  [[ -f "$mt/.markgate.yml" ]] || return 1
  [[ "$top" == "$mt" ]] || return 1
  MAIN_TREE="$mt"
  return 0
}

warn_git=0
warn_verify=0
main_tree=""
if [[ "$git_hit" == 1 ]] && in_main_tree "$eff_git"; then
  warn_git=1
  main_tree="$MAIN_TREE"
fi
if [[ "$verify_hit" == 1 ]] && in_main_tree "$eff_verify"; then
  warn_verify=1
  main_tree="$MAIN_TREE"
fi
[[ "$warn_git" == 1 || "$warn_verify" == 1 ]] || exit 0

# ...AND a feature worktree is currently active (a task is in flight).
# `.claude/worktrees/<branch>/` is the sanctioned location; if none
# exist, a main-tree command is just ordinary main-tree work and the
# branch-gate already governs the git half — stay quiet.
feature_wts=$(git -C "$main_tree" worktree list --porcelain 2>/dev/null \
  | awk '/^worktree /{print $2}' \
  | grep -F "$main_tree/.claude/worktrees/" || true)
[[ -n "$feature_wts" ]] || exit 0

wt_list=$(printf '%s\n' "$feature_wts" | sed -E "s#^$main_tree/##" | head -6 | paste -sd ',' -)
first_wt=$(printf '%s\n' "$feature_wts" | head -1)

msg="WARNING (main-tree-git-cwd-detector): a command just ran with its effective working dir resolving to the MAIN worktree ($main_tree) while feature worktree(s) are active: $wt_list. "
msg+="This is the signature of the cwd-RACE class (feedback_session_resume_resets_cwd.md): the persistent Bash cwd silently reset to the main tree mid-task, so the command targeted the WRONG tree. "

if [[ "$warn_verify" == 1 ]]; then
  msg+="THE COMMAND WAS A VERIFICATION COMMAND (\`vp run\` / \`vp test run\` / \`markgate set|verify\`), so the hazard is NOT an error you will see — it is a FALSE GREEN. "
  msg+="A build / test / typecheck / lint run in the main tree exercised UNMODIFIED \`main\`: it passes, and its verdict attests to NOTHING about the lane's changes, which are sitting in the worktree untouched. "
  msg+="A \`markgate set\` from here binds the main tree's content in the main tree's per-worktree marker store, so the gate it is meant to satisfy stays unsatisfied (and a \`markgate verify\` here answers about the wrong tree). "
  msg+="Do NOT treat that run as evidence. Re-run it in the worktree: \`cd $first_wt && <the same command>\`. "
fi

if [[ "$warn_git" == 1 ]]; then
  msg+="THE COMMAND WAS A GIT MUTATION (\`git add\`/\`commit\`/\`push\`). "
  msg+="A \"nothing to commit\", a \"non-fast-forward\" push, or a commit that captured the wrong/no files here is almost certainly THAT, not real git state. "
  msg+="Verify: (1) did the edit you intended actually land in the feature worktree? (2) re-run the git op prefixed with \`git -C <feature-worktree>\` (the cwd-race-proof form), NOT a bare git from the main-tree cwd. "
fi

msg+="If you genuinely meant to operate on the main tree, ignore this — but the branch-gate will still block a commit/push on \`main\`/\`master\`."

ctx=$(printf '%s' "$msg" | jq -Rs .)
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":%s}}\n' "$ctx"
exit 0
