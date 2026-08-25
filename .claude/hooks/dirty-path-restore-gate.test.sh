#!/usr/bin/env bash
# Smoke tests for dirty-path-restore-gate.sh
#
# Builds a REAL throwaway git repo per case (no mocking of git): the gate's
# whole decision is "does `git status --porcelain -- <path>` report anything",
# so a stubbed git would test the stub rather than the rule.
#
# Asserts:
#   - BLOCKS `git checkout -- <path>` when the path is dirty
#   - BLOCKS `git restore <path>` when the path is dirty
#   - PASSES when the path is CLEAN (the no-op case must stay quiet)
#   - PASSES for a branch switch / branch create (no `--`, not a path restore)
#   - PASSES for `git restore --staged <path>` (index only)
#   - PASSES when only an UNNAMED sibling file is dirty
#   - BLOCKS when one of several named paths is dirty
#   - PASSES under the CDKD_ALLOW_DIRTY_RESTORE=1 escape hatch
#   - PASSES for a non-Bash tool and for unrelated commands
#   - Honors `git -C <path>` when the payload cwd is elsewhere

set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/dirty-path-restore-gate.sh"
PASS=0
FAIL=0

# Create a repo with `tracked.txt` committed, plus `other.txt`.
make_repo() {
  local dir
  dir=$(mktemp -d)
  git -C "$dir" init -q
  git -C "$dir" config user.email t@example.com
  git -C "$dir" config user.name t
  echo "original" > "$dir/tracked.txt"
  echo "original" > "$dir/other.txt"
  # A path with a SPACE, because `for raw in $paths` word-split it into two
  # non-paths and the gate passed on a dirty file -- a silent discard, which is
  # the failure direction this gate exists to prevent.
  echo "original" > "$dir/sp ace.txt"
  # An apostrophe in a filename is ordinary; it opened a quoted span that ran to
  # end-of-input in the hand-written tokenizer, swallowing every later path.
  # The apostrophe goes through a variable: writing it inline needs the
  # `'"'"'` dance, which is what broke this file once already.
  local apos="'"
  # A literal BACKSLASH in a filename: inside a single-quoted span the
  # shell takes it literally, so the tokenizer must not treat it as an
  # escape there.
  local bslash="\\"
  echo "original" > "$dir/a${bslash}b.txt"
  echo "original" > "$dir/O${apos}Brien.txt"
  git -C "$dir" add -A
  git -C "$dir" commit -qm init
  echo "$dir"
}

run() {
  local name="$1" cwd="$2" command="$3" expect_exit="$4" tool="${5:-Bash}"
  local input exit_code err
  input=$(jq -nc --arg t "$tool" --arg c "$command" --arg d "$cwd" \
    '{tool_name: $t, tool_input: {command: $c}, cwd: $d}')
  err=$(mktemp)
  echo "$input" | "$HOOK" 2>"$err" && exit_code=$? || exit_code=$?
  if [[ "$exit_code" -eq "$expect_exit" ]]; then
    echo "PASS: $name (exit $exit_code)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name — expected exit $expect_exit, got $exit_code"
    sed 's/^/       /' "$err"
    FAIL=$((FAIL + 1))
  fi
  rm -f "$err"
}

# --- dirty path: must BLOCK ------------------------------------------------
R=$(make_repo); echo "modified" > "$R/tracked.txt"
run "checkout -- <dirty path> blocks" "$R" "git checkout -- tracked.txt" 2

# CHAINED shapes. None of the cases below this file's original 18 was chained,
# which is why a live regression stayed green through a full review round:
# converting the gate from a raw-command match to a per-segment one made it
# read only the FIRST segment matching each verb, so a branch switch ahead of a
# discard ended the probe. Measured at the time, all three went BLOCK -> pass.
# A branch switch chained ahead of a discard is an everyday shape.
run "branch switch THEN discard blocks"        "$R" "git checkout main && git checkout -- tracked.txt" 2
run "checkout -b THEN restore blocks"          "$R" "git checkout -b wip && git restore -- tracked.txt" 2
run "semicolon-chained discard blocks"         "$R" "git checkout main; git restore -- tracked.txt" 2
run "discard THEN branch switch blocks"        "$R" "git restore tracked.txt && git checkout main" 2

# Polarity controls for those four. Without them "it blocks" is satisfied by a
# gate that blocks everything, which is the shape this session hit four times.
run "branch switch alone passes"               "$R" "git checkout main" 0
run "checkout -b alone passes"                 "$R" "git checkout -b wip" 0

# `--staged` is per-SEGMENT, not per-command. The old form exited 0 for the
# whole command on seeing `--staged`, so a staged restore chained ahead of a
# worktree restore passed the worktree one through untested.
run "staged THEN worktree restore blocks"      "$R" "git restore --staged tracked.txt && git restore tracked.txt" 2

# `--staged` alone rewrites the index; WITH `--worktree` the same command also
# discards worktree content, so the skip has to be conditional. Both spellings
# passed on a dirty file until this was fenced.
run "staged AND worktree restore blocks"       "$R" "git restore --staged --worktree tracked.txt" 2
run "short -S -W restore blocks"               "$R" "git restore -S -W tracked.txt" 2
run "combined -SW restore blocks"              "$R" "git restore -SW tracked.txt" 2
run "worktree-only restore blocks"             "$R" "git restore -W tracked.txt" 2

# The `-W` cluster spellings an ENUMERATION misses. `git restore -S -qW f` is
# legal, matched none of `" -W "|" -SW "|" -WS "`, hit the `-S` arm, and was
# skipped -- reverting the file while the gate reported rc=0. Short flags
# cluster in any order with any other flag, so the set is not enumerable.
run "clustered -qW after -S blocks"            "$R" "git restore -S -qW tracked.txt" 2
run "clustered -Wq after -S blocks"            "$R" "git restore -S -Wq tracked.txt" 2
run "long --worktree after --staged blocks"    "$R" "git restore --staged --worktree tracked.txt" 2
# Control: a cluster with NO W must still be skipped, or the predicate has
# simply stopped skipping anything.
run "clustered -qS with no W passes"           "$R" "git restore -qS tracked.txt" 0

# BACKSLASH escapes. Without them an escaped quote opens a span that runs to
# end-of-input, so every later path merges into one token git does not know and
# the gate passes on a dirty file.
RBS=$(make_repo); echo "modified" > "$RBS/tracked.txt"
run "escaped apostrophe then a dirty path blocks" "$RBS" "git checkout -- O\\'Brien.txt tracked.txt" 2
run "escaped quote then a dirty path blocks"      "$RBS" "git checkout -- say\\\"hi.txt tracked.txt" 2
RBS2=$(make_repo); echo "modified" > "$RBS2/sp ace.txt"
run "backslash-escaped space is one path"         "$RBS2" "git restore sp\\ ace.txt" 2

# Git accepts any UNAMBIGUOUS PREFIX of a long option, so an exact-match arm is
# an enumeration one level up from the short-flag one. `--staged --worktr`
# reverted the file with the gate returning 0. The asymmetry is what hides it:
# abbreviating BOTH halves fails safe, because neither flag is recognised and
# nothing is skipped.
RPX=$(make_repo); echo "modified" > "$RPX/tracked.txt"
run "abbreviated --worktr after --staged blocks"  "$RPX" "git restore --staged --worktr tracked.txt" 2
run "abbreviated --work after --staged blocks"    "$RPX" "git restore --staged --work tracked.txt" 2
run "abbreviated --worktr after -S blocks"        "$RPX" "git restore -S --worktr tracked.txt" 2
# Controls: an abbreviated STAGED-only restore is index-only and must still be
# skipped, and `--source` must not be read as an abbreviation of `--staged`.
run "abbreviated --stag alone passes"             "$RPX" "git restore --stag tracked.txt" 0
run "--source is not --staged"                    "$RPX" "git restore --source=HEAD tracked.txt" 2

# A backslash inside a SINGLE-quoted span is literal, not an escape.
RQ=$(make_repo); echo "modified" > "$RQ/a\\b.txt"
run "backslash inside single quotes is literal"   "$RQ" "git restore 'a\\b.txt'" 2
run "backslash inside double quotes escapes"      "$RQ" 'git restore "a\\b.txt"' 2

# A QUOTED path whose text contains a flag-shaped fragment. `for w in $seg`
# word-split it, so `-Sx.txt` was read as a staged flag, the segment was
# skipped, and a dirty tracked.txt passed -- the word-splitting defect
# `split_paths` exists to fix, reintroduced in the flag scan above it.
RWS=$(make_repo); echo "modified" > "$RWS/tracked.txt"
run "flag-shaped fragment in a quoted path blocks" "$RWS" 'git restore "a -Sx.txt" tracked.txt' 2
run "W-shaped fragment in a quoted path blocks"    "$RWS" 'git restore "a -Wx.txt" tracked.txt' 2
# Control: the same shape with no flag-like fragment must block for the ORDINARY
# reason, so the two above cannot be satisfied by a gate that blocks on sight of
# a quote.
run "plain quoted path still blocks"               "$RWS" 'git restore "a x.txt" tracked.txt' 2

# `--source` and `--staged` share the `--s` prefix. Matching only the literal
# `--source` let `--sou` fall through to the staged arm and skip a segment that
# stages nothing.
run "abbreviated --sou is not --staged"            "$RWS" "git restore --sou HEAD~1 tracked.txt" 2
run "abbreviated --sourc is not --staged"          "$RWS" "git restore --sourc HEAD~1 tracked.txt" 2
# Control: an abbreviated STAGED restore is index-only and must still pass.
run "abbreviated --stage alone passes"             "$RWS" "git restore --stage tracked.txt" 0

# QUOTED paths containing a space. `for raw in $paths` split these into `"sp`
# and `ace.txt"`, neither of which git knows, so the gate passed.
RSP=$(make_repo); echo "modified" > "$RSP/sp ace.txt"
run "quoted path with a space, checkout blocks"  "$RSP" "git checkout -- \"sp ace.txt\"" 2
run "quoted path with a space, restore blocks"   "$RSP" "git restore \"sp ace.txt\"" 2
run "single-quoted path with a space blocks"     "$RSP" "git restore 'sp ace.txt'" 2
# Control: the same repo with that file CLEAN must pass, or the three above are
# satisfied by a gate that blocks whenever it sees a quote.
RSPC=$(make_repo)
run "quoted path with a space, clean, passes"    "$RSPC" "git checkout -- \"sp ace.txt\"" 0
run "restore <dirty path> blocks" "$R" "git restore tracked.txt" 2
run "restore -- <dirty path> blocks" "$R" "git restore -- tracked.txt" 2
run "escape hatch is honored" "$R" "CDKD_ALLOW_DIRTY_RESTORE=1 git checkout -- tracked.txt" 2
CDKD_ALLOW_DIRTY_RESTORE=1 run "escape hatch via env passes" "$R" "git checkout -- tracked.txt" 0
run "restore --staged is index-only, passes" "$R" "git restore --staged tracked.txt" 0
run "non-Bash tool passes" "$R" "git checkout -- tracked.txt" 0 "Edit"
run "unnamed dirty sibling does not block a clean target" "$R" "git checkout -- other.txt" 0
run "one dirty among several named paths blocks" "$R" "git checkout -- other.txt tracked.txt" 2
run "git -C <dirty repo> blocks from elsewhere" "$PWD" "git -C $R checkout -- tracked.txt" 2
rm -rf "$R"

# --- clean path: must PASS -------------------------------------------------
R=$(make_repo)
run "checkout -- <clean path> passes" "$R" "git checkout -- tracked.txt" 0
run "branch switch passes" "$R" "git checkout main" 0
run "branch create passes" "$R" "git checkout -b feature" 0
run "unrelated command passes" "$R" "git status" 0
run "git commit passes" "$R" "git commit -m x" 0
rm -rf "$R"

# --- not a git repo: must PASS (fail open) ---------------------------------
T=$(mktemp -d)
run "outside a work tree passes" "$T" "git checkout -- tracked.txt" 0
rm -rf "$T"

# --- Command matching (issue #2129) -----------------------------------------
# The gate must see its verb wherever it sits in the command list, and must NOT
# fire on a quoted MENTION of it. Both directions, or the matcher is untested.
R=$(make_repo)
echo "dirty" > "$R/tracked.txt"
run "compound: git stash && git restore -- <dirty path> blocks" "$R" \
  "git stash && git restore -- tracked.txt" 2
run "quoted mention of git restore does not fire" "$R" \
  'echo "then git restore -- tracked.txt"' 0
rm -rf "$R"

echo
echo "dirty-path-restore-gate: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
