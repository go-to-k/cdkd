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
# REMOTE-tracking refs with no local branch behind them: the shape a lane's
# branch has in a fresh checkout, and the one `git checkout <name>` DWIMs into a
# local branch + switch. The nested one is here because a `*` does not cross a
# `/` in for-each-ref, so a `refs/remotes/*/*` pattern silently misses it.
MAIN_SHA=$(git -C "$main_repo" rev-parse HEAD)
# The remotes must be CONFIGURED, not merely have refs under their prefix: git
# DWIMs `<name>` only for a remote it knows about. Measured on a fixture clone --
# with `refs/remotes/ghostremote/ghost` present and no `ghostremote` remote,
# `git checkout ghost` answers "pathspec 'ghost' did not match any file(s) known
# to git" and HEAD stays. A URL is enough; nothing is ever fetched here.
git -C "$main_repo" remote add origin https://example.invalid/origin.git
# A remote whose NAME contains a SLASH. `git remote add a/b <url>` is accepted
# (measured), and `deep-only` on it lands at `refs/remotes/a/b/deep-only`, which
# a fixed `lstrip=3` renders as `b/deep-only` while git DWIMs plain `deep-only`
# ("Switched to a new branch 'deep-only'", HEAD moved).
git -C "$main_repo" remote add a/b https://example.invalid/ab.git
git -C "$main_repo" update-ref refs/remotes/a/b/deep-only "$MAIN_SHA"
# A ref under a remote that is NOT configured -- what a removed remote or a hand
# `update-ref` leaves behind. Real git does not DWIM it (see above).
git -C "$main_repo" update-ref refs/remotes/ghostremote/ghost "$MAIN_SHA"
git -C "$main_repo" update-ref refs/remotes/origin/remote-only "$MAIN_SHA"
git -C "$main_repo" update-ref refs/remotes/origin/topic/nested-remote-only "$MAIN_SHA"
# The SYMBOLIC `refs/remotes/origin/HEAD` that every clone has. `lstrip=3`
# renders it as the bare word `HEAD`, so a DWIM list built from `refs/remotes/`
# contains it -- and `git checkout HEAD` creates nothing (measured: "Your branch
# is up to date", HEAD stayed put), so matching it would false-block a read-only
# command. Both cdkd and cdk-local carry this ref for real.
git -C "$main_repo" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/remote-only
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
# --- ARGUMENT SHAPES THE TWO-TOKEN READING GOT WRONG (2026-09-01) -------------
#
# `verdict_for` used to read token 1 and token 2 rather than WALKING the tokens.
# Both directions were wrong, and every "want" below was settled against real
# git first, printing HEAD before and after the command:
#
#   git checkout <branch> -- <paths>  BLOCKED, must not be. It restores FILES;
#     HEAD stayed `main` and f.txt took the other branch's content. The form
#     WITHOUT the `--` behaves identically ("Updated 1 path from ..."), which is
#     why the rule is "two or more positionals is a restore" rather than "a `--`
#     was seen". go-to-k/cdk-real-drift MANDATES this spelling for its
#     integration step, so the old reading refused a sibling's documented flow.
#   git checkout -f <branch>          ALLOWED, must not be. `-f` was read AS the
#     branch name, `refs/heads/-f` does not resolve, and the gate passed;
#     measured, the command printed "Switched to branch 'feat'".
#   git checkout --orphan <branch>    ALLOWED, must not be: `--orphan` was read
#     as the branch name. Measured, "Switched to a new branch 'wt-new'".
#   git checkout -                    ALLOWED while `git switch -` blocked.
#     Measured, "Switched to branch 'feat'" -- the same operation, two spellings.
#   git switch --help                 BLOCKED, must not be: it prints text and
#     touches no tree.
run_case "git checkout <branch> -- <path> is a file restore, allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout some-feature -- README.md" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout <branch> <path> without -- is also a restore, allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout some-feature README.md" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout -f <branch> blocked (a flag is not the branch name)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout -f some-feature" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout - blocked, like git switch -" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout -" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git switch --help allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git switch --help" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout --help allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout --help" '{cwd:$d,tool_input:{command:$c}}')"
# ...and the DISCRIMINATING form of each. The two cases above are vacuous under
# `checkout`: deleting the `--help` arm leaves them green, because a bare
# `git checkout --help` has no positional and passes on the "no target" arm
# instead. With a real LOCAL branch beside the flag, only the help arm can pass
# it. The short `-h` had no case at all.
run_case "git checkout --help <local branch> allowed (help arm, not the count)" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout --help some-feature" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout -h <local branch> allowed (the short help)" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout -h some-feature" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git switch -h <branch> allowed (the short help)" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git switch -h some-feature" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout -B <feat> in main tree blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout -B feat-new" '{cwd:$d,tool_input:{command:$c}}')"
# Under `switch` a leading flag blocks EITHER WAY -- the two-token reading takes
# `-f` for the branch name and blocks because it is not main/master -- so the
# exit code alone fences nothing here. The MESSAGE is what differs, and it is
# the name the refusal tells you to replay in a worktree.
run_case_msg "git switch -f <branch> names the branch, not the flag" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git switch -f some-feature" '{cwd:$d,tool_input:{command:$c}}')" \
  "some-feature" "feature branch '-f'"
# `--orphan` creates a branch under BOTH verbs. Assert the whole PHRASE, not
# just the name: with the create-flag arm dropped, the walk falls through to the
# positional arm, which names the branch correctly and merely calls the creation
# a switch -- so a name-only assertion is a control, not a fence.
run_case_msg "git switch --orphan names the branch, not the flag" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git switch --orphan feat-new" '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'feat-new'" "'--orphan'"
run_case_msg "git checkout --orphan names the branch, not the flag" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout --orphan feat-new" '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'feat-new'" "'--orphan'"
run_case_msg "long-form --force-create names the branch, not the flag" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git switch --force-create feat-new" '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'feat-new'" "'--force-create'"

# --- DWIM / --track: a branch that exists only on a REMOTE --------------------
#
# Both shapes CREATE a local branch and switch to it -- measured on a real
# clone: HEAD went `main` -> `feat`, git printing "Switched to a new branch".
# The local-only `show-ref` was blind to the way a lane's branch usually FIRST
# appears in a checkout, which is the commonest spelling of what this gate
# guards.
run_case "git checkout <remote-only branch> blocked (DWIM creates + switches)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout remote-only" '{cwd:$d,tool_input:{command:$c}}')"
run_case_msg "git checkout -t origin/<b> names the LOCAL branch it creates" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout -t origin/remote-only" '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'remote-only'" "origin/remote-only'"
# A SLASHED remote-only name. `for-each-ref 'refs/remotes/*/*'` does not list it
# -- a `*` does not cross a `/` there -- so that pattern is fail-open for every
# branch name with a slash, which is most of them in this flow. Measured on a
# real clone: the two-star form printed `HEAD feat main`, the prefix form
# printed `HEAD feat main topic/nested`, and git DWIMs the nested name just the
# same.
run_case "git checkout <nested remote-only branch> blocked too" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout topic/nested-remote-only" '{cwd:$d,tool_input:{command:$c}}')"
# CONTROL for the DWIM arm: a name that is neither a local branch nor on any
# remote is a pathspec / sha and must still pass. Without it, "block any bare
# token" scores green on the three cases above.
run_case "git checkout <name on no remote either> still allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout remote-onl" '{cwd:$d,tool_input:{command:$c}}')"
# The `refs/remotes/origin/HEAD` symref renders as the bare word `HEAD` under
# `lstrip=3`, so an unfiltered DWIM list contains it. `git checkout HEAD`
# creates nothing -- measured, "Your branch is up to date", HEAD stayed `main`
# -- so a gate that matched it would refuse a read-only command in the main
# tree. Its restore twin is the control on the other side.
run_case "git checkout HEAD is not a DWIM branch create, allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout HEAD" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout HEAD -- <path> allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout HEAD -- README.md" '{cwd:$d,tool_input:{command:$c}}')"

# --- FAIL-CLOSED on a library that predates GATE_EMBEDDING_TOKEN --------------
#
# The token walk interpolates that CONSTANT into its `[[ =~ ]]`. A library
# without it leaves the pattern EMPTY, the match then succeeds on any input with
# `${BASH_REMATCH[1]}` empty, and the walk yields nothing -- so every command
# would look like a bare `git checkout` and PASS. `declare -F` cannot see a
# missing constant, which is why the guard names it separately.
const_probe="$TMPDIR/const-probe"
mkdir -p "$const_probe/lib"
cp "$HOOK" "$const_probe/main-tree-branch-gate.sh"
grep -v '^GATE_EMBEDDING_TOKEN=' "$(dirname "$HOOK")/lib/command-match.sh" > "$const_probe/lib/command-match.sh"
probe_payload=$(jq -cn --arg d "$main_repo" --arg c "git switch -c feat-new" '{cwd:$d,tool_input:{command:$c}}')
out=$(printf '%s' "$probe_payload" | "$const_probe/main-tree-branch-gate.sh" 2>&1)
printf '%s' "$probe_payload" | "$const_probe/main-tree-branch-gate.sh" >/dev/null 2>&1
got=$?
if [ "$got" = 2 ] && printf '%s' "$out" | grep -qF 'command-match.sh is missing or unloadable'; then
  pass=$((pass + 1)); printf 'OK   library without GATE_EMBEDDING_TOKEN fails CLOSED (exit 2)\n'
else
  fail=$((fail + 1))
  fail_log+="FAIL library without GATE_EMBEDDING_TOKEN must fail closed: got exit $got, output [$out]\n"
fi

# --- GLUED FLAG SPELLINGS ------------------------------------------------------
#
# git's parse-options accepts a short flag's value GLUED to it, and bundles
# short flags: `-bfeat` is `-b feat` and `-qbfeat` is `-q -b feat`. Measured on
# real git -- each of these printed "Switched to a new branch" and the branch
# appeared in `for-each-ref refs/heads`. A walk that only knows the SPACED
# spelling sees `-bfeat` as one unknown flag, counts zero positionals, and reads
# the command as a bare `git checkout`: allowed.
#
# Under `switch` the exit code does NOT discriminate -- the old reading took
# `-cfeat` for the branch name and blocked because it is not main/master -- so
# those cases assert the whole PHRASE. `creates new feature branch 'feat'` is
# reachable only by a walk that split the flag from its value; a walk that
# dropped the create flag entirely falls through to the positional arm, which
# says `switches to feature branch` instead.
run_case "git checkout -bfeat (glued -b) blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout -bfeat" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout -Bfeat (glued -B) blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout -Bfeat" '{cwd:$d,tool_input:{command:$c}}')"
run_case_msg "git checkout --orphan=feat names the branch" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout --orphan=feat" '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'feat'" "'--orphan=feat'"
run_case_msg "git switch -cfeat (glued -c) names the branch, not the flag" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git switch -cfeat" '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'feat'" "'-cfeat'"
run_case_msg "git switch -Cfeat (glued -C) names the branch, not the flag" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git switch -Cfeat" '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'feat'" "'-Cfeat'"
run_case_msg "git switch --create=feat names the branch, not the flag" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git switch --create=feat" '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'feat'" "'--create=feat'"
run_case_msg "git switch --force-create=feat names the branch, not the flag" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git switch --force-create=feat" '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'feat'" "'--force-create=feat'"
# A short-flag BUNDLE, both spellings of where the value lives.
run_case_msg "git checkout -qbfeat (bundled, glued value) names the branch" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout -qbfeat" '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'feat'" "'-qbfeat'"
run_case_msg "git checkout -fb feat (bundled, spaced value) names the branch" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout -fb feat" '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'feat'" "'-fb'"

# --- A POSITIONAL COUNT IS NOT A PARSE ----------------------------------------
#
# `git checkout --conflict merge <branch>` SWITCHES -- measured, "Switched to
# branch 'feat'", HEAD moved and f.txt changed. Reading "two or more positionals
# is a restore" without consuming a value-taking flag's argument counted `merge`
# as a positional and let the switch through. The flag list comes from
# `git checkout -h` / `git switch -h`, not from memory.
run_case "git checkout --conflict merge <branch> blocked (value consumed)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout --conflict merge some-feature" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout --conflict=merge <branch> blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout --conflict=merge some-feature" '{cwd:$d,tool_input:{command:$c}}')"
# `--pathspec-from-file` is a RESTORE marker, not merely a value-taking flag, and
# this case used to pin the opposite. The pathspecs come FROM THE FILE, so the
# trailing token is the tree-ish to restore FROM. Measured with a real one-line
# pathspec file: `git checkout --pathspec-from-file <f> some-feature` printed
# "Updated 1 path from <sha>" and HEAD stayed on `main`; the `=` spelling does
# the same. Blocking it was a false block on a command that cannot move HEAD.
run_case "git checkout --pathspec-from-file <f> <branch> is a restore, allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout --pathspec-from-file /dev/null some-feature" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout --pathspec-from-file=<f> <branch> is a restore, allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout --pathspec-from-file=/dev/null some-feature" '{cwd:$d,tool_input:{command:$c}}')"
# `--recurse-submodules` has an OPTIONAL value, so its SPACED form must NOT
# consume the next token -- that token is the branch. Consuming it would leave
# zero positionals and pass the switch.
run_case "git checkout --recurse-submodules <branch> blocked (no value eaten)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout --recurse-submodules some-feature" '{cwd:$d,tool_input:{command:$c}}')"
# CONTROL for the consumption: the value-taking flag must not make an ALLOWED
# target block. Without this, "block whenever a flag was seen" scores green above.
run_case "git checkout --conflict merge main still allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout --conflict merge main" '{cwd:$d,tool_input:{command:$c}}')"

# --- THE PREVIOUS BRANCH, UNDER BOTH VERBS ------------------------------------
#
# `-` and `@{-1}` are the same operation. Measured -- both print "Switched to
# branch 'other'" and move HEAD. `git checkout @{-1}` was allowed outright, and
# `git switch @{-1}` blocked only by falling through its catch-all.
#
# The `@{-1}` cases also pin a property of the SHARED segmenter: `gate_segments`
# truncates a segment at a `}`, so the gate is handed `git checkout @{-1` with
# the brace gone. A pattern requiring the closing brace matches nothing here.
run_case "git checkout @{-1} blocked (previous branch)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout @{-1}" '{cwd:$d,tool_input:{command:$c}}')"
run_case_msg "git switch @{-1} is reported as the previous branch" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git switch @{-1}" '{cwd:$d,tool_input:{command:$c}}')" \
  "previous branch"

# --- RESTORE MODES MUST NOT BE BLOCKED ----------------------------------------
#
# `-p` / `--ours` / `--theirs` restore FILES. Measured -- `git checkout -p feat`
# printed a diff and left HEAD on `main`; `--ours` / `--theirs` printed
# "Updated 0 paths from the index". Blocking them is the same false block as the
# `<branch> -- <paths>` one, and the naive fix for the `-f` defect (treat any
# single positional after flags as a switch target) introduces it.
run_case "git checkout -p <branch> is a restore, allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout -p some-feature" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout --patch <branch> is a restore, allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout --patch some-feature" '{cwd:$d,tool_input:{command:$c}}')"
# The PATHSPEC here is a real LOCAL BRANCH NAME on purpose. With `README.md` the
# two cases were vacuous -- deleting `--ours|--theirs` from the restore list left
# them green, because `README.md` resolves to no branch and the command passed on
# the ordinary "not a branch" arm. `some-feature` IS a branch, so the ONLY thing
# that can make these pass is the restore marker itself.
run_case "git checkout --ours <path> allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout --ours some-feature" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout --theirs <path> allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout --theirs some-feature" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout -2 <path> allowed (the short --ours)" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout -2 some-feature" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout -3 <path> allowed (the short --theirs)" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout -3 some-feature" '{cwd:$d,tool_input:{command:$c}}')"

# --- --track IN ITS GLUED-VALUE SPELLING --------------------------------------
#
# `--track=direct <remote-ref>` still CREATES the local branch, so the value the
# flag carries must not hide the flag. The name is the start-point's LAST
# segment.
run_case_msg "git checkout --track=direct origin/<b> names the local branch" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout --track=direct origin/remote-only" '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'remote-only'" "origin/remote-only'"

# --- A QUOTED BRANCH NAME ------------------------------------------------------
#
# `.claude/rules/hooks-class-fences.md` recorded this as an accepted bound of the
# old reading: the branch name came out of a COLLAPSED quoted span, so
# `git switch "main"` compared `"main"` (quotes included) against `main` and
# FALSE-BLOCKED, while `git checkout "feat/x"` failed `show-ref refs/heads/"feat/x"`
# and PASSED. Measured against the pre-fix hook in the real main checkout:
# rc=2 and rc=0 respectively. The option parse keeps a quoted span as ONE token
# and unquotes it, so both directions are now right; these cases keep them so.
run_case "git switch \"main\" (quoted) allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git switch "main"' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git switch 'main' (single-quoted) allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git switch 'main'" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout \"<local branch>\" (quoted) blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout "some-feature"' '{cwd:$d,tool_input:{command:$c}}')"
run_case_msg "git switch -c \"<name with a space>\" names the whole name" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git switch -c "wt feat new"' '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'wt feat new'"

# --- THE CHECKOUT ERE MUST CARRY THE FLAG RUN ---------------------------------
#
# Every checkout case above puts the DECISIVE segment in a `git checkout ...`
# with no leading `git -C <path>`, so dropping `${GATE_FLAGS}` from
# `GATE_RE_GIT_CHECKOUT` was invisible: measured, that mutation left the whole
# suite green. The gate would then stand down for `git -C <main> checkout -b x`
# run from anywhere else -- a bypass in the shape a parallel lane actually
# types. This case makes a `-C`-carrying checkout the ONLY matching segment.
run_case "git -C <main> checkout -b <feat> from a worktree blocked" 2 \
  "$(jq -cn --arg d "$worktree_dir" --arg c "git -C $main_repo checkout -b feat-new" '{cwd:$d,tool_input:{command:$c}}')"
run_case "git -C <main> checkout <existing branch> from a worktree blocked" 2 \
  "$(jq -cn --arg d "$worktree_dir" --arg c "git -C $main_repo checkout some-feature" '{cwd:$d,tool_input:{command:$c}}')"
# ...and its false-block control: the same `-C` shape aimed at the WORKTREE must
# pass, so the two cases above cannot be satisfied by blocking every `-C`.
run_case "git -C <worktree> checkout -b <feat> from the main tree allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git -C $worktree_dir checkout -b feat-new" '{cwd:$d,tool_input:{command:$c}}')"

# --- SHELL WORDS ARE NOT ARGUMENTS --------------------------------------------
#
# `gate_tokens` splits SHELL WORDS, and a redirection, a trailing `&` and a `#`
# comment are all words the SHELL owns -- git never sees any of them. Feeding
# them to an option parse inflated the positional count and read a real switch as
# a file restore. Every command below moves HEAD for real (measured against git
# 2.53.0 with HEAD printed before and after: `main` -> `some-feature`, and
# `main` -> `other` for the `-` one), and the first three were scored rc=0 by the
# gate while its own `origin/main` predecessor scored them 2 -- a REGRESSION.
run_case "git checkout <branch> 2>/dev/null blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout some-feature 2>/dev/null' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout <branch> >/dev/null 2>&1 blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout some-feature >/dev/null 2>&1' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout <branch> # <comment> blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout some-feature # switch lane' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout -q <branch> 2>&1 blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout -q some-feature 2>&1' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout - 2>/dev/null blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout - 2>/dev/null' '{cwd:$d,tool_input:{command:$c}}')"
# The SPACED redirection target is a separate word and must be dropped WITH its
# operator; dropping only the `>` leaves `/dev/null` as a phantom pathspec.
run_case "git checkout <branch> > /dev/null (spaced target) blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout some-feature > /dev/null' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout <branch> 2>>log blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout some-feature 2>>log' '{cwd:$d,tool_input:{command:$c}}')"
# CONTROL, and it is what stops "drop every word after the first positional":
# a real restore beside a redirection must STILL pass.
run_case "git checkout <branch> -- <path> 2>/dev/null still allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout some-feature -- README.md 2>/dev/null' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout <branch> <path> # <comment> still allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout some-feature README.md # restore one file' '{cwd:$d,tool_input:{command:$c}}')"
# A QUOTED `#` is an argument, not a comment, so a branch name that starts with
# one must still be judged rather than swallowed.
run_case "git checkout '#not-a-comment' allowed (quoted # is an argument)" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout '#not-a-comment'" '{cwd:$d,tool_input:{command:$c}}')"

# --- A `--` WITH NOTHING AFTER IT IS NOT A PATHSPEC ---------------------------
#
# Measured: `git checkout some-feature --` prints "Switched to branch
# 'some-feature'" and HEAD moves, while `git checkout some-feature -- f.txt`
# updates the file and HEAD stays. So the rule is "a pathspec OPERAND exists",
# not "a `--` was seen" -- the reading that shipped one fix earlier.
run_case "git checkout <branch> -- (nothing after) blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout some-feature --' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout main -- (nothing after) allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout main --' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout -- (no positional at all) allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --' '{cwd:$d,tool_input:{command:$c}}')"
# `git switch` has NO pathspec form (`usage: git switch [<options>] [<branch>]`),
# so `--` there only ends the options. Measured: `git switch -- main` prints
# "Already on 'main'" and `git switch -- some-feature` switches. Applying
# checkout's grammar to both verbs made the first a FALSE BLOCK ("no resolvable
# target") in all three repos, including the `origin/main` predecessor.
run_case "git switch -- main allowed (switch has no pathspec form)" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git switch -- main' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git switch -- <feature> blocked (it really switches)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git switch -- some-feature' '{cwd:$d,tool_input:{command:$c}}')"

# --- GIT ACCEPTS UNAMBIGUOUS PREFIXES OF A LONG NAME --------------------------
#
# `git checkout -h` does not show it, but git's parse-options resolves any
# unambiguous prefix. Measured: `--orph newb` and `--or newb` both print
# "Switched to a new branch 'newb'"; `--trac origin/remote-only` creates local
# `remote-only`; `git switch --creat newb` creates `newb`. All four scored rc=0
# against the gate before the option table carried the whole grammar.
run_case_msg "git checkout --orph <b> blocked (prefix of --orphan)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --orph newb' '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'newb'"
run_case_msg "git checkout --or <b> blocked (shortest unambiguous prefix)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --or newb' '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'newb'"
run_case_msg "git checkout --trac <remote-ref> blocked (prefix of --track)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --trac origin/remote-only' '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'remote-only'"
run_case_msg "git switch --creat <b> blocked (prefix of --create)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git switch --creat newb' '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'newb'"
# The prefix table has to work in the ALLOW direction too, or it is only a
# fail-closed accident: both of these resolve to a restore / a no-DWIM read and
# must pass. Without prefix resolution they would be unknown options and block.
run_case "git checkout --pathspec-from-f <f> <branch> allowed (prefix, restore)" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --pathspec-from-f /dev/null some-feature' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout --no-gu <remote-only> allowed (prefix of --no-guess)" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --no-gu remote-only' '{cwd:$d,tool_input:{command:$c}}')"

# --- AN OPTION THE GRAMMAR CANNOT RESOLVE MAY NOT ALLOW -----------------------
#
# The general form of the two defects a positional COUNT produced: an unmodelled
# flag moves every positional after it, so the walk does not know where the
# switch target is. Every ALLOWING arm depends on that knowledge and the blocking
# arms do not, so an unresolved option blocks. Today it fires only on commands
# git itself refuses -- measured, `--creat` under checkout is "error: unknown
# option `creat'" and `--pat` is "error: ambiguous option: pat" -- so it costs
# nothing now; it is what keeps a FUTURE git option from re-opening the hole.
run_case_msg "git checkout --frobnicate main blocked (unknown long option)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --frobnicate main' '{cwd:$d,tool_input:{command:$c}}')" \
  "cannot resolve"
run_case_msg "git checkout --pat main blocked (AMBIGUOUS prefix)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --pat main' '{cwd:$d,tool_input:{command:$c}}')" \
  "cannot resolve"
run_case_msg "git checkout -Z main blocked (unknown short letter)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout -Z main' '{cwd:$d,tool_input:{command:$c}}')" \
  "cannot resolve"
run_case_msg "git checkout --creat main blocked (switch-only name under checkout)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --creat main' '{cwd:$d,tool_input:{command:$c}}')" \
  "cannot resolve"
# CONTROLS: a KNOWN option beside `main` must still pass, in the long, the
# negated and the short spelling. Without these, "block whenever any flag is
# present" scores green on the four cases above.
run_case "git checkout --quiet main allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --quiet main' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout --no-overwrite-ignore main allowed (negated form)" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --no-overwrite-ignore main' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout -q main allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout -q main' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git switch --discard-changes main allowed (switch-only name)" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git switch --discard-changes main' '{cwd:$d,tool_input:{command:$c}}')"

# --- EVERY VALUE-TAKING FLAG, NOT A SAMPLE OF THE ARM -------------------------
#
# `--conflict` and `--pathspec-from-file` had cases while `--unified` and
# `--inter-hunk-context` -- the other two members of the same arity class under
# `checkout` -- had none, and `-U` had none either. A value-taking flag with no
# case is an untested member of a class that has produced three defects. Each
# command below really switches (the flag's value is consumed by git, so the
# trailing name is the branch); if the table gives the flag arity 0 instead, the
# value becomes a phantom positional and the command reads as a restore.
run_case "git checkout --unified 3 <branch> blocked (value consumed)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --unified 3 some-feature' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout --unified=3 <branch> blocked (glued value)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --unified=3 some-feature' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout --inter-hunk-context 2 <branch> blocked (value consumed)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --inter-hunk-context 2 some-feature' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout -U 3 <branch> blocked (short value consumed)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout -U 3 some-feature' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout -U3 <branch> blocked (short glued value)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout -U3 some-feature' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git switch --conflict merge <branch> blocked (value consumed)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git switch --conflict merge some-feature' '{cwd:$d,tool_input:{command:$c}}')"
# ...and the CONTROL for the whole arity class: an ALLOWED command must not be
# turned into a block by the consumption. `git checkout --unified 3 main` really
# stays on main.
run_case "git checkout --unified 3 main allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --unified 3 main' '{cwd:$d,tool_input:{command:$c}}')"

# --- OPTIONAL-VALUE FLAGS CONSUME NOTHING -------------------------------------
#
# `-t` / `--track` / `--recurse-submodules` take an OPTIONAL value, so the SPACED
# form does NOT eat the next token -- measured, `git checkout -t
# origin/remote-only` creates local `remote-only`, i.e. the ref is a start-point
# POSITIONAL. The glued and `=` spellings were fenced; the SPACED `--track` was
# not.
run_case_msg "git checkout --track <remote-ref> (spaced) blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --track origin/remote-only' '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'remote-only'"
run_case_msg "git switch --track <remote-ref> (spaced) blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git switch --track origin/remote-only' '{cwd:$d,tool_input:{command:$c}}')" \
  "creates new feature branch 'remote-only'"

# --- THE DWIM LIST IS THE CONFIGURED REMOTES, STRIPPED PER REMOTE -------------
#
# A remote NAME may contain a slash, so a fixed `lstrip=3` is wrong: `deep-only`
# on remote `a/b` lstrips to `b/deep-only` while git DWIMs plain `deep-only`
# (measured: "Switched to a new branch 'deep-only'", HEAD moved) -- a FAIL-OPEN.
# And a ref under a remote that is not CONFIGURED is not DWIMmed at all
# (measured: "pathspec 'ghost' did not match any file(s) known to git", HEAD
# stays) -- a FALSE BLOCK for a `refs/remotes/` scan.
run_case "git checkout <branch on a SLASH-named remote> blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout deep-only' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout <ref under an UNCONFIGURED remote> allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout ghost' '{cwd:$d,tool_input:{command:$c}}')"
# `--no-guess` turns the DWIM off, so git answers "pathspec did not match" and
# HEAD stays -- measured against the SAME name that moves HEAD without the flag.
# It does not disable the LOCAL branch lookup: `--no-guess some-feature` switches.
run_case "git checkout --no-guess <remote-only> allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --no-guess remote-only' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout --no-guess <local branch> still blocked" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --no-guess some-feature' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout --guess <remote-only> blocked (the default)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --guess remote-only' '{cwd:$d,tool_input:{command:$c}}')"
run_case "git checkout --no-guess --guess <remote-only> blocked (last wins)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --no-guess --guess remote-only' '{cwd:$d,tool_input:{command:$c}}')"

# --- A BLOCK MUST NOT NAME AN OPERATION GIT WILL NOT PERFORM ------------------
#
# `git checkout -d <branch>` / `--detach <branch>` DETACHES (measured: HEAD went
# to a raw sha, not to the branch), and the block announced it as "switches to
# feature branch '<b>'". The VERDICT was right and is unchanged; the wording was
# describing something git does not do.
run_case_msg "git checkout -d <local branch> is reported as a detach" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout -d some-feature' '{cwd:$d,tool_input:{command:$c}}')" \
  "detaches HEAD" "switches to feature branch"
run_case_msg "git checkout --detach <local branch> is reported as a detach" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --detach some-feature' '{cwd:$d,tool_input:{command:$c}}')" \
  "detaches HEAD" "switches to feature branch"
run_case_msg "git checkout --detach <remote-only> is reported as a detach" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout --detach remote-only' '{cwd:$d,tool_input:{command:$c}}')" \
  "detaches HEAD" "switches to it"
# The `d` cluster letter under SWITCH had no case either, only the long spelling.
run_case_msg "git switch -d blocked and reported as a detach" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git switch -d' '{cwd:$d,tool_input:{command:$c}}')" \
  "detaches HEAD"
# The documented ASYMMETRY, kept deliberately: the sha form under checkout passes.
run_case "git checkout --detach <sha> allowed (documented asymmetry)" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout --detach $MAIN_SHA" '{cwd:$d,tool_input:{command:$c}}')"

# --- A BARE `git switch` ------------------------------------------------------
#
# A git error, but blocked conservatively rather than reasoned about. It had no
# case, so deleting the arm was invisible.
run_case_msg "bare git switch blocked conservatively" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git switch' '{cwd:$d,tool_input:{command:$c}}')" \
  "no resolvable target"

# --- AN UNSPLITTABLE ARGUMENT LIST IS REFUSED, NOT TRUNCATED ------------------
#
# An UNBALANCED quote cannot be split into shell words at all, and the splitter
# used to return the prefix it managed silently: `-b agent's-branch` yielded the
# single token `-b`, which read as a bare `git checkout` and PASSED -- a
# FAIL-OPEN on a command that creates a branch (measured: `git checkout -b
# agent\'s-br` prints "Switched to a new branch 'agent's-br'"). Refusing is the
# deliberate choice: the text is a shell syntax error in the first place
# (measured: "unexpected EOF while looking for matching `''").
# The apostrophe is built rather than written, and that is a BASH 3.2 defect
# rather than style. Under 3.2.57 a `'` inside a DOUBLE-quoted word inside a
# `$(...)` opens a quote span that the NEXT single-quoted argument closes, so the
# jq filter is split, jq fails, and the remaining arguments shift by one --
# measured, the same line gives `argc=4 a2=[] a3=[]` under 3.2 and
# `argc=3 a3=[unbalanced quote]` under 5.3.9. The suite runs under BOTH shells,
# so a case written the direct way reports a hook defect that does not exist.
APOS=$(printf '\047')
run_case_msg "git checkout -b <unbalanced quote> blocked, not truncated" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout -b agent${APOS}s-branch" '{cwd:$d,tool_input:{command:$c}}')" \
  "unbalanced quote"
run_case_msg "git checkout <branch> with a trailing apostrophe blocked (fails CLOSED)" 2 \
  "$(jq -cn --arg d "$main_repo" --arg c "git checkout some-feature${APOS}" '{cwd:$d,tool_input:{command:$c}}')" \
  "unbalanced quote"
# CONTROL: a BALANCED quote around a name with an apostrophe in it is ordinary
# and must reach the normal arms, not the refusal.
run_case "git checkout \"main\" (balanced quotes) still allowed" 0 \
  "$(jq -cn --arg d "$main_repo" --arg c 'git checkout "main"' '{cwd:$d,tool_input:{command:$c}}')"

# --- THE ONE-ENTRY MEMO ACTUALLY MEMOISES -------------------------------------
#
# `main_tree_of` used to be read as `seg_main=$(main_tree_of "$dir")`, which runs
# it in a COMMAND SUBSTITUTION: both memo variables were written into a subshell
# that exited immediately, so the memo never hit and every segment forked
# `git worktree list` again -- under a comment claiming the saving. Measured
# before the fix: 3 forks for the command below, 1 after. Counting the forks is
# the only way to see this; the VERDICT is identical either way, which is why
# turning the memo off left the whole suite green.
memo_shim="$TMPDIR/memo-shim"
mkdir -p "$memo_shim"
REAL_GIT="$(command -v git)"
cat > "$memo_shim/git" <<GITSHIM
#!/bin/sh
[ -n "\${GIT_LOG:-}" ] && printf '%s\n' "\$*" >> "\$GIT_LOG"
exec "$REAL_GIT" "\$@"
GITSHIM
chmod +x "$memo_shim/git"
memo_log="$TMPDIR/memo.log"; : > "$memo_log"
memo_payload=$(jq -cn --arg d "$main_repo" --arg c "git switch main && git switch main && git switch -c feat-new" '{cwd:$d,tool_input:{command:$c}}')
printf '%s' "$memo_payload" | env PATH="$memo_shim:$PATH" GIT_LOG="$memo_log" "$HOOK" >/dev/null 2>&1
memo_rc=$?
memo_forks=$(grep -c 'worktree list' "$memo_log" | tr -d ' ')
# The rc is asserted BESIDE the count, and that pairing is the point: mutating
# `judge` to stop after segment 1 also makes the hook fork once, so "1 fork" on
# its own is satisfied by a gate that walked ONE segment instead of three. Only
# `rc=2` -- which requires reaching the THIRD segment, the `git switch -c` -- says
# the single fork covered all three.
if [ "$memo_forks" = 1 ] && [ "$memo_rc" = 2 ]; then
  pass=$((pass + 1)); printf 'OK   the one-entry memo forks `git worktree list` once ACROSS 3 same-tree segments (rc=2)\n'
else
  fail=$((fail + 1))
  fail_log+="FAIL memo: 3 same-tree segments forked \`git worktree list\` $memo_forks time(s) with rc=$memo_rc, expected 1 fork and rc=2\n"
fi

CASE_FLOOR=142
if [ "$((pass + fail))" -lt "$CASE_FLOOR" ]; then
  fail=$((fail + 1))
  fail_log+="FAIL case floor: only $((pass + fail)) cases ran, expected at least $CASE_FLOOR\n"
  printf 'FAIL case floor: only %s cases ran, expected at least %s\n' "$((pass + fail))" "$CASE_FLOOR"
fi
echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
