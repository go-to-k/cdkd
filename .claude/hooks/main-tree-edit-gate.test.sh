#!/usr/bin/env bash
# Smoke test for main-tree-edit-gate.sh.
#
# Builds a fixture repo on `main` plus a linked feature-branch
# worktree, then feeds the hook synthetic PreToolUse payloads and
# asserts the exit code. Run from the repo root:
#   bash .claude/hooks/main-tree-edit-gate.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/main-tree-edit-gate.sh"

# `HOOK_BASH=<path>` runs the HOOK under that interpreter too, not merely this
# suite. `run-tests.sh` already exports it alongside each shell it drives, and
# this file IGNORED it until 2026-09-07: the hook is `#!/usr/bin/env bash`, so a
# plain `bash "$HOOK"` takes whatever comes first on PATH -- 5.x -- while the
# suite itself ran under 3.2. "Passes under bash 3.2" was therefore true of the
# test and false of the thing under test, and a regex whose two bash engines
# DISAGREE (`gate_strip_prefix`; see .claude/rules/hooks-class-fences.md) could
# only fail on a runner that has 3.2 as both -- i.e. in CI, never here.
#
# Resolved to an ABSOLUTE path so the value cannot depend on where the hook is
# invoked from. `run-tests.sh` passes `bash` / `/bin/bash`, both of which
# `command -v` settles; the fallback only matters for a hand-typed relative
# path, and it deliberately resolves against the caller's cwd, not this file's.
HOOK_RUNNER="${HOOK_BASH:-bash}"
HOOK_RUNNER="$(command -v "$HOOK_RUNNER" 2>/dev/null || printf '%s' "$HOOK_RUNNER")"
case "$HOOK_RUNNER" in /*) ;; *) HOOK_RUNNER="$PWD/$HOOK_RUNNER" ;; esac

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

MAIN="$TMPDIR/main"
git init -q -b main "$MAIN"
mkdir -p "$MAIN/docs/_generated" "$MAIN/src"
echo "row" > "$MAIN/docs/_generated/ledger.tsv"
echo "x" > "$MAIN/src/existing.ts"
# A tracked file OUTSIDE `src|tests|docs|scripts|.claude`, so the only arm that
# can refuse a write to it is `tracked`. Without one, every "tracked" case in
# this file was actually exercising `new-source-file` -- which is how a dead
# `tracked` arm sat behind a green suite for an entire branch.
echo "readme" > "$MAIN/README.md"
# Opt the fixture into the gate (issue #1259).
touch "$MAIN/.markgate.yml"
git -C "$MAIN" add -A
git -C "$MAIN" -c user.email=t@t -c user.name=t commit -q -m init

# A second repo WITHOUT .markgate.yml (non-opted-in, e.g. a personal
# blog repo) whose tracked files must remain editable on main.
OPTOUT="$TMPDIR/optout"
git init -q -b main "$OPTOUT"
echo "draft" > "$OPTOUT/article.md"
git -C "$OPTOUT" add -A
git -C "$OPTOUT" -c user.email=t@t -c user.name=t commit -q -m init

# Feature worktree on a non-main branch.
WT="$MAIN/.claude/worktrees/feat"
git -C "$MAIN" worktree add -q "$WT" -b feat/work 2>/dev/null
mkdir -p "$WT/docs/_generated"
# The library's own directory, in BOTH trees. `__norm_candidate` returns 1 when
# a candidate's PARENT DIRECTORY does not exist, and the hook then exits 0
# without ever asking which branch the tree is on -- so a case naming a path
# under a directory nobody created passes for that reason and proves nothing
# about the arm it was written for. Both are created so the WORKTREE case and
# its MAIN-tree twin differ only in the tree, which is the thing under test.
mkdir -p "$WT/.claude/hooks/lib" "$MAIN/.claude/hooks/lib"

pass=0; fail=0
# run_case <expected_exit> <desc> <json>
run_case() {
  local expected="$1" desc="$2" json="$3" rc
  printf '%s' "$json" | "$HOOK_RUNNER" "$HOOK" >/dev/null 2>&1
  rc=$?
  if [[ "$rc" == "$expected" ]]; then
    pass=$((pass+1)); printf 'ok   (exit %s) %s\n' "$rc" "$desc"
  else
    fail=$((fail+1)); printf 'FAIL (exit %s, want %s) %s\n' "$rc" "$expected" "$desc"
  fi
}

# ASSERTS THE REFUSAL TEXT, not only the exit code.
#
# `run_case` compares rc and discards stderr, and rc alone cannot tell a REFUSAL
# from a CRASH: a `set -u` abort exits 2 as well. That is not hypothetical --
# the overflow refusal referenced `__cds`, a variable `local` to
# `__union_cd_bases`, so every overflow aborted with `__cds: unbound variable`
# and printed no message at all, while the case for it sat green on the crash.
# The same blindness hid a dead `tracked` arm behind a neighbouring arm that
# refused with the same code. Use this wherever WHICH refusal fired is the
# thing under test.
run_case_text() {
  local expected="$1" needle="$2" desc="$3" json="$4" rc out
  out=$(printf '%s' "$json" | "$HOOK_RUNNER" "$HOOK" 2>&1 >/dev/null); rc=$?
  if [[ "$rc" == "$expected" && "$out" == *"$needle"* ]]; then
    pass=$((pass+1)); printf 'ok   (exit %s, text) %s\n' "$rc" "$desc"
  else
    fail=$((fail+1))
    printf 'FAIL (exit %s want %s; text %s) %s\n' "$rc" "$expected" \
      "$([[ "$out" == *"$needle"* ]] && echo ok || echo MISSING)" "$desc"
    printf '     wanted text: %s\n     got: %s\n' "$needle" "$(printf '%s' "$out" | head -2)"
  fi
}

# 1. Edit a TRACKED file in the main tree on `main` -> BLOCK (2).
run_case 2 "Edit tracked ledger in main tree on main" \
  "$(jq -nc --arg fp "$MAIN/docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Edit", cwd:$cwd, tool_input:{file_path:$fp}}')"

# 2. Edit the SAME tracked file but inside the feature worktree -> PASS (0).
cp "$MAIN/docs/_generated/ledger.tsv" "$WT/docs/_generated/ledger.tsv" 2>/dev/null || true
run_case 0 "Edit tracked ledger inside feature worktree" \
  "$(jq -nc --arg fp "$WT/docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Edit", cwd:$cwd, tool_input:{file_path:$fp}}')"

# 3. Bash redirect `> trackedfile` in main tree on main -> BLOCK (2).
run_case 2 "Bash '> ledger.tsv' in main tree on main" \
  "$(jq -nc --arg cmd "echo hi > $MAIN/docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 4. Bash write to /tmp (untracked, outside repo) -> PASS (0).
run_case 0 "Bash '> /tmp/scratch' " \
  "$(jq -nc --arg cmd "echo hi > /tmp/scratch.$$.log" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 5. Write a NEW source file under src/ in main tree on main -> BLOCK (2).
run_case 2 "Write new src/ file in main tree on main" \
  "$(jq -nc --arg fp "$MAIN/src/brandnew.ts" --arg cwd "$MAIN" \
    '{tool_name:"Write", cwd:$cwd, tool_input:{file_path:$fp}}')"

# 6. Read-only Bash (no write target) in main tree -> PASS (0).
run_case 0 "Bash read-only grep in main tree" \
  "$(jq -nc --arg cmd "grep -n row $MAIN/docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 7. tee to tracked file in main tree on main -> BLOCK (2).
run_case 2 "Bash 'tee ledger.tsv' in main tree on main" \
  "$(jq -nc --arg cmd "echo x | tee $MAIN/docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 8. Variable-indirected write target is a KNOWN GAP -> PASS (0)
#    (documented: worktree-first process is the guard for this).
run_case 0 "Bash 'mv \$tmp \$LEDGER' (variable target, known gap)" \
  "$(jq -nc --arg cmd 'mv "$tmp" "$LEDGER"' --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 9. Edit a tracked file on main in a NON-opted-in repo (no
#    .markgate.yml) -> PASS (0). Issue #1259: unrelated personal repos
#    must not be gated.
run_case 0 "Edit tracked file on main in non-opted-in repo" \
  "$(jq -nc --arg fp "$OPTOUT/article.md" --arg cwd "$OPTOUT" \
    '{tool_name:"Edit", cwd:$cwd, tool_input:{file_path:$fp}}')"

# 10. Bash redirect to the same non-opted-in repo file -> PASS (0).
run_case 0 "Bash '>> article.md' on main in non-opted-in repo" \
  "$(jq -nc --arg cmd "echo more >> $OPTOUT/article.md" --arg cwd "$OPTOUT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 11-13. A QUOTED or ESCAPED `cd` must steer the gate exactly as the literal
# one does (go-to-k/cdkd#2614). The payload cwd is a DIFFERENT tree on purpose,
# so the command's own `cd` is the only thing that can reach the main tree --
# without it these read as "wrote a relative path somewhere else" and pass for
# the wrong reason. Measured against the pre-fix hook: the literal spelling
# exited 2 while all three of these exited 0, because the gate matched the verb
# `cd` as literal text while already unquoting its VALUE one line later.
for cd_spelling in '"cd"' "'cd'" '\cd'; do
  run_case 2 "Bash ${cd_spelling} <main tree> && '> ledger.tsv'" \
    "$(jq -nc --arg cmd "${cd_spelling} $MAIN && echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
      '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
done

# 14. The literal control for the three above, from the SAME foreign cwd -- so
# a change that broke `cd` resolution entirely would redden this too rather
# than leaving the trio passing vacuously.
run_case 2 "Bash literal cd <main tree> && '> ledger.tsv'" \
  "$(jq -nc --arg cmd "cd $MAIN && echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 15. And the other direction: a `cd` into the FEATURE worktree must still
# pass, so the fix cannot be "resolve every cd to the main tree".
run_case 0 "Bash \"cd\" <feature worktree> && '> ledger.tsv'" \
  "$(jq -nc --arg cmd "\"cd\" $WT && echo hi > docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 16-23. A `cd` AFTER the write must not move the base, and neither must one
# inside a subshell or a substitution (go-to-k/cdkd#2614 review). The first
# revision of that fix handed the WHOLE command to `cmd_last_cd_target`, which
# follows every `cd` in command position -- the library's own doc names a
# trailing one hijacking the lookup as the hazard its VERB argument exists for,
# and this gate has no verb. Measured against that revision, all eight of these
# were rc=0: the gate's own founding incident, reachable with ten characters of
# ordinary shell and no quoting trick at all.
for after in 'cd /tmp' 'cd /tmp \&\& ls'; do
  run_case 2 "Bash '> ledger.tsv' then '&& $after' in main tree" \
    "$(jq -nc --arg cmd "echo hi > docs/_generated/ledger.tsv && $after" --arg cwd "$MAIN" \
      '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
done
run_case 2 "Bash '> ledger.tsv' then '; cd /tmp' in main tree" \
  "$(jq -nc --arg cmd "echo hi > docs/_generated/ledger.tsv; cd /tmp" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 2 "Bash 'tee ledger.tsv' then '&& cd /tmp' in main tree" \
  "$(jq -nc --arg cmd "echo x | tee docs/_generated/ledger.tsv && cd /tmp" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 2 "Bash new src/ file then '&& cd /tmp' in main tree" \
  "$(jq -nc --arg cmd "echo hi > src/brandnew.ts && cd /tmp" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
# An ODD trailing backslash escapes the space, so `cd\ /tmp` is the single word
# `cd /tmp` -- bash answers "No such file or directory" and NEVER LEAVES the
# main tree, yet the segmenter used to hand this walk a clean `cd` + `/tmp`.
# Measured before the fix (go-to-k/cdkd#2650): rc=0, i.e. the write below was
# allowed onto a tracked file on `main`. THE EVEN-BACKSLASH SIBLING IS NOT A
# CONTROL and is no longer labelled one: run under guard-removed,
# guard-always-fires and pristine it returns 2 in all three, so it cannot
# discriminate the guard and calling it a control asserted something it never
# checked. It stays as an ordinary case -- `cd\\ /tmp` is a two-word command
# whose verb is `cd\`, refused whatever the guard does. The DISCRIMINATING
# control lives in `command-match.test.sh` ("a short verb still dequotes"),
# where removing the bound turns roughly twenty cases red.
run_case 2 "Bash escaped-space 'cd\\ /tmp' then '> ledger.tsv' in main tree" \
  "$(jq -nc --arg cmd 'cd\ /tmp ; echo hi > docs/_generated/ledger.tsv' --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 2 "Bash even-backslash 'cd\\\\ /tmp' then '> ledger.tsv' in main tree" \
  "$(jq -nc --arg cmd 'cd\\ /tmp ; echo hi > docs/_generated/ledger.tsv' --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
# NOT A CONTROL EITHER, for the same measured reason (rc=0 under both
# polarities). It bounds the blast radius: a real `cd` out of the tree still
# has to be honoured, or the fix above would have bought its rc=2 by breaking
# every legitimate move instead.
run_case 0 "Bash real 'cd /tmp' then a write there, from the main tree" \
  "$(jq -nc --arg cmd 'cd /tmp ; echo hi > ledger.tsv' --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
# A `(` inside a QUOTED argument is not a subshell. An earlier revision of the
# marking counted parens blind to quoting, so this marked the REAL `cd` as
# subshell-derived, ignored it, and blocked a write that lands in the worktree
# -- the loud direction, but wrong. The marking reads the segment through
# `strip_noncommand_spans` first, so the quoted `(` is gone before any paren is
# counted. The second case is its CONTROL: a real subshell `cd` must still be
# ignored, or the fix above would have been bought by disabling the marking.
run_case 0 "Bash a QUOTED ( then a real cd <wt> then a write there" \
  "$(jq -nc --arg cmd "echo \"a (b\" && cd $WT && echo x > docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 2 "Bash a REAL subshell cd <wt> then a write in main tree" \
  "$(jq -nc --arg cmd "( cd $WT ) ; echo x > docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
# A SUBSHELL cd does not move the caller's cwd, and `$( )` is the ordinary
# path-resolution idiom -- `.claude/hooks/**` carries it in ~20 files, so this
# one fires by accident rather than by contrivance.
run_case 2 "Bash '> ledger.tsv' then a SUBSHELL cd in main tree" \
  "$(jq -nc --arg cmd "echo hi > docs/_generated/ledger.tsv && (cd /tmp && ls)" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 2 "Bash '> ledger.tsv' then a SUBSTITUTION cd in main tree" \
  "$(jq -nc --arg cmd "echo hi > docs/_generated/ledger.tsv; x=\$(cd /tmp && pwd)" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 2 "Bash the 2026-06-21 ledger shape, with a trailing cd" \
  "$(jq -nc --arg cmd "printf 'a\tb\n' >> docs/_generated/ledger.tsv && cd $WT && git status" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 24-26. The SAME root cause in the opposite direction: writing inside the
# FEATURE worktree and then running the standing post-merge `cd <main> && git
# pull` was rc=2 on that revision -- a block naming a file the command never
# touches. Both directions are fixed by bounding the scan, so both are pinned.
run_case 0 "Bash write in feature tree then '&& cd <main> && git pull'" \
  "$(jq -nc --arg cmd "echo hi > docs/_generated/ledger.tsv && cd $MAIN && git pull" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
# The scan is ANCHORED, so a `cd` that is not the first command is not
# followed and the base stays the payload cwd -- here the feature worktree, so
# the write is unprotected and this PASSES. Same answer as origin/main.
run_case 0 "Bash a SUBSHELL cd <main> before a write in the feature tree" \
  "$(jq -nc --arg cmd "(cd $MAIN && git fetch) && echo hi > docs/x" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 0 "Bash a SUBSTITUTION cd <main> before a write in the feature tree" \
  "$(jq -nc --arg cmd "sha=\$(cd $MAIN && git rev-parse HEAD); echo \$sha > docs/x" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 27. And the control the eight above need: a `cd` BEFORE the write still
# moves the base, or they would all pass for the wrong reason.
run_case 0 "Bash 'cd /tmp && > ledger.tsv' still resolves to /tmp" \
  "$(jq -nc --arg cmd "cd /tmp && echo hi > docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 28-30. Carry-forward from the go-to-k/cdkd#2614 review of the bounded scan.
# `tee` is matched WITHOUT a trailing space -- requiring one let `tee\t<file>`
# through, a write the gate is supposed to see.
run_case 2 "Bash 'tee<TAB>ledger.tsv' then '&& cd /tmp' in main tree" \
  "$(jq -nc --arg cmd "$(printf 'echo x | tee\tdocs/_generated/ledger.tsv && cd /tmp')" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
# A command carrying BOTH a substitution and a backtick span: an earlier
# revision picked the opening delimiter from one arm and the CLOSING one by
# re-testing the original string, so it stripped to the wrong closer and lost
# the real `cd` after it.
# KNOWN FALSE REFUSALS, and the declared price of an anchored scan: a command
# whose FIRST segment is a substitution or a subshell has its real `cd` ignored,
# so the base stays the payload cwd -- the main tree here -- and the write is
# refused although it lands in the feature worktree. Loud, one rephrase away,
# and the direction this repo prefers: three attempts to widen the scan each
# traded this for a SILENT miss (go-to-k/cdkd#2650 carries the tables).
run_case 0 "Bash a backtick span, a \$( ) span, then 'cd <wt>' and a write" \
  "$(jq -nc --arg cmd "x=\`date\`; y=\$(pwd); cd $WT && echo hi > docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 0 "Bash the same two spans in the other order" \
  "$(jq -nc --arg cmd "y=\$(pwd); x=\`date\`; cd $WT && echo hi > docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 31. Same class as 29-30: the `cd` is not first, so it is not followed. Kept
# separate because a quoted `>` is what the TRUNCATION revision tripped over --
# it dropped the `cd` too, but silently BYPASSED instead of refusing whenever
# the payload cwd was a feature worktree. Pinning the refusing answer here is
# what makes that regression visible if the scan is ever widened again.
run_case 0 "Bash a quoted '>' before a real cd is not a write" \
  "$(jq -nc --arg cmd "echo \"a > b\" && cd $WT && echo x > docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 32-34. THE OTHER POLARITY OF 29-31, and the reason it is pinned: those three
# are described as false refusals, and from a main-tree cwd they are. Run from
# a FEATURE-worktree cwd with the `cd` pointing at the MAIN tree they are the
# same miss with the sign flipped -- the gate exits 0 and the write really does
# land on the main tree's tracked ledger. Round 3 of go-to-k/cdkd#2614 shipped
# exactly this shape while its comment claimed "loud direction", so the claim
# is now pinned in both polarities rather than asserted in one. INHERITED from
# origin/main, not introduced here; widening the scan to close it is
# go-to-k/cdkd#2650.
run_case 2 "Bash a backtick + \$( ) span then 'cd <main>' and a write" \
  "$(jq -nc --arg cmd "x=\`date\`; y=\$(pwd); cd $MAIN && echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 2 "Bash the same two spans in the other order, cd into main" \
  "$(jq -nc --arg cmd "y=\$(pwd); x=\`date\`; cd $MAIN && echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 2 "Bash a quoted '>' then 'cd <main>' and a write" \
  "$(jq -nc --arg cmd "echo \"a > b\" && cd $MAIN && echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 35-42. The VERB unquoting, against what bash actually does. A blanket
# backslash strip here manufactured a `cd` bash never runs and moved the base
# AWAY from the protected tree -- measured, the tracked file really was
# overwritten in a sandbox copy.
#
# EACH CASE BUILDS ITS SPELLING EXPLICITLY rather than looping over quoted
# literals. A `for` loop over single-quoted elements keeps the backslashes
# literal, so an earlier revision fed `"\\cd"` where its comment said `"\cd"`
# -- not vacuous, but not the spelling the regression was measured on either,
# and this suite has already shipped one genuinely vacuous case that way.
# The name of each case is the spelling, and the command is built from the same
# string.
verb_case() { # <want> <verb-as-bash-would-see-it>
  run_case "$1" "Bash a first token bash reads as [$2]" \
    "$(jq -nc --arg cmd "$2 /tmp ; echo hi > docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
      '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
}
# NOT `cd` to bash -- each must leave the base alone, so the write resolves in
# the main tree and BLOCKS.
verb_case 2 "'\cd'"
verb_case 2 '"\cd"'
verb_case 2 '"c\d"'
verb_case 2 '\\cd'
verb_case 2 'c\\d'
# ...and the ones bash really does read as `cd`, so the unescape cannot be
# tightened into a refusal. `\c\d` is the longest spelling that reaches `cd`,
# which is what the length bound on the unescape loop is derived from.
verb_case 0 'cd'
verb_case 0 '\cd'
verb_case 0 'c\d'
verb_case 0 '\c\d'
verb_case 0 "'cd'"
verb_case 0 '"cd"'

# 46. UNDER-RECOGNITION, pinned rather than fixed. `c""d`, `"c"d`, `'c'd` and
# `$(echo cd)` are `cd` to bash and not to this anchored regex, so the base is
# not moved. From a main-tree cwd that refuses (loud); from a feature-worktree
# cwd with the `cd` pointing at the main tree it is a silent miss, the same
# class as cases 32-34. INHERITED -- origin/main, 62922e18 and HEAD all answer
# the same. Reviewed and deliberately NOT fixed: the two revisions that caught
# this class are the two that opened main-tree-cwd bypasses, so a sixth attempt
# is the pattern this lane already paid for five times. go-to-k/cdkd#2650.
run_case 2 "Bash a partially-quoted cd verb from a feature cwd" \
  "$(jq -nc --arg cmd "c\"\"d $MAIN && echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"


# --- THE CHANGES THAT HAD NO CASE AT ALL (go-to-k/cdkd#2650 review round 2) ---
# Each of the five below was measured by a reviewer as rc 2 -> 0 with its
# implementation reverted, while all three suites stayed green. A behaviour with
# no case that goes red is not covered by "the suite passes"; it is covered by
# nothing. Every one writes a TRACKED file in the main tree, so the missing
# direction was a silent fail-open in each case.
run_case 2 "Bash a quoted ) inside a substitution, then a write in main tree" \
  "$(jq -nc --arg cmd "x=\$(echo 'a)b'; cd /tmp) ; echo hi > docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 2 "Bash a PROCESS SUBSTITUTION cd, then a write in main tree" \
  "$(jq -nc --arg cmd "diff <(cd /tmp && pwd) f ; echo hi > docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 2 "Bash a 'bash -c' cd cannot move the caller, then a write in main tree" \
  "$(jq -nc --arg cmd "bash -c \"cd /tmp\" ; echo hi > docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 2 "Bash an if-compound subshell cd, then a write in main tree" \
  "$(jq -nc --arg cmd "if (cd /tmp); then echo hi > docs/_generated/ledger.tsv; fi" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 2 "Bash a while-compound subshell cd, then a write in main tree" \
  "$(jq -nc --arg cmd "while (cd /tmp); do echo hi > docs/_generated/ledger.tsv; break; done" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# --- A WRITE INSIDE A SUBSTITUTION, FOLLOWED BY A cd ------------------------
# The body runs in a child, but its REDIRECTION lands in the caller's cwd, so
# the write is real. Bodies used to be drained once at the very END of the
# stream, which resolved them against the base as it stood AFTER the trailing
# `cd` -- the "a cd after the write moved the base" incident this gate exists
# for, arriving by a new route. Verified against real bash: the tracked file
# really was overwritten while the gate returned 0. These four spellings are
# what a differential oracle over a write grid reported, not what looked
# representative.
for __v in '$(echo hi > docs/_generated/ledger.tsv)' '$(echo hi >> docs/_generated/ledger.tsv)' \
           '`echo hi > docs/_generated/ledger.tsv`' '`echo hi >> docs/_generated/ledger.tsv`'; do
  run_case 2 "Bash a write inside $__v then '; cd /tmp' in main tree" \
    "$(jq -nc --arg cmd "x=$__v ; cd /tmp" --arg cwd "$MAIN" \
      '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
done
run_case 2 "Bash a cd inside one substitution and a write in the next" \
  "$(jq -nc --arg cmd "x=\$(cd /tmp) ; y=\$(echo hi > docs/_generated/ledger.tsv)" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# --- THE SUBSTITUTION MARK MUST NOT BE FORGEABLE ---------------------------
# `gate_segments_marked` carries "this segment came from a substitution body"
# as a sentinel byte in the stream. If a command can contain that byte, it can
# assert the property about itself -- and the property means "do not honour
# this `cd`", so asserting it turns a real `cd` into one the gate ignores.
# Measured before the input was sanitised: from a feature worktree,
# `<byte>cd <main tree> && echo hi > <tracked>` went rc 2 -> 0. The unprefixed
# twin is the control, and it discriminates: it is 2 in both worlds only
# because the byte is what does the damage.
__SENT=$(printf '\025')
run_case 2 "Bash a FORGED substitution mark cannot disarm a real cd (feature cwd)" \
  "$(jq -nc --arg cmd "${__SENT}cd $MAIN && echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 2 "Bash the same command without the forged mark (feature cwd)" \
  "$(jq -nc --arg cmd "cd $MAIN && echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 2 "Bash a forged mark mid-command does not disarm the cd either" \
  "$(jq -nc --arg cmd "echo ${__SENT}x ; cd $MAIN && echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# --- THE INPUT BOUND, BOTH SIDES AND THE OVER-BLOCK CONTROL -----------------
# Past GATE_EDIT_MAXBYTES the walk is skipped and the base is pinned at the
# payload cwd, which is strictly MORE refusing -- the second case is the proof,
# since the identical shape under the bound is correctly ALLOWED by the third.
# The fourth bounds the blast radius: a write to a path outside the repo must
# still pass, or the cheap path would be a blanket refusal of large commands in
# every repo on every branch, which is what this hook must never become.
__pad=": $(printf '#%.0s' $(seq 1 40000)) ;"
run_case 2 "Bash PAST the byte bound: write to a tracked file in main tree" \
  "$(jq -nc --arg cmd "$__pad echo hi > docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 2 "Bash PAST the byte bound: a real cd out is NOT followed (conservative)" \
  "$(jq -nc --arg cmd "$__pad cd /tmp ; echo hi > docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 0 "Bash UNDER the bound: the same real cd out IS followed" \
  "$(jq -nc --arg cmd "cd /tmp ; echo hi > docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 0 "Bash PAST the byte bound: a write OUTSIDE the repo still passes" \
  "$(jq -nc --arg cmd "$__pad echo hi > /tmp/elsewhere.txt" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# --- THE FAIL-CLOSED LOAD PATH, which had no case at all (go-to-k/cdkd#2650) -
# The guard has been here since the hook started sourcing the shared matcher,
# and nothing ran it. It matters more than an ordinary arm because this hook's
# matcher is `Edit|Write|Bash`: an unloadable library used to take away every
# tool an agent would repair it with. Measured the hard way -- an apostrophe
# inside a comment in the library's awk program closed the shell string, and the
# session that wrote it was locked out of its own repo, four times in one
# session.
#
# go-to-k/cdkd#2717 SPLIT that: `Bash` still fails closed, `Edit` and `Write` do
# not, because those two arms read `tool_input.file_path` and call no library
# function. The cases below assert BOTH halves against the same broken fixture
# -- the refusal and the surviving arms -- because either one alone is
# satisfiable by the bug it replaces: refusing everything passes the first, and
# passing everything passes the second.
BROKEN="$TMPDIR/broken"
cp -R .claude/hooks "$BROKEN"
echo 'this is not shell(' > "$BROKEN/lib/command-match.sh"

# run_broken <expected_exit> <needle|-> <desc> <json>
# `-` as the needle asserts the exit code alone. Runs the BROKEN copy, not
# `$HOOK`, so it cannot use `run_case` / `run_case_text`.
run_broken() {
  local expected="$1" needle="$2" desc="$3" json="$4" rc out ok_text
  out=$(printf '%s' "$json" | "$HOOK_RUNNER" "$BROKEN/main-tree-edit-gate.sh" 2>&1 >/dev/null); rc=$?
  if [[ "$needle" == "-" ]]; then ok_text=1
  elif [[ "$out" == *"$needle"* ]]; then ok_text=1
  else ok_text=0; fi
  if [[ "$rc" == "$expected" && "$ok_text" == 1 ]]; then
    pass=$((pass + 1)); printf 'ok   (exit %s, broken lib) %s\n' "$rc" "$desc"
  else
    fail=$((fail + 1))
    printf 'FAIL (exit %s want %s; text %s) %s\n' "$rc" "$expected" \
      "$([[ "$ok_text" == 1 ]] && echo ok || echo MISSING)" "$desc"
    printf '     wanted text: %s\n     got: %s\n' "$needle" "$(printf '%s' "$out" | head -2)"
  fi
}

run_broken 2 "Restore that file" "a Bash call with an unloadable library fails CLOSED" \
  "$(jq -nc --arg cwd "$MAIN" '{tool_name:"Bash", cwd:$cwd, tool_input:{command:"echo hi > docs/_generated/ledger.tsv"}}')"

# The Bash refusal is unconditional within its arm -- a write to /tmp is refused
# too, because deciding that it is safe is exactly the parse the hook cannot do.
run_broken 2 "Restore that file" "an unloadable library refuses EVERY Bash call, not only in-tree writes" \
  "$(jq -nc --arg cwd "$MAIN" '{tool_name:"Bash", cwd:$cwd, tool_input:{command:"echo hi > /tmp/elsewhere.txt"}}')"

# The refusal has to say what SURVIVES, or an agent reads it as a dead end and
# starts working around the gate. Every SENTENCE of that advice gets a needle,
# not just the headline: a review found lines 100-108 of the hook individually
# deletable with the suite green, which is the same "the text is load-bearing"
# claim going unpinned that this PR objects to in the text it replaced.
#
# The worktree qualifier is the one that was WRONG before this round. "Repair it
# with the Edit or Write tool" is false in the main tree on `main`, where the
# tracked-file arm refuses that edit -- the very case pinned below.
__refusal_payload="$(jq -nc --arg cwd "$MAIN" '{tool_name:"Bash", cwd:$cwd, tool_input:{command:"echo hi > docs/_generated/ledger.tsv"}}')"
run_broken 2 "lib/command-match.sh is missing or unloadable" \
  "the refusal names WHICH file, so 'Restore that file' has an antecedent" "$__refusal_payload"
run_broken 2 "cannot resolve the command's working directory" \
  "the refusal says what the missing file cost it" "$__refusal_payload"
run_broken 2 "Restore that file" "the refusal says what to do" "$__refusal_payload"
run_broken 2 "Only Bash is refused" "the refusal names the arms that still work" "$__refusal_payload"
run_broken 2 "FROM A FEATURE WORKTREE" "the refusal names WHERE the repair is possible" "$__refusal_payload"
run_broken 2 "can repair it with the Edit or Write tool" \
  "the refusal names the repair itself, not only the place it works" "$__refusal_payload"
run_broken 2 "In the main tree on main this gate refuses that edit too" \
  "the refusal names where it is NOT, instead of overstating the route" "$__refusal_payload"
run_broken 2 "the repair belongs to the operator" \
  "the refusal names WHO repairs it in the main tree" "$__refusal_payload"
run_broken 2 "To inspect the file first" \
  "the refusal labels bash -n as an INSPECTION, not as the repair" "$__refusal_payload"
run_broken 2 "bash -n" "the refusal names the inspection command" "$__refusal_payload"
run_broken 2 "no longer refused is the proof" "the refusal says how to tell the repair worked" "$__refusal_payload"

# The refusal has to be the FIRST thing the arm does. Moving it below the
# `[[ -z "$cmd" ]] && exit 0` on the next line survives every other case in this
# file, and turns an empty or absent `command` under a broken library from 2
# into 0. Nothing else in the suite reaches the arm with no command.
run_broken 2 "Restore that file" "an EMPTY Bash command still hits the refusal (guard is above the -z bail)" \
  "$(jq -nc --arg cwd "$MAIN" '{tool_name:"Bash", cwd:$cwd, tool_input:{command:""}}')"

# THE LOCKOUT CASES. Each of these exits 2 against the pre-go-to-k/cdkd#2717
# hook -- that is what "locked out" meant -- and 0 here.
#
# `Edit` and `Write` are asserted SEPARATELY, but not because dropping a label
# from the `case` pattern would otherwise be invisible -- case 5 above (a Write
# of a new `src/` file, expecting 2) already fences `Write`, and dropping the
# label sends it to `*)` and 0. They are separate because an expect-0 case
# proves nothing on its own about WHICH arm answered, so each needs the
# same-tool ENFORCEMENT control below it.
run_broken 0 - "Edit outside the repo is ALLOWED with an unloadable library" \
  "$(jq -nc --arg fp "$TMPDIR/scratch.txt" --arg cwd "$MAIN" \
    '{tool_name:"Edit", cwd:$cwd, tool_input:{file_path:$fp}}')"
run_broken 0 - "Write outside the repo is ALLOWED with an unloadable library" \
  "$(jq -nc --arg fp "$TMPDIR/scratch.txt" --arg cwd "$MAIN" \
    '{tool_name:"Write", cwd:$cwd, tool_input:{file_path:$fp}}')"
# The repair itself, in the tree where the library an agent actually edits
# lives. This one passes for the BRANCH reason -- a feature worktree always
# passes -- where the two above pass for a different one (outside any repo).
# The MAIN-tree twin immediately below is what makes that claim checkable: same
# path shape, same broken library, same absent-or-present parent directory,
# differing only in the tree. Without the twin the case was a THIRD spelling of
# "a path the gate could not resolve" -- `$WT/.claude/hooks/lib` did not exist,
# so it exited before the branch lookup and its MAIN-tree twin returned 0 too.
run_broken 0 - "Write to the library in a FEATURE worktree survives an unloadable library" \
  "$(jq -nc --arg fp "$WT/.claude/hooks/lib/command-match.sh" --arg cwd "$WT" \
    '{tool_name:"Write", cwd:$cwd, tool_input:{file_path:$fp}}')"
run_broken 2 "Blocked by main-tree-edit-gate" \
  "the same library path in the MAIN tree on main is refused (the twin)" \
  "$(jq -nc --arg fp "$MAIN/.claude/hooks/lib/command-match.sh" --arg cwd "$MAIN" \
    '{tool_name:"Write", cwd:$cwd, tool_input:{file_path:$fp}}')"

# ...and the controls that keep the lockout cases from being fail-open. The
# surviving arms must still ENFORCE: a protected main-tree target is refused by
# the gate's OWN message, not by the load refusal. The needle discriminates
# which of the two fired.
#
# ONE PER TOOL LABEL, and that is not symmetry for its own sake. With only the
# `Edit` control, inserting `[ "$tool" = Write ] && [ "$__lib_loaded" != 1 ] &&
# exit 0` into the dispatch survived the whole suite: the `Write` lockout case
# asserts an exit code alone, so a fail-open there is indistinguishable from the
# arm working. Measured on this suite before the `Write` control existed.
run_broken 2 "Blocked by main-tree-edit-gate" \
  "Edit of a tracked main-tree file is still BLOCKED with an unloadable library" \
  "$(jq -nc --arg fp "$MAIN/docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Edit", cwd:$cwd, tool_input:{file_path:$fp}}')"
run_broken 2 "Blocked by main-tree-edit-gate" \
  "Write to a tracked main-tree file is still BLOCKED with an unloadable library" \
  "$(jq -nc --arg fp "$MAIN/docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Write", cwd:$cwd, tool_input:{file_path:$fp}}')"

# THE OTHER TWO LABELS IN THE `case` PATTERN. A Claude Code matcher is an
# UNANCHORED REGEX, so `Edit|Write|Bash` matches `MultiEdit` and `NotebookEdit`
# on the substring `Edit` and this hook IS invoked for both. `MultiEdit` was in
# the file-path arm with no case; `NotebookEdit` was in NEITHER, so a notebook
# write to a tracked file in the main tree on `main` was allowed outright --
# a hole that predates the load-refusal split and is closed with it.
#
# Both are pinned with the pair, like Edit and Write: the allow case alone
# cannot tell the arm answering from `*)` answering.
for __t in MultiEdit NotebookEdit; do
  run_broken 2 "Blocked by main-tree-edit-gate" \
    "$__t of a tracked main-tree file is BLOCKED with an unloadable library" \
    "$(jq -nc --arg t "$__t" --arg fp "$MAIN/docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
      '{tool_name:$t, cwd:$cwd, tool_input:{file_path:$fp}}')"
  run_broken 0 - "$__t outside the repo is ALLOWED with an unloadable library" \
    "$(jq -nc --arg t "$__t" --arg fp "$TMPDIR/scratch.txt" --arg cwd "$MAIN" \
      '{tool_name:$t, cwd:$cwd, tool_input:{file_path:$fp}}')"
done

# THE `*)` ARM, which the hook spends a paragraph justifying and nothing
# measured: replacing its `exit 0` with the refusal left the suite green. An
# unclassifiable `tool_name` -- a malformed payload, or `jq` missing too -- must
# PASS even with the library unloadable, because refusing there puts Edit and
# Write back inside the refusal and re-creates the lockout by a second route.
# The target is a tracked main-tree file, so this is the strongest form: even
# there, an unknown tool is not this hook's business.
run_broken 0 - "an unclassifiable tool_name falls to *) and PASSES (refusing there re-creates the lockout)" \
  "$(jq -nc --arg fp "$MAIN/docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"WebFetch", cwd:$cwd, tool_input:{file_path:$fp}}')"
run_broken 0 - "an ABSENT tool_name does the same" \
  "$(jq -nc --arg fp "$MAIN/docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{cwd:$cwd, tool_input:{file_path:$fp}}')"
# A library that LOADS CLEANLY but lacks the symbol. The broken-syntax fixture
# above can never reach the `declare -F gate_segments_marked` clause -- it trips
# the `. source` arm first -- so that clause was load-bearing and untested:
# measured, dropping it makes this hook accept `origin/main`'s library and
# return 0 on a tracked-file write. Anything defining the other two helpers but
# not this one does; a stub is used rather than a git object so the case does
# not depend on the repo's history being fetched.
STUBLIB="$TMPDIR/stublib"
cp -R .claude/hooks "$STUBLIB"
{
  printf 'gate_unquote_span() { printf %%s "$1"; }\n'
  printf 'gate_unquote() { printf %%s "$1"; }\n'
  printf 'gate_segments() { printf %%s "$1"; }\n'
} > "$STUBLIB/lib/command-match.sh"
printf '%s' \
  "$(jq -nc --arg cwd "$MAIN" '{tool_name:"Bash", cwd:$cwd, tool_input:{command:"echo hi > docs/_generated/ledger.tsv"}}')" \
  | "$HOOK_RUNNER" "$STUBLIB/main-tree-edit-gate.sh" >/dev/null 2>&1
sl_rc=$?
if [[ "$sl_rc" == 2 ]]; then
  pass=$((pass + 1)); echo "ok   (exit 2) a library missing gate_segments_marked fails CLOSED"
else
  fail=$((fail + 1)); echo "not ok (exit $sl_rc, want 2) a loadable library without gate_segments_marked must fail CLOSED"
fi
# ...and the arm split holds on THIS arm too. The `declare -F` clause and the
# `. source` clause are different code paths to the same flag, and only the
# second had an Edit case -- so a split applied to one and not the other would
# have been invisible here.
#
# IT IS A PAIR, for the same reason every other allow-case here is. With only
# the allow half, a fail-open reachable in exactly this state --
# `if declare -F gate_unquote && ! declare -F gate_segments_marked &&
# [ "$tool" != Bash ]; then exit 0; fi` -- survived the whole suite: exit 0 from
# the arm and exit 0 from a fail-open are the same byte.
run_stublib() { # <expected> <needle|-> <desc> <json>
  local expected="$1" needle="$2" desc="$3" json="$4" rc out ok_text
  out=$(printf '%s' "$json" | "$HOOK_RUNNER" "$STUBLIB/main-tree-edit-gate.sh" 2>&1 >/dev/null); rc=$?
  if [[ "$needle" == "-" || "$out" == *"$needle"* ]]; then ok_text=1; else ok_text=0; fi
  if [[ "$rc" == "$expected" && "$ok_text" == 1 ]]; then
    pass=$((pass + 1)); printf 'ok   (exit %s, stub lib) %s\n' "$rc" "$desc"
  else
    fail=$((fail + 1))
    printf 'FAIL (exit %s want %s; text %s) %s\n' "$rc" "$expected" \
      "$([[ "$ok_text" == 1 ]] && echo ok || echo MISSING)" "$desc"
    printf '     wanted text: %s\n     got: %s\n' "$needle" "$(printf '%s' "$out" | head -2)"
  fi
}
run_stublib 0 - "an Edit survives a library missing gate_segments_marked" \
  "$(jq -nc --arg fp "$TMPDIR/scratch.txt" --arg cwd "$MAIN" \
    '{tool_name:"Edit", cwd:$cwd, tool_input:{file_path:$fp}}')"
run_stublib 2 "Blocked by main-tree-edit-gate" \
  "...and still ENFORCES on a tracked main-tree file (the control for it)" \
  "$(jq -nc --arg fp "$MAIN/docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Edit", cwd:$cwd, tool_input:{file_path:$fp}}')"

# An IDENTICAL copy with a WORKING library is the control: it proves the
# assertions above came from the broken library and not from the copying.
#
# It is a second copy rather than `$BROKEN` repaired in place. Repairing
# `$BROKEN` here made every `run_broken` added BELOW this line silently run
# against a healthy library -- an ordering hazard with no symptom, because such
# a case does not fail, it just stops measuring anything. `$BROKEN` now stays
# broken for the whole file, and the assertion after the control says so.
BROKEN_CTL="$TMPDIR/broken-ctl"
cp -R .claude/hooks "$BROKEN_CTL"
printf '%s' \
  "$(jq -nc --arg cwd "$MAIN" '{tool_name:"Bash", cwd:$cwd, tool_input:{command:"echo hi > /tmp/elsewhere.txt"}}')" \
  | "$HOOK_RUNNER" "$BROKEN_CTL/main-tree-edit-gate.sh" >/dev/null 2>&1
fc_ctl=$?
if [[ "$fc_ctl" == 0 ]]; then
  pass=$((pass + 1)); echo "ok   (exit 0) an identical copy with a WORKING library allows an outside write"
else
  fail=$((fail + 1)); echo "not ok (exit $fc_ctl, want 0) the copied hook must work when its library loads"
fi
# Every `run_broken` above asserted something only because `$BROKEN`'s library
# was still unloadable when it ran. Nothing else says so, and the thing that
# would break it -- repairing `$BROKEN` mid-file, as this control used to --
# leaves those cases green while they measure nothing.
# EXISTENCE IS CHECKED SEPARATELY. `bash -n <absent file>` exits 127, which is
# non-zero and so read as "still broken" -- so `rm -f` on the fixture passed this
# assertion. Deleting the library IS a broken library for the hook, but not for
# the cases above: they assert the SOURCE arm's refusal, and a file that is gone
# takes a different path to it. Both halves, or the guard has a hole where the
# thing it guards against is one command away.
if [[ ! -f "$BROKEN/lib/command-match.sh" ]]; then
  fail=$((fail + 1)); echo "not ok \$BROKEN's library is GONE -- the run_broken cases did not exercise the syntax-error arm"
elif "$HOOK_RUNNER" -n "$BROKEN/lib/command-match.sh" 2>/dev/null; then
  fail=$((fail + 1)); echo "not ok \$BROKEN's library PARSES -- every run_broken case above measured nothing"
else
  pass=$((pass + 1)); echo "ok   \$BROKEN's library is present and still unparsable at the end of the block"
fi

# A FLOOR, which this suite never had. Its sibling `command-match.test.sh`
# tightened one to zero slack while a DELETED case here stayed invisible -- and
# this is the only suite in which the four fail-opens found in review could be
# expressed at all, so a silent shrink here is the expensive kind. At the
# observed count: both bash builds agree, so no case is version-gated.
# --- FOUR BEHAVIOURS A REVIEWER MEASURED AS UNFENCED ------------------------
# Each was revertible with the gate suite, the oracle, the matcher suite and the
# differential ALL green. "Every suite passes" is not coverage; a case that goes
# red is. Each of these was watched doing so before being written down.
#
# 1. The `cd` TARGET is unquoted (`gate_unquote`), not just the verb. Cases
#    11-13 quote the VERB and the oracle uses a bare path, so dropping the
#    target unquote was invisible: measured, from a feature cwd
#    `cd "<main>" && echo hi > <tracked>` went 2 -> 0.
run_case 2 "Bash a QUOTED cd TARGET from a feature cwd still resolves" \
  "$(jq -nc --arg cmd "cd \"$MAIN\" && echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
# 2. A substitution followed by a multi-line `--body`. THIS CASE DOES NOT
#    DISCRIMINATE `drain_extra`'s quote handling and is not claimed to: probed
#    against the shipped code, dropping the body's `ignore_q` retry leaves this
#    suite at 76/0. What that repair IS fenced by is the verb question, one
#    layer down -- `gate_matches ... GATE_RE_GIT_COMMIT` on a backtick body
#    whose `#` comment carries an apostrophe goes MATCH -> NO-MATCH, measured
#    before and after the fix. The case stays because the shape is worth having
#    in the gate's own corpus, but the fence lives in `command-match.test.sh`.
run_case 2 "Bash a substitution then a multi-line body then a write" \
  "$(jq -nc --arg cmd 'x=$(cd /tmp) ; gh pr comment 1 --body "a
b" ; echo hi > docs/_generated/ledger.tsv' --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
# 3. `sed -i` is a write vehicle on BOTH paths, and the suite had no `sed` case
#    at all -- only the oracle exercised it.
run_case 2 "Bash sed -i rewriting a tracked file in the main tree" \
  "$(jq -nc --arg cmd "sed -i.bak -e s/row/POISON/ docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
# 4. The over-cap path unions in raw-text `cd` targets. Without that union a
#    feature-worktree write reached the main tree behind 210 padding segments.
run_case 2 "Bash over the marking cap, cd INTO the main tree from a feature cwd" \
  "$(jq -nc --arg cmd "$(printf '; true %.0s' $(seq 1 210)) ; cd $MAIN && echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 5-8. THE FOUR BLOCKERS THE go-to-k/cdkd#2711 REVIEW FOUND, each a fail-open
#      this branch INTRODUCED and each measured rc 2 -> 0 against origin/main's
#      2 before the repair. They are here rather than in the oracle because the
#      oracle's grid has no axis for any of them.
#
# 5. The over-cap compensation asked a re-derived question over a different
#    population: the library counts RAW segment lines (blanks included), this
#    hook counted the OUTPUT stream (blanks dropped). So an ordinary multi-line
#    call could be over the cap in the library -- every `cd` discarded -- and
#    under it by the hook's count, with nothing compensating.
run_case 2 "Bash blank-line padding puts the library over the cap, not the hook" \
  "$(jq -nc --arg cmd "cd $MAIN$(printf '\n%.0s' $(seq 1 200))
echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
# 6. The same defect reached by a shape nobody would call padding: a plain
#    multi-line script with blank lines between its steps.
run_case 2 "Bash an ordinary multi-line script, blank lines between steps" \
  "$(jq -nc --arg cmd "cd $MAIN
$(for i in $(seq 1 110); do printf 'echo step%s\n\n' "$i"; done)
echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
# 7. `GATE_EDIT_MAXPAIRS` was tested as `added + n > cap` with `added` zero on
#    the first pass, so a command already carrying more than `cap` candidates
#    unioned NOTHING -- the cap became the off-switch the union exists to deny.
#    Every `>` is a candidate, so a quoted body of markdown blockquotes reaches
#    it with no padding at all.
#    THE LINE COUNT IS CHOSEN TO CROSS `GATE_EDIT_MAXBYTES`, and an earlier
#    revision of this case did not. 211 lines is 3874 B -- UNDER the 4096 B cap
#    -- so it took the ordinary walk and never reached `__union_cd_bases` at
#    all: the case passed while the union was broken, which is how the round-10
#    regression below shipped past a suite reporting 83/0. 250 lines is 4.5 KB
#    and takes the over-bytes arm, which is the one under test.
run_case 2 "Bash a 250-line quoted body starves the cd union of its budget" \
  "$(jq -nc --arg cmd "cd $MAIN ; true --body \"$(for i in $(seq 1 250); do printf '> quoted line %s\n' "$i"; done)\" ; echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
#    And the round-10 shape itself: past the budget the union used to copy the
#    array's HEAD, while the real write target is its TAIL. Measured rc 2 -> 0
#    at N=240 with the tracked file really overwritten.
run_case 2 "Bash a 900-line quoted body: the write is the LAST candidate" \
  "$(jq -nc --arg cmd "cd $MAIN ; true --body \"$(for i in $(seq 1 900); do printf '> quoted line %s\n' "$i"; done)\" ; echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
# 8. The union matched a bare literal `cd`, so `"cd"` / `'cd'` / `\cd` -- the
#    spellings go-to-k/cdkd#2614 closed on the ordinary walk -- were invisible
#    on BOTH bounded paths. Paired with its literal control, which passes on
#    every revision, so the pair cannot go green together by accident.
run_case 2 "Bash a QUOTED cd verb on the over-bytes path" \
  "$(jq -nc --arg cmd ": '$(printf 'a%.0s' $(seq 1 5000))' ; \"cd\" $MAIN && echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 2 "Bash a LITERAL cd verb on the over-bytes path (control)" \
  "$(jq -nc --arg cmd ": '$(printf 'a%.0s' $(seq 1 5000))' ; cd $MAIN && echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
# 9. Unbounded `bash -c` recursion: each level restarted with a fresh
#    `GATE_MARK_MAXSEG` budget and contributed ONE segment to its parent, so
#    neither existing bound could see the nesting. Cost was quadratic --
#    measured 24.1 s at 4087 bytes against a 10 s PreToolUse timeout, and a
#    KILLED hook cannot emit exit 2, which disarms every gate at once.
#
#    THE EXPECTATION IS 0, AND THAT IS THE POINT. Asked of real bash rather than
#    assumed: `sh -c` runs a CHILD, so none of those `cd`s moves this shell, the
#    write resolves against the FEATURE worktree, and a feature worktree always
#    passes -- measured, the worktree's ledger is written and the main tree's is
#    not. A first draft of this case asserted 2 and was wrong about bash, not
#    about the gate. What it pins is that the depth bound did not change the
#    VERDICT for the shape it bounds; the cost half is fenced by the latency
#    assertion in command-match.test.sh, which can time the library directly.
run_case 0 "Bash deeply nested sh -c around a cd, then a write" \
  "$(jq -nc --arg cmd "$(printf 'sh -c %.0s' $(seq 1 300))cd $MAIN ; echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 10. LATENCY, and it is a gate-bypass case rather than a performance one: past
#     the 10 s PreToolUse timeout the hook is KILLED and cannot emit exit 2, so
#     every gate goes quiet at once. Every `>` is a write candidate, so a
#     `--body` holding N blockquote lines carries N of them, and each used to
#     cost a `dirname` fork plus a subshell plus two `git` calls. Measured on
#     900 such lines: origin/main 7.15 s, this branch 13.79 s before the union
#     cap was bounded by WORK rather than by rounds, 8.86 s after, and 0.17 s
#     once the per-parent-directory memo landed. The budget is deliberately far
#     under the timeout and far over the measured cost, so this fails on a
#     return of the per-candidate forks, not on a slow machine.
__lat_body=$(awk 'BEGIN{printf "cd /tmp\n"; for(i=0;i<900;i++) printf "> quoted line %d\n", i}')
__lat_json=$(jq -nc --arg cmd "gh pr comment 1 --body \"$__lat_body\"" --arg cwd "$MAIN" \
  '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')
__lat_t0=$(date +%s)
printf '%s' "$__lat_json" | "$HOOK_RUNNER" "$HOOK" >/dev/null 2>&1
__lat_t1=$(date +%s)
__lat_secs=$((__lat_t1 - __lat_t0))
if [ "$__lat_secs" -le 4 ]; then
  pass=$((pass + 1))
  printf 'ok   latency: 900 write candidates in %ss (budget 4s, timeout 10s)\n' "$__lat_secs"
else
  fail=$((fail + 1))
  printf 'FAIL latency: 900 write candidates took %ss, budget 4s\n' "$__lat_secs"
fi

# 11-13. THE SHAPES THAT DEFEATED THREE SUCCESSIVE VERSIONS OF THE UNION CAP.
#        All three passed a suite reporting 83/0 while the gate allowed a write
#        bash really performed, so they are pinned by shape rather than by the
#        cap arithmetic that happened to be wrong that round.
#
# 11. A DECOY `cd` INSIDE A QUOTED BODY, ahead of the real one. Under any cap
#     that budgeted the first round, only the decoy was unioned and the real
#     `cd <main tree>` was dropped. The decoy is not contrived: this hook's own
#     refusal message prints `cd .claude/worktrees/<slug>`, so quoting the
#     message in a `--body` is enough. Paired with its control -- same command
#     with the decoy line removed -- so the pair cannot go green together.
run_case 2 "Bash a decoy cd in a quoted body ahead of the real one" \
  "$(jq -nc --arg cmd "true --body \"  cd .claude/worktrees/hardening
$(for i in $(seq 1 250); do printf '> quoted line %s\n' "$i"; done)\" ; cd $MAIN ; echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 2 "Bash the same without the decoy (control)" \
  "$(jq -nc --arg cmd "true --body \"$(for i in $(seq 1 250); do printf '> quoted line %s\n' "$i"; done)\" ; cd $MAIN ; echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
# 12. DISTINCT tokens, which the deduplication cannot collapse and the
#     repeated-token latency case above structurally cannot see. This is the
#     cost shape: 2500 of them cost 18 s -- past the 10 s PreToolUse timeout,
#     where the hook is killed and cannot emit exit 2 -- before `ls-files` was
#     batched per directory and the deduplication learned to scale. Asserts the
#     VERDICT here; the clock is asserted below.
run_case 2 "Bash 1500 DISTINCT write-candidate tokens, then a real cd" \
  "$(jq -nc --arg cmd "cd $MAIN ; gh pr comment 1 --body \"$(for i in $(seq 1 1500); do printf '> tok%s line %s\n' "$i" "$i"; done)\" ; echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 13. The clock for that shape. The existing latency case uses a REPEATED token
#     and measures 0 s however bad the per-candidate cost gets, so it could not
#     have caught this; distinct tokens are the discriminating input.
__vt_body=$(for i in $(seq 1 1500); do printf '> tok%s line %s\n' "$i" "$i"; done)
__vt_json=$(jq -nc --arg cmd "cd $MAIN ; gh pr comment 1 --body \"$__vt_body\" ; echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
  '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')
__vt_t0=$(date +%s)
printf '%s' "$__vt_json" | "$HOOK_RUNNER" "$HOOK" >/dev/null 2>&1
__vt_t1=$(date +%s)
__vt_secs=$((__vt_t1 - __vt_t0))
if [ "$__vt_secs" -le 4 ]; then
  pass=$((pass + 1))
  printf 'ok   latency: 1500 DISTINCT candidates in %ss (budget 4s, timeout 10s)\n' "$__vt_secs"
else
  fail=$((fail + 1))
  printf 'FAIL latency: 1500 DISTINCT candidates took %ss, budget 4s\n' "$__vt_secs"
fi

# 14-17. ROUND 14. Three of these are engine-parity or bound cases the suite had
#        no shape for; the fourth is a false BLOCK, which this file had almost
#        no coverage of at all.
#
# 14. A BACKSLASH IN THE WRITE TARGET. The token classes were spelled
#     `[^[:space:]\<\>\|\&\;\(\)]`, and a backslash inside a bracket expression
#     is an ordinary MEMBER under POSIX -- so bash 3.2 ended the token at the
#     backslash and 5.x did not. `echo x > back\slash.md` extracted `back` under
#     3.2, which is not a tracked file, so the gate allowed a write to one, on
#     the only bash CI runs. Same root cause as `gate_strip_prefix`'s, six sites
#     away. This case needs the fixture file to exist and be TRACKED, so it
#     builds its own rather than using the shared one.
mkdir -p "$TMPDIR/bsrepo"
git init -q -b main "$TMPDIR/bsrepo" >/dev/null 2>&1
printf 'x\n' > "$TMPDIR/bsrepo/back\\slash.md"
touch "$TMPDIR/bsrepo/.markgate.yml"
git -C "$TMPDIR/bsrepo" add -A >/dev/null 2>&1
git -C "$TMPDIR/bsrepo" -c user.email=t@t -c user.name=t commit -q -m init >/dev/null 2>&1
#     THE COMMAND NEEDS A DOUBLED BACKSLASH. `> back\slash.md` is
#     `backslash.md` to bash -- quote removal, measured -- and that file is not
#     tracked, so 0 is the right answer for it. The round-14 revision of this
#     case asserted 2 for that spelling and was wrong about bash, not about the
#     gate; it passed only because the fixture happened to be the one
#     arrangement where `git ls-files` echoed the raw token back.
run_case 2 "Bash a doubled backslash naming the tracked file" \
  "$(jq -nc --arg cmd 'echo x > back\\slash.md' --arg cwd "$TMPDIR/bsrepo" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 0 "Bash a single backslash, which names a different file (control)" \
  "$(jq -nc --arg cmd 'echo x > back\slash.md' --arg cwd "$TMPDIR/bsrepo" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 0 "Bash an UNTRACKED target in the same repo (control)" \
  "$(jq -nc --arg cmd 'echo x > untracked.md' --arg cwd "$TMPDIR/bsrepo" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
# 15. THE PRODUCT, not just the target count. `GATE_EDIT_MAXCD` bounds `k`, but
#     the union materialises k*n and `n` is unbounded on the over-bytes path:
#     measured on bash 3.2 with k=19 -- UNDER the cap -- n=4000 cost 55 s
#     against the 10 s PreToolUse timeout, where the hook is killed and cannot
#     refuse anything. Asserts the verdict; the clock is the latency case above.
run_case 2 "Bash k=19 cd targets under the cap with 2000 write candidates" \
  "$(jq -nc --arg cmd "$(for i in $(seq 1 19); do printf 'cd %s/e%s ; ' "$TMPDIR" "$i"; done) true --body \"$(for i in $(seq 1 2000); do printf '> tok%s\n' "$i"; done)\" ; cd $MAIN ; echo hi > README.md" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
# 16. A FALSE BLOCK. `__cds` counted `cd` OCCURRENCES, so twenty-five copies of
#     one target -- no union cost at all -- tripped the overflow and refused,
#     with a message claiming 20 DISTINCT targets. The suite had no case for the
#     overflow refusing something it should not.
#     The repeated target must be the MAIN TREE and the write must be one the
#     gate would ALLOW. Pointing it at an unrelated directory does not
#     discriminate: the overflow refusal only fires when some base is a
#     protected tree, so the buggy and fixed versions both answered 0.
#     AND it must cross `GATE_EDIT_MAXBYTES`, or it takes the ordinary walk and
#     never reaches `__union_cd_bases` at all -- the same way round 10's union
#     pin missed its path by 200 bytes. 25 cds is ~1.5 KB, so the command is
#     padded past 4096 B with a comment.
run_case 0 "Bash the same cd target 25 times, then an allowed write" \
  "$(jq -nc --arg cmd "$(for i in $(seq 1 25); do printf 'cd %s ; ' "$MAIN"; done) : '$(for i in $(seq 1 400); do printf 'pad%s ' "$i"; done)' ; echo hi > untracked-scratch.txt" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
# 17. THE CLOCK for the k*n product. Case 15 asserts the VERDICT, and the
#     verdict is 2 with or without the product bound -- only the TIME differs,
#     so 15 alone fences nothing. Measured on bash 3.2 without the bound: k=19,
#     n=4000 cost 55 s against the 10 s PreToolUse timeout.
__kn_cmd="$(for i in $(seq 1 19); do printf 'cd %s/e%s ; ' "$TMPDIR" "$i"; done) true --body \"$(for i in $(seq 1 2000); do printf '> tok%s\n' "$i"; done)\" ; cd $MAIN ; echo hi > README.md"
__kn_json=$(jq -nc --arg cmd "$__kn_cmd" --arg cwd "$WT" \
  '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')
__kn_t0=$(date +%s)
printf '%s' "$__kn_json" | "$HOOK_RUNNER" "$HOOK" >/dev/null 2>&1
__kn_t1=$(date +%s)
__kn_secs=$((__kn_t1 - __kn_t0))
if [ "$__kn_secs" -le 4 ]; then
  pass=$((pass + 1))
  printf 'ok   latency: 19 cd targets x 2000 candidates in %ss (budget 4s, timeout 10s)\n' "$__kn_secs"
else
  fail=$((fail + 1))
  printf 'FAIL latency: 19 cd targets x 2000 candidates took %ss, budget 4s\n' "$__kn_secs"
fi

# 18-21. ROUND 15. Two blockers, both introduced by the round-14 commit, and
#        both invisible to an exit-code-only assertion.
#
# 18. THE OVERFLOW REFUSAL NEVER PRINTED. `__cds` is `local` to
#     `__union_cd_bases`; the heredoc reading it runs at top level, so under
#     `set -u` every overflow aborted -- and bash's abort status is 2, the same
#     code the refusal uses, so case 15 was green on a crash. Asserted by TEXT.
run_case_text 2 "too many distinct" "Bash overflow refuses WITH its message" \
  "$(jq -nc --arg cmd "$(for i in $(seq 1 25); do printf 'cd %s/d%s ; ' "$MAIN" "$i"; done) cd $MAIN ; : '$(for i in $(seq 1 400); do printf 'pad%s ' "$i"; done)' ; echo hi > README.md" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
# 19-21. A BACKSLASH IN THE TARGET, where bash's quote removal makes the write
#     land on a DIFFERENT, tracked file. `echo hi > READ\ME.md` really writes
#     `README.md` (measured). The gate looked for a file named `READ\ME.md`,
#     did not find one, and allowed it; `origin/main` refused. Round 14 fixed
#     only the token BOUNDARY, and its case used a fixture literally named
#     `back\slash.md` -- the one arrangement where `git ls-files` happens to
#     echo the raw token back, so it passed while this stayed open. The fixture
#     here is a plain `README.md`, which is what makes these discriminate.
run_case_text 2 "tracked" "Bash a backslash before a letter in the target" \
  "$(jq -nc --arg cmd 'echo hi > READ\ME.md' --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case_text 2 "tracked" "Bash a leading backslash in the target" \
  "$(jq -nc --arg cmd 'echo hi > \README.md' --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 0 "Bash a backslash target that is NOT tracked (control)" \
  "$(jq -nc --arg cmd 'echo hi > SCRAT\CH.txt' --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 22-25. THE OVER-SIZE SCAN. A security review confirmed `git ls-files` dies
#        with E2BIG past ~20000 pathspecs, and `2>/dev/null` turned that into
#        "not tracked" for a whole directory -- so the batched call is chunked
#        now. Chasing that surfaced the bigger one: the over-bytes scan consumes
#        its input with `${__rest#*...}`, which is QUADRATIC, and 329 KB with
#        6000 distinct `>` targets cost 28.3 s on bash 3.2 against the 10 s
#        PreToolUse timeout, where the hook is killed and every gate on the call
#        is disarmed. The scan now refuses past `GATE_EDIT_MAXSCAN` instead.
#
#        Three defects were found INSIDE that fix, and all three are pinned
#        here because none was visible from the verdict alone:
#          - skipping the scan leaves `candidates` empty, and the early
#            `exit 0` for "no candidates" then ALLOWED the command -- a 0.05 s
#            fail-open replacing a 28 s one;
#          - `${arr[@]}` on an empty array aborts under `set -u` on bash 3.2
#            (rc=1, neither allow nor block) in unrelated repositories;
#          - the refusal headline still said "too many distinct cd targets".
__big_body=$(for i in $(seq 1 6000); do printf '> padpadpadpadpadpadpadpadpadpadpadpadpadpad%s\n' "$i"; done)
run_case_text 2 "too large to analyse" "Bash a 300 KB command in the main tree refuses" \
  "$(jq -nc --arg cmd "true --body \"$__big_body\" ; echo hi > out.txt" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 0 "Bash the same 300 KB command from a feature worktree" \
  "$(jq -nc --arg cmd "true --body \"$__big_body\" ; echo hi > out.txt" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 0 "Bash the same 300 KB command in a repo with no .markgate.yml" \
  "$(jq -nc --arg cmd "true --body \"$__big_body\" ; echo hi > out.txt" --arg cwd "$TMPDIR" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 25. The clock: the refusal has to be produced FAST, or it is produced after
#     the hook has already been killed. This is the assertion the verdict cases
#     above cannot make.
__os_json=$(jq -nc --arg cmd "true --body \"$__big_body\" ; echo hi > out.txt" --arg cwd "$MAIN" \
  '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')
__os_t0=$(date +%s)
printf '%s' "$__os_json" | "$HOOK_RUNNER" "$HOOK" >/dev/null 2>&1
__os_t1=$(date +%s)
__os_secs=$((__os_t1 - __os_t0))
if [ "$__os_secs" -le 4 ]; then
  pass=$((pass + 1))
  printf 'ok   latency: a 300 KB command refused in %ss (budget 4s, timeout 10s)\n' "$__os_secs"
else
  fail=$((fail + 1))
  printf 'FAIL latency: a 300 KB command took %ss to refuse, budget 4s\n' "$__os_secs"
fi

CASE_FLOOR=129
# `ran` is captured BEFORE the increment. Incrementing `fail` first and then
# printing `$((pass + fail))` re-counted the floor's own failure as a case, so
# one deleted case reported `only 129 cases ran, expected at least 129` -- a
# message that reads like a bug in the check rather than the shrink it caught.
__ran=$((pass + fail))
if [ "$__ran" -lt "$CASE_FLOOR" ]; then
  fail=$((fail + 1))
  printf 'not ok case floor: only %s cases ran, expected at least %s\n' "$__ran" "$CASE_FLOOR"
fi
echo "----"
echo "passed=$pass failed=$fail"
[[ "$fail" -eq 0 ]]
