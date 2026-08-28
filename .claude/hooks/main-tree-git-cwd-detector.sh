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
# The hook covers THREE families of command, which share that
# mechanism but fail in different ways:
#
#   1. GIT MUTATIONS — `git add` / `git commit` / `git push` /
#      `git rebase` / `git merge` / `git cherry-pick`. The tells are
#      quiet and easy to misread: "nothing to commit", a
#      "non-fast-forward" push, a commit that lands the wrong (or no)
#      files, or a rebase/merge that "fast-forwards" or reports
#      "Already up to date" against the WRONG tree (issue #2363: a
#      mistargeted `git rebase origin/main` in the main tree
#      fast-forwarded silently, harmless only because local `main`
#      held no unique commits) — none of which look like a cwd bug.
#      `git pull` is deliberately NOT in this family: the post-merge
#      sync (/work-issues section 9) runs `git pull` in the MAIN tree
#      as a mandated step, so warning on it would make the detector's
#      common case "ignore this" — the same argument as the
#      `vp run build` exemption below, settled by the verb set rather
#      than by a state predicate.
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
#   3. `gh pr merge` — a MARKER-CONSULTING command (issue #2363). The
#      merge gates resolve the marker store and the
#      `.markgate-pr-review-sha` sentinel from the tree the command
#      runs from, so a main-tree `gh pr merge` is judged against the
#      MAIN tree's markers: a block arrives with a misleading
#      diagnosis (the fresh marker sits in the worktree — the measured
#      incident shape), and a pass would attest to the wrong tree
#      entirely. `gh pr create` is left out: it consults `verify-pr`
#      the same way, but the same session runs it moments after
#      setting the markers, so the mistargeted shape has not been
#      observed there and the family stays minimal.
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
#   3. no `cd` at all -> the hook's reported cwd;
#   4. a `cd` that IS present but does not RESOLVE -> stay SILENT.
#
# Rule 4 is not a detail, it is the difference between a useful
# detector and one people learn to ignore. `cd "$WT" && vp run test` is
# the spelling `/work-issues` section 6 mandates, and a VARIABLE is how
# it gets written in practice — the same shape that defeated
# `pr-review-gate` twice in the run this hook was extended for. The
# quoted span is neutralised to a placeholder before parsing, so the
# target cannot be resolved; falling back to the payload cwd would then
# make the hook assert "this ran in the MAIN worktree" about a command
# that almost certainly did not, on the one spelling we tell everyone
# to use. Absence of a `cd` and an unresolvable `cd` are DIFFERENT
# states and must not collapse into each other.
#
# The honest reason for the silence is that the hook cannot know: it
# has no way to expand `$WT`. Between a false alarm on the mandated
# spelling and a missed warning on a command that already carried the
# right prefix, the false alarm costs more — it trains the reader to
# skip the warning, which disables the hook for the cases it CAN
# decide. (An UNQUOTED `cd $WT` resolves to a literal `$WT` path that
# does not exist, and the `-d` check below already makes that quiet.)
#
# `git -C` is deliberately NOT honoured for the verification family:
# `vp` and `markgate` have no `-C` equivalent, so a compound like
# `git -C <wt> add -A && vp run test` runs the TEST in the cwd
# regardless. Reading the `-C` there would silence the warning — a
# false NEGATIVE, which for a detector is the one unacceptable
# direction, since a missing warning is indistinguishable from nothing
# being wrong.
#
# ── THE `vp run build` EXEMPTION (go-to-k/cdkd#2094) ──────────────────
#
# One main-tree verification command is MANDATED rather than mistaken:
# the post-merge rebuild. `post-merge-sync-reminder.sh` fires after
# every `gh pr merge`, and `/work-issues` section 9 spells the step out
# — `git pull` in the MAIN tree, then `vp run build` there, because the
# artifact other projects consume is the main tree's `dist/`. Before
# this exemption the hook fired on that step every single time, on a
# higher-frequency shape than the `cd "$WT" && …` false positive rule 4
# above was written for. An "ignore this" that applies to a step the
# flow requires is not a caveat, it is the common case, and a detector
# whose common case is "ignore this" is a detector nobody reads.
#
# WHAT WAS MEASURED, because the obvious discriminator does not work.
# The tempting rule is POSITION IN THE FLOW: the post-merge rebuild
# happens on `main`, CLEAN, at `origin/main`, so key on that. Measured
# against this repo mid-lane on 2026-08-27, with six feature worktrees
# live and lane work in flight:
#
#     main tree branch        main
#     git status --porcelain  0 lines (CLEAN)
#     rev-list --count HEAD...origin/main   0 ahead, 1 behind
#
# i.e. the main tree looks IDENTICAL in the dangerous shape, and it has
# to: the whole hazard is that a run against an UNMODIFIED main tree
# passes. The lane's content lives in the worktree, so the main tree is
# clean in both. `at origin/main` fails the other way — it is true for
# long mid-lane stretches (this flow pulls after every merge, while
# sibling lanes stay live), so it would go quiet in exactly the
# post-merge window where other lanes are most exposed. Main-tree git
# state carries NO signal separating the two shapes.
#
# The worktree side does not separate them either. Measured the same
# day: 5 of the 6 live lanes had a CLEAN worktree with 1-2 commits
# ahead of `main`, so "some lane holds UNCOMMITTED work" was false for
# the dangerous shape most of the time, and after a squash merge the
# just-merged lane's branch is still `ahead` of main, so "ahead" does
# not mark it as finished either.
#
# What DOES separate them is the TASK. `vite.config.ts` defines exactly
# one `vp run` task whose product is an ARTIFACT the main tree
# legitimately owns — `build`, whose `dist/` is gitignored and is what
# `/use-cdkd` points another project at. Every other task is one of two
# things that must KEEP warning: it yields a VERDICT about the tree it
# ran in (`test`, `typecheck`, `lint`, `check`, `verify`,
# `format:check`, the `audit:*` family), which is what becomes a FALSE
# GREEN from the wrong tree; or it WRITES TRACKED files there (the
# `gen:*` family), which is the separate main-tree hazard
# `main-tree-edit-gate` / `main-tree-dirty-detector` exist for. So the
# verify half goes quiet only when EVERY verification verb in the
# command is `vp run build`.
#
# "EVERY" is what keeps this from being the blanket "suppress every
# main-tree `vp run build`" the issue rules out — but ONLY for commands
# `VERIFY_VERB` matches. `vp run build && vp run test` — the measured
# 2026-08-20 shape — still warns, as does
# `vp run build && markgate set check`, and the GIT family is untouched
# (`git add -A && vp run build` still warns for its git half). What it
# is NOT is "a build cannot launder a verdict riding along with it";
# see ACCEPTED MISS below for the true boundary.
#
# The state checks are kept as a NARROWING, and are honestly not the
# discriminator: they only ensure the main tree holds nothing of its
# own that a build could be attesting to (on `main`/`master`, clean of
# TRACKED changes, and not AHEAD of `origin/<branch>` — "at, or being
# fast-forwarded to"). A missing `origin/<branch>` ref means the
# position cannot be established, so it WARNS rather than exempting.
# UNTRACKED files are excluded on purpose — the main tree routinely
# carries scratch / log output, and counting it would revive the very
# false positive this exemption removes; see `post_merge_position` for
# the measurement and the sibling hook it copies. Measured: `dist/` is
# gitignored, so a completed build leaves the tree clean and this
# predicate still holds when the hook evaluates it (PostToolUse runs
# AFTER the command).
#
# ACCEPTED MISS — a BOUNDARY, not the single example an earlier
# revision of this header conceded. The exemption drops the verify
# warning for ANY command riding along that `VERIFY_VERB` does not
# match, the SAME call included. The verb set is `vp run <task>` /
# `vp test run <path>` / `markgate set|verify`, so anything spelled
# outside it rides quietly. Measured 2026-08-27 against a fixture main
# tree in post-merge position, pre-change hook -> this one, all five
# warn -> quiet in ONE call:
#
#     vp run build && node dist/cli.js deploy
#     vp run build && npx vitest run
#     vp run build && pnpm test
#     vp run build && ./scripts/verify.sh
#     vp run build && eval "vp run test"
#
# What is lost is INCIDENTAL coverage, and the same measurement shows
# it: each of those riding commands run ALONE is quiet under BOTH hooks
# (`node dist/cli.js deploy` and `npx vitest run` were checked), so
# none was ever DETECTED as a verification command — the pre-change
# warning came from the adjacent `vp run build` token, not from the
# riding command. The cross-call shape is the same loss: a rebuild,
# then a `node dist/cli.js` live test in a SEPARATE call, loses its
# warning at the build step.
#
# This is deliberately NOT closed by widening `VERIFY_VERB` to cover
# `node` / `npx` / `pnpm` / a script path. That is a different change
# with its own false-positive surface, and it does not belong in a lane
# whose whole purpose is REMOVING a false positive. Per this hook's
# standing trade, a missed warning is the status quo ante while a false
# alarm on a mandated step disables the detector wholesale. All five
# spellings are pinned as QUIET cases in the suite, so the concession
# is FENCED rather than merely written down: widening the verb set
# later must reckon with them explicitly.
#
# ── KNOWN GAP: what moving to the shared matcher COST ─────────────────
#
# This hook used to match with its own inline ERE anchored at
# `(^|[&;|(])`. The shared `lib/command-match.sh` anchors at
# `(^|[|;&][[:space:]]*)` — no `(` — so moving to it LOST subshell and
# command-substitution positions. Measured old -> new, all warn ->
# quiet:
#
#     (git commit -m x)
#     true && (git commit -m x)
#     out=$(git commit -m x)
#
# It also inherits the shared matcher's unbalanced-apostrophe limit:
# `echo don't; git commit -m y` goes warn -> quiet, because the lone
# apostrophe opens a quoted span that swallows the rest.
#
# This is a REGRESSION for this hook, not parity, and it is recorded
# rather than papered over. It is accepted here because the loss is
# shared with 17 other hooks — several of them BLOCKING gates, where
# the same gap is a `check-gate` bypass rather than a missed warning —
# so the fix belongs in the library, under its own review and its own
# test round, not in this hook's local ERE. Widening the shared matcher
# changes what all 17 match at once. Tracked as its own issue; see the
# `main-tree-git-cwd-detector` entry in `.claude/rules/hooks.md`.
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
  || ! declare -F gate_segments >/dev/null 2>&1 \
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
# `rebase` / `merge` / `cherry-pick` joined for issue #2363 —
# continuation forms (`rebase --continue` / `--abort`) match too, on
# purpose: mistargeted, they error with "No rebase in progress", a tell
# as misreadable as "nothing to commit". `pull` is deliberately absent
# (the mandated post-merge main-tree sync — see the header).
GIT_VERB='git([[:space:]]+-[^[:space:]]+)*[[:space:]]+(commit|add|push|rebase|merge|cherry-pick)([[:space:]]|$|[|;&])'

# Family 2: verification commands whose verdict is taken as evidence.
#
# The optional `mise exec [args] -- ` prefix is not an optional nicety:
# this repo pins BOTH `vp` and `markgate` through mise, and
# `work-issues/references/gates-and-pr.md` instructs agents to invoke them that way, so a
# matcher seeing only the bare binaries would miss the real-world shape
# entirely. It applies to BOTH binaries — an earlier revision honoured
# it for `markgate` only, and that asymmetry would have gone quiet on
# exactly the `mise exec -- vp run test` the skill tells people to
# write. A literal `--` is required, so `mise exec -- echo vp run test`
# does not match on the `echo`'s arguments.
#
# `npx` / `pnpm exec` are deliberately NOT honoured: this repo pins
# `vp` via mise and those spellings do not appear in it, so adding them
# buys nothing and widens the surface. The failure direction of that
# choice is a MISS, i.e. the status quo before this hook existed.
#
# `vp run <task>` requires a task token, so a bare `vp run` (which does
# nothing) does not arm it. `vp test run <path>` is the form
# vp-run-test-path-gate steers callers to, so it must be covered too or
# the steer would move traffic OUT of this detector's view.
# `markgate status` is read-only and stays out.
RUNNER_PFX='(mise[[:space:]]+exec[[:space:]]+([^[:space:]]+[[:space:]]+)*--[[:space:]]+)?'
VERIFY_VERB="${RUNNER_PFX}"'(vp[[:space:]]+run[[:space:]]+[^[:space:]]|vp[[:space:]]+test[[:space:]]+run([[:space:]]|$|[|;&])|markgate[[:space:]]+(set|verify)([[:space:]]|$|[|;&]))'

# Family 3: `gh pr merge` (issue #2363). Same flag-token shape as
# GIT_VERB, with the same accepted gap: a flag VALUE (`gh -R <repo> pr
# merge`) breaks the match, a missed warning in a hook that only
# informs. gh has no `-C`, so there is no `-C` handling to consider.
GH_PR_MERGE_VERB='gh([[:space:]]+-[^[:space:]]+)*[[:space:]]+pr[[:space:]]+merge([[:space:]]|$|[|;&])'

# Cheap literal pre-filter before the shared matcher. This hook is a
# PostToolUse `Bash` hook with no `if:` condition, so it runs on EVERY
# Bash call, and `cmd_matches_verb` costs an awk pass over the whole
# command (twice here, plus twice more for the cd resolution). The
# filter is strictly BROADER than every ERE below — every command
# matching them contains one of these literals — so it can only skip
# commands the matcher would also have rejected.
printf '%s' "$cmd" | grep -qE 'git|vp|markgate|gh' || exit 0

git_hit=0
verify_hit=0
ghpr_hit=0
# The shared matcher neutralises heredoc bodies and quoted spans first,
# then requires COMMAND POSITION — so a commit message or PR body that
# quotes `vp run test` does not fire (this repo's own commit messages
# routinely describe the commands they are about).
cmd_matches_verb "$cmd" "$GIT_VERB" && git_hit=1
cmd_matches_verb "$cmd" "$VERIFY_VERB" && verify_hit=1
cmd_matches_verb "$cmd" "$GH_PR_MERGE_VERB" && ghpr_hit=1
[[ "$git_hit" == 1 || "$verify_hit" == 1 || "$ghpr_hit" == 1 ]] || exit 0

hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
base="${hook_cwd:-$PWD}"

# --------------------------------------------------------- effective dirs
#
# has_cd_before_verb <cmd> <verb-ere> — succeeds when a `cd` appears in
# command position before the verb, INCLUDING one whose path was
# entirely quoted. `cmd_last_cd_target` deliberately skips that case
# (it cannot resolve a placeholder) and returns an empty string, which
# is indistinguishable from "there was no cd at all". This mirrors its
# scan to tell those two states apart; see rule 4 in the header for why
# they must not collapse.
has_cd_before_verb() {
  strip_noncommand_spans "$1" | awk -v verb="$2" '
    {
      n = split($0, seg, /[|;&]+/)
      for (k = 1; k <= n; k++) {
        s = seg[k]
        sub(/^[ \t]+/, "", s)
        if (verb != "" && s ~ verb) { stop = 1; break }
        if (s ~ /^cd([ \t]|$)/) { found = 1 }
      }
      if (stop) exit
    }
    END { exit(found ? 0 : 1) }
  '
}

# verify_is_build_only <cmd> — succeeds when at least one verification
# verb is present in command position and EVERY one of them is
# `vp run build`. See the `vp run build` EXEMPTION section in the
# header for why the task name is the discriminator and why "every" is
# load-bearing.
#
# Segment-wise rather than one more ERE, because the question is "is
# this token exactly `build`?" and an ERE can only spell that as a
# negation of a word, which fails OPEN on near-misses: the natural
# `build[^…]|b[^u]|bu[^i]|…` expansion reads `vp run buil` and
# `vp run b` as builds. Exact comparison per segment gets those right
# (measured: both classify as non-build, i.e. still warn).
verify_is_build_only() {
  local segment saw_build=0
  while IFS= read -r segment; do
    # Peel the same optional `mise exec [args] -- ` prefix RUNNER_PFX
    # honours, so the spelling the skills actually tell agents to write
    # classifies identically to the bare one.
    if [[ "$segment" =~ ^mise[[:space:]]+exec[[:space:]]+([^[:space:]]+[[:space:]]+)*--[[:space:]]+(.+)$ ]]; then
      segment="${BASH_REMATCH[2]}"
    fi
    if [[ "$segment" =~ ^vp[[:space:]]+run[[:space:]]+build([[:space:]]|$) ]]; then
      saw_build=1
      continue
    fi
    if [[ "$segment" =~ ^(vp[[:space:]]+run[[:space:]]+[^[:space:]]|vp[[:space:]]+test[[:space:]]+run([[:space:]]|$)|markgate[[:space:]]+(set|verify)([[:space:]]|$)) ]]; then
      return 1
    fi
  done < <(gate_segments "$1")
  [ "$saw_build" = 1 ]
}

eff_git="$base"
if [[ "$git_hit" == 1 ]]; then
  # There is deliberately NO `git -C <dir>` handling here, and that is a
  # narrowing of this hook, not an oversight (go-to-k/cdkd#2027). It used to
  # carry the same hand-rolled `-C` scan the twelve BLOCKING gates carried, and
  # in this hook the scan was UNREACHABLE: `GIT_VERB` requires every token
  # between `git` and the verb to start with `-`, so the `-C` VALUE breaks the
  # match and `git -C <path> commit` never reaches this block at all. Measured:
  #
  #   MATCH    git commit -m x
  #   nomatch  git -C /tmp/x commit -m x
  #   nomatch  git -C "$W" commit -m x
  #
  # So the branch could never fire, and removing it changes no behaviour. What
  # remains is a real but SEPARATE gap -- this detector does not warn about the
  # `git -C <main-tree> commit` shape at all -- which is a missed warning in a
  # hook that only informs, the smaller harm its header already chooses. Fixing
  # it means widening GIT_VERB, i.e. changing what the detector fires on, which
  # is not what the #2027 fail-closed sweep is about.
  cdt="$(cmd_last_cd_target "$cmd" "$base" "$GIT_VERB")"
  if [[ -n "$cdt" ]]; then
    eff_git="$cdt"
  elif has_cd_before_verb "$cmd" "$GIT_VERB"; then
    # A `cd` we cannot resolve: stay silent rather than assert the cwd
    # (header rule 4).
    git_hit=0
  fi
fi

eff_verify="$base"
if [[ "$verify_hit" == 1 ]]; then
  cdt="$(cmd_last_cd_target "$cmd" "$base" "$VERIFY_VERB")"
  if [[ -n "$cdt" ]]; then
    eff_verify="$cdt"
  elif has_cd_before_verb "$cmd" "$VERIFY_VERB"; then
    verify_hit=0
  fi
fi

eff_ghpr="$base"
if [[ "$ghpr_hit" == 1 ]]; then
  cdt="$(cmd_last_cd_target "$cmd" "$base" "$GH_PR_MERGE_VERB")"
  if [[ -n "$cdt" ]]; then
    eff_ghpr="$cdt"
  elif has_cd_before_verb "$cmd" "$GH_PR_MERGE_VERB"; then
    ghpr_hit=0
  fi
fi

[[ "$git_hit" == 1 || "$verify_hit" == 1 || "$ghpr_hit" == 1 ]] || exit 0

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
  mt=$(git -C "$d" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0, 10); exit}')
  [[ -n "$mt" ]] || return 1
  top=$(canon "$top")
  mt=$(canon "$mt")
  [[ -f "$mt/.markgate.yml" ]] || return 1
  [[ "$top" == "$mt" ]] || return 1
  MAIN_TREE="$mt"
  return 0
}

# post_merge_position <main-tree> — succeeds when the main tree holds
# nothing of its own that a build there could be wrongly attesting to:
# on `main`/`master`, clean of TRACKED changes, and not AHEAD of its
# `origin/<branch>` ("at, or being fast-forwarded to", the post-merge
# state). This is a NARROWING of the exemption, not the discriminator —
# see the header: the same three properties hold mid-lane, which is
# measured and is why the task name carries the decision. A missing
# remote-tracking ref means the position cannot be established, so it
# does NOT exempt.
#
# "clean" means clean of TRACKED changes, and the `^??` filter is
# load-bearing rather than tidiness. A bare `git status --porcelain`
# lists untracked files too, and the main tree routinely carries
# untracked scratch / log output, so keying on it would flip the
# MANDATED post-merge rebuild back to WARN on a single stray file —
# reviving the exact false positive this exemption exists to remove
# (measured 2026-08-27: one `?? scratch.log` was enough). The sibling
# `main-tree-dirty-detector.sh` already strips `^??` for the same
# reason and says so at its own `dirty=` line; ignored files never
# appear in `--porcelain` at all, so `dist/` is out either way. Both
# directions are pinned in the suite (untracked-only stays quiet, a
# dirty TRACKED file still warns) so neither half can rot.
#
# Only reached on a command already known to be armed, main-tree-bound
# and concurrent with a live worktree, so its `git` calls are off the
# every-Bash-call path this hook otherwise stays clear of.
post_merge_position() {
  local mt="$1" br
  br=$(git -C "$mt" symbolic-ref --quiet --short HEAD 2>/dev/null) || return 1
  [[ "$br" == "main" || "$br" == "master" ]] || return 1
  [ -z "$(git -C "$mt" status --porcelain 2>/dev/null | grep -vE '^\?\?')" ] || return 1
  git -C "$mt" rev-parse --verify --quiet "refs/remotes/origin/$br" >/dev/null 2>&1 || return 1
  [ "$(git -C "$mt" rev-list --count "refs/remotes/origin/$br..HEAD" 2>/dev/null)" = "0" ] || return 1
  return 0
}

warn_git=0
warn_verify=0
warn_ghpr=0
main_tree=""
if [[ "$git_hit" == 1 ]] && in_main_tree "$eff_git"; then
  warn_git=1
  main_tree="$MAIN_TREE"
fi
if [[ "$verify_hit" == 1 ]] && in_main_tree "$eff_verify"; then
  warn_verify=1
  main_tree="$MAIN_TREE"
fi
if [[ "$ghpr_hit" == 1 ]] && in_main_tree "$eff_ghpr"; then
  warn_ghpr=1
  main_tree="$MAIN_TREE"
fi
[[ "$warn_git" == 1 || "$warn_verify" == 1 || "$warn_ghpr" == 1 ]] || exit 0

# ...AND a feature worktree is currently active (a task is in flight).
# `.claude/worktrees/<branch>/` is the sanctioned location; if none
# exist, a main-tree command is just ordinary main-tree work and the
# branch-gate already governs the git half — stay quiet.
feature_wts=$(git -C "$main_tree" worktree list --porcelain 2>/dev/null \
  | awk '/^worktree /{print substr($0, 10)}' \
  | grep -F "$main_tree/.claude/worktrees/" || true)
[[ -n "$feature_wts" ]] || exit 0

# The MANDATED post-merge rebuild (go-to-k/cdkd#2094). Drops only the
# VERIFY half — a git mutation or a `gh pr merge` riding along keeps
# its own warning.
if [[ "$warn_verify" == 1 ]] \
  && verify_is_build_only "$cmd" \
  && post_merge_position "$main_tree"; then
  warn_verify=0
  [[ "$warn_git" == 1 || "$warn_ghpr" == 1 ]] || exit 0
fi

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
  msg+="THE COMMAND WAS A GIT MUTATION (\`git add\`/\`commit\`/\`push\`/\`rebase\`/\`merge\`/\`cherry-pick\`). "
  msg+="A \"nothing to commit\", a \"non-fast-forward\" push, a commit that captured the wrong/no files, a rebase/merge that \"fast-forwarded\" or said \"Already up to date\", or a \"No rebase in progress\" here is almost certainly THAT, not real git state. "
  msg+="Verify: (1) did the edit you intended actually land in the feature worktree? (2) re-run the git op prefixed with \`git -C <feature-worktree>\` (the cwd-race-proof form), NOT a bare git from the main-tree cwd. "
fi

if [[ "$warn_ghpr" == 1 ]]; then
  msg+="THE COMMAND WAS \`gh pr merge\`, a MARKER-CONSULTING command: the merge gates resolve the markgate marker store and the \`.markgate-pr-review-sha\` sentinel from the tree the command runs from, so from here they read the MAIN tree's markers — a block arrives with a MISLEADING diagnosis (the fresh marker sits in the worktree), and a pass would attest to the wrong tree entirely. "
  msg+="Do NOT chase the gate's stated reason from here. Re-run it from the lane that set the markers: \`cd $first_wt && <the same gh pr merge command>\`. "
fi

msg+="If you genuinely meant to operate on the main tree, ignore this — but the branch-gate will still block a commit/push on \`main\`/\`master\`."

ctx=$(printf '%s' "$msg" | jq -Rs .)
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":%s}}\n' "$ctx"
exit 0
