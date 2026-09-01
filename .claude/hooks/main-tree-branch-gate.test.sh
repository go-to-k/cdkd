#!/usr/bin/env bash
# Smoke test for main-tree-branch-gate.sh.
#
# Exercises the cwd-aware main-tree resolution against fixture
# main + worktree pairs, asserting both BLOCK (exit 2) and ALLOW
# (exit 0) outcomes. Run from the repo root:
#   bash .claude/hooks/main-tree-branch-gate.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/main-tree-branch-gate.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# bash 3.2 is NOT exercised on the HOOK by running THIS FILE under /bin/bash.
# The hook's shebang is `#!/usr/bin/env bash`, which resolves through PATH and
# finds whatever bash is first there -- Homebrew 5.x on a dev Mac. `HOOK_BASH`
# puts a `bash` shim first on PATH so the subject follows the harness.
if [ -n "${HOOK_BASH:-}" ]; then
  HOOK_BASH_BIN="$(command -v "$HOOK_BASH" 2>/dev/null || printf '%s' "$HOOK_BASH")"
  case "$HOOK_BASH_BIN" in /*) ;; *) HOOK_BASH_BIN="$PWD/$HOOK_BASH_BIN" ;; esac
  HOOK_BASH_SHIM="$TMPDIR/bash32-shim"
  mkdir -p "$HOOK_BASH_SHIM"
  ln -sf "$HOOK_BASH_BIN" "$HOOK_BASH_SHIM/bash"
  PATH="$HOOK_BASH_SHIM:$PATH"
  export PATH
fi

# Set up a main repo + one linked worktree under
# `.claude/worktrees/feat-x/`.
main_repo="$TMPDIR/main-repo"
git init -q -b main "$main_repo"
git -C "$main_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
# Opt the fixture into the gate (issue #1259).
touch "$main_repo/.markgate.yml"
# Pre-create the feature branch (refs needed for show-ref).
git -C "$main_repo" branch feat-x
git -C "$main_repo" branch some-feature
# A worktree at `.claude/worktrees/feat-x/` checked out to `feat-x`.
mkdir -p "$main_repo/.claude/worktrees"
worktree_dir="$main_repo/.claude/worktrees/feat-x"
git -C "$main_repo" worktree add -q "$worktree_dir" feat-x

pass=0
fail=0
fail_log=""

run_case() {
  local name="$1"; local want="$2"; local payload="$3"
  local out got
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) || true
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got\n"
    fail_log+="  payload: $payload\n"
    fail_log+="  output : $out\n"
  fi
}

# The exit code alone cannot say WHICH branch a block is about, and the message
# is the whole product of a block -- it names the branch to replay in a
# worktree. `run_case` compares exit codes only, so a gate that blocks for the
# right reason and NAMES THE WRONG THING is green there.
#
# run_case_msg <name> <want-exit> <payload> <must-contain> [<must-not-contain>]
run_case_msg() {
  local name="$1" want="$2" payload="$3" have="$4" nothave="${5:-}"
  local out got why=""
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1)
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?
  [[ "$got" == "$want" ]] || why="want exit $want, got $got"
  printf '%s' "$out" | grep -qF -- "$have" || why="${why:+$why; }message lacks [$have]"
  if [[ -n "$nothave" ]] && printf '%s' "$out" | grep -qF -- "$nothave"; then
    why="${why:+$why; }message wrongly contains [$nothave]"
  fi
  if [[ -z "$why" ]]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s, names [%s])\n' "$name" "$got" "$have"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: $why\n"
    fail_log+="  payload: $payload\n"
    fail_log+="  output : $out\n"
  fi
}

# --- ALLOW cases ---

# 1. git switch main in main tree → allow (going back to main).
run_case "git switch main in main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git switch main"}}' "$main_repo")"

# 2. git checkout main in main tree → allow.
run_case "git checkout main in main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git checkout main"}}' "$main_repo")"

# 3. git switch master in main tree → allow.
run_case "git switch master in main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git switch master"}}' "$main_repo")"

# 4. git switch -c feat in a worktree (not main tree) → allow.
run_case "git switch -c feat in worktree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git switch -c feat-new"}}' "$worktree_dir")"

# 5. git switch feat in a worktree → allow.
run_case "git switch <feat> in worktree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git switch some-feature"}}' "$worktree_dir")"

# 6. git checkout -- <pathspec> in main tree → allow (file restore).
run_case "git checkout -- <pathspec> in main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git checkout -- README.md"}}' "$main_repo")"

# 7. git checkout <sha> in main tree → allow (detached HEAD).
HEAD_SHA=$(git -C "$main_repo" rev-parse HEAD)
run_case "git checkout <sha> in main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git checkout %s"}}' "$main_repo" "$HEAD_SHA")"

# 8. git worktree add in main tree → allow (sanctioned escape).
run_case "git worktree add in main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git worktree add .claude/worktrees/x -b feat-y"}}' "$main_repo")"

# 9. git status in main tree → allow (not a switch/checkout).
run_case "git status in main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git status"}}' "$main_repo")"

# 10. Empty payload → allow (nothing to gate).
run_case "empty payload allowed" 0 ''

# --- BLOCK cases ---

# 11. git switch -c <feat> in main tree → block.
run_case "git switch -c <feat> in main tree blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git switch -c feat-new"}}' "$main_repo")"

# 12. git switch <feat> (existing branch) in main tree → block.
run_case "git switch <feat> in main tree blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git switch some-feature"}}' "$main_repo")"

# 13. git checkout -b <feat> in main tree → block.
run_case "git checkout -b <feat> in main tree blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git checkout -b feat-new"}}' "$main_repo")"

# 14. git checkout <feat> (existing local branch) in main tree → block.
run_case "git checkout <feat> (existing branch) in main tree blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git checkout some-feature"}}' "$main_repo")"

# 15. cd <main> && git switch feat from worktree cwd → block (cd target wins).
run_case "cd <main> && git switch <feat> from worktree blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd %s && git switch some-feature"}}' "$worktree_dir" "$main_repo")"

# 16. git -C <main> switch feat → block.
run_case "git -C <main> switch <feat> blocked" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s switch some-feature"}}' "$worktree_dir" "$main_repo")"

# 17. git switch - (previous branch, conservative) in main tree → block.
run_case "git switch - in main tree blocked conservatively" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git switch -"}}' "$main_repo")"

# --- REPO OPT-IN SCOPE case (issue #1259) ---

# 17b. git switch -c <feat> in the MAIN tree of a repo WITHOUT
#      .markgate.yml → allow (non-opted-in repo, e.g. a personal
#      blog worked on from a cdkd session).
optout_repo="$TMPDIR/optout-repo"
git init -q -b main "$optout_repo"
git -C "$optout_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
run_case "git switch -c <feat> in non-opted-in repo main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git switch -c feat-new"}}' "$optout_repo")"

# --- Edge cases ---

# 18. Not a git repo → fall through (can't see, can't gate).
run_case "non-repo target dir passes through" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git switch foo"}}' "$TMPDIR")"

# --- LINE-START ANCHORING cases (issue #563) ---
#
# The matcher MUST NOT fire when the literal substrings `git switch`
# / `git checkout` appear inside a quoted argument body of an
# unrelated command. Per memory rule
# feedback_hook_command_match_line_start.md, applied to
# main-tree-branch-gate.sh in issue #563 (mirroring the PR #562
# fix to check-gate.sh).

# 19. `gh issue create --body "...git switch..."` in main tree: the
#     body mentions `git switch` but the command itself starts with
#     `gh`. MUST pass through (would otherwise block routine issue
#     creation from the main tree).
run_case "gh issue body quoting 'git switch' in main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh issue create --body \"remember to git switch back to main after\""}}' "$main_repo")"

# 20. `echo "...git checkout..."` in main tree: the body mentions
#     `git checkout` but the command starts with `echo`. MUST pass
#     through.
run_case "echo body quoting 'git checkout' in main tree allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"echo \"tip: git checkout -b some-feature in a worktree\""}}' "$main_repo")"

# --- CHAINED command position (2026-08-31). The walker this replaced skipped to
# the FIRST `git` token in the whole command, so a chained `git <verb> && git
# switch -c <b>` read the FIRST verb, fell to the "unrecognised subcommand, fail
# open" arm and exited 0 -- a live bypass, reproduced on the real main checkout:
# the bare form rc=2, the chained twin rc=0. The suite had a `cd <main> && git
# switch` case and no `git <verb> && git switch` one, which is why it survived.
run_case "git fetch && git switch -c <feat> in main tree blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git fetch origin && git switch -c wt-probe origin/main" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git status; git checkout -b <feat> in main tree blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git status --short; git checkout -b wt-probe" '{cwd:$d,tool_input:{command:$c}}')"

# ...and every allowance still holds when chained, which is what keeps the two
# cases above from being satisfied by a hook that blocks any chained git.
run_case "git fetch && git switch main in main tree allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git fetch origin && git switch main" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git status && git checkout -- <path> in main tree allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git status --short && git checkout -- README.md" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git fetch && git switch -c <feat> in a WORKTREE allowed" 0 \
  "$(jq -cn --arg d "$worktree_dir" --arg c "git fetch origin && git switch -c wt-probe origin/main" '{cwd:$d,tool_input:{command:$c}}')"

# The blocking verdict must come from the RIGHT segment: an allowed switch in
# segment 1 must not excuse a blocking one in segment 2. A gate that reads only
# the first matching segment passes this and fences nothing -- the shape
# `gate_verb_rest_each` exists for.
run_case "an allowed switch first does not excuse a blocking one after it" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git switch main && git switch -c wt-probe" '{cwd:$d,tool_input:{command:$c}}')"

# The mandated quoted-body pair in its CHAINED spelling, since the matcher
# change is exactly where those regress.
run_case "chained quoted mention of git switch -c in main tree allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git status && echo \"do not run: git switch -c wt-probe\"" '{cwd:$d,tool_input:{command:$c}}')"

# --- PER-SEGMENT TREE RESOLUTION (2026-09-01). The tree used to be resolved
# ONCE for the whole command, outside the per-segment walk, so segment 1's tree
# decided every segment. That is a gate BYPASS in one direction and a FALSE
# BLOCK in the other, and both were live. Measured against the real main
# checkout and its real linked worktree, payload cwd = the main tree:
#
#   git -C <wt> switch -c a && git switch -c b       rc=0, want 2
#   git -C <wt> checkout -b a && git checkout -b b   rc=0, want 2
#   git switch main && git -C <wt> switch -c a       rc=2, want 0
#
# The first two are the `git fetch && git switch -c` bypass above, one operator
# further along; the third refuses a branch creation IN a linked worktree, which
# is the shape the whole worktree convention mandates.
run_case "worktree segment first does not excuse a main-tree switch after it" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git -C $worktree_dir switch -c a && git switch -c wt-probe" '{cwd:$d,tool_input:{command:$c}}')"
run_case "worktree segment first does not excuse a main-tree checkout after it" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git -C $worktree_dir checkout -b a && git checkout -b wt-probe" '{cwd:$d,tool_input:{command:$c}}')"
run_case "a main-tree segment first does not condemn a worktree one after it" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git switch main && git -C $worktree_dir switch -c a" '{cwd:$d,tool_input:{command:$c}}')"
# A `cd` PERSISTS into later segments while a `-C` binds only its own command --
# the two halves of the per-segment resolution, each with its false direction.
run_case "cd into a worktree carries into the next segment (allowed)" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "cd $worktree_dir && git switch -c a && git switch -c b" '{cwd:$d,tool_input:{command:$c}}')"
run_case "a -C back at the main tree after a cd to a worktree still blocks" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "cd $worktree_dir && git switch -c a && git -C $main_repo switch -c wt-probe" '{cwd:$d,tool_input:{command:$c}}')"
# An UNREADABLE tree in the LATER segment must still refuse: the per-segment
# walk carries gate_target_dir_strict's contract per line, and dropping it there
# would restore #2027 one operator along.
run_case "an unreadable -C in a later segment is refused, not passed" 2 \
  "$(jq -cn --arg d "$worktree_dir" --arg c "git switch -c a && git -C \"\$W\" switch -c b" '{cwd:$d,tool_input:{command:$c}}')"

# --- The block MESSAGE names the branch, not the flag. The verdict was already
# right for `git switch --create feat/x`; the text called the branch `--create`,
# which is what the reader is told to replay in a worktree.
run_case_msg "long-form --create names the branch, not the flag" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git switch --create feat-new" '{cwd:$d,tool_input:{command:$c}}')" \
  "feat-new" "'--create'"
run_case_msg "--detach is reported as a detach, not as a branch named --detach" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git switch --detach origin/main" '{cwd:$d,tool_input:{command:$c}}')" \
  "detaches HEAD" "feature branch '--detach'"


# A FLOOR on the case total. Every `for` loop above expands a LIST, and emptying
# one -- or deleting a case -- removes assertions SILENTLY while the tally still
# reads `fail: 0`. No suite in this repo had one, so the only thing standing
# between a gutted loop and a green run was somebody noticing the number move.
# Raise it when cases are added; never lower it to make a red run green.
CASE_FLOOR=36
if [ "$((pass + fail))" -lt "$CASE_FLOOR" ]; then
  fail=$((fail + 1))
  fail_log+="FAIL case floor: only $((pass + fail)) cases ran, expected at least 36\n"
  printf 'FAIL case floor: only %s cases ran, expected at least %s\n' "$((pass + fail))" "$CASE_FLOOR"
fi
echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
