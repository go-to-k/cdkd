#!/usr/bin/env bash
# verify-pr-gate.sh
#
# PreToolUse hook. Blocks `gh pr create` and `gh pr merge` (including
# --auto) unless the `verify-pr` markgate marker is fresh for the
# current content state. The gate's scope (see .markgate.yml) covers
# every code/test/doc path the /verify-pr skill inspects, so editing
# any of them invalidates the marker and forces a successful
# /verify-pr run before the PR can be opened or merged.
#
# This is the structural enforcement of the "PR readiness checklist"
# rule: live-test the changed behavior, walk all shared-utility
# callers, refresh PR title + body, and run the session retrospective
# (proposing new rules/hooks/skills for recurring patterns) BEFORE
# `gh pr create` / `gh pr merge`. The skill said it; the hook
# enforces it.
#
# WHY the cwd-aware resolution matters (cdkd #559): this repo is
# regularly worked in via `git worktree`, and markgate stores marker
# state per-worktree at `<git rev-parse --absolute-git-dir>/markgate/`.
# The pre-#559 implementation derived REPO from `BASH_SOURCE` and
# always landed on the main working tree, defeating markgate's
# per-worktree isolation and forcing every parallel agent to converge
# on the main tree's view (see memory rule
# feedback_cross_agent_main_tree_contention.md). We now resolve the
# target working tree from the PreToolUse payload's `cwd` field +
# leading `cd <path>` + last `gh -C <path>` flag.

# Shared command-position matcher (issue #1455): catches the guarded verb
# after ANY chained command (`git push && gh pr create`), not just after an
# optional leading `cd`. See .claude/hooks/lib/command-match.sh.
# shellcheck source=lib/command-match.sh
__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked as
# `bash verify-pr-gate.sh` from inside the hooks dir), which would look for
# `<script-name>/lib/...`. Fall back to the cwd in that case.
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."
if ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null \
  || ! declare -F cmd_matches_verb >/dev/null \
  || ! declare -F gate_matches >/dev/null \
  || ! declare -F gate_target_dir_strict >/dev/null \
  || ! declare -F gate_refuse_unresolved_target >/dev/null \
  || ! declare -F cmd_last_cd_target >/dev/null \
  || ! declare -F gate_segments >/dev/null \
  || ! declare -F gate_segments_raw >/dev/null \
  || ! declare -F gate_verb_span >/dev/null \
  || ! declare -F gate_argv >/dev/null \
  || ! declare -F gate_word_is_literal >/dev/null \
  || ! declare -F strip_noncommand_spans >/dev/null; then
  # FAIL CLOSED. Without the helper `cmd_matches_verb` is undefined, the
  # `if ! cmd_matches_verb ...` guard below sees exit 127 (truthy for `!`),
  # and the hook would `exit 0` -- silently disabling the gate, which is the
  # exact failure mode this file exists to prevent. Refuse instead.
  echo "Blocked: .claude/hooks/lib/command-match.sh is missing or unloadable," >&2
  echo "so this gate cannot evaluate the command. Restore the file; do not" >&2
  echo "work around the gate." >&2
  exit 2
fi

# go-to-k/cdkd#2729: the load guard above covers the FUNCTIONS this hook calls
# and CANNOT see a missing CONSTANT. Reading one the library does not define
# aborts under `set -u` with exit 1, and per .claude/rules/hooks.md any exit
# that is not 2 propagates as a NON-BLOCKING error -- i.e. a PASS. Refuse
# instead, unconditionally and before the first constant is read, naming every
# GATE_* constant read below. NOT yet fenced as a class -- the fence was split
# out of this change and is tracked by go-to-k/cdkd#2826, so nothing
# mechanical notices a hook that reads a constant without this call.
if ! declare -F gate_require_const >/dev/null 2>&1; then
  # The helper itself is missing, so nothing below can be trusted either.
  echo "Blocked: .claude/hooks/lib/command-match.sh loaded but does not define" >&2
  echo "gate_require_const, so this gate cannot verify the constants it reads." >&2
  exit 2
fi
gate_require_const GATE_RE_GH_PR_CREATE_OR_MERGE

set -u

# Read the entire stdin payload once; we need both .tool_input.command
# and .cwd from it.
input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate `gh pr create` and `gh pr merge` invocations -- any other
# command passes through. Match both `gh pr merge` and
# `gh pr merge --auto`. Tolerate an optional `gh -C <path>` between
# `gh` and `pr` so `gh -C <path> pr create` is also recognised.
# Matching goes through the SHARED command-position matcher
# (.claude/hooks/lib/command-match.sh, issue #1455): heredoc bodies and
# quoted spans are stripped, then the verb is matched at line start OR
# after a `&&` / `||` / `;` / `|` operator. That catches chained
# invocations the old line-start anchor missed, while a quoted mention
# still does not fire (it is removed rather than dodged by position).
if ! gate_matches "$cmd" "$GATE_RE_GH_PR_CREATE_OR_MERGE"; then
  exit 0
fi

# Resolve where the gh command will actually run (cwd-aware; mirrors
# integ-local-gate.sh).
# Where the git/gh command will actually RUN.
#
# This calls the SHARED resolver in lib/command-match.sh, replacing the
# hand-rolled `-C` scan this hook used to carry. That copy captured the raw
# token with no guard for an unexpanded `$VAR`, so the standard worktree
# spelling `git -C "$W" ...` resolved to the literal `<cwd>/$W`, the repo
# probe below failed, and the gate exited 0 over a tree it never looked at
# (go-to-k/cdkd#2027). The strict resolver refuses instead of guessing.
__verb_ere="$GATE_RE_GH_PR_CREATE_OR_MERGE"
if ! target_dir=$(gate_target_dir_strict "$cmd" "${hook_cwd:-$PWD}" "$__verb_ere"); then
  gate_refuse_unresolved_target "verify-pr-gate" "${hook_cwd:-$PWD}"
fi

# If the resolved target dir is not a git repo, silently pass — we
# can't audit what we can't see.
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# Repo opt-in scope (mirrors branch-gate.sh, issue #1259): this gate protects
# repos that follow the markgate convention. A session rooted in such a repo can
# still run git / gh against OTHER repos (a dotfiles checkout, a scratch clone)
# that have no markers at all, and blocking there is pure friction — the gate
# would demand a marker the repo cannot have. Opt-in signal: a `.markgate.yml`
# at the resolved target repo's top level. Repos without it pass through.
target_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || echo "")
if [[ -z "$target_top" || ! -f "$target_top/.markgate.yml" ]]; then
  exit 0
fi

# REPO IDENTITY (go-to-k/cdkd#3209) -- computed HERE, before the `cd -P` below,
# because `$__hook_dir` CAN BE RELATIVE and would then name the wrong directory
# once this process has changed its cwd. Two ways it is relative, and the first
# revision of this comment named only the second: `.claude/settings.json` invokes
# this hook as `${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/verify-pr-gate.sh`, which
# is `./.claude/hooks/...` whenever that variable is unset -- the PRODUCTION
# spelling, not an edge case; and `${BASH_SOURCE[0]%/*}` falls back to `.` when
# the script is invoked with a bare name.
#
# THE PLACEMENT IS FENCED BY A CASE, and an earlier revision of this paragraph
# described that case wrongly in BOTH halves. It is not enough for the hook to
# be invoked relatively: the case must ALSO target a directory that is not the
# process's cwd, or `./.claude/hooks` resolves identically before and after the
# `cd -P` and the block can be moved with the suite still green. And the flip is
# passing -> REFUSING, not the reverse: from inside a foreign target the hook's
# own repo becomes unresolvable, the identity fails CLOSED, and a sibling PR
# that should clear is refused -- go-to-k/cdkd#3209's original false block,
# coming back. Measured by moving the block: 78 green, that one case red.
#
# The SHA BINDING further down is a cdkd-ONLY device: `/verify-pr` writes
# `.markgate-verify-pr-sha`, and no sibling repo defines the file. This gate
# fires on commands targeting ANY repo carrying a `.markgate.yml` (the opt-in
# above), and cdk-local and cdk-real-drift both carry one -- so a `gh pr create`
# there was refused for a sentinel those repos never write, by a refusal NO
# legitimate action could clear. `.claude/rules/hooks.md`'s prescribed remedy
# (complete the target's own checklist, set its markers, retry) does not reach
# it, because what is missing is a FILE FORMAT rather than a marker, and writing
# cdkd's sentinel into a sibling is the second half of the same sentence: "do
# not fix the target repo to match cdkd". It blocked a step
# `.claude/skills/work-issues/references/retro.md` 10-c MANDATES -- the session
# that finds a lesson lands the mirror PR in all three repos.
#
# So: require the BINDING only in the repo that DEFINES it, and keep requiring
# `markgate verify verify-pr` everywhere. cdkd's POLICY still applies to a
# sibling target; cdkd's MECHANISM stops being demanded of a repo that has none.
#
# WHY `BASH_SOURCE` IS RIGHT FOR THIS AND WAS WRONG FOR THE MARKER LOOKUP.
# The header above records that the pre-#559 implementation derived the marker
# store from `BASH_SOURCE`, and that doing so defeated markgate's per-worktree
# isolation. These are DIFFERENT QUESTIONS and the next reader will assume they
# are the same one. "Which marker store?" is PER-WORKTREE -- markgate keys it on
# `--absolute-git-dir`, which differs in every linked worktree -- so only the
# payload `cwd` can answer it, and `BASH_SOURCE` answered a question it was not
# asked. "Which REPOSITORY is this?" is the opposite: deliberately
# worktree-INVARIANT, and the GIT COMMON DIR is exactly the value every linked
# worktree of one repository shares. So resolving it from `BASH_SOURCE` does not
# reintroduce #559: the marker lookup below still comes from the payload cwd,
# every cdkd worktree carries its own `.claude/hooks` copy that resolves to the
# SAME common dir, and only a genuinely different repository takes the relaxed
# path.
#
# Both values are canonicalised with `cd` + `pwd -P` -- the spelling
# `.claude/skills/work-issues/references/launch-mode.md` uses for this same
# value. It is DEFENSIVE AND UNFENCED, and saying why it is there is not the
# same as having measured that it does anything: the usual reason given, that
# macOS resolves `/var` to `/private/var`, was checked and is NOT one. Measured
# 2026-09-16 on git 2.49: `--path-format=absolute --git-common-dir` already
# prints `/private/var/...` for a main checkout, a linked worktree and a
# relative `GIT_DIR`, and deleting this line changes no verdict in the suite.
# It stays because a path git DID return unresolved would compare unequal to
# itself in the RELAXING direction; do not cite a measurement for it.
#
# FAIL CLOSED: if EITHER common dir cannot be resolved, the sentinel stays
# required, which is today's behaviour. An unresolvable identity never relaxes.
#
# KNOWN BOUNDS, stated rather than chased:
#   - For a foreign target, `verify-pr` is `requires: [...]` with no `include:`
#     of its own THERE too, so a marker stale by INHERITANCE can pass -- the
#     very hole the binding closes here. That is the sibling repo's own design,
#     and `.claude/rules/hooks.md` forbids porting cdkd's stricter gate down to
#     fix it.
#   - A second CLONE of cdkd (a clone, not a worktree) is foreign by this test
#     and takes the relaxed path. Not hypothetical -- a separate checkout for
#     drafting a security fix is an ordinary thing to have. Its marker must
#     still be fresh, so what it loses is only the lane-N-inherits-lane-N-1
#     protection: the same bound as the row above, in a checkout that has its
#     own `/verify-pr`.
#   - "FAIL CLOSED" covers an UNRESOLVABLE identity, not a RESOLVABLE WRONG one.
#     If this file is reached through a symlinked `.claude` (or `.claude/hooks`)
#     whose physical location sits inside a DIFFERENT repository, `git -C` follows
#     the symlink, the hook's "own" repo becomes that other one, and every cdkd
#     target is then classified foreign -- the go-to-k/cdkd#2686 binding silently
#     dropped. Not this repo's shape (both are real directories in the main tree
#     and in every worktree), and it needs write access to the checkout, which is
#     already game over. Stated because the phrase above reads as if only the
#     unresolvable case can go wrong.
__vpg_common_dir() {
  # `--path-format=absolute` is load-bearing, not tidiness: the bare form prints
  # a path relative to the directory `-C` named, so the `cd` below would resolve
  # it against THIS process's cwd instead. Measured 2026-09-16 -- a main checkout
  # answers `.git`, and `-C <repo>/.claude` answers `../.git`; a linked worktree
  # happens to answer absolutely, which is exactly how this would have looked
  # correct in the tree it was written in.
  local __d
  __d=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  [ -n "$__d" ] || return 1
  __d=$(cd "$__d" 2>/dev/null && pwd -P) || return 1
  [ -n "$__d" ] || return 1
  printf '%s\n' "$__d"
}

# `$target_dir`, NEVER the payload cwd. They differ exactly for the two
# spellings CLAUDE.md prescribes -- `gh -C <path> pr ...` and `cd <path> && gh
# pr ...` -- and reading the cwd here would classify by where the SHELL stands
# instead of where the command runs: a `gh -C <own repo>` issued from a sibling
# checkout would take the relaxed path and drop the binding. Fenced by the two
# cwd-differs-from-target cases in the suite; a mutant swapping this for
# `${hook_cwd:-$PWD}` survived the whole suite before they existed.
target_is_foreign=0
__hook_common=$(__vpg_common_dir "$__hook_dir") || __hook_common=""
__target_common=$(__vpg_common_dir "$target_dir") || __target_common=""
if [ -n "$__hook_common" ] && [ -n "$__target_common" ] \
  && [ "$__hook_common" != "$__target_common" ]; then
  target_is_foreign=1
fi

# ...but a command can name a repo OTHER than the one the target directory is
# in, and the relaxation is sound only while those are the same thing. Measured
# on this branch before any guard existed: from a cdk-local checkout,
# `gh pr merge <N> --squash --repo go-to-k/cdkd` went 2 -> 0 -- cdk-local's
# fresh marker clearing the merge of a CDKD pull request, with neither cdkd's
# marker nor its sentinel consulted. Nothing downstream catches it:
# `pr-review-gate` and `ci-green-gate` resolve the PR in the TARGET cwd with no
# `-R` of their own, so they judge a different repo's PR number, or fail open on
# a missing one.
#
# THE FIRST FIX WAS A DENYLIST AND IT IS WHY THIS ONE IS NOT. A regex for
# `-R` / `--repo` over `strip_noncommand_spans` output closed those two
# spellings and one review round produced five more that gh honours and it did
# not see: `GH_REPO=<slug> gh ...` and `export GH_REPO=...` (the assignment is
# stripped before the segment is read, and it need not even be in this segment),
# `gh pr merge https://github.com/<owner>/<repo>/pull/<N>` (a URL selector needs
# no flag at all), `gh pr merge N "--repo" <slug>` and `--re"po"` (stripping a
# quoted span deletes the flag NAME with it). Enumerating spellings has no
# termination proof; `.claude/skills/work-issues/references/implement.md` 5-f'
# names the instrument change and its stricter option -- REFUSE the construct
# rather than model it.
#
# So this is an ALLOWLIST: relax only when the command PROVABLY names no other
# repo, and treat every shape it cannot read as naming one.
#
#   - the hook's own environment carries no `GH_REPO` (a hook inherits the
#     session's, and gh honours it over the local repo);
#   - the RAW command text contains no `GH_REPO` anywhere -- raw, because
#     `env "GH_REPO=x" gh ...` hides it from the stripper, and whole-command,
#     because `export GH_REPO=x; gh ...` puts it in a different segment;
#   - every TOKEN of every matched `gh ... pr create|merge` segment is
#     LITERALLY READABLE (`gate_word_is_literal`): a `$VAR`, a substitution, a
#     brace expansion, a backslash or an unbalanced quote is a shape this cannot
#     model, so it stops the relaxation instead of passing through it;
#   - and no token NAMES A REPO. Two shapes, both tested on the token with its
#     QUOTE CHARACTERS REMOVED (`$noq`) rather than on the raw text or on
#     `gate_unquote`'s output:
#       `--repo*`, and `-R*` or a combined short-flag CLUSTER containing `R`
#       (`-[!-]*R*`). gh's `-R` is an ordinary cobra short flag, so it clusters:
#       measured 2026-09-16, `gh pr view -cR go-to-k/cdkd 3214` and the glued
#       `-cRgo-to-k/cdkd` BOTH resolve the cdkd PR from a non-repo directory,
#       and `-sdR <slug>` / `-sR<slug>` are the same shape on `pr merge`. A
#       prefix-only `-R*` test let every one of those through.
#       `-tRelease` -- a `--title` short flag whose VALUE begins with `R` --
#       is refused by that cluster pattern. Deliberate: over-refusal falls back
#       to the binding, which is the direction this whole guard errs in.
#     `$noq` is the ONLY form tested because it SUBSUMES the other two:
#     deleting quote characters can expose a prefix but never hide one.
#     Measured -- `$noq` alone keeps the suite green, `gate_unquote`'s output
#     alone loses the `--re"po"` case (the library's unquote is not a shell and
#     leaves `--re"po`), and the RAW token alone loses that and `"--repo"` as
#     well. An earlier revision looped over all three and said all three were
#     needed; the loop was dead and the sentence was false. For the SELECTOR
#     test the form is not load-bearing at all -- once
#     `gate_word_is_literal` has passed, every form agrees on `://`, and the
#     mutant swapping one for another discriminated zero cases. It uses `$noq`
#     for uniformity, not because a probe demanded it.
#   - and no token is a URL / PR SELECTOR: the token's FIRST
#     whitespace-delimited word (`${noq%%[[:space:]]*}`) carries `://` or
#     `/pull/<digits>`. gh resolves the repo from such a selector with no flag
#     and no variable at all.
#
#     TWO WRONGER VERSIONS CAME FIRST, and both are worth keeping written down
#     because each looked like the obvious test.
#     (1) "the raw token carries no QUOTE" -- agents quote URLs routinely, so
#         `gh pr merge "https://github.com/<o>/<r>/pull/5"` and the
#         single-quoted form resolved FOREIGN and PASSED (measured rc=0 while
#         the bare form returned 2).
#     (2) "the whole token carries no WHITESPACE" -- its premise, that a
#         selector never has whitespace, is FALSE. gh `url.Parse`s the argument
#         and PREFIX-matches `^/OWNER/REPO/pull/(\d+)`, so ANYTHING after the
#         number still resolves. Measured on gh 2.92.0 from a non-repo
#         directory, `gh pr view <sel> --json url` resolved cdkd's PR for a
#         trailing SPACE, a trailing NBSP, `.../pull/<n>?x=a b` and
#         `.../pull/<n>/files x` -- and all four took the relaxed path. A
#         LEADING space, tab or newline is refused by gh itself, so those need
#         nothing here.
#     What the FIRST-WORD test buys is the thing the whitespace test was
#     reaching for and missed: a URL sitting inside PROSE is still exempt,
#     because prose starts with a word that is not a URL. Measured, both
#     `--body "see https://x "` and `--body=see https://x` stay exempt.
#     OVER-REFUSAL, named rather than discovered: a body whose FIRST word is a
#     URL (`--body "https://x is the link"`) now refuses. Fail-closed, and the
#     answer is the same as for every other over-refusal here -- run it from the
#     target repo's own checkout.
#   - and the segment did not reach the verb through `xargs`, which INJECTS argv
#     from stdin: the words this predicate reads are then not the words gh
#     receives. Measured, `printf <pr-url> | xargs gh pr merge --squash` relaxed
#     while gh resolved that PR from a non-repo directory, and the `xargs -n1`
#     and `xargs ... < file` forms behave the same.
#
#     THIS IS A STRUCTURAL DISTINCTION, NOT A SPELLING, which is what makes it
#     closable in one arm rather than another round of the cascade above. Read
#     `gate_strip_prefix`'s whole set and ask of each member "does it change
#     what argv the command ends up with?":
#       `env` `command` `nohup` `sudo` `exec` `time` `timeout <arg>` -- EXEC the
#         command with the argv written IN the text (`env` changes the
#         ENVIRONMENT, which is why the `GH_REPO` clauses above exist, not argv);
#       `then` `do` `else` `elif` `if` `while` `until` `!` `{` `(`, a `case ...
#         in` head and its arm labels -- shell syntax, no argv at all;
#       `VAR=value` -- an assignment, same environment story as `env`;
#       `-FLAG` -- a flag belonging to one of the wrappers above;
#       `xargs` -- ALONE in reading stdin and APPENDING it as arguments.
#     So one member is the injector and the rest are not. A future author adding
#     to that set should re-ask this question rather than re-deriving the list.
#
# KNOWN BOUND -- THE RESIDUAL CLASS, and it is worth stating as one thing rather
# than as the list of spellings that led to it. This predicate answers "does
# this TOKEN name another repo" from the token's TEXT. Two questions that is
# structurally unable to answer:
#
#   (a) WHICH token gh will read as the selector. It does not know, so it scans
#       EVERY token and models prose with the first-word heuristic above -- and
#       that heuristic is exactly where the `--body "https://x is the link"`
#       over-refusal comes from. This one IS closable, by deciding the question
#       on the SELECTOR POSITION instead of on every token: filed as
#       go-to-k/cdkd#3256.
#   (b) A repo reaching gh through a channel that is not the segment's literal
#       argv at all -- an `upstream` remote in the target checkout
#       (go-to-k/cdkd#3235), a `GH_REPO` / `GH_HOST` assembled at run time, a
#       `gh alias` expanding to a `-R`. NO reading of the command text closes
#       this class, positional or otherwise; only asking what gh itself would
#       resolve does, which is go-to-k/cdkd#3235's subject.
#
# FAILURE DIRECTION: a miss is the only dangerous one. Refusing to relax falls
# back to the binding requirement, which was UNCONDITIONAL before
# go-to-k/cdkd#3209 -- so this is never stricter than `origin/main`, whatever it
# over-refuses. Two deliberate over-refusals: a `-R` naming the target's OWN
# repo, and an unexpanded `$VAR` anywhere in the gh command. Both are answered
# by running the command from the target repo's checkout with literal
# arguments, which `.claude/rules/hooks.md`'s sibling-repo section prescribes
# anyway.
#
# KNOWN BOUND, and it is NOT this guard's: `env "GH_REPO=x" gh pr merge ...` --
# the assignment QUOTED after an `env` -- matches no verb in the SHARED matcher,
# so this gate (and every other one on it) never fires at all. Measured
# 2026-09-16: `gate_matches` says no, and `gate_segments` emits a segment
# beginning with the quoted assignment. `git commit` and `git push` go the same
# way, so it is a property of `gate_strip_prefix`, not of this gate -- folded
# onto go-to-k/cdkd#2354, which already carries the quoted-LEADER half of the
# same root cause. The allowlist below refuses that shape once the matcher
# reaches it, which is why this is RECORDED here rather than answered here.
#
# KNOWN BOUND, and WIDER than an earlier revision of this comment said. That
# revision named `gh repo set-default <other slug>` -- a deliberate act writing
# `remote.<name>.gh-resolved` -- and filed the case under "needs write access to
# the checkout". gh does not need either. Measured 2026-09-16 in a fresh repo
# with `origin` = go-to-k/cdk-local, `upstream` = go-to-k/cdkd, NO `gh-resolved`
# key and no interaction: `gh repo view --json nameWithOwner` answers
# **go-to-k/cdkd**. gh prefers an `upstream` remote over `origin`, so a plain
# `git remote add upstream <other repo>` -- an ordinary agent operation, and the
# standard fork setup -- silently re-points every later bare `gh pr merge <N>`
# in that checkout, with NOTHING in the command text for this guard to read.
# Removing the upstream remote returns the answer to go-to-k/cdk-local.
#
# NOT answered here, deliberately. The honest guard is a remote-slug COMPARISON
# -- resolve what gh would resolve in the target and require it to equal the
# target's own repo -- and that is a structural fix at the end of a cascade,
# which `.claude/skills/work-issues/references/verify.md` 8-a says to FILE
# rather than take late. A presence test is not a substitute: refusing any
# `gh-resolved` holding a slug would refuse a sibling that ran
# `gh repo set-default` on ITSELF, which is what gh tells a multi-remote
# checkout to do, and that re-breaks the flow this change exists to enable.
# Filed as go-to-k/cdkd#3235, which would also retire the second-clone bound
# above.
#
# KNOWN BOUND on the ENVIRONMENT tests: `[ -z "${GH_REPO:-}" ]` reads this
# process's env, and the `*GH_REPO*` text test reads the command as WRITTEN.
# Neither sees a name assembled at run time (`export "GH_RE"PO=...`) or one
# arriving from a file the command sources, and `GH_HOST` -- which re-points gh
# at another API host and combines with the rest -- has exactly the same shape.
# Stated rather than answered: enumerating spellings is the instrument this
# guard was rewritten to get away from, and the run-time forms are not readable
# from command text at all.
# Sets `__vpg_retract` to the REASON it refused, so the block message below can
# say what to do instead of sending the reader to a sentinel a sibling cannot
# write. Empty on success.
__vpg_retract=""
__vpg_names_no_other_repo() {
  local cmd="$1" seg tok noq argv
  __vpg_retract=""

  if [ -n "${GH_REPO:-}" ]; then
    __vpg_retract="GH_REPO is set in this session's environment"
    return 1
  fi
  case "$cmd" in
    *GH_REPO*)
      __vpg_retract="the command carries a GH_REPO assignment"
      return 1
      ;;
  esac

  # `xargs` is read from the RAW segments, not the ones below. `gate_segments`
  # emits each segment with `gate_strip_prefix` ALREADY APPLIED -- measured,
  # `printf <url> | xargs gh pr merge` arrives here as a bare
  # `gh pr merge --squash`, so the wrapper is invisible to the token walk that
  # follows and a first attempt at this check saw nothing. `gate_segments_raw`
  # keeps it.
  #
  # Scoped per RAW segment and to `xargs` appearing BEFORE a `gh` token in the
  # SAME one, rather than anywhere in the command: `xargs rm < list; gh pr merge
  # 42` is two segments and only the first has the wrapper. No positional
  # correlation between the two segment streams is assumed, because a 1:1
  # alignment between them is not a documented property and a wrong index would
  # judge the wrong segment.
  while IFS= read -r seg; do
    [ -n "$seg" ] || continue
    while IFS= read -r tok; do
      [ -n "$tok" ] || continue
      noq=${tok//\"/}
      noq=${noq//\'/}
      case "$noq" in
        # The verb: stop here, which is what makes the test BEFORE-only. An
        # `xargs` further right is an ARGUMENT (`--title xargs`), not the
        # wrapper.
        gh) break ;;
        xargs)
          __vpg_retract="the gh command's arguments arrive from stdin through xargs, so the command text cannot name the target repo"
          return 1
          ;;
      esac
    done <<EOF
$(gate_argv "$seg" 2>/dev/null)
EOF
  done < <(gate_segments_raw "$cmd")

  while IFS= read -r seg; do
    gate_verb_span "$seg" "$__verb_ere" >/dev/null 2>&1 || continue
    # Captured, not piped: a process substitution discards the rc, and
    # `gate_argv` returning 1 is precisely the "cannot read this" case.
    if ! argv=$(gate_argv "$seg"); then
      __vpg_retract="the gh command cannot be split into words (an unbalanced quote?)"
      return 1
    fi
    while IFS= read -r tok; do
      [ -n "$tok" ] || continue
      if ! gate_word_is_literal "$tok"; then
        __vpg_retract="the gh command carries an argument this gate cannot read literally ($tok)"
        return 1
      fi
      # ONE derived form, used by both tests below. `gate_unquote`'s output was
      # a third variable until a probe showed it fenced nothing: once
      # `gate_word_is_literal` has passed, deleting the quote CHARACTERS and
      # unquoting properly agree on every input either test can separate, and
      # the mutant swapping one for the other discriminated zero cases.
      noq=${tok//\"/}
      noq=${noq//\'/}
      case "$noq" in
        -R* | --repo* | -[!-]*R*)
          __vpg_retract="the gh command carries a repo override ($tok)"
          return 1
          ;;
      esac
      # A URL / PR selector names the repo with no flag at all. Tested on the
      # token's FIRST whitespace-delimited word -- NOT on the whole token, which
      # gh resolves anyway; see the block comment above.
      case "${noq%%[[:space:]]*}" in
        *://* | */pull/[0-9]*)
          __vpg_retract="the gh command names a pull request by URL ($tok)"
          return 1
          ;;
      esac
    done <<EOF
$argv
EOF
  done < <(gate_segments "$cmd")
  return 0
}

if [ "$target_is_foreign" -eq 1 ] && ! __vpg_names_no_other_repo "$cmd"; then
  target_is_foreign=0
fi

# Fail CLOSED, matching `check-gate.sh`'s `cannot_evaluate`. A gate that cannot
# enter the tree it is judging has not cleared it. This was `|| exit 0` -- a
# fail-open the delta's `git -C "$target_dir"` was working around rather than
# closing (go-to-k/cdkd#2686 review).
# `-P`, physical: bash's LOGICAL `cd` resolves `..` textually, so a path with a
# `..` after a symlink can land in a DIFFERENT existing directory than the
# physical chdir `git -C` did at the repo probe above -- `markgate verify` would
# then run in one tree while `target_top` and the sentinel come from another (measured,
# go-to-k/cdkd#2686 round-3 review). The refusal below is near-unreachable for
# that reason -- that probe already proved the chdir works -- but it fails CLOSED
# like `check-gate.sh`'s `cannot_evaluate` rather than passing a tree it could
# not enter.
if ! cd -P "$target_dir" 2>/dev/null; then
  echo "Blocked by verify-pr-gate: cannot enter $target_dir to evaluate the marker." >&2
  exit 2
fi

# Prefer the `.mise.toml`-pinned version via `mise exec --` so the repo's
# canonical markgate wins over an older PATH binary; see check-gate.sh for
# the schema-bump rationale (0.3.0 markers are silently invisible to 0.3.1).
if command -v mise >/dev/null 2>&1; then
  markgate=(mise exec -- markgate)
elif command -v markgate >/dev/null 2>&1; then
  markgate=(markgate)
else
  echo "Blocked by verify-pr-gate: markgate is not installed. Run 'mise install' at the repo root (see CONTRIBUTING.md)." >&2
  exit 2
fi

"${markgate[@]}" verify verify-pr >/dev/null 2>&1
status=$?

# SHA BINDING (go-to-k/cdkd#2686).
#
# A fresh marker is not enough. `verify-pr` is declared `requires: [check,
# docs]` with NO `include:` of its own, so once set in a worktree it never
# stales by itself -- it is only ever MASKED by a stale child. Running `/check`
# and `/check-docs` un-masks it, and the gate that is supposed to physically
# block `gh pr create` / `gh pr merge` for a PR whose live behaviour was never
# exercised goes green for a PR `/verify-pr` has never seen.
#
# That is invisible in a single-PR session and NOT invisible in the IN-PLACE
# worktree mode CLAUDE.md prescribes, where lane N inherits lane N-1's parent
# marker. Measured twice, in different worktrees a day apart: a parent an hour
# older than children four minutes old, `markgate verify verify-pr` rc=0, and
# `gh pr create` unblocked.
#
# THIS COMPARISON IS THE ENFORCEMENT, not a nicer error string. `markgate
# verify` digests the gate's SCOPE; a sentinel nobody rewrote keeps its digest
# whatever the branch moved to, so `verify` reports `match` for a sentinel
# naming a different commit entirely (measured on the sibling gate,
# go-to-k/cdkd#2681 -- whose whole subject is a comment that claimed the digest
# enforced it, and which would have made deleting this look like a safe
# simplification). Do not remove it on the strength of the digest.
#
# Bound to the LOCAL HEAD, not to the PR's `headRefOid` as `pr-review-gate.sh`
# is: this gate also guards `gh pr create`, where there is no PR to ask. The
# local HEAD exists at both moments and is exactly what distinguishes one lane
# from the next.
# Read from the repo TOP, not the cwd: `gh pr create` run from a subdirectory
# would otherwise find no sentinel and be refused for a reason that has nothing
# to do with the marker. `target_top` is already resolved above.
recorded_sha=""
if [ -f "$target_top/.markgate-verify-pr-sha" ]; then
  # SIZE first, then read WHOLE, then check the SHAPE. The order matters and
  # two weaker spellings were measured wrong before this one:
  #
  #   `head -c 100` alone -- a sentinel of `<sha><60 spaces><junk>` reads as the
  #   bare sha under the cap and as sha+junk without it, so the CAP decides the
  #   verdict, not the comparison. An earlier comment here claimed truncation
  #   "cannot turn a non-match into a match"; it is exactly what it does.
  #
  #   cap + shape check -- same hole: the truncated read IS a well-formed sha.
  #   Raising the cap only moves the padding length that defeats it.
  #
  # What actually closes the truncation hole is reading the file WHOLE: the junk
  # then lands in `recorded_sha` and the comparison fails. The size cap is a
  # RESOURCE bound (a legitimate sentinel is one sha and a newline -- 41 bytes,
  # 65 for sha256), and the shape check rejects malformed content early.
  #
  # Measured, and CORRECTED after a reviewer checked the claim I made here:
  #
  #   - the SIZE CAP is load-bearing on its own. `<sha><100 spaces>` (140 B)
  #     refuses today and PASSES with the cap widened, because `tr` strips the
  #     padding and what is left is a well-formed sha. An earlier revision of
  #     this comment said removing the cap "changes no verdict" -- an untrue
  #     claim of exactly the form this gate exists to stop, written twice in one
  #     PR. The divergence is in the safe direction; the claim was still false.
  #   - the HEX and LENGTH checks genuinely are redundant with the comparison:
  #     `head_sha` is always lowercase 40-hex, so a malformed `recorded_sha`
  #     can never compare equal. Removing either, or both, changes no verdict.
  #     They stay because they make the REASON legible in the block message.
  #
  # KNOWN BOUNDS, stated rather than chased: the read FOLLOWS a symlink (an
  # attacker who can plant one in your worktree can do worse), and a sentinel
  # whose sha is followed by a NUL passes: `tr` now strips NUL so bash no longer
  # warns about it on stderr, but the remaining bytes still read as the sha.
  # Neither is reachable from the documented flow, which writes the file with
  # `git rev-parse`.
  sentinel_bytes=$(wc -c < "$target_top/.markgate-verify-pr-sha" 2>/dev/null | tr -d '[:space:]')
  case "$sentinel_bytes" in
    '' | *[!0-9]*) sentinel_bytes=99999 ;;
  esac
  if [ "$sentinel_bytes" -le 128 ]; then
    # Braces around the redirect: bash applies `< file` BEFORE `2>/dev/null`, so
    # a `chmod 000` sentinel otherwise leaks a "Permission denied" line onto the
    # hook's own stderr (verdict was already correct).
    recorded_sha=$({ tr -d '[:space:]\000' < "$target_top/.markgate-verify-pr-sha"; } 2>/dev/null)
    case "$recorded_sha" in
      *[!0-9a-f]* | "") recorded_sha="" ;;
    esac
    case "${#recorded_sha}" in
      40 | 64) ;;
      *) recorded_sha="" ;;
    esac
  fi
fi
# `--verify`, not a bare `rev-parse HEAD`: in a repo with no commits the bare
# form prints the literal string `HEAD` on STDOUT (and the fatal on stderr), so
# `head_sha` would be "HEAD" rather than empty and the `-n` guard below would be
# dead code. Measured. `--verify` yields a sha or nothing.
head_sha=$(git -C "$target_dir" rev-parse --verify HEAD 2>/dev/null || echo "")

if [ "$status" -eq 0 ] && [ -n "$head_sha" ] && [ "$recorded_sha" = "$head_sha" ]; then
  exit 0
fi

# A FOREIGN target clears on the MARKER alone (go-to-k/cdkd#3209; the identity
# block above carries the reasoning and the bounds). The sentinel this gate
# compares is cdkd's own device, which the target repo does not write.
#
# `[ -n "$head_sha" ]` is deliberately NOT repeated here. That guard exists
# because an absent sentinel and an unreadable HEAD both read as the empty
# string, so `"" = ""` would PASS the comparison above; with no comparison on
# this path there is nothing for it to fail open.
if [ "$status" -eq 0 ] && [ "$target_is_foreign" -eq 1 ]; then
  exit 0
fi

# Extract the parenthesized reason from `markgate status verify-pr` so the
# error message tells the user *why* the gate is stale. With markgate 0.3+
# `requires: [check, docs]` the reason often names the failing child
# (e.g. "(child docs is stale)"), pointing the user straight at /check or
# /check-docs without forcing them to re-run /verify-pr blindly. Fails open
# to the static heredoc body when extraction fails.
reason=$("${markgate[@]}" status verify-pr 2>/dev/null \
  | awk '/^state:/ { if (match($0, /\([^)]+\)/)) print substr($0, RSTART, RLENGTH); exit }')

# Reaching here with a FRESH marker means the binding is what failed, whatever
# shape it failed in. An earlier revision said `&& [ "$recorded_sha" != "$head_sha" ]`,
# which is NOT the complement of the pass condition: with an unreadable HEAD and
# no sentinel both are empty, `!=` is false, and a fresh marker fell through to
# the generic "stale" text -- the exact misdirection these lines exist to
# prevent. Measured; found by both reviews of go-to-k/cdkd#2686.
# The actionable half of a RETRACTED relaxation, shared by the two paths that
# can reach it: a fresh marker (where it is the whole story) and a STALE one
# (where it is the second reason, and clearing the marker will not fix it).
__vpg_print_override_guidance() {
  printf "Re-run it from the target repository's own checkout, with literal arguments:\n" >&2
  printf "  - no \`-R\` / \`--repo\` and no short-flag cluster carrying \`R\`\n" >&2
  printf "  - no \`GH_REPO\` in the environment or on the command line\n" >&2
  printf "  - the PR named by NUMBER, not by URL\n" >&2
  printf "  - no unexpanded \$VARIABLE in the gh command\n\n" >&2
  printf "Do NOT write cdkd's \`.markgate-verify-pr-sha\` into the sibling; that file is\ncdkd's own device and the sibling does not define it.\n\n" >&2
}

if [ "$status" -eq 0 ] && [ -n "$__vpg_retract" ]; then
  # THE RETRACTED-RELAXATION CASE, and it is the one place the message below is
  # actively MISLEADING. The target is a FOREIGN repo, so it has no
  # `.markgate-verify-pr-sha` and cannot be given one without doing the thing
  # `.claude/rules/hooks.md` forbids ("do not fix the target repo to match
  # cdkd") -- yet without this branch the reader is sent to `/verify-pr` and to
  # that sentinel. With `GH_REPO` exported in a shell profile EVERY sibling PR
  # lands here, so this is not a corner.
  printf "Blocked by verify-pr-gate: this command targets %s, which is NOT this repo,\nand it also names a repository of its own -- %s.\n\n" \
    "$target_top" "$__vpg_retract" >&2
  printf "A cdkd session may open or merge a PR in a sibling repo on that repo's OWN\n\`verify-pr\` marker. It may not do so with a command that could be acting on a\nTHIRD repo, because then the marker attests to something else entirely.\n\n" >&2
  __vpg_print_override_guidance
elif [ "$status" -eq 0 ]; then
  # The marker is FRESH; what is wrong is what it is bound to. Saying "stale"
  # here would send the reader to `/check` for a problem no child has.
  printf "Blocked by verify-pr-gate: the \`verify-pr\` marker is fresh but bound to a different commit.\n\n" >&2
  printf "  HEAD is:          %s\n" "${head_sha:-<unreadable>}" >&2
  # A present-but-rejected sentinel is not the same as an absent one, and the
  # reader needs to know which: "unset" sends them to /verify-pr, "malformed"
  # sends them to the file.
  sentinel_label="<unset>"
  if [ -n "$recorded_sha" ]; then
    sentinel_label="$recorded_sha"
  elif [ -e "$target_top/.markgate-verify-pr-sha" ]; then
    sentinel_label="<present but unreadable or malformed>"
  fi
  printf "  marker bound to:  %s\n\n" "$sentinel_label" >&2
  printf "This is the second-lane case: a marker set for an earlier branch in this\nworktree, un-masked by a later \`/check\` + \`/check-docs\`. Run \`/verify-pr\`\nfor THIS branch.\n\n" >&2
elif [ -n "$reason" ]; then
  printf "Blocked by verify-pr-gate: the \`verify-pr\` marker is stale %s.\n\n" "$reason" >&2
else
  echo "Blocked by verify-pr-gate: the \`verify-pr\` marker is stale (or missing)." >&2
  echo >&2
fi

# SKIPPED when the retraction is the ONLY thing wrong -- a FRESH marker plus a
# retracted relaxation. `/verify-pr` is not the remedy there: the target is a
# foreign repo, this session's `verify-pr` marker has nothing to do with it, and
# the block above already named the one action that clears it. Printing this
# underneath would put the wrong instruction last, which is the instruction that
# gets followed.
#
# `status -eq 0` is load-bearing and was missing: without it a STALE marker plus
# a retraction also exited here, so the reader got the staleness line and
# NOTHING else -- neither the `/verify-pr` remedy that does apply to the
# staleness, nor the second-reason note below. Caught by the case that asserts
# both reasons appear.
if [ "$status" -eq 0 ] && [ -n "$__vpg_retract" ]; then
  exit 2
fi

cat >&2 <<'EOF'
Required action — no exceptions:
  /verify-pr [PR-number]

The skill walks the full PR-readiness checklist:
  - typecheck / lint / build / unit tests
  - test coverage for the diff
  - CI status / working tree / docs consistency / leftover AWS resources
  - code review (incl. shared-utility caller verification)
  - live-test the changed behavior against real or fixture input
  - retrospective + proposals for new rules / hooks / skills
  - PR title + body freshness vs the actual diff

It is the ONLY legitimate setter of this marker. Do NOT call
`markgate set verify-pr` directly from a shell to bypass this hook —
the whole point of the gate is that an unverified PR cannot be opened
or merged. If a check legitimately cannot pass right now (e.g. no
AWS credentials for live-test), say so explicitly in the report; the
gate stays red so a human can decide whether to override.
EOF

# A STALE marker and a RETRACTED relaxation are INDEPENDENT, and the staleness
# branches above print only the first. Clearing the marker then leaves the
# reader blocked again by a different message, with nothing having said the
# second reason was there all along. No security impact -- the verdict is the
# same either way -- purely so one refusal names everything that is wrong.
if [ -n "$__vpg_retract" ]; then
  printf "\nAND A SECOND REASON, which clearing the marker will NOT fix: this command\ntargets %s, which is NOT this repo, and %s.\n\n" \
    "$target_top" "$__vpg_retract" >&2
  __vpg_print_override_guidance
fi
exit 2
