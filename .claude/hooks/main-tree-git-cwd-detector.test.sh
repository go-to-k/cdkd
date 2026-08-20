#!/usr/bin/env bash
# Smoke test for main-tree-git-cwd-detector.sh.
#
# Builds a fixture main repo + a feature worktree under
# `.claude/worktrees/`, then feeds the hook synthetic PostToolUse
# payloads and asserts whether the cwd-race warning is emitted
# (stdout contains the hook marker) or not. Run from repo root:
#   bash .claude/hooks/main-tree-git-cwd-detector.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/main-tree-git-cwd-detector.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

MAIN="$TMPDIR/main"
git init -q -b main "$MAIN"
echo "seed" > "$MAIN/file.txt"
# Opt the fixture into the gate (issue #1259).
touch "$MAIN/.markgate.yml"
git -C "$MAIN" add -A
git -C "$MAIN" -c user.email=t@t -c user.name=t commit -q -m init

# canonicalize (macOS /tmp -> /private/tmp) so paths in payloads match
# what the hook resolves via `pwd -P`.
MAIN="$(cd "$MAIN" && pwd -P)"

# A feature worktree under .claude/worktrees/ = "task in flight".
WT="$MAIN/.claude/worktrees/feat-x"
git -C "$MAIN" worktree add -q "$WT" -b feat/x >/dev/null 2>&1
WT="$(cd "$WT" && pwd -P)"

pass=0; fail=0
# run_case <expect: warn|quiet> <desc> <cwd> <command>
run_case() {
  local expect="$1" desc="$2" cwd="$3" cmd="$4" out got
  local json
  json=$(jq -nc --arg c "$cmd" --arg cwd "$cwd" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$c}}')
  out=$(printf '%s' "$json" | bash "$HOOK" 2>/dev/null)
  if printf '%s' "$out" | grep -q "main-tree-git-cwd-detector"; then got="warn"; else got="quiet"; fi
  if [[ "$got" == "$expect" ]]; then
    pass=$((pass+1)); printf 'ok   (%s) %s\n' "$got" "$desc"
  else
    fail=$((fail+1)); printf 'FAIL (got %s, want %s) %s\n' "$got" "$expect" "$desc"
  fi
}

# 1. Bare `git commit` from the MAIN tree cwd while a feature worktree
#    is active -> WARN (the cwd-race signature).
run_case warn  "bare git commit in main tree, feature worktree active" \
  "$MAIN" 'git commit -m x'

# 2. `git add -A && git commit` compound from main tree -> WARN.
run_case warn  "compound git add && git commit in main tree" \
  "$MAIN" 'git add -A && git commit -F /tmp/msg'

# 3. `git push` from main tree -> WARN.
run_case warn  "bare git push in main tree" \
  "$MAIN" 'git push origin HEAD'

# 4. `git -C <feature-worktree> commit` from main cwd -> QUIET
#    (the cwd-race-PROOF form; targets the worktree).
run_case quiet "git -C <worktree> commit from main cwd" \
  "$MAIN" "git -C $WT commit -m x"

# 5. `cd <worktree> && git commit` from main cwd -> QUIET
#    (cd redirects the effective dir to the worktree).
run_case quiet "cd <worktree> && git commit" \
  "$MAIN" "cd $WT && git commit -m x"

# 6. Bare `git commit` from the feature-worktree cwd -> QUIET
#    (already in the right tree).
run_case quiet "bare git commit from feature-worktree cwd" \
  "$WT" 'git commit -m x'

# 7. Read-only verb (`git status`) in main tree -> QUIET (not mutating).
run_case quiet "git status in main tree" \
  "$MAIN" 'git status'

# 8. Quoted body mentioning git commit -> QUIET (command-position anchor).
run_case quiet "echo containing 'git commit' string" \
  "$MAIN" 'echo "run git commit next"'

# ---------------------------------------------------------------------
# VERIFICATION-COMMAND family (`vp run` / `vp test run` / `markgate
# set|verify`). Same cwd-race mechanism as the git family, opposite
# failure mode: the main-tree run produces no error at all, it produces
# a FALSE GREEN. Cases 9-20.
# ---------------------------------------------------------------------

# 9. `vp run build` in main tree, feature worktree active -> WARN.
run_case warn  "vp run build in main tree, feature worktree active" \
  "$MAIN" 'vp run build'

# 10. `vp run build && vp run test` — the measured 2026-08-20 shape:
#     the full suite ran against the MAIN checkout while the lane's
#     changes sat in the worktree -> WARN.
run_case warn  "vp run build && vp run test in main tree" \
  "$MAIN" 'vp run build && vp run test'

# 11. `vp test run <path>` (the form vp-run-test-path-gate steers to)
#     in main tree -> WARN.
run_case warn  "vp test run <path> in main tree" \
  "$MAIN" 'vp test run tests/unit/cli/version.test.ts'

# 12. Bare `markgate set` in main tree -> WARN.
run_case warn  "markgate set check in main tree" \
  "$MAIN" 'markgate set check'

# 13. The `mise exec -- markgate ...` form — how EVERY marker call in
#     this repo is actually spelled -> WARN. A matcher that only sees a
#     bare `markgate` misses the real-world shape entirely.
run_case warn  "mise exec -- markgate set in main tree" \
  "$MAIN" 'mise exec -- markgate set check'

# 14. Same for `markgate verify` under the mise prefix -> WARN.
run_case warn  "mise exec -- markgate verify in main tree" \
  "$MAIN" 'mise exec -- markgate verify check'

# 15. `cd <worktree> && vp run test` -> QUIET (the sanctioned form).
run_case quiet "cd <worktree> && vp run test" \
  "$MAIN" "cd $WT && vp run test"

# 16. `cd <worktree> && mise exec -- markgate set` -> QUIET.
run_case quiet "cd <worktree> && mise exec -- markgate set" \
  "$MAIN" "cd $WT && mise exec -- markgate set check"

# 17. `vp run test` from the feature-worktree cwd -> QUIET (already in
#     the right tree).
run_case quiet "vp run test from feature-worktree cwd" \
  "$WT" 'vp run test'

# 18. Quoted mention of a verification command -> QUIET (the shared
#     command-position matcher neutralises quoted spans). Uses `git -C
#     <worktree>` so the GIT half is quiet for its own reason, isolating
#     the verify half.
#
#     The quoted body carries a `&&` SEPARATOR before the verb. That is
#     load-bearing: without one the verb is not in command position even
#     in the RAW text, so the case would pass with stripping disabled
#     and would not discriminate the stripper at all. With it, the only
#     thing keeping this quiet is the neutralisation.
run_case quiet "git -C <worktree> commit whose message quotes '&& vp run test'" \
  "$MAIN" "git -C $WT commit -m \"done && vp run test\""

# 19. Plain quoted mention with no git verb at all -> QUIET. Same
#     construction: the `;` inside the quotes puts the verb in command
#     position in the raw text, so this fails without the stripper.
run_case quiet "echo containing '; mise exec -- markgate set' string" \
  "$MAIN" 'echo "next; mise exec -- markgate set check"'

# 19b. The `mise exec -- ` prefix must be honoured for `vp` too, not
#      only `markgate` — work-issues/SKILL.md tells agents to invoke vp
#      that way -> WARN.
run_case warn  "mise exec -- vp run test in main tree" \
  "$MAIN" 'mise exec -- vp run test'

# 19c. `mise exec <tool> -- vp run <task>` (a tool token before `--`).
run_case warn  "mise exec node@24 -- vp run build in main tree" \
  "$MAIN" 'mise exec node@24 -- vp run build'

# 19d. The literal `--` is required, so a `mise exec` whose ARGUMENTS
#      merely mention the verb does not fire -> QUIET.
run_case quiet "mise exec -- echo mentioning vp run test" \
  "$MAIN" 'mise exec -- echo vp run test'

# 20. `git -C <worktree>` does NOT redirect the verification half: the
#     `vp run test` still runs in the cwd (vp has no `-C`), so this must
#     WARN. Honouring the `-C` here would be a false NEGATIVE, the one
#     unacceptable direction for a detector.
run_case warn  "git -C <worktree> add && bare vp run test" \
  "$MAIN" "git -C $WT add -A && vp run test"

# ---------------------------------------------------------------------
# UNRESOLVABLE `cd`: a `cd` IS present in command position but its
# target cannot be resolved (the path was entirely quoted, so the
# stripper left a placeholder). Must stay QUIET — asserting the cwd
# here means crying wolf on `cd "$WT" && <cmd>`, the exact spelling
# /work-issues section 6 mandates and the shape that defeated
# pr-review-gate twice. "No cd" and "unresolvable cd" are different
# states. Cases 20a-20e.
# ---------------------------------------------------------------------

# 20a. VERIFICATION family, the mandated spelling with a quoted
#      variable -> QUIET.
run_case quiet 'cd "$WT" && vp run test (quoted var, unresolvable)' \
  "$MAIN" 'cd "$WT" && vp run test'

# 20b. GIT family, same shape -> QUIET.
run_case quiet 'cd "$WT" && git commit (quoted var, unresolvable)' \
  "$MAIN" 'cd "$WT" && git commit -m x'

# 20c. Also the marker call, which is what section 6 is actually about.
run_case quiet 'cd "$W" && mise exec -- markgate set check' \
  "$MAIN" 'cd "$W" && mise exec -- markgate set check'

# 20d. An UNQUOTED variable resolves to a literal `$WT` path that does
#      not exist, so the directory check makes it quiet by a different
#      route -> QUIET. Pinned so the two mechanisms cannot both be
#      removed at once believing the other covers it.
run_case quiet 'cd $WT && vp run test (unquoted var, nonexistent dir)' \
  "$MAIN" 'cd $WT && vp run test'

# 20e. CONTROL for 20a-20d: identical shape with a RESOLVABLE literal
#      target that IS the main tree still WARNS. Without this, making
#      the hook quiet on every `cd` would pass 20a-20d.
run_case warn  "cd <main-tree> && vp run test (resolvable, is main tree)" \
  "$MAIN" "cd $MAIN && vp run test"

# ---------------------------------------------------------------------
# Scope guards: the evidence-producing set only. Noise is what makes a
# detector get ignored, so read-only commands stay out. Cases 21-23.
# ---------------------------------------------------------------------

# 21. `markgate status` is read-only -> QUIET.
run_case quiet "markgate status in main tree" \
  "$MAIN" 'markgate status'

# 22. Bare `vp run` with no task token -> QUIET.
run_case quiet "bare vp run with no task in main tree" \
  "$MAIN" 'vp run'

# 23. An arbitrary read-only command in the main tree -> QUIET. This is
#     the deliberate coverage LIMIT: the 2026-08-20 run's second
#     violation was a bare `grep` on a relative path, which this hook
#     does not and will not see.
run_case quiet "arbitrary grep in main tree (documented non-coverage)" \
  "$MAIN" 'grep -rn "marker" .claude/skills'

# 24. No feature worktree active -> QUIET even for a bare main-tree commit
#     (no task in flight; ordinary main-tree work governed by branch-gate).
git -C "$MAIN" worktree remove --force "$WT" >/dev/null 2>&1
run_case quiet "bare git commit in main tree, NO feature worktree" \
  "$MAIN" 'git commit -m x'

# 25. Same for a verification command: no task in flight -> QUIET.
run_case quiet "vp run test in main tree, NO feature worktree" \
  "$MAIN" 'vp run test'

# 26. NON-opted-in repo (no .markgate.yml): bare git commit in its main
#     tree with a feature worktree active -> QUIET (issue #1259).
OPTOUT="$TMPDIR/optout"
git init -q -b main "$OPTOUT"
echo "seed" > "$OPTOUT/file.txt"
git -C "$OPTOUT" add -A
git -C "$OPTOUT" -c user.email=t@t -c user.name=t commit -q -m init
OPTOUT="$(cd "$OPTOUT" && pwd -P)"
OWT="$OPTOUT/.claude/worktrees/feat-y"
git -C "$OPTOUT" worktree add -q "$OWT" -b feat/y >/dev/null 2>&1
run_case quiet "bare git commit in non-opted-in repo main tree, worktree active" \
  "$OPTOUT" 'git commit -m x'

# 27. Same for a verification command in a non-opted-in repo -> QUIET.
run_case quiet "vp run test in non-opted-in repo main tree, worktree active" \
  "$OPTOUT" 'vp run test'

echo "----"
echo "passed=$pass failed=$fail"
[[ "$fail" -eq 0 ]]
