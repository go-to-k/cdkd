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
# Mirror the real repo's ignore of the worktree root (`.gitignore:49`).
# Without it the nested worktree shows as untracked and the main tree is
# never CLEAN, which would make every post-merge case (issue #2094) pass
# for the wrong reason.
printf '.claude/worktrees/\n' > "$MAIN/.gitignore"
git -C "$MAIN" add -A
git -C "$MAIN" -c user.email=t@t -c user.name=t commit -q -m init
# A remote-tracking ref for `main`, written directly (no network), so
# the post-merge-position predicate has something to compare HEAD
# against. Cases that need the opposite polarity move or delete it.
git -C "$MAIN" update-ref refs/remotes/origin/main HEAD

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

# 9. A verdict-producing task in the main tree, feature worktree active
#    -> WARN. This case used to be `vp run build`; that command is now
#    the MANDATED post-merge rebuild and is covered by the #2094 block
#    below, so the general "a verification command in the main tree
#    warns" property is pinned on a task that is unambiguously a
#    verdict.
run_case warn  "vp run test in main tree, feature worktree active" \
  "$MAIN" 'vp run test'

# 9b. Same for another verdict task, so the WARN side does not rest on
#     the single token `test`.
run_case warn  "vp run typecheck in main tree, feature worktree active" \
  "$MAIN" 'vp run typecheck'

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
#      only `markgate` — work-issues/references/gates-and-pr.md tells agents to invoke vp
#      that way -> WARN.
run_case warn  "mise exec -- vp run test in main tree" \
  "$MAIN" 'mise exec -- vp run test'

# 19c. `mise exec <tool> -- vp run <task>` (a tool token before `--`).
#      Uses a verdict task: the `build` spelling of this same shape is
#      the #2094 exemption and is pinned QUIET below, so keeping `build`
#      here would have turned a matcher case into an exemption case.
run_case warn  "mise exec node@24 -- vp run typecheck in main tree" \
  "$MAIN" 'mise exec node@24 -- vp run typecheck'

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

# ---------------------------------------------------------------------
# The MANDATED post-merge rebuild (issue #2094). `post-merge-sync-
# reminder.sh` fires after every `gh pr merge` and `/work-issues`
# section 9 spells out a `vp run build` in the MAIN tree, so before the
# exemption this detector fired on a routine step every single time.
#
# BOTH directions are pinned here on purpose. A one-sided fence that
# only asserts the quiet case is satisfied by a detector that warns
# about nothing; one that only asserts the warn case never notices the
# exemption widening. Cases 28a-28h are the quiet side (each FAILS
# against the pre-change hook), 29a-29i the warn side (each PASSES
# against both, so they fence the exemption rather than the fix).
# ---------------------------------------------------------------------

# 28a. The exact reported shape: a bare `vp run build` in a main tree
#      that is on `main`, clean, and at `origin/main` -> QUIET.
run_case quiet "vp run build in post-merge main tree" \
  "$MAIN" 'vp run build'

# 28b. The `mise exec -- ` spelling the skills tell agents to write must
#      classify identically, or the exemption would depend on which of
#      two sanctioned spellings was used -> QUIET.
run_case quiet "mise exec -- vp run build in post-merge main tree" \
  "$MAIN" 'mise exec -- vp run build'

# 28c. ...including with a tool token before the `--`.
run_case quiet "mise exec node@24 -- vp run build in post-merge main tree" \
  "$MAIN" 'mise exec node@24 -- vp run build'

# 28d. The literal mandated sequence. `pull` is not in GIT_VERB, so the
#      git half never arms and only the verify half is in question.
run_case quiet "git pull --ff-only origin main && vp run build" \
  "$MAIN" 'git pull --ff-only origin main && vp run build'

# 28e. Spelled with an explicit `cd` to the main tree — the deliberate
#      form. Note case 20e pins the SAME shape with `vp run test` as a
#      WARN, so this pair isolates the task name as the discriminator.
run_case quiet "cd <main-tree> && vp run build" \
  "$MAIN" "cd $MAIN && vp run build"

# 28f. Task ARGUMENTS do not change the task -> QUIET.
run_case quiet "vp run build --silent in post-merge main tree" \
  "$MAIN" 'vp run build --silent'

# 28g. Extra whitespace is the same command -> QUIET.
run_case quiet "vp  run  build (extra whitespace)" \
  "$MAIN" 'vp  run  build'

# 28h. A main-tree path containing a SPACE, reached through a quoted
#      `cd`. The exemption reads git state out of the resolved path, so
#      a path the resolver mangles would silently fall back to warning.
MAINSP="$TMPDIR/main sp"
git init -q -b main "$MAINSP"
echo "seed" > "$MAINSP/file.txt"
touch "$MAINSP/.markgate.yml"
printf '.claude/worktrees/\n' > "$MAINSP/.gitignore"
git -C "$MAINSP" add -A
git -C "$MAINSP" -c user.email=t@t -c user.name=t commit -q -m init
git -C "$MAINSP" update-ref refs/remotes/origin/main HEAD
MAINSP="$(cd "$MAINSP" && pwd -P)"
git -C "$MAINSP" worktree add -q "$MAINSP/.claude/worktrees/feat-z" -b feat/z >/dev/null 2>&1
run_case quiet "cd \"<main tree with space>\" && vp run build" \
  "$TMPDIR" "cd \"$MAINSP\" && vp run build"
# ...and its control: the same quoted path with a verdict task WARNS,
# so the case above cannot pass merely because the path was unresolved.
run_case warn  "cd \"<main tree with space>\" && vp run test (control)" \
  "$TMPDIR" "cd \"$MAINSP\" && vp run test"

# 29a. A build cannot LAUNDER a verdict riding in the same command.
#      This is what separates the exemption from the blanket "suppress
#      every main-tree `vp run build`" the issue rules out. Case 10
#      already pins the `vp run test` spelling of this (it is the
#      measured 2026-08-20 shape); this one uses `vp test run <path>`,
#      the form vp-run-test-path-gate steers callers to, so the two are
#      not one command written twice.
run_case warn  "vp run build && vp test run <path> in post-merge main tree" \
  "$MAIN" 'vp run build && vp test run tests/unit/cli/version.test.ts'

# 29b. Same for a marker call riding along.
run_case warn  "vp run build && mise exec -- markgate set check" \
  "$MAIN" 'vp run build && mise exec -- markgate set check'

# 29c. The GIT family is untouched by the exemption: the git half keeps
#      its own warning even though the verify half is dropped.
run_case warn  "git add -A && vp run build in post-merge main tree" \
  "$MAIN" 'git add -A && vp run build'

# 29d. A near-miss task name is NOT `build`. An ERE spelled as "a word
#      that is not build" fails open on these; the exact-token
#      comparison does not.
run_case warn  "vp run build:docs in post-merge main tree" \
  "$MAIN" 'vp run build:docs'

# 29e. ...and a task whose name merely STARTS with build.
run_case warn  "vp run buildx in post-merge main tree" \
  "$MAIN" 'vp run buildx'

# 29f. State arm: a DIRTY main tree holds content of its own that a
#      build there could be attesting to -> WARN. This is the TRACKED
#      half of a pair; 29f-b below is its untracked twin and the two
#      must stay together, because each alone is a one-sided fence: 29f
#      alone is satisfied by a predicate that counts untracked files
#      (the #2094 false positive, revived), and 29f-b alone by a
#      predicate that has stopped looking at the tree at all.
echo "lane edit" >> "$MAIN/file.txt"
run_case warn  "vp run build while the main tree is DIRTY (tracked)" \
  "$MAIN" 'vp run build'
echo "seed" > "$MAIN/file.txt"

# 29f-b. ...and the untracked half: a main tree carrying ONLY untracked
#      files is still in the post-merge position -> QUIET. The main
#      tree routinely holds scratch / log output, so a bare
#      `git status --porcelain` here would flip the MANDATED rebuild
#      back to WARN on one stray file. Measured against the pre-filter
#      predicate: a single `?? scratch.log` was enough.
echo "scratch" > "$MAIN/scratch.log"
run_case quiet "vp run build while the main tree has ONLY untracked files" \
  "$MAIN" 'vp run build'
rm -f "$MAIN/scratch.log"

# 29g. State arm: local `main` AHEAD of `origin/main` is not the
#      post-merge position -> WARN.
MAIN_BASE="$(git -C "$MAIN" rev-parse HEAD)"
echo "local" > "$MAIN/local.txt"
git -C "$MAIN" add -A
git -C "$MAIN" -c user.email=t@t -c user.name=t commit -q -m local
run_case warn  "vp run build while main is AHEAD of origin/main" \
  "$MAIN" 'vp run build'
git -C "$MAIN" reset -q --hard "$MAIN_BASE"
rm -f "$MAIN/local.txt"

# 29h. State arm: no `origin/<branch>` ref at all means the position
#      cannot be ESTABLISHED, and an unestablished position must not
#      exempt -> WARN.
git -C "$MAIN" update-ref -d refs/remotes/origin/main
run_case warn  "vp run build with no origin/main ref" \
  "$MAIN" 'vp run build'
git -C "$MAIN" update-ref refs/remotes/origin/main HEAD

# 29i. State arm: the main tree checked out to something other than
#      `main`/`master` -> WARN.
git -C "$MAIN" checkout -q -b side
run_case warn  "vp run build while the main tree is on a side branch" \
  "$MAIN" 'vp run build'
git -C "$MAIN" checkout -q main
git -C "$MAIN" branch -q -D side

# 29k-29o. The ACCEPTED MISS, FENCED rather than merely written down.
#      The exemption drops the verify warning for ANY riding command
#      `VERIFY_VERB` does not match -- the SAME call included, not just
#      the separate-call `node dist/cli.js` shape an earlier revision
#      conceded. These five are pinned QUIET because that is the
#      DOCUMENTED LOSS, not an oversight: none of them was ever
#      detected as a verification command (each is quiet under the
#      PRE-change hook too when run alone), so what the exemption
#      removed is the INCIDENTAL coverage the adjacent `vp run build`
#      token was giving them. Closing this means widening `VERIFY_VERB`
#      to `node` / `npx` / `pnpm` / a script path, which carries its
#      own false-positive surface and is a different change; whoever
#      makes it has to flip these cases deliberately, which is the
#      point of pinning them.
run_case quiet "vp run build && node dist/cli.js (riding, unmatched verb)" \
  "$MAIN" 'vp run build && node dist/cli.js deploy'
run_case quiet "vp run build && npx vitest run (riding, unmatched verb)" \
  "$MAIN" 'vp run build && npx vitest run'
run_case quiet "vp run build && pnpm test (riding, unmatched verb)" \
  "$MAIN" 'vp run build && pnpm test'
run_case quiet "vp run build && ./scripts/verify.sh (riding, unmatched verb)" \
  "$MAIN" 'vp run build && ./scripts/verify.sh'
# `eval` hides the verb inside a quoted span, so the shared matcher
# never sees it in command position -- the same loss reached by a
# different route, and the one spelling that could be mistaken for a
# gap in `verify_is_build_only` rather than in the verb set.
run_case quiet "vp run build && eval \"vp run test\" (riding, hidden by eval)" \
  "$MAIN" 'vp run build && eval "vp run test"'

# 29j. Regression control for the whole block: with the main tree back
#      in the post-merge position, 28a's verdict must be reproducible.
#      Without it a mutation case that forgot to restore would leave
#      every later case testing a different fixture.
run_case quiet "vp run build in post-merge main tree (after state arms)" \
  "$MAIN" 'vp run build'

# ---------------------------------------------------------------------
# GIT-family widening (issue #2363): `rebase` / `merge` / `cherry-pick`
# are the same cwd-race signature as a bare `git commit` — the measured
# incident was `git rebase origin/main` running in the main tree and
# fast-forwarding silently. `git pull` must stay OUT: it is the
# mandated post-merge main-tree sync. Cases 30a-30h.
# ---------------------------------------------------------------------

# 30a. The incident shape itself -> WARN.
run_case warn  "git rebase origin/main in main tree" \
  "$MAIN" 'git rebase origin/main'

# 30b. A continuation form -> WARN (mistargeted, it errors with "No
#      rebase in progress" — a tell as misreadable as "nothing to
#      commit").
run_case warn  "git rebase --continue in main tree" \
  "$MAIN" 'git rebase --continue'

# 30c. `git merge` -> WARN (a mistargeted merge fast-forwards main as
#      silently as the incident's rebase did). This spelling includes the
#      alternative main-tree sync `git merge --ff-only origin/main`, and
#      warning on it is ACCEPTED, not an oversight: the hook header's
#      measurement shows main-tree git state cannot separate a deliberate
#      sync from a lane's mistargeted one (both happen on a clean main at
#      origin/main), and the sync spelling the flow actually mandates is
#      `git pull` (30e), which stays quiet.
run_case warn  "git merge --ff-only origin/main in main tree" \
  "$MAIN" 'git merge --ff-only origin/main'

# 30c-b/30c-c. Hyphenated READ-ONLY siblings of the new verbs stay out:
#      `git merge-base` is ship.md's flatten step and `git merge-tree` is
#      verify-pr's conflict probe, both run in the main tree routinely.
#      These pin the verb-boundary class (`merge([[:space:]]...)`) that
#      keeps `merge-base` / `merge-tree` / `cherry-pick`'s hyphen rules
#      consistent.
run_case quiet "git merge-base origin/main HEAD in main tree" \
  "$MAIN" 'git merge-base origin/main HEAD'
run_case quiet "git merge-tree HEAD origin/main in main tree" \
  "$MAIN" 'git merge-tree HEAD origin/main'

# 30d. `git cherry-pick` -> WARN.
run_case warn  "git cherry-pick <sha> in main tree" \
  "$MAIN" 'git cherry-pick abc1234'

# 30e. CONTROL: `git pull` stays QUIET — it is the mandated post-merge
#      sync step in the MAIN tree (/work-issues section 9), so adding
#      it to the family would make the detector's common case "ignore
#      this". The `pull` token must never join GIT_VERB.
run_case quiet "git pull in main tree (mandated post-merge sync)" \
  "$MAIN" 'git pull'

# 30f. The sanctioned spelling -> QUIET (cd redirects to the worktree).
run_case quiet "cd <worktree> && git rebase origin/main" \
  "$MAIN" "cd $WT && git rebase origin/main"

# 30g. From the worktree cwd -> QUIET (already in the right tree).
run_case quiet "git rebase origin/main from feature-worktree cwd" \
  "$WT" 'git rebase origin/main'

# 30h. Quoted mention -> QUIET (command-position matcher). The `&&`
#      inside the quotes puts the verb in command position in the RAW
#      text, so this discriminates the stripper.
run_case quiet "echo containing '&& git rebase origin/main' string" \
  "$MAIN" 'echo "then && git rebase origin/main"'

# ---------------------------------------------------------------------
# `gh pr merge` family (issue #2363): a marker-consulting command whose
# gate verdicts are computed against the tree it runs from. The
# incident: a main-tree `gh pr merge` made pr-review-gate read the MAIN
# tree's stale `.markgate-pr-review-sha` and block with a misleading
# "mismatch" while the fresh marker sat in the worktree. Cases 31a-31g.
# ---------------------------------------------------------------------

# 31a. `gh pr merge` from the main tree, worktree active -> WARN.
run_case warn  "gh pr merge in main tree" \
  "$MAIN" 'gh pr merge 123 --squash --delete-branch'

# 31b. The sanctioned spelling -> QUIET.
run_case quiet "cd <worktree> && gh pr merge" \
  "$MAIN" "cd $WT && gh pr merge 123 --squash"

# 31c. From the worktree cwd -> QUIET.
run_case quiet "gh pr merge from feature-worktree cwd" \
  "$WT" 'gh pr merge 123 --squash'

# 31d. Non-merge gh subcommands are NOT marker-consulting -> QUIET.
#      This pins the family to `pr merge` alone.
run_case quiet "gh pr checks in main tree (non-merge gh)" \
  "$MAIN" 'gh pr checks 123 --watch'

# 31e. Quoted mention -> QUIET (with the `&&` that makes the case
#      discriminate the stripper).
run_case quiet "echo containing '&& gh pr merge 5' string" \
  "$MAIN" 'echo "wait && gh pr merge 5"'

# 31f. The #2094 build exemption must not LAUNDER the gh half: a
#      `vp run build && gh pr merge` in the post-merge position drops
#      the verify warning and keeps the gh one -> WARN.
run_case warn  "vp run build && gh pr merge in post-merge main tree" \
  "$MAIN" 'vp run build && gh pr merge 123 --squash'

# 31g. Unresolvable `cd` before the verb -> QUIET (header rule 4, same
#      as both other families; case 20e is the resolvable control).
run_case quiet 'cd "$W" && gh pr merge (quoted var, unresolvable)' \
  "$MAIN" 'cd "$W" && gh pr merge 123'

# 24. No feature worktree active -> QUIET even for a bare main-tree commit
#     (no task in flight; ordinary main-tree work governed by branch-gate).
git -C "$MAIN" worktree remove --force "$WT" >/dev/null 2>&1
run_case quiet "bare git commit in main tree, NO feature worktree" \
  "$MAIN" 'git commit -m x'

# 25. Same for a verification command: no task in flight -> QUIET.
run_case quiet "vp run test in main tree, NO feature worktree" \
  "$MAIN" 'vp run test'

# 25b. Same for the gh family: no task in flight -> QUIET (ordinary
#      main-tree merges are the single-writer default).
run_case quiet "gh pr merge in main tree, NO feature worktree" \
  "$MAIN" 'gh pr merge 123 --squash'

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
