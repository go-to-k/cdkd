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
run_case 2 "Bash a backtick span, a \$( ) span, then 'cd <wt>' and a write (false refusal)" \
  "$(jq -nc --arg cmd "x=\`date\`; y=\$(pwd); cd $WT && echo hi > docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 2 "Bash the same two spans in the other order (false refusal)" \
  "$(jq -nc --arg cmd "y=\$(pwd); x=\`date\`; cd $WT && echo hi > docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 31. Same class as 29-30: the `cd` is not first, so it is not followed. Kept
# separate because a quoted `>` is what the TRUNCATION revision tripped over --
# it dropped the `cd` too, but silently BYPASSED instead of refusing whenever
# the payload cwd was a feature worktree. Pinning the refusing answer here is
# what makes that regression visible if the scan is ever widened again.
run_case 2 "Bash a quoted '>' before a real cd (false refusal)" \
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
run_case 0 "Bash a backtick + \$( ) span then 'cd <main>' and a write (INVERTED: a silent miss)" \
  "$(jq -nc --arg cmd "x=\`date\`; y=\$(pwd); cd $MAIN && echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 0 "Bash the same two spans in the other order (INVERTED: a silent miss)" \
  "$(jq -nc --arg cmd "y=\$(pwd); x=\`date\`; cd $MAIN && echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
run_case 0 "Bash a quoted '>' then 'cd <main>' and a write (INVERTED: a silent miss)" \
  "$(jq -nc --arg cmd "echo \"a > b\" && cd $MAIN && echo hi > docs/_generated/ledger.tsv" --arg cwd "$WT" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"

# 35-39. The VERB unquoting, against what bash actually does. A blanket
# backslash strip here manufactured a `cd` bash never runs and moved the base
# AWAY from the protected tree -- measured, the tracked file really was
# overwritten. Each spelling below is one bash does NOT treat as `cd`.
for __v in "'\\cd'" '"\\cd"' '"c\\d"' '\\\\cd' 'c\\\\d'; do
  run_case 2 "Bash a first token that only LOOKS like cd: $__v" \
    "$(jq -nc --arg cmd "$__v /tmp ; echo hi > docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
      '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
done
# ...and the ones bash DOES, so the unescape cannot be tightened into a refusal.
for __v in '\cd' "'cd'" '"cd"'; do
  run_case 0 "Bash a first token bash really reads as cd: $__v" \
    "$(jq -nc --arg cmd "$__v /tmp ; echo hi > docs/_generated/ledger.tsv" --arg cwd "$MAIN" \
      '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')"
done

echo "----"
echo "passed=$pass failed=$fail"
[[ "$fail" -eq 0 ]]
