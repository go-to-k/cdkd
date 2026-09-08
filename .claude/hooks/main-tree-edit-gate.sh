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
#   - Edit / Write / MultiEdit / NotebookEdit: `tool_input.file_path`,
#     falling back to `tool_input.notebook_path` (reliable). The last
#     two reach this hook because a matcher is an UNANCHORED REGEX and
#     `Edit|Write|Bash` matches the substring; NotebookEdit is the one
#     that sends `notebook_path` instead of `file_path`.
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
__lib_loaded=1
if ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null \
  || ! declare -F gate_unquote_span >/dev/null \
  || ! declare -F gate_unquote >/dev/null \
  || ! declare -F gate_segments_marked >/dev/null; then
  __lib_loaded=0
fi

# The refusal is DEFERRED to the `Bash` arm, and that is the whole point of
# separating these two statements.
#
# FAIL CLOSED is still right for `Bash`: a hook that cannot parse the command
# cannot say the write is safe, and `|| exit 0` on an unloadable library is the
# shape that made twelve sibling gates inert (go-to-k/cdkd#2027).
#
# But this hook's matcher is `Edit|Write|Bash`, and refusing at LOAD time
# refused all three at once -- taking away the tools the library is repaired
# with. That happened four times in one session (go-to-k/cdkd#2650), three of
# them from a single apostrophe inside a comment in the library's awk program,
# and each time the maintainer had to run the repair from their own shell. A
# safety mechanism must not be able to remove the operator's means of repair.
#
# The asymmetry that makes the split sound: the file-path arm (all four labels)
# reads its target through `jq` and calls NO library function -- the path
# arrives already expanded, so there is no shell text to parse. Only the `Bash`
# arm needs the matcher, so only the `Bash` arm fails closed on it. Everything
# between here and the dispatch is variable assignments and function
# definitions, so nothing runs against the missing functions in between.
#
# Refusing EVERY Bash call rather than only the ones it would have parsed is
# deliberate: deciding which calls are safe is the parse it cannot do.
#
# ONE arm is neither of the two: a `tool_name` this hook cannot classify -- a
# malformed payload, or `jq` missing as well -- falls through the `case` to `*)`
# and exits 0, where the load-time refusal used to catch it. That is accepted
# rather than overlooked. Refusing in `*)` means refusing a payload whose tool is
# UNKNOWN, which puts Edit and Write back inside the refusal the moment `jq`
# breaks too -- the lockout again, arriving by a second route. It is pinned by a
# case, because eight lines of argument for a behaviour nothing measures is how
# the behaviour goes away in a later refactor.
#
# An earlier revision of this comment justified it with "the registered matcher
# is `Edit|Write|Bash`, so `*)` is unreachable". That was FALSE, and the file
# contradicted it two ways at once. Claude Code matchers are UNANCHORED REGEX:
# `Edit|Write|Bash` matches `MultiEdit` and `NotebookEdit` on the substring
# `Edit`, so both reach this hook. `MultiEdit` was already in the file-path arm
# and `NotebookEdit` was not -- which meant a NotebookEdit of a tracked file in
# the main tree on `main` fell to `*)` and was ALLOWED. That hole predates this
# change and is closed here, in the same `case` label the comment is about; the
# sibling `worktree-owner-gate` has listed `NotebookEdit` all along.
__refuse_unloadable_library() {
  echo "Blocked: .claude/hooks/lib/command-match.sh is missing or unloadable," >&2
  echo "so main-tree-edit-gate cannot resolve the command's working directory." >&2
  echo "Restore that file; do not work around the gate." >&2
  echo "" >&2
  echo "Only Bash is refused. This hook's file-path arms read the target" >&2
  echo "path directly and need no shell parsing, so FROM A FEATURE WORKTREE you" >&2
  echo "can repair the library with the Edit or Write tool -- that route is open." >&2
  echo "In the main tree on main this gate refuses that edit too, for its own" >&2
  echo "separate reason, so there the repair belongs to the operator, made from" >&2
  echo "their own shell ('!' prefixed, in Claude Code). To inspect it first:" >&2
  echo "  bash -n .claude/hooks/lib/command-match.sh" >&2
  echo "A Bash call that is no longer refused is the proof the library loaded." >&2
  exit 2
}

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
# Declared HERE, above the function that writes them: the helper block further
# down is defined AFTER `__union_cd_bases` is CALLED, so initialising there left
# `__union_overflow` unbound at the first call and the hook exited 1 -- neither
# allow nor block.
# TOKEN CLASSES IN VARIABLES, with NO BACKSLASH INSIDE THE BRACKETS.
#
# `[^[:space:]\<\>\|\&\;\(\)]` reads, under POSIX, as "not a space, not a
# BACKSLASH, not <, >, |, &, ; or )" -- a backslash inside a bracket expression
# is an ordinary MEMBER, not an escape. bash 3.2's engine honours that and 5.x's
# does not, so the two disagreed about where a write target ENDS: `echo x >
# back\slash.md` extracted `back\slash.md` under 5.x and `back` under 3.2,
# and `back` is not a tracked file, so the gate allowed a write to one -- on the
# only bash CI runs. Same root cause as `gate_strip_prefix`'s, three functions
# away, found by a reviewer probing filenames rather than commands.
#
# NOT named `GATE_*`. That prefix marks a constant SHARED from `lib/`, and
# `unresolved-target-class` fence 4 refuses any hook that reads a positional
# `BASH_REMATCH[N]` out of a match built from one -- widening a shared constant
# elsewhere shifts every index here (go-to-k/cdkd#2200). These two are local to
# this file, so the coupling the fence guards against does not exist; the fence
# reported them purely on the name, and renaming is the honest answer rather
# than an exemption. **Neither may ever contain a GROUP**, for the same reason
# the fence exists: the regexes below index their captures positionally.
#
# They are VARIABLES because a bare `)` inside a bracket expression written
# INLINE ends the `[[ ]]` word before the regex engine sees it -- both engines
# reject that -- so the escapes could not simply be deleted in place.
__TOK='[^[:space:]<>|&;()]'
__TOK_Q='[^[:space:]<>|&;()'"'"'"]'
__cd_targets=(); __union_overflow=0; __overflow_reason=""
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
  local __n __i __b __rest __cds=0 __ci __seen_cd
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
  while [[ "$__rest" =~ (^|[[:space:]\;\&\|])[\"\'\\]*c[\"\'\\]*d[\"\'\\]*[[:space:]]+(${__TOK}+) ]]; do
    __b=$(gate_unquote "${BASH_REMATCH[2]}")
    __rest="${__rest#*"${BASH_REMATCH[0]}"}"
    case "$__b" in *'$'* | *'`'*) continue ;; /*) ;; *) __b="$base_dir/$__b" ;; esac
    # EVERY target is RECORDED, even past the bound; only the UNION stops. The
    # recording is a text scan and costs nothing, and the overflow refusal below
    # needs the full list -- checking only what was unioned asks about the first
    # `k` targets and misses the real one when it comes last, which is exactly
    # where a padded command puts it. Measured: without this the n*k shape went
    # rc 2 -> 0, i.e. the bound meant to be fail-closed was a fail-open.
    # DISTINCT targets, not occurrences. `__cds` counted every `cd` it matched,
    # so `cd /tmp` twenty-five times -- one distinct target, no union cost at
    # all -- tripped the overflow and produced a refusal whose message said
    # "distinct cd targets: over 20". A false block AND a wrong diagnosis.
    # The scan is O(k^2) and `k` is not bounded by anything, so it stops once the
    # union has: past overflow the count no longer decides anything, and the
    # refusal below only needs SOME protected base, which duplicates do not
    # hide. Measured before this guard, k=1500 cost 31 s -- past the timeout.
    if [ "$__union_overflow" != 1 ]; then
      __seen_cd=0
      for ((__ci = 0; __ci < ${#__cd_targets[@]}; __ci++)); do
        if [ "${__cd_targets[$__ci]}" = "$__b" ]; then __seen_cd=1; break; fi
      done
      if [ "$__seen_cd" = 1 ]; then continue; fi
    fi
    __cd_targets+=("$__b")
    __cds=$((__cds + 1))
    # `if`, never a trailing `[ ... ] && x`. Under a caller's `set -e` a false
    # test as the LAST command of a loop body aborts the FUNCTION -- the trap
    # this repo already records for `gate_segments`' emit. Here it ended the
    # scan silently, so `__union_overflow` was never set, the refusal below
    # never ran, and the n*k shape measured rc=0 where it had been 2.
    if [ "$__union_overflow" != 1 ]; then
    for ((__i = 0; __i < __n; __i++)); do
      candidates+=("${candidates[$__i]}"); cand_bases+=("$__b")
    done
    # THE BOUND IS FAIL-CLOSED, which is the whole difference from the cap this
    # replaced. `n` write candidates against `k` distinct `cd` targets is n*k
    # pairs however cleverly they are stored, and deduplication cannot help when
    # both sets are genuinely distinct: measured on bash 3.2, `cd /tmp/dN && echo
    # a > /tmp/dN/fN` repeated, 200 copies (8 KB) cost 9.8 s and 250 cost 22 s,
    # against a 10 s PreToolUse timeout after which the hook is KILLED and
    # returns 142 -- neither allow nor block, so every gate on that call is
    # disarmed.
    #
    # Three earlier versions bounded the work and SKIPPED the rest, and each
    # left a hole in the allowing direction. Refusing instead cannot: over the
    # bound the command is not analysed, so it is not permitted either. The
    # limit is far above any real command -- 20 distinct `cd` targets in one
    # Bash call -- and the refusal names it, so a legitimate outlier is a loud,
    # actionable message rather than a silent pass.
      # BOTH the target count AND THE PRODUCT. Capping `k` alone bounds nothing:
      # the union materialises k*n entries and `n`, the write-candidate count, is
      # deliberately unbounded on the over-bytes path. Measured on bash 3.2 --
      # the only bash CI has -- with k=19, UNDER the target cap: n=2000 cost
      # 15.4 s and n=4000 cost 55.0 s, against a 10 s PreToolUse timeout after
      # which the hook is killed, emits no exit 2, and every gate on the call is
      # disarmed. That is the failure this bound exists to prevent, arriving
      # through the fix for it.
      if [ "$__cds" -ge "${GATE_EDIT_MAXCD:-20}" ]; then
        __union_overflow=1
        __overflow_reason="too many distinct cd targets (${GATE_EDIT_MAXCD:-20})"
      elif [ "$((__cds * __n))" -ge "${GATE_EDIT_MAXPAIRS:-15000}" ]; then
        __union_overflow=1
        __overflow_reason="cd targets x write candidates over ${GATE_EDIT_MAXPAIRS:-15000}"
      fi
    fi
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
    # `LC_ALL=C`: under a UTF-8 locale `sort` ABORTS on an invalid byte
    # ("Illegal byte sequence") and, on glibc, collates keys that differ only in
    # punctuation as EQUAL -- which silently drops a pair, and a dropped pair is
    # a write nobody checks. Byte ordering is all this needs.
    done < <(
      for ((__i = 0; __i < ${#candidates[@]}; __i++)); do
        printf '%s\x1e%s\n' "${candidates[$__i]}" "${cand_bases[$__i]:-$base_dir}"
      done | LC_ALL=C sort -u
    )
  fi
  # NEVER ASSIGN FROM A POSSIBLY-EMPTY ARRAY. `("${__oc[@]}")` on an empty array
  # is an unbound-variable abort under `set -u` on bash 3.2 -- rc 127, which is
  # neither allow nor block, i.e. a fail-open. If the pass produced nothing,
  # leave the originals alone: deduplication is an optimisation and skipping it
  # is always safe.
  if [ "${#__oc[@]}" -gt 0 ]; then
    candidates=("${__oc[@]}"); cand_bases=("${__ob[@]}")
  fi
}
# go-to-k/cdkd#2729: the guard above covers the FUNCTIONS this hook calls and
# CANNOT see a missing CONSTANT. This hook reads none of its OWN, so the call
# takes no arguments and asks only about the library's.
#
# **LOAD-BEARING HERE, and measured.** With this call REMOVED and each declared
# base stripped one at a time, payload
# `cd <main tree> && echo hi > docs/_generated/integ-last-run.tsv` -- a tracked
# write into the main checkout while it is on `main`, which is this gate's
# founding incident -- **seven bases flip rc 2 -> 0**: `GATE_SUBST_MARK`,
# `GATE_MARK_MAXSEG`, `GATE_QUOTED_VALUE` and the four `GATE_SEP_*`. The control
# (call removed, library COMPLETE) stays rc=2; with the call present all seven
# answer rc=2 naming the constant.
#
# The cause is this hook's LIBRARY load guard (the `declare -F` chain near the
# top of the file, not the `gate_require_const` one inside the `Bash` arm): it requires
# `gate_segments_marked`,
# and the ordered walk go-to-k/cdkd#2650 moved this hook onto reads those
# constants BARE inside function bodies, where the `${X:-}` defaults on the
# library's load-time assignments do nothing.
#
# **Two earlier revisions of this comment were wrong, and HOW they were wrong is
# the point.** The first asserted the sibling `broad-process-kill-gate`'s
# measurement as if it were this hook's, with the payload left as an unfilled
# template slot. The second called the call "PRECAUTIONARY" and claimed "zero
# flips" -- measured against the PRE-#2650 hook, which did not use the shared
# walk, then carried across the rebase that gave this hook the walk. Either one
# would have made deleting a check that stops seven live fail-opens look like a
# safe simplification: the go-to-k/cdkd#2681 class. State a measurement, or
# state nothing.
# NOT yet fenced as a class -- the fence is split out into
# go-to-k/cdkd#2826.
#
# **THE CALL LIVES IN THE `Bash` ARM, and putting it here instead was a live
# defect measured on this change's own rebase.** This hook's matcher takes Edit
# and Write too, so a check ahead of the tool-arm split refuses THEM when the
# library cannot answer -- and the library is what Edit and Write are needed to
# repair. A merge conflict in `lib/command-match.sh` left `Bash`, `Edit` and
# `Write` all refused with this message, from three separate attempts, and the
# repair took the maintainer's own shell. That is the same lockout
# go-to-k/cdkd#2717 already carved the `declare -F` chain out of, re-opened by a
# SECOND liveness check placed ahead of the split; `__refuse_unloadable_library`
# in the `Bash` arm is where both belong. Any future check added to this hook
# goes inside that arm.

input=$(cat 2>/dev/null || true)

tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
base_dir="${hook_cwd:-$PWD}"

# --- Collect candidate target file paths -----------------------------------
candidates=()
cand_bases=()

case "$tool" in
  Edit|Write|MultiEdit|NotebookEdit)
    # `notebook_path` is NOT a guess: it is the field `worktree-owner-gate.sh`
    # has read for `NotebookEdit` all along, and NotebookEdit is the one tool in
    # this pattern that does not send `file_path`. Reading only `file_path` made
    # adding the label INERT for exactly the tool it was added for -- measured,
    # a NotebookEdit of a TRACKED main-tree file collected no candidate and
    # exited 0, while the same payload spelled with `file_path` exited 2. Cases
    # written against the invented spelling passed throughout.
    fp=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' 2>/dev/null || echo "")
    [[ -n "$fp" ]] && candidates+=("$fp")
    ;;
  Bash)
    # Before anything is read off the command: without the matcher this arm
    # cannot resolve a `cd`, and an unresolved `cd` is the difference between
    # "the write is outside the repo" and "the write lands in the main tree".
    [ "$__lib_loaded" = 1 ] || __refuse_unloadable_library
    # The CONSTANT half of the same requirement, here rather than at the top of
    # the file for the reason the header gives: this arm is the only one that
    # reads a library constant, and refusing Edit / Write for a constant they
    # never touch removes the tools the library is repaired with.
    if ! declare -F gate_require_const >/dev/null 2>&1; then
      echo "Blocked: .claude/hooks/lib/command-match.sh loaded but does not define" >&2
      echo "gate_require_const, so this gate cannot verify the constants it reads." >&2
      echo "Repair the library with Edit or Write -- this gate deliberately still" >&2
      echo "allows those, so a broken matcher cannot lock out its own fix." >&2
      exit 2
    fi
    gate_require_const
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
      # AND A SECOND, MUCH HIGHER BOUND ON THE SCAN ITSELF, which refuses rather
      # than scanning. Each loop below consumes `__rest` with `${__rest#*...}`,
      # which copies the remainder every iteration -- quadratic in command
      # length. Measured on bash 3.2, the only bash CI has, on a quoted `--body`
      # whose every line is a distinct `>` target: 109 KB / 2000 targets took
      # 3.7 s and 329 KB / 6000 took 28.3 s, past the 10 s PreToolUse timeout
      # where the hook is killed and every gate on the call is disarmed.
      # origin/main is slower still on the same shape, so the cost is inherited
      # -- but inherited cost past the timeout is the same fail-open.
      #
      # The candidate-count bound further down cannot help: it runs AFTER this
      # scan has already spent the time. This one has to be here, and it has to
      # refuse -- scanning a prefix and then allowing is the hole three
      # successive versions of the `cd` bound shipped.
      if [[ ${#cmd} -gt ${GATE_EDIT_MAXSCAN:-131072} ]]; then
        __union_overflow=1
        __overflow_reason="command too large to analyse (${GATE_EDIT_MAXSCAN:-131072} bytes)"
      fi
      __rest="$cmd"
      while [[ "$__union_overflow" != 1 && "$__rest" =~ (\>\>?)[[:space:]]*(${__TOK}+) ]]; do
        candidates+=("${BASH_REMATCH[2]}"); cand_bases+=("$base_dir")
        __rest="${__rest#*"${BASH_REMATCH[0]}"}"
      done
      __rest="$cmd"
      while [[ "$__union_overflow" != 1 && "$__rest" =~ tee[[:space:]]+(-a[[:space:]]+)?(${__TOK}+) ]]; do
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
        while [[ "$__rest" =~ (${__TOK_Q}*/${__TOK_Q}*) ]]; do
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
      while [[ "$__rest" =~ (\>\>?)[[:space:]]*(${__TOK}+) ]]; do
        candidates+=("${BASH_REMATCH[2]}"); cand_bases+=("$cur_base")
        __rest="${__rest#*"${BASH_REMATCH[0]}"}"
      done
      __rest="$__seg"
      while [[ "$__union_overflow" != 1 && "$__rest" =~ tee[[:space:]]+(-a[[:space:]]+)?(${__TOK}+) ]]; do
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

# NOT when the scan was REFUSED. Skipping the scan leaves `candidates` empty,
# and this early exit then allowed the very command the refusal was for --
# measured, a 329 KB body went rc 0 in 0.05 s, which is a faster fail-open than
# the 28 s one it replaced. The overflow decision has to be reached.
if [[ ${#candidates[@]} -eq 0 && "${__union_overflow:-0}" != 1 ]]; then exit 0; fi

# --- Helpers ---------------------------------------------------------------
# Memo for `is_protected_path`, keyed on the candidate's parent directory. See
# the comment at its use site for why this is a linear scan and not a hash.
__pp_dir=(); __pp_branch=(); __pp_top=()
__pp_lsf_tracked=1
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
__canon_dirs=(); __canon_vals=()
# Answers in a GLOBAL, never on stdout. A caller writing `x=$(__canon_memo ...)`
# forks a subshell on EVERY call however cheap the function is -- and this one
# runs per candidate, so a 2500-token command paid 10000 forks and took 10.4 s
# against the 10 s PreToolUse timeout. The memo was added to REMOVE forks; the
# calling convention put them back.
__CANON=""
__canon_memo() { # <dir> -> __CANON
  local d="$1" i=0
  while [ "$i" -lt "${#__canon_dirs[@]}" ]; do
    if [ "${__canon_dirs[$i]}" = "$d" ]; then __CANON="${__canon_vals[$i]}"; return 0; fi
    i=$((i + 1))
  done
  local c; c=$(canonicalize_dir "$d")
  __canon_dirs+=("$d"); __canon_vals+=("$c")
  __CANON="$c"
}
__norm_candidate() {
  local raw="$1" base="${2:-$base_dir}" abs dir
  raw="${raw%\"}"; raw="${raw#\"}"; raw="${raw%\'}"; raw="${raw#\'}"
  case "$raw" in
    *'$'* | *'*'* | *'?'* | *'['* | '/dev/'* | '-') return 1 ;;
  esac
  # BASH QUOTE REMOVAL. An unquoted backslash escapes the next character, so
  # `echo hi > READ\ME.md` really writes `README.md` -- measured, along with
  # `\README.md` and `READM\E.md`. Without this the gate looked for a file
  # named `READ\ME.md`, did not find it, and allowed a write to the tracked
  # `README.md`; `origin/main` refused all three. `gate_unquote` does not do
  # this (checked: it returns those tokens unchanged), and the shared library
  # offers nothing else that does, so it is here rather than borrowed.
  #
  # Guarded on the token CONTAINING a backslash, because this runs once per
  # candidate and a command can carry thousands: the loop is character-at-a-time
  # and almost no real path has one.
  case "$raw" in
    *'\'*)
      local __ur="" __rr="$raw" __rc
      while [ -n "$__rr" ]; do
        __rc=${__rr%"${__rr#?}"}; __rr=${__rr#?}
        if [ "$__rc" = '\' ] && [ -n "$__rr" ]; then
          __rc=${__rr%"${__rr#?}"}; __rr=${__rr#?}
        fi
        __ur="$__ur$__rc"
      done
      raw="$__ur"
      ;;
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
  [[ -d "$dir" ]] || return 1
  # CANONICALISE HERE, so every consumer keys on the same string. It was done in
  # `is_protected_path` and not here, and the two then disagreed: the primer was
  # handed the CANONICAL dir while this function yielded the RAW one, so the
  # comparison never matched, `paths` stayed empty, and every candidate came
  # back "not tracked". The `tracked` arm was dead and only `new-source-file`
  # still refused -- which is invisible in a fixture whose files all sit under
  # `docs/` or `src/`, and on macOS every `mktemp -d` is a symlinked path, so
  # the suite ran that way and still reported 88/0.
  __canon_memo "$dir"; dir="$__CANON"
  __NC_DIR="$dir"; __NC_ABS="$dir/${abs##*/}"
  return 0
}

# One `git ls-files` for a directory, covering every candidate that resolves
# into it. Idempotent; the result is a \x1f-delimited set of absolute paths.
__pp_lsf_dirs=(); __pp_lsf_set=(); __pp_lsf_idx=0; __pp_lsf_primed=0
# One scratch file for every `ls-files` chunk, created once and cleaned up on
# exit. The hook must not leave temp files behind: it runs on every tool call.
__lsf_tmp=$(mktemp 2>/dev/null || printf '/tmp/cdkd-lsf.%s' "$$")
trap 'rm -f "$__lsf_tmp"' EXIT
# ONE PASS OVER THE CANDIDATES, not one pass per directory.
#
# The first version primed lazily and re-scanned the whole candidate array for
# each distinct parent, so the work was candidates x directories. With 1500
# distinct tokens that measured 5 s against this suite's 4 s budget -- caught by
# the latency case added in the previous round, which is the only reason it did
# not ship. Bucketing in a single pass makes it candidates + directories, and
# still one `git ls-files` per directory.
__prime_all_tracked() {
  [ "$__pp_lsf_primed" = 0 ] || return 0
  __pp_lsf_primed=1
  # PARALLEL ARRAYS, never a growing string. Accumulating each directory's paths
  # by appending to `lists[$j]` is quadratic -- 1500 paths of ~60 bytes copies a
  # buffer that reaches 90 KB, 1500 times -- and bash 3.2, the only bash CI has,
  # is far slower at it than 5.x: the suite measured 1.5 s under 5.x and 5 s
  # under 3.2 against a 4 s budget. Two flat arrays plus a filtering pass per
  # DIRECTORY is O(candidates x directories) with no copying, and the number of
  # distinct directories in one command is one or two.
  local i j d
  local dirs=() all_dir=() all_abs=()
  for ((i = 0; i < ${#candidates[@]}; i++)); do
    __norm_candidate "${candidates[$i]}" "${cand_bases[$i]:-$base_dir}" || continue
    all_dir+=("$__NC_DIR"); all_abs+=("$__NC_ABS")
    local hit=-1
    for ((j = 0; j < ${#dirs[@]}; j++)); do
      if [ "${dirs[$j]}" = "$__NC_DIR" ]; then hit=$j; break; fi
    done
    if [ "$hit" -lt 0 ]; then dirs+=("$__NC_DIR"); fi
  done
  for ((j = 0; j < ${#dirs[@]}; j++)); do
    d="${dirs[$j]}"
    local paths=() line set=$'\x1f'
    for ((i = 0; i < ${#all_dir[@]}; i++)); do
      if [ "${all_dir[$i]}" = "$d" ]; then paths+=("${all_abs[$i]}"); fi
    done
    if [ "${#paths[@]}" -gt 0 ]; then
      # `core.quotePath=false` and `-z`. By default git QUOTES any path with a
      # non-ASCII, control or backslash character -- `"uni-\303\274n.md"` --
      # which never matches the raw path the membership test looks for, so a
      # tracked file with such a name was ALLOWED. The `--error-unmatch` form
      # this replaced read an exit code and was immune; batching made the OUTPUT
      # load-bearing, so the output has to be literal. `-z` also removes the
      # newline-in-filename question entirely.
      #
      # NO `--full-name`: with `-C "$d"` git reports the tracked subset RELATIVE
      # TO `$d`, which is what the loop re-absolutises. A first draft piped
      # through `sed` to prepend the toplevel, which was redundant and tripped
      # `unresolved-target-class` fence 1 -- it forbids a `-C` inside a
      # grep/sed/awk expression, the shape of a hook hand-rolling its own
      # target-directory scan.
      # `:(literal)` so git does not apply its OWN escape handling to a pathspec
      # this hook has already resolved bash-style. Without it `ls-files --
      # 'READ\ME.md'` matched and PRINTED `README.md`, while the membership test
      # searched for the raw token -- a miss, and therefore an allow, for a
      # tracked file. The two resolutions have to happen once, here, not once in
      # each layer with different rules.
      #
      # NO CASE DISCRIMINATES THIS ONE, and saying so is better than implying a
      # fence that is not there: with the bash-side unescape above running
      # first, the pathspec handed to git no longer contains an escape for git
      # to resolve, so plain and `:(literal)` agree on every input the suite
      # has. It stays because the resolution has already happened and a second
      # one can only disagree -- probed, removing it reddens nothing.
      # CHUNKED, because one exec has an argument-size limit and exceeding it
      # is a FAIL-OPEN here: `ls-files` dies with E2BIG, `2>/dev/null` swallows
      # it, the set comes back empty, and every candidate in the bucket is
      # reported "not tracked". Measured on this machine: 5000 pathspecs
      # succeed, 20000 fail and print nothing. The union's own bound admits
      # `GATE_EDIT_MAXPAIRS` pairs, so a single bucket can reach that many.
      #
      # 500 per exec is two orders of magnitude under the limit and costs one
      # fork per 500 candidates -- still bounded, still far cheaper than the
      # per-candidate fork this batching replaced. A chunk that fails ANYWAY
      # falls back to `--error-unmatch` per path for that chunk only: slow, but
      # it reads an exit code instead of parsing output, so it cannot be fooled
      # by an empty result.
      local __lp=() __lpi __lpn=0 __chunk_rc
      for ((__lpi = 0; __lpi <= ${#paths[@]}; __lpi++)); do
        if [ "$__lpi" -lt "${#paths[@]}" ]; then
          __lp+=(":(literal)${paths[$__lpi]}")
          __lpn=$((__lpn + 1))
          [ "$__lpn" -lt "${GATE_EDIT_LSFILES_CHUNK:-500}" ] && continue
        fi
        [ "${#__lp[@]}" -gt 0 ] || continue
        # THROUGH A FILE, not a process substitution: the chunk's EXIT STATUS is
        # the thing that decides whether the fallback runs, and `< <(...)` does
        # not surrender it. A second `ls-files` just to read the status would
        # double the forks this batching exists to remove, and a command
        # substitution cannot hold the `-z` output because bash drops NULs.
        : > "$__lsf_tmp"
        git -C "$d" -c core.quotePath=false ls-files -z -- "${__lp[@]}" > "$__lsf_tmp" 2>/dev/null
        __chunk_rc=$?
        while IFS= read -r -d '' line; do
          [ -n "$line" ] || continue
          case "$line" in /*) ;; *) line="$d/$line" ;; esac
          set="$set$line"$'\x1f'
        done < "$__lsf_tmp"
        if [ "$__chunk_rc" != 0 ]; then
          local __fb
          for __fb in "${__lp[@]}"; do
            __fb="${__fb#:(literal)}"
            if git -C "$d" ls-files --error-unmatch -- ":(literal)$__fb" >/dev/null 2>&1; then
              set="$set$__fb"$'\x1f'
            fi
          done
        fi
        __lp=(); __lpn=0
      done
    fi
    __pp_lsf_dirs+=("$d"); __pp_lsf_set+=("$set")
  done
}

__prime_tracked() {
  local d="$1" i=0
  __prime_all_tracked
  while [ "$i" -lt "${#__pp_lsf_dirs[@]}" ]; do
    if [ "${__pp_lsf_dirs[$i]}" = "$d" ]; then __pp_lsf_idx=$i; return 0; fi
    i=$((i + 1))
  done
  # A directory nobody bucketed has no tracked candidates by construction.
  __pp_lsf_dirs+=("$d"); __pp_lsf_set+=($'\x1f')
  __pp_lsf_idx=$(( ${#__pp_lsf_dirs[@]} - 1 ))
}

# Is this directory inside an OPTED-IN worktree that is on main/master?
#
# Separate from `is_protected_path` on purpose. That function decides about a
# FILE and, since the tracked test was batched, only knows about files in the
# candidate list -- so probing it with a synthetic path (`.markgate.yml`) came
# back "not tracked", fell through to the source-dir arm, and answered NO for a
# real main tree. The overflow refusal asks a different question, so it gets its
# own predicate; both share the per-directory memo, so this costs no new forks.
__base_is_protected_tree() {
  local d="$1" i=0 branch top
  [ -d "$d" ] || return 1
  __canon_memo "$d"; d="$__CANON"
  while [ "$i" -lt "${#__pp_dir[@]}" ]; do
    if [ "${__pp_dir[$i]}" = "$d" ]; then
      branch="${__pp_branch[$i]}"; top="${__pp_top[$i]}"
      [ -n "$branch" ] || return 1
      [ -n "$top" ] || return 1
      [ "$branch" = main ] || [ "$branch" = master ] || return 1
      [ -f "$top/.markgate.yml" ] || return 1
      case "$d" in "$top"/.claude/worktrees | "$top"/.claude/worktrees/*) return 1 ;; esac
      PROTECT_BRANCH="$branch"; PROTECT_TOP="$top"
      return 0
    fi
    i=$((i + 1))
  done
  branch=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null) || branch=""
  if [ -n "$branch" ]; then
    top=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) || top=""
    if [ -n "$top" ]; then __canon_memo "$top"; top="$__CANON"; fi
  else
    top=""
  fi
  __pp_dir+=("$d"); __pp_branch+=("$branch"); __pp_top+=("$top")
  [ -n "$branch" ] || return 1
  [ -n "$top" ] || return 1
  [ "$branch" = main ] || [ "$branch" = master ] || return 1
  [ -f "$top/.markgate.yml" ] || return 1
  # SAME nested-worktree exclusion as `is_protected_path`. Without it the two
  # predicates disagreed: a write into `<top>/.claude/worktrees/foo` was allowed
  # by the ordinary path and REFUSED by the overflow path, which then named that
  # directory as the protected worktree.
  case "$d" in "$top"/.claude/worktrees | "$top"/.claude/worktrees/*) return 1 ;; esac
  PROTECT_BRANCH="$branch"; PROTECT_TOP="$top"
  return 0
}

is_protected_path() {
  # echo "BLOCK <reason>" on stderr-worthy hit, else nothing.
  # ONE normaliser, shared with `__prime_tracked`. This function used to carry
  # its own copy, and the two disagreed about canonicalisation, which killed the
  # `tracked` arm outright. A second copy of one predicate is the recurring
  # defect in this file, not an incidental one.
  __norm_candidate "$1" "${2:-$base_dir}" || return 1
  local dir="$__NC_DIR" abs="$__NC_ABS"
  # MEMOISED PER PARENT DIRECTORY. Asking git for the branch and the toplevel is
  # 2 `git` per candidate, and candidates overwhelmingly SHARE a parent -- so
  # without this the cost is linear in candidates when it is really linear in
  # distinct directories. Measured on a `gh pr comment --body` holding 900
  # blockquote lines, all of which are candidates: 7.15 s before, and that is on
  # origin/main, i.e. the shape was already within 3 s of the 10 s PreToolUse
  # timeout that disarms every gate.
  #
  # bash 3.2 has no associative arrays, and a linear scan is right anyway: the
  # number of DISTINCT parent directories in one command is one or two, so the
  # scan is shorter than the hash it would replace. `dir` arrives canonical from
  # the normaliser, so it is the key.
  local __ci=0 __hit=-1
  while [ "$__ci" -lt "${#__pp_dir[@]}" ]; do
    [ "${__pp_dir[$__ci]}" = "$dir" ] && { __hit=$__ci; break; }
    __ci=$((__ci + 1))
  done
  local branch top
  if [ "$__hit" -ge 0 ]; then
    branch="${__pp_branch[$__hit]}"; top="${__pp_top[$__hit]}"
  else
    branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null) || branch=""
    if [ -n "$branch" ]; then
      top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || top=""
      if [ -n "$top" ]; then __canon_memo "$top"; top="$__CANON"; fi
    else
      top=""
    fi
    __pp_dir+=("$dir"); __pp_branch+=("$branch"); __pp_top+=("$top")
  fi
  # A cached MISS is a miss: an empty branch or toplevel means the dir is not in
  # a git repo (or git failed), which is the same `return 1` the uncached path
  # took. Storing it is what keeps a repeated miss from re-forking.
  [ -n "$branch" ] || return 1
  [ -n "$top" ] || return 1
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
# THE OVERFLOW DECISION COMES FIRST, BEFORE THE DEDUPE.
#
# Once the bound has tripped the command is going to be refused, so
# deduplicating the pairs it already built is work whose result nothing reads.
# It is not free: at `GATE_EDIT_MAXPAIRS` the array holds thousands of entries,
# and the CI runner -- slower than any developer machine, and the only place
# bash 3.2 runs both halves -- spent 6 s of the 10 s PreToolUse budget on a
# k=19 / n=2000 command that was refused anyway. A budget is not the thing to
# relax when the hook is genuinely that close to being killed.

# THE OVERFLOW REFUSES, and it refuses only where the gate could ever apply.
# `__union_cd_bases` stops after `GATE_EDIT_MAXCD` distinct `cd` targets rather
# than analysing an n*k product that would outlive the 10 s PreToolUse timeout.
# Stopping is not permitting: the command was not analysed, so it is not
# allowed. But this hook fires on EVERY Bash call in ANY repo, so a blanket
# refusal would be a false block in unrelated trees -- the check below asks only
# the bounded question "is any base a protected main tree", which the
# per-directory memo answers without new forks.
# THE CANDIDATE COUNT NEEDS THE SAME FAIL-CLOSED BOUND AS THE `cd` COUNT.
# `GATE_EDIT_MAXCD` and `GATE_EDIT_MAXPAIRS` are both inside `__union_cd_bases`,
# which does not run at all when a command carries no `cd` -- and the per-
# candidate work is what costs. Measured on bash 3.2, the only bash CI has, with
# a quoted `--body` whose every line is a distinct `>` target and no `cd` at all:
# 2000 candidates 3.7 s, 6000 candidates 28.3 s, against a 10 s PreToolUse
# timeout after which the hook is KILLED and every gate on the call is disarmed.
# (origin/main is slower still on the same shape -- this is inherited cost, not
# introduced, but inherited cost past the timeout is the same fail-open.)
#
# Refusing rather than truncating, for the reason the `cd` bound refuses: a
# bound that analyses less and then ALLOWS is a hole, and three of them shipped
# in this branch before that was believed.
if [ "${#candidates[@]}" -ge "${GATE_EDIT_MAXCAND:-2500}" ]; then
  __union_overflow=1
  __overflow_reason="too many write candidates (${GATE_EDIT_MAXCAND:-2500})"
fi

if [ "${__union_overflow:-0}" = 1 ]; then
  for __ov in "${__cd_targets[@]:-$base_dir}" "$base_dir"; do
    if __base_is_protected_tree "$__ov"; then
      cat >&2 <<EOF
Blocked by main-tree-edit-gate: this command is too large to analyse safely.

  distinct cd targets: ${#__cd_targets[@]} (limit ${GATE_EDIT_MAXCD:-20})
  write candidates:    ${#candidates[@]}
  reason:              $__overflow_reason
  worktree:            $PROTECT_TOP  (on $PROTECT_BRANCH)
  tool:                $tool

Resolving every write target against every \`cd\` in this command would take
longer than the 10 s PreToolUse budget, after which this hook is killed and
cannot refuse anything -- so it refuses now rather than guessing.

Split the command: run the \`cd\`-heavy part on its own, then the write.
EOF
      exit 2
    fi
  done
fi


# Deduplicate only when the candidates will actually be CHECKED. This is an
# optimisation for `is_protected_path`, which does not run on the path above.
__dedupe_candidates
__i=0
# `${arr[@]}` ON AN EMPTY ARRAY IS AN UNBOUND-VARIABLE ABORT ON BASH 3.2 -- the
# only bash CI has -- while bash 4.4+ expands it to nothing. The refusal path
# above leaves `candidates` empty by design when the scan is skipped, so this
# loop aborted with rc=1: neither allow nor block, in an UNRELATED repository
# the gate should simply have passed. Same trap the dedupe hit one round
# earlier; both are guarded by a count now rather than by a `:-` default, which
# would inject a bogus candidate.
if [ "${#candidates[@]}" -gt 0 ]; then
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
fi

exit 0
