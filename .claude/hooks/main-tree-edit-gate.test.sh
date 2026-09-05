#!/usr/bin/env bash
# Smoke test for main-tree-edit-gate.sh.
#
# Builds a fixture repo on `main` plus a linked feature-branch
# worktree, then feeds the hook synthetic PreToolUse payloads and
# asserts the exit code. Run from the repo root:
#   bash .claude/hooks/main-tree-edit-gate.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/main-tree-edit-gate.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

MAIN="$TMPDIR/main"
git init -q -b main "$MAIN"
mkdir -p "$MAIN/docs/_generated" "$MAIN/src"
echo "row" > "$MAIN/docs/_generated/ledger.tsv"
echo "x" > "$MAIN/src/existing.ts"
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

pass=0; fail=0
# run_case <expected_exit> <desc> <json>
run_case() {
  local expected="$1" desc="$2" json="$3" rc
  printf '%s' "$json" | bash "$HOOK" >/dev/null 2>&1
  rc=$?
  if [[ "$rc" == "$expected" ]]; then
    pass=$((pass+1)); printf 'ok   (exit %s) %s\n' "$rc" "$desc"
  else
    fail=$((fail+1)); printf 'FAIL (exit %s, want %s) %s\n' "$rc" "$expected" "$desc"
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
# matcher is `Edit|Write|Bash`: an unloadable library takes away every tool an
# agent would repair it with, which is by design and therefore has to SAY so.
# Measured the hard way -- an apostrophe inside a comment in the library's awk
# program closed the shell string, and the session that wrote it was locked out
# of its own repo. Asserted: the refusal fires (exit 2, never 0), and it names
# the operator route out. A refusal with no way out reads as a broken harness.
BROKEN="$TMPDIR/broken"
cp -R .claude/hooks "$BROKEN"
echo 'this is not shell(' > "$BROKEN/lib/command-match.sh"
fc_out=$(printf '%s' \
  "$(jq -nc --arg cwd "$MAIN" '{tool_name:"Bash", cwd:$cwd, tool_input:{command:"echo hi > docs/_generated/ledger.tsv"}}')" \
  | bash "$BROKEN/main-tree-edit-gate.sh" 2>&1)
fc_rc=$?
if [[ "$fc_rc" == 2 ]]; then
  pass=$((pass + 1)); echo "ok   (exit 2) an unloadable library fails CLOSED"
else
  fail=$((fail + 1)); echo "not ok (exit $fc_rc, want 2) an unloadable library must fail CLOSED"
fi
if [[ "$fc_out" == *"prefix the command with"* && "$fc_out" == *"bash -n"* ]]; then
  pass=$((pass + 1)); echo "ok   the fail-closed refusal names the operator route out"
else
  fail=$((fail + 1)); echo "not ok the fail-closed refusal must name a route out; got: $fc_out"
fi
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
  | bash "$STUBLIB/main-tree-edit-gate.sh" >/dev/null 2>&1
sl_rc=$?
if [[ "$sl_rc" == 2 ]]; then
  pass=$((pass + 1)); echo "ok   (exit 2) a library missing gate_segments_marked fails CLOSED"
else
  fail=$((fail + 1)); echo "not ok (exit $sl_rc, want 2) a loadable library without gate_segments_marked must fail CLOSED"
fi

# The same fixture with the library RESTORED is the control: it proves the two
# assertions above came from the broken library and not from the copy itself.
cp .claude/hooks/lib/command-match.sh "$BROKEN/lib/command-match.sh"
printf '%s' \
  "$(jq -nc --arg cwd "$MAIN" '{tool_name:"Bash", cwd:$cwd, tool_input:{command:"echo hi > /tmp/elsewhere.txt"}}')" \
  | bash "$BROKEN/main-tree-edit-gate.sh" >/dev/null 2>&1
fc_ctl=$?
if [[ "$fc_ctl" == 0 ]]; then
  pass=$((pass + 1)); echo "ok   (exit 0) the same copy with the library restored allows an outside write"
else
  fail=$((fail + 1)); echo "not ok (exit $fc_ctl, want 0) the copied hook must work when its library loads"
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

CASE_FLOOR=76
if [ "$((pass + fail))" -lt "$CASE_FLOOR" ]; then
  fail=$((fail + 1))
  printf 'not ok case floor: only %s cases ran, expected at least %s\n' "$((pass + fail))" "$CASE_FLOOR"
fi
echo "----"
echo "passed=$pass failed=$fail"
[[ "$fail" -eq 0 ]]
