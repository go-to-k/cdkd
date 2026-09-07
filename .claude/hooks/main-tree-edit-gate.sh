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
# The library is loaded for `gate_unquote_span` / `gate_unquote` -- the verb and
# path unquoting -- AND for `gate_segments_marked`, which is what the walk below
# is built on. It is still NOT loaded for `cmd_last_cd_target`: three rounds
# tried resolving the `cd` with that helper, or with scans built around it, and
# each shipped a silent failure (go-to-k/cdkd#2650 carries the tables).
#
# This comment said "the `cd` match below is deliberately a local, ANCHORED
# regex" for one revision after that stopped being true, which is worse than
# saying nothing: a future round following it would revert the ordered walk and
# restore the bug the walk exists to close. It is an ORDERED WALK over
# `gate_segments_marked` now, and the anchored regex is gone.
# shellcheck source=lib/command-match.sh
__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked as
# `bash main-tree-edit-gate.sh` from inside the hooks dir).
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."
if ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null \
  || ! declare -F gate_unquote_span >/dev/null \
  || ! declare -F gate_unquote >/dev/null \
  || ! declare -F gate_segments_marked >/dev/null; then
  # FAIL CLOSED, as every other blocking gate does: a hook that cannot parse
  # the command cannot say the edit is safe, and `|| exit 0` on an unloadable
  # library is the shape that made twelve sibling gates inert
  # (go-to-k/cdkd#2027).
  echo "Blocked: .claude/hooks/lib/command-match.sh is missing or unloadable," >&2
  echo "so main-tree-edit-gate cannot resolve the command's working directory." >&2
  echo "Restore the file; do not work around the gate." >&2
  # THIS HOOK MATCHES Edit AND Write AS WELL AS Bash, so an unloadable library
  # takes away the three tools an agent would repair it with. Fail-closed is
  # still right -- a gate that cannot parse the command cannot bless the edit --
  # but a refusal with no way out reads as a broken harness rather than a
  # working gate, so it has to name the one route that does not weaken it: a
  # human running the fix in their own shell. In Claude Code that is the `!`
  # prefix in the prompt. Measured the hard way (go-to-k/cdkd#2650): an
  # apostrophe inside a comment in the library's awk program closed the shell
  # string, and the session that wrote it could not undo it.
  echo "" >&2
  echo "If you are an agent and Edit/Write/Bash are all refused, you cannot fix" >&2
  echo "this yourself -- that is by design. Ask the operator to run the repair" >&2
  echo "from their own shell (in Claude Code, prefix the command with '!')." >&2
  echo "Check it first with: bash -n .claude/hooks/lib/command-match.sh" >&2
  exit 2
fi

# Every `cd` target in the RAW command text becomes an additional base for every
# candidate already collected. Used wherever the walk's own `cd` following is
# unavailable or untrusted -- past either bound, and when the segmenter reports
# a mis-split -- because discarding the `cd` is refusing only from a main-tree
# cwd; from a feature worktree the discarded `cd` is the one that would have
# brought the write INTO the protected tree.
#
# THE PRODUCT IS CAPPED, and that is not defensive tidiness. This is
# |candidates| x |cd targets|: an ordinary `cd /tmp && echo a > /tmp/fN`
# repeated 250 times (8 KB) produced 62,750 candidates and ran past 60 s, where
# origin/main answered in 1.9 s -- and past the 10 s PreToolUse timeout a killed
# hook cannot emit exit 2, so the whole gate disappears. An earlier revision had
# already been bitten by the exponential form of the same loop; capping the
# COUNT rather than re-deriving the loop is what stops the third variant.
#
# Past the cap the extra bases are simply not added. That LOSES refusals rather
# than adding them, so it wants to be generous -- but a pair is not free: every
# candidate is resolved against the filesystem later, so the cap has to be set
# from the COST of a candidate rather than from what looks like a lot. Measured
# end to end on 250 `cd`s x 250 writes (7892 B, which takes the cheap path):
# 5000 pairs 40 s, 1000 pairs 10 s, 200 pairs 2 s. The first two are past the
# 10 s PreToolUse timeout, where a killed hook cannot emit exit 2 and the gate
# disappears -- the same failure the union exists to prevent, arriving through
# the fix for it. 200 pairs is 20 `cd`s against 10 write targets, well past any
# hand-written command.
__union_cd_bases() {
  # NO CAP. Every candidate gets every raw-text `cd` target as an extra base.
  #
  # THE CAP WAS THE DEFECT, not the thing keeping the defect out. Three review
  # rounds each bounded this differently and each left a hole, all in the same
  # direction -- some candidate never received some base, and the gate allowed a
  # write it should have refused:
  #
  #   - `added + n > MAXPAIRS` with `added` zero on the first pass: a command
  #     already over the cap unioned NOTHING;
  #   - `MAXPAIRS / n` rounds, floored at 1: the product became 2n, unbounded,
  #     and 900 candidates took 13.8 s past the 10 s PreToolUse timeout;
  #   - `min(n, budget)` per round: copies the array HEAD, and the real write
  #     target is its TAIL, after whatever padding made n large.
  #
  # The cap existed because duplicating array entries makes the work the PRODUCT
  # of two counts. The duplicates are the problem, so they are removed instead:
  # a `--body` holding 900 blockquote lines yields 900 candidates that are all
  # the SAME token, and one (candidate, base) pair after deduplication. What is
  # left is the number of DISTINCT write targets times the number of DISTINCT
  # `cd` targets, which is small in any command a person or an agent writes, and
  # is work that has to happen anyway -- a distinct target genuinely needs its
  # own check.
  local __n __i __b __rest
  __n=${#candidates[@]}
  [ "$__n" -gt 0 ] || return 0
  __rest="$cmd"
  # THE VERB IS UNQUOTED HERE TOO. A bare-literal `cd` misses `"cd"`, `'cd'` and
  # `\cd` -- the precise spellings go-to-k/cdkd#2614 closed, and which the
  # ordinary walk still handles through `gate_unquote_span`. So both bounded
  # escapes lost them: from a worktree, `"cd" <main tree> && echo x > <tracked>`
  # went rc=0 with the file written, against rc=2 for the literal control. The
  # class tolerates quote and backslash characters anywhere in the word; it
  # over-matches (`\\cd`, which bash does NOT run as cd, matches too), and that
  # is the REFUSING direction, which is the right way for a fallback to be wrong.
  while [[ "$__rest" =~ (^|[[:space:]\;\&\|])[\"\'\\]*c[\"\'\\]*d[\"\'\\]*[[:space:]]+([^[:space:]\<\>\|\&\;\(\)]+) ]]; do
    __b=$(gate_unquote "${BASH_REMATCH[2]}")
    __rest="${__rest#*"${BASH_REMATCH[0]}"}"
    case "$__b" in *'$'* | *'`'*) continue ;; /*) ;; *) __b="$base_dir/$__b" ;; esac
    for ((__i = 0; __i < __n; __i++)); do
      candidates+=("${candidates[$__i]}"); cand_bases+=("$__b")
    done
  done
}

# Collapse (candidate, base) pairs to their distinct set.
#
# This is what makes the uncapped union above affordable, and it is a
# CORRECTNESS-NEUTRAL transformation: `is_protected_path` is a pure function of
# the pair, so checking a pair twice cannot change any verdict. The cost it
# removes is real -- each pair costs a `git ls-files`, and the shapes that make
# the union expensive are repeated tokens (every `>` in a quoted `--body` yields
# the same candidate word).
#
# A string set with one lookup per pair. bash 3.2 has no associative arrays; the
# accumulated string stays short because it holds DISTINCT pairs, which is the
# quantity this function exists to show is small.
__dedupe_candidates() {
  local __i __key __seen="" __c __b __line
  local __oc=() __ob=()
  # TWO SPELLINGS, AND THE THRESHOLD IS THE POINT. The in-shell set is
  # fork-free, which is what the common case wants (a handful of candidates),
  # but a substring match against a growing string is quadratic: 2500 DISTINCT
  # pairs built a 50 KB string and cost more than the forks the dedupe exists to
  # avoid. Past the threshold one `sort -u` is O(n log n) and one fork.
  #
  # Deduplication is an OPTIMISATION, never a verdict: `is_protected_path` is a
  # pure function of the pair, so which spelling ran cannot change any outcome.
  # That is why a threshold is safe here and was not safe on the union cap.
  if [ "${#candidates[@]}" -le "${GATE_EDIT_DEDUPE_INLINE:-200}" ]; then
    for ((__i = 0; __i < ${#candidates[@]}; __i++)); do
      __c="${candidates[$__i]}"; __b="${cand_bases[$__i]:-$base_dir}"
      __key=$'\x1f'"$__c"$'\x1e'"$__b"$'\x1f'
      case "$__seen" in
        *"$__key"*) continue ;;
      esac
      __seen="$__seen$__key"
      __oc+=("$__c"); __ob+=("$__b")
    done
  else
    while IFS=$'\x1e' read -r __c __b; do
      [ -n "$__c" ] || continue
      __oc+=("$__c"); __ob+=("$__b")
    done < <(
      for ((__i = 0; __i < ${#candidates[@]}; __i++)); do
        printf '%s\x1e%s\n' "${candidates[$__i]}" "${cand_bases[$__i]:-$base_dir}"
      done | sort -u
    )
  fi
  candidates=("${__oc[@]}"); cand_bases=("${__ob[@]}")
}

input=$(cat 2>/dev/null || true)

tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
base_dir="${hook_cwd:-$PWD}"

# --- Collect candidate target file paths -----------------------------------
candidates=()
cand_bases=()

case "$tool" in
  Edit|Write|MultiEdit)
    fp=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
    [[ -n "$fp" ]] && candidates+=("$fp")
    ;;
  Bash)
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
    [[ -z "$cmd" ]] && exit 0
    # AN ORDERED WALK OVER `gate_segments_marked`. Each segment either updates
    # the running base (a `cd` that is NOT subshell-derived) or has its write
    # targets resolved against the base as it stands at that point.
    #
    # This is the fifth resolution strategy this gate has carried, and the
    # first that is neither anchored nor hand-rolled. The four before it, all
    # measured against origin/main (go-to-k/cdkd#2650 keeps the tables):
    #
    #   a local `^cd` regex        -- read the verb as LITERAL text, so
    #     `"cd" <main> && echo x > <tracked>` was rc=0 (go-to-k/cdkd#2614).
    #   `cmd_last_cd_target` over the whole command -- follows EVERY `cd`, so
    #     one AFTER the write moved the base: `echo hi > <tracked> && cd /tmp`
    #     rc=2 -> 0, this gate's founding incident in ten characters.
    #   truncate at the earliest write + a hand-rolled span stripper -- leaked
    #     a `cd` through a nested or quoted `)`, and dropped a real `cd` when a
    #     `>` sat inside a quoted argument, which is a SILENT bypass from a
    #     feature-worktree cwd rather than the refusal its comment claimed.
    #   the anchored regex with the verb unquoted -- no fail-open of its own,
    #     but it ignores every `cd` that is not first, which is a refusal from
    #     a main-tree cwd and a silent miss from a feature one.
    #
    # The ordered walk was tried at round 3 and closed all of those except one:
    # `gate_segments` FLATTENS a subshell, so `( cd /tmp ) ; echo hi >
    # <tracked>` moved the base although the real shell would not.
    # `gate_segments_marked` is that missing bit -- go-to-k/cdkd#2650. It is a
    # SEPARATE entry point, so nothing that reads `gate_segments` had to change;
    # that is a weaker claim than the "additive, `gate_segments` untouched" this
    # comment used to make, and the weaker one is the measured one.
    #
    # The marking reads each segment through `strip_noncommand_spans` first, so
    # a `(` inside a quoted argument is not counted:
    # `echo "a (b" && cd <wt> && echo x > f` keeps its real `cd`. An earlier
    # revision counted parens on the raw text and over-marked that `cd` into a
    # block -- loud, but wrong -- and this comment described that as the shipped
    # behaviour for one revision longer than it was true. Both it and its
    # control (a REAL subshell `cd`, still ignored) are pinned as cases.
    #
    # PAST `GATE_MARK_MAXSEG` SEGMENTS the marking goes conservative -- every
    # segment marked 1, so NO `cd` below is honoured and the base stays at the
    # payload cwd. FROM THE MAIN TREE that blocks; from a FEATURE worktree it is
    # permissive, because the `cd <main tree>` that would have brought the write
    # into the protected tree is the one being ignored. That second polarity is
    # measured EQUAL on origin/main, so it is inherited rather than introduced,
    # but it is stated here because the previous wording claimed only the
    # flattering half. The bound itself is deliberate: the per-segment strip
    # forks two processes, and 2000 segments cost 11 s against a 10 s PreToolUse
    # timeout. A killed hook cannot exit 2.
    # A HARD INPUT BOUND, with a cheaper analysis past it rather than a refusal.
    #
    # The ordered walk costs one awk pass plus a shell loop over every segment,
    # and the per-segment work is superlinear in SEGMENT COUNT, not in bytes --
    # which is why the first cap was set from the wrong measurement. At 32768
    # the worst shape under the cap (`a;` repeated, 16000 tiny segments) took
    # 11.2 s; the PreToolUse timeout is 10 s, past which the hook is KILLED and
    # cannot emit exit 2, so the gate disappears at exactly the size where it
    # matters. Re-measured across candidate caps on the same shapes: 8192 ->
    # 2.7 s, 4096 -> 0.58 s. It is set at 4096, which is roughly 17x of margin
    # rather than the negative margin it shipped with. This runs BEFORE the on-`main` test, on every Bash, Edit and
    # Write call in any repo on any branch, so the bound is not optional.
    #
    # Past the bound the base is NOT followed at all: it stays at the payload
    # cwd, and write targets are extracted from the raw command text with the
    # same three patterns. That is strictly conservative for the case this gate
    # exists for -- no `cd` is honoured, so nothing can move a write out of the
    # protected tree -- and it is O(n) with no subprocess. A REFUSAL was the
    # other option and was rejected: this hook fires on every tool call, so
    # refusing a large command would break unrelated work in unrelated repos.
    if [[ ${#cmd} -gt ${GATE_EDIT_MAXBYTES:-4096} ]]; then
      __rest="$cmd"
      while [[ "$__rest" =~ (\>\>?)[[:space:]]*([^[:space:]\<\>\|\&\;\(\)]+) ]]; do
        candidates+=("${BASH_REMATCH[2]}"); cand_bases+=("$base_dir")
        __rest="${__rest#*"${BASH_REMATCH[0]}"}"
      done
      __rest="$cmd"
      while [[ "$__rest" =~ tee[[:space:]]+(-a[[:space:]]+)?([^[:space:]\<\>\|\&\;\(\)]+) ]]; do
        candidates+=("${BASH_REMATCH[2]}"); cand_bases+=("$base_dir")
        __rest="${__rest#*"${BASH_REMATCH[0]}"}"
      done
      # THE THIRD VEHICLE, and leaving it out was a measured fail-open. The
      # comment above once said "the same three patterns" while two were
      # applied: `sed -i '' s/a/b/ <tracked>` behind 40 KB of padding went
      # rc 2 -> 0 with the file really rewritten. The full walk takes the LAST
      # word of the segment; with no segments here, every word that looks like
      # a path after a `sed -i` is a candidate, which over-approximates in the
      # refusing direction.
      if [[ "$cmd" =~ sed[[:space:]]+-i ]]; then
        __rest="${cmd#*sed}"
        while [[ "$__rest" =~ ([^[:space:]\<\>\|\&\;\(\)\'\"]*/[^[:space:]\<\>\|\&\;\(\)\'\"]*) ]]; do
          candidates+=("${BASH_REMATCH[1]}"); cand_bases+=("$base_dir")
          __rest="${__rest#*"${BASH_REMATCH[0]}"}"
        done
        candidates+=("${cmd##*[[:space:]]}"); cand_bases+=("$base_dir")
      fi
      # EVERY `cd` TARGET IN THE RAW TEXT IS ALSO A BASE, not just the payload
      # cwd. Pinning the base alone is conservative from the MAIN tree and
      # PERMISSIVE from a feature worktree, where the `cd <main tree>` that
      # brings a write INTO the protected tree is the one being discarded:
      # measured, `cd <main> && echo POISON > <tracked>` behind padding went
      # rc 2 -> 0. Adding each `cd` target as an extra base for every candidate
      # keeps the cheap path refusing in both polarities; it over-approximates,
      # which is the direction this hook is allowed to be wrong in.
      # ONE implementation, shared by all three callers. It was written out
      # inline here and again below, and the two copies diverged the moment one
      # of them was fixed: the exponential `__n`-inside-the-loop bug lived in
      # the copy that did NOT get the parallel change. A helper cannot drift
      # from itself, and the product cap it carries now applies everywhere.
      __union_cd_bases
    else
    # ONE segmentation pass, reused. It used to run twice -- once for the walk
    # and once for the over-cap test -- doubling the cost of the hot path this
    # file spends sixty lines bounding.
    __marked=$(gate_segments_marked "$cmd")

    # A BARE `)` SEGMENT IS THE SEGMENTER TELLING YOU IT MIS-SPLIT. It appears
    # when a multi-line `$( )` was not joined -- the `)` that should have closed
    # the span became a segment of its own -- and everything the body contained
    # is then loose in the stream at top level, including a `cd` that really
    # runs in a child.
    #
    # The known cause is a `)` inside a `#` comment: the line joiner replaces
    # newlines with `;`, so a comment's true extent is no longer recoverable and
    # `flush_line` splits the joined text again. Teaching both scanners about
    # comments (done above) stops them ENDING the span early but cannot undo the
    # `;` join, so the shape still reaches here. Measured from the main tree,
    # with the tracked file really written and the gate returning 0:
    #
    #   x=$( <newline> # note ) <newline> cd /tmp <newline> ) <newline>
    #   echo POISON > <tracked>
    #
    # "FOLLOW NO `cd` AT ALL" WAS THE WRONG ANSWER, and it is worth saying why,
    # because it reads as obviously conservative and is not. A revision of this
    # file did exactly that -- any bare `)` segment disabled `cd` following for
    # the whole command -- and it made things WORSE than the revision before it.
    # Discarding the `cd` walk is refusing only when the payload cwd is already
    # the protected tree. From a FEATURE WORKTREE the `cd <main tree>` that
    # brings a write INTO the protected tree is precisely the one being thrown
    # away: measured, `cd <main> && echo POISON > <tracked>` answered 2, and the
    # same command behind a four-line `x=$( / # c ) / true / )` prefix answered
    # 0 with the tracked file really written.
    #
    # So the signal is kept and the response inverted: every `cd` target in the
    # RAW TEXT becomes an additional base for every candidate, which is the same
    # remedy the two bounded paths below already use, and which over-approximates
    # in the REFUSING direction from either cwd. The product is capped for the
    # reason those paths are: a union that multiplies is a denial of service on
    # a hook that runs on every tool call.
    __mis_split=0
    while IFS=$'\t' read -r __m __s; do
      case "$__s" in ')'|')'[[:space:]]*) __mis_split=1; break ;; esac
    done <<< "$__marked"

    cur_base="$base_dir"
    while IFS=$'\t' read -r __mark __seg; do
      [[ -n "$__seg" ]] || continue
      if [[ "$__mark" == 0 ]]; then
        # `cd` in command position, at THIS level. The verb is unquoted and
        # unescaped the way bash does it (go-to-k/cdkd#2614): a token that was
        # QUOTED keeps its content verbatim, and only an UNQUOTED one is
        # unescaped, left to right. A blanket backslash strip here previously
        # MANUFACTURED a `cd` bash never runs -- `'\cd'`, `"c\d"`, `\\cd` --
        # and moved the base away from the protected tree.
        if [[ "$__seg" =~ ^([^[:space:]]+)[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
          __raw="${BASH_REMATCH[1]}"
          __verb=$(gate_unquote_span "$__raw")
          if [[ "$__verb" == "$__raw" && ${#__raw} -le 4 ]]; then
            __out=""; __rest="$__raw"
            while [[ -n "$__rest" ]]; do
              case "$__rest" in
                '\'?*) __rest="${__rest#?}"; __out="$__out${__rest%"${__rest#?}"}"; __rest="${__rest#?}" ;;
                *)     __out="$__out${__rest%"${__rest#?}"}"; __rest="${__rest#?}" ;;
              esac
            done
            __verb="$__out"
          fi
          if [[ "$__verb" == "cd" ]]; then
            cdt=$(gate_unquote "${BASH_REMATCH[2]}")
            case "$cdt" in
              *'$'* | *'`'*) : ;;   # unexpanded: not a path, leave the base
              *)
                [[ "$cdt" != /* ]] && cdt="$cur_base/$cdt"
                cur_base="$cdt"
                ;;
            esac
            continue
          fi
        fi
      fi
      # Extract LITERAL redirection / write targets FROM THIS SEGMENT, against
      # the base as it stands here. We deliberately skip tokens containing `$`
      # (unexpandable variables) and `*?[` (globs).
      # NO SUBPROCESS PER SEGMENT. The three extractions used to be
      # `printf | grep -oE | sed -E` pipelines plus a `grep -q` and an `awk`,
      # i.e. roughly seven forks for every segment of every command -- and this
      # walk runs BEFORE the on-`main` test, so every Bash, Edit and Write call
      # in any repo on any branch paid it. Measured: 500 segments 4.3 s, 1000
      # segments 8.2 s, 2000 segments 16.0 s, against a flat 0.03 s on
      # origin/main, crossing the 10 s PreToolUse timeout at roughly 1200. A
      # killed hook cannot emit exit 2, so the whole gate goes away at exactly
      # the size where someone would want it to.
      #
      # The three patterns below are the SAME three, transcribed to bash
      # regexes; the transcription was checked by running both forms over 543
      # segments (the differential corpus, the write/context grid, and 16
      # adversarial redirect/tee shapes) and requiring byte-identical output.
      __rest="$__seg"
      while [[ "$__rest" =~ (\>\>?)[[:space:]]*([^[:space:]\<\>\|\&\;\(\)]+) ]]; do
        candidates+=("${BASH_REMATCH[2]}"); cand_bases+=("$cur_base")
        __rest="${__rest#*"${BASH_REMATCH[0]}"}"
      done
      __rest="$__seg"
      while [[ "$__rest" =~ tee[[:space:]]+(-a[[:space:]]+)?([^[:space:]\<\>\|\&\;\(\)]+) ]]; do
        candidates+=("${BASH_REMATCH[2]}"); cand_bases+=("$cur_base")
        __rest="${__rest#*"${BASH_REMATCH[0]}"}"
      done
      if [[ "$__seg" =~ sed[[:space:]]+-i ]]; then
        candidates+=("${__seg##*[[:space:]]}"); cand_bases+=("$cur_base")
      fi
    done <<< "$__marked"
    # PAST `GATE_MARK_MAXSEG` EVERY SEGMENT IS MARKED SUBSHELL-DERIVED, so the
    # walk above honours no `cd` at all. From the MAIN tree that refuses; from a
    # FEATURE worktree it is the permissive direction, because the
    # `cd <main tree>` that brings a write INTO the protected tree is exactly
    # what gets discarded -- measured, 210 padding segments turned rc 2 into 0
    # for five write vehicles. Union in the raw-text `cd` targets, as the
    # over-bound path does, so the cap cannot be used as an off-switch.
    # ASK WHETHER EVERY SEGMENT IS SUBSHELL-DERIVED -- do not re-count against
    # the cap. Over the cap the library marks EVERYTHING 1, and that state is
    # what this branch has to compensate for; counting `^1` lines against
    # `GATE_MARK_MAXSEG` here answers a different question over a different
    # population, because the library counts RAW segment lines (blank ones
    # included) while this stream has dropped every empty segment. A command can
    # therefore be over the cap in the library -- every `cd` ignored -- and under
    # it by this count, so the compensation never runs and the `cd` is discarded
    # with nothing replacing it. Measured: `cd <main tree>`, 110 `echo` lines
    # separated by blank lines, then a write (1654 B, 220 lines, an ordinary
    # multi-line Bash call) went rc 2 -> 0 with the tracked file really written,
    # while origin/main answered 2.
    #
    # "Every segment marked 1" is exactly the state the library produces when
    # over, needs no second copy of the predicate, and its false positive -- a
    # command genuinely made only of subshell segments -- unions in extra bases,
    # which is the REFUSING direction.
    __all_marked=1
    __seen_seg=0
    while IFS=$'\t' read -r __m __s; do
      [[ -n "$__s" ]] || continue
      __seen_seg=1
      [[ "$__m" == 1 ]] || { __all_marked=0; break; }
    done <<< "$__marked"
    if [[ ( "$__seen_seg" == 1 && "$__all_marked" == 1 ) || "$__mis_split" == 1 ]]; then
      __union_cd_bases
    fi
    fi
    ;;
  *)
    exit 0
    ;;
esac

[[ ${#candidates[@]} -eq 0 ]] && exit 0

# --- Helpers ---------------------------------------------------------------
# Memo for `is_protected_path`, keyed on the candidate's parent directory. See
# the comment at its use site for why this is a linear scan and not a hash.
__pp_dir=(); __pp_canon=(); __pp_branch=(); __pp_top=()
__pp_lsf_key=""; __pp_lsf_tracked=1
canonicalize_dir() {
  local p="$1"
  if [[ -d "$p" ]]; then (cd "$p" 2>/dev/null && pwd -P) || printf '%s' "${p%/}"
  else printf '%s' "${p%/}"; fi
}

# Resolve a raw candidate + base to the (dir, abs) pair `is_protected_path`
# decides on, or return 1 when the token is not resolvable. ONE definition, used
# by both the decision and the batch primer below -- the recurring defect in this
# area has been two copies of one predicate drifting apart.
__NC_DIR=""; __NC_ABS=""
__norm_candidate() {
  local raw="$1" base="${2:-$base_dir}" abs dir
  raw="${raw%\"}"; raw="${raw#\"}"; raw="${raw%\'}"; raw="${raw#\'}"
  case "$raw" in
    *'$'* | *'*'* | *'?'* | *'['* | '/dev/'* | '-') return 1 ;;
  esac
  abs="$raw"
  [[ "$abs" != /* ]] && abs="$base/$abs"
  # Strip EVERY trailing slash: `dirname a/b/c//` is `a/b`, while one `%/`
  # leaves `a/b/c`, which exists as a directory, so the candidate resolved to
  # itself and the gate ALLOWED it.
  abs="${abs%"${abs##*[!/]}"}"
  [[ -n "$abs" ]] || abs=/
  dir="${abs%/*}"
  [[ -n "$dir" ]] || dir=/
  __NC_DIR="$dir"; __NC_ABS="$abs"
  return 0
}

# One `git ls-files` for a directory, covering every candidate that resolves
# into it. Idempotent; the result is a \x1f-delimited set of absolute paths.
__pp_lsf_dirs=(); __pp_lsf_set=(); __pp_lsf_idx=0
__prime_tracked() {
  local d="$1" i=0 paths=() line
  while [ "$i" -lt "${#__pp_lsf_dirs[@]}" ]; do
    [ "${__pp_lsf_dirs[$i]}" = "$d" ] && { __pp_lsf_idx=$i; return 0; }
    i=$((i + 1))
  done
  for ((i = 0; i < ${#candidates[@]}; i++)); do
    __norm_candidate "${candidates[$i]}" "${cand_bases[$i]:-$base_dir}" || continue
    [ "$__NC_DIR" = "$d" ] && paths+=("$__NC_ABS")
  done
  local set=$'\x1f'
  if [ "${#paths[@]}" -gt 0 ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      case "$line" in /*) ;; *) line="$d/$line" ;; esac
      set="$set$line"$'\x1f'
    # NO `--full-name`, and no post-processing: with `-C "$d"` git reports the
    # tracked subset RELATIVE TO `$d`, which is exactly what the loop above
    # re-absolutises. A first draft piped through `sed` to prepend the toplevel,
    # which was both redundant and tripped `unresolved-target-class`'s fence 1 --
    # it forbids a `-C` inside a grep/sed/awk expression, because that is the
    # shape of a hook hand-rolling its own target-directory scan.
    done < <(git -C "$d" ls-files -- "${paths[@]}" 2>/dev/null)
  fi
  __pp_lsf_dirs+=("$d"); __pp_lsf_set+=("$set")
  __pp_lsf_idx=$(( ${#__pp_lsf_dirs[@]} - 1 ))
}

is_protected_path() {
  # echo "BLOCK <reason>" on stderr-worthy hit, else nothing.
  local raw="$1" base="${2:-$base_dir}"
  # Strip surrounding quotes.
  raw="${raw%\"}"; raw="${raw#\"}"; raw="${raw%\'}"; raw="${raw#\'}"
  # Skip unresolvable tokens (variables / globs / process-subst).
  case "$raw" in
    *'$'* | *'*'* | *'?'* | *'['* | '/dev/'* | '-') return 1 ;;
  esac
  # Absolutize relative to base_dir.
  local abs="$raw"
  [[ "$abs" != /* ]] && abs="$base/$abs"
  # Directory to query git from = the file's parent (must exist).
  # `${abs%/*}` rather than `dirname`: this runs ONCE PER CANDIDATE, and a
  # command can carry hundreds (every `>` is one), so a fork here is a fork
  # times N. `abs` is absolute by construction above, so the only special case
  # is a file directly under the root.
  # Strip a trailing slash first: `dirname a/b/c/` is `a/b`, while `${x%/*}`
  # on the same input yields `a/b/c` -- which then exists as a directory, so the
  # candidate resolved to itself and the gate ALLOWED it. Not reachable through
  # a redirect (bash refuses `> dir/`), but the divergence is real and measured.
  abs="${abs%/}"
  local dir="${abs%/*}"
  [[ -n "$dir" ]] || dir=/
  [[ -d "$dir" ]] || return 1
  # MEMOISED PER PARENT DIRECTORY. Canonicalising and asking git for the branch
  # and the toplevel is 1 subshell + 2 `git` per candidate, and candidates
  # overwhelmingly SHARE a parent -- so without this the cost is linear in
  # candidates when it is really linear in distinct directories. Measured on a
  # `gh pr comment --body` holding 900 blockquote lines, all of which are
  # candidates: 7.15 s before, and that is on origin/main, i.e. the shape was
  # already within 3 s of the 10 s PreToolUse timeout that disarms every gate.
  #
  # bash 3.2 has no associative arrays, and a linear scan is right anyway: the
  # number of DISTINCT parent directories in one command is one or two, so the
  # scan is shorter than the hash it would replace.
  local __ci=0 __hit=-1
  while [ "$__ci" -lt "${#__pp_dir[@]}" ]; do
    [ "${__pp_dir[$__ci]}" = "$dir" ] && { __hit=$__ci; break; }
    __ci=$((__ci + 1))
  done
  local canon branch top
  if [ "$__hit" -ge 0 ]; then
    canon="${__pp_canon[$__hit]}"; branch="${__pp_branch[$__hit]}"; top="${__pp_top[$__hit]}"
  else
    canon=$(canonicalize_dir "$dir")
    branch=$(git -C "$canon" rev-parse --abbrev-ref HEAD 2>/dev/null) || branch=""
    if [ -n "$branch" ]; then
      top=$(git -C "$canon" rev-parse --show-toplevel 2>/dev/null) || top=""
      [ -n "$top" ] && top=$(canonicalize_dir "$top")
    else
      top=""
    fi
    __pp_dir+=("$dir"); __pp_canon+=("$canon"); __pp_branch+=("$branch"); __pp_top+=("$top")
  fi
  # A cached MISS is a miss: an empty branch or toplevel means the dir is not in
  # a git repo (or git failed), which is the same `return 1` the uncached path
  # took. Storing it is what keeps a repeated miss from re-forking.
  [ -n "$branch" ] || return 1
  [ -n "$top" ] || return 1
  dir="$canon"
  abs="$dir/${abs##*/}"
  [[ "$branch" == "main" || "$branch" == "master" ]] || return 1
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
  # Tracked file? -> always protected.
  #
  # ONE `git ls-files` PER DIRECTORY, not per candidate. This was the last
  # per-candidate fork, and it is what made the union need a cap at all -- every
  # attempt to bound that cap left a hole (three rounds, three holes, all in the
  # allowing direction). Removing the cost removes the reason for the cap.
  #
  # A one-entry memo was tried first and only collapses REPEATED tokens; a
  # `--body` with distinct words per line defeats it, and 2500 of them cost
  # 18 s against the 10 s PreToolUse timeout -- a killed hook emits no exit 2,
  # so that is a fail-open, not a slow test. `ls-files` accepts many pathspecs
  # and prints the tracked subset, so the whole question for a directory is one
  # fork. Primed lazily on first need, from the candidate arrays, through the
  # SAME normalisation this function uses -- a second copy of that logic is how
  # the two halves of a bound came to disagree earlier in this branch.
  __prime_tracked "$dir"
  local __tk=$'\x1f'"$abs"$'\x1f'
  case "${__pp_lsf_set[$__pp_lsf_idx]}" in
    *"$__tk"*) __pp_lsf_tracked=0 ;;
    *) __pp_lsf_tracked=1 ;;
  esac
  if [ "$__pp_lsf_tracked" = 0 ]; then
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

# Dedupe LAST, after both bounded paths have unioned their bases in, so it sees
# the final pair set. Cheap when there is nothing to collapse.
__dedupe_candidates

__i=0
for c in "${candidates[@]}"; do
  # `:-` is load-bearing: the Edit / Write arm pushes candidates with no
  # per-candidate base, and `${arr[$i]}` on an empty array under `set -u`
  # aborts with rc=1 -- neither allow nor block.
  if is_protected_path "$c" "${cand_bases[$__i]:-$base_dir}"; then
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
  __i=$((__i + 1))
done

exit 0
