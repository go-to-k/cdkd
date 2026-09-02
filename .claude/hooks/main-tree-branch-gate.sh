#!/usr/bin/env bash
# main-tree-branch-gate.sh
#
# PreToolUse hook. Blocks branch-switching commands in the MAIN
# worktree (= the cdkd repo top-level dir) so multiple agents
# working in parallel don't race / clobber each other on the shared
# main tree. The main worktree must stay on `main` / `master`;
# feature branches go to `.claude/worktrees/<branch>/`.
#
# WHY this gate: the main worktree at `/Users/goto/pc/github/cdkd`
# is a SHARED RESOURCE across parallel agents. When agent A is
# mid-flight on a feature branch and agent B does
# `git switch <some-other-feature>`, A's uncommitted work either
# gets clobbered (if no stash) or gets silently stashed by B (if
# B was being defensive). Real incidents in 2026-05-24:
#   1. PR #459 agent stashed PR #547 fix-back uncommitted work.
#   2. PR #549 (Splunk) agent created their feature branch in the
#      main tree, forcing PR #547 agent to switch out.
# See memory feedback_cross_agent_main_tree_contention.md.
#
# Resolution order for "where is the git command running", applied PER
# SEGMENT -- a `-C` binds its one command, a `cd` persists into the next:
#   1. that segment's own `git -C <path>` — last `-C` wins.
#   2. the `cd <path>` segments before it.
#   3. The hook's `cwd` field.
#   4. $PWD.
# Per segment because one command can straddle two trees, and resolving it
# once for the whole command bypassed the gate in one direction and
# false-blocked in the other. Measured; see main_tree_of below.
#
# Gate scope. The arguments are read as git's ARGV -- `gate_argv` drops the words
# the SHELL owns (a redirection and its target, a trailing `&`, a `#` comment)
# and the remainder is walked against each verb's full option grammar, so a
# leading FLAG is never mistaken for the branch name and a trailing pathspec is
# never mistaken for a switch. See verdict_for's header for every shape the
# earlier readings got wrong, each settled against real git.
#   - Block: `git switch <not-main>`, `git switch -c|-C|--create|--force-create
#     <branch>`, `git switch --orphan <branch>`, `git switch -`,
#     `git switch --detach`, `git checkout -b|-B|--orphan <branch>`,
#     `git checkout -t|--track <remote-ref>`, `git checkout -`,
#     `git checkout <not-main> [--]` when NO pathspec operand follows it AND it
#     names either a LOCAL branch or a branch on a CONFIGURED REMOTE (git DWIMs
#     the second into a create + switch), and any command carrying an option this
#     gate cannot resolve against that grammar.
#   - Pass: `git switch main` / `master` / `-- main`, `git checkout main` /
#     `master`, `git checkout [<tree-ish>] -- <pathspec>` and
#     `git checkout <tree-ish> <pathspec>` (file restores -- measured, HEAD stays
#     put), `git checkout -p|--ours|--theirs|--pathspec-from-file ...`,
#     `git checkout --no-guess <remote-only-name>`, `git checkout <sha>`
#     (detached HEAD), `git checkout HEAD`, `--help`, `git worktree add ...` (the
#     sanctioned path), and everything in a LINKED worktree, which is where the
#     convention wants feature branches.
#
# Bypass: agents that legitimately need to operate in the main tree
# (e.g. release tooling, history surgery) can `cd <subdir>` first
# or explicitly `git -C <main-tree>` and override with the
# documented escape. The hook only fires when the target dir IS
# the main repo top-level.

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
  || ! declare -F gate_verb_rest_each_dir >/dev/null \
  || ! declare -F gate_refuse_unresolved_target >/dev/null \
  || ! declare -F cmd_last_cd_target >/dev/null \
  || ! declare -F strip_noncommand_spans >/dev/null \
  || ! declare -F gate_tokens >/dev/null \
  || ! declare -F gate_argv >/dev/null \
  || ! declare -F gate_word_is_literal >/dev/null \
  || [ -z "${GATE_EMBEDDING_TOKEN:-}" ] \
  || [ -z "${GATE_REDIR_TOKEN:-}" ]; then
  # FAIL CLOSED. Without the helper `cmd_matches_verb` is undefined, the
  # `if ! cmd_matches_verb ...` guard below sees exit 127 (truthy for `!`),
  # and the hook would `exit 0` -- silently disabling the gate, which is the
  # exact failure mode this file exists to prevent. Refuse instead.
  #
  # `GATE_EMBEDDING_TOKEN` and `GATE_REDIR_TOKEN` are CONSTANTS, not functions,
  # and they are named here because the shared `gate_tokens` / `gate_argv`
  # interpolate them into the `[[ =~ ]]` that splits the argument text and the
  # one that spots a redirection. A library predating either leaves that pattern
  # EMPTY, and an empty ERE matches EVERY string at position 0 with every capture
  # group empty -- so `gate_tokens` would print an empty first token forever and
  # `gate_argv` would drop every word as a redirection. Either way the walk
  # yields nothing usable and every command reads like a bare `git checkout`.
  # (The earlier note here said the loop's `[[ =~ ]]` "does NOT match" with an
  # empty token, which is the wrong mechanism: an empty pattern matches
  # everything. The conclusion -- name the constants, fail closed -- is right,
  # and the loop terminates only because `gate_tokens` breaks on an empty rest.)
  # `declare -F` cannot see a missing constant; only this can.
  #
  # `gate_word_is_literal` is named for a third reason: it is the ONLY thing
  # standing between the walk and a word whose expansion this gate cannot see.
  # A library predating it makes the `if ! gate_word_is_literal ...` call exit
  # 127, which `!` reads as TRUE, so every word would look unaccountable and the
  # gate would block everything -- loud, but a gate that refuses `git checkout
  # main` is as unusable as one that allows a switch. Refusing here says why.
  echo "Blocked: .claude/hooks/lib/command-match.sh is missing or unloadable," >&2
  echo "so this gate cannot evaluate the command. Restore the file; do not" >&2
  echo "work around the gate." >&2
  exit 2
fi

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Match `git switch` / `git checkout` in the subcommand position.
# Matching goes through the SHARED command-position matcher
# (.claude/hooks/lib/command-match.sh, issue #1455): heredoc bodies and
# quoted spans are stripped, then the verb is matched at line start OR
# after a `&&` / `||` / `;` / `|` operator. That catches chained
# invocations the old line-start anchor missed, while a quoted mention
# still does not fire (it is removed rather than dodged by position).
if ! gate_matches "$cmd" "$GATE_RE_GIT_SWITCH"; then
  exit 0
fi

# Canonicalize a path before comparing. macOS resolves `/tmp` -> `/private/tmp`
# and `/var` -> `/private/var` via symlinks; `git worktree list --porcelain`
# always emits the real path, while the user's cwd may still carry the symlink.
# `cd <dir> && pwd -P` is the portable canonicalizer (BSD readlink lacks `-f`
# until 12+).
canonicalize() {
  local p="$1"
  if [[ -d "$p" ]]; then
    (cd "$p" 2>/dev/null && pwd -P) || printf '%s' "${p%/}"
  else
    printf '%s' "${p%/}"
  fi
}

# main_tree_of <dir>
#
# Print the MAIN worktree's path when <dir> IS that worktree AND the repo opts
# into the convention; print nothing and return 1 otherwise.
#
# Called PER MATCHED SEGMENT. `-C` and a preceding `cd` can put two segments of
# one command in two different trees, and this gate's verdict is per segment, so
# asking this question once for the whole command gets BOTH directions wrong.
# Measured against the real main checkout and the real linked worktree, payload
# cwd = the main tree, before this was per-segment:
#
#   git -C <worktree> switch -c a && git switch -c b     rc=0, want 2  BYPASS
#   git -C <worktree> checkout -b a && git checkout -b b rc=0, want 2  BYPASS
#   git switch main && git -C <worktree> switch -c a     rc=2, want 0  FALSE BLOCK
#
# The bypass is the same family as the `git fetch && git switch -c` one this
# gate closed one commit earlier: the tree was resolved from segment 1, the gate
# stood down for the whole command, and segment 2 -- in the SHARED main tree --
# was never judged. The false block refuses a branch creation in a linked
# worktree, which is precisely what the worktree convention mandates.
#
#
# LIMIT, stated rather than hidden. `gate_segments` FLATTENS a subshell, so a
# `cd` inside one leaks past the closing paren and steers every later segment:
#
#   (cd <worktree> && git switch -c a) && git switch -c b
#
# resolves segment 3 to the worktree and PASSES. Measured from the real main
# checkout, rc=0 where 2 is wanted -- and measured the same against the hook
# BEFORE the per-segment change, so this is a pre-existing bound rather than one
# that change introduced. Closing it means teaching the shared segmenter to
# report subshell depth, which is a change to every gate that calls it, not to
# this one. The exposure is narrow in the other direction too: the false-BLOCK
# twin cannot happen, since a leaked `cd` can only ever make the gate quieter.
# `git rev-parse --show-toplevel` returns the CURRENT worktree's top, which
# differs between the main tree and any `.claude/worktrees/<x>/`. Cheaper
# heuristic: the main worktree is whatever `git worktree list` lists first.
#
# ONE-ENTRY memo, WHICH THE SIBLING cdk-local DOES NOT HAVE -- stated because the
# argument for this gate is "one function with two homes", so a reader of either
# file should be able to see where the two stop agreeing. That copy forks
# `git worktree list` once per matching segment; this one caches. The divergence
# lived only in a commit message until 2026-09-02.
#
# Every ordinary command's segments share a tree, and a miss
# costs a `git worktree list` fork inside a PreToolUse hook that runs on every
# Bash call. bash 3.2 has no associative arrays and a deeper cache buys nothing
# at these sizes.
#
# The answer comes back in the GLOBAL `mt_result`, not on stdout, and that is
# what makes the memo real. Read as `seg_main=$(main_tree_of "$dir")` the
# function ran in a COMMAND SUBSTITUTION -- a subshell -- so both memo variables
# were written into a child that exited immediately and every segment forked
# `git worktree list` again. Measured before the change: a 3-segment same-tree
# command forked it 3 times, under this very comment claiming a saving. A
# fork-counting case in the suite now pins the count at 1.
_mt_memo_dir=""
_mt_memo_val=""
mt_result=""
main_tree_of() {
  local dir="$1" mt
  mt_result=""
  if [ "$dir" = "$_mt_memo_dir" ]; then
    [ -n "$_mt_memo_val" ] || return 1
    mt_result="$_mt_memo_val"
    return 0
  fi
  _mt_memo_dir="$dir"
  _mt_memo_val=""
  mt=$(git -C "$dir" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0, 10); exit}')
  # Not in a git repo / cannot resolve -- pass through (we do not gate what we
  # cannot see).
  [ -n "$mt" ] || return 1
  # Repo opt-in scope (issue #1259): only repos following the worktree +
  # markgate convention get main-tree branch protection. Unrelated repos (a
  # personal blog, a scratch clone) have no parallel-agent contention on their
  # main tree. Opt-in signal: a `.markgate.yml` at the main worktree root.
  [ -f "$mt/.markgate.yml" ] || return 1
  # A LINKED worktree (`.claude/worktrees/<x>/` or similar) is exactly where the
  # convention wants feature branches, so it is not gated.
  [ "$(canonicalize "$dir")" = "$(canonicalize "$mt")" ] || return 1
  _mt_memo_val="$mt"
  mt_result="$mt"
}


# remote_dwim_names <dir>
#
# One candidate DWIM name per line: the names `git checkout <name>` may CREATE a
# local branch for and switch to, because a remote carries them. Two things it
# must get right, both measured against real git 2.53 on a fixture clone:
#
#   SYMREFS ARE NOT BRANCHES. `refs/remotes/<remote>/HEAD` exists in essentially
#     every clone, and `%(refname:lstrip=3)` renders it as the bare name `HEAD`.
#     Real git leaves HEAD exactly where it was for `git checkout HEAD`
#     (measured: "Your branch is ahead of 'origin/main'", HEAD stayed `main`), so
#     a list carrying it false-blocks a read-only command. `git branch HEAD` is
#     refused by git itself, so dropping symrefs costs no real candidate.
#
#   A REMOTE NAME MAY CONTAIN A SLASH, so a fixed `lstrip=3` is wrong. `git
#     remote add a/b <url>` is accepted -- measured -- and the branch `deep-only`
#     on it lands at `refs/remotes/a/b/deep-only`, which lstrips to
#     `b/deep-only` while git DWIMs plain `deep-only` ("Switched to a new branch
#     'deep-only'", HEAD moved). A gate comparing against `b/deep-only` PASSES
#     that switch -- measured against this gate before this function replaced the
#     `lstrip=3` scan: rc=0 where 2 is wanted. The prefix is therefore stripped
#     PER REMOTE using the remote's own name, so it is right whatever the name
#     contains.
#
# ITERATING THE CONFIGURED REMOTES is also what makes the list stop at what git
# will actually DWIM. A ref can sit under `refs/remotes/<name>/` with no remote
# `<name>` configured -- `git update-ref` puts one there, and a removed remote
# can leave one behind. Measured: with `refs/remotes/ghostremote/ghost` present
# and no `ghostremote` remote, `git checkout ghost` answers "pathspec 'ghost'
# did not match any file(s) known to git" and HEAD stays -- while a scan of
# `refs/remotes/` alone offered `ghost` as a candidate and this gate blocked it.
#
# WHAT IT DOES NOT CHECK, stated because an earlier wording claimed it did: there
# is no UNIQUENESS check. With the same name on two remotes git REFUSES ("hint:
# If you meant to check out a remote tracking branch on, e.g. 'origin'", HEAD
# stays -- measured) while this list still offers the name and the gate blocks.
# That is the conservative direction, so the behaviour stays; the claim that the
# list holds only names "exactly one remote carries" does not.
#
# The pattern stays the PREFIX `refs/remotes/<remote>/`, never `.../*/*`: in
# `for-each-ref` a `*` does not cross a `/`, so the two-star form misses every
# slashed BRANCH name (`origin/topic/nested`), which is most of them in this flow.
remote_dwim_names() {
  local dir="$1" remote refname symref
  while IFS= read -r remote; do
    [ -n "$remote" ] || continue
    # `%(refname)` FIRST and the symref second: with `IFS=<tab>` a LEADING empty
    # field is eaten (tab is IFS whitespace), so the symref-first spelling shifts
    # every ordinary ref's name into the wrong variable. In this order the
    # `IFS=$'\t' read` spelling is safe -- git refuses a ref name containing any
    # ASCII control character, tab included, so neither field can hold a tab run
    # for `read` to fold.
    while IFS=$'\t' read -r refname symref; do
      [ -n "$refname" ] || continue
      [ -z "$symref" ] || continue
      printf '%s\n' "${refname#refs/remotes/$remote/}"
    done < <(git -C "$dir" for-each-ref \
      --format=$'%(refname)\t%(symref)' "refs/remotes/$remote/" 2>/dev/null)
  done < <(git -C "$dir" remote 2>/dev/null)
}

# The LONG-OPTION grammar of each verb, transcribed from `git checkout -h` /
# `git switch -h` (git 2.53.0), one `<name>:<arity>` per line:
#
#   0   takes nothing
#   1   REQUIRES a value, which the spaced spelling takes from the NEXT token
#   ?   OPTIONAL value, which the spaced spelling does NOT take -- measured,
#       `git checkout -t origin/remote-only` creates local `remote-only`, so the
#       ref that follows is a start-point POSITIONAL and not the flag's argument
#
# It is COMPLETE rather than a list of the interesting flags, and that is
# load-bearing twice over.
#
#   git ACCEPTS ANY UNAMBIGUOUS PREFIX of a long name, which `-h` does not show
#     and an earlier revision of this parse took from `-h` alone. Measured:
#     `git checkout --orph newb` prints "Switched to a new branch 'newb'",
#     `git checkout --or newb` does the same (`orphan` is the only name starting
#     `or`), and `git checkout --trac origin/<b>` creates local `<b>` and
#     switches. All three scored rc=0 against this gate before the table existed.
#     A prefix can only be resolved against the WHOLE name set, so a table
#     holding just the flags this gate cares about would answer "unknown" for
#     `--or` one day and "ambiguous" the next as the set changed.
#
#   AN UNMODELLED VALUE-TAKING FLAG MOVES EVERY POSITIONAL AFTER IT. That is the
#     `--conflict merge <branch>` defect, and it is a defect of the TABLE, not of
#     the walk.
#
# Every `--[no-]x` line in `-h` contributes BOTH `x` and `no-x`. The negated form
# takes no value and carries no effect -- measured: `git checkout --no-orphan
# some-feature` and `git checkout --no-conflict some-feature` both switch, so the
# name after them is a positional.
#
# `-h` IS NOT THE WHOLE GRAMMAR, and reading it as though it were is what made
# this gate block commands git runs. Four options are accepted and not printed
# there, three of them with rc=0 (measured, git 2.53.0, HEAD printed before and
# after):
#
#   --end-of-options              rc=0;   stops option parsing (gitcli(7))
#   --git-completion-helper       rc=0;   prints the completion list
#   --git-completion-helper-all   rc=0;   prints it including hidden entries
#   --help-all                    rc=129; prints the usage, HEAD unmoved
#
# All four are `parse-options` built-ins rather than checkout's own, so they
# exist under BOTH verbs -- confirmed for each, e.g. `git switch
# --end-of-options main` answers "Already on 'main'". They are at arity 0.
#
# THREE ARITIES HERE ARE INERT, and that is deliberate rather than an oversight:
# `create:1`, `force-create:1` and `orphan:1` never take effect, because the
# arity line sets `pending=skip` and the effect arm for those three immediately
# overrides it with `pending=value` (the token IS the branch name, and it has to
# be captured rather than merely consumed). They are written at their true arity
# anyway, because this table's job is to state git's grammar -- lowering them to
# 0 to match the code path would make the table lie about git and would break
# the moment the effect arm changed.
#
# NOTHING PINS THESE TABLES TO THE INSTALLED GIT, stated as a residual rather
# than hidden. A wholly NEW option name lands on `parse_certain=0` and blocks
# (verified with `--frobnicate`), and a newly AMBIGUOUS prefix is moot because
# git refuses the command as well. What would pass silently is an ARITY CHANGE
# to a name already here -- `--track` going from optional to required, say --
# because the walk would then consume the wrong token and could ALLOW.
# Regenerating from `--git-completion-helper-all` would catch a new NAME but not
# an arity change, so it is not the fix it looks like.
GATE_CHECKOUT_LONG_OPTS='help:0
help-all:0
end-of-options:0
git-completion-helper:0
git-completion-helper-all:0
guess:0
no-guess:0
overlay:0
no-overlay:0
quiet:0
no-quiet:0
recurse-submodules:?
no-recurse-submodules:0
progress:0
no-progress:0
merge:0
no-merge:0
conflict:1
no-conflict:0
detach:0
no-detach:0
track:?
no-track:0
force:0
no-force:0
orphan:1
no-orphan:0
overwrite-ignore:0
no-overwrite-ignore:0
ignore-other-worktrees:0
no-ignore-other-worktrees:0
ours:0
theirs:0
patch:0
no-patch:0
unified:1
inter-hunk-context:1
ignore-skip-worktree-bits:0
no-ignore-skip-worktree-bits:0
pathspec-from-file:1
no-pathspec-from-file:0
pathspec-file-nul:0
no-pathspec-file-nul:0'

GATE_SWITCH_LONG_OPTS='help:0
help-all:0
end-of-options:0
git-completion-helper:0
git-completion-helper-all:0
create:1
no-create:0
force-create:1
no-force-create:0
guess:0
no-guess:0
discard-changes:0
no-discard-changes:0
quiet:0
no-quiet:0
recurse-submodules:?
no-recurse-submodules:0
progress:0
no-progress:0
merge:0
no-merge:0
conflict:1
no-conflict:0
detach:0
no-detach:0
track:?
no-track:0
force:0
no-force:0
orphan:1
no-orphan:0
overwrite-ignore:0
no-overwrite-ignore:0
ignore-other-worktrees:0
no-ignore-other-worktrees:0'

# resolve_long_opt <verb> <name-without-dashes>
#
# Answers in the globals `gate_long` (the canonical name) and `gate_long_arity`.
# Returns 0 on a resolved name, 1 on an unknown one, 2 on an AMBIGUOUS prefix --
# and git's own answers for those two are "error: unknown option" and "error:
# ambiguous option", both of which abort the command without touching HEAD.
# An EXACT match wins over any prefix, as it does in git's parse-options.
gate_long=""
gate_long_arity=""
resolve_long_opt() {
  local verb="$1" name="$2" table n a hits=0
  gate_long=""
  gate_long_arity=""
  if [ "$verb" = switch ]; then table="$GATE_SWITCH_LONG_OPTS"; else table="$GATE_CHECKOUT_LONG_OPTS"; fi
  while IFS=: read -r n a; do
    [ -n "$n" ] || continue
    if [ "$n" = "$name" ]; then
      gate_long="$n"
      gate_long_arity="$a"
      return 0
    fi
  done <<EOF
$table
EOF
  while IFS=: read -r n a; do
    [ -n "$n" ] || continue
    # `$name` is QUOTED so a glob character inside it is literal; the trailing
    # `*` is the only wildcard.
    case "$n" in
      "$name"*) hits=$((hits + 1)); gate_long="$n"; gate_long_arity="$a" ;;
    esac
  done <<EOF
$table
EOF
  [ "$hits" -eq 1 ] && return 0
  gate_long=""
  gate_long_arity=""
  [ "$hits" -eq 0 ] && return 1
  return 2
}

# verdict_for <verb> <args> <dir>
# 0 = this segment must be BLOCKED (with `target_branch` / `block_reason` set),
# 1 = allowed. <args> is everything after the matched verb, flags included,
# because the verb ERE already consumed the leading `git -C ... ` flag run.
#
#   `git switch <main|master>`             -> allow
#   `git checkout <main|master>`           -> allow
#   `git switch -- <main|master>`          -> allow (`--` under switch only ends
#                                            the options; switch has no pathspec)
#   `git switch -c|-C|--create|--force-create <branch>` -> block
#   `git switch|checkout --orphan <branch>`             -> block
#   `git switch <other-branch>` / `git switch -- <other-branch>` -> block
#   `git switch|checkout -` / `@{-1}`      -> block (previous branch, unknowable)
#   `git switch --detach`                  -> block
#   `git checkout -b|-B <branch>`          -> block
#   `git switch|checkout -t|--track <remote-ref>` -> block (DWIM create + switch)
#   `git checkout <other-branch>`          -> block when NO pathspec operand
#                                            follows it AND it names a LOCAL
#                                            branch or a branch on a CONFIGURED
#                                            remote
#   `git checkout <branch> --`             -> block: a `--` with nothing after it
#                                            leaves no pathspec, so this is the
#                                            switch (measured: HEAD moved)
#   `git checkout [<tree-ish>] -- <paths>` -> allow (file restore)
#   `git checkout <tree-ish> <paths>`      -> allow (file restore, no `--`)
#   `git checkout -p|--ours|--theirs|--pathspec-from-file ...` -> allow (restore)
#   `git checkout --no-guess <remote-only-name>` -> allow (DWIM is off; measured,
#                                            "pathspec did not match", HEAD stays)
#   `git checkout <sha>` / `HEAD`          -> allow (detached HEAD / a rev)
#   `git switch|checkout --help`           -> allow
#
# A REAL OPTION PARSE over git's ARGV. Three properties carry the whole design,
# and each replaced a class of defect rather than a spelling:
#
# 1. THE INPUT IS ARGV, NOT SHELL WORDS. `gate_argv` drops the words the SHELL
#    owns -- a redirection and its target, a trailing `&`, a `#` comment -- so
#    they cannot be miscounted as arguments. Reading `gate_tokens` output
#    directly made `git checkout <branch> 2>/dev/null`, `... >/dev/null 2>&1` and
#    `... # switch lane` read as two-positional file restores and PASS; all three
#    really move HEAD (measured, `main` -> `some-feature`).
#
# 2. FLAGS ARE RESOLVED AGAINST A COMPLETE GRAMMAR, prefixes included (see the
#    tables above), and a SHORT token is walked as a CLUSTER because git's
#    parse-options accepts `-qbfeat` as `-q -b feat` and takes the remainder of
#    the cluster as a value-taking letter's value. Every glued spelling --
#    `-bfeat`, `-Bfeat`, `-cfeat`, `-Cfeat`, `--create=feat`, `--orphan=feat` --
#    was measured creating the branch and switching to it.
#
# 3. AN INCOMPLETE PARSE MAY NOT ALLOW. When a long name resolves to no entry or
#    to more than one, or a cluster letter is unknown, the walk does not know
#    where the positionals are -- it cannot tell whether the flag would have
#    eaten the next token. Every arm below that ALLOWS depends on that knowledge;
#    the arms that BLOCK do not. So an unresolved option sets `parse_certain=0`
#    and the verdict is a conservative block naming the option. This is the
#    general form of the two defects that a POSITIONAL COUNT produced -- first
#    `--conflict merge <branch>` (a value read as a positional), then
#    `<branch> 2>/dev/null` (a shell word read as a positional). Both were the
#    count RELAXING a verdict on a parse that was not complete.
#
#    IT DOES NOT COST NOTHING, and the claim that it did was measured FALSE. The
#    arm was documented as firing "only on commands git itself refuses". Against
#    git 2.53.0 it also fired on three git ACCEPTS: `git checkout
#    --end-of-options main` (rc=0, HEAD stays), `--end-of-options -- f.txt`
#    (rc=0, restores) and `--git-completion-helper` (rc=0, prints the list).
#    Those are in the tables now. The residual trade is stated instead of
#    denied: an option this gate has never heard of is blocked even when git
#    would run it, because the alternative is to GUESS an arity, and a wrong
#    arity moves every positional after it. A false block costs one message
#    naming the option; a false allow costs a switched shared main tree.
#
# 4. A WORD THE SHELL OWNS MAY NOT RELAX EITHER. Property 3 is stated for git's
#    OPTIONS, and for three rounds `gate_argv` did the opposite for the shell's
#    WORDS: it enumerated the forms it recognised -- a redirection, a trailing
#    `&`, a `#` comment -- and passed everything else through as an argument.
#    Each round added a spelling and the next round found the one still missing.
#    Last time that was `$EMPTY` / `${EMPTY}` (an empty expansion VANISHES, so a
#    positional git never receives was counted) and `{fd}>/dev/null` (bash's
#    fd-variable redirection, a word git never receives at all). Both made
#    `git checkout <branch> <word>` read as a two-positional FILE RESTORE and
#    PASS -- measured rc=0 where 2 is wanted, on commands that really move HEAD.
#
#    The default is therefore INVERTED rather than the list extended. Every word
#    goes through `gate_word_is_literal`, which admits one only when each of its
#    characters is on a closed list of characters the shell does not act on, and
#    a word that fails sets `parse_certain=0`.
#
#    HOW WE KNOW A SHAPE NOBODY HAS THOUGHT OF LANDS ON BLOCK. Every shell
#    construct is SPELLED, and spelled with characters. A construct outside that
#    closed list -- one added to a future bash, one nobody here has met, one not
#    written down anywhere -- necessarily contains a character the list does not
#    hold, and is refused without anyone having enumerated it. The only escape
#    would be a construct spelled ENTIRELY in inert characters, and an inert
#    character is by definition one the shell does not act on. So the surface to
#    audit is the LIST (in the shared library, with a reason recorded per
#    member), not a catalogue of shell forms.
#
#    THE COST IS OVER-STRICTNESS, and it is real: `git checkout main -- "$f"` is
#    a file restore, and this gate now blocks it, because it cannot see what
#    `$f` holds. That cost was MEASURED rather than assumed, because inverting a
#    default trades a silent class of bypasses for a loud class of false
#    refusals and the trade is only defensible if the second number is known.
#    Every `git checkout` / `git switch` in the three sibling repos' committed
#    files was replayed through the hook before and after (payload cwd = a real
#    main checkout, `<branch>` a branch that exists there):
#
#      corpus                                       206 distinct texts
#      verdict changed 0 -> 2 (newly blocked)        32
#        ...of those, documentation metasyntax
#           (`<branch>`, `[<options>]`, table rows)  30
#        ...runnable commands                         2
#      verdict changed 2 -> 0 (newly allowed)         2   the `#`-comment fix
#
#    Narrowed to lines that actually EXECUTE -- excluding `*.test.sh` and
#    comment lines -- the three repos hold exactly two `git checkout`
#    invocations between them, both `git checkout -- "${WATCH_SRC}"` inside
#    `tests/integration/local-start-api/verify.sh`. Neither is reachable by this
#    hook: they run from a fixture subdirectory rather than the main worktree
#    top level, and they run INSIDE a script, where a PreToolUse hook sees only
#    `bash .../verify.sh`. So the measured false-block count on commands this repo
#    actually runs is ZERO, and the escape when it is not is named in the
#    message: spell the path literally, or run from outside the main tree, which
#    is what the convention asks for anyway.
#
# The positional structure this parse still reads is the one GIT reads, and it is
# a boolean rather than a tally: `first_pos` (the switch target) and
# `pathspec_seen` (a pathspec operand exists). Git's own grammar is
# `git checkout [<options>] <branch>` OR
# `git checkout [<options>] [<branch>] -- <file>...`, so no correct gate can
# avoid asking whether an operand follows the target -- `git checkout <branch>
# <path>` restores a file and leaves HEAD alone while `git checkout <branch>`
# switches, and only the extra operand tells them apart (both measured). What is
# fixed is WHAT is examined: git's argv, fully parsed, or nothing.
#
# Verdicts settled against real git first, printing HEAD and the local branch
# list before and after. The defects this parse replaced, in the order found:
#
#   git checkout <branch> -- <paths>   was BLOCKED, and must not be: it restores
#     FILES and leaves HEAD alone. `git checkout <branch> <paths>` without the
#     `--` behaves identically. go-to-k/cdk-real-drift MANDATES the `--` spelling
#     for its integration step, so the old reading refused a sibling repo's own
#     documented flow.
#
#   git checkout <branch> --           was ALLOWED once that fix shipped, and
#     must not be: a `--` with NOTHING after it leaves no pathspec at all.
#     Measured -- "Switched to branch 'some-feature'", HEAD moved. The rule is
#     therefore "a pathspec operand exists", not "a `--` was seen".
#
#   git switch -- main                 was BLOCKED, and must not be: `git switch`
#     has NO pathspec form (`usage: git switch [<options>] [<branch>]`), so `--`
#     there only ends the options. Measured -- "Already on 'main'". The same
#     token walk was applying checkout's grammar to both verbs, and the command
#     landed on the "no resolvable target" arm. `git switch -- <feature>` DOES
#     switch (measured), so that one still blocks.
#
#   git checkout -f <branch>           was ALLOWED: `-f` was read AS the branch
#     name, `refs/heads/-f` does not resolve, and the gate passed.
#
#   git checkout --orphan <branch>     was ALLOWED: `--orphan` was read as the
#     branch name.
#
#   git checkout <name> / -t origin/<name>
#     were ALLOWED. With no LOCAL `<name>` but a remote carrying it, both CREATE
#     the local branch and switch -- measured, HEAD went `main` -> `feat`. That is
#     how a lane's branch usually FIRST appears in a checkout.
#
#   git checkout -  /  git checkout @{-1}   were ALLOWED while `git switch -`
#     blocked. Measured -- both print "Switched to branch 'other'" and move HEAD.
#
#   git checkout --conflict merge <branch>   was ALLOWED: `merge` inflated a
#     positional count and the command read as a restore. Measured -- it switches.
#
#   git checkout --orph <branch> / --trac origin/<b> / --or <b>   were ALLOWED:
#     git accepts unambiguous PREFIXES of a long name and the parse only knew the
#     full spellings. Measured -- all three move HEAD.
#
#   git checkout deep-only             was ALLOWED where `deep-only` lives on a
#     remote whose NAME contains a slash. Measured -- "Switched to a new branch
#     'deep-only'". The DWIM list was built with a fixed `lstrip=3`.
#
#   git checkout ghost                 was BLOCKED where `refs/remotes/ghostremote/ghost`
#     exists with NO `ghostremote` remote configured. Measured -- "pathspec
#     'ghost' did not match", HEAD stays.
#
#   git checkout --pathspec-from-file <f> <branch>   was BLOCKED: the pathspecs
#     come FROM THE FILE, so the trailing token is the tree-ish and the command is
#     a RESTORE. Measured -- "Updated 1 path from ...", HEAD stayed `main`. The
#     flag had been filed with `--conflict` as merely value-taking.
#
#   git checkout --no-guess <remote-only-name>   was BLOCKED: `--no-guess` turns
#     the DWIM off, so git answers "pathspec did not match" and HEAD stays --
#     measured, against a name that DID move HEAD without the flag.
#
# `--detach` stays asymmetric between the verbs: `git switch --detach` blocks
# while `git checkout <sha>` / `git checkout --detach <sha>` passes. That is the
# behaviour this gate shipped with, kept rather than silently changed here --
# but the rationale it shipped with, "the sha form is read-only inspection", is
# FALSE and is not repeated. `git checkout <sha>` REWRITES the shared working
# tree and leaves a detached HEAD, and the detached HEAD then disarms the
# sibling gate: `branch-gate.sh` reads
# `git -C <dir> symbolic-ref --short HEAD`, which is EMPTY while detached, and
# falls through to its `exit 0`. Measured in a throwaway repo carrying a
# `.markgate.yml`, driving branch-gate with `git commit -m x`: rc=2 on `main`,
# rc=0 once detached. So allowing the sha form leaves a two-step path to an
# ungated commit in the main checkout. Changing the verdict is a behaviour
# change with its own blast radius (it would refuse a legitimate inspection
# spelling in three repos) and belongs in its own PR, not smuggled into a parse
# fix -- recorded here and in .claude/rules/hooks.md so the next reader inherits
# the measurement rather than the old claim. What IS fixed here is the WORDING:
# `git checkout -d <branch>` / `--detach <branch>` really detaches (measured,
# HEAD went to a raw sha), and the block used to announce it as "switches to
# feature branch '<branch>'" -- a verdict that was right about an operation git
# would not perform.
#
# KNOWN BOUND, in the message rather than the verdict: `gate_segments` truncates
# a segment at a `}`, so `git switch -c 'feat/{id}'` blocks correctly but the
# message and its `git worktree add` recipe name `feat/{id` . The cause is in the
# shared splitter, which every gate in the library calls; it is recorded in
# .claude/rules/hooks-main-tree-branch.md rather than worked around here.
verdict_for() {
  local verb="$1" rest="$2" dir="$3"
  local tok pending="" create_val="" create_flag="" detach_flag="" track_flag=""
  local prev_ref="" bad_opt="" bad_word="" raw_tok="" argv="" argv_rc=0
  local saw_help=0 saw_restore=0 end_opts=0 dashdash_seen=0 no_guess=0
  local detach_seen=0 pathspec_seen=0 parse_certain=1 is_pos=0
  local npos=0 first_pos="" name lval lhas letters ch rc
  target_branch=""
  block_reason=""

  # The argument text must be splittable into shell words at all. It is NOT when
  # a quote is unbalanced, and `gate_argv` reports that rather than returning a
  # truncation -- `-b agent's-branch` used to yield the single token `-b`, which
  # read as a bare `git checkout` and PASSED. Refusing is the deliberate choice
  # over a coarser second scan: bash refuses to run that text at all ("unexpected
  # EOF while looking for matching `''"), so nothing legitimate is lost, and the
  # message says exactly why.
  #
  # A `#` COMMENT IS NO LONGER PART OF THAT QUESTION. `gate_argv` cuts one before
  # it splits, so an apostrophe inside a comment is never weighed as a quote:
  # `git checkout main # don't switch lanes` blocked here until round 4, on a
  # command bash calls valid and git answers with "Already on 'main'".
  #
  # CAPTURED ONCE. This used to call `gate_argv` for the rc and again to feed the
  # walk -- two parses of one text, and two chances for them to disagree.
  argv=$(gate_argv "$rest")
  argv_rc=$?
  if [ "$argv_rc" -ne 0 ]; then
    target_branch=""
    block_reason="carries an argument list this gate cannot split into shell words (unbalanced quote), so its target cannot be read -- block conservatively"
    return 0
  fi

  while IFS= read -r raw_tok; do
    # A here-string over an EMPTY capture still yields one blank line, and a
    # blank word must not be counted as a positional: it made a bare
    # `git checkout` read as `git checkout ''`, whose DWIM probe
    # (`grep -qxF -- ""`) matches every remote branch name there is.
    [ -n "$raw_tok" ] || continue
    # EVERY WORD IS PROVED LITERAL BEFORE ANY ARM READS IT -- property 4 in the
    # header, the same "an incomplete parse may not ALLOW" fence applied to the
    # SHELL's grammar instead of git's. `gate_argv` prints the words that are
    # neither a redirection nor a comment; it does not promise they reach git as
    # the text printed, and `$EMPTY` / `{fd}>/dev/null` are two measured shapes
    # where they do not.
    #
    # ONE SHAPE IS EXEMPT, and the exemption is PROVED rather than assumed: a
    # word beginning with the literal characters `@{-`. No expansion can produce
    # or remove those three characters, so such a word always survives as at
    # least one word -- it can never VANISH, which is the only direction that
    # turns a switch into a file restore. Its verdict here is the previous-branch
    # BLOCK, and the only thing that relaxes that is MORE positionals, which an
    # expansion can only add. Without the exemption the walk would still block
    # `git checkout @{-1}` (right) but also `git checkout @{-1} -- README.md`,
    # which restores a file and leaves HEAD alone -- measured, and a case in this
    # suite. `gate_segments` truncates the segment at the `}`, so the word
    # arriving here is `@{-1`; the pattern is the prefix for that reason.
    case "$raw_tok" in
      '@{-'*) : ;;
      *)
        if ! gate_word_is_literal "$raw_tok"; then
          parse_certain=0
          [ -n "$bad_word" ] || bad_word="$raw_tok"
        fi
        ;;
    esac
    tok=$(gate_unquote "$raw_tok")
    is_pos=0
    if [ -n "$pending" ]; then
      # `value` is a branch name; `skip` is some other flag's required argument,
      # consumed only so it cannot be miscounted as a positional.
      [ "$pending" = value ] && create_val="$tok"
      pending=""
    elif [ "$end_opts" -eq 1 ]; then
      is_pos=1
    else
      case "$tok" in
        # `--` ends the options. Under CHECKOUT everything after it is a
        # pathspec; under SWITCH there is no pathspec form, so what follows is
        # still the branch. Both measured.
        # `dashdash_seen` carries the PATHSPEC half separately, because
        # `--end-of-options` ends the options too and does NOT give what follows
        # checkout's pathspec meaning -- measured, `git checkout
        # --end-of-options some-feature` really switches.
        --) end_opts=1; dashdash_seen=1 ;;
        # `-` and `@{-N}` name the PREVIOUS branch under BOTH verbs. The pattern
        # is the PREFIX `@{-`, without the closing brace, and that is measured
        # rather than sloppy: `gate_segments` TRUNCATES a segment at a `}`, so
        # the shared walk hands this gate `git checkout @{-1` for an input of
        # `git checkout @{-1}`. A pattern requiring the `}` matched nothing.
        -|@{-*) prev_ref="$tok"; is_pos=1 ;;
        --*)
          # A long flag. Split on the FIRST `=`, so the glued and spaced
          # spellings of a value-taking flag reach the same arm, then resolve the
          # NAME against the verb's grammar -- exact match, else unique prefix.
          case "$tok" in
            --*=*) name="${tok%%=*}"; lval="${tok#*=}"; lhas=1 ;;
            *)     name="$tok";       lval="";          lhas=0 ;;
          esac
          resolve_long_opt "$verb" "${name#--}"
          rc=$?
          if [ "$rc" -ne 0 ]; then
            parse_certain=0
            [ -n "$bad_opt" ] || bad_opt="$name"
          else
            # A REQUIRED value that is not glued comes from the next token. The
            # effect arms below override `skip` with `value` where the argument
            # is the branch name itself.
            [ "$gate_long_arity" = 1 ] && [ "$lhas" -eq 0 ] && pending=skip
            case "$gate_long" in
              help) saw_help=1 ;;
              create|force-create|orphan)
                create_flag="--$gate_long"
                if [ "$lhas" -eq 1 ]; then create_val="$lval"; else pending=value; fi
                ;;
              track) track_flag="--track" ;;
              detach)
                detach_seen=1
                [ "$verb" = switch ] && detach_flag="--detach"
                ;;
              # File-restore markers. `--pathspec-from-file` belongs HERE and not
              # with the merely value-taking flags: the pathspecs come from the
              # FILE, so a trailing token is the tree-ish and the command is a
              # restore (measured: "Updated 1 path", HEAD stayed). Its value is
              # still consumed, by the arity line above.
              patch|ours|theirs|pathspec-from-file) saw_restore=1 ;;
              # `--pathspec-file-nul` is NOT a restore marker on its own: real git
              # refuses it without `--pathspec-from-file` ("fatal: the option
              # '--pathspec-file-nul' requires '--pathspec-from-file'"), so it
              # never appears in an accepted command that this arm would need to
              # judge.
              guess) no_guess=0 ;;
              no-guess) no_guess=1 ;;
              # `--end-of-options` stops OPTION parsing without making the next
              # token a pathspec -- gitcli(7)'s idiom for a script handling an
              # untrusted ref. Measured against git 2.53.0: `--end-of-options
              # main` stays on main, `--end-of-options -- f.txt` restores, and
              # `--end-of-options some-feature` SWITCHES. So it sets `end_opts`
              # and NOT `dashdash_seen`, and the third shape blocks through the
              # ordinary local-branch arm rather than through a special case.
              end-of-options) end_opts=1 ;;
              # `--help-all` / `--git-completion-helper[-all]` are accepted and
              # carry no effect on the positionals; they are in the tables so
              # they resolve rather than land on the unknown-option block.
              *) : ;;
            esac
          fi
          ;;
        -?*)
          # A SHORT flag CLUSTER: git's parse-options accepts `-qbfeat` as
          # `-q -b feat`, so the letters are walked one at a time and a
          # value-taking letter takes the REST of the token as its value, or the
          # next token when nothing is left.
          letters="${tok#-}"
          while [ -n "$letters" ]; do
            ch="${letters%"${letters#?}"}"
            letters="${letters#?}"
            case "$verb:$ch" in
              checkout:b|checkout:B|switch:c|switch:C)
                create_flag="-$ch"
                if [ -n "$letters" ]; then create_val="$letters"; letters=""
                else pending=value; fi
                ;;
              *:h) saw_help=1 ;;
              *:t)
                # OPTIONAL value: anything glued after `t` IS that value, and the
                # SPACED form consumes nothing -- measured, `git checkout -t
                # origin/remote-only` creates local `remote-only`, so the ref is
                # a start-point positional.
                track_flag="-t"
                letters=""
                ;;
              *:d)
                detach_seen=1
                [ "$verb" = switch ] && detach_flag="-d"
                ;;
              checkout:p|checkout:2|checkout:3) saw_restore=1 ;;
              checkout:U)
                # REQUIRED value.
                if [ -n "$letters" ]; then letters=""; else pending=skip; fi
                ;;
              *:q|*:m|*:f|checkout:l) : ;;
              *)
                # An unrecognised letter. git answers "error: unknown switch" and
                # aborts; this walk cannot know whether the letter would have
                # taken the rest of the cluster or the next token, so it stops
                # reading and marks the parse incomplete.
                parse_certain=0
                [ -n "$bad_opt" ] || bad_opt="-$ch"
                letters=""
                ;;
            esac
          done
          ;;
        *) is_pos=1 ;;
      esac
    fi
    if [ "$is_pos" -eq 1 ]; then
      if [ "$dashdash_seen" -eq 1 ] && [ "$verb" = checkout ]; then
        pathspec_seen=1
      else
        npos=$((npos + 1))
        if [ "$npos" -eq 1 ]; then first_pos="$tok"; else pathspec_seen=1; fi
      fi
    fi
  done <<EOF
$argv
EOF

  # THE FENCE COMES FIRST, ahead of every arm that ALLOWS -- `--help` included.
  # `saw_help` used to return above it, which made the help arm the one relaxing
  # verdict that skipped the fence this whole design rests on: `git checkout
  # --frobnicate --help` allowed. Harmless in that spelling, since git answers
  # "unknown option" and HEAD does not move, but an exemption with no argument
  # behind it is what the next round finds.
  if [ "$parse_certain" -eq 0 ]; then
    # Properties 3 and 4 in the header. The walk met an OPTION it could not
    # resolve against git's grammar, or a WORD whose expansion it cannot see, so
    # it does not know where the positionals are; refusing is the only answer
    # that cannot be wrong in the dangerous direction.
    target_branch=""
    if [ -n "$bad_opt" ]; then
      block_reason="uses an option this gate cannot resolve against \`git $verb\`'s grammar ($bad_opt), so its target cannot be read -- block conservatively"
    else
      block_reason="carries the word \`$bad_word\`, whose expansion this gate cannot see, so its target cannot be read -- block conservatively"
    fi
    return 0
  fi

  [ "$saw_help" -eq 1 ] && return 1

  if [ -n "$create_flag" ]; then
    target_branch="$create_val"
    block_reason="creates new feature branch '$target_branch'"
    return 0
  fi
  if [ -n "$detach_flag" ]; then
    # Detaching HEAD moves the SHARED tree off `main` exactly as a branch switch
    # does, so the verdict is unchanged; only the wording is, since there is no
    # branch to name.
    target_branch=""
    block_reason="detaches HEAD in the main tree (\`git switch $detach_flag\`)"
    return 0
  fi
  if [ -n "$track_flag" ] && [ "$saw_restore" -eq 0 ] && [ "$pathspec_seen" -eq 0 ] \
    && [ "$npos" -eq 1 ]; then
    # `git checkout -t origin/feat` / `git switch --track origin/feat` CREATE a
    # local `feat` and switch to it -- measured, and the local branch appeared.
    # The name is the start-point's LAST segment, so `origin/topic/x` yields `x`.
    target_branch="${first_pos##*/}"
    block_reason="creates new feature branch '$target_branch'"
    return 0
  fi
  if [ -n "$prev_ref" ] && [ "$saw_restore" -eq 0 ] && [ "$pathspec_seen" -eq 0 ] \
    && [ "$npos" -eq 1 ]; then
    target_branch="$prev_ref"
    block_reason="switches to the previous branch (\`git $verb $prev_ref\`); resolved branch unknown -- block conservatively"
    return 0
  fi

  case "$verb" in
    switch)
      case "$first_pos" in
        main|master) return 1 ;;
        "")
          # A bare `git switch` with no branch and no create flag. It is a git
          # error, but block conservatively rather than reason about a shape
          # nothing legitimate produces.
          target_branch=""
          block_reason="runs \`git switch\` in the main tree with no resolvable target -- block conservatively"
          return 0
          ;;
        *)
          target_branch="$first_pos"
          block_reason="switches to feature branch '$first_pos'"
          return 0
          ;;
      esac
      ;;
    checkout)
      # `-p` / `--ours` / `--theirs` / `--pathspec-from-file` are RESTORE modes
      # whatever the operands look like: measured, `-p <branch>` prints a diff and
      # leaves HEAD on `main`, `--ours` / `--theirs` refuse to run without paths,
      # and `--pathspec-from-file <f> <branch>` updates paths from `<branch>`.
      [ "$saw_restore" -eq 1 ] && return 1
      # A PATHSPEC OPERAND exists -- either after a `--` or as a second
      # positional. That is `git checkout [<branch>] -- <file>...`, a file
      # restore, whatever it names. Note this is the operand's EXISTENCE, not a
      # count: `git checkout <branch> --` has a `--` and no operand, and it
      # switches.
      [ "$pathspec_seen" -eq 1 ] && return 1
      # No positional at all: a bare `git checkout` or `git checkout --`, both of
      # which leave HEAD alone (measured).
      [ "$npos" -eq 0 ] && return 1
      case "$first_pos" in
        main|master) return 1 ;;
        *)
          # A branch name or a sha. A name resolving to a LOCAL branch is a
          # branch switch; so is one that resolves on a CONFIGURED REMOTE (the
          # DWIM arm below). A sha or a pathspec passes. Both questions are asked
          # of the SEGMENT's own tree, since that is where the command would run.
          if git -C "$dir" show-ref --verify --quiet "refs/heads/$first_pos" 2>/dev/null; then
            target_branch="$first_pos"
            if [ "$detach_seen" -eq 1 ]; then
              block_reason="detaches HEAD in the main tree at '$first_pos'"
            else
              block_reason="switches to feature branch '$first_pos'"
            fi
            return 0
          fi
          # DWIM. With no LOCAL `<name>` but a configured remote carrying it,
          # `git checkout <name>` CREATES the local branch and switches to it.
          # `--no-guess` turns that off, and then git answers "pathspec did not
          # match" and HEAD stays -- measured, so the arm is skipped for it.
          # `grep -qxF` is an exact whole-LINE match, so a name that is merely a
          # SUBSTRING of a remote branch does not false-block either.
          if [ "$no_guess" -eq 0 ] \
            && remote_dwim_names "$dir" | grep -qxF -- "$first_pos"; then
            target_branch="$first_pos"
            if [ "$detach_seen" -eq 1 ]; then
              block_reason="detaches HEAD in the main tree at remote branch '$first_pos'"
            else
              block_reason="creates a local branch tracking remote '$first_pos' and switches to it"
            fi
            return 0
          fi
          return 1
          ;;
      esac
      ;;
  esac
  return 1
}

target_branch=""
block_reason=""
target_dir=""
main_tree=""

# judge <verb> <verb-ere>
# Walk every matching segment WITH the tree it runs in, and stop at the first
# one that must be blocked.
#
# EVERY matching segment is considered, not just the first. A gate whose verdict
# depends on the ARGUMENTS and that reads only segment 1 has the same hole one
# operator further along -- `gate_verb_rest_each`'s own header records
# dirty-path-restore-gate falling into exactly that during the #2200 review.
#
# The two verbs are read with SEPARATE EREs because the tail cannot be judged
# without knowing which fired: `-c` creates a branch under `switch` and is a
# config override under `checkout`.
judge() {
  local verb="$1" ere="$2" line seg_dir seg_main rest
  while IFS= read -r line; do
    # Split on the FIRST tab only. `IFS=$'\t' read -r dir rest` would fold a TAB
    # RUN inside the rest -- tab is IFS whitespace -- and silently drop an
    # argument.
    seg_dir="${line%%$'\t'*}"
    rest="${line#*$'\t'}"
    if [ -z "$seg_dir" ]; then
      # This segment names its tree with an expression the parser cannot read.
      # Refuse rather than guess: gate_target_dir_strict's contract, now applied
      # per segment (go-to-k/cdkd#2027).
      gate_refuse_unresolved_target "main-tree-branch-gate" "${hook_cwd:-$PWD}"
    fi
    main_tree_of "$seg_dir" || continue
    seg_main="$mt_result"
    verdict_for "$verb" "$rest" "$seg_dir" || continue
    target_dir="$seg_dir"
    main_tree="$seg_main"
    return 0
  done < <(gate_verb_rest_each_dir "$cmd" "${hook_cwd:-$PWD}" "$ere")
  return 1
}

judge switch "$GATE_RE_GIT_SWITCH_ONLY" || judge checkout "$GATE_RE_GIT_CHECKOUT"

[[ -n "$block_reason" ]] || exit 0

# Compose the block message.
branch_slug=$(printf '%s' "${target_branch:-feature-branch}" | tr -c 'a-zA-Z0-9._/-' '-')
cat >&2 <<EOF
Blocked by main-tree-branch-gate: target git working tree IS the main worktree, and the command $block_reason.

  resolved target dir: $target_dir
  command: $cmd

The main worktree at $main_tree is a SHARED RESOURCE across parallel agents. Feature branches must live in their own worktree so concurrent agents don't clobber each other's uncommitted work (real incidents on 2026-05-24, see memory feedback_cross_agent_main_tree_contention.md).

Correct invocation:

  git worktree add .claude/worktrees/${branch_slug} -b ${target_branch:-<branch>} origin/main
  cd .claude/worktrees/${branch_slug}
  # ... your work here ...

The main tree must stay on \`main\` (or \`master\`). When done with the feature worktree:

  git worktree remove .claude/worktrees/${branch_slug}

If you genuinely need to operate on a feature branch IN the main tree (release surgery, history rewrite, etc.), the escape is to confirm with the user explicitly first — there is no flag to bypass this hook silently.
EOF

exit 2
