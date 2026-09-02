#!/usr/bin/env bash
# flatten-before-rebase-gate.sh
#
# PreToolUse hook. Blocks `git rebase <upstream>` when the target branch
# carries more than one commit AND its diff touches an APPEND-SHAPED
# generated file, steering the caller to collapse the branch first.
#
# WHY: `docs/changelog-cdkd.md` gains an entry at the same place on every
# lane, so it conflicts on nearly every parallel-lane rebase -- and a
# commit-by-commit rebase re-conflicts on it ONCE PER COMMIT. This repo
# squash-merges (`mergeCommitAllowed: false`, `rebaseMergeAllowed:
# false`), so the branch tip is the only history that survives and
# flattening loses nothing. `docs/_generated/integ-last-run.tsv` is the
# other one: keeping both sides there yields two rows for the same test,
# which its one-row-per-test invariant forbids and CI rejects.
#
# WHY A HOOK RATHER THAN A SENTENCE: the rule has been written down since
# 2026-08-25 -- `.claude/skills/work-issues/references/ship.md` section 9,
# "FLATTEN BEFORE YOU REBASE -- this is the default step, not a remedy to
# reach for once the conflicts start" -- and has been skipped on FIVE
# lanes across TWO runs anyway: three lanes on 2026-08-25, each aborted
# and redone, and both lanes of the 2026-09-02 IN-PLACE run
# (go-to-k/cdkd#2428 / go-to-k/cdkd#2450), where collapsing the branch
# turned four conflicts into one. The prose even diagnoses why it gets
# skipped -- "at the moment you type `git rebase` you have not hit a
# conflict yet" -- which names the moment a PreToolUse hook has and a
# document does not. The skill's own section 10-b: a rule already in the
# text that is violated anyway is ESCALATED, not restated.
#
# SCOPE, deliberately narrow in three ways:
#   1. Only a rebase that names an UPSTREAM. `git rebase --continue` /
#      `--abort` / `--skip` / `--quit` / `--edit-todo` are how you get OUT
#      of a rebase and must never be blocked.
#   2. Only when `rev-list --count <merge-base>..HEAD` is 2 or more.
#   3. Only when the branch's diff touches one of the append-shaped files.
#      A multi-commit rebase that cannot hit the measured conflict passes.
#
# The working tree is resolved with the shared `gate_verb_rest_each_dir`,
# so `cd <lane> && git rebase main` and `git -C <lane> rebase main` are
# both read correctly -- the second is the spelling this repo's own flow
# PRINTS (`references/gates-and-pr.md` section 7), and computing the
# counts in the hook's cwd instead would judge the main checkout in
# exactly the case the `-C` was added for.
#
# Bypass: `CDKD_SKIP_FLATTEN_GATE=1`, honoured from the environment OR
# from the command text (the `dirty-path-restore-gate` convention, PR
# go-to-k/cdkd#2371). Use it for a deliberate history-preserving rebase.
#
# FAILS OPEN on anything it cannot evaluate -- an unreadable target dir,
# an unresolvable upstream, a git error. That is the opposite of the
# fail-CLOSED posture of the branch / merge gates, and it is deliberate:
# those gates guard an irreversible action, while blocking here can wedge
# a caller mid-rebase, and the cost of a miss is one avoidable conflict.
# The LIBRARY load still fails closed, because a missing helper would
# disable the check silently rather than degrade it.

set -u

LIB_DIR="${BASH_SOURCE[0]%/*}"
[ "$LIB_DIR" = "${BASH_SOURCE[0]}" ] && LIB_DIR="."
# shellcheck source=lib/command-match.sh
if ! . "$LIB_DIR/lib/command-match.sh" 2>/dev/null \
  || ! declare -F gate_verb_rest_each_dir >/dev/null 2>&1 \
  || ! declare -F cmd_matches_verb >/dev/null 2>&1 \
  || ! declare -F gate_argv >/dev/null 2>&1 \
  || ! declare -F gate_unquote >/dev/null 2>&1 \
  || ! declare -F strip_noncommand_spans >/dev/null 2>&1 \
  || [ -z "${GATE_RE_GIT_REBASE:-}" ]; then
  echo "Blocked by flatten-before-rebase-gate: cannot load lib/command-match.sh" >&2
  exit 2
fi

input=$(cat 2>/dev/null || echo "")
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[ -n "$cmd" ] || exit 0
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# `GATE_RE_GIT_REBASE` is the STRICT form defined in lib/command-match.sh: an
# allowlist of git's real global flags, so `rebase` must be the actual
# subcommand. It is not `^git${GATE_FLAGS}...`, which let
# `git -C <lane> log --grep rebase main` match and made the first cut of this
# gate refuse a read-only query with `reset --soft` advice. The pattern lives in
# the library because unresolved-target-class.test.sh fence 1 forbids a hook
# from spelling a `-C` scan itself.
cmd_matches_verb "$cmd" "$GATE_RE_GIT_REBASE" || exit 0

case "${CDKD_SKIP_FLATTEN_GATE:-}" in 1 | true | TRUE) exit 0 ;; esac
# Read the NEUTRALISED text, not the raw command: the raw form let a mention
# inside an unrelated argument buy the bypass (measured:
# `git ... rebase main && echo "then CDKD_SKIP_FLATTEN_GATE=1 if you must"`
# passed). Same value set as the env channel, so the two cannot disagree.
_gate_bypass=$(strip_noncommand_spans "$cmd" 2>/dev/null || printf '%s' "$cmd")
case "$_gate_bypass" in
  *CDKD_SKIP_FLATTEN_GATE=1* | *CDKD_SKIP_FLATTEN_GATE=true* | *CDKD_SKIP_FLATTEN_GATE=TRUE*) exit 0 ;;
esac

# Files whose every lane appends at the same place. Keep in sync with
# `references/ship.md` section 9, which carries the resolution recipe for
# each; `tests/unit/scripts/flatten-gate-file-list-sync.test.ts` fences
# the pair so neither can drift alone.
APPEND_SHAPED='docs/changelog-cdkd.md docs/_generated/integ-last-run.tsv'

while IFS= read -r line; do
  dir=${line%%$'\t'*}
  rest=${line#*$'\t'}

  # An EMPTY dir means the segment named its tree with an expression the
  # parser cannot read. Blocking gates refuse here; this one stands down.
  [ -n "$dir" ] || continue

  # The argument shape is judged by an ALLOWLIST, and anything else stands the
  # gate down. Reading "the first bare token is the upstream" was wrong twice:
  # `git rebase --exec "make test" main` handed the flag's VALUE forward as the
  # upstream, and `git rebase <upstream> <branch>` (git's 3-arg form) judged
  # HEAD while prescribing a `reset --soft` that would collapse a branch the
  # caller never named. Enumerating value-taking flags cannot close that -- the
  # next unlisted one re-opens it -- so the shape this gate acts on is exactly
  # `rebase [valueless-flags] <one-bare-token>`, and every other shape is
  # somebody else's business.
  upstream=""
  nbare=0
  unknown=0
  while IFS= read -r tok; do
    [ -n "$tok" ] || continue
    case "$tok" in
      -q | --quiet | -v | --verbose | --stat | --no-stat | -f | --force-rebase \
        | --no-ff | --autostash | --no-autostash | --autosquash | --no-autosquash \
        | --verify | --no-verify | --fork-point | --no-fork-point \
        | --update-refs | --no-update-refs | --rerere-autoupdate | --no-rerere-autoupdate)
        ;;
      -*)
        # Includes --onto, --root, --exec, -x, -s, -X, --strategy*, -i, and
        # every flag git adds after this is written. Standing down is the
        # fail-open answer and needs no maintenance.
        unknown=1
        break
        ;;
      *)
        nbare=$((nbare + 1))
        [ -z "$upstream" ] && upstream=$(gate_unquote "$tok")
        ;;
    esac
  done < <(gate_argv "$rest")
  [ "$unknown" = 0 ] || continue

  # 0 bare tokens is `--continue` / `--abort` / `--skip` / `--quit` /
  # `--edit-todo`, the ways OUT of a rebase -- never block those. 2+ is the
  # 3-arg form, judged above.
  [ "$nbare" = 1 ] || continue

  # An unexpanded or globbed upstream is not a ref this hook can resolve.
  case "$upstream" in '' | *'$'* | *'`'* | *'*'* | *'?'*) continue ;; esac

  gitc=(git -C "$dir")
  "${gitc[@]}" rev-parse --is-inside-work-tree >/dev/null 2>&1 || continue
  base=$("${gitc[@]}" merge-base "$upstream" HEAD 2>/dev/null) || continue
  [ -n "$base" ] || continue
  n=$("${gitc[@]}" rev-list --count "$base..HEAD" 2>/dev/null) || continue
  case "$n" in '' | *[!0-9]*) continue ;; esac
  [ "$n" -ge 2 ] || continue

  changed=$("${gitc[@]}" diff --name-only "$base..HEAD" 2>/dev/null) || continue
  hit=""
  set -f   # $APPEND_SHAPED is a literal list, never a glob to expand
  for f in $APPEND_SHAPED; do
    case "
$changed
" in *"
$f
"*) hit=$f; break ;; esac
  done
  set +f
  [ -n "$hit" ] || continue

  {
    echo "Blocked by flatten-before-rebase-gate: collapse the branch to ONE commit first."
    echo
    echo "  target tree: $dir"
    echo "  commits since $upstream: $n"
    echo "  append-shaped file in the diff: $hit"
    echo
    echo "$hit gains an entry at the same place on every lane, so it"
    echo "conflicts on nearly every parallel-lane rebase -- and an unflattened rebase"
    echo "re-conflicts on it ONCE PER COMMIT. This repo squash-merges, so the branch tip"
    echo "is the only history that survives and flattening loses nothing."
    echo
    echo "Run this first, then re-run your rebase:"
    echo
    echo "  git -C \"$dir\" reset --soft \"\$(git -C \"$dir\" merge-base $upstream HEAD)\""
    echo "  git -C \"$dir\" commit -F <your message file>"
    echo
    echo "Then resolve the ONE conflict per .claude/skills/work-issues/references/ship.md"
    echo "section 9, which also carries the keep-both verification for $hit."
    echo
    echo "Deliberately preserving history? CDKD_SKIP_FLATTEN_GATE=1 bypasses this gate."
  } >&2
  exit 2
done < <(gate_verb_rest_each_dir "$cmd" "${hook_cwd:-$PWD}" "$GATE_RE_GIT_REBASE")

exit 0
